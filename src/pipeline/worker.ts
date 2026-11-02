// Pipeline worker (spec 12): stages 1-6 with its own engine copy and the
// current world snapshot. The live game is never touched here. The client
// terminates this worker if a stage passes its time limit (watchdog).
import { loadSheetBitmaps, render, setRenderBackend, NATIVE_W, NATIVE_H } from "../engine/render";
import type { Engine } from "../engine/engine";
import { runCheck } from "./core";
import type { CheckRequest } from "./types";

const FALLBACK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
let bitmaps: Map<string, { width: number; height: number }> | null = null;

function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return "data:image/png;base64," + btoa(bin);
  });
}

async function renderShot(eng: Engine, shot: { focus: { x: number; y: number } }, baseUrl: string): Promise<string> {
  if (typeof OffscreenCanvas === "undefined") return FALLBACK_PNG;
  if (!bitmaps) {
    bitmaps = await loadSheetBitmaps(baseUrl);
    const map = bitmaps;
    setRenderBackend((f) => map.get(f), (w, h) => new OffscreenCanvas(w, h) as never);
  }
  const full = new OffscreenCanvas(NATIVE_W, NATIVE_H);
  const fctx = full.getContext("2d")!;
  render(fctx as unknown as CanvasRenderingContext2D, eng);
  // Crop about 9x7 tiles around the focus, zoomed 3x (spec 12, stage 6).
  const cw = 9 * 16, ch = 7 * 16;
  const sx = Math.max(0, Math.min(NATIVE_W - cw, shot.focus.x * 16 + 8 - cw / 2));
  const sy = Math.max(0, Math.min(320 - ch, shot.focus.y * 16 + 8 - ch / 2));
  const out = new OffscreenCanvas(cw * 3, ch * 3);
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, sx, sy, cw, ch, 0, 0, cw * 3, ch * 3);
  return blobToDataUrl(await out.convertToBlob({ type: "image/png" }));
}

// Boot can be slow (the compiler bundle loads first); tell the client we are
// ready so its watchdog only ever times actual stages, never module loading.
self.postMessage({ type: "ready" });

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; req: CheckRequest };
  if (msg.type !== "check") return;
  try {
    const report = await runCheck(msg.req, {
      onStage: (e) => self.postMessage({ type: "stage", stage: e.stage, status: e.status, ms: e.ms }),
      renderShot: (game, shot) => renderShot(game.eng, shot, msg.req.baseUrl),
    });
    self.postMessage({ type: "done", report });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
