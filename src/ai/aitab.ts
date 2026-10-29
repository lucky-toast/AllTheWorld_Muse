import { STAGES, type Report, type Stage, type StageEvent } from "../pipeline/types";
import { ManualProvider } from "./provider";
import { Designer, estTokens, type AiLogEntry } from "./designer";
import { renderArtBoard } from "../engine/render";
import { appendAiLog, appendJournal } from "../pipeline/persistence";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e;
}
function download(name: string, href: string) { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); }

/** The AI tab in the dev panel: task -> prompt -> paste reply -> attempts -> visual check -> load. */
export class AiTab {
  provider = new ManualProvider();
  private promptEl: HTMLTextAreaElement;
  private replyEl: HTMLTextAreaElement;
  private statusEl: HTMLDivElement;
  private attemptsEl: HTMLDivElement;
  private totalEl: HTMLDivElement;
  private logEl: HTMLPreElement;
  private artCanvas: HTMLCanvasElement | null = null;
  private msgLabelEl!: HTMLDivElement;
  private copyBtnEl!: HTMLButtonElement;
  private designer: Designer;
  private totalSentTokens = 0;
  onLoaded: () => void = () => {};

  constructor(root: HTMLElement, private opts: {
    getWorldText: () => string;
    routeStage: (handler: ((ev: StageEvent) => void) | null) => void;
    isEnabled: () => boolean;
    setEnabled: (on: boolean) => void;
  }) {
    root.appendChild(el("div", "devsec", "AI designer — you are the messenger"));
    const setting = document.createElement("label"); setting.className = "dev-loaded";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = opts.isEnabled();
    cb.addEventListener("change", () => opts.setEnabled(cb.checked));
    setting.appendChild(cb); setting.appendChild(document.createTextNode(" \"What changed\" panel (C)"));
    root.appendChild(setting);
    const taskRow = el("div", "fixture-list");
    const task = document.createElement("input"); task.type = "text"; task.placeholder = "Task for the AI designer…"; task.className = "task-input"; task.id = "ai-task";
    const start = el("button", "", "Start") as HTMLButtonElement;
    taskRow.appendChild(task); taskRow.appendChild(start); root.appendChild(taskRow);

    const msgLabel = el("div", "devsec", "Message to copy to the AI"); msgLabel.id = "ai-message-label";
    root.appendChild(msgLabel);
    this.promptEl = document.createElement("textarea"); this.promptEl.readOnly = true; this.promptEl.rows = 8; this.promptEl.className = "ai-text"; this.promptEl.id = "ai-prompt";
    root.appendChild(this.promptEl);
    const promptBtns = el("div", "fixture-list");
    const copy = el("button", "", "Copy prompt") as HTMLButtonElement; copy.id = "ai-copy";
    copy.addEventListener("click", () => { void navigator.clipboard?.writeText(this.promptEl.value); this.status("Copied — paste it into your AI chat."); });
    this.msgLabelEl = msgLabel; this.copyBtnEl = copy;
    const dlArt = el("button", "", "Download art board") as HTMLButtonElement;
    dlArt.addEventListener("click", () => { if (this.artCanvas) this.artCanvas.toBlob((b) => { if (b) download("art-board.png", URL.createObjectURL(b)); }); });
    const len = el("span", "ai-len", "") as HTMLSpanElement; len.id = "ai-length";
    promptBtns.appendChild(copy); promptBtns.appendChild(dlArt); promptBtns.appendChild(len); root.appendChild(promptBtns);

    this.replyEl = document.createElement("textarea"); this.replyEl.rows = 7; this.replyEl.className = "ai-text"; this.replyEl.id = "ai-reply"; this.replyEl.placeholder = "Paste the AI's reply here…";
    root.appendChild(this.replyEl);
    const replyBtns = el("div", "fixture-list");
    const submit = el("button", "", "Submit reply") as HTMLButtonElement;
    submit.id = "ai-submit";
    submit.addEventListener("click", () => { if (this.provider.waiting) this.provider.deliver(this.replyEl.value); else this.status("No message is waiting for a reply. Press Start first."); });
    replyBtns.appendChild(submit); root.appendChild(replyBtns);

    this.statusEl = el("div", "dev-errors", ""); this.statusEl.id = "ai-status"; root.appendChild(this.statusEl);
    this.totalEl = el("div", "dev-loaded", "Estimated tokens: total sent 0"); root.appendChild(this.totalEl);
    this.attemptsEl = el("div", "ai-attempts"); root.appendChild(this.attemptsEl);
    const logTitle = el("div", "devsec", "Message log (saved to data/ai-log.jsonl)");
    this.logEl = el("pre", "dev-report", ""); root.appendChild(logTitle); root.appendChild(this.logEl);

    this.provider.onShow = (text) => {
      this.promptEl.value = text;
      this.promptEl.scrollTop = 0;
      // Name the message for what it is, so the human knows what to copy.
      const kind = text.includes("failed the pipeline") ? "Repair message — copy this to the AI"
        : text.includes("passed every automated check") ? "Visual check message — copy this to the AI"
        : "Designer prompt — copy this to the AI";
      this.msgLabelEl.textContent = kind;
      this.copyBtnEl.textContent = "Copy " + (kind.startsWith("Repair") ? "repair message" : kind.startsWith("Visual") ? "visual check message" : "prompt");
      len.textContent = `${text.length} chars · ~${estTokens(text.length)} tokens (this message; the whole conversation is resent each time)`;
      const fullLen = text.length;
      this.promptEl.dataset.chars = String(fullLen);
    };

    this.designer = new Designer({
      provider: this.provider,
      getWorldText: opts.getWorldText,
      routeStage: opts.routeStage,
      onAttemptStart: (idx) => this.startAttempt(idx),
      onStage: (idx, ev) => this.attemptStage(idx, ev),
      onShots: (idx, report) => this.showShots(idx, report),
      onLog: (entry) => this.addLog(entry),
      onStatus: (t) => this.status(t),
      appendJournal: async (entry) => { await appendJournal(entry); this.onLoaded(); },
    });

    start.addEventListener("click", () => {
      if (!task.value.trim()) { this.status("Type a task first."); return; }
      this.attemptsEl.innerHTML = ""; this.totalSentTokens = 0; this.updateTotal();
      // Render the art board now so Download art board has the PNG ready.
      this.artCanvas = document.createElement("canvas"); renderArtBoard(this.artCanvas);
      void this.designer.runUpdate(task.value.trim()).catch((e) => this.status("Designer stopped: " + (e as Error).message));
    });
  }

