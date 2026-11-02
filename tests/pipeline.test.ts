// Phase 4: the pipeline (spec 12), live load (13.1) and storage (13.2), run in Node through
// the same client, watchdog and worker protocol the browser uses (the worker runs in-process).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { loadBaseSystems } from "../src/systems/base";
import { Pipeline, type WorkerLike } from "../src/pipeline/client";
import { inProcessWorker } from "../src/pipeline/inprocess";
import { LiveLoader } from "../src/pipeline/live";
import { DevServerStore, LocalStore, sha256Hex, type ModuleCache } from "../src/pipeline/store";
import { reportText, POSITIONS_NOTE } from "../src/pipeline/report";
import { compileSystem } from "../src/sandbox/compile";
import type { FromWorker, Report, StageEvent } from "../src/pipeline/types";
import { handleStorage } from "../devserver/storage";

const fixture = (f: string) => ({ manifest: readFileSync(`fixtures/${f}/manifest.json`, "utf8"), source: readFileSync(`fixtures/${f}/module.ts`, "utf8") });

/** fetch, answered by the dev-server storage handler on `dir`. */
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
function dataDir() { const d = join(mkdtempSync(join(tmpdir(), "atw-p4-")), "data"); dirs.push(d); return d; }

/** A live game (real map, base systems) with its storage, loader and pipeline. */
function game(dir = dataDir(), createWorker: () => WorkerLike = inProcessWorker) {
  const host = new Host(buildWorld());
  loadBaseSystems(host);
  host.interactions.refresh(true);
  const store = new DevServerStore(storageFetch(dir));
  const live = new LiveLoader(host, store, { wait: async () => {} });
  const stages: StageEvent[] = [];
  const pipeline = new Pipeline({ createWorker, live, onStage: (e) => stages.push(e) });
  const compile = async (m: unknown, s: string) => { const r = await compileSystem(m, s); if (!r.ok) throw new Error(r.errors[0].message); return r.wasm; };
  return { host, eng: host.eng, store, live, pipeline, stages, dir, compile };
}
const submit = (g: ReturnType<typeof game>, f: string) => g.pipeline.submitSystem(fixture(f).manifest, fixture(f).source);

