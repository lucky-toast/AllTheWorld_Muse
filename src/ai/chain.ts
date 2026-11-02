// The wish chain (spec 13.5): a wish runs the planner, then the designer for each step in order.
// Each step builds a fresh designer prompt, so it sees the systems earlier steps loaded. A step
// dropped after its repairs stops the chain; earlier steps stay loaded and the rest are logged,
// not retried. Zero steps logs "nothing to build". One wish at a time. A send that fails (an API
// error) ends the chain with "error"; earlier steps stay loaded, as with "stopped". The plan is
// never shown to the player, who sees only the load transition and "The world feels different".
import type { Host } from "../engine/host";
import type { StageEvent } from "../pipeline/types";
import { runStep, type DesignerHooks, type DesignerPipeline } from "./designer";
import type { AiLog, Journal } from "./journal";
import { cleanWish, runPlanner } from "./planner";
import { AiApiError, usageText, type AiProvider, type ChatImage } from "./provider";
import { WishRecorder, type StatsSink, type WishLine } from "./stats";

export interface ChainHooks {
  onStatus?(text: string): void;
  onPlannerSend?(attempt: number, text: string): void;
  onPlan?(steps: string[], warnings: string[]): void;
  onStepStart?(index: number, step: string): void;
  designer?(index: number): DesignerHooks;
  onStepDone?(index: number, ok: boolean, text: string): void;
  onJournal?(): void;
  onDone?(result: ChainResult): void;
  /** The wish's stats line (steps, failures, token totals), written when it ends. */
  onStats?(line: WishLine): void;
}

export type ChainResult =
  | { status: "busy" | "empty" | "nothing" | "planner_failed" | "done" | "stopped" | "error"; loaded: string[]; message: string };

export class WishChain {
  running = false;
  constructor(private opts: {
    host: Host;
    planner: AiProvider;
    designer: AiProvider;
    pipeline: DesignerPipeline;
    journal: Journal;
    log: AiLog;
    hooks?: ChainHooks;
    routeStages?(fn: ((e: StageEvent) => void) | null): void;
    /** The designer's map images, drawn once per step (sent only by providers that take images). */
    mapImages?(): Promise<ChatImage[]>;
    /** Where the usage and wish stats go (data/ai-usage.jsonl, data/ai-wishes.jsonl; src/ai/stats.ts). */
    stats?: StatsSink;
  }) {}
  /** The recorder of the wish being built, if any. */
  private rec: WishRecorder | null = null;

  /** Record the API call that just ended and log its real token counts, when the provider made one. */
  private recordCall(provider: AiProvider, role: "planner" | "designer", step: number | null, attempt: number, wish: string) {
    const c = provider.lastCall;
    if (!c) return;
    this.rec?.call(role, step, attempt, c);
    if (c.usage) this.opts.log.add("note", role, `usage: ${usageText(c.usage)}`, { wish, ...(step ? { step } : {}) });
  }

  /** Resolves when the last wish's stats are written. */
  statsFlushed(): Promise<void> { return this.rec?.flushed() ?? Promise.resolve(); }

