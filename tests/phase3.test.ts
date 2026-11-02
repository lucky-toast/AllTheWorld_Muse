// @ts-nocheck
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileSystem, ASC_VERSION, ASC_FLAGS } from "../src/sandbox/compile";
import { meterBinary, MeterError } from "../src/sandbox/meter";
import { loadWasmModule, listModuleImports, ModuleLoadError } from "../src/sandbox/module";
import { runSystemTests, runSystemShots } from "../src/sandbox/runner";
import { buildWorld } from "../src/world/map";
import { createGame } from "../src/systems/base/index";
import type { Manifest } from "../src/engine/manifest";

const root = process.cwd();
function fixture(name: string): { manifest: Manifest; source: string } {
  const manifest = JSON.parse(readFileSync(join(root, "fixtures", name, "manifest.json"), "utf8")) as Manifest;
  const source = readFileSync(join(root, "fixtures", name, "module.ts"), "utf8");
  return { manifest, source };
}
async function compiled(name: string) {
  const { manifest, source } = fixture(name);
  const r = await compileSystem(manifest, source);
  if (!r.ok) throw new Error(`${name} did not compile: ${JSON.stringify(r.errors)}`);
  return { manifest, source, bytes: r.bytes };
}
function freshGame() {
  const eng = buildWorld();
  const game = createGame(eng);
  game.testMode = true;
  return { eng, game };
}

// Minimal hand-built wasm builder for loader/meter rejection tests.
function uleb(n: number): number[] { const out: number[] = []; let v = n; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); return out; }
function nameBytes(s: string): number[] { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; }
function section(id: number, payload: number[]): number[] { return [id, ...uleb(payload.length), ...payload]; }
function vec(items: number[][]): number[] { const out = [...uleb(items.length)]; for (const i of items) out.push(...i); return out; }
function handModule(opts: { extraImport?: boolean; body: number[] }): Uint8Array {
  const types = section(1, vec([[0x60, 0, 0]]));
  const imports: number[][] = [
    [...nameBytes("host"), ...nameBytes("call"), 0x00, 0x00],
    [...nameBytes("env"), ...nameBytes("memory"), 0x02, 0x00, 0x01],
  ];
  if (opts.extraImport) imports.push([...nameBytes("env"), ...nameBytes("extra"), 0x00, 0x00]);
  const importSec = section(2, vec(imports));
  const funcSec = section(3, vec([[0x00]]));
  const funcImports = opts.extraImport ? 2 : 1; // host.call, plus env.extra when present; env.memory is not a function
  const exportSec = section(7, vec([[...nameBytes("perform"), 0x00, ...uleb(funcImports)]]));
  const body = [...uleb(0), ...opts.body, 0x0b];
  const codeSec = section(10, vec([[...uleb(body.length), ...body]]));
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...importSec, ...funcSec, ...exportSec, ...codeSec]);
}
const minimalManifest: Manifest = { id: "handy", why: "hand built", buildsOn: [], replaces: [], entities: {}, components: {}, interactions: [{ verb: "act", label: "Act", target: "branch" }], reactions: [], emits: {}, shots: [] };

describe("compile (spec 10.1)", () => {
  it("pins asc and notes the fixed flags", () => {
    expect(ASC_VERSION).toBe("0.28.20");
    expect(ASC_FLAGS).toContain("--importMemory");
    expect(ASC_FLAGS).toContain("--exportRuntime");
    expect(ASC_FLAGS.join(" ")).toContain("abort=~lib/sdk/index/sdkAbort");
  });
  it("a type error fails with line and source text", async () => {
    const r = await compileSystem(minimalManifest, `import { nosuchhelper } from "sdk";\nexport function perform(v: string, t: i32, h: i32): void { nosuchhelper(); }`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.some((e) => e.line !== undefined && (e.sourceLine ?? "").length > 0)).toBe(true);
    }
  });
});

