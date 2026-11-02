// Map images for the designer (ported from renderMapImage at 24531c5, reworked): one PNG per
// area, the world in daylight at 1x (16 px per tile) with no lighting, effects or HUD. Tiles are
// spaced by a 1 px grid line of one fixed colour, so no sprite pixel is covered, and column and
// row numbers sit in a thin margin along the top and left edges (the same x and y the SDK uses).
// Each image is labelled with its area id. At most MAP_IMAGE_MAX_AREAS areas: the player's
// current area first, then the most recently created ones.
import type { Engine } from "../engine/engine";
import { drawArea } from "../engine/render";
import { LIMITS } from "../tuning";

/** Pixels per tile, plus the grid line between tiles. */
export const MAP_TILE_PX = 16;
export const MAP_CELL_PX = MAP_TILE_PX + 1;
/** Margins: the area label, then the column numbers along the top; the row numbers on the left. */
export const MAP_LABEL_H = 14;
export const MAP_NUMBERS_H = 11;
export const MAP_MARGIN_LEFT = 16;
export const MAP_MARGIN_TOP = MAP_LABEL_H + MAP_NUMBERS_H;
const GRID_COLOR = "#000000";
const MARGIN_COLOR = "#202812";
const TEXT_COLOR = "#e8e4c8";

/** The bits of a canvas this file uses (a DOM canvas, an OffscreenCanvas or a test stand-in). */
export interface CanvasLike { width: number; height: number; getContext(type: "2d"): unknown }
export type CanvasMaker = (w: number, h: number) => CanvasLike;
const domCanvas: CanvasMaker = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

/** Which areas get a map: the player's current area first, then the newest others, MAP_IMAGE_MAX_AREAS in all. */
export function mapAreas(eng: Engine): string[] {
  const current = eng.currentArea();
  const newestFirst = [...eng.areas.keys()].reverse().filter((a) => a !== current);
  return [current, ...newestFirst].slice(0, LIMITS.MAP_IMAGE_MAX_AREAS);
}

/** An area's size in tiles (the map's for an unknown area). */
function tilesOf(eng: Engine, area: string): { w: number; h: number } {
  return eng.areaSize(area) ?? { w: eng.width, h: eng.height };
}

/** Size of one map image in pixels: an area smaller than the map gets a smaller image. */
export function mapSize(eng: Engine, area: string = eng.currentArea()): { w: number; h: number } {
  const t = tilesOf(eng, area);
  return { w: MAP_MARGIN_LEFT + t.w * MAP_CELL_PX + 1, h: MAP_MARGIN_TOP + t.h * MAP_CELL_PX + 1 };
}

/** Pixel position of tile (x, y)'s top-left corner in a map image. */
export function tilePx(x: number, y: number): { px: number; py: number } {
  return { px: MAP_MARGIN_LEFT + 1 + x * MAP_CELL_PX, py: MAP_MARGIN_TOP + 1 + y * MAP_CELL_PX };
}

/** Draw one area's map. Pure in the world: nothing in the engine changes. */
export function renderMap(eng: Engine, area: string, make: CanvasMaker = domCanvas): CanvasLike {
  const t = tilesOf(eng, area);
  const world = make(t.w * MAP_TILE_PX, t.h * MAP_TILE_PX);
  const wctx = world.getContext("2d") as CanvasRenderingContext2D;
  drawArea(wctx, eng, area, true);

  const { w, h } = mapSize(eng, area);
  const out = make(w, h);
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = MARGIN_COLOR; ctx.fillRect(0, 0, w, h);
  // The grid: one colour behind the whole map; each tile is copied into its cell, leaving 1 px lines.
  ctx.fillStyle = GRID_COLOR; ctx.fillRect(MAP_MARGIN_LEFT, MAP_MARGIN_TOP, w - MAP_MARGIN_LEFT, h - MAP_MARGIN_TOP);
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
    const { px, py } = tilePx(x, y);
    ctx.drawImage(world as CanvasImageSource, x * MAP_TILE_PX, y * MAP_TILE_PX, MAP_TILE_PX, MAP_TILE_PX, px, py, MAP_TILE_PX, MAP_TILE_PX);
  }
  // The area label, then column numbers along the top and row numbers down the left, centred on their tiles.
  ctx.fillStyle = TEXT_COLOR; ctx.textBaseline = "middle";
  ctx.font = "bold 10px monospace"; ctx.textAlign = "left";
  ctx.fillText(`area ${area}`, 2, MAP_LABEL_H / 2 + 1);
  ctx.font = "9px monospace"; ctx.textAlign = "center";
  for (let x = 0; x < t.w; x++) ctx.fillText(String(x), tilePx(x, 0).px + MAP_TILE_PX / 2, MAP_LABEL_H + MAP_NUMBERS_H / 2 + 1);
  for (let y = 0; y < t.h; y++) ctx.fillText(String(y), MAP_MARGIN_LEFT / 2, tilePx(0, y).py + MAP_TILE_PX / 2 + 1);
  return out;
}

/** One map per area in mapAreas order (the current area first), drawn from the world as it is now. */
export function renderMaps(eng: Engine, make: CanvasMaker = domCanvas): { area: string; canvas: CanvasLike }[] {
  return mapAreas(eng).map((area) => ({ area, canvas: renderMap(eng, area, make) }));
}

/** The maps as PNGs, each named after its area (browser only). */
export async function renderMapImages(eng: Engine): Promise<{ area: string; fileName: string; png: Blob }[]> {
  const maps = renderMaps(eng);
  return Promise.all(maps.map(({ area, canvas }) => new Promise<{ area: string; fileName: string; png: Blob }>((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve({ area, fileName: mapFileName(area), png: b }) : reject(new Error(`the map of ${area} couldn't be rendered`))), "image/png"))));
}

/** A file name for an area's map: map-<area id>.png, with anything unusual in the id replaced by _. */
export function mapFileName(area: string): string { return `map-${area.replace(/[^A-Za-z0-9._-]/g, "_")}.png`; }

/** Bytes as base64, in chunks so a large image doesn't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The maps as base64 PNGs, ready to go with the designer's message (browser only). */
export async function mapImagesBase64(eng: Engine): Promise<{ mediaType: "image/png"; data: string }[]> {
  const maps = await renderMapImages(eng);
  return Promise.all(maps.map(async (m) => ({ mediaType: "image/png" as const, data: bytesToBase64(new Uint8Array(await m.png.arrayBuffer())) })));
}
