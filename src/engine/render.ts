// Renderer (spec section 3, "Rendering order"), ported from the old engine. Draws only
// the player's current area. It reads the engine directly: it is engine code, not a system.
import { CATALOG, catalogGet } from "./catalog";
import type { Engine, EntRec } from "./engine";
import type { Dir, LightComp, SpriteComp } from "./types";
import { TUNING, phaseAt } from "../tuning";

const HUD_H = 28;
export const MAP_PX_H = 320;
export const NATIVE_W = 480, NATIVE_H = MAP_PX_H + HUD_H;


type AnyImage = { width: number; height: number };
const images = new Map<string, AnyImage>();
let imageProvider: (file: string) => AnyImage | undefined = (f) => images.get(f);
let canvasFactory: (w: number, h: number) => { width: number; height: number; getContext: (t: string) => unknown } =
  (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c as never; };
/** Worker rendering: supply ImageBitmaps and an OffscreenCanvas factory. */
export function setRenderBackend(provider: (file: string) => AnyImage | undefined, factory: typeof canvasFactory) { imageProvider = provider; canvasFactory = factory; }
export async function loadSheetBitmaps(baseUrl: string): Promise<Map<string, AnyImage>> {
  const map = new Map<string, AnyImage>();
  const files = [...new Set(CATALOG.sprites.map((s) => s.file))];
  await Promise.all(files.map(async (f) => {
    try { const r = await fetch(baseUrl + "/assets/" + encodeURI(CATALOG.root + f)); const b = await r.blob(); map.set(f, await createImageBitmap(b)); } catch { /* missing sheet draws nothing */ }
  }));
  return map;
}
export function loadSheets(): Promise<void[]> {
  const files = [...new Set(CATALOG.sprites.map((s) => s.file))];
  return Promise.all(files.map((f) => new Promise<void>((res) => {
    const img = new Image();
    img.onload = () => res(); img.onerror = () => res();
    img.src = "/assets/" + encodeURI(CATALOG.root + f);
    images.set(f, img);
  })));
}
function sheet(file: string) { return imageProvider(file); }
function imgW(img: AnyImage): number { return (img as HTMLImageElement).naturalWidth || img.width; }
function imgH(img: AnyImage): number { return (img as HTMLImageElement).naturalHeight || img.height; }

