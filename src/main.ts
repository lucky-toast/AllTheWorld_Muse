import { buildWorld } from "./world/map";
import { BASE_SYSTEMS } from "./systems/base/index";
import { loadSheets, render, renderSpritesTab, NATIVE_W, NATIVE_H } from "./engine/render";
import { Input } from "./engine/input";
import { TUNING } from "./tuning";

const canvas = document.getElementById("game") as HTMLCanvasElement;
canvas.width = NATIVE_W; canvas.height = NATIVE_H;
const ctx = canvas.getContext("2d")!;
const panel = document.getElementById("devpanel") as HTMLDivElement;
const devCanvas = document.getElementById("devcanvas") as HTMLCanvasElement;
const devCtx = devCanvas.getContext("2d")!;

const eng = buildWorld();
for (const s of BASE_SYSTEMS) eng.loadSystem(s);
const params = new URLSearchParams(location.search);
if (params.get("time")) eng.world().time.set(params.get("time")!); // shot/test aid, e.g. ?time=night
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
  if (code === "KeyR" && shift) { eng.reloadAll(BASE_SYSTEMS); eng.world().ui.banner("Systems reloaded"); }
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
  while (acc >= stepMs) { input.tick(); eng.tick(); acc -= stepMs; }
  ctx.imageSmoothingEnabled = false;
  render(ctx, eng);
  if (panelOpen) renderSpritesTab(devCtx, eng.tickCount);
  requestAnimationFrame(frame);
}
loadSheets().then(() => requestAnimationFrame(frame));
