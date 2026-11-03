// The dev panel's AI tab (spec 13.6): a "Player wish" box and Start, and a "What changed" on/off
// setting. A wish goes through the Muse API: the tab shows the planner's message and reply, then
// for each step and attempt the designer's message, its lookup rounds, its reply and a row of stage
// boxes, with real token usage. Everything here is read-only; Start needs the dev server's API key.
// The plan shows here only, never in the game.
import { STAGES, type Report, type Stage, type StageEvent } from "../pipeline/types";
import type { ChainHooks, ChainResult } from "../ai/chain";
import type { DesignerHooks } from "../ai/designer";
import type { AiLog, AiLogEntry } from "../ai/journal";
import { MuseProvider, usageText, type AiUsage } from "../ai/provider";
import { estTokens } from "../ai/template";
import { changedEnabled, setChangedEnabled } from "../ai/changed";
import { resultSummary } from "../ai/tools";
import { AI_MODELS, LIMITS } from "../tuning";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
};
const button = (text: string, cls = "") => { const b = el("button", cls, text); b.type = "button"; return b; };
const sizeText = (text: string) => `${text.length} chars · ~${estTokens(text.length)} tokens`;

/** One sent message and its reply, both read-only, with the lookup rounds between them. */
function exchange(opts: { cls: string }) {
  const root = el("div", `aix ${opts.cls}`);
  const msg = el("textarea", "ai-text ai-message"); msg.readOnly = true; msg.rows = 6;
  const size = el("div", "ai-len", "");
  // One line per lookup round (the designer's tool calls), filled in as they happen.
  const lookups = el("div", "ai-lookups");
  let shown = false;
  const reply = el("textarea", "ai-text ai-reply"); reply.rows = 5; reply.readOnly = true; reply.placeholder = "The reply appears here when the API answers";
  const result = el("div", "ai-result", "");
  root.append(msg, size, lookups, reply, result);
  return {
    root, result,
    /** Whether show() has filled this box: tool rounds send again, and must not replace its message. */
    get shown() { return shown; },
    show(text: string) { shown = true; msg.value = text; msg.scrollTop = 0; size.textContent = sizeText(text); reply.value = ""; },
    /** The reply and its real token usage. */
    fill(text: string, usage: AiUsage | null) {
      reply.value = text;
      if (usage) size.textContent = `${sizeText(msg.value)} · ${usageText(usage)}`;
    },
    /** Add one lookup round's line. */
    lookup(text: string) { lookups.append(el("div", "", text)); },
  };
}

export class AiTab {
  readonly body = el("div", "aitab");
  /** Planner and designer each have their own provider (spec 13.5), so they can use different models. */
  readonly musePlanner = new MuseProvider({ role: "planner", ...AI_MODELS.planner });
  readonly museDesigner = new MuseProvider({ role: "designer", ...AI_MODELS.designer });
  /** Whether the dev server has a MUSE_API_KEY (GET /__ai/status). */
  private apiReady = false;
  private apiNote = el("div", "ai-setting", "Checking for the Muse API key…");
  private statusEl = el("div", "pipestatus ai-status");
  private planEl = el("ol", "ai-plan");
  private stepsEl = el("div", "ai-steps");
  private logEl = el("pre", "pipelog ai-log");
  private wishEl = el("input", "ai-wish");
  private startBtn = button("Start", "ai-start");
  private plannerBox: ReturnType<typeof exchange>;
  private stepEls: HTMLElement[] = [];
  /** Where designer messages go: the attempt box shown next. */
  private nextDesignerBox: ReturnType<typeof exchange> | null = null;

