// Browser entry: builds the world, runs the fixed-step loop and the renderer, and wires the dev keys.
import { buildWorld } from "./world/map";
import { Host } from "./engine/host";
import { FixedLoop } from "./engine/loop";
import { attachKeyboard } from "./engine/input";
import { loadBaseSystems } from "./systems/base";
import { loadSheets, render, NATIVE_W, NATIVE_H } from "./engine/render";
import { DevPanel } from "./dev/devpanel";
import { TUNING } from "./tuning";

const canvas = document.getElementById("game") as HTMLCanvasElement;
canvas.width = NATIVE_W; canvas.height = NATIVE_H;
const ctx = canvas.getContext("2d")!;
const panelEl = document.getElementById("devpanel") as HTMLDivElement;
const wrap = document.getElementById("wrap")!;
const params = new URLSearchParams(location.search);

const eng = buildWorld();
const host = new Host(eng);
loadBaseSystems(host);
const devPanel = new DevPanel(panelEl);
const loop = new FixedLoop();

// Screen fit: the largest whole-number scale that fits (fractional below 1x), centered,
// re-fit on resize and when the dev panel opens. The panel never covers the map.
let panelOpen = false;
function fit() {
  const reserved = panelOpen ? panelEl.offsetWidth : 0;
  const availW = Math.max(1, window.innerWidth - reserved);
  wrap.style.width = `${availW}px`;
  const whole = Math.max(1, Math.min(Math.floor(availW / NATIVE_W), Math.floor(window.innerHeight / NATIVE_H)));
  const s = availW < NATIVE_W || window.innerHeight < NATIVE_H ? Math.min(availW / NATIVE_W, window.innerHeight / NATIVE_H) : whole;
  canvas.style.width = `${Math.floor(NATIVE_W * s)}px`; canvas.style.height = `${Math.floor(NATIVE_H * s)}px`;
  ctx.imageSmoothingEnabled = false;
}
function setPanel(open: boolean) {
  panelOpen = open; panelEl.hidden = !open; fit();
  if (open) host.controls.releaseAll(); // the panel swallows game input while open
}
window.addEventListener("resize", fit);
setPanel(!!params.get("dev"));
document.getElementById("devclose")?.addEventListener("click", () => setPanel(false));

attachKeyboard(host.controls, {
  onTimeSpeed() {
    const speeds = TUNING.timeSpeeds; eng.timeSpeed = speeds[(speeds.indexOf(eng.timeSpeed as 1) + 1) % speeds.length];
    eng.banner = { text: `Time ${eng.timeSpeed}x`, t: TUNING.bannerTicks };
  },
  onDevPanel() { setPanel(!panelOpen); },
  // Shift+R: rebuild the registry and re-create every loaded module, keeping the world.
  onReloadSystems() { host.reloadSystems(); eng.banner = { text: "Systems reloaded", t: TUNING.bannerTicks }; },
}, () => panelOpen);

// URL aid: ?time=night|dusk|dawn|day jumps the clock on load.
const time = params.get("time");
if (time && ["night", "dusk", "dawn", "day"].includes(time)) eng.jumpClock(time);
host.interactions.refresh(true);
// Dev builds expose the engine and host for poking at from the console.
if (import.meta.env.DEV) Object.assign(window, { atw: { eng, host } });

// Pixel font from the pack path; this pack copy has no font file, so text falls back to monospace.
try {
  const face = new FontFace("PixelFont", "url('/assets/Ninja%20Adventure%20-%20Asset%20Pack/Ui/Font/NormalFont.ttf')");
  face.load().then((f) => { document.fonts.add(f); }).catch(() => {});
} catch { /* fallback stays monospace */ }

let last = performance.now();
function frame(now: number) {
  loop.advance(now - last, () => host.tick()); last = now;
  ctx.imageSmoothingEnabled = false;
  render(ctx, eng);
  devPanel.draw(eng.tickCount);
  requestAnimationFrame(frame);
}
void loadSheets().then(() => { last = performance.now(); requestAnimationFrame(frame); });
