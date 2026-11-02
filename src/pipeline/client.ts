// The pipeline client (spec 12): checkSystem, loadChecked and submitSystem.
//
// checkSystem sends the candidate, the loaded AI modules and the serialized live world to a
// fresh worker, which runs stages 1 to 6 on its own engine copies. A watchdog arms a timer at
// every stage start (compileMs for Compile, stageMs for the rest) and terminates the worker
// when one runs over, so even code that never yields can't hold up the game. loadChecked runs
// Load (spec 13.1) only for a passed report this client issued, and refuses it if the set of
// loaded systems changed since the check.
import { LIMITS } from "../tuning";
import type { FromWorker, LoadedModule, Report, Stage, StageEvent, ToWorker } from "./types";

export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  /** Replace the message handler. */
  setHandler(fn: (msg: FromWorker) => void): void;
}

/** What the pipeline needs from the live game. */
export interface LiveSide {
  /** Loaded AI modules in load order, every loaded id in load order, and the serialized world. */
  checkInputs(): { loaded: LoadedModule[]; loadedIds: string[]; world: string; successors?: Record<string, string> };
  /** Load (spec 13.1). Resolves with the report updated to the Load outcome. */
  load(report: Report): Promise<Report>;
}

export interface PipelineOptions {
  createWorker(): WorkerLike;
  live: LiveSide;
  /** Where the worker fetches sprite sheets for shots. */
  baseUrl?: string;
  onStage?(e: StageEvent): void;
  /** Stage time limits in ms (tests shorten them). */
  limits?: { compileMs: number; stageMs: number };
}

/** The real Web Worker. */
export function browserWorker(): WorkerLike {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // Hold messages until the worker says it is ready (its imports use top-level await).
  let ready = false; const queued: ToWorker[] = [];
  let handler: ((m: FromWorker) => void) | null = null;
  w.addEventListener("message", (e: MessageEvent<FromWorker>) => {
    if (e.data.type === "ready") { if (!ready) { ready = true; for (const m of queued.splice(0)) w.postMessage(m); } return; }
    handler?.(e.data);
  });
  w.addEventListener("error", (e) => { e.preventDefault(); handler?.({ type: "error", message: e.message || "the pipeline worker failed to start" }); });
  return {
    postMessage: (m) => { if (ready) w.postMessage(m); else queued.push(m); },
    terminate: () => w.terminate(),
    setHandler: (fn) => { handler = fn; },
  };
}

const idFrom = (manifestJson: string): string | null => {
  try { const id = (JSON.parse(manifestJson) as { id?: unknown })?.id; return typeof id === "string" ? id : null; } catch { return null; }
};

export class Pipeline {
  private issued = new WeakSet<Report>();
  /** A started worker kept between jobs (starting one loads the compiler, which takes seconds). */
  private spare: WorkerLike | null = null;
  constructor(private opts: PipelineOptions) {}
  /** Start a worker ahead of the first job. */
  warm() { this.spare ??= this.opts.createWorker(); }
  private take(): WorkerLike { const w = this.spare ?? this.opts.createWorker(); this.spare = null; return w; }
  /** A worker that finished its job cleanly is kept; one that was killed or failed is not. */
  private giveBack(w: WorkerLike, clean: boolean) {
    if (clean && !this.spare) { w.setHandler(() => {}); this.spare = w; }
    else { try { w.terminate(); } catch { /* already gone */ } }
  }
  private get limits() { return this.opts.limits ?? { compileMs: LIMITS.compileMs, stageMs: LIMITS.stageMs }; }

