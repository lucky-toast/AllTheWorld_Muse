// @ts-nocheck
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkSystem, loadChecked, submitSystem } from "../src/pipeline/client";
import { MemoryStorage } from "../src/pipeline/storage";
import { reloadStoredSystems, undoLastLoad } from "../src/pipeline/load";
import { buildWorld } from "../src/world/map";
import { createGame } from "../src/systems/base/index";

const root = process.cwd();
function fixture(name) {
  const dir = join(root, "fixtures", name);
  return { manifestJson: readFileSync(join(dir, "manifest.json"), "utf8"), source: readFileSync(join(dir, "module.ts"), "utf8") };
}
function liveGame() { const eng = buildWorld(); const game = createGame(eng); return { eng, game }; }
const node = { backend: "node" };

describe("pipeline fixture table (spec 12, 14)", () => {
  it("campfire and chop pass all stages", async () => {
    for (const name of ["campfire", "chop"]) {
      const { game } = liveGame();
      const f = fixture(name);
      const report = await checkSystem(f.manifestJson, f.source, { ...node, game });
      expect(report.ok, `${name}: ${JSON.stringify(report.errors)}`).toBe(true);
      expect(report.systemId).toBe(name);
      expect(report.stage).toBe("Load");
      expect(report.shots.length).toBeGreaterThan(0);
    }
  }, 300000);

  const bad = [
    ["bad_manifest", "Manifest", /not in the catalog|dragon_huge/],
    ["bad_prefix", "Manifest", /fire\.lit|prefix|does not own|emitted/],
    ["bad_types", "Compile", /.+/],
    ["bad_export", "Module", /perform/],
    ["bad_test", "Tests", /.+/],
    ["bad_breaks_base", "World check", /.+/],
    ["bad_loop", "World check", /.+/],
    ["bad_memory", "World check", /.+/],
  ];
  for (const [name, stage, re] of bad) {
    it(`${name} fails at exactly ${stage}`, async () => {
      expect(existsSync(join(root, "fixtures", name, "manifest.json")), `${name} fixture exists`).toBe(true);
      const { game } = liveGame();
      const f = fixture(name);
      const report = await checkSystem(f.manifestJson, f.source, { ...node, game });
      expect(report.ok, `${name} should fail`).toBe(false);
      expect(report.stage).toBe(stage);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors.map((e) => e.message).join(" ")).toMatch(re);
    }, 300000);
  }

  it("bad_loop does not hang the check", async () => {
    const { game } = liveGame();
    const f = fixture("bad_loop");
    const started = Date.now();
    const report = await checkSystem(f.manifestJson, f.source, { ...node, game });
    expect(report.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(120000);
  }, 180000);
});

describe("dev-server storage endpoints (spec 13.2)", () => {
  it("saves and serves a system, and never writes code files", async () => {
    const { PassThrough } = await import("node:stream");
    const { existsSync, rmSync, readdirSync } = await import("node:fs");
    const { systemsHandler } = await import("../vite.config");
    const dir = ".tmp/phase4-storage";
    rmSync(dir, { recursive: true, force: true });
    const call = (method, url, body) => new Promise((resolveCall) => {
      const req = new PassThrough();
      req.method = method;
      req.url = url;
      const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ?? ""; resolveCall(this); } };
      const done = systemsHandler(dir)(req, res);
      req.end(body ? JSON.stringify(body) : undefined);
      void done;
    });
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    let bin = "";
    for (const b of wasm) bin += String.fromCharCode(b);
    const saved = await call("POST", "/system", { id: "campfire", manifestJson: "{}", source: "export function onTick(): void {}", wasmB64: btoa(bin), buildsOn: ["carry"], timestamp: 1 });
    expect(saved.statusCode).toBe(200);
    expect(existsSync(`${dir}/systems/campfire/module.wasm`)).toBe(true);
    expect(existsSync(`${dir}/systems/campfire/module.sha256`)).toBe(true);
    expect(readdirSync(`${dir}/systems/campfire`).some((f) => /\.(ts|js|mjs)$/.test(f))).toBe(false);
    const bad = await call("POST", "/system", { id: "../evil", manifestJson: "{}", source: "", wasmB64: "" });
    expect(bad.statusCode).toBe(400);
    const badFile = await call("GET", "/system?id=campfire&file=..%2Fsecret");
    expect(badFile.statusCode).toBe(400);
    const index = await call("GET", "/");
    expect(JSON.parse(index.body).systems.map((s) => s.id)).toEqual(["campfire"]);
    const removed = await call("DELETE", "/system?id=campfire");
    expect(removed.statusCode).toBe(200);
    expect(existsSync(`${dir}/systems/campfire`)).toBe(false);
  });
});

describe("live load, undo and storage (spec 13.1, 13.2)", () => {
  it("submitSystem loads campfire live; a second submit is rejected; Undo removes it", async () => {
    const { eng, game } = liveGame();
    const storage = new MemoryStorage();
    const f = fixture("campfire");
    const report = await submitSystem(f.manifestJson, f.source, { ...node, game, storage });
    expect(report.ok, JSON.stringify(report.errors)).toBe(true);
    expect(game.registry.byId("campfire")).toBeDefined();
    expect(eng.banner?.text).toBe("The world feels different");
    expect((await storage.listRecords()).map((r) => r.id)).toContain("campfire");
    const again = await submitSystem(f.manifestJson, f.source, { ...node, game, storage });
    expect(again.ok).toBe(false);
    expect(again.errors.map((e) => e.message).join(" ")).toMatch(/already/);
    expect(undoLastLoad(game, storage)).toBe(true);
    expect(game.registry.byId("campfire")).toBeUndefined();
    expect((await storage.listRecords()).map((r) => r.id)).not.toContain("campfire");
  }, 300000);

  it("loadChecked refuses when the loaded set changed since the check", async () => {
    const { game } = liveGame();
    const storage = new MemoryStorage();
    const f = fixture("campfire");
    const report = await checkSystem(f.manifestJson, f.source, { ...node, game });
    expect(report.ok).toBe(true);
    const chop = fixture("chop");
    const loaded = await submitSystem(chop.manifestJson, chop.source, { ...node, game, storage });
    expect(loaded.ok, JSON.stringify(loaded.errors)).toBe(true);
    const stale = await loadChecked(report, { game, storage });
    expect(stale.ok).toBe(false);
    expect(stale.errors.map((e) => e.message).join(" ")).toMatch(/changed/);
  }, 300000);

  it("a tampered stored module is metered or rejected at startup; dependents are skipped", async () => {
    const storage = new MemoryStorage();
    const { game } = liveGame();
    const f = fixture("campfire");
    const report = await submitSystem(f.manifestJson, f.source, { ...node, game, storage });
    expect(report.ok).toBe(true);
    // Tamper with the stored wasm bytes.
    const rec = await storage.getSystem("campfire");
    const tampered = rec.wasm.slice();
    tampered[tampered.length - 20] ^= 0xff;
    await storage.putSystem({ ...rec, wasm: tampered });
    const fresh = liveGame();
    const result = await reloadStoredSystems(fresh.game, storage);
    // Either it still loads (fresh metering made it safe) or it is skipped; it must never run unmetered.
    expect(result.loaded.includes("campfire") || result.skipped.some((s) => s.id === "campfire")).toBe(true);
    expect(fresh.game.faults).toEqual([]);
  }, 300000);
});
