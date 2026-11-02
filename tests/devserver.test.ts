// @ts-nocheck
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isValidSystemId, resolveDataPath, systemsHandler } from "../vite.config";

const DATA_DIR = ".tmp/dev-server-data";

function post(id: unknown) {
  const req = new PassThrough();
  req.method = "POST";
  req.url = "/save";
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(body) { this.body = body ?? ""; },
  };
  const done = systemsHandler(DATA_DIR)(req, res);
  req.end(JSON.stringify({ id }));
  return done.then(() => res);
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("dev server id and path checks", () => {
  it("validates the exact id shape", () => {
    expect(isValidSystemId("campfire")).toBe(true);
    expect(isValidSystemId("../vite.config")).toBe(false);
    expect(isValidSystemId("a/b")).toBe(false);
    expect(isValidSystemId("Bad")).toBe(false);
    expect(resolveDataPath(DATA_DIR, "../vite.config", "manifest.json")).toBeNull();
    expect(resolveDataPath(DATA_DIR, "a/b", "manifest.json")).toBeNull();
    expect(resolveDataPath(DATA_DIR, "campfire", "../secret")).toBeNull();
  });

  it("rejects traversal ids with 400 and writes nothing", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    for (const id of ["../vite.config", "a/b"]) {
      const res = await post(id);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/invalid system id/);
    }
    expect(filesUnder(DATA_DIR)).toEqual([]);
  });
});
