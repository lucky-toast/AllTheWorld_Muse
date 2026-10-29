import { STAGES, type Report, type Stage, type StageEvent } from "./types";
import { submitSystem } from "./client";
import { startFresh } from "./persistence";
import campfire from "../../fixtures/campfire.ts?raw";
import badSprite from "../../fixtures/bad-sprite.ts?raw";
import badTypes from "../../fixtures/bad-types.ts?raw";
import badLoop from "../../fixtures/bad-loop.ts?raw";
import badTest from "../../fixtures/bad-test.ts?raw";
import badContract from "../../fixtures/bad-contract.ts?raw";
import badIgnores from "../../fixtures/bad-ignores-handled.ts?raw";
import badShot from "../../fixtures/bad-shot.ts?raw";

export const FIXTURES: { name: string; source: string }[] = [
  { name: "campfire.ts", source: campfire as unknown as string },
  { name: "bad-sprite.ts", source: badSprite as unknown as string },
  { name: "bad-types.ts", source: badTypes as unknown as string },
  { name: "bad-loop.ts", source: badLoop as unknown as string },
  { name: "bad-test.ts", source: badTest as unknown as string },
  { name: "bad-contract.ts", source: badContract as unknown as string },
  { name: "bad-ignores-handled.ts", source: badIgnores as unknown as string },
  { name: "bad-shot.ts", source: badShot as unknown as string },
];

export class DevPanel {
  private boxes = new Map<Stage, HTMLDivElement>();
  private reportEl: HTMLPreElement;
  private shotsEl: HTMLDivElement;
  private loadedEl: HTMLDivElement;
  private errorsEl: HTMLDivElement;
  private lastReport: Report | null = null;
  onLoadedChanged: () => void = () => {};

  constructor(root: HTMLElement, private opts: { getLoaded: () => string[]; getSkipped: () => string[] }) {
    root.innerHTML = "";
    const title = document.createElement("div"); title.className = "devsec"; title.textContent = "Pipeline — submit a system (checks run in a worker; the game keeps running)";
    root.appendChild(title);
    const row = document.createElement("div"); row.className = "stage-row";
    for (const s of STAGES) {
      const b = document.createElement("div"); b.className = "stage-box grey"; b.textContent = s;
      b.title = "Click for this stage's errors";
      b.addEventListener("click", () => this.showStageErrors(s));
      this.boxes.set(s, b); row.appendChild(b);
    }
    root.appendChild(row);
    this.errorsEl = document.createElement("div"); this.errorsEl.className = "dev-errors"; root.appendChild(this.errorsEl);
    const list = document.createElement("div"); list.className = "fixture-list";
    for (const f of FIXTURES) {
      const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Submit " + f.name;
      btn.addEventListener("click", () => void this.submit(f.source));
      list.appendChild(btn);
    }
    const fresh = document.createElement("button"); fresh.type = "button"; fresh.textContent = "Start fresh"; fresh.className = "fresh";
    fresh.addEventListener("click", async () => { await startFresh(); location.reload(); });
    list.appendChild(fresh);
    root.appendChild(list);
    this.reportEl = document.createElement("pre"); this.reportEl.className = "dev-report"; this.reportEl.textContent = "No submissions yet.";
    root.appendChild(this.reportEl);
    this.shotsEl = document.createElement("div"); this.shotsEl.className = "dev-shots"; root.appendChild(this.shotsEl);
    this.loadedEl = document.createElement("div"); this.loadedEl.className = "dev-loaded"; root.appendChild(this.loadedEl);
    this.refreshLoaded();
  }

  /** Submit a fixture by file name (used by the ?submit= browser aid). */
  async submitFixture(name: string) { const f = FIXTURES.find((x) => x.name === name); if (f) await this.submit(f.source); }
  private async submit(source: string) {
    for (const b of this.boxes.values()) { b.className = "stage-box grey"; b.textContent = b.textContent.replace(/ \(.*\)$/, ""); }
    this.errorsEl.textContent = ""; this.shotsEl.innerHTML = "";
    const report = await submitSystem(source);
    this.showReport(report);
  }

  onStage(ev: StageEvent) {
    const b = this.boxes.get(ev.stage); if (!b) return;
    if (ev.status === "start") b.className = "stage-box amber";
    else {
      b.className = "stage-box " + (ev.status === "pass" ? "green" : "red");
      if (ev.ms !== undefined) b.textContent = `${ev.stage} (${ev.ms}ms)`;
    }
  }

  showReport(report: Report) {
    this.lastReport = report;
    // Load box reflects the Load stage outcome; a failed report turns its failing stage red.
    const loadBox = this.boxes.get("Load");
    if (loadBox) loadBox.className = "stage-box " + (report.ok ? "green" : this.lastReport.stage === "Load" ? "red" : "grey");
    if (!report.ok && report.stage !== "Load") { const b = this.boxes.get(report.stage); if (b) b.className = "stage-box red"; }
    this.reportEl.textContent = [
      `system: ${report.systemId ?? "?"}  ok: ${report.ok}  stage reached: ${report.stage}  total: ${report.durationMs}ms`,
      `loaded at check time: [${report.loadedSystems.join(", ")}]`,
      ...report.errors.map((e) => "- " + e.message + (e.line ? ` (line ${e.line}${e.sourceLine ? ": " + e.sourceLine : ""})` : "")),
    ].join("\n");
    this.errorsEl.textContent = report.errors.length ? "Click the red stage box for full error detail." : "";
    this.shotsEl.innerHTML = "";
    for (const shot of report.shots) {
      const wrap = document.createElement("div");
      const cap = document.createElement("div"); cap.textContent = shot.name;
      const img = document.createElement("img"); img.src = shot.png; img.alt = shot.name; img.width = 216;
      wrap.appendChild(cap); wrap.appendChild(img); this.shotsEl.appendChild(wrap);
    }
    this.refreshLoaded();
    this.onLoadedChanged();
  }

  private showStageErrors(stage: Stage) {
    if (!this.lastReport) { this.errorsEl.textContent = "No report yet."; return; }
    const errs = stage === this.lastReport.stage || (stage === "Load" && this.lastReport.ok) ? this.lastReport.errors : [];
    this.errorsEl.textContent = errs.length ? errs.map((e) => JSON.stringify(e, null, 1)).join("\n") : `No errors recorded for ${stage}.`;
  }

  refreshLoaded() {
    const loaded = this.opts.getLoaded(); const skipped = this.opts.getSkipped();
    this.loadedEl.textContent = "Loaded systems: " + (loaded.length ? loaded.join(", ") : "(base game only)") + (skipped.length ? "  |  Skipped at startup: " + skipped.join("; ") : "");
  }
}