describe("fixtures as metered modules (spec 14)", () => {
  it("campfire compiles, loads, and passes all its own tests and shots", async () => {
    const { manifest, bytes } = await compiled("campfire");
    const imports = listModuleImports(bytes).map((i) => `${i.module}.${i.name}`).sort();
    expect(imports).toEqual(["env.memory", "host.call"]);
    const { game } = freshGame();
    const handle = loadWasmModule(game, manifest, bytes, { migrate: true });
    expect(handle.meteredBytes.length).toBeGreaterThan(bytes.length);
    const results = runSystemTests(manifest, bytes);
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining([
      "test_three_branches_make_a_fire", "test_two_branches_do_not_make_a_fire", "test_the_fire_has_a_light",
      "test_it_burns_out_to_ash", "test_the_player_cannot_walk_through_a_lit_fire",
    ]));
    for (const r of results) expect(r.passed, `${r.name}: ${JSON.stringify(r.checks)} faults=${JSON.stringify(r.faults)}`).toBe(true);
    const shots = runSystemShots(manifest, bytes);
    expect(shots).toHaveLength(2);
    for (const s of shots) expect(s.passed, `${s.name}: ${JSON.stringify(s.faults)}`).toBe(true);
    expect(shots.find((s) => s.name === "ash")!.entities.some((e) => e.type === "firepit_ash")).toBe(true);
  }, 120000);

  it("chop compiles, loads, and passes all its own tests and shots", async () => {
    const { manifest, bytes } = await compiled("chop");
    const imports = listModuleImports(bytes).map((i) => `${i.module}.${i.name}`).sort();
    expect(imports).toEqual(["env.memory", "host.call"]);
    const { game, eng } = freshGame();
    loadWasmModule(game, manifest, bytes, { migrate: true });
    expect([...eng.entities.values()].some((r) => r.type === "axe")).toBe(true);
    const results = runSystemTests(manifest, bytes);
    expect(results.length).toBe(4);
    for (const r of results) expect(r.passed, `${r.name}: ${JSON.stringify(r.checks)} faults=${JSON.stringify(r.faults)}`).toBe(true);
    const shots = runSystemShots(manifest, bytes);
    expect(shots).toHaveLength(1);
    expect(shots[0].passed).toBe(true);
  }, 120000);

  it("chop interactions rank Chop first with an axe, Pick up without one (spec 6)", async () => {
    const { manifest, bytes } = await compiled("chop");
    const { game } = freshGame();
    loadWasmModule(game, manifest, bytes, { migrate: true });
    game.call("test", { op: "sim.teleport", x: 12, y: 9 });
    game.call("test", { op: "sim.face", dir: "up" });
    game.interactions.refresh();
    expect(game.eng.interactionPrompt).toContain("Pick up");
    game.call("test", { op: "sim.give", type: "axe" });
    game.interactions.refresh();
    expect(game.eng.interactionPrompt).toContain("Chop");
    game.interactions.cycle();
    expect(game.eng.interactionPrompt).toContain("Drop");
  }, 120000);
});

describe("loader and meter rejections (spec 10.3)", () => {
  it("an extra import is rejected", () => {
    const { game } = freshGame();
    const bytes = handModule({ extraImport: true, body: [] });
    expect(() => loadWasmModule(game, minimalManifest, bytes)).toThrowError(ModuleLoadError);
    expect(() => loadWasmModule(game, minimalManifest, bytes)).toThrowError(/unexpected import env\.extra/);
  });
  it("a missing perform for a declared interaction is rejected", () => {
    const { game } = freshGame();
    const bytes = handModule({ body: [] });
    // Rename the only export away from perform by patching its name bytes.
    const patched = bytes.slice();
    const idx = patched.findIndex((b, i) => b === 0x70 && patched[i + 1] === 0x65); // "pe" of perform
    patched[idx] = 0x78; // "xe..."
    expect(() => loadWasmModule(game, minimalManifest, patched)).toThrowError(/does not export "perform"/);
  });
  it("an unknown opcode is rejected by the meter", () => {
    const bytes = handModule({ body: [0xfe, 0x00] });
    expect(() => meterBinary(bytes)).toThrowError(MeterError);
    expect(() => meterBinary(bytes)).toThrowError(/unknown opcode/);
  });
  it("the meter is deterministic", async () => {
    const { bytes } = await compiled("chop");
    const a = meterBinary(bytes);
    const b = meterBinary(bytes);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.fuelGlobalIndex).toBe(b.fuelGlobalIndex);
  }, 120000);
});