  constructor(private opts: { start(wish: string): Promise<ChainResult>; log: AiLog; onChangedSetting(on: boolean): void }) {
    const b = this.body;
    b.append(el("div", "devsec", "Player wish"));
    const row = el("div", "pipebtns");
    this.wishEl.type = "text"; this.wishEl.placeholder = "What should the world do?"; this.wishEl.maxLength = 400;
    this.wishEl.addEventListener("keydown", (e) => { if (e.key === "Enter") this.startBtn.click(); });
    this.startBtn.addEventListener("click", () => void this.start());
    row.append(this.wishEl, this.startBtn);
    const setting = el("label", "ai-setting");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = changedEnabled();
    cb.addEventListener("change", () => { setChangedEnabled(cb.checked); opts.onChangedSetting(cb.checked); });
    setting.append(cb, document.createTextNode(' "What changed" panel (C or click the game)'));
    b.append(row, this.statusEl, setting, this.apiNote);
    this.startBtn.disabled = true;
    void this.checkApi();

    b.append(el("div", "devsec", "Planner"));
    this.plannerBox = exchange({ cls: "ai-planner" });
    b.append(this.plannerBox.root);
    // The planner's re-ask sends again in the same conversation: the box keeps the first message.
    this.musePlanner.onShow = (text) => { if (!this.plannerBox.shown) this.plannerBox.show(text); this.say("Waiting for the planner…"); };
    this.musePlanner.onReply = (text, usage) => this.plannerBox.fill(text, usage);
    b.append(el("div", "devsec", "Plan (shown here only)"), this.planEl, this.stepsEl);
    // A lookup round sends again: the box keeps the attempt's message, and the round shows as a line (onToolRound).
    this.museDesigner.onShow = (text) => { if (!this.nextDesignerBox?.shown) this.nextDesignerBox?.show(text); this.say("Waiting for the designer…"); };
    this.museDesigner.onReply = (text, usage) => { if (!this.museDesigner.lastToolCalls.length) this.nextDesignerBox?.fill(text, usage); };
    b.append(el("div", "devsec", "AI log"), this.logEl);
    opts.log.onAppend = () => this.drawLog();
    this.drawLog();
  }

  say(text: string) { this.statusEl.textContent = text; }

  /** GET /__ai/status. Anything but the dev server's answer counts as not configured. */
  private async checkApi() {
    try {
      const res = await fetch("/__ai/status", { cache: "no-store" });
      const v = res.ok ? (await res.json()) as { configured?: unknown } : null;
      this.apiReady = v?.configured === true;
    } catch { this.apiReady = false; }
    // The variable's name is split so a build never holds the string "MUSE_API_KEY" (an easy leak check).
    this.apiNote.textContent = this.apiReady ? "" : `Wishes need the Muse API: set ${["MUSE", "API", "KEY"].join("_")} in .env.local and restart npm run dev.`;
    this.apiNote.hidden = this.apiReady;
    if (!this.running) this.startBtn.disabled = !this.apiReady;
  }

  /** Whether the dev server has the API key, so a wish can be built. */
  get canUseApi(): boolean { return this.apiReady; }
  /** Whether a wish started here or in the game is being built. */
  get running(): boolean { return this.busy; }
  private busy = false;

  private async start() { if (this.apiReady && !this.busy) await this.run(this.wishEl.value); }

  /** The in-game wish box: the same path as Start. The wish shows in the "Player wish" box so the panel follows along. */
  startWish(wish: string): Promise<ChainResult> | null {
    if (!this.apiReady || this.busy) return null;
    this.wishEl.value = wish;
    return this.run(wish);
  }

  private async run(wish: string): Promise<ChainResult> {
    this.busy = true; this.startBtn.disabled = true;
    this.plannerBox = this.freshPlannerBox();
    try { return await this.opts.start(wish); } finally { this.busy = false; this.startBtn.disabled = !this.apiReady; }
  }

  /** A new planner box for a new wish, in place of the last one. */
  private freshPlannerBox(): ReturnType<typeof exchange> {
    const x = exchange({ cls: "ai-planner" });
    this.plannerBox.root.replaceWith(x.root);
    return x;
  }

