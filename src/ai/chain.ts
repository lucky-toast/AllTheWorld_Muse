// The wish chain (spec 13.5): a wish runs the planner, then the designer for each step in order.
// Each step builds a fresh designer prompt, so it sees the systems earlier steps loaded. A step
// dropped after its repairs stops the chain; earlier steps stay loaded and the rest are logged,
// not retried. Zero steps logs "nothing to build". One wish at a time. The plan is never shown
// to the player, who sees only the load transition and "The world feels different".
import type { Host } from "../engine/host";
import type { StageEvent } from "../pipeline/types";
import { runStep, type DesignerHooks, type DesignerPipeline } from "./designer";
import type { AiLog, Journal } from "./journal";
import { cleanWish, runPlanner } from "./planner";
import type { AiProvider } from "./provider";

export interface ChainHooks {
  onStatus?(text: string): void;
  onPlannerSend?(attempt: number, text: string): void;
  onPlan?(steps: string[], warnings: string[]): void;
  onStepStart?(index: number, step: string): void;
  designer?(index: number): DesignerHooks;
  onStepDone?(index: number, ok: boolean, text: string): void;
  onJournal?(): void;
  onDone?(result: ChainResult): void;
}

export type ChainResult =
  | { status: "busy" | "empty" | "nothing" | "planner_failed" | "done" | "stopped"; loaded: string[]; message: string };

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
  }) {}

  async run(rawWish: string): Promise<ChainResult> {
    const { hooks = {}, log } = this.opts;
    const end = (r: ChainResult) => { hooks.onStatus?.(r.message); if (r.status !== "busy") hooks.onDone?.(r); return r; };
    if (this.running) return end({ status: "busy", loaded: [], message: "A wish is already being built. Wait for it to finish." });
    const wish = cleanWish(rawWish);
    if (!wish) return end({ status: "empty", loaded: [], message: "The wish is empty once cleaned, so nothing was sent." });
    this.running = true;
    try {
      hooks.onStatus?.("Waiting for the planner's reply.");
      const plan = await runPlanner({
        host: this.opts.host, provider: this.opts.planner, wish,
        hooks: {
          onSend: (a, text) => { log.add("sent", "planner", text, { wish }); hooks.onPlannerSend?.(a, text); },
          onReply: (_a, text) => { log.add("reply", "planner", text, { wish }); },
          onProblem: (_a, p) => { log.add("note", "planner", `unreadable reply: ${p}`, { wish }); hooks.onStatus?.(`The planner's reply couldn't be read (${p}). Re-asking once.`); },
        },
      });
      if (!plan.ok) { log.add("note", "chain", `wish dropped: ${plan.reason}`, { wish }); return end({ status: "planner_failed", loaded: [], message: `Wish dropped: ${plan.reason}.` }); }
      for (const w of plan.warnings) log.add("note", "planner", `warning: ${w}`, { wish });
      hooks.onPlan?.(plan.steps, plan.warnings);
      if (!plan.steps.length) { log.add("note", "chain", "nothing to build", { wish }); return end({ status: "nothing", loaded: [], message: "The planner returned no steps: nothing to build." }); }
      const loaded: string[] = [];
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        hooks.onStepStart?.(i, step);
        hooks.onStatus?.(`Step ${i + 1} of ${plan.steps.length}: waiting for the designer's reply.`);
        const dh = hooks.designer?.(i) ?? {};
        const r = await runStep({
          host: this.opts.host, provider: this.opts.designer, pipeline: this.opts.pipeline, task: step, tags: plan.tags[i], routeStages: this.opts.routeStages,
          hooks: {
            ...dh,
            onAttempt: (a, text) => { log.add("sent", "designer", text, { wish, step: i + 1 }); dh.onAttempt?.(a, text); },
            onReply: (a, text) => { log.add("reply", "designer", text, { wish, step: i + 1 }); dh.onReply?.(a, text); },
            onReport: (a, rep) => { if (!rep.ok) log.add("note", "designer", `attempt ${a + 1} failed at ${rep.stage}: ${rep.errors[0]?.message ?? ""}`, { wish, step: i + 1 }); dh.onReport?.(a, rep); },
            onParseFailed: (a, ps) => { log.add("note", "designer", `attempt ${a + 1}: reply unreadable: ${ps.join("; ")}`, { wish, step: i + 1 }); dh.onParseFailed?.(a, ps); },
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
        await this.opts.journal.append({ ...r.meta, systemId: r.systemId, wish, step, timestamp: new Date().toISOString() });
        hooks.onJournal?.();
        hooks.onStepDone?.(i, true, `${r.systemId} loaded`);
      }
      return end({ status: "done", loaded, message: `Done: loaded ${loaded.join(", ")}.` });
    } finally { this.running = false; }
  }
}
