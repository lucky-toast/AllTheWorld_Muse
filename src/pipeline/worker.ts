// The pipeline Web Worker (spec 12): stages 1 to 6 with its own engine copies, plus
// recompiles at startup. The client's watchdog terminates it when a stage runs over.
// Shots render here to an OffscreenCanvas with lighting, cropped around the focus and zoomed.
import { handleMessage } from "./protocol";
import { areaOffsetPx, loadSheetBitmaps, render, setRenderBackend, NATIVE_W, MAP_PX_H } from "../engine/render";
import type { Host } from "../engine/host";
import type { Shot } from "../engine/manifest";
import type { ToWorker } from "./types";
import { TUNING } from "../tuning";

let sheets: Promise<void> | null = null;

function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf); let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return "data:image/png;base64," + btoa(bin);
  });
}

async function renderShot(baseUrl: string, host: Host, shot: Shot): Promise<string | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  if (!sheets) sheets = loadSheetBitmaps(baseUrl).then((map) => { setRenderBackend((f) => map.get(f), (w, h) => new OffscreenCanvas(w, h) as never); });
  await sheets;
  const full = new OffscreenCanvas(NATIVE_W, MAP_PX_H + 28);
  render(full.getContext("2d") as unknown as CanvasRenderingContext2D, host.eng);
  const T = TUNING.shotTilesW, H = TUNING.shotTilesH, Z = TUNING.shotZoom;
  const cw = T * 16, ch = H * 16;
  const off = areaOffsetPx(host.eng, host.eng.currentArea()); // a smaller area is drawn centred
  const sx = Math.max(0, Math.min(NATIVE_W - cw, off.x + shot.focus.x * 16 + 8 - cw / 2));
  const sy = Math.max(0, Math.min(MAP_PX_H - ch, off.y + shot.focus.y * 16 + 8 - ch / 2));
  const out = new OffscreenCanvas(cw * Z, ch * Z);
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(full, sx, sy, cw, ch, 0, 0, cw * Z, ch * Z);
  return blobToDataUrl(await out.convertToBlob({ type: "image/png" }));
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  const baseUrl = msg.type === "check" ? msg.baseUrl : "";
  void handleMessage(msg, (m) => self.postMessage(m), (host, shot) => renderShot(baseUrl, host, shot));
};
// The compiler's modules use top-level await, so this script finishes evaluating late; a message
// sent before then would be lost. The client waits for this before sending anything.
self.postMessage({ type: "ready" });
