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
  test("a valid id passes the guards and the files round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "atw-"));
    const data = join(root, "data");
    const enc = (s: string) => new TextEncoder().encode(s);
    const text = (r: { body: unknown }) => new TextDecoder().decode(r.body as Uint8Array);
    try {
      expect(handleStorage(data, "GET", "/systems.json")).toMatchObject({ status: 200, body: "[]" });
      expect(handleStorage(data, "PUT", "/systems/campfire/manifest.json", enc(`{"id":"campfire"}`)).status).toBe(200);
      expect(handleStorage(data, "PUT", "/systems/campfire/manifest.json", enc(`not json`)).status).toBe(400);
      expect(handleStorage(data, "PUT", "/systems/campfire/module.wasm", new Uint8Array([0, 97, 115, 109])).status).toBe(200);
      expect(text(handleStorage(data, "GET", "/systems/campfire/manifest.json"))).toBe(`{"id":"campfire"}`);
      expect(handleStorage(data, "GET", "/systems/campfire/source.as").status).toBe(404);
      expect(handleStorage(data, "PUT", "/systems.json", enc(`[{"id":"../x"}]`)).status).toBe(400);
      expect(handleStorage(data, "PUT", "/systems.json", enc(`[{"id":"campfire","order":0}]`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/world.json", enc(`{"v":1}`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/ai-log.jsonl", enc(`{"role":"user"}`)).status).toBe(200);
      expect(handleStorage(data, "POST", "/ai-log.jsonl", enc(`{"role":"model"}`)).status).toBe(200);
      expect(text(handleStorage(data, "GET", "/ai-log.jsonl"))).toBe(`{"role":"user"}\n{"role":"model"}\n`);
      expect(handleStorage(data, "PUT", "/main.ts", enc("x")).status).toBe(404);
      expect(handleStorage(data, "DELETE", "/systems/campfire").status).toBe(200);
      expect(listAll(data).sort()).toEqual(["ai-log.jsonl", "systems", "systems.json", "world.json"]);
      expect(handleStorage(data, "POST", "/fresh").status).toBe(200);
      expect(listAll(data)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
