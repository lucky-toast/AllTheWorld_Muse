// Phase 6: succession (spec 11). campfire_v2 replaces campfire; fireside_cat builds on campfire.
// Everything runs through the same pipeline, live loader and dev-server storage the game uses
// (the worker runs in-process).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { loadBaseSystems } from "../src/systems/base";
import { Pipeline } from "../src/pipeline/client";
import { inProcessWorker } from "../src/pipeline/inprocess";
import { LiveLoader } from "../src/pipeline/live";
import { DevServerStore } from "../src/pipeline/store";
import { compileSystem } from "../src/sandbox/compile";
import { runAiTests } from "../src/sandbox/runners";
import { buildPrompt } from "../src/ai/designer";
import { buildPlannerPrompt } from "../src/ai/planner";
import { handleStorage } from "../devserver/storage";
import type { Request } from "../src/engine/host";

const read = (p: string) => readFileSync(p, "utf8");
const fixture = (f: string) => ({ manifest: read(`fixtures/${f}/manifest.json`), source: read(`fixtures/${f}/module.ts`) });

function storageFetch(dir: string) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const b = init?.body;
    const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b instanceof Uint8Array ? b : b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : undefined;
    const r = handleStorage(dir, init?.method ?? "GET", url.replace(/^\/__data/, ""), bytes);
    const out = r.body instanceof Uint8Array || typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(out as BodyInit, { status: r.status, headers: { "content-type": r.type ?? "application/json" } });
  };
}
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function dataDir() { const d = join(mkdtempSync(join(tmpdir(), "atw-p6-")), "data"); dirs.push(d); return d; }

function game(dir = dataDir()) {
  const host = new Host(buildWorld());
  loadBaseSystems(host);
  host.interactions.refresh(true);
  const store = new DevServerStore(storageFetch(dir));
  const live = new LiveLoader(host, store, { wait: async () => {} });
  const pipeline = new Pipeline({ createWorker: inProcessWorker, live });
  const compile = async (m: unknown, s: string) => { const r = await compileSystem(m, s); if (!r.ok) throw new Error(r.errors[0].message); return r.wasm; };
  const eng = host.eng;
  /** A sim request as the engine (test mode while it runs). */
  const sim = (req: Record<string, unknown>) => { const m = host.mode; host.mode = "test"; try { return host.call("@engine", req as Request); } finally { host.mode = m; } };
  /** Drop three branches in an L around (15, 10), or the same L at (10, 5) with `elsewhere` (a clear spot on the map), like a player would. */
  const buildFire = (elsewhere = false) => {
    const dx = elsewhere ? -5 : 0, dy = elsewhere ? -5 : 0;
    for (const [x, y, dir] of [[15, 9, "down"], [15, 9, "right"], [16, 11, "up"]] as const) {
      sim({ op: "sim.teleport", x: x + dx, y: y + dy }); sim({ op: "sim.give", type: "branch" }); sim({ op: "sim.face", dir }); sim({ op: "sim.interact" });
    }
    sim({ op: "sim.teleport", x: 15, y: 13 });
  };
  const fires = () => eng.query("campfire").map((id) => eng.rec(id)!);
  const light = (id: number) => eng.rec(id)!.comps.get("light") as { radius: number } | undefined;
  const index = () => JSON.parse(read(join(dir, "systems.json"))) as { id: string; replacedBy: string | null }[];
  const ticks = (n: number) => { for (let i = 0; i < n; i++) host.tick(); };
  const submitText = (manifest: string, source: string) => pipeline.submitSystem(manifest, source);
  const submit = (f: string) => submitText(fixture(f).manifest, fixture(f).source);
  return { host, eng, store, live, pipeline, compile, dir, sim, buildFire, fires, light, index, ticks, submit, submitText };
}
type Game = ReturnType<typeof game>;

/** campfire loads and lights a fire, fireside_cat loads, then campfire_v2 replaces campfire. */
async function succession(g: Game = game()) {
  expect((await g.submit("campfire")).ok).toBe(true);
  g.buildFire();
  expect(g.fires().length).toBe(1);
  g.ticks(100); // part way through the burn
  expect((await g.submit("fireside_cat")).ok).toBe(true);
  const fire = g.fires()[0].id;
  const before = g.eng.serialize();
  const replacedReads: string[] = [];
  const call = g.host.call.bind(g.host);
  g.host.call = (system: string, req: Request) => { if (req.op === "state.getReplaced") replacedReads.push(system); return call(system, req); };
  const report = await g.submit("campfire_v2");
  g.host.call = call;
  expect(report.errors).toEqual([]);
  expect(report.ok).toBe(true);
  return { g, fire, before, replacedReads };
}

const BASE = ["movement", "carry", "push", "daynight"];