export function drawSprite(ctx: CanvasRenderingContext2D, id: string, px: number, pyBottom: number, tick: number, opts?: { anim?: string; frame?: number; facing?: string; moving?: boolean; offset?: { x: number; y: number } }) {
  const e = catalogGet(id); if (!e) return;
  const img = sheet(e.file); if (!img || imgW(img) === 0) return;
  const ox = (e.offset?.x ?? 0) + (opts?.offset?.x ?? 0), oy = (e.offset?.y ?? 0) + (opts?.offset?.y ?? 0);
  // Player: columns are directions, rows are animation frames.
  if (e.dirs) {
    const col = Math.max(0, e.dirs.indexOf((opts?.facing ?? "down") as Dir));
    let row = 0;
    if (opts?.moving) { const range = e.anims?.walk?.rows ?? [0, 3]; const span = range[1] - range[0] + 1; row = range[0] + Math.floor(tick / 6) % span; }
    ctx.drawImage(img as CanvasImageSource, col * 16, row * 16, 16, 16, px + ox, pyBottom - 16 + oy, 16, 16);
    return;
  }
  let sx = e.x ?? 0, sy = e.y ?? 0, sw = e.w ?? imgW(img), sh = e.h ?? imgH(img);
  if (e.frameW) {
    sw = e.frameW; sh = e.frameH ?? imgH(img);
    let frame = opts?.frame ?? 0;
    const animName = opts?.anim;
    if (animName && e.anims?.[animName]) {
      const a = e.anims[animName]; const from = a.from ?? 0, to = a.to ?? from; const fps = a.fps ?? 8;
      const span = to - from + 1; frame = from + (a.loop === false ? Math.min(span - 1, Math.floor(tick / Math.max(1, Math.round(60 / fps)))) : Math.floor(tick / Math.max(1, Math.round(60 / fps))) % span);
    } else if (e.pieces) frame = opts?.frame ?? 0;
    else if (e.frames) frame = Math.floor(tick / 8) % e.frames;
    sx = (e.x ?? 0) + frame * e.frameW; sy = e.y ?? 0;
  }
  ctx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, px + ox, pyBottom - sh + oy, sw, sh);
}
function drawFixedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, cellW = 5) {
  for (let i = 0; i < text.length; i++) ctx.fillText(text[i], x + i * cellW, y);
}
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lightingAt(hour: number): { color: string; alpha: number } {
  // Blend between phase keyframes by hour.
  const stops: [number, string][] = [[0, "night"], [5, "night"], [6, "dawn"], [7, "day"], [17, "day"], [18.5, "dusk"], [20, "night"], [24, "night"]];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (hour >= stops[i][0] && hour <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const t = b[0] === a[0] ? 0 : (hour - a[0]) / (b[0] - a[0]);
  const la = TUNING.lighting[a[1]], lb = TUNING.lighting[b[1]];
  const ca = hexRgb(la.color), cb = hexRgb(lb.color);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return { color: `rgb(${c[0]},${c[1]},${c[2]})`, alpha: la.alpha + (lb.alpha - la.alpha) * t };
}

/** Render-time tile position of an entity (slides between tiles over slideTicks). */
export function renderPos(rec: EntRec): { x: number; y: number } | null {
  if (!rec.pos) return null;
  if (rec.slideFrom && rec.slideT > 0) { const k = 1 - rec.slideT / TUNING.slideTicks; return { x: rec.slideFrom.x + (rec.pos.x - rec.slideFrom.x) * k, y: rec.slideFrom.y + (rec.pos.y - rec.slideFrom.y) * k }; }
  return rec.pos;
}

/** The entities the renderer draws: those with a sprite in an area (the player's current one by default). */
export function drawnEntities(eng: Engine, area: string = eng.currentArea()): EntRec[] {
  return [...eng.entities.values()].filter((r) => r.pos && r.pos.area === area && r.comps.has("sprite"));
}

export function render(ctx: CanvasRenderingContext2D, eng: Engine) {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, NATIVE_W, NATIVE_H);
  const tick = eng.tickCount;
  const area = eng.currentArea();
  drawArea(ctx, eng, area);
  // Particles / float text
  for (const p of eng.particles) if (p.area === area) drawSprite(ctx, p.sprite, Math.round(p.x * 16), Math.round((p.y + 1) * 16), tick, { frame: p.frame });
  for (const f of eng.floats) {
    if (f.area !== area) continue;
    ctx.font = "8px monospace"; ctx.fillStyle = f.color; ctx.globalAlpha = 1 - f.life / f.maxLife;
    drawFixedText(ctx, f.text, Math.round(f.x * 16), Math.round(f.y * 16), 5); ctx.globalAlpha = 1;
  }
  // Lighting: darkness with soft holes for lights
  const light = lightingAt(eng.hour);
  if (light.alpha > 0.01) {
    const lit = [...eng.entities.values()].filter((r) => r.pos && r.pos.area === area && r.comps.has("light"));
    const dark = canvasFactory(NATIVE_W, MAP_PX_H) as HTMLCanvasElement;
    const dctx = dark.getContext("2d")!;
    dctx.fillStyle = light.color; dctx.globalAlpha = light.alpha; dctx.fillRect(0, 0, NATIVE_W, MAP_PX_H);
    dctx.globalCompositeOperation = "destination-out"; dctx.globalAlpha = 1;
    for (const r of lit) {
      const l = r.comps.get("light") as LightComp;
      const rp = renderPos(r)!; const cx = rp.x * 16 + 8, cy = rp.y * 16 + 8;
      const flick = l.flicker ? Math.sin(tick * 0.3 + r.id) * 3 * l.flicker : 0;
      const g = dctx.createRadialGradient(cx, cy, 2, cx, cy, Math.max(4, l.radius + flick));
      g.addColorStop(0, `rgba(0,0,0,${Math.min(1, l.strength)})`); g.addColorStop(1, "rgba(0,0,0,0)");
      dctx.fillStyle = g; dctx.beginPath(); dctx.arc(cx, cy, Math.max(4, l.radius + flick), 0, Math.PI * 2); dctx.fill();
    }
    ctx.drawImage(dark, 0, 0);
    // Warm tint inside glows (additive, subtle)
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (const r of lit) {
      const l = r.comps.get("light") as LightComp; const rp = renderPos(r)!;
      const g = ctx.createRadialGradient(rp.x * 16 + 8, rp.y * 16 + 8, 2, rp.x * 16 + 8, rp.y * 16 + 8, l.radius);
      g.addColorStop(0, "rgba(255,180,90,0.10)"); g.addColorStop(1, "rgba(255,180,90,0)");
      ctx.fillStyle = g; ctx.fillRect(rp.x * 16 + 8 - l.radius, rp.y * 16 + 8 - l.radius, l.radius * 2, l.radius * 2);
    }
    ctx.restore();
  }
  // Screen tint
  if (eng.tint) { ctx.globalAlpha = eng.tint.alpha * (1 - eng.tint.t / eng.tint.max); ctx.fillStyle = eng.tint.color; ctx.fillRect(0, 0, NATIVE_W, MAP_PX_H); ctx.globalAlpha = 1; }
  // E prompt, then the overlay panel
  drawPrompt(ctx, eng);
  drawOverlay(ctx, eng);
  // Banner
  if (eng.banner) { ctx.globalAlpha = Math.min(1, eng.banner.t / 30); ctx.fillStyle = "rgba(20,24,14,0.75)"; ctx.fillRect(0, 6, NATIVE_W, 14); ctx.font = "8px monospace"; ctx.fillStyle = "#f2ecd0"; ctx.textAlign = "center"; drawFixedText(ctx, eng.banner.text, NATIVE_W / 2 - (eng.banner.text.length * 5) / 2, 16, 5); ctx.textAlign = "left"; ctx.globalAlpha = 1; }
  renderHud(ctx, eng);
}