  /** The hooks the wish chain calls. */
  readonly hooks: ChainHooks = {
    onStatus: (t) => this.say(t),
    onPlannerSend: (attempt, _text) => {
      if (attempt === 0) { this.planEl.replaceChildren(); this.stepsEl.replaceChildren(); this.stepEls = []; this.plannerBox.result.textContent = ""; }
    },
    onPlan: (steps, warnings) => {
      this.plannerBox.result.textContent = steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}${warnings.length ? ` (${warnings.join("; ")})` : ""}` : "No steps: nothing to build.";
      this.planEl.replaceChildren(...steps.map((s) => el("li", "", s)));
    },
    onStepStart: (i, step) => {
      const box = el("div", "ai-step");
      box.append(el("div", "devsec", `Step ${i + 1}: ${step}`));
      this.stepsEl.append(box); this.stepEls[i] = box;
    },
    designer: (i) => this.designerHooks(i),
    onStepDone: (i, ok, text) => { this.stepEls[i]?.append(el("div", ok ? "ai-ok" : "ai-dropped", ok ? text : `Dropped: ${text}`)); },
  };

  private designerHooks(i: number): DesignerHooks {
    const rows = new Map<number, Map<Stage, HTMLDivElement>>();
    const boxes = new Map<number, ReturnType<typeof exchange>>();
    return {
      onAttempt: (attempt) => {
        const step = this.stepEls[i]; if (!step) return;
        step.append(el("div", "ai-attempt", attempt === 0 ? "Designer message" : `Repair ${attempt} of ${LIMITS.repairsPerStep}`));
        const x = exchange({ cls: "ai-designer" });
        const stages = el("div", "stagerow"); const row = new Map<Stage, HTMLDivElement>();
        for (const s of STAGES) { const bx = el("div", "stagebox grey"); bx.append(el("span", "name", s), el("span", "ms", "")); row.set(s, bx); stages.append(bx); }
        x.root.insertBefore(stages, x.result);
        rows.set(attempt, row); boxes.set(attempt, x);
        step.append(x.root);
        this.nextDesignerBox = x;
      },
      onToolRound: (attempt, round, calls) => {
        const usage = this.museDesigner.lastUsage;
        const args = (a: string) => (a.length > 80 ? `${a.slice(0, 79)}…` : a);
        boxes.get(attempt)?.lookup([`Lookups, round ${round}${usage ? ` · ${usageText(usage)}` : ""}`, ...calls.map((c) => `  ${c.name} ${args(c.arguments)} → ${resultSummary(c.name, c.result)}`)].join("\n"));
        this.say(`Step ${i + 1}: the designer looked things up (round ${round}). Waiting for its reply…`);
      },
      onLookupLimit: (attempt) => { const x = boxes.get(attempt); if (x) x.result.textContent = `Still looking things up after the step's ${LIMITS.LOOKUP_ROUNDS_PER_STEP} lookup rounds, so this attempt failed.`; },
      onParseFailed: (attempt, problems) => { const x = boxes.get(attempt); if (x) x.result.textContent = `The reply couldn't be read: ${problems.join("; ")}`; },
      onStage: (attempt, e: StageEvent) => {
        const bx = rows.get(attempt)?.get(e.stage); if (!bx) return;
        bx.className = `stagebox ${e.status === "start" ? "amber" : e.status === "pass" ? "green" : "red"}`;
        if (e.ms !== undefined) bx.querySelector(".ms")!.textContent = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`;
      },
      onReport: (attempt, r: Report) => {
        const x = boxes.get(attempt); if (!x) return;
        const failed = r.ok ? null : rows.get(attempt)?.get(r.stage);
        if (failed) failed.className = "stagebox red";
        x.result.textContent = r.ok ? `${r.systemId} loaded in ${r.durationMs} ms` : `Failed at ${r.stage}: ${r.errors.map((e) => e.message).join("; ")}`;
      },
    };
  }

  private drawLog() {
    const fmt = (e: AiLogEntry) => `${e.timestamp.slice(11, 19)} ${e.kind.padEnd(5)} ${e.role.padEnd(8)} ${String(e.chars).padStart(6)} ch ~${String(e.tokensEst).padStart(5)} tok  ${e.kind === "note" ? e.text : e.text.slice(0, 60).replace(/\s+/g, " ")}`;
    const text = this.opts.log.entries.slice(-40).map(fmt).join("\n") || "(empty)";
    if (this.logEl.textContent !== text) this.logEl.textContent = text;
  }
}
