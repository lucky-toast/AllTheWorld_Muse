import { STAGES, type Report, type Stage, type StageEvent } from "../pipeline/types";
import { ManualProvider } from "./provider";
import { Designer, estTokens, type AiLogEntry } from "./designer";
import { renderArtBoard } from "../engine/render";
import { appendAiLog, appendJournal } from "../pipeline/persistence";
import { parseDirectorReply, HAND_TASK_NOTE, type DirectorEntry } from "./director";
import { renderMapImage } from "./mapimage";
import { catalogGet } from "../engine/catalog";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e;
}
function download(name: string, href: string) { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); }

/** The AI tab in the dev panel: task -> prompt -> paste reply -> attempts -> visual check -> load. */
export class AiTab {
  provider = new ManualProvider();
  directorProvider = new ManualProvider();
  private directorPromptEl!: HTMLTextAreaElement;
  private directorReplyEl!: HTMLTextAreaElement;
  private directorCardEl!: HTMLDivElement;
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
    buildDirectorPrompt: () => string;
    refreshJournal: () => Promise<void>;
    getLoadedIds: () => string[];
    getEngine: () => import("../engine/engine").Engine;
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
    const askDir = el("button", "", "Ask the director") as HTMLButtonElement; askDir.id = "director-ask";
    taskRow.appendChild(task); taskRow.appendChild(start); taskRow.appendChild(askDir); root.appendChild(taskRow);

    // --- Director step ---
    root.appendChild(el("div", "devsec", "Director message — copy this to the AI"));
    const dirPrompt = document.createElement("textarea"); dirPrompt.readOnly = true; dirPrompt.rows = 7; dirPrompt.className = "ai-text"; dirPrompt.id = "director-prompt";
    root.appendChild(dirPrompt);
    const dirBtns = el("div", "fixture-list");
    const dirCopy = el("button", "", "Copy prompt") as HTMLButtonElement; dirCopy.id = "director-copy";
    dirCopy.addEventListener("click", () => { void navigator.clipboard?.writeText(dirPrompt.value); this.status("Director prompt copied — paste it into your AI chat."); });
    const dlMap = el("button", "", "Download map") as HTMLButtonElement; dlMap.id = "director-map";
    dlMap.addEventListener("click", () => { void renderMapImage(opts.getEngine()).then((b) => download("map.png", URL.createObjectURL(b))).catch((e) => this.status("Map render failed: " + (e as Error).message)); });
    const dirLen = el("span", "ai-len", "") as HTMLSpanElement; dirLen.id = "director-length";
    dirBtns.appendChild(dirCopy); dirBtns.appendChild(dlMap); dirBtns.appendChild(dirLen); root.appendChild(dirBtns);
    const dirReply = document.createElement("textarea"); dirReply.rows = 6; dirReply.className = "ai-text"; dirReply.id = "director-reply"; dirReply.placeholder = "Paste the director's reply here…";
    root.appendChild(dirReply);
    const dirSubmitRow = el("div", "fixture-list");
    const dirSubmit = el("button", "", "Submit director reply") as HTMLButtonElement; dirSubmit.id = "director-submit";
    dirSubmitRow.appendChild(dirSubmit); root.appendChild(dirSubmitRow);
    const dirCard = el("div", "director-card"); dirCard.id = "director-card"; dirCard.hidden = true; root.appendChild(dirCard);
    this.directorPromptEl = dirPrompt; this.directorReplyEl = dirReply; this.directorCardEl = dirCard;
    this.directorProvider.onShow = (text) => { dirPrompt.value = text; dirPrompt.scrollTop = 0; dirLen.textContent = `${text.length} chars · ~${estTokens(text.length)} tokens`; };
    dirSubmit.addEventListener("click", () => { if (this.directorProvider.waiting) this.directorProvider.deliver(dirReply.value); else this.status("No director message is waiting. Press Ask the director first."); });
    askDir.addEventListener("click", () => void this.askDirector());

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
      this.beginRun(task.value.trim() + "\n\n" + HAND_TASK_NOTE, null, true);
    });
  }

  /** Start the designer flow. Director runs keep their accumulated token total. */
  private beginRun(taskText: string, director: DirectorEntry | null, resetTotal: boolean) {
    this.attemptsEl.innerHTML = ""; this.attemptRows = []; this.lastReports = [];
    if (resetTotal) { this.totalSentTokens = 0; this.updateTotal(); }
    this.artCanvas = document.createElement("canvas"); renderArtBoard(this.artCanvas);
    void this.designer.runUpdate(taskText, director).catch((e) => this.status("Designer stopped: " + (e as Error).message));
  }

  private async askDirector() {
    await this.opts.refreshJournal(); // pick up entries appended since the tab opened
    this.attemptsEl.innerHTML = ""; this.attemptRows = []; this.totalSentTokens = 0; this.updateTotal();
    this.directorCardEl.hidden = true;
    const prompt = this.opts.buildDirectorPrompt();
    for (;;) {
      this.addLog({ kind: "sent", role: "director", text: prompt, chars: prompt.length, tokensEst: estTokens(prompt.length), timestamp: new Date().toISOString() });
      const reply = await this.directorProvider.send([{ role: "system", content: prompt }]);
      this.addLog({ kind: "reply", role: "director", text: reply, chars: reply.length, tokensEst: estTokens(reply.length), timestamp: new Date().toISOString() });
      const parsed = parseDirectorReply(reply, (id) => !!catalogGet(id), this.opts.getLoadedIds());
      if (!parsed.entry) { this.status("Director reply problem: " + parsed.problems.join("; ") + ". Fix the reply in the director box and submit again."); continue; }
      if (parsed.warnings.length) this.status(parsed.warnings.join("; ") + " — you can still continue.");
      this.showDirectorCard(parsed.entry);
      return;
    }
  }

  private showDirectorCard(entry: DirectorEntry) {
    const card = this.directorCardEl;
    card.innerHTML = "";
    card.hidden = false;
    card.appendChild(el("div", "changed-title", entry.title));
    card.appendChild(el("div", "", entry.experience));
    card.appendChild(el("div", "", entry.brief));
    const meta = [`buildsOn: ${entry.buildsOn.join(", ") || "(none)"}`, `sprites: ${entry.sprites.join(", ") || "(none)"}`,
      ...(entry.where ? [`where: ${entry.where}`] : []), ...(entry.later ? [`later: ${entry.later}`] : []), `journal: ${entry.journal}`];
    card.appendChild(el("div", "dev-loaded", meta.join("\n")));
    const send = el("button", "", "Send to designer") as HTMLButtonElement; send.id = "director-send";
    send.addEventListener("click", () => {
      const task = "```json\n" + JSON.stringify(entry, null, 1) + "\n```";
      this.beginRun(task, entry, false);
    });
    card.appendChild(send);
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
    const line = `[${entry.timestamp}] ${entry.role} ${entry.kind} · ${entry.chars} chars · ~${entry.tokensEst} tokens\n${entry.text.slice(0, 400)}${entry.text.length > 400 ? "…" : ""}`;
    this.logEl.textContent += line + "\n\n";
    void appendAiLog(JSON.stringify(entry));
  }
  private updateTotal() { this.totalEl.textContent = `Estimated tokens: total sent ${this.totalSentTokens} (each repair resends the whole conversation, so later attempts cost more)`; }
  private status(t: string) { this.statusEl.textContent = t; }
}
