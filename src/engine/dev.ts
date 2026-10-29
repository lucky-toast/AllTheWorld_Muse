// Dev tools: T cycles the time speed, Shift+R reloads all systems without
// losing the world, and Backtick opens a dev panel whose first tab shows
// every catalog sprite. All dev hotkeys preventDefault, like the game keys.
import type { CatalogEntry, SystemDef, World } from './api';
import { CATALOG, getSprite } from './catalog';
import { internals } from './world';

/** Time speeds the T key cycles through. */
export const TIME_SPEEDS = [1, 4, 16] as const;

/** Next speed in the 1x -> 4x -> 16x cycle (unknown speeds restart at 1x). */
export function nextSpeed(current: unknown): number {
  const i = (TIME_SPEEDS as readonly unknown[]).indexOf(current);
  return TIME_SPEEDS[(i + 1) % TIME_SPEEDS.length] ?? 1;
}

/** Cycles daynight's speed; returns the new speed (1 when daynight is absent). */
export function cycleTimeSpeed(world: World): number {
  const st = internals(world).systemState('daynight');
  const next = nextSpeed(st?.speed);
  if (st) st.speed = next;
  return next;
}

/** Unloads every loaded system, then loads defs in order; state survives. */
export function reloadAllSystems(world: World, defs: readonly SystemDef[]): void {
  for (const id of [...world.systems]) world.unloadSystem(id);
  for (const def of defs) world.loadSystem(def);
}

/** Minimal key-event surface for dev hotkeys; works with the DOM and doubles. */
export interface DevKeyEvent {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  preventDefault(): void;
}

/** Minimal event-target surface; works with window and with test doubles. */
export interface DevKeyTarget {
  addEventListener(type: string, fn: (e: DevKeyEvent) => void): void;
  removeEventListener(type: string, fn: (e: DevKeyEvent) => void): void;
}

/** What the dev hotkeys do; wired up in main.ts. */
export interface DevActions {
  cycleSpeed(): void;
  reload(): void;
  togglePanel(): void;
  /** Closes the panel; returns true when it was open (Escape only then). */
  closePanel(): boolean;
}

/** Dev hotkeys: T cycles speed, Shift+R reloads systems, Backtick toggles. */
export class DevKeys {
  private target: DevKeyTarget | null = null;
  private onKeyDown = (e: DevKeyEvent): void => {
    if (e.key === '`' || e.key === 'Backquote') {
      e.preventDefault();
      if (!e.ctrlKey && !e.metaKey) this.actions.togglePanel();
      return;
    }
    if (e.key === 'Escape') {
      if (this.actions.closePanel()) e.preventDefault();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      const lower = e.key.toLowerCase();
      if (lower === 't' && !e.shiftKey) {
        e.preventDefault();
        this.actions.cycleSpeed();
      } else if (lower === 'r' && e.shiftKey) {
        e.preventDefault();
        this.actions.reload();
      }
    }
  };

  constructor(private actions: DevActions) {}

  /** Starts listening on a target (window in play). */
  attach(target: DevKeyTarget): void {
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
  }

  /** Stops listening. */
  detach(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target = null;
    }
  }
}

/** One sprites-tab cell: a catalog sprite plus the anim names to cycle. */
export interface SpriteCell {
  id: string;
  entry: CatalogEntry;
  /** Anim names in cycle order ('static', 'pieces', or 'pose:x' when apt). */
  anims: string[];
}

/** A cell for EVERY catalog sprite, in catalog order. */
export function spriteCells(): SpriteCell[] {
  return CATALOG.map((entry) => {
    let anims: string[];
    if (entry.dirs) {
      anims = [
        ...Object.keys(entry.anims ?? {}),
        ...Object.keys(entry.poses ?? {}).map((p) => `pose:${p}`),
      ];
    } else if (entry.pieces) {
      anims = ['pieces'];
    } else {
      anims = Object.keys(entry.anims ?? {});
    }
    if (anims.length === 0) anims = ['static'];
    return { id: entry.id, entry, anims };
  });
}

/** What the dev panel needs from the outside (images + input swallowing). */
export interface DevPanelOpts {
  /** One loaded sheet image, as in Renderer.imageFor. */
  imageFor(file: string): HTMLImageElement | undefined;
  /** Fired on open/close so the game can swallow input while open. */
  onOpenChange?(open: boolean): void;
}

const ZOOM = 4; // sprites-tab zoom, per spec
const ANIM_MS = 1200; // each named anim plays ~1.2s before the next
const TILE_PX = 16;

/** The dev panel: a DOM overlay whose first tab shows every catalog sprite. */
export class DevPanel {
  private root: HTMLElement | null = null;
  private previews: CellPreview[] = [];
  private raf = 0;
  private _open = false;

  constructor(private opts: DevPanelOpts) {}

