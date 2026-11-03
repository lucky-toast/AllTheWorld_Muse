// The World check again at Load (spec 13.1 with Phase 5b), off the main thread.
//
// Load re-runs the World check on a copy of the live world as it is under the leaf: it copies
// the world with every loaded system, ticks it, plays walk, pick up and drop, saves and loads
// it, and re-creates every module. That grows with every system the player adds, and run on
// the main thread it froze the game (the leaf stopped animating) until it was done.
//
// So it runs in its own small worker, which loads the engine but not the compiler and starts
// fast, and it reuses the modules the live game already prepared: a compiled WebAssembly.Module
// can be posted to a worker, so nothing is metered or compiled again. The game is paused under
// the leaf while it runs (the loop doesn't tick while a Load is busy), so the world can't change.
// Each worker runs one recheck and is ended, which frees every module memory it made.
import { aiSystem, moduleMemories, resetMemoryPeak, type PreparedModule } from "../sandbox/module";
import { LIMITS } from "../tuning";
import type { PipelineError } from "./types";
import { rerunWorldCheck } from "./worldcheck";

/** What a recheck needs: the world under the leaf, the loaded AI systems' modules in load order, and the candidate's. */
export interface RecheckRequest {
  world: string;
  loaded: PreparedModule[];
  candidate: PreparedModule;
  /** Replaced id -> replacement (spec 11). */
  successors: [string, string][];
}
export interface RecheckResult { errors: PipelineError[]; log: string[] }
/** Runs a recheck somewhere: in a worker in the browser, in this thread in Node tests. */
export type RecheckRunner = (req: RecheckRequest) => Promise<RecheckResult>;

/** The recheck itself, in this thread. Fresh defs around the already prepared modules (their fuel stats start at zero). */
export function runRecheck(req: RecheckRequest): RecheckResult {
  const log: string[] = [];
  resetMemoryPeak();
  const errors = rerunWorldCheck(req.world, req.loaded.map((p) => aiSystem(p)), aiSystem(req.candidate), log, new Map(req.successors));
  const m = moduleMemories();
  log.push(`module memories at Load: at most ${m.peak} held at once during the recheck, ${m.live} still held`);
  return { errors, log };
}

/** In this thread (Node tests, and anywhere Workers don't exist). */
export const inThreadRecheck: RecheckRunner = async (req) => runRecheck(req);

type FromRecheckWorker = { type: "ready" } | { type: "done"; result: RecheckResult } | { type: "error"; message: string };

/**
 * In a Web Worker: a started one waits as the spare, so a Load doesn't wait for it to start; it
 * runs one recheck, is ended, and a new spare starts. One that runs over LIMITS.stageMs is ended
 * and the recheck fails, so a stuck check can't hold the leaf over the game for good. A worker
 * that can't start at all falls back to this thread (the old way: correct, but the game pauses).
 */
export function workerRecheck(make: () => Worker = () => new Worker(new URL("./recheckworker.ts", import.meta.url), { type: "module" })): { run: RecheckRunner; warm(): void } {
  interface Spare { w: Worker; ready: Promise<void> }
  let spare: Spare | null = null;
  const start = (): Spare => {
    const w = make();
    const ready = new Promise<void>((resolve, reject) => {
      const onMsg = (e: MessageEvent<FromRecheckWorker>) => { if (e.data.type === "ready") { w.removeEventListener("message", onMsg); resolve(); } };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", (e) => { e.preventDefault(); reject(new Error(e.message || "the recheck worker failed to start")); }, { once: true });
    });
    ready.catch(() => {}); // a spare that never starts is only an error once a recheck uses it
    return { w, ready };
  };
  const warm = () => { spare ??= start(); };
  const run: RecheckRunner = async (req) => {
    const s = spare ?? start(); spare = null;
    try {
      try { await s.ready; }
      catch (e) {
        const result = runRecheck(req);
        result.log.push(`the recheck ran on the main thread: its worker didn't start (${e instanceof Error ? e.message : String(e)})`);
        return result;
      }
      return await new Promise<RecheckResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the World check on the live world took longer than ${LIMITS.stageMs / 1000} s`)), LIMITS.stageMs);
        s.w.addEventListener("message", (e: MessageEvent<FromRecheckWorker>) => {
          if (e.data.type === "done") { clearTimeout(timer); resolve(e.data.result); }
          else if (e.data.type === "error") { clearTimeout(timer); reject(new Error(e.data.message)); }
        });
        s.w.addEventListener("error", (e) => { e.preventDefault(); clearTimeout(timer); reject(new Error(e.message || "the recheck worker failed")); });
        s.w.postMessage(req);
      });
    } finally {
      s.w.terminate(); // frees every module memory the recheck made
      warm();
    }
  };
  return { run, warm };
}
