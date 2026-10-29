import catalogData from '../catalog.json';
import {
  FLOAT_TEXT_TICKS,
  HUD_BAR_HEIGHT,
  HUD_BG,
  HUD_FONT_PX,
  HUD_PHASE_COLORS,
  HUD_TEXT,
  PARTICLE_TICKS,
  PHASE_DARKNESS,
  PHASES,
  SLIDE_MS,
  TICKS_PER_SECOND,
} from '../tuning';
import type { CatalogEntry, Dir, Entity, LightComp, Phase, SpriteComp, World } from './api';
import { internals } from './world';

// Plain Canvas 2D renderer: native-res canvas scaled up, y-sorted entities,
// catalog anims/dirs/poses, slide on non-instant moves, phase lighting with
// warm light glows, and a HUD bar below the map.

export const TILE = 16;
const SPRITES = (catalogData as unknown as { sprites: CatalogEntry[] }).sprites;
const BY_ID = new Map(SPRITES.map((s) => [s.id, s]));
const LAYER_ORDER = { ground: 0, object: 1, above: 2, overlay: 3 } as const;
const SLIDE_TICKS = Math.max(1, Math.round((SLIDE_MS / 1000) * TICKS_PER_SECOND));
const PHASE_NAMES: Record<Phase, string> = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };

const ASSET_ROOT = 'assets/Ninja Adventure - Asset Pack/';

