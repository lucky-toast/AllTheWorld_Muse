// Pipeline client (spec 12): checkSystem, loadChecked, submitSystem.
// In the browser, stages 1-6 run in a Web Worker under a watchdog that
// terminates the worker when a stage passes its time limit. In Node the same
// stages run in-process through the same code and the same per-stage limits.
import type { Game } from "../engine/runtime";
import { compileSystem } from "../sandbox/compile";
import { TUNING } from "../tuning";
import { buildWorld } from "../world/map";
import { runCheck } from "./core";
import { performLoad, loadedBytesFor } from "./load";
import { bytesToB64, sha256Hex, type SystemStorage } from "./storage";
import type { CheckRequest, Report, Stage, StageEvent } from "./types";

export interface PipelineContext {
  game?: Game;
  storage?: SystemStorage;
  backend?: "worker" | "node";
  onStage?: (e: StageEvent) => void;
  /** Browser only: wraps the covered moment of Load (leaf transition). */
  transition?: (covered: () => void | Promise<void>) => Promise<void>;
}

function fingerprint(game: Game): string {
  return game.registry.systems.map((s) => s.manifest.id).join(",");
}

function buildRequest(manifestJson: string, source: string, game?: Game): CheckRequest {
  const loaded = game ? loadedBytesFor(game).map((r) => ({ manifest: r.manifest, wasmB64: bytesToB64(r.wasm) })) : [];
  return {
    manifestJson, source,
    snapshot: game ? game.eng.serialize() : buildWorld().serialize(),
    loaded,
    baseUrl: typeof location !== "undefined" ? location.origin : "",
  };
}

/** Seconds the worker gets to signal ready before stages run in-process instead. */
const WORKER_BOOT_TIMEOUT_MS = 10_000;

function checkInWorker(req: CheckRequest, ctx: PipelineContext): Promise<Report | null> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    let currentStage: Stage = "Manifest";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limitFor = (stage: Stage) => (stage === "Compile" ? TUNING.limits.compileTimeMs : TUNING.limits.stageTimeMs);
    const fail = (stage: Stage, message: string) => {
      if (timer) clearTimeout(timer);
      clearTimeout(bootTimer);
      worker.terminate();
      resolve({ ok: false, stage, systemId: null, errors: [{ message }], shots: [], durationMs: 0, manifestJson: req.manifestJson, source: req.source, loadedSystems: [], stageMs: {} });
    };
    const arm = (stage: Stage) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(stage, `${stage} stage timed out after ${limitFor(stage)} ms; the worker was stopped`), limitFor(stage) + 250);
    };
    // The watchdog times stages, not worker boot: it is armed by each stage's
    // start message. A worker that never becomes ready at all resolves null,
    // and the caller runs the same stages in-process as a fallback.
    const bootTimer = setTimeout(() => { clearTimeout(bootTimer); worker.terminate(); resolve(null); }, WORKER_BOOT_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; stage?: Stage; status?: "start" | "pass" | "fail"; ms?: number; report?: Report; message?: string };
      if (msg.type === "ready") { clearTimeout(bootTimer); return; }
      if (msg.type === "stage" && msg.stage && msg.status) {
        currentStage = msg.stage;
        if (msg.status === "start") arm(msg.stage);
        ctx.onStage?.({ stage: msg.stage, status: msg.status, ms: msg.ms });
      } else if (msg.type === "done" && msg.report) {
        if (timer) clearTimeout(timer);
        clearTimeout(bootTimer);
        worker.terminate();
        resolve(msg.report);
      } else if (msg.type === "error") {
        fail(currentStage, msg.message ?? "pipeline worker failed");
      }
    };
    worker.onerror = () => fail(currentStage, "pipeline worker crashed");
    worker.postMessage({ type: "check", req });
  });
}