  async run(rawWish: string): Promise<ChainResult> {
    const { hooks = {}, log } = this.opts;
    const end = (r: ChainResult) => {
      const rec = this.rec;
      if (r.status !== "busy" && r.status !== "empty" && rec) {
        const line = rec.finish(r.status, r.message, r.loaded);
        if (line.mode === "api") log.add("note", "chain", `wish total: ${line.tokens.requests} requests · ${usageText(line.tokens)}`, { wish: rec.wish });
        hooks.onStats?.(line);
      }
      hooks.onStatus?.(r.message); if (r.status !== "busy") hooks.onDone?.(r); return r;
    };
    if (this.running) return end({ status: "busy", loaded: [], message: "A wish is already being built. Wait for it to finish." });
    const wish = cleanWish(rawWish);
    if (!wish) return end({ status: "empty", loaded: [], message: "The wish is empty once cleaned, so nothing was sent." });
    this.running = true;
    this.rec = new WishRecorder(this.opts.stats, wish);
    const rec = this.rec;
    const loaded: string[] = [];
    let current: number | undefined; // the 1-based step being built, if any
    let attemptNow = 0; // the attempt in flight, for a send that rejects
    try {
      hooks.onStatus?.("Waiting for the planner's reply.");
      const plan = await runPlanner({
        host: this.opts.host, provider: this.opts.planner, wish,
        hooks: {
          onSend: (a, text) => { attemptNow = a; rec.plannerSend(); log.add("sent", "planner", text, { wish }); hooks.onPlannerSend?.(a, text); },
          onReply: (a, text) => { log.add("reply", "planner", text, { wish }); this.recordCall(this.opts.planner, "planner", null, a, wish); },
          onProblem: (_a, p) => { log.add("note", "planner", `unreadable reply: ${p}`, { wish }); hooks.onStatus?.(`The planner's reply couldn't be read (${p}). Re-asking once.`); },
        },
      });
      if (!plan.ok) { log.add("note", "chain", `wish dropped: ${plan.reason}`, { wish }); return end({ status: "planner_failed", loaded: [], message: `Wish dropped: ${plan.reason}.` }); }
      for (const w of plan.warnings) log.add("note", "planner", `warning: ${w}`, { wish });
      rec.planned(plan.steps.length);
      hooks.onPlan?.(plan.steps, plan.warnings);
      if (!plan.steps.length) { log.add("note", "chain", "nothing to build", { wish }); return end({ status: "nothing", loaded: [], message: "The planner returned no steps: nothing to build." }); }
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        current = i + 1; attemptNow = 0;
        rec.stepStart(i + 1, step);
        hooks.onStepStart?.(i, step);
        hooks.onStatus?.(`Step ${i + 1} of ${plan.steps.length}: waiting for the designer's reply.`);
        const dh = hooks.designer?.(i) ?? {};
        const r = await runStep({
          host: this.opts.host, provider: this.opts.designer, pipeline: this.opts.pipeline, task: step, tags: plan.tags[i], routeStages: this.opts.routeStages, mapImages: this.opts.mapImages,
          hooks: {
            ...dh,
            onAttempt: (a, text) => { attemptNow = a; rec.stepAttempt(i + 1); log.add("sent", "designer", text, { wish, step: i + 1 }); dh.onAttempt?.(a, text); },
            onReply: (a, text) => { log.add("reply", "designer", text, { wish, step: i + 1 }); this.recordCall(this.opts.designer, "designer", i + 1, a, wish); dh.onReply?.(a, text); },
            onReport: (a, rep) => { if (!rep.ok) rec.stepFailed(i + 1, rep.stage); if (!rep.ok) log.add("note", "designer", `attempt ${a + 1} failed at ${rep.stage}: ${rep.errors[0]?.message ?? ""}`, { wish, step: i + 1 }); dh.onReport?.(a, rep); },
            onParseFailed: (a, ps) => { rec.stepFailed(i + 1, "Reply format"); log.add("note", "designer", `attempt ${a + 1}: reply unreadable: ${ps.join("; ")}`, { wish, step: i + 1 }); dh.onParseFailed?.(a, ps); },
          },
        });
        if (!r.ok) {
          log.add("note", "chain", `step ${i + 1} dropped (${r.reason}): ${step}`, { wish, step: i + 1 });
          const rest = plan.steps.slice(i + 1);
          rest.forEach((s, j) => log.add("note", "chain", `step ${i + 2 + j} not built because the chain stopped: ${s}`, { wish, step: i + 2 + j }));
          hooks.onStepDone?.(i, false, r.reason);
          return end({ status: "stopped", loaded, message: `Step ${i + 1} was dropped (${r.reason}). The chain stopped${loaded.length ? `; ${loaded.join(", ")} stay loaded` : ""}.` });
        }
        loaded.push(r.systemId);
        rec.stepLoaded(i + 1, r.systemId);
        await this.opts.journal.append({ ...r.meta, systemId: r.systemId, wish, step, timestamp: new Date().toISOString() });
        hooks.onJournal?.();
        hooks.onStepDone?.(i, true, `${r.systemId} loaded`);
      }
      return end({ status: "done", loaded, message: `Done: loaded ${loaded.join(", ")}.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A send that failed at the API still cost tokens (a reply cut off at max_tokens): record that call.
      if (e instanceof AiApiError) {
        const p = current ? this.opts.designer : this.opts.planner;
        if (p.lastCall && !p.lastCall.ok) this.recordCall(p, current ? "designer" : "planner", current ?? null, attemptNow, wish);
      }
      log.add("note", "chain", `${e instanceof AiApiError ? "API error" : "error"}: ${msg}`, { wish, ...(current ? { step: current } : {}) });
      const where = current ? `Step ${current}` : "The planner";
      return end({ status: "error", loaded, message: `${where} stopped on an error: ${msg}. The chain stopped${loaded.length ? `; ${loaded.join(", ")} stay loaded` : ""}.` });
    } finally { this.running = false; }
  }
}