/** Stardew-style clock in 10-minute steps: 19.66 -> "7:30 PM". Widest value is 8 chars. */
export function formatClock(hour: number): string {
  const totalMin = Math.floor((hour * 60) / 10) * 10;
  const h24 = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "#rrggbb" + alpha -> "rgba(...)". */
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private images = new Map<string, HTMLImageElement>();
  private raf = 0;
  private running = false;
  private fontFamily = 'monospace';
  private lightLayer: HTMLCanvasElement | null = null;

  private canvas: HTMLCanvasElement;
  private world: World;
  constructor(canvas: HTMLCanvasElement, world: World) {
    this.canvas = canvas;
    this.world = world;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
  }

  /** Load every sheet once, plus the pack pixel font when the pack ships it. */
  async load(): Promise<void> {
    const files = [...new Set(SPRITES.map((s) => s.file))];
    const base = import.meta.env.BASE_URL || '/';
    const failures: string[] = [];
    await Promise.all(
      files.map(
        (file) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images.set(file, img);
              resolve();
            };
            img.onerror = () => {
              failures.push(file);
              resolve();
            };
            img.src = encodeURI(`${base}${ASSET_ROOT}${file}`);
          }),
      ),
    );
    if (failures.length > 0) throw new Error(`missing art files: ${failures.join(', ')}.`);
    // The pack's pixel font; falls back to monospace when missing (it is, today).
    try {
      const face = new FontFace(
        'AllTheWorldPixel',
        `url("${encodeURI(`${base}${ASSET_ROOT}Ui/Font/NormalFont.ttf`)}")`,
      );
      await face.load();
      document.fonts.add(face);
      this.fontFamily = '"AllTheWorldPixel", monospace';
    } catch {
      this.fontFamily = 'monospace';
    }
  }

  /** One loaded sheet image, for engine-side readers like the dev panel. */
  imageFor(file: string): HTMLImageElement | undefined {
    return this.images.get(file);
  }

  /** Fit the whole map plus the HUD bar at the largest whole-number scale; call on resize. */
  resize(): void {
    const { w, h } = internals(this.world).mapSize();
    const cw = w * TILE;
    const ch = h * TILE + HUD_BAR_HEIGHT;
    this.canvas.width = cw;
    this.canvas.height = ch;
    const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / cw, window.innerHeight / ch)));
    this.canvas.style.width = `${cw * scale}px`;
    this.canvas.style.height = `${ch * scale}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  frame(): void {
    const inner = internals(this.world);
    const { w, h } = inner.mapSize();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w * TILE, h * TILE + HUD_BAR_HEIGHT);

    // Terrain.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const entry = BY_ID.get(this.world.tiles.get(x, y)!);
        if (entry) this.drawSprite(entry, { id: entry.id }, x, y, 'down', false);
      }
    }

    // Entities with a sprite, sorted by layer, then y, then z.
    const list = inner
      .allEntities()
      .filter((e) => e.pos && e.get<SpriteComp>('sprite'))
      .map((e) => {
        const sprite = e.get<SpriteComp>('sprite')!;
        const layer = LAYER_ORDER[BY_ID.get(sprite.id)?.layer ?? 'object'];
        return { e, sprite, layer, y: e.pos!.y, z: sprite.z ?? 0 };
      })
      .sort((a, b) => a.layer - b.layer || a.y - b.y || a.z - b.z);
    for (const { e, sprite } of list) {
      const entry = BY_ID.get(sprite.id);
      if (!entry) continue;
      const { x, y, sliding } = this.renderPos(e);
      const facing = (e.get('facing') as Dir | undefined) ?? 'down';
      this.drawSprite(entry, sprite, x, y, facing, sliding);
    }

    // The held item floats above the player (carry lifts it off the map).
    const player = this.world.query('player')[0];
    const heldId = (player?.get('held') as { id: number } | undefined)?.id;
    if (player?.pos && heldId != null) {
      const held = inner.allEntities().find((e) => e.id === heldId);
      const sprite = held?.get<SpriteComp>('sprite');
      const entry = sprite && BY_ID.get(sprite.id);
      if (entry && sprite) {
        const img = this.images.get(entry.file);
        const { sw, sh } = this.sourceSize(entry, img);
        const rect = this.sourceRect(entry, sprite, 'down', false, sw, sh);
        if (img && rect) {
          const dx = Math.round(player.pos.x * TILE + (TILE - rect.w) / 2);
          const dy = Math.round(player.pos.y * TILE - rect.h - 2);
          ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, dx, dy, rect.w, rect.h);
        }
      }
    }

    this.drawParticles();
    this.drawLighting();
    this.drawTexts();
    this.drawTint();
    this.drawBanner();
    this.drawHud();
  }

  /** Tile-space position with slide/tween interpolation. */
  private renderPos(e: Entity): { x: number; y: number; sliding: boolean } {
    const inner = internals(this.world);
    const p = e.pos!;
    const tween = inner.tweens.get(e.id);
    if (tween && tween.total > 0) {
      const k = 1 - tween.left / tween.total;
      return { x: tween.fx + (tween.tx - tween.fx) * k, y: tween.fy + (tween.ty - tween.fy) * k, sliding: true };
    }
    const slide = inner.slides.get(e.id);
    if (slide) {
      const k = Math.min(1, (this.world.ticks - slide.t0) / SLIDE_TICKS);
      if (k >= 1) inner.slides.delete(e.id);
      return { x: slide.fx + (p.x - slide.fx) * k, y: slide.fy + (p.y - slide.fy) * k, sliding: k < 1 };
    }
    return { x: p.x, y: p.y, sliding: false };
  }

  private sourceSize(entry: CatalogEntry, img: HTMLImageElement | undefined): { sw: number; sh: number } {
    const sw = entry.frameW ?? entry.w ?? img?.naturalWidth ?? TILE;
    const sh = entry.frameH ?? entry.h ?? img?.naturalHeight ?? TILE;
    return { sw, sh };
  }

  /** Source rect for a sprite comp: dirs columns, anim rows/ranges, poses, pieces. */
  private sourceRect(
    entry: CatalogEntry,
    sprite: SpriteComp,
    facing: Dir,
    sliding: boolean,
    sw: number,
    sh: number,
  ): { x: number; y: number; w: number; h: number } | null {
    const anim = sprite.anim ?? (sliding ? 'walk' : 'idle');
    // Directional sheets (the player): columns are directions, anims are row ranges.
    if (entry.dirs) {
      const col = Math.max(0, entry.dirs.indexOf(facing));
      const pose = entry.poses?.[anim];
      if (pose) return { x: pose[0] * sw, y: pose[1] * sh, w: sw, h: sh };
      const range = entry.anims?.[anim]?.rows ?? entry.anims?.idle?.rows ?? [0, 0];
      const fps = entry.anims?.[anim]?.fps ?? 6;
      const span = range[1] - range[0] + 1;
      const frame = sprite.frame ?? Math.floor(this.world.ticks / (TICKS_PER_SECOND / fps)) % span;
      return { x: col * sw, y: (range[0] + (frame % span)) * sh, w: sw, h: sh };
    }
    // Horizontal strips: named frame ranges; pieces pick one frame, never animate.
    if (entry.frames) {
      const range = entry.anims?.[anim] ?? { from: 0, to: entry.frames - 1 };
      if (entry.pieces) {
        const f = sprite.frame ?? range.from ?? 0;
        return { x: (entry.x ?? 0) + f * sw, y: entry.y ?? 0, w: sw, h: sh };
      }
      const from = range.from ?? 0;
      const to = range.to ?? entry.frames - 1;
      const fps = range.fps ?? 8;
      const span = to - from + 1;
      const f = sprite.frame ?? (range.loop === false
        ? Math.min(to, from + Math.floor(this.world.ticks / (TICKS_PER_SECOND / fps)))
        : from + (Math.floor(this.world.ticks / (TICKS_PER_SECOND / fps)) % span));
      return { x: (entry.x ?? 0) + f * sw, y: entry.y ?? 0, w: sw, h: sh };
    }
    // Static sprite (whole file when x/y/w/h are absent).
    if (entry.x == null || entry.y == null) return { x: 0, y: 0, w: sw, h: sh };
    return { x: entry.x, y: entry.y, w: entry.w ?? sw, h: entry.h ?? sh };
  }

  /** Draw anchored at the bottom-left tile, nudged by catalog offset. */
  private drawSprite(entry: CatalogEntry, sprite: SpriteComp, x: number, y: number, facing: Dir, sliding: boolean): void {
    const img = this.images.get(entry.file);
    if (!img) return;
    const { sw, sh } = this.sourceSize(entry, img);
    const rect = this.sourceRect(entry, sprite, facing, sliding, sw, sh);
    if (!rect) return;
    const dx = Math.round(x * TILE + (entry.offset?.x ?? 0));
    const dy = Math.round((y + 1) * TILE - rect.h + (entry.offset?.y ?? 0));
    this.ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, dx, dy, rect.w, rect.h);
  }

  private drawParticles(): void {
    const inner = internals(this.world);
    const ctx = this.ctx;
    for (const p of inner.particles) {
      const entry = BY_ID.get(p.sprite);
      const img = entry && this.images.get(entry.file);
      if (!entry || !img) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.ttl / PARTICLE_TICKS));
      const { sw, sh } = this.sourceSize(entry, img);
      const rect = this.sourceRect(entry, { id: p.sprite }, 'down', false, sw, sh);
      if (rect) ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, p.x * TILE, p.y * TILE, rect.w, rect.h);
      ctx.globalAlpha = 1;
    }
  }

  /** Every entity glow on the map: pixel center, radius, color, strength. */
  private lights(): Array<{ x: number; y: number; r: number; color: string; strength: number }> {
    const out: Array<{ x: number; y: number; r: number; color: string; strength: number }> = [];
    for (const e of this.world.query('light')) {
      const pos = e.pos;
      const light = e.get('light') as LightComp | undefined;
      if (!pos || !light || !(light.radius > 0) || !(light.strength > 0)) continue;
      // Deterministic shimmer from the tick counter; never touches the sim RNG.
      const flicker = light.flicker ?? 0;
      const wobble = 1 + flicker * 0.1 * Math.sin(this.world.ticks * 0.35 + e.id * 1.7);
      out.push({
        x: (pos.x + 0.5) * TILE,
        y: (pos.y + 0.5) * TILE,
        r: Math.max(1, light.radius * TILE * wobble),
        color: light.color,
        strength: Math.max(0, Math.min(1, light.strength)),
      });
    }
    return out;
  }

  /** The phase darkness over the whole map, with a soft warm hole per light. */
  private drawLighting(): void {
    const inner = internals(this.world);
    const { w, h } = inner.mapSize();
    const dark = PHASE_DARKNESS[this.world.time.phase];
    if (dark.alpha <= 0) return; // full daylight: nothing to darken, no glow to draw
    if (!this.lightLayer) this.lightLayer = document.createElement('canvas');
    const layer = this.lightLayer;
    if (layer.width !== w * TILE || layer.height !== h * TILE) {
      layer.width = w * TILE;
      layer.height = h * TILE;
    }
    const lctx = layer.getContext('2d');
    if (!lctx) return;
    lctx.globalCompositeOperation = 'source-over';
    lctx.globalAlpha = 1;
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.fillStyle = withAlpha(dark.color, dark.alpha);
    lctx.fillRect(0, 0, layer.width, layer.height);
    // Each light erases a soft hole; overlapping holes erase deeper, like added light.
    const lights = this.lights();
    lctx.globalCompositeOperation = 'destination-out';
    for (const { x, y, r, strength } of lights) {
      const g = lctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.55})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(x, y, r, 0, Math.PI * 2);
      lctx.fill();
    }
    this.ctx.drawImage(layer, 0, 0);
    // A faint warm tint over each glow so light reads as warm, not just less dark.
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const { x, y, r, color, strength } of lights) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, withAlpha(color, 0.22 * strength));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTexts(): void {
    const inner = internals(this.world);
    const ctx = this.ctx;
    ctx.font = `${HUD_FONT_PX}px ${this.fontFamily}`;
    ctx.textAlign = 'center';
    for (const t of inner.texts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, t.ttl / FLOAT_TEXT_TICKS));
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x * TILE + TILE / 2, t.y * TILE - (FLOAT_TEXT_TICKS - t.ttl) * 0.15);
      ctx.globalAlpha = 1;
    }
  }

  private drawTint(): void {
    const inner = internals(this.world);
    if (!inner.tintState) return;
    const t = inner.tintState;
    const ctx = this.ctx;
    ctx.globalAlpha = t.alpha * (t.left / t.total);
    ctx.fillStyle = t.color;
    const { w, h } = inner.mapSize();
    ctx.fillRect(0, 0, w * TILE, h * TILE);
    ctx.globalAlpha = 1;
  }

  private drawBanner(): void {
    const inner = internals(this.world);
    if (!inner.bannerState) return;
    const { w } = inner.mapSize();
    const b = inner.bannerState;
    const ctx = this.ctx;
    ctx.globalAlpha = Math.max(0, Math.min(1, b.ttl / 30));
    ctx.font = `${HUD_FONT_PX}px ${this.fontFamily}`;
    const tw = ctx.measureText(b.text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect((w * TILE) / 2 - tw / 2 - 4, 4, tw + 8, 14);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(b.text, (w * TILE) / 2, 14);
    ctx.globalAlpha = 1;
  }

  /** Fixed-width cell for one char: digits vary in the pixel font, cells don't. */
  private cellW(): number {
    const ctx = this.ctx;
    let wide = 0;
    for (const d of '0123456789') wide = Math.max(wide, ctx.measureText(d).width);
    return Math.ceil(wide) + 1;
  }

  /** Draws text char-by-char in fixed cells, left-anchored at x; returns the slot end. */
  private drawCells(text: string, x: number, y: number, cells: number, cellW: number): number {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    const chars = [...text].slice(0, cells);
    for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i], x + i * cellW, y);
    return x + cells * cellW;
  }

  /** The bar below the map: clock, phase (+speed), day bar left; system slots right. */
  private drawHud(): void {
    const inner = internals(this.world);
    const { w, h } = inner.mapSize();
    const ctx = this.ctx;
    const y0 = h * TILE;
    const cy = y0 + HUD_BAR_HEIGHT / 2 + 0.5;
    ctx.fillStyle = HUD_BG;
    ctx.fillRect(0, y0, w * TILE, HUD_BAR_HEIGHT);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = HUD_TEXT;
    ctx.fillRect(0, y0, w * TILE, 1);
    ctx.globalAlpha = 1;
    ctx.font = `${HUD_FONT_PX}px ${this.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HUD_TEXT;

    const cw = this.cellW();
    let x = 4;
    // Clock in 10-minute steps; the slot fits the widest value ("12:00 PM").
    x = this.drawCells(formatClock(this.world.time.hour), x, cy, 8, cw) + 8;
    // Phase name, with the time speed beside it when it isn't 1x; the speed
    // slot stays reserved so showing it never shifts what follows.
    const speed = internals(this.world).systemState('daynight')?.speed;
    const speedText = typeof speed === 'number' && speed !== 1 ? ` ${speed}x` : '';
    x = this.drawCells(`${PHASE_NAMES[this.world.time.phase]}${speedText}`, x, cy, 9, cw) + 8;
    // Day bar: each phase in its own color, with a marker for now.
    const bw = 72;
    const bh = 8;
    const bx = x;
    const by = cy - bh / 2;
    const spans = [
      { from: 0, to: PHASES.dawn.start, color: HUD_PHASE_COLORS.night },
      { from: PHASES.dawn.start, to: PHASES.dawn.end, color: HUD_PHASE_COLORS.dawn },
      { from: PHASES.day.start, to: PHASES.day.end, color: HUD_PHASE_COLORS.day },
      { from: PHASES.dusk.start, to: PHASES.dusk.end, color: HUD_PHASE_COLORS.dusk },
      { from: PHASES.dusk.end, to: 24, color: HUD_PHASE_COLORS.night },
    ];
    for (const s of spans) {
      ctx.fillStyle = s.color;
      ctx.fillRect(bx + (s.from / 24) * bw, by, ((s.to - s.from) / 24) * bw + 0.5, bh);
    }
    ctx.strokeStyle = HUD_TEXT;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + (this.world.time.hour / 24) * bw - 1, by - 1, 2, bh + 2);

    // System slots pack the right side; each reserves width chars for its text.
    const slots = [...inner.hud.values()];
    const gap = 8;
    const widths = slots.map((s) => (s.icon ? 15 : 0) + Math.max(0, s.width) * cw);
    let sx = w * TILE - 4 - widths.reduce((a, b) => a + b, 0) - gap * Math.max(0, slots.length - 1);
    ctx.fillStyle = HUD_TEXT;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.icon) {
        const entry = BY_ID.get(slot.icon);
        const img = entry && this.images.get(entry.file);
        if (entry && img) {
          const { sw, sh } = this.sourceSize(entry, img);
          const rect = this.sourceRect(entry, { id: slot.icon }, 'down', false, sw, sh);
          if (rect) ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, sx, cy - 6, 12, 12);
        }
        sx += 15;
      }
      sx = this.drawCells(slot.text, sx, cy, Math.max(0, slot.width), cw) + gap;
    }
  }
}
