// Dev panel Pipeline tab (spec 13.6): fixture buttons, 7 stage boxes, the
// report with shots, loaded/skipped lists, the combined log, Undo, Start fresh.
import type { Game } from "../engine/runtime";
import { formatReport, type Report, type StageEvent } from "./types";
import { STAGES } from "./types";
import { canUndo, lastLoadedId, undoLastLoad } from "./load";
import type { SystemStorage } from "./storage";

export interface FixtureText { name: string; manifestJson: string; source: string }

export interface PipelinePanelDeps {
  game: Game;
  storage: SystemStorage;
  fixtures: FixtureText[];
  submit: (f: FixtureText) => Promise<Report>;
  startFresh: () => void | Promise<void>;
}

type BoxState = "idle" | "running" | "pass" | "fail";
interface Box { el: HTMLDivElement; state: BoxState; ms?: number }

export class PipelinePanel {
  private boxes = new Map<string, Box>();
  private reportEl: HTMLPreElement;
  private shotsEl: HTMLDivElement;
  private loadedEl: HTMLDivElement;
  private skippedEl: HTMLDivElement;
  private logEl: HTMLPreElement;
  private undoBtn: HTMLButtonElement;
  private lastReport: Report | null = null;
  skipped: { id: string; reason: string }[] = [];

  constructor(root: HTMLElement, private deps: PipelinePanelDeps) {
    root.innerHTML = "";
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      root.appendChild(el);
      return el;
    };
    mk("div", "Pipeline — submit a fixture (spec 12)").className = "devsec";
    const btnRow = mk("div");
    btnRow.className = "tabrow";
    for (const f of deps.fixtures) {
      const b = document.createElement("button");
      b.textContent = f.name;
      b.addEventListener("click", () => { void this.runFixture(f); });
      btnRow.appendChild(b);
    }
    const stageRow = mk("div");
    stageRow.className = "tabrow";
    stageRow.id = "stageboxes";
    for (const stage of STAGES) {
      const box = document.createElement("div");
      box.className = "stagebox";
      box.textContent = stage;
      box.addEventListener("click", () => { if (this.lastReport && this.lastReport.stage === stage) this.showReport(this.lastReport); });
      stageRow.appendChild(box);
      this.boxes.set(stage, { el: box, state: "idle" });
    }
    this.reportEl = mk("pre");
    this.reportEl.className = "report";
    this.shotsEl = mk("div");
    this.shotsEl.className = "shots";
    mk("div", "Loaded systems").className = "devsec";
    this.loadedEl = mk("div");
    mk("div", "Skipped at startup").className = "devsec";
    this.skippedEl = mk("div");
    mk("div", "Denials, near-limits, strikes and overlaps").className = "devsec";
    this.logEl = mk("pre");
    this.logEl.className = "report";
    const actions = mk("div");
    actions.className = "tabrow";
    this.undoBtn = document.createElement("button");
    this.undoBtn.textContent = "Undo last load";
    this.undoBtn.addEventListener("click", () => { if (undoLastLoad(deps.game, deps.storage)) this.refresh(); });
    actions.appendChild(this.undoBtn);
    const fresh = document.createElement("button");
    fresh.textContent = "Start fresh";
    fresh.addEventListener("click", () => { void deps.startFresh(); });
    actions.appendChild(fresh);
    this.refresh();
  }

  onStage = (e: StageEvent): void => {
    const box = this.boxes.get(e.stage);
    if (!box) return;
    box.state = e.status === "start" ? "running" : e.status === "pass" ? "pass" : "fail";
    if (e.ms !== undefined) box.ms = e.ms;
    this.paintBox(e.stage);
  };

  private paintBox(stage: string): void {
    const box = this.boxes.get(stage);
    if (!box) return;
    const colors: Record<BoxState, string> = { idle: "#666", running: "#b58900", pass: "#3f7d2c", fail: "#a33" };
    box.el.style.background = colors[box.state];
    box.el.style.borderColor = colors[box.state];
    box.el.textContent = box.ms !== undefined && box.state !== "running" ? `${stage} ${box.ms}ms` : stage;
  }

  private resetBoxes(): void {
    for (const [stage, box] of this.boxes) { box.state = "idle"; box.ms = undefined; this.paintBox(stage); }
  }

  async runFixture(f: FixtureText): Promise<Report> {
    this.resetBoxes();
    this.reportEl.textContent = `Running ${f.name}…`;
    const report = await this.deps.submit(f);
    this.showReport(report);
    return report;
  }

  showReport(report: Report): void {
    this.lastReport = report;
    for (const stage of STAGES) {
      const box = this.boxes.get(stage)!;
      const idx = STAGES.indexOf(stage);
      const reached = STAGES.indexOf(report.stage);
      if (report.stageMs[stage] !== undefined) box.ms = report.stageMs[stage];
      if (report.ok) box.state = "pass";
      else if (idx < reached) box.state = "pass";
      else if (idx === reached) box.state = "fail";
      else box.state = "idle";
      this.paintBox(stage);
    }
    this.reportEl.textContent = formatReport(report);
    this.shotsEl.innerHTML = "";
    for (const shot of report.shots) {
      const img = document.createElement("img");
      img.src = shot.png;
      img.alt = shot.name;
      img.title = shot.name;
      img.className = "shotimg";
      this.shotsEl.appendChild(img);
    }
    this.refresh();
  }

  setSkipped(skipped: { id: string; reason: string }[]): void {
    this.skipped = skipped;
    this.refresh();
  }

  refresh(): void {
    const { game } = this.deps;
    this.loadedEl.textContent = game.registry.systems.map((s) => s.manifest.id).join(", ") || "(none)";
    this.skippedEl.textContent = this.skipped.length ? this.skipped.map((s) => `${s.id}: ${s.reason}`).join("\n") : "(none)";
    const eng = game.eng;
    const lines: string[] = [];
    for (const d of eng.deniedLog.slice(-30)) lines.push(`denied t${d.tick} ${d.system} ${d.op} (${d.code}) ${d.msg}`);
    for (const n of eng.nearLimitLog.slice(-30)) lines.push(`near-limit t${n.tick} ${n.system} ${n.op} ${n.used}/${n.limit}`);
    for (const f of game.faults.slice(-30)) lines.push(`strike t${f.tick} ${f.system} ${f.handler}: ${f.message}`);
    for (const o of eng.overlapLog.slice(-30)) lines.push(`overlap t${o.tick} ${o.event} entity ${o.entity}: ${o.systems.join(" + ")}`);
    this.logEl.textContent = lines.join("\n") || "(log is empty)";
    const id = lastLoadedId(game);
    this.undoBtn.disabled = !canUndo(game);
    this.undoBtn.textContent = id ? `Undo last load (${id})` : "Undo last load";
  }
}