describe("fuel, memory, strikes and rollback (spec 10.4, 4.4)", () => {
  const looperManifest: Manifest = { id: "looper", why: "loops forever", buildsOn: [], replaces: [], entities: {}, components: {}, interactions: [], reactions: [], emits: {}, shots: [] };
  const looperSource = `import { spawn } from "sdk";\nexport function onTick(): void { spawn("branch", 15, 10); while (true) { } }`;
  const dependentManifest: Manifest = { id: "afterloop", why: "builds on looper", buildsOn: ["looper"], replaces: [], entities: {}, components: {}, interactions: [], reactions: [], emits: {}, shots: [] };
  const dependentSource = `export function onTick(): void { }`;

  it("an infinite loop traps on fuel and the world is rolled back", async () => {
    const compiledLooper = await compileSystem(looperManifest, looperSource);
    if (!compiledLooper.ok) throw new Error(JSON.stringify(compiledLooper.errors));
    const { eng, game } = freshGame();
    const before = [...eng.entities.values()].filter((r) => r.type === "branch").length;
    loadWasmModule(game, looperManifest, compiledLooper.bytes, {});
    game.tick();
    expect(game.faults.some((f) => f.system === "looper")).toBe(true);
    expect([...eng.entities.values()].filter((r) => r.type === "branch").length).toBe(before);
  }, 120000);

  it("three traps in a minute unload the system and a system that builds on it", async () => {
    const compiledLooper = await compileSystem(looperManifest, looperSource);
    if (!compiledLooper.ok) throw new Error(JSON.stringify(compiledLooper.errors));
    const compiledDep = await compileSystem(dependentManifest, dependentSource);
    if (!compiledDep.ok) throw new Error(JSON.stringify(compiledDep.errors));
    const { eng, game } = freshGame();
    loadWasmModule(game, looperManifest, compiledLooper.bytes, {});
    loadWasmModule(game, dependentManifest, compiledDep.bytes, {});
    game.tick(); game.tick();
    expect(game.registry.byId("looper")).toBeDefined();
    game.tick();
    expect(game.registry.byId("looper")).toBeUndefined();
    expect(game.registry.byId("afterloop")).toBeUndefined();
    expect(eng.banner?.text).toContain("looper");
  }, 120000);

  it("an unbounded allocation traps on memory and is rolled back", async () => {
    const memManifest: Manifest = { id: "hog", why: "allocates forever", buildsOn: [], replaces: [], entities: {}, components: {}, interactions: [], reactions: [], emits: {}, shots: [] };
    const memSource = `import { spawn } from "sdk";\nexport function onTick(): void { spawn("branch", 15, 10); const keep = new Array<Uint8Array>(); while (true) { keep.push(new Uint8Array(65536)); } }`;
    const compiledMem = await compileSystem(memManifest, memSource);
    if (!compiledMem.ok) throw new Error(JSON.stringify(compiledMem.errors));
    const { eng, game } = freshGame();
    const before = [...eng.entities.values()].filter((r) => r.type === "branch").length;
    loadWasmModule(game, memManifest, compiledMem.bytes, {});
    game.tick();
    expect(game.faults.some((f) => f.system === "hog")).toBe(true);
    expect([...eng.entities.values()].filter((r) => r.type === "branch").length).toBe(before);
    expect(game.registry.byId("hog")).toBeDefined();
  }, 120000);

  it("the same module gives the same fuel count on every run", async () => {
    const { manifest, bytes } = await compiled("campfire");
    const used: number[] = [];
    for (let i = 0; i < 2; i++) {
      const { game } = freshGame();
      const handle = loadWasmModule(game, manifest, bytes, {});
      handle.strikesEnabled = false;
      game.invoke(handle.system, "onTick", () => handle.system.onTick!());
      used.push(handle.lastFuelUsed);
    }
    expect(used[0]).toBeGreaterThan(0);
    expect(used[1]).toBe(used[0]);
  }, 120000);
});

describe("no dynamic code execution in src (spec 10)", () => {
  it("grep finds no new Function, eval( or dynamic import() in src/", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
    walk(join(root, "src"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text.includes("new Function"), f).toBe(false);
      expect(text.includes("eval("), f).toBe(false);
      expect(/[^.\w]import\s*\(/.test(text), f).toBe(false);
    }
  });
});