describe("campfire_v2 replaces campfire", () => {
  test("it loads in one step; campfire stops reacting; the lit fire keeps burning under it; its state is handed over once", async () => {
    const { g, fire, replacedReads } = await succession();
    const { host, eng } = g;
    expect([...host.systems.keys()]).toEqual([...BASE, "fireside_cat", "campfire_v2"]);
    expect(host.successors.get("campfire")).toBe("campfire_v2");
    expect(host.registry.reactors("item.dropped")).not.toContain("campfire");
    expect(host.registry.eventOwner.get("campfire.lit")).toBe("campfire_v2");
    expect(host.registry.eventOwner.get("campfire.out")).toBe("campfire_v2");
    expect(host.events.some((e) => e.name === "system.unloaded" && e.payload.id === "campfire" && e.payload.reason === "replaced by campfire_v2")).toBe(true);
    expect(host.events.some((e) => e.name === "system.loaded" && e.payload.id === "campfire_v2")).toBe(true);
    // Ownership records moved to the new system.
    expect(eng.entityOwner.get(fire)).toBe("campfire_v2");
    expect(eng.typeOwner.get("campfire")).toBe("campfire_v2");
    expect(eng.componentOwner.get("burnLeft")).toBe("campfire_v2");
    expect([...eng.entityOwner.values()]).not.toContain("campfire");
    // migrate read campfire's state once on the live game, and that state is gone now.
    expect(replacedReads).toEqual(["campfire_v2"]);
    expect(eng.systemState.has("campfire")).toBe(false);
    expect(eng.systemState.get("campfire_v2")).toEqual({ lit: 1 });
    // The old fire flared up under the new system and keeps burning down.
    const rec = eng.rec(fire)!;
    expect(rec.tags.has("lit")).toBe(true);
    expect(g.light(fire)?.radius).toBe(70);
    const left = rec.comps.get("burnLeft") as number;
    g.ticks(10);
    expect(rec.comps.get("burnLeft")).toBe(left - 10);
    // ...all the way to ash, and the cat (which built on campfire) leaves when it goes out.
    expect(eng.query("fireside_cat").length).toBe(0); // the cat came after this fire was lit
    g.ticks(left + 120);
    expect(rec.tags.has("ash")).toBe(true);
    expect(host.events.some((e) => e.name === "campfire.out")).toBe(true);
    // A new fire is campfire_v2's alone: one pit, the wide light, and a cat comes.
    g.buildFire(true);
    const lit = g.fires().filter((r) => r.tags.has("lit"));
    expect(lit.length).toBe(1);
    expect(g.light(lit[0].id)?.radius).toBe(70);
    expect(eng.entityOwner.get(lit[0].id)).toBe("campfire_v2");
    expect(eng.query("fireside_cat").length).toBe(1);
    expect(eng.systemState.get("campfire_v2")).toEqual({ lit: 2 });
    // Storage keeps campfire, marked replacedBy.
    expect(g.index()).toMatchObject([
      { id: "campfire", replacedBy: "campfire_v2" },
      { id: "fireside_cat", replacedBy: null },
      { id: "campfire_v2", replacedBy: null },
    ]);
    expect(existsSync(join(g.dir, "systems/campfire/module.wasm"))).toBe(true);
  }, 300_000);

  test("fireside_cat, which builds on campfire, still passes its tests with campfire_v2 loaded", async () => {
    const { g } = await succession();
    const cat = g.host.systems.get("fireside_cat")!.def;
    const v2 = g.host.systems.get("campfire_v2")!.def;
    const results = runAiTests(cat, [v2]);
    expect(results.map((r) => r.name)).toEqual(["a_lit_fire_brings_a_cat", "the_cat_leaves_when_the_fire_goes_out"]);
    for (const r of results) expect({ name: r.name, passed: r.passed, failed: r.checks.filter((c) => !c.passed) }).toEqual({ name: r.name, passed: true, failed: [] });
    // A replaced id in buildsOn counts as its replacement: unloading campfire_v2 takes the cat with it.
    expect(g.host.dependentsOf("campfire_v2")).toEqual(["fireside_cat"]);
    // And a new system may still say buildsOn campfire.
    const rider = { id: "rider", why: "Builds on campfire (test only).", buildsOn: ["campfire"] };
    const r = await g.submitText(JSON.stringify(rider), `import { player, check } from "sdk";\nexport function test_ok(): void { check(player() != 0, "ok"); }\n`);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  }, 300_000);

  test("Undo after the succession brings the old campfire back, working", async () => {
    const { g, fire, before } = await succession();
    const { host, eng } = g;
    expect(await g.live.undo()).toMatch(/undid campfire_v2: .* and campfire is back/);
    expect([...host.systems.keys()]).toEqual([...BASE, "campfire", "fireside_cat"]);
    expect(host.successors.size).toBe(0);
    expect(host.registry.reactors("item.dropped")).toContain("campfire");
    expect(host.registry.eventOwner.get("campfire.lit")).toBe("campfire");
    expect(eng.serialize()).toBe(before);
    expect(eng.entityOwner.get(fire)).toBe("campfire");
    expect(eng.systemState.get("campfire")).toEqual({ lit: 1 });
    expect(g.light(fire)?.radius).toBe(46);
    expect(existsSync(join(g.dir, "systems/campfire_v2"))).toBe(false);
    expect(g.index()).toMatchObject([{ id: "campfire", replacedBy: null }, { id: "fireside_cat", replacedBy: null }]);
    expect(g.index().length).toBe(2);
    // campfire works: the old fire burns down under it, and a new fire is its kind (and brings a cat).
    const rec = eng.rec(fire)!;
    const left = rec.comps.get("burnLeft") as number;
    g.ticks(10);
    expect(rec.comps.get("burnLeft")).toBe(left - 10);
    g.ticks(left + 120);
    expect(rec.tags.has("ash")).toBe(true);
    g.buildFire(true);
    const lit = g.fires().filter((r) => r.tags.has("lit"));
    expect(lit.length).toBe(1);
    expect(g.light(lit[0].id)?.radius).toBe(46);
    expect(eng.entityOwner.get(lit[0].id)).toBe("campfire");
    expect(eng.query("fireside_cat").length).toBe(1);
    expect(eng.systemState.get("campfire")).toEqual({ lit: 2 });
    // campfire_v2 can be submitted again.
    expect((await g.submit("campfire_v2")).ok).toBe(true);
    expect(host.systems.has("campfire")).toBe(false);
  }, 300_000);

  test("after a reload, campfire isn't instantiated and campfire_v2 is", async () => {
    const { g, fire } = await succession();
    await g.live.saveWorld();
    const h = game(g.dir);
    const created: string[] = [];
    const load = h.host.load.bind(h.host);
    h.host.load = (def, opts) => { created.push((def.manifest as { id: string }).id); return load(def, opts); };
    await h.live.startup(h.compile);
    expect(created).toEqual(["fireside_cat", "campfire_v2"]);
    expect([...h.host.systems.keys()]).toEqual([...BASE, "fireside_cat", "campfire_v2"]);
    expect(h.live.skipped).toEqual([]);
    expect(h.live.records.has("campfire")).toBe(false);
    expect(h.host.successors.get("campfire")).toBe("campfire_v2");
    // The fire keeps burning under campfire_v2, and the cat still answers its events.
    const rec = h.eng.rec(fire)!;
    expect(h.eng.entityOwner.get(fire)).toBe("campfire_v2");
    const left = rec.comps.get("burnLeft") as number;
    h.ticks(5);
    expect(rec.comps.get("burnLeft")).toBe(left - 5);
    h.buildFire(true);
    expect(h.eng.query("fireside_cat").length).toBe(1);
  }, 300_000);

  test("the designer and planner prompts drop campfire's block and show replaces on campfire_v2's", async () => {
    const g = game();
    expect((await g.submit("campfire")).ok).toBe(true);
    const text = (p: { cached: string; rest: string }) => p.cached + p.rest;
    expect(text(buildPrompt(g.host, "task"))).toContain("## System: campfire\n");
    expect((await g.submit("fireside_cat")).ok).toBe(true);
    expect((await g.submit("campfire_v2")).ok).toBe(true);
    for (const p of [buildPrompt(g.host, "task"), buildPlannerPrompt(g.host, "a warmer fire")]) {
      const t = text(p);
      expect(t).not.toContain("## System: campfire\n");
      expect(p.slots.AI_SYSTEMS).toContain("## System: fireside_cat\n");
      expect(p.slots.AI_SYSTEMS).not.toContain("campfire_v2");
      expect(p.slots.NEWEST_AI_SYSTEM).toMatch(/^## System: campfire_v2\nwhy: .*\nbuildsOn: \[carry\]\nreplaces: \[campfire\]\n/);
    }
  }, 300_000);
});

test("the Tests stage drops campfire's own tests and re-runs fireside_cat's with the replacement", async () => {
  const g = game();
  expect((await g.submit("campfire")).ok).toBe(true);
  expect((await g.submit("fireside_cat")).ok).toBe(true);
  // A replacement that never announces a lit fire breaks the cat, which relies on campfire.lit.
  // Its own tests stop checking for the event, so they pass and the cat's tests are what fail.
  const quiet = fixture("campfire_v2").source.replace(`emit("campfire.lit",`, `if (false) emit("campfire.lit",`).replace(`check(simEvents("campfire.lit").length == 1, "campfire.lit fired once");`, "");
  const r = await g.submitText(fixture("campfire_v2").manifest, quiet);
  expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "Tests" });
  const tests = r.errors.map((e) => e.test);
  expect(tests).toContain("fireside_cat.test_a_lit_fire_brings_a_cat");
  expect(tests.some((t) => t?.startsWith("campfire."))).toBe(false);
  expect(g.host.systems.has("campfire")).toBe(true);
}, 300_000);