export async function checkSystem(manifestJson: string, source: string, ctx: PipelineContext = {}): Promise<Report> {
  const req = buildRequest(manifestJson, source, ctx.game);
  const backend = ctx.backend ?? (typeof Worker !== "undefined" && ctx.game ? "worker" : "node");
  if (backend === "worker") {
    const workerReport = await checkInWorker(req, ctx);
    if (workerReport === null) {
      // Fallback: the worker never became ready (seen with Vite dev module
      // loading in slow environments). Run the identical stages in-process;
      // the report says so, and the stage watchdog limits still apply.
      const report = await runCheck(req, { onStage: ctx.onStage });
      report.note = "pipeline worker did not become ready; stages ran in-process (fallback)";
      if (ctx.game) report.loadedSystems = fingerprint(ctx.game).split(",").filter(Boolean);
      return report;
    }
    const report = workerReport;
    if (ctx.game) report.loadedSystems = fingerprint(ctx.game).split(",").filter(Boolean);
    // Make sure Load has a manifest and bytes even if they did not survive the boundary.
    if (report.ok && (!report.manifest || !report.wasm)) {
      try {
        const manifest = JSON.parse(manifestJson) as Report["manifest"];
        const compiled = await compileSystem(manifest, source);
        if (compiled.ok) { report.manifest = report.manifest ?? manifest; report.wasm = compiled.bytes; }
      } catch { /* loadChecked fails closed */ }
    }
    return report;
  }
  const report = await runCheck(req, { onStage: ctx.onStage });
  if (ctx.game) report.loadedSystems = fingerprint(ctx.game).split(",").filter(Boolean);
  return report;
}

/** Stage 7 (spec 13.1). Only for a passed report whose loaded set is unchanged. */
export async function loadChecked(report: Report, ctx: PipelineContext = {}): Promise<Report> {
  const failLoad = (message: string): Report => ({ ...report, ok: false, stage: "Load", errors: [{ message }] });
  if (!report.ok || !report.manifest || !report.wasm) return failLoad("load refused: the check did not pass");
  const game = ctx.game;
  if (!game) return failLoad("load refused: no live game");
  if (fingerprint(game) !== report.loadedSystems.join(",")) {
    return failLoad("load refused: the set of loaded systems changed since the check; run the check again");
  }
  if (game.registry.byId(report.manifest.id)) return failLoad(`system "${report.manifest.id}" is already loaded`);
  ctx.onStage?.({ stage: "Load", status: "start" });
  const t0 = Date.now();
  const doLoad = async (): Promise<void> => {
    performLoad(game, { manifest: report.manifest!, manifestJson: report.manifestJson, source: report.source, wasm: report.wasm! });
    if (ctx.storage) {
      await ctx.storage.putSystem({ id: report.manifest!.id, manifestJson: report.manifestJson, source: report.source, wasm: report.wasm!, sha256: await sha256Hex(report.wasm!), buildsOn: report.manifest!.buildsOn, timestamp: Date.now() });
      for (const oldId of report.manifest!.replaces) {
        const old = await ctx.storage.getSystem(oldId);
        if (old) await ctx.storage.putSystem({ ...old, replacedBy: report.manifest!.id });
      }
      await ctx.storage.saveWorld(game.eng.serialize());
    }
  };
  try {
    game.paused = true;
    if (ctx.transition) await ctx.transition(doLoad);
    else await doLoad();
  } catch (e) {
    ctx.onStage?.({ stage: "Load", status: "fail", ms: Date.now() - t0 });
    return failLoad(e instanceof Error ? e.message : String(e));
  } finally {
    game.paused = false;
  }
  ctx.onStage?.({ stage: "Load", status: "pass", ms: Date.now() - t0 });
  return { ...report, ok: true, stage: "Load", stageMs: { ...report.stageMs, Load: Date.now() - t0 } };
}

/** checkSystem + loadChecked in a row. */
export async function submitSystem(manifestJson: string, source: string, ctx: PipelineContext = {}): Promise<Report> {
  const report = await checkSystem(manifestJson, source, ctx);
  if (!report.ok) return report;
  return loadChecked(report, ctx);
}