  /** True while the panel is open (and swallowing game input). */
  get open(): boolean {
    return this._open;
  }

  /** Opens the panel; a no-op returning false without a DOM (headless). */
  openPanel(): boolean {
    if (this._open) return true;
    if (typeof document === 'undefined') return false;
    this.root = document.createElement('div');
    this.root.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:50;' +
      'display:flex;align-items:center;justify-content:center;';
    const panel = document.createElement('div');
    panel.style.cssText =
      'background:#14100b;border:2px solid #f5eeda;max-width:94vw;max-height:90vh;' +
      'display:flex;flex-direction:column;font-family:monospace;';
    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;padding:8px 8px 0;';
    const tab = document.createElement('div');
    tab.textContent = 'sprites';
    tab.style.cssText =
      'background:#f5eeda;color:#14100b;padding:4px 12px;font-size:12px;';
    tabs.appendChild(tab);
    const grid = document.createElement('div');
    grid.style.cssText =
      'overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,max-content));' +
      'gap:8px;padding:8px;justify-content:start;';
    this.previews = spriteCells().map((cell) => {
      const preview = new CellPreview(cell, this.opts.imageFor);
      grid.appendChild(preview.el);
      return preview;
    });
    const hint = document.createElement('div');
    hint.textContent = '`/Esc closes · T time speed · Shift+R reload systems';
    hint.style.cssText = 'color:#f5eeda;font-size:11px;padding:0 8px 8px;opacity:0.7;';
    panel.appendChild(tabs);
    panel.appendChild(grid);
    panel.appendChild(hint);
    this.root.appendChild(panel);
    document.body.appendChild(this.root);
    this._open = true;
    this.opts.onOpenChange?.(true);
    const tick = () => {
      if (!this._open) return;
      const now = performance.now();
      for (const p of this.previews) p.draw(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return true;
  }

  /** Closes the panel; returns true when it was open. */
  closePanel(): boolean {
    if (!this._open) return false;
    this._open = false;
    cancelAnimationFrame(this.raf);
    this.root?.remove();
    this.root = null;
    this.previews = [];
    this.opts.onOpenChange?.(false);
    return true;
  }

  /** Toggles the panel. */
  toggle(): boolean {
    return this._open ? !this.closePanel() : this.openPanel();
  }
}

/** One sprites-tab card: the sprite at 4x on grass with the tile outline. */
class CellPreview {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private label: HTMLElement;
  private shownAnim = '';

  constructor(
    private cell: SpriteCell,
    private imageFor: (file: string) => HTMLImageElement | undefined,
  ) {
    const doc = document;
    this.el = doc.createElement('div');
    this.el.style.cssText = 'background:#1d1710;padding:4px;';
    this.canvas = doc.createElement('canvas');
    const [cw, ch] = this.canvasSize();
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.canvas.style.cssText = 'image-rendering:pixelated;display:block;';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.label = doc.createElement('div');
    this.label.style.cssText =
      'color:#f5eeda;font-size:11px;margin-top:2px;max-width:220px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;';
    this.label.textContent = cell.id;
    this.el.appendChild(this.canvas);
    this.el.appendChild(this.label);
  }

  /** Canvas size: tile multiples at 4x (dirs: all 4 columns; pieces: the row). */
  private canvasSize(): [number, number] {
    const e = this.cell.entry;
    const img = this.imageFor(e.file);
    if (e.layer === 'overlay') return [240, 180]; // full-screen fx fits a preview
    if (e.dirs) return [4 * TILE_PX * ZOOM, TILE_PX * ZOOM];
    if (e.pieces) {
      const fw = e.frameW ?? TILE_PX;
      const frames = e.frames ?? 1;
      const h = img?.naturalHeight && img.naturalWidth ? img.naturalHeight : TILE_PX;
      return [Math.max(1, frames * fw) * ZOOM, Math.max(1, h) * ZOOM];
    }
    const w = e.frameW ?? e.w ?? (img?.naturalWidth || TILE_PX);
    const h = e.frameH ?? e.h ?? (img?.naturalHeight || TILE_PX);
    const cols = Math.max(1, Math.ceil(w / TILE_PX));
    const rows = Math.max(1, Math.ceil(h / TILE_PX));
    return [cols * TILE_PX * ZOOM, rows * TILE_PX * ZOOM];
  }

  /** Redraws grass, outline, and the current anim frame. */
  draw(now: number): void {
    const { entry } = this.cell;
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.imageSmoothingEnabled = false;
    this.drawGrass(cw, ch);
    const img = this.imageFor(entry.file);
    const anim = this.cell.anims[Math.floor(now / ANIM_MS) % this.cell.anims.length];
    if (anim !== this.shownAnim) {
      this.shownAnim = anim;
      this.label.textContent = `${this.cell.id} — ${anim}`;
    }
    if (!img || !img.naturalWidth) {
      ctx.fillStyle = '#ff5a5a';
      ctx.fillRect(cw / 2 - 2, ch / 2 - 2, 4, 4);
      return;
    }
    if (entry.layer === 'overlay') {
      const k = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    } else if (entry.dirs) {
      this.drawDirs(img, anim, now, cw, ch);
    } else if (entry.pieces) {
      const fw = entry.frameW ?? TILE_PX;
      const frames = entry.frames ?? 1;
      for (let f = 0; f < frames; f++) {
        ctx.drawImage(img, f * fw, 0, fw, img.naturalHeight, f * fw * ZOOM, 0, fw * ZOOM, ch);
      }
    } else if (entry.frames) {
      const r = this.stripFrame(entry, anim, now);
      const fw = entry.frameW ?? TILE_PX;
      const fh = entry.frameH ?? entry.h ?? img.naturalHeight;
      const dw = fw * ZOOM;
      const dh = fh * ZOOM;
      ctx.drawImage(img, (entry.x ?? 0) + r * fw, entry.y ?? 0, fw, fh, 0, ch - dh, dw, dh);
    } else if (entry.x == null || entry.y == null) {
      const w = img.naturalWidth * ZOOM;
      const h = img.naturalHeight * ZOOM;
      ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, ch - h, w, h);
    } else {
      const w = entry.w ?? TILE_PX;
      const h = entry.h ?? TILE_PX;
      ctx.drawImage(img, entry.x, entry.y, w, h, 0, ch - h * ZOOM, w * ZOOM, h * ZOOM);
    }
    // Tile outline: a faint grid plus a bright border over the grass.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let x = TILE_PX * ZOOM; x < cw; x += TILE_PX * ZOOM) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, ch);
      ctx.stroke();
    }
    for (let y = TILE_PX * ZOOM; y < ch; y += TILE_PX * ZOOM) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(cw, y + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, cw - 2, ch - 2);
  }

