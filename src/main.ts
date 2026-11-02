// Browser entry: builds the world, runs the fixed-step loop and the renderer, and wires the dev keys.
import { buildWorld } from "./world/map";
import { Host } from "./engine/host";
import { FixedLoop } from "./engine/loop";
import { attachKeyboard } from "./engine/input";
import { loadBaseSystems } from "./systems/base";
import { loadSheets, render, NATIVE_W, NATIVE_H } from "./engine/render";
import { DevPanel } from "./dev/devpanel";
import { PipelineTab } from "./dev/pipelinetab";
import { Pipeline, browserWorker, configurePipeline } from "./pipeline/client";
import { LiveLoader } from "./pipeline/live";
import { detectStore } from "./pipeline/store";
import { drawTransition } from "./pipeline/transition";
import { drawTopBar, TOP_H, wishNotice, type ThinkingPhase } from "./engine/topbar";
import { LIMITS, TUNING } from "./tuning";
import { AiTab } from "./dev/aitab";
import { mapImagesBase64, renderMapImages } from "./ai/mapimage";
import { SwitchProvider } from "./ai/provider";
import { WishChain } from "./ai/chain";
import { AiLog, Journal } from "./ai/journal";
import { ChangedPanel } from "./ai/changed";
import type { StageEvent } from "./pipeline/types";

const canvas = document.getElementById("game") as HTMLCanvasElement;
// The canvas is the top bar (topbar.ts) above the game frame (map and bottom HUD).
const CANVAS_H = TOP_H + NATIVE_H;
canvas.width = NATIVE_W; canvas.height = CANVAS_H;
const ctx = canvas.getContext("2d")!;
const panelEl = document.getElementById("devpanel") as HTMLDivElement;
const wrap = document.getElementById("wrap")!;
const params = new URLSearchParams(location.search);

const eng = buildWorld();
const host = new Host(eng);
loadBaseSystems(host);
const devPanel = new DevPanel(panelEl);
const loop = new FixedLoop();
// Storage, the live loader and the pipeline (spec 12, 13). Set up before the first frame.
const store = await detectStore();
let tab: PipelineTab | null = null;
// The journal feeds "What changed"; the AI log is data/ai-log.jsonl (spec 13.3, 13.5).
const journal = new Journal(store);
await journal.load();
const aiLog = new AiLog(store);
const changed = new ChangedPanel(document.getElementById("changed") as HTMLDivElement);
changed.setEntries(journal.entries);
const live = new LiveLoader(host, store, {
  onChange: () => tab?.refresh(),
  onUndone: (id) => { void journal.forget(id).then(() => changed.setEntries(journal.entries)); },
});
// While a wish step is checked, its stage events also go to that attempt's row in the AI tab.
let aiStages: ((e: StageEvent) => void) | null = null;
const pipeline = new Pipeline({ createWorker: browserWorker, live, baseUrl: location.origin, onStage: (e) => { tab?.onStage(e); aiStages?.(e); } });
configurePipeline(pipeline);
pipeline.warm();
tab = new PipelineTab(pipeline, live, () => void startFresh());
devPanel.addTab("Pipeline", tab.body, () => tab!.draw());
// The wish chain and the AI tab (spec 13.5, 13.6). The AI tab picks each role's provider (copy and
// paste, or the Muse API) when a wish starts; in API mode the maps go with the designer's message.
let chain: WishChain | null = null;
// What the wish is waiting on, for the top bar's "The world is thinking" state.
let thinking: ThinkingPhase | null = null;
// How the last wish ended, when it didn't build everything, for the top bar's notice.
let notice: { text: string; start: number } | null = null;
const aiTab = new AiTab({ start: (w) => chain!.run(w), log: aiLog, onChangedSetting: (on) => { if (!on) changed.hide(); }, mapImages: () => renderMapImages(eng) });
chain = new WishChain({
  host, planner: new SwitchProvider(() => aiTab.pickPlanner()), designer: new SwitchProvider(() => aiTab.pickDesigner()), pipeline, journal, log: aiLog,
  mapImages: () => (aiTab.sendsImages ? mapImagesBase64(eng) : Promise.resolve([])),
  stats: store, // data/ai-usage.jsonl and data/ai-wishes.jsonl; npm run ai-report
  hooks: {
    ...aiTab.hooks,
    onJournal: () => changed.setEntries(journal.entries),
    onPlannerSend: (a, text) => { thinking = "planner"; aiTab.hooks.onPlannerSend?.(a, text); },
    onStepStart: (i, step) => { thinking = "designer"; aiTab.hooks.onStepStart?.(i, step); },
    onDone: (r) => {
      thinking = null;
      const text = wishNotice(r.status, r.loaded.length);
      notice = text ? { text, start: performance.now() } : null;
      aiTab.hooks.onDone?.(r);
    },
  },
  routeStages: (fn) => { aiStages = fn; },
});
devPanel.addTab("AI", aiTab.body);
async function startFresh() {
  await live.startFresh();
  const keep = new URLSearchParams(); if (params.get("dev")) keep.set("dev", "1");
  location.href = location.pathname + (keep.size ? `?${keep}` : "");
}

