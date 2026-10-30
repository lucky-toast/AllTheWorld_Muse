import type { Engine } from "../engine/engine";
import { render, NATIVE_W } from "../engine/render";

export const MAP_SCALE = 3;
export const MAP_MARGIN_LEFT = 30;
export const MAP_MARGIN_TOP = 20;
const WORLD_W = NATIVE_W; // 480
const WORLD_H = 320; // map only, no HUD
/** Pixel centre of a tile in the map image, so labels line up with tiles. */
export function tileCenterPx(x: number, y: number): { px: number; py: number } {
  return { px: MAP_MARGIN_LEFT + (x * 16 + 8) * MAP_SCALE, py: MAP_MARGIN_TOP + (y * 16 + 8) * MAP_SCALE };
}

/**
 * PNG of the current world as the player would see it, always in daylight,
 * no HUD, at 3x, with a grid line on every tile and tile coordinates labelled
 * along the top and left edges (same x/y as e.pos, tiles.get and moveTo).
 * Pure function of the world: it temporarily sets the clock to morning for
 * the render and restores it immediately.
 */
export function renderMapImage(world: Engine): Promise<Blob> {
  const full = document.createElement("canvas"); full.width = WORLD_W; full.height = 348;
  const fctx = full.getContext("2d")!;
  const prevHour = world.hour;
  world.hour = 9; // daylight: no darkness layer
  try { render(fctx, world); } finally { world.hour = prevHour; }

  const out = document.createElement("canvas");
  out.width = MAP_MARGIN_LEFT + WORLD_W * MAP_SCALE;
  out.height = MAP_MARGIN_TOP + WORLD_H * MAP_SCALE;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#202812"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(full, 0, 0, WORLD_W, WORLD_H, MAP_MARGIN_LEFT, MAP_MARGIN_TOP, WORLD_W * MAP_SCALE, WORLD_H * MAP_SCALE);
  // Grid: 1px white at ~25% opacity around every tile.
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= world.width; x++) { const px = MAP_MARGIN_LEFT + x * 16 * MAP_SCALE + 0.5; ctx.moveTo(px, MAP_MARGIN_TOP); ctx.lineTo(px, MAP_MARGIN_TOP + WORLD_H * MAP_SCALE); }
  for (let y = 0; y <= world.height; y++) { const py = MAP_MARGIN_TOP + y * 16 * MAP_SCALE + 0.5; ctx.moveTo(MAP_MARGIN_LEFT, py); ctx.lineTo(MAP_MARGIN_LEFT + WORLD_W * MAP_SCALE, py); }
  ctx.stroke();
  // Edge labels, lined up with tile centres.
  ctx.font = "10px monospace"; ctx.fillStyle = "#e8e4c8"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let x = 0; x < world.width; x++) ctx.fillText(String(x), tileCenterPx(x, 0).px, MAP_MARGIN_TOP / 2);
  for (let y = 0; y < world.height; y++) ctx.fillText(String(y), MAP_MARGIN_LEFT / 2, tileCenterPx(0, y).py);
  return new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("map image render failed"))), "image/png"));
}