describe("the Manifest stage refuses a bad replacement", () => {
  test("a replacement missing one of campfire's events fails with a readable message", async () => {
    const g = game();
    expect((await g.submit("campfire")).ok).toBe(true);
    const before = g.eng.serialize();
    const m = JSON.parse(fixture("campfire_v2").manifest);
    delete m.emits["campfire.out"];
    const r = await g.submitText(JSON.stringify(m), fixture("campfire_v2").source);
    expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "Manifest" });
    expect(r.errors.map((e) => e.message)).toEqual([`replaces "campfire": it emits "campfire.out", so "campfire.out" must stay in emits under the same name (systems that react to it rely on it)`]);
    expect(g.eng.serialize()).toBe(before);
    expect(g.host.systems.has("campfire")).toBe(true);
  }, 120_000);

  test("replacing a base system fails", async () => {
    const g = game();
    const m = { id: "carry2", why: "Carry, but better.", replaces: ["carry"] };
    const r = await g.submitText(JSON.stringify(m), `import { check } from "sdk";\nexport function test_ok(): void { check(true, "ok"); }\n`);
    expect({ ok: r.ok, stage: r.stage }).toEqual({ ok: false, stage: "Manifest" });
    expect(r.errors.map((e) => e.message)).toEqual([`replaces: "carry" is a base system, and base systems can't be replaced`]);
    expect(g.host.systems.has("carry")).toBe(true);
  }, 60_000);

  test("replacing something that isn't loaded, or was already replaced, fails", async () => {
    const g = game();
    const src = `import { check } from "sdk";\nexport function test_ok(): void { check(true, "ok"); }\n`;
    let r = await g.submitText(JSON.stringify({ id: "ghost2", why: "x", replaces: ["ghost"] }), src);
    expect(r.errors.map((e) => e.message)).toEqual([`replaces: "ghost" isn't a loaded AI system`]);
    expect((await g.submit("campfire")).ok).toBe(true);
    expect((await g.submit("campfire_v2")).ok).toBe(true);
    const m = JSON.parse(fixture("campfire_v2").manifest); m.id = "campfire_v3";
    r = await g.submitText(JSON.stringify(m), fixture("campfire_v2").source);
    expect(r.errors.map((e) => e.message)).toEqual([`replaces: "campfire" was already replaced by "campfire_v2"; replace that instead`]);
  }, 300_000);
});