/**
 * Terrain, entities (by layer, then y, then z) and the held item of one area at 16 px per tile.
 * No effects, lighting or HUD. `settled` draws each entity on its tile, not part way through a slide.
 */
export function drawArea(ctx: CanvasRenderingContext2D, eng: Engine, area: string, settled = false) {
  ctx.imageSmoothingEnabled = false;
  const tick = eng.tickCount;
  const tiles = eng.areas.get(area)?.tiles;
  // Terrain
  if (tiles) for (let y = 0; y < eng.height; y++) for (let x = 0; x < eng.width; x++) drawSprite(ctx, tiles[y][x], x * 16, (y + 1) * 16, tick);
  // Entities with a sprite, by layer, then y, then z
  const recs = drawnEntities(eng, area);
  const spr = (r: EntRec) => r.comps.get("sprite") as SpriteComp;
  const order = (l: string) => (l === "ground" ? 0 : l === "object" ? 1 : l === "above" ? 2 : 3);
  const layerOf = (r: EntRec) => order(catalogGet(spr(r).id)?.layer ?? "object");
  const at = (r: EntRec) => (settled ? r.pos : renderPos(r));
  const sorted = recs.sort((a, b) => {
    const d = layerOf(a) - layerOf(b); if (d) return d;
    const rpA = at(a)!, rpB = at(b)!;
    if (rpA.y !== rpB.y) return rpA.y - rpB.y;
    return (spr(a).z ?? 0) - (spr(b).z ?? 0);
  });
  let playerRec: EntRec | undefined;
  for (const r of sorted) {
    if (r.tags.has("player")) playerRec = r;
    const rp = at(r)!; const s = spr(r);
    const facing = r.comps.get("facing") as string | undefined;
    const t = s.anim ? tick - (eng.animStart.get(r.id) ?? 0) : tick;
    drawSprite(ctx, s.id, Math.round(rp.x * 16), Math.round((rp.y + 1) * 16), t, { anim: s.anim, frame: s.frame, facing, moving: !!r.slideFrom && r.slideT > 0, offset: s.offset });
  }
  // Held item above the player
  const held = playerRec?.comps.get("held") as { id: number } | undefined;
  if (playerRec && held) {
    const item = eng.rec(held.id); const rp = at(playerRec)!;
    const s = item?.comps.get("sprite") as SpriteComp | undefined;
    if (s) drawSprite(ctx, s.id, Math.round(rp.x * 16), Math.round((rp.y + 1) * 16) - TUNING.heldLiftPx, tick);
  }
}

