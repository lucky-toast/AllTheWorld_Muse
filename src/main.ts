import { buildWorld } from "./world/map";
import { createGame } from "./systems/base/index";
import { Input } from "./engine/input";
import { loadSheets, render, renderSpritesTab, NATIVE_W, NATIVE_H } from "./engine/render";
import { TUNING } from "./tuning";

const eng = buildWorld();
const game = createGame(eng);
const input = new Input(game);
const params = new URLSearchParams(location.search);
if (params.get("time")) eng.jumpTime(params.get("time")!);
game.interactions.refresh();

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const devPanel = document.getElementById("devpanel") as HTMLDivElement;
const devCanvas = document.getElementById("devcanvas") as HTMLCanvasElement;
const devCtx = devCanvas.getContext("2d")!;
let panelOpen = params.get("dev") === "1";
devPanel.hidden = !panelOpen;
input.swallowed = panelOpen;

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

const SPEED_CYCLE = [1, 4, 16];
input.onDevKey = (code, shift) => {
  if (code === "Backquote") {
    panelOpen = !panelOpen;
    devPanel.hidden = !panelOpen;
    input.swallowed = panelOpen;
    fit();
    return;
  }
  if (code === "KeyR" && shift) { game.reloadAll(); return; }
  if (code === "KeyT") {
    const next = SPEED_CYCLE[(SPEED_CYCLE.indexOf(eng.timeSpeed) + 1) % SPEED_CYCLE.length];
    eng.timeSpeed = next;
    void eng.host.call("(engine)", { op: "ui.banner", text: `Speed ${next}x` });
  }
};
input.attach();
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
});

let last = performance.now();
let acc = 0;
function frame(now: number) {
  acc += Math.min(250, now - last);
  last = now;
  const stepMs = 1000 / TUNING.ticksPerSecond;
  while (acc >= stepMs) {
    game.tick();
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
