// The dev panel's AI tab (spec 13.6): a "Player wish" box and Start; then the planner's message
// (read-only, Copy), its reply box and Submit; then for each step the designer's message (Copy,
// Download art board, Download maps), reply box and Submit, with an attempt row of stage boxes and a token
// estimate. A "What changed" on/off setting. The plan shows here only, never in the game.
import { renderArtBoard } from "../engine/render";
import { STAGES, type Report, type Stage, type StageEvent } from "../pipeline/types";
import type { ChainHooks, ChainResult } from "../ai/chain";
import type { DesignerHooks } from "../ai/designer";
import type { AiLog, AiLogEntry } from "../ai/journal";
import { ManualProvider } from "../ai/provider";
import { estTokens } from "../ai/template";
import { changedEnabled, setChangedEnabled } from "../ai/changed";
import { LIMITS } from "../tuning";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
};
const button = (text: string, cls = "") => { const b = el("button", cls, text); b.type = "button"; return b; };
const sizeText = (text: string) => `${text.length} chars · ~${estTokens(text.length)} tokens`;

/** One message box with Copy, and a reply box with Submit, wired to a ManualProvider. */
function exchange(provider: ManualProvider, opts: { cls: string; status: (t: string) => void; art?: () => void; maps?: () => void }) {
  const root = el("div", `aix ${opts.cls}`);
  const msg = el("textarea", "ai-text ai-message"); msg.readOnly = true; msg.rows = 6;
  const row = el("div", "pipebtns");
  const copy = button("Copy");
  copy.addEventListener("click", () => { msg.select(); void navigator.clipboard?.writeText(msg.value).then(() => opts.status("Copied. Paste it into your AI chat."), () => { document.execCommand?.("copy"); }); });
  row.append(copy);
  if (opts.art) { const art = button("Download art board"); art.addEventListener("click", opts.art); row.append(art); }
  if (opts.maps) { const maps = button("Download maps"); maps.addEventListener("click", opts.maps); row.append(maps); }
  const size = el("span", "ai-len", ""); row.append(size);
  const reply = el("textarea", "ai-text ai-reply"); reply.rows = 5; reply.placeholder = "Paste the AI's reply here";
  const submit = button("Submit", "ai-submit");
  submit.addEventListener("click", () => {
    if (!provider.waiting) { opts.status("Nothing is waiting for a reply here."); return; }
    if (!reply.value.trim()) { opts.status("Paste the reply first."); return; }
    submit.disabled = true; reply.readOnly = true;
    provider.deliver(reply.value);
  });
  const result = el("div", "ai-result", "");
  root.append(msg, row, reply, submit, result);
  return {
    root, result,
    show(text: string) { msg.value = text; msg.scrollTop = 0; size.textContent = sizeText(text); reply.value = ""; reply.readOnly = false; submit.disabled = false; },
    done() { submit.disabled = true; reply.readOnly = true; },
  };
}

export class AiTab {
  readonly body = el("div", "aitab");
  /** Planner and designer each have their own provider instance (spec 13.5). */
  readonly planner = new ManualProvider();
  readonly designer = new ManualProvider();
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

  constructor(private opts: {
    start(wish: string): Promise<ChainResult>; log: AiLog; onChangedSetting(on: boolean): void;
    /** The designer's map images, drawn from the world as it is when called. */
    mapImages(): Promise<{ fileName: string; png: Blob }[]>;
  }) {
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
    b.append(row, this.statusEl, setting);

    b.append(el("div", "devsec", "Planner"));
    this.plannerBox = exchange(this.planner, { cls: "ai-planner", status: (t) => this.say(t) });
    b.append(this.plannerBox.root);
    this.planner.onShow = (text) => this.plannerBox.show(text);
    b.append(el("div", "devsec", "Plan (shown here only)"), this.planEl, this.stepsEl);
    this.designer.onShow = (text) => this.nextDesignerBox?.show(text);
    b.append(el("div", "devsec", "AI log"), this.logEl);
    opts.log.onAppend = () => this.drawLog();
    this.drawLog();
  }

  say(text: string) { this.statusEl.textContent = text; }

  private async start() {
    const wish = this.wishEl.value;
    this.startBtn.disabled = true;
    try { await this.opts.start(wish); } finally { this.startBtn.disabled = false; }
  }

  /** The hooks the wish chain calls. */
  readonly hooks: ChainHooks = {
    onStatus: (t) => this.say(t),
    onPlannerSend: (attempt, _text) => {
      if (attempt === 0) { this.planEl.replaceChildren(); this.stepsEl.replaceChildren(); this.stepEls = []; this.plannerBox.result.textContent = ""; }
    },
    onPlan: (steps, warnings) => {
      this.plannerBox.done();
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
    onDone: (r) => { if (r.status === "planner_failed") this.plannerBox.done(); },
  };

  private designerHooks(i: number): DesignerHooks {
    const rows = new Map<number, Map<Stage, HTMLDivElement>>();
    const boxes = new Map<number, ReturnType<typeof exchange>>();
    return {
      onAttempt: (attempt) => {
        const step = this.stepEls[i]; if (!step) return;
        step.append(el("div", "ai-attempt", attempt === 0 ? "Designer message" : `Repair ${attempt} of ${LIMITS.repairsPerStep}`));
        const x = exchange(this.designer, { cls: "ai-designer", status: (t) => this.say(t), art: () => downloadArtBoard(), maps: () => void this.downloadMaps() });
        const stages = el("div", "stagerow"); const row = new Map<Stage, HTMLDivElement>();
        for (const s of STAGES) { const bx = el("div", "stagebox grey"); bx.append(el("span", "name", s), el("span", "ms", "")); row.set(s, bx); stages.append(bx); }
        x.root.insertBefore(stages, x.result);
        rows.set(attempt, row); boxes.set(attempt, x);
        step.append(x.root);
        this.nextDesignerBox = x;
      },
      onReply: (attempt) => boxes.get(attempt)?.done(),
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

  /** Download maps: one PNG per area, as the world is at this moment. */
  private async downloadMaps() {
    try {
      const maps = await this.opts.mapImages();
      for (const m of maps) {
        const url = URL.createObjectURL(m.png);
        const a = document.createElement("a"); a.href = url; a.download = m.fileName; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      this.say(`Downloaded ${maps.length} map${maps.length === 1 ? "" : "s"}: ${maps.map((m) => m.fileName).join(", ")}`);
    } catch (e) { this.say(`The maps couldn't be drawn: ${e instanceof Error ? e.message : String(e)}`); }
  }

  private drawLog() {
    const fmt = (e: AiLogEntry) => `${e.timestamp.slice(11, 19)} ${e.kind.padEnd(5)} ${e.role.padEnd(8)} ${String(e.chars).padStart(6)} ch ~${String(e.tokensEst).padStart(5)} tok  ${e.kind === "note" ? e.text : e.text.slice(0, 60).replace(/\s+/g, " ")}`;
    const text = this.opts.log.entries.slice(-40).map(fmt).join("\n") || "(empty)";
    if (this.logEl.textContent !== text) this.logEl.textContent = text;
  }
}

/** Download art board (the old renderArtBoard) as a PNG. */
function downloadArtBoard() {
  const c = document.createElement("canvas"); renderArtBoard(c);
  const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = "art-board.png"; a.click();
}