describe("Host.load with replaces", () => {
  test("state.getReplaced works during migrate only, a failed migrate puts the old system back, and the state survives", () => {
    const host = new Host(buildWorld());
    loadBaseSystems(host);
    const reads: unknown[] = [];
    host.load({ base: false, manifest: { id: "old", why: "x", emits: { "old.ping": {} } }, create: (call) => ({ migrate() { call({ op: "state.set", value: { n: 7 } } as Request); } }) });
    expect(host.eng.systemState.get("old")).toEqual({ n: 7 });
    const order = [...host.systems.keys()];
    // A migrate that throws: nothing changes.
    expect(() => host.load({ base: false, manifest: { id: "new1", why: "x", replaces: ["old"], emits: { "old.ping": {} } }, create: () => ({ migrate() { throw new Error("boom"); } }) })).toThrow(/migrate of "new1" failed/);
    expect([...host.systems.keys()]).toEqual(order);
    expect(host.successors.size).toBe(0);
    expect(host.eng.systemState.get("old")).toEqual({ n: 7 });
    // A good one reads the state once, then it is gone; reading it later is denied.
    let later: (() => unknown) | null = null;
    host.load({ base: false, manifest: { id: "new2", why: "x", replaces: ["old"], emits: { "old.ping": {} } }, create: (call) => {
      later = () => call({ op: "state.getReplaced", id: "old" } as Request);
      return { migrate() { reads.push(call({ op: "state.getReplaced", id: "old" } as Request)); } };
    } });
    expect(reads).toEqual([{ ok: true, r: { n: 7 } }]);
    expect(host.eng.systemState.has("old")).toBe(false);
    expect(later!()).toMatchObject({ ok: false, code: "phase" });
    expect(host.systems.has("old")).toBe(false);
    expect(host.registry.owns("new2", "old.ping")).toBe(true);
    // Forget (Undo) puts "old" back in its place.
    host.forget("new2");
    expect([...host.systems.keys()]).toEqual(order);
    expect(host.registry.owns("old", "old.ping")).toBe(true);
  });
});
