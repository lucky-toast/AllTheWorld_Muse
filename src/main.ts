import { buildWorld } from "./world/map";
import { createGame } from "./systems/base/index";
import { Input } from "./engine/input";
import { loadSheets, render, renderSpritesTab, drawSprite, NATIVE_W, NATIVE_H } from "./engine/render";
import { TUNING } from "./tuning";
import { submitSystem, type PipelineContext } from "./pipeline/client";
import { detectStorage, type SystemStorage } from "./pipeline/storage";
import { reloadStoredSystems, reinstantiateAll } from "./pipeline/load";
import { PipelinePanel, type FixtureText } from "./pipeline/devpanel";

// Fixtures (spec 14) as text, exactly as AI output would arrive.
const manifestTexts = import.meta.glob("/fixtures/*/manifest.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sourceTexts = import.meta.glob("/fixtures/*/module.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
function fixtureList(): FixtureText[] {
  const out: FixtureText[] = [];
  for (const path of Object.keys(manifestTexts)) {
    const name = path.split("/")[2];
    const source = sourceTexts[`/fixtures/${name}/module.ts`];
    if (source !== undefined) out.push({ name, manifestJson: manifestTexts[path], source });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const eng = buildWorld();
const game = createGame(eng);
const input = new Input(game);
const params = new URLSearchParams(location.search);

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const transitionCanvas = document.getElementById("transition") as HTMLCanvasElement;
const devPanel = document.getElementById("devpanel") as HTMLDivElement;
const devCanvas = document.getElementById("devcanvas") as HTMLCanvasElement;
const devCtx = devCanvas.getContext("2d")!;
let panelOpen = params.get("dev") === "1";
let activeTab: "sprites" | "pipeline" = "sprites";
devPanel.hidden = !panelOpen;
input.swallowed = panelOpen;

function fit() {
  const ww = window.innerWidth, wh = window.innerHeight;
  const nativeWide = ww / wh > NATIVE_W / NATIVE_H;
  const gameW = nativeWide ? Math.floor(wh * (NATIVE_W / NATIVE_H)) : ww;
  const gameH = nativeWide ? wh : Math.floor(ww * (NATIVE_H / NATIVE_W));
  canvas.style.width = gameW + "px";
  canvas.style.height = gameH + "px";
  transitionCanvas.style.width = gameW + "px";
  transitionCanvas.style.height = gameH + "px";
  if (panelOpen) {
    const zoom = Math.min(3, Math.max(1, Math.floor(gameW / 264)));
    devCanvas.style.width = `${264 * 3 * zoom}px`;
    devCanvas.style.height = "auto";
  }
}
window.addEventListener("resize", fit);
fit();

/** Leaf transition (spec 13.1): fx_leaf swirling across a soft fade, about 2 s. */
function leafTransition(covered: () => void | Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const tctx = transitionCanvas.getContext("2d")!;
    transitionCanvas.hidden = false;
    const started = performance.now();
    const total = 2000;
    const leaves = Array.from({ length: 42 }, (_, i) => ({
      x: (i * 53) % NATIVE_W, y: (i * 97) % 320, speed: 0.6 + (i % 5) * 0.22, sway: 14 + (i % 4) * 7, phase: i * 1.7,
    }));
    let coveredDone = false;
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / total);
      const cover = t < 0.5 ? t * 2 : (1 - t) * 2; // 0 -> 1 -> 0
      tctx.clearRect(0, 0, NATIVE_W, NATIVE_H);
      tctx.fillStyle = `rgba(24,32,14,${0.92 * cover})`;
      tctx.fillRect(0, 0, NATIVE_W, NATIVE_H);
      tctx.imageSmoothingEnabled = false;
      for (const leaf of leaves) {
        const y = ((leaf.y + t * 340 * leaf.speed) % 340) - 10;
        const x = leaf.x + Math.sin(t * 9 + leaf.phase) * leaf.sway;
        tctx.globalAlpha = Math.min(1, cover + 0.25);
        drawSprite(tctx, "fx_leaf", Math.round(x), Math.round(y) + 16, Math.floor(t * 60), { frame: Math.floor(t * 24 + leaf.phase) % 4 });
      }
      tctx.globalAlpha = 1;
      if (t >= 0.5 && !coveredDone) {
        coveredDone = true;
        void Promise.resolve(covered()).then(() => {
          if (t < 1) requestAnimationFrame(step);
          else { transitionCanvas.hidden = true; resolve(); }
        });
        return;
      }
      if (t < 1) requestAnimationFrame(step);
      else { transitionCanvas.hidden = true; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

let storage: SystemStorage | null = null;
let panel: PipelinePanel | null = null;

function pipelineCtx(): PipelineContext {
  return {
    game,
    storage: storage ?? undefined,
    transition: leafTransition,
    onStage: (e) => panel?.onStage(e),
  };
}

const SPEED_CYCLE = [1, 4, 16];
input.onDevKey = (code, shift) => {
  if (code === "Backquote") {
    panelOpen = !panelOpen;
    devPanel.hidden = !panelOpen;
    input.swallowed = panelOpen;
    fit();
    return;
  }
  if (code === "KeyR" && shift) {
    game.reloadAll();
    if (storage) void reinstantiateAll(game, storage).then((r) => panel?.setSkipped(r.skipped));
    return;
  }
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

for (const [tabId, tab] of [["tab-sprites", "sprites"], ["tab-pipeline", "pipeline"]] as const) {
  document.getElementById(tabId)?.addEventListener("click", () => {
    activeTab = tab;
    document.getElementById("tab-sprites")?.classList.toggle("active", tab === "sprites");
    document.getElementById("tab-pipeline")?.classList.toggle("active", tab === "pipeline");
    (document.getElementById("sprites-tab") as HTMLDivElement).hidden = tab !== "sprites";
    (document.getElementById("pipeline-tab") as HTMLDivElement).hidden = tab !== "pipeline";
    if (tab === "pipeline") panel?.refresh();
  });
}

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
  if (panelOpen && activeTab === "sprites") renderSpritesTab(devCtx, eng.tickCount);
  requestAnimationFrame(frame);
}

void (async () => {
  try { await document.fonts.load('8px "Press Start 2P"'); } catch { /* fallback font is fine */ }
  await loadSheets();
  // Startup (spec 13.2): stored AI systems through the Module stage, then the saved world.
  storage = await detectStorage();
  const reload = await reloadStoredSystems(game, storage);
  const savedWorld = await storage.loadWorld().catch(() => null);
  if (savedWorld) {
    try { eng.restore(savedWorld); } catch { /* a bad save never blocks the game */ }
  }
  if (params.get("time")) eng.jumpTime(params.get("time")!);
  game.interactions.refresh();

  panel = new PipelinePanel(document.getElementById("pipeline-tab") as HTMLDivElement, {
    game,
    storage,
    fixtures: fixtureList(),
    submit: (f) => submitSystem(f.manifestJson, f.source, pipelineCtx()),
    startFresh: async () => {
      await storage?.startFresh();
      location.reload();
    },
  });
  panel.setSkipped(reload.skipped);

  // Autosave the world every 5 s and on unload (spec 13.2).
  setInterval(() => { void storage?.saveWorld(eng.serialize()).catch(() => { /* best effort */ }); }, 5000);
  window.addEventListener("pagehide", () => { void storage?.saveWorld(eng.serialize()).catch(() => { /* best effort */ }); });

  requestAnimationFrame(frame);

  // ?submit=<fixture> URL aid (spec 3): send a fixture through the pipeline on load.
  const submitName = params.get("submit");
  if (submitName) {
    const fixture = fixtureList().find((f) => f.name === submitName);
    if (fixture && panel) {
      // The aid exists to watch the pipeline: show its tab while it runs.
      document.getElementById("tab-pipeline")?.click();
      void panel.runFixture(fixture);
    }
  }
})();
