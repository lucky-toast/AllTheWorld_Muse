import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStorage, safeDataPath } from "../devserver/storage";

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }) as string[];
}

describe("dev server storage guards (13.2)", () => {
  test("rejects ids like ../vite.config and a/b with 400 and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "atw-"));
    const data = join(root, "data");
    try {
      const before = listAll(root);
      for (const method of ["PUT", "POST", "DELETE", "GET"]) {
        for (const id of ["../vite.config", "a/b", "..%2Fvite.config", "a%2Fb", "Bad", "1abc", "", "a".repeat(41), "%E0%A4%A"]) {
          const url = `/systems/${id}${id === "" ? "x/" : ""}`;
          const res = handleStorage(data, method, url);
          expect(res.status, `${method} ${url}`).toBe(400);
        }
        expect(handleStorage(data, method, "/systems/ok_id/../../vite.config.ts").status).toBe(400);
        expect(handleStorage(data, method, "/systems/ok_id/module.ts").status).toBe(400);
      }
      expect(listAll(root)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("a valid id passes the guards (the endpoint itself arrives later)", () => {
    expect(handleStorage("/tmp/none/data", "PUT", "/systems/campfire/manifest.json").status).toBe(501);
    expect(handleStorage("/tmp/none/data", "GET", "/systems").status).toBe(200);
  });
  test("paths must stay inside data/ and never be code files", () => {
    expect(safeDataPath("/x/data", "systems", "a", "manifest.json")).toBe("/x/data/systems/a/manifest.json");
    expect(safeDataPath("/x/data", "..", "vite.config.ts")).toBeNull();
    expect(safeDataPath("/x/data", "systems", "..", "..", "src", "main.ts")).toBeNull();
    expect(safeDataPath("/x/data", "systems", "a", "evil.js")).toBeNull();
    expect(safeDataPath("/x/data", "/etc/passwd")).toBeNull();
    expect(safeDataPath("/x/data")).toBeNull();
  });
});