  private attemptRows: { boxes: Map<Stage, HTMLDivElement>; shots: HTMLDivElement; info: HTMLDivElement }[] = [];
  private startAttempt(idx: number) {
    const wrap = el("div", "ai-attempt");
    wrap.appendChild(el("div", "devsec", `Attempt ${idx + 1}`));
    const row = el("div", "stage-row");
    const boxes = new Map<Stage, HTMLDivElement>();
    for (const s of STAGES) { const b = el("div", "stage-box grey", s); boxes.set(s, b); row.appendChild(b); }
    wrap.appendChild(row);
    const info = el("div", "dev-loaded", ""); wrap.appendChild(info);
    const shots = el("div", "dev-shots"); wrap.appendChild(shots);
    const dl = el("button", "", "Download shots") as HTMLButtonElement;
    dl.addEventListener("click", () => { const r = this.lastReports[idx]; if (r) for (const s of r.shots) download(s.name.replace(/\W+/g, "_") + ".png", s.png); });
    wrap.appendChild(dl);
    this.attemptsEl.appendChild(wrap);
    this.attemptRows[idx] = { boxes, shots, info };
  }
  private lastReports: Report[] = [];
  private attemptStage(idx: number, ev: StageEvent) {
    const row = this.attemptRows[idx]; if (!row) return;
    const b = row.boxes.get(ev.stage); if (!b) return;
    b.className = "stage-box " + (ev.status === "start" ? "amber" : ev.status === "pass" ? "green" : "red");
    if (ev.ms !== undefined) b.textContent = `${ev.stage} (${ev.ms}ms)`;
    row.info.textContent = ev.status === "fail" ? `Failed at ${ev.stage}. See the repair message above.` : row.info.textContent;
  }
  private showShots(idx: number, report: Report) {
    this.lastReports[idx] = report;
    const row = this.attemptRows[idx]; if (!row) return;
    row.info.textContent = report.ok ? `Passed every stage in ${report.durationMs}ms — visual check is next; nothing loaded yet.` : `Failed at ${report.stage}: ${report.errors.map((e) => e.message).join("; ")}`;
    row.shots.innerHTML = "";
    for (const shot of report.shots) {
      const w = el("div", ""); const cap = el("div", "", shot.name); const img = document.createElement("img"); img.src = shot.png; img.alt = shot.name; img.width = 216;
      w.appendChild(cap); w.appendChild(img); row.shots.appendChild(w);
    }
  }
  private addLog(entry: AiLogEntry) {
    if (entry.kind === "sent") { this.totalSentTokens += entry.tokensEst; this.updateTotal(); }
    const line = `[${entry.timestamp}] ${entry.kind} · ${entry.chars} chars · ~${entry.tokensEst} tokens\n${entry.text.slice(0, 400)}${entry.text.length > 400 ? "…" : ""}`;
    this.logEl.textContent += line + "\n\n";
    void appendAiLog(JSON.stringify(entry));
  }
  private updateTotal() { this.totalEl.textContent = `Estimated tokens: total sent ${this.totalSentTokens} (each repair resends the whole conversation, so later attempts cost more)`; }
  private status(t: string) { this.statusEl.textContent = t; }
}
