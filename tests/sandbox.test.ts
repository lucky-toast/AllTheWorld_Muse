// Phase 3: AI systems as metered WebAssembly modules (spec 10, 14).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileSystem, formatCompileError, ASC_VERSION, read } from "../src/sandbox/compile";
import { meter, inspect, WasmError, FUEL_EXPORT } from "../src/sandbox/meter";
import { checkModule, loadAiSystem, prepareModule, ModuleError, type AiSystemDef } from "../src/sandbox/module";
import { runAiTests, runShots, worldHost } from "../src/sandbox/runners";
import { testSystem } from "./helpers";
import { baseModule } from "./wasm";

const FIXTURES = ["campfire", "chop"];
const manifestOf = (f: string) => JSON.parse(readFileSync(`fixtures/${f}/manifest.json`, "utf8"));
const sourceOf = (f: string) => readFileSync(`fixtures/${f}/module.ts`, "utf8");

async function compiled(manifest: unknown, source: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await compileSystem(manifest, source);
  if (!r.ok) throw new Error(r.errors.map(formatCompileError).join("\n"));
  return r.wasm;
}

const wasm: Record<string, Uint8Array<ArrayBuffer>> = {};
beforeAll(async () => { for (const f of FIXTURES) wasm[f] = await compiled(manifestOf(f), sourceOf(f)); }, 120_000);

test("asc is pinned to the version the flags were checked against", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.devDependencies.assemblyscript).toBe(ASC_VERSION);
});

describe.each(FIXTURES)("fixture %s", (f) => {
  test("its only imports are host.call and env.memory", () => {
    for (const bytes of [wasm[f], meter(wasm[f])]) {
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
      expect(imports).toEqual([{ module: "host", name: "call", kind: "function" }, { module: "env", name: "memory", kind: "memory" }]);
    }
  });

  test("loads as a metered module", () => {
    const def = loadAiSystem(wasm[f], manifestOf(f));
    const exports = WebAssembly.Module.exports(def.prepared.module).map((e) => e.name);
    expect(exports).toContain(FUEL_EXPORT);
    expect(def.prepared.metered.length).toBeGreaterThan(wasm[f].length);
    expect(inspect(def.prepared.metered).definedGlobals).toBe(inspect(wasm[f]).definedGlobals + 1);
  });

  test("passes all its own tests on the real map", () => {
    const results = runAiTests(loadAiSystem(wasm[f], manifestOf(f)));
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) {
      expect({ test: r.name, error: r.error, failed: r.checks.filter((c) => !c.passed).map((c) => c.label), faults: r.faults }).toEqual({ test: r.name, error: null, failed: [], faults: [] });
      expect(r.passed).toBe(true);
    }
  });

  test("its shots set up without errors", () => {
    const shots = runShots(loadAiSystem(wasm[f], manifestOf(f)));
    expect(shots.length).toBe(manifestOf(f).shots.length);
    for (const s of shots) expect({ shot: s.name, error: s.error, faults: s.faults }).toEqual({ shot: s.name, error: null, faults: [] });
  });
});

test("campfire's shots show a lit fire at night and an ash ring", () => {
  const [lit, ash] = runShots(loadAiSystem(wasm.campfire, manifestOf("campfire")));
  expect(lit.host.eng.phase).toBe("night");
  const fire = (s: typeof lit) => s.host.eng.rec(s.host.eng.query("campfire")[0]);
  expect(fire(lit)?.tags.has("lit")).toBe(true);
  expect((fire(ash)?.comps.get("sprite") as { id: string }).id).toBe("firepit_ash");
});

test("the compiler finds the SDK whatever path style asc asks with (Windows uses backslashes)", () => {
  const fs = { "node_modules/sdk/index.ts": "sdk", "module.ts": "mine" };
  expect(read(fs, "node_modules\\sdk\\index.ts")).toBe("sdk");
  expect(read(fs, "node_modules\\sdk\\node_modules\\sdk\\index.ts")).toBe("sdk");
  expect(read(fs, "../../node_modules/sdk/index.ts")).toBe("sdk");
  expect(read(fs, "module.ts")).toBe("mine");
  expect(read(fs, "node_modules\\sdk\\nope.ts")).toBeNull();
});