  /** Grass tiles under the sprite (flat green when the sheet is missing). */
  private drawGrass(cw: number, ch: number): void {
    const ctx = this.ctx;
    const grass = getSprite('grass');
    const img = this.imageFor(grass.file);
    if (!img || !img.naturalWidth || grass.x == null || grass.y == null) {
      ctx.fillStyle = '#5da64a';
      ctx.fillRect(0, 0, cw, ch);
      return;
    }
    for (let y = 0; y < ch; y += TILE_PX * ZOOM) {
      for (let x = 0; x < cw; x += TILE_PX * ZOOM) {
        ctx.drawImage(
          img,
          grass.x,
          grass.y,
          TILE_PX,
          TILE_PX,
          x,
          y,
          TILE_PX * ZOOM,
          TILE_PX * ZOOM,
        );
      }
    }
  }

  /** The player: all 4 direction columns playing the same anim or pose. */
  private drawDirs(img: HTMLImageElement, anim: string, now: number, cw: number, ch: number): void {
    const ctx = this.ctx;
    const e = this.cell.entry;
    const fw = e.frameW ?? TILE_PX;
    const fh = e.frameH ?? TILE_PX;
    if (anim.startsWith('pose:')) {
      const pose = e.poses?.[anim.slice('pose:'.length)];
      if (!pose) return;
      const dw = fw * ZOOM;
      const dh = fh * ZOOM;
      ctx.drawImage(img, pose[0] * fw, pose[1] * fh, fw, fh, (cw - dw) / 2, ch - dh, dw, dh);
      return;
    }
    const range = e.anims?.[anim]?.rows ?? e.anims?.idle?.rows ?? [0, 0];
    const fps = e.anims?.[anim]?.fps ?? 6;
    const span = range[1] - range[0] + 1;
    const row = range[0] + (Math.floor(now / (1000 / fps)) % span);
    for (let col = 0; col < (e.dirs?.length ?? 4); col++) {
      ctx.drawImage(
        img,
        col * fw,
        row * fh,
        fw,
        fh,
        col * TILE_PX * ZOOM,
        ch - TILE_PX * ZOOM,
        TILE_PX * ZOOM,
        TILE_PX * ZOOM,
      );
    }
  }

  /** Current frame of a horizontal-strip anim (non-looping anims hold the end). */
  private stripFrame(entry: CatalogEntry, anim: string, now: number): number {
    const frames = entry.frames ?? 1;
    const range = entry.anims?.[anim] ?? { from: 0, to: frames - 1 };
    const from = range.from ?? 0;
    const to = range.to ?? frames - 1;
    const fps = range.fps ?? 8;
    const step = Math.floor((now % ANIM_MS) / (1000 / fps));
    if (range.loop === false) return Math.min(to, from + step);
    const span = to - from + 1;
    return from + (step % span);
  }
}
