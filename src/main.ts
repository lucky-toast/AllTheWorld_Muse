import { buildWorld } from "./world/map";
import { BASE_SYSTEMS } from "./systems/base/index";
import { loadSheets, render, renderSpritesTab, NATIVE_W, NATIVE_H } from "./engine/render";
import { Input } from "./engine/input";
import { TUNING } from "./tuning";
import { configurePipeline, defaultDeps } from "./pipeline/client";
import { LiveLoader } from "./pipeline/live";
import { DevPanel } from "./pipeline/devpanel";
import { loadSavedSystems, loadSavedWorld, saveWorld } from "./pipeline/persistence";

const canvas = document.getElementById("game") as HTMLCanvasElement;
canvas.width = NATIVE_W; canvas.height = NATIVE_H;
const ctx = canvas.getContext("2d")!;
const panel = document.getElementById("devpanel") as HTMLDivElement;
const devCanvas = document.getElementById("devcanvas") as HTMLCanvasElement;
const devCtx = devCanvas.getContext("2d")!;

const eng = buildWorld();
for (const s of BASE_SYSTEMS) eng.loadSystem(s);
const live = new LiveLoader(eng);
const devPanel = new DevPanel(document.getElementById("pipeline-root")!, {
  getLoaded: () => eng.loadOrder.filter((id) => live.runtime.has(id)),
  getSkipped: () => live.skipped,
});
configurePipeline({
  ...defaultDeps((report) => live.performLoad(report)),
  getLoaded: () => live.loadedSources(),
  getSnapshot: () => eng.snapshot(),
  onStage: (ev) => devPanel.onStage(ev),
});
const params = new URLSearchParams(location.search);
if (params.get("dev")) panel.hidden = false;
const input = new Input(eng);

let panelOpen = params.get("dev") ? true : false;
if (panelOpen) input.swallowed = true;
function fit() {
  const scale = Math.max(1, Math.min(Math.floor(window.innerWidth / NATIVE_W), Math.floor(window.innerHeight / NATIVE_H)));
  const s = window.innerWidth < NATIVE_W || window.innerHeight < NATIVE_H ? Math.min(window.innerWidth / NATIVE_W, window.innerHeight / NATIVE_H) : scale;
  canvas.style.width = `${Math.floor(NATIVE_W * s)}px`; canvas.style.height = `${Math.floor(NATIVE_H * s)}px`;
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener("resize", fit); fit();

input.attach((code, shift) => {
  if (code === "KeyT") { eng.timeSpeed = eng.timeSpeed === 1 ? 4 : eng.timeSpeed === 4 ? 16 : 1; eng.world().ui.banner(`Time ${eng.timeSpeed}x`); }
  if (code === "KeyR" && shift) { eng.reloadAll([...BASE_SYSTEMS, ...live.allDefs()]); eng.world().ui.banner("Systems reloaded"); }
  if (code === "Backquote") { panelOpen = !panelOpen; panel.hidden = !panelOpen; input.swallowed = panelOpen; }
});
document.getElementById("devclose")?.addEventListener("click", () => { panelOpen = false; panel.hidden = true; input.swallowed = false; });

// Pixel font: the pack path from the brief; falls back to monospace if the font file is absent in this pack copy.
try {
  const face = new FontFace("PixelFont", "url('/assets/Ninja%20Adventure%20-%20Asset%20Pack/Ui/Font/NormalFont.ttf')");
  face.load().then((f) => { document.fonts.add(f); }).catch(() => {});
} catch { /* fallback stays monospace */ }

let last = performance.now(); let acc = 0; const stepMs = 1000 / TUNING.ticksPerSecond;
function frame(now: number) {
  acc += Math.min(250, now - last); last = now;
  if (!live.transitioning) { while (acc >= stepMs) { input.tick(); eng.tick(); acc -= stepMs; } } else acc = 0;
  ctx.imageSmoothingEnabled = false;
  render(ctx, eng);
  live.drawTransition(ctx, now);
  if (panelOpen) renderSpritesTab(devCtx, eng.tickCount);
  requestAnimationFrame(frame);
}
// Startup: load saved systems (no transition), then restore the saved world.
(async () => {
  const saved = await loadSavedSystems();
  if (saved.length) await live.loadSaved(saved, BASE_SYSTEMS.map((s) => s.id));
  const world = await loadSavedWorld();
  if (world) { try { eng.restore(world); } catch { /* start with the fresh world */ } }
  if (params.get("time")) eng.world().time.set(params.get("time")!); // shot/test aid, e.g. ?time=night
  devPanel.refreshLoaded();
  if (params.get("submit")) void devPanel.submitFixture(params.get("submit")!); // browser-aid: drive the pipeline end-to-end
  setInterval(() => { void saveWorld(eng.serialize()); }, 5000);
  window.addEventListener("beforeunload", () => { void saveWorld(eng.serialize()); });
  await loadSheets();
  requestAnimationFrame(frame);
})();