  /** Stages 1 to 6 in a worker. Never touches the live game. */
  checkSystem(manifestJson: string, source: string): Promise<Report> {
    const { loaded, loadedIds, world, successors } = this.opts.live.checkInputs();
    const t0 = Date.now();
    return new Promise<Report>((resolve) => {
      const worker = this.take();
      let stage: Stage = "Manifest";
      let stageT = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const stageMs: Report["stageMs"] = {};
      const finish = (r: Report, clean = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        this.giveBack(worker, clean);
        if (r.ok) this.issued.add(r);
        resolve(r);
      };
      const failHere = (message: string) => {
        const ms = Date.now() - stageT; stageMs[stage] = ms;
        this.opts.onStage?.({ stage, status: "fail", ms });
        finish({ ok: false, stage, systemId: idFrom(manifestJson), errors: [{ message }], shots: [], durationMs: Date.now() - t0, log: [], stageMs });
      };
      const arm = () => {
        clearTimeout(timer);
        const limit = stage === "Compile" ? this.limits.compileMs : this.limits.stageMs;
        timer = setTimeout(() => failHere(`the ${stage} stage took longer than ${limit / 1000} s, so the pipeline stopped it; the game kept running`), limit);
      };
      worker.setHandler((m) => {
        if (settled) return;
        if (m.type === "stage") {
          if (m.event.status === "start") { stage = m.event.stage; stageT = Date.now(); arm(); }
          else if (m.event.ms !== undefined) stageMs[m.event.stage] = m.event.ms;
          this.opts.onStage?.(m.event);
        } else if (m.type === "done") finish(m.report, true);
        else if (m.type === "error") failHere(`the pipeline worker failed: ${m.message}`);
      });
      arm(); // also covers the worker starting up
      worker.postMessage({ type: "check", req: { manifestJson, source, loaded, loadedIds, world, successors }, baseUrl: this.opts.baseUrl ?? "" });
    });
  }

  /** Load a passed report (spec 13.1). Refuses anything else. */
  async loadChecked(report: Report): Promise<Report> {
    const refuse = (message: string): Report => {
      this.opts.onStage?.({ stage: "Load", status: "fail", ms: 0 });
      return { ...report, ok: false, stage: "Load", errors: [{ message }] };
    };
    if (!this.issued.has(report) || !report.checked) return refuse("loadChecked refused: this report didn't come from a passed checkSystem");
    if (!report.ok) return refuse(`loadChecked refused: the report failed at ${report.stage}`);
    const now = this.opts.live.checkInputs().loadedIds;
    if (now.join(",") !== report.checked.loaded.join(",")) return refuse(`loadChecked refused: the loaded systems changed since the check (then [${report.checked.loaded.join(", ")}], now [${now.join(", ")}]); check it again`);
    if (report.systemId && now.includes(report.systemId)) return refuse(`loadChecked refused: a system with id "${report.systemId}" is already loaded`);
    this.issued.delete(report); // one load per report
    const t = Date.now();
    this.opts.onStage?.({ stage: "Load", status: "start" });
    const out = await this.opts.live.load(report);
    const ms = Date.now() - t;
    this.opts.onStage?.({ stage: "Load", status: out.ok ? "pass" : "fail", ms });
    return { ...out, stageMs: { ...out.stageMs, Load: ms } };
  }

  /** checkSystem, then loadChecked if it passed. */
  async submitSystem(manifestJson: string, source: string): Promise<Report> {
    const report = await this.checkSystem(manifestJson, source);
    return report.ok ? this.loadChecked(report) : report;
  }

  /** Compile a stored system's source again (startup, when its module is missing or doesn't match). */
  compile(manifest: unknown, source: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Promise((resolve, reject) => {
      const worker = this.take();
      const timer = setTimeout(() => { this.giveBack(worker, false); reject(new Error(`compiling took longer than ${this.limits.compileMs / 1000} s`)); }, this.limits.compileMs);
      worker.setHandler((m) => {
        if (m.type !== "compiled" && m.type !== "error") return;
        clearTimeout(timer); this.giveBack(worker, m.type === "compiled");
        if (m.type === "compiled" && m.ok) resolve(m.wasm);
        else reject(new Error(m.type === "compiled" ? m.message : m.message));
      });
      worker.postMessage({ type: "compile", manifest, source });
    });
  }
}

// ---- The spec's three entry points, bound to the game's pipeline once main.ts configures it ----
let configured: Pipeline | null = null;
export function configurePipeline(p: Pipeline) { configured = p; }
function need(): Pipeline { if (!configured) throw new Error("the pipeline isn't configured"); return configured; }
/** Stages 1 to 6 on a candidate system, in a worker. Resolves with its Report. */
export function checkSystem(manifestJson: string, source: string): Promise<Report> { return need().checkSystem(manifestJson, source); }
/** Load a passed Report into the live game (spec 13.1). */
export function loadChecked(report: Report): Promise<Report> { return need().loadChecked(report); }
/** checkSystem, then loadChecked if it passed. */
export function submitSystem(manifestJson: string, source: string): Promise<Report> { return need().submitSystem(manifestJson, source); }
