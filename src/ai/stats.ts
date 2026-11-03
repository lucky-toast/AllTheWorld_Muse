// AI usage stats, for reviewing test rounds (spec 13.5). Two JSON-lines files, kept through the
// game's Store (data/ on the dev server, localStorage in built copies) and kept by Start fresh:
//
//   data/ai-usage.jsonl   one line per API request: role, step, attempt, model, real tokens
//                         (input, cached input, output) and time, failed requests included
//   data/ai-wishes.jsonl  one line per wish, written when it ends: steps planned and loaded,
//                         designer failures before each system loaded, and token totals for
//                         the whole wish, from the wish going in to its last system loading
//
// `npm run ai-report` prints a summary of both. Requests sent by hand (Dev panel mode) have no
// real token counts, so their wishes show mode "manual" and zero tokens.
import type { AiCall } from "./provider";

export type StatsFile = "ai-usage.jsonl" | "ai-wishes.jsonl";
export interface StatsSink { appendStats(file: StatsFile, line: string): Promise<void> }

export interface Tokens { requests: number; input: number; cachedInput: number; output: number }
const noTokens = (): Tokens => ({ requests: 0, input: 0, cachedInput: 0, output: 0 });
/** Cached share of the input, in whole percent (0 when there was no input). */
export const cachedPct = (t: { input: number; cachedInput: number }) => (t.input ? Math.round((t.cachedInput / t.input) * 100) : 0);

/** One line of ai-usage.jsonl. `step` is 1-based; null for the planner. `attempt` 0 is the first send. `reasoning` is part of `output`. */
export interface UsageLine {
  timestamp: string; wishId: string; wish: string; role: "planner" | "designer"; step: number | null; attempt: number;
  model: string; ok: boolean; finishReason: string | null; error?: string; ms: number;
  input: number; cachedInput: number; output: number; reasoning: number; cachedPct: number;
}

/** One step of a wish. `failures` are attempts that didn't load (unreadable reply or a failed stage). */
export interface StepStats { step: number; task: string; attempts: number; failures: number; failedAt: string[]; systemId: string | null; tokens: Tokens }

/** One line of ai-wishes.jsonl. */
export interface WishLine {
  wishId: string; wish: string; startedAt: string; finishedAt: string; durationMs: number;
  mode: "api" | "manual"; status: string; message: string;
  plannerAttempts: number; stepsPlanned: number; stepsLoaded: number; designerFailures: number;
  loaded: string[]; steps: StepStats[];
  planner: Tokens; designer: Tokens; tokens: Tokens;
}

const add = (t: Tokens, c: AiCall) => { t.requests++; if (c.usage) { t.input += c.usage.input; t.cachedInput += c.usage.cachedInput; t.output += c.usage.output; } };

/** Collects one wish's stats as the chain runs, and writes them. */
export class WishRecorder {
  readonly wishId: string;
  private started: Date;
  private plannerAttempts = 0;
  private stepsPlanned = 0;
  private steps: StepStats[] = [];
  private planner = noTokens();
  private designer = noTokens();
  private pending: Promise<void> = Promise.resolve();

  constructor(private sink: StatsSink | undefined, readonly wish: string, private now: () => Date = () => new Date()) {
    this.started = now();
    this.wishId = `${this.started.toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  plannerSend() { this.plannerAttempts++; }
  planned(n: number) { this.stepsPlanned = n; }
  stepStart(step: number, task: string) { this.steps[step - 1] = { step, task, attempts: 0, failures: 0, failedAt: [], systemId: null, tokens: noTokens() }; }
  stepAttempt(step: number) { const s = this.steps[step - 1]; if (s) s.attempts++; }
  stepFailed(step: number, stage: string) { const s = this.steps[step - 1]; if (s) { s.failures++; s.failedAt.push(stage); } }
  stepLoaded(step: number, systemId: string) { const s = this.steps[step - 1]; if (s) s.systemId = systemId; }

  /** One API call (planner when step is null). Nothing for providers that don't make calls. */
  call(role: "planner" | "designer", step: number | null, attempt: number, c: AiCall | null | undefined) {
    if (!c) return;
    add(role === "planner" ? this.planner : this.designer, c);
    if (step !== null && this.steps[step - 1]) add(this.steps[step - 1].tokens, c);
    const u = c.usage ?? { input: 0, cachedInput: 0, output: 0 };
    const line: UsageLine = {
      timestamp: this.now().toISOString(), wishId: this.wishId, wish: this.wish, role, step, attempt,
      model: c.model, ok: c.ok, finishReason: c.finishReason, ...(c.error ? { error: c.error } : {}), ms: c.ms,
      input: u.input, cachedInput: u.cachedInput, output: u.output, reasoning: u.reasoning ?? 0, cachedPct: cachedPct(u),
    };
    this.write("ai-usage.jsonl", line);
  }

  /** The wish's token totals so far. */
  totals(): Tokens {
    const t = noTokens();
    for (const x of [this.planner, this.designer]) { t.requests += x.requests; t.input += x.input; t.cachedInput += x.cachedInput; t.output += x.output; }
    return t;
  }

  /** Write the wish's line. */
  finish(status: string, message: string, loaded: string[]): WishLine {
    const end = this.now();
    const tokens = this.totals();
    const line: WishLine = {
      wishId: this.wishId, wish: this.wish, startedAt: this.started.toISOString(), finishedAt: end.toISOString(), durationMs: end.getTime() - this.started.getTime(),
      mode: tokens.requests ? "api" : "manual", status, message,
      plannerAttempts: this.plannerAttempts, stepsPlanned: this.stepsPlanned, stepsLoaded: loaded.length,
      designerFailures: this.steps.reduce((n, s) => n + (s?.failures ?? 0), 0),
      loaded: [...loaded], steps: this.steps.filter(Boolean),
      planner: { ...this.planner }, designer: { ...this.designer }, tokens,
    };
    this.write("ai-wishes.jsonl", line);
    return line;
  }

  /** Resolves when every line so far is written. */
  flushed(): Promise<void> { return this.pending; }

  private write(file: StatsFile, v: unknown) {
    const sink = this.sink; if (!sink) return;
    const text = JSON.stringify(v);
    this.pending = this.pending.then(() => sink.appendStats(file, text)).catch((err) => console.warn(`${file} append failed:`, err));
  }
}