describe("compile errors", () => {
  test("name the line and source text", async () => {
    const r = await compileSystem({ id: "bad_types" }, `import { player } from "sdk";\n\nexport function onTick(): void {\n  summonDragon(player());\n}\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors[0];
    expect(e).toMatchObject({ file: "module.ts", line: 4, sourceLine: "  summonDragon(player());" });
    expect(formatCompileError(e)).toMatch(/^module\.ts:4:3 .*summonDragon/);
  });
  test("an extra host import declared in source is refused by the loader", async () => {
    const bytes = await compiled({ id: "sneaky" }, `@external("env", "now") declare function now(): f64;\nexport function onTick(): void { now(); }\n`);
    const r = checkModule(bytes, { id: "sneaky" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/import "env.now" isn't allowed/);
  });
});

describe("hand-built binaries", () => {
  test("a module with only the two imports and the glue loads", () => {
    expect(checkModule(baseModule(), { id: "ok" })).toMatchObject({ ok: true });
  });
  test("an extra import is rejected", () => {
    const bytes = baseModule({ imports: [{ module: "env", name: "fetch", kind: "func", type: 4 }] });
    expect(WebAssembly.validate(bytes)).toBe(true);
    const r = checkModule(bytes, { id: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain(`import "env.fetch" isn't allowed; the only imports are host.call and env.memory`);
    expect(() => prepareModule(bytes, { id: "x" })).toThrow(ModuleError);
  });
  test("a missing perform for a declared interaction is rejected", () => {
    const manifest = { id: "x", interactions: [{ verb: "poke", label: "Poke", target: "crate" }] };
    const r = checkModule(baseModule(), manifest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/1 interaction\(s\) but the module exports no perform/);
    // With a perform of the right signature it passes.
    const withPerform = baseModule({ funcs: [{ type: 5, body: [0x0b] }], exports: [{ name: "perform", func: 8 }] });
    expect(checkModule(withPerform, manifest).ok).toBe(true);
  });
  test("a compiled module without perform is rejected the same way", async () => {
    const manifest = { id: "bad_export", interactions: [{ verb: "poke", label: "Poke", target: "crate" }] };
    const bytes = await compiled(manifest, `export function onTick(): void {}\n`);
    expect(() => prepareModule(bytes, manifest)).toThrow(/exports no perform/);
  });
  test("an unknown opcode is rejected by the meter", () => {
    // v128.const 0 (SIMD, 0xfd 0x0c + 16 bytes), then drop: valid WebAssembly, but not something the meter understands.
    const simd = [0xfd, 0x0c, ...new Array(16).fill(0), 0x1a, 0x0b];
    const bytes = baseModule({ funcs: [{ type: 4, body: simd }] });
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(() => meter(bytes)).toThrow(WasmError);
    expect(() => meter(bytes)).toThrow(/unknown opcode 0xfd/);
    expect(() => prepareModule(bytes, { id: "x" })).toThrow(/metering failed: function \d+: unknown opcode 0xfd/);
  });
  test("an unexpected export and a wrong signature are rejected", () => {
    const bytes = baseModule({ funcs: [{ type: 1, body: [0x20, 0x00, 0x0b] }, { type: 1, body: [0x20, 0x00, 0x0b] }], exports: [{ name: "steal", func: 8 }, { name: "onTick", func: 9 }] });
    const r = checkModule(bytes, { id: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toMatch(/unexpected export "steal"/);
      expect(r.errors.join("\n")).toMatch(/export "onTick" has the signature \(i32\) -> \(i32\); it must be \(\) -> \(\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Traps, rollback and strikes (spec 4.4, 10.4)
// ---------------------------------------------------------------------------
const TRAPPER = `import { player, getNum, setNum } from "sdk";
const hoard = new Array<ArrayBuffer>();
export function onTick(): void {
  const p = player();
  const mode = <i32>getNum(p, "trap");
  if (mode == 0) return;
  setNum(p, "marker", getNum(p, "marker") + 1); // a write the rollback must undo
  if (mode == 1) { let n: i64 = 0; while (true) { n++; } }
  if (mode == 2) { while (true) hoard.push(new ArrayBuffer(1 << 20)); }
}
`;
const trapperManifest = { id: "trapper", why: "Traps when asked (test only)." };
let trapperWasm: Uint8Array<ArrayBuffer>;
beforeAll(async () => { trapperWasm = await compiled(trapperManifest, TRAPPER); }, 60_000);

function trapWorld(extra: AiSystemDef[] = []) {
  const def = loadAiSystem(trapperWasm, trapperManifest);
  const host = worldHost(def);
  for (const d of extra) host.load(d);
  const eng = host.eng; const player = eng.player()!;
  return { def, host, eng, player };
}

describe("traps roll the world back", () => {
  test("an infinite loop traps on fuel and the world is rolled back", () => {
    const { host, eng, player } = trapWorld();
    host.tick();
    expect(host.faults).toEqual([]);
    eng.setComp(player.id, "trap", 1);
    const before = eng.serialize();
    host.tick();
    expect(host.faults.at(-1)).toMatchObject({ system: "trapper", kind: "onTick" });
    expect(host.faults.at(-1)!.msg).toMatch(/ran out of fuel \(50000000 units\)/);
    expect(player.comps.get("marker")).toBeUndefined();
    // Only the clock and tick counter moved; every entity is as it was.
    expect(JSON.parse(eng.serialize()).entities).toEqual(JSON.parse(before).entities);
    // The game keeps running and the module works again on its next call.
    eng.setComp(player.id, "trap", 0);
    host.tick(); host.tick();
    expect(host.faults.length).toBe(1);
  });

  test("an unbounded allocation traps on memory and is rolled back", () => {
    const { host, eng, player } = trapWorld();
    eng.setComp(player.id, "trap", 2);
    host.tick();
    expect(host.faults.at(-1)!.msg).toMatch(/ran out of memory \(16777216 bytes\)/);
    expect(player.comps.get("marker")).toBeUndefined();
    eng.setComp(player.id, "trap", 0);
    host.tick();
    expect(host.faults.length).toBe(1);
    expect(host.systems.has("trapper")).toBe(true);
  });

  test("three traps in a minute unload the system and a system that builds on it", () => {
    const rider = testSystem({ id: "rider", buildsOn: ["trapper"], reactions: ["system.unloaded"] });
    const { host, eng, player } = trapWorld();
    host.load(rider);
    const unloaded: string[] = [];
    host.load(testSystem({ id: "watcher", reactions: ["system.unloaded"] }, () => ({ onEvent: (_n, p) => { unloaded.push(JSON.parse(p).id); } })));
    eng.setComp(player.id, "trap", 1);
    host.tick(); host.tick();
    expect(host.strikes.map((s) => s.count)).toEqual([1, 2]);
    expect(host.systems.has("trapper")).toBe(true);
    host.tick();
    expect(host.systems.has("trapper")).toBe(false);
    expect(host.systems.has("rider")).toBe(false);
    expect(host.systems.has("watcher")).toBe(true);
    expect(host.unloads.at(-1)).toMatchObject({ ids: ["trapper", "rider"], reason: "strikes" });
    expect(unloaded).toEqual(["rider", "trapper"]);
    expect(eng.banner?.text).toBe("trapper kept failing and was removed");
    // Its entities and components stay in the world without behaviour.
    expect(player.comps.get("trap")).toBe(1);
    host.tick();
    expect(host.faults.length).toBe(3);
  });

  test("strikes more than a minute apart don't unload", () => {
    const { host, eng, player } = trapWorld();
    for (let i = 0; i < 3; i++) {
      eng.setComp(player.id, "trap", 1); host.tick();
      eng.setComp(player.id, "trap", 0);
      for (let t = 0; t < 31 * 60; t++) host.tick();
    }
    expect(host.strikes.length).toBe(3);
    expect(host.systems.has("trapper")).toBe(true);
  }, 60_000);

  test("traps in tests fail the test instead of striking", () => {
    const { host } = trapWorld();
    host.mode = "test";
    host.eng.setComp(host.eng.player()!.id, "trap", 1);
    host.tick(); host.tick(); host.tick();
    expect(host.faults.length).toBe(3);
    expect(host.strikes).toEqual([]);
    expect(host.systems.has("trapper")).toBe(true);
  });
});

test("a trap in a reactor rolls back the emitter's whole transaction", async () => {
  const emitterManifest = { id: "emitter", why: "Emits a ping (test only).", emits: { "emitter.ping": {} } };
  const listenerManifest = { id: "listener", why: "Loops on a ping (test only).", buildsOn: ["emitter"], reactions: ["emitter.ping"] };
  const emitter = loadAiSystem(await compiled(emitterManifest, `import { player, getNum, setNum, emit, Obj } from "sdk";
export function onTick(): void { const p = player(); if (getNum(p, "go") != 1) return; setNum(p, "sent", 1); emit("emitter.ping", new Obj()); }
`), emitterManifest);
  const listener = loadAiSystem(await compiled(listenerManifest, `import { player } from "sdk";
export function onEvent(name: string, payload: string): void { if (player()) while (true) {} }
`), listenerManifest);
  const host = worldHost(listener, [emitter]);
  const player = host.eng.player()!;
  host.eng.setComp(player.id, "go", 1);
  host.tick();
  expect(host.faults.at(-1)).toMatchObject({ system: "listener", kind: "onTick" });
  expect(host.faults.at(-1)!.msg).toMatch(/listener\.onEvent ran out of fuel/);
  expect(player.comps.get("sent")).toBeUndefined();
  expect(host.strikes.map((s) => s.system)).toEqual(["listener"]);
  // The emitter's own fuel was shared with the listener: the emitter's account paid for the loop.
  expect(emitter.stats.calls.at(-1)).toMatchObject({ name: "onTick", used: 50_000_000n });
}, 60_000);

describe("determinism", () => {
  test("the metered binary is the same on every run", async () => {
    const again = await compiled(manifestOf("campfire"), sourceOf("campfire"));
    expect(again).toEqual(wasm.campfire);
    expect(meter(again)).toEqual(meter(wasm.campfire));
  });

  test("a module's metered binary gives the same fuel count on every run", () => {
    const run = (f: string) => {
      const def = loadAiSystem(wasm[f], manifestOf(f));
      runAiTests(def);
      return { total: def.stats.total, calls: def.stats.calls.map((c) => `${c.name}:${c.used}`) };
    };
    for (const f of FIXTURES) {
      const a = run(f), b = run(f);
      expect(a.total).toBeGreaterThan(0n);
      expect(b).toEqual(a);
    }
  });
});

test("src/ never builds code at runtime", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js)$/.test(n)) files.push(p); } };
  walk("src");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    expect({ f, hit: /new Function|\beval\(|\bimport\(/.test(text) }).toEqual({ f, hit: false });
  }
});