// ---------------------------------------------------------------------------
// The fixture table (spec 14): every fixture through the pipeline, on the base game.
// ---------------------------------------------------------------------------
const TABLE: { fixture: string; stage: string; ok: boolean; message?: RegExp; after?: string[] }[] = [
  { fixture: "campfire", stage: "Load", ok: true },
  { fixture: "campfire_v2", stage: "Load", ok: true, after: ["campfire"] },
  { fixture: "fireside_cat", stage: "Load", ok: true, after: ["campfire"] },
  { fixture: "chop", stage: "Load", ok: true },
  { fixture: "bad_manifest", stage: "Manifest", ok: false, message: /entities\.dragon: sprite "dragon_huge" isn't in the catalog/ },
  { fixture: "bad_prefix", stage: "Manifest", ok: false, message: /emits: "fire\.lit" must start with "bad_prefix\."/ },
  { fixture: "bad_types", stage: "Compile", ok: false, message: /^module\.ts:2:\d+ .*summonDragon/ },
  { fixture: "bad_export", stage: "Module", ok: false, message: /lists 1 interaction\(s\) but the module exports no perform/ },
  { fixture: "bad_test", stage: "Tests", ok: false, message: /bad_test\.test_dropping_a_stone_strikes_a_spark failed: check "a spark appeared" failed/ },
  { fixture: "bad_breaks_base", stage: "World check", ok: false, message: /the player can't walk any more: no step from \(15, 11\) works/ },
  { fixture: "bad_loop", stage: "World check", ok: false, message: /^bad_loop\.onTick ran out of fuel \(50000000 units\) \(tick 50 of 300/ },
  { fixture: "bad_memory", stage: "World check", ok: false, message: /^bad_memory\.onTick ran out of memory \(16777216 bytes\)/ },
];

test("every fixture folder is in the table", () => {
  expect(readdirSync("fixtures").sort()).toEqual(TABLE.map((t) => t.fixture).sort());
});

describe.each(TABLE)("fixture $fixture", ({ fixture: f, stage, ok, message, after }) => {
  test(`${ok ? "loads" : `fails at ${stage}`}${after ? ` after ${after.join(", ")}` : ""}`, async () => {
    const g = game();
    for (const a of after ?? []) expect((await submit(g, a)).ok).toBe(true);
    g.stages.length = 0;
    const before = g.eng.serialize();
    const report = await submit(g, f);
    expect({ ok: report.ok, stage: report.stage, errors: report.ok ? [] : undefined }).toMatchObject({ ok, stage });
    if (ok) {
      expect(report.errors).toEqual([]);
      expect(g.host.systems.has(f)).toBe(true);
      expect(g.eng.banner?.text).toBe("The world feels different");
      // The stage boxes lit one by one, in order, each passing.
      const passed = g.stages.filter((e) => e.status === "pass").map((e) => e.stage);
      expect(passed).toEqual(["Manifest", "Compile", "Module", "Tests", "World check", "Shots", "Load"]);
    } else {
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors.map((e) => e.message).join("\n")).toMatch(message!);
      // The live game was never touched.
      expect(g.eng.serialize()).toBe(before);
      expect(g.host.systems.has(f)).toBe(false);
      expect(g.stages.filter((e) => e.status === "fail").map((e) => e.stage)).toEqual([stage]);
      expect(reportText(report)).toContain(`failed at ${stage}`);
    }
  }, 120_000);
});

test("a compile error carries its line and source text", async () => {
  const g = game();
  const r = await submit(g, "bad_types");
  expect(r.errors[0]).toMatchObject({ line: 2, sourceLine: `import { player, summonDragon, check } from "sdk";` });
}, 60_000);

test("a failed test reports its checks, events, denials and entities", async () => {
  const g = game();
  const r = await submit(g, "bad_test");
  const e = r.errors[0];
  expect(e.test).toBe("bad_test.test_dropping_a_stone_strikes_a_spark");
  expect(e.checks).toEqual([{ label: "a spark appeared", passed: false }]);
  expect(e.events?.some((ev) => ev.name === "item.dropped")).toBe(true);
  expect(e.entities?.some((x) => x.type === "player")).toBe(true);
  expect(Array.isArray(e.denied)).toBe(true);
}, 60_000);

test("shots are produced (not rendered in Node) and logged", async () => {
  const g = game();
  const r = await g.pipeline.checkSystem(fixture("campfire").manifest, fixture("campfire").source);
  expect(r.ok).toBe(true);
  expect(r.stage).toBe("Shots");
  expect(r.shots.map((s) => s.name)).toEqual(["lit_at_night", "ash_ring"]);
  expect(r.log.join("\n")).toMatch(/shot "lit_at_night" wasn't rendered here/);
  expect(Object.keys(r.stageMs)).toEqual(["Manifest", "Compile", "Module", "Tests", "World check", "Shots"]);
}, 60_000);

// ---------------------------------------------------------------------------
// Load, loadChecked and Undo (spec 13.1)
// ---------------------------------------------------------------------------
describe("report text", () => {
  test("names spawns the host moved, and what was in the way", () => {
    const text = reportText({ ok: false, stage: "Tests", systemId: "forest_cottage", durationMs: 1, shots: [], log: [], errors: [{
      message: "forest_cottage.test_x failed", moved: [{ op: "spawn", what: "a cottage", asked: { x: 21, y: 6, area: "clearing" }, placed: { x: 21, y: 5, area: "clearing" }, inTheWay: "tree_round#12 at (23, 6)" }],
    }] } as unknown as Parameters<typeof reportText>[0]);
    expect(text).toContain("spawn a cottage: asked (21, 6, clearing), placed (21, 5, clearing); in the way: tree_round#12 at (23, 6)");
    expect(text).toContain("posOf");
    expect(text).toContain(POSITIONS_NOTE);
  });
  test("repeats the positions note only when the failure is about positions", () => {
    const report = (e: Record<string, unknown>) => reportText({ ok: false, stage: "Tests", systemId: "s", durationMs: 1, shots: [], log: [], errors: [{ message: "s.test_x failed", ...e }] } as unknown as Parameters<typeof reportText>[0]);
    expect(report({})).not.toContain(POSITIONS_NOTE);
    expect(report({ events: [{ tick: 3, name: "player.blocked", payload: {}, blockedBy: "rock_brown_small#32 at (11, 15)" }] })).toContain(POSITIONS_NOTE);
    expect(report({ denied: [{ op: "sim.teleport", code: "denied", msg: "(22, 6) in clearing isn't free for the player" }] })).toContain(POSITIONS_NOTE);
  });
});

describe("live load", () => {
  test("campfire loads live: saved, announced, and three dropped branches make a fire", async () => {
    const g = game();
    const r = await submit(g, "campfire");
    expect(r.ok).toBe(true);
    for (const f of ["manifest.json", "source.as", "module.wasm", "module.sha256"]) expect(existsSync(join(g.dir, "systems/campfire", f))).toBe(true);
    const wasm = readFileSync(join(g.dir, "systems/campfire/module.wasm"));
    expect(readFileSync(join(g.dir, "systems/campfire/module.sha256"), "utf8")).toBe(await sha256Hex(new Uint8Array(wasm)));
    expect(JSON.parse(readFileSync(join(g.dir, "systems.json"), "utf8"))).toMatchObject([{ id: "campfire", order: 0, buildsOn: ["carry"], replacedBy: null }]);
    expect(existsSync(join(g.dir, "world.json"))).toBe(true);
    expect(g.host.events.some((e) => e.name === "system.loaded" && e.payload.id === "campfire")).toBe(true);
    // Play it: three branches dropped side by side light a fire.
    g.host.mode = "test";
    const call = (req: Record<string, unknown>) => g.host.call("@engine", req as { op: string });
    for (const [x, y, dir] of [[15, 9, "down"], [15, 9, "right"], [16, 11, "up"]] as const) {
      call({ op: "sim.teleport", x, y }); call({ op: "sim.give", type: "branch" }); call({ op: "sim.face", dir }); call({ op: "sim.interact" });
    }
    expect(g.eng.query("campfire").length).toBe(1);
    expect(g.eng.rec(g.eng.query("campfire")[0])!.tags.has("lit")).toBe(true);
  }, 60_000);

  test("an id that already exists is rejected, and Undo brings the world back", async () => {
    const g = game();
    const before = g.eng.serialize();
    expect((await submit(g, "campfire")).ok).toBe(true);
    const again = await submit(g, "campfire");
    expect(again.ok).toBe(false);
    expect(again.stage).toBe("Manifest");
    expect(again.errors[0].message).toMatch(/a system with id "campfire" is already loaded/);
    expect(await g.live.undo()).toMatch(/undid campfire/);
    expect(g.host.systems.has("campfire")).toBe(false);
    expect(JSON.parse(g.eng.serialize()).entities).toEqual(JSON.parse(before).entities);
    expect(existsSync(join(g.dir, "systems/campfire"))).toBe(false);
    expect(JSON.parse(readFileSync(join(g.dir, "systems.json"), "utf8"))).toEqual([]);
    expect(await g.live.undo()).toMatch(/nothing to undo/);
    // And it can be submitted again.
    expect((await submit(g, "campfire")).ok).toBe(true);
  }, 120_000);

  test("loadChecked refuses a report when the loaded systems changed, and reports it didn't issue", async () => {
    const g = game();
    const a = await g.pipeline.checkSystem(fixture("campfire").manifest, fixture("campfire").source);
    const b = await g.pipeline.checkSystem(fixture("chop").manifest, fixture("chop").source);
    expect((await g.pipeline.loadChecked(a)).ok).toBe(true);
    const r = await g.pipeline.loadChecked(b);
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/the loaded systems changed since the check/);
    expect(g.host.systems.has("chop")).toBe(false);
    const forged: Report = { ...a, systemId: "campfire2" };
    expect((await g.pipeline.loadChecked(forged)).errors[0].message).toMatch(/didn't come from a passed checkSystem/);
    expect((await g.pipeline.loadChecked(a)).ok).toBe(false); // a report loads once
  }, 120_000);

  test("chop loads after campfire (campfire's tests run again with chop loaded), and both survive a restart", async () => {
    const g = game();
    expect((await submit(g, "campfire")).ok).toBe(true);
    const r = await submit(g, "chop");
    expect(r.ok).toBe(true);
    // chop makes branches and campfire burns them, so campfire's tests ran again with chop loaded.
    expect(r.log.find((l) => l.startsWith("re-ran campfire's tests"))).toMatch(/shares .*branch/);
    expect(g.eng.query("axe").length).toBe(1);
    // Play on a little, then save as autosave would.
    for (let i = 0; i < 120; i++) g.host.tick();
    await g.live.saveWorld();
    const saved = JSON.parse(g.eng.serialize());
    // A page refresh: a fresh host, base systems, then the stored systems and the saved world.
    const h = game(g.dir);
    await h.live.startup(h.compile);
    expect([...h.host.systems.keys()]).toEqual(["movement", "carry", "push", "daynight", "campfire", "chop"]);
    expect(h.live.skipped).toEqual([]);
    expect(JSON.parse(h.eng.serialize()).entities).toEqual(saved.entities);
    expect(JSON.parse(h.eng.serialize()).clock).toEqual(saved.clock);
    expect(h.eng.query("axe").length).toBe(1); // migrate didn't run again
    // Chop still works after the restart: freeze focus, then branches.
    h.host.mode = "test";
    const call = (req: Record<string, unknown>) => h.host.call("@engine", req as { op: string });
    const logs = () => h.eng.query("pushable").filter((id) => h.eng.rec(id)!.type === "log_fallen");
    const n = logs().length;
    call({ op: "sim.teleport", x: 9, y: 8 }); call({ op: "sim.face", dir: "up" }); call({ op: "sim.interact" });
    expect((h.eng.player()!.comps.get("held") as { id: number }).id).toBe(h.eng.query("axe")[0]);
    call({ op: "sim.teleport", x: 12, y: 9 }); call({ op: "sim.face", dir: "up" }); call({ op: "sim.interact" });
    expect(h.host.focus.mode).toBe("freeze");
    call({ op: "sim.wait", ticks: 60 });
    expect(logs().length).toBe(n - 1);
    expect(h.host.focus.holder).toBeNull();
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Startup from storage (spec 13.2)
// ---------------------------------------------------------------------------
const RIDER = { manifest: JSON.stringify({ id: "rider", why: "Builds on campfire (test only).", buildsOn: ["campfire"] }), source: `import { player, check } from "sdk";\nexport function onTick(): void { player(); }\nexport function test_ok(): void { check(true, "ok"); }\n` };
const LOOPER = `import { player } from "sdk";\nexport function onTick(): void { if (player()) while (true) {} }\n`;

describe("startup", () => {
  async function twoSystems() {
    const g = game();
    expect((await submit(g, "campfire")).ok).toBe(true);
    expect((await g.pipeline.submitSystem(RIDER.manifest, RIDER.source)).ok).toBe(true);
    return g;
  }

  test("a stored module that isn't valid WebAssembly is rejected, and what builds on it is skipped", async () => {
    const g = await twoSystems();
    const junk = new TextEncoder().encode("not wasm at all");
    writeFileSync(join(g.dir, "systems/campfire/module.wasm"), junk);
    writeFileSync(join(g.dir, "systems/campfire/module.sha256"), await sha256Hex(junk));
    const h = game(g.dir);
    await h.live.startup(h.compile);
    expect(h.host.systems.has("campfire")).toBe(false);
    expect(h.live.skipped).toEqual([
      { id: "campfire", reason: "the bytes aren't a valid WebAssembly module" },
      { id: "rider", reason: "it builds on campfire, which was skipped" },
    ]);
  }, 120_000);

  test("a tampered module.wasm with a matching hash is still metered: its loop runs out of fuel", async () => {
    const g = await twoSystems();
    const r = await compileSystem({ id: "campfire" }, LOOPER);
    if (!r.ok) throw new Error("compile failed");
    // Keep the manifest's other needs out of the way: a module with only onTick, under campfire's id.
    writeFileSync(join(g.dir, "systems/campfire/manifest.json"), JSON.stringify({ id: "campfire", why: "tampered" }));
    writeFileSync(join(g.dir, "systems/campfire/module.wasm"), r.wasm);
    writeFileSync(join(g.dir, "systems/campfire/module.sha256"), await sha256Hex(r.wasm));
    const h = game(g.dir);
    await h.live.startup(h.compile);
    expect(h.host.systems.has("campfire")).toBe(true);
    h.host.tick();
    expect(h.host.faults.at(-1)?.msg).toMatch(/campfire\.onTick ran out of fuel/);
  }, 120_000);

  test("a module.wasm that doesn't match module.sha256 is compiled again from source", async () => {
    const g = await twoSystems();
    const good = readFileSync(join(g.dir, "systems/campfire/module.wasm"));
    writeFileSync(join(g.dir, "systems/campfire/module.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const h = game(g.dir);
    await h.live.startup(h.compile);
    expect(h.host.systems.has("campfire")).toBe(true);
    expect(h.host.systems.has("rider")).toBe(true);
    expect(h.live.notes.join("\n")).toMatch(/campfire: module\.wasm doesn't match module\.sha256/);
    expect(new Uint8Array(readFileSync(join(g.dir, "systems/campfire/module.wasm")))).toEqual(new Uint8Array(good));
  }, 120_000);

  test("Start fresh deletes everything; the next start is the base game and campfire can be submitted again", async () => {
    const g = await twoSystems();
    await g.store.appendAiLog(JSON.stringify({ role: "user", chars: 1 }));
    await g.store.saveJournal([{ title: "x" }]);
    await g.live.startFresh();
    await g.live.saveWorld(); // nothing is saved again before the reload
    expect(readdirSync(g.dir)).toEqual([]);
    const h = game(g.dir);
    await h.live.startup(h.compile);
    expect([...h.host.systems.keys()]).toEqual(["movement", "carry", "push", "daynight"]);
    expect(h.eng.serialize()).toBe(game().eng.serialize());
    expect((await submit(h, "campfire")).ok).toBe(true);
  }, 180_000);

  test("a built copy keeps modules in a cache keyed by the source hash and recompiles when it is gone", async () => {
    const mem = new Map<string, string>();
    const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    const modules = new Map<string, Uint8Array<ArrayBuffer>>();
    const cache: ModuleCache = { get: async (k) => modules.get(k) ?? null, put: async (k, w) => { modules.set(k, w); }, clear: async () => { modules.clear(); } };
    const make = () => {
      const host = new Host(buildWorld()); loadBaseSystems(host);
      const live = new LiveLoader(host, new LocalStore(ls, cache), { wait: async () => {} });
      return { host, live, pipeline: new Pipeline({ createWorker: inProcessWorker, live }) };
    };
    const a = make();
    expect((await a.pipeline.submitSystem(fixture("campfire").manifest, fixture("campfire").source)).ok).toBe(true);
    expect([...modules.keys()]).toEqual([await sha256Hex(fixture("campfire").source)]);
    expect(JSON.parse(mem.get("atw.systems")!)[0]).toMatchObject({ id: "campfire", source: fixture("campfire").source });
    await a.live.saveWorld();
    modules.clear(); // the IndexedDB cache was deleted
    const b = make();
    let compiles = 0;
    await b.live.startup(async (m, s) => { compiles++; const r = await compileSystem(m, s); if (!r.ok) throw new Error("no"); return r.wasm; });
    expect(compiles).toBe(1);
    expect(b.host.systems.has("campfire")).toBe(true);
    expect(modules.size).toBe(1);
    expect(b.live.notes.join("\n")).toMatch(/compiled module was missing/);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The watchdog (spec 12)
// ---------------------------------------------------------------------------
test("the watchdog kills a worker whose stage runs over its time limit", async () => {
  let terminated = false;
  const hanging = (): WorkerLike => {
    let handler: ((m: FromWorker) => void) | null = null;
    return {
      postMessage() { setTimeout(() => { handler?.({ type: "stage", event: { stage: "Manifest", status: "start" } }); handler?.({ type: "stage", event: { stage: "Manifest", status: "pass", ms: 1 } }); handler?.({ type: "stage", event: { stage: "Compile", status: "start" } }); handler?.({ type: "stage", event: { stage: "Compile", status: "pass", ms: 1 } }); handler?.({ type: "stage", event: { stage: "Module", status: "pass", ms: 1 } }); handler?.({ type: "stage", event: { stage: "Tests", status: "start" } }); }, 0); },
      terminate() { terminated = true; },
      setHandler(fn) { handler = fn; },
    };
  };
  const g = game(dataDir(), hanging);
  const p = new Pipeline({ createWorker: hanging, live: g.live, limits: { compileMs: 1000, stageMs: 5000, testsStageMs: 50 }, onStage: (e) => g.stages.push(e) });
  const r = await p.checkSystem(fixture("campfire").manifest, "");
  expect(terminated).toBe(true);
  expect(r).toMatchObject({ ok: false, stage: "Tests", systemId: "campfire" });
  expect(r.errors[0].message).toBe("the Tests stage took longer than 0.05 s, so the pipeline stopped it; the game kept running");
  expect(g.stages.at(-1)).toMatchObject({ stage: "Tests", status: "fail" });
});

test("doorOf gives the tile in front of a building's door, and the door tile itself is solid", async () => {
  const g = game();
  const manifest = JSON.stringify({ id: "doors", why: "A house to test doorOf with.", entities: { house: { sprite: "house_orange_roof", tags: ["solid"] } } });
  const source = `import { spawn, doorOf, posOf, isFree, check, simTeleport, simFace, simWalk, playerPos, spaceFind } from "sdk";
export function migrate(): void {}
export function test_door(): void {
  const s = spaceFind(13, 4, 4, 3)!; // the house's two rows and the row in front of it
  const h = spawn("house", s.x, s.y + 1);
  const p = posOf(h)!;
  const d = doorOf(h);
  check(d != null && d.x == p.x + 1 && d.y == p.y + 1, "the doorstep is below the door column");
  check(isFree(d!.x, d!.y), "the doorstep is free");
  check(!isFree(d!.x, d!.y - 1), "the door tile itself is solid");
  simTeleport(d!.x, d!.y); simFace("up"); simWalk("up");
  const pp = playerPos()!;
  check(pp.x == d!.x && pp.y == d!.y, "walking into the door is blocked");
  check(doorOf(0) == null, "nothing has no door");
}`;
  const r = await g.pipeline.checkSystem(manifest, source);
  expect(reportText(r)).not.toContain("failed");
  expect(r.ok).toBe(true);
});

test("areaCreate makes a room smaller than the map, and areaSize reads it back", async () => {
  const g = game();
  const manifest = JSON.stringify({ id: "hut", why: "A small room to test area sizes with." });
  const source = `import { areaCreate, areaSize, areaList, travel, playerPos, check, simWalk, simFace } from "sdk";
export function migrate(): void {
  if (!areaList().includes("hut.inside")) areaCreate("inside", "interior_floor_brown_plain", 8, 6);
}
export function test_room(): void {
  const s = areaSize("hut.inside");
  check(s.w == 8 && s.h == 6, "the room is 8x6");
  check(travel("hut.inside", s.w - 1, 2), "travel to the east wall");
  check(areaSize().w == 8, "areaSize() is the current area's");
  simFace("right"); simWalk("right");
  check(playerPos()!.x == s.w - 1, "the room's edge blocks");
  check(!travel("hut.inside", 20, 2), "outside the room is refused");
}`;
  const r = await g.pipeline.checkSystem(manifest, source);
  expect(reportText(r)).not.toContain("failed");
  expect(r.ok).toBe(true);
});

test("a handler that runs out of fuel during a test is named, with where its fuel went, and its events show as undone", async () => {
  const g = game();
  const manifest = JSON.stringify({ id: "greedy", why: "A dawn handler that asks too much.", reactions: ["time.dawn"], emits: { "greedy.woke": {} } });
  const source = `import { emit, info, query, simTime, check, Obj } from "sdk";
export function migrate(): void {}
export function onEvent(name: string, payload: string): void {
  if (name != "time.dawn") return;
  emit("greedy.woke", new Obj());
  for (let i = 0; i < 100000; i++) info(1 + (i % 40));
}
export function test_dawn(): void {
  simTime("night"); simTime("dawn");
  check(query("player").length == 1, "still here");
}`;
  const r = await g.pipeline.checkSystem(manifest, source);
  const text = reportText(r);
  expect(r.ok).toBe(false);
  // The handler is named, not the test, and the message says what the fuel went on.
  expect(text).toContain("greedy.test_dawn failed: it threw: greedy.onEvent ran out of fuel (50000000 units) after");
  expect(text).toMatch(/SDK calls \(info \d+/);
  expect(text).not.toContain("test_dawn ran out of fuel");
  // What the rolled-back handler emitted is marked as undone.
  expect(text).toMatch(/greedy\.woke \{\} \(undone, rolled back: greedy faulted\)/);
});

test("each test has its own time limit, and a timeout names the test that ran over", async () => {
  const slow = (): WorkerLike => {
    let handler: ((m: FromWorker) => void) | null = null;
    const send = (m: FromWorker, ms: number) => setTimeout(() => handler?.(m), ms);
    return {
      postMessage() {
        send({ type: "stage", event: { stage: "Tests", status: "start" } }, 0);
        // Three tests of 40 ms each: 120 ms in all, over a 60 ms test budget only if one test is.
        send({ type: "test", name: "campfire.test_a" }, 1); send({ type: "test", name: "campfire.test_b" }, 41); send({ type: "test", name: "campfire.test_c" }, 81);
        // test_c never finishes.
      },
      terminate() {},
      setHandler(fn) { handler = fn; },
    };
  };
  const g = game(dataDir(), slow);
  const p = new Pipeline({ createWorker: slow, live: g.live, limits: { compileMs: 1000, stageMs: 1000, testMs: 60, testsStageMs: 5000 } });
  const t0 = Date.now();
  const r = await p.checkSystem(fixture("campfire").manifest, "");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(130); // test_a and test_b each stayed inside their own 60 ms
  expect(r).toMatchObject({ ok: false, stage: "Tests", errors: [{ test: "campfire.test_c" }] });
  expect(r.errors[0].message).toMatch(/^campfire\.test_c took longer than 0\.06 s/);
});
