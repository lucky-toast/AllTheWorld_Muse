import { buildWorld } from "./world/map";
import { loadSheets, render, renderSpritesTab, NATIVE_W, NATIVE_H } from "./engine/render";
import { TUNING } from "./tuning";

const eng = buildWorld();
const params = new URLSearchParams(location.search);
if (params.get("time")) eng.jumpTime(params.get("time")!);

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const devPanel = document.getElementById("devpanel") as HTMLDivElement;
const devCanvas = document.getElementById("devcanvas") as HTMLCanvasElement;
const devCtx = devCanvas.getContext("2d")!;
let panelOpen = params.get("dev") === "1";
devPanel.hidden = !panelOpen;

function fit() {
  const ww = window.innerWidth, wh = window.innerHeight;
  const nativeWide = ww / wh > NATIVE_W / NATIVE_H;
  const gameW = nativeWide ? Math.floor(wh * (NATIVE_W / NATIVE_H)) : ww;
  const gameH = nativeWide ? wh : Math.floor(ww * (NATIVE_H / NATIVE_W));
  canvas.style.width = gameW + "px";
  canvas.style.height = gameH + "px";
  if (panelOpen) {
    const zoom = Math.min(3, Math.max(1, Math.floor(gameW / 264)));
    devCanvas.style.width = `${264 * 3 * zoom}px`;
    devCanvas.style.height = "auto";
  }
}
window.addEventListener("resize", fit);
fit();

const SPEED_CYCLE = [1, 2, 3, 0.5];
window.addEventListener("keydown", (e) => {
  if (e.key === "`") {
    panelOpen = !panelOpen;
    devPanel.hidden = !panelOpen;
    fit();
    e.preventDefault();
    return;
  }
  if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const next = SPEED_CYCLE[(SPEED_CYCLE.indexOf(eng.timeSpeed) + 1) % SPEED_CYCLE.length];
    eng.timeSpeed = next;
    void eng.host.call("(engine)", { op: "ui.banner", text: `Speed ${next}x` });
    e.preventDefault();
  }
});

let last = performance.now();
let acc = 0;
function frame(now: number) {
  acc += Math.min(250, now - last);
  last = now;
  const stepMs = 1000 / TUNING.ticksPerSecond;
  while (acc >= stepMs) {
    eng.tick();
    acc -= stepMs;
  }
  render(ctx, eng);
  if (panelOpen) renderSpritesTab(devCtx, eng.tickCount);
  requestAnimationFrame(frame);
}

void (async () => {
  try { await document.fonts.load('8px "Press Start 2P"'); } catch { /* fallback font is fine */ }
  await loadSheets();
  requestAnimationFrame(frame);
})();
