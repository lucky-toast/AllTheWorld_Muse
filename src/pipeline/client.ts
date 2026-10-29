import { TUNING } from "../tuning";
import { STAGES, type CheckRequest, type LoadedSystemSource, type Report, type Stage, type StageEvent } from "./types";

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  setHandler(fn: (msg: unknown) => void): void;
}

export interface PipelineDeps {
  createWorker: () => WorkerLike;
  getLoaded: () => LoadedSystemSource[];
  getSnapshot: () => string;
  baseUrl: string;
  performLoad: (report: Report) => Promise<Report>;
  onStage?: (ev: StageEvent) => void;
}

let deps: PipelineDeps | null = null;
const issuedReports = new WeakSet<Report>();
export function configurePipeline(d: PipelineDeps) { deps = d; }

function browserWorker(): WorkerLike {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return {
    postMessage: (m) => w.postMessage(m),
    terminate: () => w.terminate(),
    setHandler: (fn) => w.addEventListener("message", (e) => fn(e.data)),
  };
}
export function defaultDeps(performLoad: PipelineDeps["performLoad"]): Pick<PipelineDeps, "createWorker" | "baseUrl" | "performLoad"> {
  return { createWorker: browserWorker, baseUrl: location.origin, performLoad };
}

function guessSystemId(source: string): string | null {
  const m = source.match(/defineSystem\s*\(\s*\{[^}]*?id:\s*"([^"]+)"/s);
  return m?.[1] ?? null;
}

/** Run every stage except Load, in a worker, in the background. Never touches the live game. */
export function checkSystem(source: string): Promise<Report> {
  if (!deps) return Promise.reject(new Error("pipeline not configured"));
  const d = deps;
  const loaded = d.getLoaded();
  const req: CheckRequest = { source, loaded, snapshot: d.getSnapshot(), baseUrl: d.baseUrl };
  const loadedIds = loaded.map((l) => l.id);
  return new Promise<Report>((resolve) => {
    const worker = d.createWorker();
    const started = performance.now();
    let current: Stage = STAGES[0];
    let settled = false;
    const stageMs: Report["stageMs"] = {};
    const finish = (r: Report) => { if (settled) return; settled = true; clearTimeout(timer); try { worker.terminate(); } catch { /* already gone */ } issuedReports.add(r); resolve(r); };
    const failCurrent = (r: Report) => { d.onStage?.({ stage: current, status: "fail", ms: Math.round(performance.now() - started) }); finish(r); };
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        failCurrent({
          ok: false, stage: current, systemId: guessSystemId(source),
          errors: [{ message: `stage "${current}" exceeded the ${TUNING.pipeline.stageTimeoutMs}ms time limit; the worker was killed and the game kept running` }],
          shots: [], durationMs: Math.round(performance.now() - started), source, loadedSystems: loadedIds, stageMs,
        });
      }, TUNING.pipeline.stageTimeoutMs);
    };
    let timer = setTimeout(() => {}, 0); armTimer();
    worker.setHandler((msg) => {
      const m = msg as { type: string; stage?: Stage; status?: "start" | "pass" | "fail"; ms?: number; report?: Report; message?: string };
      if (m.type === "stage" && m.stage && m.status) {
        if (m.status === "start") { current = m.stage; armTimer(); }
        if (m.ms !== undefined) stageMs[m.stage] = m.ms;
        d.onStage?.({ stage: m.stage, status: m.status, ms: m.ms });
        if (m.status !== "start") armTimer();
      } else if (m.type === "done" && m.report) {
        finish(m.report);
      } else if (m.type === "error") {
        finish({ ok: false, stage: current, systemId: guessSystemId(source), errors: [{ message: "worker error: " + (m.message ?? "unknown") }], shots: [], durationMs: Math.round(performance.now() - started), source, loadedSystems: loadedIds, stageMs });
      }
    });
    worker.postMessage({ type: "check", req });
  });
}

/** Run the Load stage for a report that passed. Refuses anything else, and refuses if the loaded systems (or the checked source/system) changed since the check. */
export async function loadChecked(report: Report): Promise<Report> {
  if (!deps) throw new Error("pipeline not configured");
  const refuse = (message: string): Report => ({ ...report, ok: false, stage: "Load", errors: [{ message }] });
  if (!issuedReports.has(report)) return refuse("loadChecked refused: this report was not produced by checkSystem in this session");
  if (!report.ok) return refuse(`loadChecked refused: the report did not pass (it failed at ${report.stage})`);
  const now = deps.getLoaded().map((l) => l.id);
  if (JSON.stringify(now) !== JSON.stringify(report.loadedSystems)) return refuse(`loadChecked refused: loaded systems changed since the check (was [${report.loadedSystems.join(", ")}], now [${now.join(", ")}]); the check no longer applies`);
  if (!report.systemId || guessSystemId(report.source) !== report.systemId) return refuse("loadChecked refused: the report's source no longer matches its checked system id; the check no longer applies");
  if (deps.getLoaded().some((l) => l.id === report.systemId)) return refuse(`loadChecked refused: system "${report.systemId}" is already loaded`);
  return deps.performLoad(report);
}

/** checkSystem, then loadChecked if it passed. */
export async function submitSystem(source: string): Promise<Report> {
  const report = await checkSystem(source);
  if (!report.ok) return report;
  return loadChecked(report);
}