const TEXT_CELL = 5;
/** The one-line E prompt, centred above the target tile, kept on the map. */
function drawPrompt(ctx: CanvasRenderingContext2D, eng: Engine) {
  const p = eng.prompt; if (!p || p.area !== eng.currentArea()) return;
  const w = p.text.length * TEXT_CELL + 8, h = 11;
  const x = Math.max(1, Math.min(NATIVE_W - w - 1, Math.round(p.x * 16 + 8 - w / 2)));
  let y = p.y * 16 - h - 3; if (y < 1) y = (p.y + 1) * 16 + 3; // no room above: draw below the tile
  ctx.fillStyle = "rgba(20,24,14,0.82)"; ctx.fillRect(x, y, w, h);
  ctx.font = "8px monospace"; ctx.fillStyle = "#f2ecd0";
  drawFixedText(ctx, p.text, x + 4, y + 8, TEXT_CELL);
}
/** The plain ui.overlay panel at the bottom of the map (the final layout waits on the asset review). */
function drawOverlay(ctx: CanvasRenderingContext2D, eng: Engine) {
  const o = eng.overlay?.value; if (!o) return;
  const lines = o.lines; const h = 8 + (o.title ? 11 : 0) + lines.length * 10 + (o.bar ? 12 : 0);
  const x = 8, w = NATIVE_W - 16, top = MAP_PX_H - h - 6;
  ctx.fillStyle = "rgba(20,24,14,0.88)"; ctx.fillRect(x, top, w, h);
  ctx.fillStyle = "#5a6b42"; ctx.fillRect(x, top, w, 1);
  ctx.font = "8px monospace"; let y = top + 11;
  if (o.title) { ctx.fillStyle = "#cdbf8a"; drawFixedText(ctx, o.title, x + 6, y, TEXT_CELL); y += 11; }
  ctx.fillStyle = "#f2ecd0";
  for (const line of lines) { drawFixedText(ctx, line, x + 6, y, TEXT_CELL); y += 10; }
  if (o.bar) {
    const bw = w - 12 - (o.bar.label ? o.bar.label.length * TEXT_CELL + 6 : 0);
    ctx.fillStyle = "#3a4a24"; ctx.fillRect(x + 6, y - 6, bw, 6);
    ctx.fillStyle = "#cdbf8a"; ctx.fillRect(x + 6, y - 6, bw * Math.max(0, Math.min(1, o.bar.value)), 6);
    if (o.bar.label) { ctx.fillStyle = "#f2ecd0"; drawFixedText(ctx, o.bar.label, x + 12 + bw, y, TEXT_CELL); }
  }
}

