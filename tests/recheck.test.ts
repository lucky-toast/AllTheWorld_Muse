// The World check again at Load, off the main thread (src/pipeline/recheck.ts): Load hands the
// recheck the modules the live game already prepared (nothing metered or compiled again), its
// outcome decides the Load as before, a request survives being posted to a worker, and the worker
// client keeps a spare, ends each worker after one recheck, times out, and falls back in-thread.
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { loadBaseSystems } from "../src/systems/base";
import { LiveLoader } from "../src/pipeline/live";
import { LocalStore, type ModuleCache } from "../src/pipeline/store";
import { runRecheck, workerRecheck, type RecheckRequest, type RecheckResult } from "../src/pipeline/recheck";
import { aiSystem, prepareModule, type AiSystemDef } from "../src/sandbox/module";
import type { Report } from "../src/pipeline/types";
import { baseModule } from "./wasm";

/** A system whose module only has an empty onTick (no compiler needed). */
const TICKER = baseModule({ funcs: [{ type: 4, body: [0x0b] }], exports: [{ name: "onTick", func: 8 }] });
const manifestOf = (id: string) => JSON.stringify({ id, why: "Ticks, for the recheck tests." });

/** A report as a passed check gives it, for a ticker system called `id`. */
function passed(id: string): Report {
  return { ok: true, stage: "Shots", systemId: id, errors: [], shots: [], durationMs: 1, log: [], stageMs: {}, checked: { manifestJson: manifestOf(id), source: "", wasm: TICKER, loaded: [] } } as unknown as Report;
}

function game(recheck?: (req: RecheckRequest) => Promise<RecheckResult>) {
  const host = new Host(buildWorld());
  loadBaseSystems(host);
  host.interactions.refresh(true);
  const ls = new Map<string, string>();
  const mem: ModuleCache = { get: async () => null, put: async () => {}, clear: async () => {} };
  const store = new LocalStore({ getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => void ls.set(k, v), removeItem: (k) => void ls.delete(k) }, mem);
  const live = new LiveLoader(host, store, { wait: async () => {}, ...(recheck ? { recheck } : {}) });
  return { host, live };
}

describe("the Load recheck", () => {
  test("gets the live game's own prepared modules, in load order, and the world under the leaf", async () => {
    const seen: RecheckRequest[] = [];
    const g = game(async (req) => { seen.push(req); return runRecheck(req); });
    expect((await g.live.load(passed("tick_a"))).ok).toBe(true);
    expect((await g.live.load(passed("tick_b"))).ok).toBe(true);
    const a = g.host.systems.get("tick_a")!.def as AiSystemDef;
    expect(seen).toHaveLength(2);
    // The second Load sends tick_a's module object itself: it isn't metered or compiled again.
    expect(seen[1].loaded).toHaveLength(1);
    expect(seen[1].loaded[0].module).toBe(a.prepared.module);
    expect(seen[1].candidate.systemId).toBe("tick_b");
    expect(typeof seen[1].world).toBe("string");
  });

  test("a recheck that finds errors refuses the Load and restores the world", async () => {
    const g = game(async () => ({ errors: [{ message: "the player can't walk any more" }], log: [] }));
    const before = g.host.eng.serialize();
    const r = await g.live.load(passed("tick_a"));
    expect(r).toMatchObject({ ok: false, stage: "World check" });
    expect(r.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^the world changed while your system was being checked/), "the player can't walk any more"]);
    expect(g.host.systems.has("tick_a")).toBe(false);
    expect(g.host.eng.serialize()).toBe(before);
  });

  test("a recheck that fails to run refuses the Load with its reason", async () => {
    const g = game(async () => { throw new Error("the World check on the live world took longer than 20 s"); });
    const r = await g.live.load(passed("tick_a"));
    expect(r).toMatchObject({ ok: false, stage: "World check" });
    expect(r.errors[0].message).toBe("the World check couldn't run again on the live world: the World check on the live world took longer than 20 s");
    expect(g.host.systems.has("tick_a")).toBe(false);
  });

  test("a request survives being copied to a worker, and the recheck passes on it", () => {
    const host = new Host(buildWorld()); loadBaseSystems(host);
    const loaded = ["tick_a", "tick_b"].map((id) => prepareModule(TICKER, JSON.parse(manifestOf(id))));
    for (const p of loaded) host.load(aiSystem(p), { migrate: false });
    const req: RecheckRequest = { world: host.eng.snapshot(), loaded, candidate: prepareModule(TICKER, JSON.parse(manifestOf("tick_c"))), successors: [] };
    const copied = structuredClone(req);
    expect(copied.loaded[0].module).toBeInstanceOf(WebAssembly.Module);
    const r = runRecheck(copied);
    expect(r.errors).toEqual([]);
    expect(r.log.some((l) => l.startsWith("module memories at Load:"))).toBe(true);
    host.dispose();
  });
});

describe("the recheck worker client", () => {
  /** A stand-in Worker: says ready (unless `broken`), answers a recheck with `answer` after `delay` ms. */
  function fakeWorkers(opts: { answer?: RecheckResult; delay?: number; broken?: boolean } = {}) {
    const made: { terminated: boolean; posted: number }[] = [];
    const make = () => {
      const me = { terminated: false, posted: 0 }; made.push(me);
      const listeners = new Map<string, ((e: unknown) => void)[]>();
      const fire = (type: string, e: unknown) => { for (const fn of listeners.get(type) ?? []) fn(e); };
      setTimeout(() => (opts.broken ? fire("error", { message: "no worker here", preventDefault() {} }) : fire("message", { data: { type: "ready" } })), 0);
      return {
        addEventListener(type: string, fn: (e: unknown) => void) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
        removeEventListener(type: string, fn: (e: unknown) => void) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
        postMessage() { me.posted++; setTimeout(() => fire("message", { data: { type: "done", result: opts.answer ?? { errors: [], log: ["ran in the worker"] } } }), opts.delay ?? 0); },
        terminate() { me.terminated = true; },
      } as unknown as Worker;
    };
    return { made, make };
  }
  const req = (): RecheckRequest => {
    const host = new Host(buildWorld()); loadBaseSystems(host);
    return { world: host.eng.snapshot(), loaded: [], candidate: prepareModule(TICKER, JSON.parse(manifestOf("tick_c"))), successors: [] };
  };

  test("uses the warm spare, ends it after one recheck, and starts the next spare", async () => {
    const f = fakeWorkers();
    const w = workerRecheck(f.make);
    w.warm();
    expect(f.made).toHaveLength(1);
    expect((await w.run(req())).log).toEqual(["ran in the worker"]);
    expect(f.made[0]).toMatchObject({ posted: 1, terminated: true });
    expect(f.made).toHaveLength(2);
    expect(f.made[1].terminated).toBe(false);
    await w.run(req());
    expect(f.made[1].terminated).toBe(true);
  });

  test("a worker that can't start falls back to this thread, and says so", async () => {
    const f = fakeWorkers({ broken: true });
    const r = await workerRecheck(f.make).run(req());
    expect(r.errors).toEqual([]);
    expect(r.log.at(-1)).toMatch(/^the recheck ran on the main thread: its worker didn't start \(no worker here\)/);
    expect(f.made[0].terminated).toBe(true);
  });
});
