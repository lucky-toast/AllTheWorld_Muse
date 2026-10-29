// Pipeline worker: runs every check stage except Load. Has its own engine copy;
// the live game is never touched here. Killed by the client if a stage times out.
import { runCheck } from "./core";
import type { CheckRequest } from "./types";
import { loadSheetBitmaps, render, setRenderBackend, NATIVE_W, NATIVE_H } from "../engine/render";
import type { Engine } from "../engine/engine";

const FALLBACK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
let bitmaps: Map<string, { width: number; height: number }> | null = null;

function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf); let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return "data:image/png;base64," + btoa(bin);
  });
}

async function renderShot(eng: Engine, shot: { focus: { x: number; y: number } }, _w: unknown, baseUrl: string): Promise<string> {
  void _w;
  if (typeof OffscreenCanvas === "undefined") return FALLBACK_PNG;
  if (!bitmaps) {
    bitmaps = await loadSheetBitmaps(baseUrl);
    const map = bitmaps;
    setRenderBackend((f) => map.get(f), (w, h) => new OffscreenCanvas(w, h) as never);
  }
  const full = new OffscreenCanvas(NATIVE_W, NATIVE_H);
  const fctx = full.getContext("2d")!;
  render(fctx as unknown as CanvasRenderingContext2D, eng);
  // Crop ~9x7 tiles around focus, zoom 3x.
  const cw = 9 * 16, ch = 7 * 16;
  const sx = Math.max(0, Math.min(480 - cw, shot.focus.x * 16 + 8 - cw / 2));
  const sy = Math.max(0, Math.min(320 - ch, shot.focus.y * 16 + 8 - ch / 2));
  const out = new OffscreenCanvas(cw * 3, ch * 3);
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, sx, sy, cw, ch, 0, 0, cw * 3, ch * 3);
  return blobToDataUrl(await out.convertToBlob({ type: "image/png" }));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; req: CheckRequest };
  if (msg.type !== "check") return;
  try {
    const report = await runCheck(msg.req, {
      onStage: (stage, status, ms) => self.postMessage({ type: "stage", stage, status, ms }),
      renderShot: (eng, shot, w) => renderShot(eng, shot, w, msg.req.baseUrl),
    });
    self.postMessage({ type: "done", report });
  } catch (err) {
    self.postMessage({ type: "error", message: (err as Error).message });
  }
};