function renderHud(ctx: CanvasRenderingContext2D, eng: Engine) {
  const y0 = MAP_PX_H; ctx.fillStyle = "#202812"; ctx.fillRect(0, y0, NATIVE_W, HUD_H);
  ctx.fillStyle = "#3a4a24"; ctx.fillRect(0, y0, NATIVE_W, 1);
  ctx.font = "8px monospace"; ctx.textBaseline = "alphabetic";
  // Clock in 10-minute steps, fixed-width digit cells, reserved slots.
  const totalMin = Math.floor(eng.hour * 60 / 10) * 10; const h24 = Math.floor(totalMin / 60), m = totalMin % 60;
  const ampm = h24 >= 12 ? "PM" : "AM"; const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const clock = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  ctx.fillStyle = "#f2ecd0"; drawFixedText(ctx, clock.padEnd(8, " "), 6, y0 + 12, 5);
  const phaseNames: Record<string, string> = { dawn: "Dawn", day: "Day", dusk: "Dusk", night: "Night" };
  let label = phaseNames[phaseAt(eng.hour)];
  if (eng.timeSpeed !== 1) label += ` ${eng.timeSpeed}x`;
  drawFixedText(ctx, label.padEnd(10, " "), 52, y0 + 12, 5);
  ctx.fillStyle = "#cdbf8a"; drawFixedText(ctx, `Day ${eng.day}`.padEnd(7, " "), 108, y0 + 12, 5);
  // Day bar: phases shaded, marker for now. Reserved fixed rect.
  const bx = 150, bw = 110, by = y0 + 6, bh = 6;
  const segs: [string, number, number][] = [["#060d2a", 0, 5], ["#d9a066", 5, 7], ["#7ec850", 7, 17], ["#e07b2a", 17, 20], ["#060d2a", 20, 24]];
  for (const [c, a, b] of segs) { ctx.fillStyle = c; ctx.fillRect(bx + (a / 24) * bw, by, ((b - a) / 24) * bw, bh); }
  ctx.fillStyle = "#fff"; ctx.fillRect(bx + (eng.hour / 24) * bw - 0.5, by - 2, 1.5, bh + 4);
  // Right side: system HUD slots, each with reserved width.
  let rx = NATIVE_W - 6;
  ctx.fillStyle = "#f2ecd0";
  for (const slot of [...eng.hudSlots.values()].reverse()) {
    rx -= slot.width * 5;
    drawFixedText(ctx, slot.text.slice(0, slot.width).padEnd(slot.width, " "), rx, y0 + 12, 5);
    if (slot.icon) { rx -= 18; drawSprite(ctx, slot.icon, rx, y0 + 20, eng.tickCount); }
    rx -= 8;
  }
}

/** Dev sprites tab: every catalog sprite at 4x on grass with tile outline; anims play. */
export function renderSpritesTab(ctx: CanvasRenderingContext2D, tick: number) {
  const sprites = CATALOG.sprites; const cols = 3, cellW = 264, cellH = 224;
  const rows = Math.ceil(sprites.length / cols);
  if (ctx.canvas.width !== cols * cellW) ctx.canvas.width = cols * cellW;
  if (ctx.canvas.height !== rows * cellH) ctx.canvas.height = rows * cellH;
  ctx.imageSmoothingEnabled = false; ctx.fillStyle = "#2a331e"; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  sprites.forEach((s, i) => {
    const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
    const ax = cx + 16, ay = cy + 188; // bottom-left anchor: sprite draws upward from here at 4x
    ctx.save(); ctx.translate(ax, ay); ctx.scale(4, 4); ctx.translate(-ax, -ay);
    drawSprite(ctx, "grass", ax, ay, tick);
    drawSprite(ctx, s.id, ax, ay, tick, { anim: s.anims ? Object.keys(s.anims)[0] : undefined });
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.strokeRect(ax, ay - 64, 64, 64);
    ctx.font = "10px monospace"; ctx.fillStyle = "#e8e4c8"; ctx.fillText(s.id, cx + 8, cy + 208);
  });
}
