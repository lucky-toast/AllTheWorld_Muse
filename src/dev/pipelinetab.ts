// The dev panel's Pipeline tab (spec 13.6): one button per fixture, a row of 6 stage boxes
// (grey, amber while running, green, red; time on each; a red box shows its errors on
// click), the report, loaded and skipped systems, the denial, near-limit, strike
// and overlap log, Undo and Start fresh.
import type { Pipeline } from "../pipeline/client";
import type { LiveLoader } from "../pipeline/live";
import { reportText } from "../pipeline/report";
import { STAGES, type Report, type Stage, type StageEvent } from "../pipeline/types";

// Every fixture folder, as text (they go through submitSystem exactly as AI output would).
const MANIFESTS = import.meta.glob("../../fixtures/*/manifest.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const MODULES = import.meta.glob("../../fixtures/*/module.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
export const FIXTURES: { name: string; manifest: string; source: string }[] = Object.keys(MANIFESTS).map((p) => {
  const name = /fixtures\/([^/]+)\//.exec(p)![1];
  return { name, manifest: MANIFESTS[p], source: MODULES[`../../fixtures/${name}/module.ts`] ?? "" };
}).sort((a, b) => (a.name.startsWith("bad_") ? 1 : 0) - (b.name.startsWith("bad_") ? 1 : 0) || a.name.localeCompare(b.name));

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
};

export class PipelineTab {
  readonly body = el("div", "pipetab");
  private boxes = new Map<Stage, HTMLDivElement>();
  private buttons: HTMLButtonElement[] = [];
  private detail = el("pre", "pipedetail");
  private reportEl = el("pre", "pipereport", "Nothing submitted yet.");
  private loadedEl = el("div", "pipelist");
  private logEl = el("pre", "pipelog");
  private status = el("div", "pipestatus");
  private last: Report | null = null;
  private running = false;
  private frames = 0;

  constructor(private pipeline: Pipeline, private live: LiveLoader, private onFresh: () => void) {
    const b = this.body;
    b.append(el("div", "devsec", "Submit a fixture"));
    const row = el("div", "pipebtns");
    for (const f of FIXTURES) {
      const btn = el("button", f.name.startsWith("bad_") ? "bad" : "good", f.name); btn.type = "button";
      btn.addEventListener("click", () => void this.submitFixture(f.name));
      this.buttons.push(btn); row.append(btn);
    }
    b.append(row, el("div", "devsec", "Stages"));
    const stages = el("div", "stagerow");
    for (const s of STAGES) {
      const box = el("div", "stagebox grey"); box.title = "Click a red box for its errors";
      box.append(el("span", "name", s), el("span", "ms", ""));
      box.addEventListener("click", () => this.showErrors(s));
      this.boxes.set(s, box); stages.append(box);
    }
    b.append(stages, this.detail, el("div", "devsec", "Report"), this.reportEl);
    const actions = el("div", "pipebtns");
    const undo = el("button", "", "Undo last load"); undo.type = "button";
    undo.addEventListener("click", async () => { this.say(await this.live.undo()); this.refresh(); });
    const fresh = el("button", "danger", "Start fresh"); fresh.type = "button";
    fresh.addEventListener("click", () => { if (confirm("Delete every saved system, the world, the journal and the log, and start again with the base game?")) this.onFresh(); });
    actions.append(undo, fresh);
    b.append(actions, this.status, el("div", "devsec", "Systems"), this.loadedEl, el("div", "devsec", "Log: denials, near limits, strikes, unloads, overlaps"), this.logEl);
    this.detail.hidden = true;
    this.refresh();
  }

  private say(text: string) { this.status.textContent = text; }

  /** Submit a fixture by folder name (the buttons and the ?submit= aid). */
  async submitFixture(name: string): Promise<Report | null> {
    const f = FIXTURES.find((x) => x.name === name);
    if (!f) { this.say(`no fixture "${name}"`); return null; }
    if (this.running) { this.say("a submission is already running"); return null; }
    this.running = true; this.buttons.forEach((b) => (b.disabled = true));
    for (const box of this.boxes.values()) { box.className = "stagebox grey"; box.querySelector(".ms")!.textContent = ""; }
    this.detail.hidden = true; this.reportEl.textContent = `Checking ${name}...`; this.say("");
    try {
      const r = await this.pipeline.submitSystem(f.manifest, f.source);
      this.show(r);
      return r;
    } catch (e) {
      this.reportEl.textContent = `The pipeline failed: ${e instanceof Error ? e.message : String(e)}`;
      return null;
    } finally {
      this.running = false; this.buttons.forEach((b) => (b.disabled = false)); this.refresh();
    }
  }

  onStage(e: StageEvent) {
    const box = this.boxes.get(e.stage); if (!box) return;
    box.className = `stagebox ${e.status === "start" ? "amber" : e.status === "pass" ? "green" : "red"}`;
    if (e.ms !== undefined) box.querySelector(".ms")!.textContent = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)} s` : `${e.ms} ms`;
  }

  private show(r: Report) {
    this.last = r;
    if (!r.ok) this.boxes.get(r.stage)!.className = "stagebox red";
    this.reportEl.textContent = reportText(r);
    if (!r.ok) this.showErrors(r.stage);
  }

  private showErrors(stage: Stage) {
    const r = this.last;
    if (!r || r.ok || r.stage !== stage) { this.detail.hidden = true; return; }
    this.detail.hidden = false;
    this.detail.textContent = r.errors.map((e) => JSON.stringify(e, null, 1)).join("\n\n");
  }

  /** Called every frame while the tab is shown; the lists refresh a few times a second. */
  draw() { if (++this.frames % 20 === 0) this.refresh(); }

  refresh() {
    const host = this.live.host;
    const sys = [...host.systems.values()];
    const lines = [
      `Loaded: ${sys.map((s) => (s.base ? s.id : `${s.id} (AI)`)).join(", ")}`,
      ...(host.successors.size ? [`Replaced: ${[...host.successors].map(([a, b]) => `${a} by ${b}`).join(", ")}`] : []),
      `Skipped at startup: ${this.live.skipped.length ? this.live.skipped.map((s) => `${s.id} (${s.reason})`).join("; ") : "none"}`,
      ...(this.live.notes.length ? [`Startup notes: ${this.live.notes.join("; ")}`] : []),
      `Undo: ${this.live.history.length ? `last load was ${this.live.history.at(-1)!.id}` : "nothing loaded this session"}`,
      `Storage: ${this.live.store.kind === "dev" ? "dev server (data/)" : "this browser (localStorage + IndexedDB)"}`,
    ];
    this.loadedEl.textContent = lines.join("\n");
    const log: { tick: number; text: string }[] = [
      ...host.denials.map((d) => ({ tick: d.tick, text: `denied   ${d.system} ${d.op}: ${d.code}: ${d.msg}` })),
      ...host.nearLimits.map((n) => ({ tick: n.tick, text: `near     ${n.system} used ${n.used} of ${n.max} (${n.limit})` })),
      ...host.strikes.map((s) => ({ tick: s.tick, text: `strike   ${s.system} #${s.count}: ${s.msg}` })),
      ...host.unloads.map((u) => ({ tick: u.tick, text: `unloaded ${u.ids.join(", ")} (${u.reason})` })),
      ...host.overlaps.map((o) => ({ tick: o.tick, text: `overlap  ${o.systems.join(" + ")} wrote entity ${o.entity} on ${o.event}` })),
    ].sort((a, b) => a.tick - b.tick).slice(-60);
    const text = log.length ? log.map((l) => `${String(l.tick).padStart(7)}  ${l.text}`).join("\n") : "(empty)";
    if (this.logEl.textContent !== text) this.logEl.textContent = text;
  }
}