// Screen fit: the largest whole-number scale that fits (fractional below 1x), centered,
// re-fit on resize and when the dev panel opens. The panel never covers the map.
let panelOpen = false;
function fit() {
  const reserved = panelOpen ? panelEl.offsetWidth : 0;
  const availW = Math.max(1, window.innerWidth - reserved);
  wrap.style.width = `${availW}px`;
  const whole = Math.max(1, Math.min(Math.floor(availW / NATIVE_W), Math.floor(window.innerHeight / CANVAS_H)));
  const s = availW < NATIVE_W || window.innerHeight < CANVAS_H ? Math.min(availW / NATIVE_W, window.innerHeight / CANVAS_H) : whole;
  canvas.style.width = `${Math.floor(NATIVE_W * s)}px`; canvas.style.height = `${Math.floor(CANVAS_H * s)}px`;
  ctx.imageSmoothingEnabled = false;
}
function setPanel(open: boolean) {
  panelOpen = open; panelEl.hidden = !open; fit();
  if (open) host.controls.releaseAll(); // the panel swallows game input while open
}
window.addEventListener("resize", fit);
setPanel(!!params.get("dev"));
document.getElementById("devclose")?.addEventListener("click", () => setPanel(false));
// Clicking the game opens "What changed".
canvas.addEventListener("click", () => changed.toggle());

attachKeyboard(host.controls, {
  onTimeSpeed() {
    const speeds = TUNING.timeSpeeds; eng.timeSpeed = speeds[(speeds.indexOf(eng.timeSpeed as 1) + 1) % speeds.length];
    eng.banner = { text: `Time ${eng.timeSpeed}x`, t: TUNING.bannerTicks };
  },
  onDevPanel() { setPanel(!panelOpen); },
  // Shift+R: rebuild the registry and re-create every loaded module, keeping the world.
  onReloadSystems() { host.reloadSystems(); eng.banner = { text: "Systems reloaded", t: TUNING.bannerTicks }; },
  onChanged() { changed.toggle(); },
}, () => panelOpen || live.busy);

// Startup: every stored AI system through the Module stage again, then the saved world.
await live.startup((m, src) => pipeline.compile(m, src));
// Autosave every few seconds and when the page goes away.
setInterval(() => { void live.saveWorld().catch((e) => console.warn("autosave failed:", e)); }, LIMITS.autosaveMs);
window.addEventListener("pagehide", () => live.saveWorldOnExit());

// URL aid: ?time=night|dusk|dawn|day jumps the clock on load.
const time = params.get("time");
if (time && ["night", "dusk", "dawn", "day"].includes(time)) eng.jumpClock(time);
host.interactions.refresh(true);
// Dev builds expose the engine and host for poking at from the console.
if (import.meta.env.DEV) Object.assign(window, { atw: { eng, host, live, pipeline, tab, chain, aiTab, journal, aiLog } });

// Pixel font from the pack path; this pack copy has no font file, so text falls back to monospace.
try {
  const face = new FontFace("PixelFont", "url('/assets/Ninja%20Adventure%20-%20Asset%20Pack/Ui/Font/NormalFont.ttf')");
  face.load().then((f) => { document.fonts.add(f); }).catch(() => {});
} catch { /* fallback stays monospace */ }

let last = performance.now();
function frame(now: number) {
  // Ticks and input pause while a system loads live.
  if (live.busy) loop.reset(); else loop.advance(now - last, () => host.tick());
  last = now;
  ctx.imageSmoothingEnabled = false;
  // The game frame sits below the top bar; the load transition and its banner still cover only the map.
  ctx.save(); ctx.translate(0, TOP_H);
  render(ctx, eng);
  drawTransition(ctx, live.transitionStart, now);
  ctx.restore();
  const newest = journal.entries[journal.entries.length - 1];
  drawTopBar(ctx, { area: eng.currentArea(), last: newest?.title ?? null, thinking: chain?.running && !live.busy ? thinking : null, notice }, now);
  devPanel.draw(eng.tickCount);
  requestAnimationFrame(frame);
}
void loadSheets().then(() => {
  last = performance.now(); requestAnimationFrame(frame);
  // URL aid: ?submit=<fixture> sends a fixture through the pipeline once (dropped from the URL so a refresh doesn't resend it).
  const submit = params.get("submit");
  if (submit) {
    const url = new URL(location.href); url.searchParams.delete("submit"); history.replaceState(null, "", url);
    void tab!.submitFixture(submit);
  }
});
