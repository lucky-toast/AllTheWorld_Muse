// Shared engine types. Nothing here is a system API: systems only see host requests (section 4.2).

/** A tile position. `area` is the id of the area the tile is in. */
export interface Pos { x: number; y: number; area: string }

// ---------- Catalog ----------

/** Pixel offset. */
export interface PixelOffset { x: number; y: number }

/** Facing direction. In directional sheets, columns follow this order. */
export type Dir = "down" | "up" | "left" | "right";

/** One entry from src/catalog.json. */
export interface CatalogEntry {
  /** Unique snake_case id; other entries refer to this entry by it. */
  id: string;
  /** Asset path relative to the catalog's `root` (image, .ogg/.wav audio, or .ttf font). */
  file: string;
  /** Left edge of the sprite's rectangle within the sheet, in pixels. If x/y/w/h are absent, the entry is the whole file. */
  x?: number;
  /** Top edge of the sprite's rectangle within the sheet, in pixels. */
  y?: number;
  /** Width of the rectangle in pixels. */
  w?: number;
  /** Height of the rectangle in pixels. */
  h?: number;
  /** Search and grouping tags (e.g. "tree", "solid", "ui", "region", "kit"). */
  tags: string[];
  /** Plain-language description; for `region`/`kit` entries it also explains the tile layout. */
  desc: string;
  /** Tiles the entity blocks/occupies, from its bottom-left tile. `x` shifts it right by that many columns. Default 1x1. */
  footprint?: { x?: number; w: number; h: number };
  /** Pixel nudge applied when drawing. */
  offset?: PixelOffset;
  /** Draw layer: ground = flat, under everything; object = y-sorted with the player; above = drawn over objects; overlay = whole screen. Terrain tiles, UI and audio have none. */
  layer?: "ground" | "object" | "above" | "overlay";
  /** What it is made of, main material first (e.g. ["wood", "plant"]). */
  materials?: string[];
  /** Related entries by name (color, state, view, animation file…); every member of a group carries the same map. */
  variants?: Record<string, string>;
  /** What this turns into after an event, e.g. { cut: "stump_big" }. Values are entry ids. */
  becomes?: Record<string, string>;
  /** Width of one animation frame or piece, in pixels. */
  frameW?: number;
  /** Height of one frame; defaults to the full height of the image or rectangle. */
  frameH?: number;
  /** Number of frames in a single-row strip, or in a grid read left-to-right, top-to-bottom. */
  frames?: number;
  /** Named animations. Strips use from/to (inclusive frame indices); directional sheets use rows (inclusive [first, last]), with one column per entry in `dirs`. */
  anims?: Record<string, {
    /** First frame index (strips). */
    from?: number;
    /** Last frame index, inclusive (strips). */
    to?: number;
    /** First and last row, inclusive (directional sheets). */
    rows?: [number, number];
    /** Playback speed in frames per second. */
    fps?: number;
    /** True if the animation repeats. */
    loop?: boolean;
  }>;
  /** Single-frame poses in a directional sheet, as [column, row] (e.g. dead, item). */
  poses?: Record<string, [number, number]>;
  /** Direction order of the sheet's columns. */
  dirs?: Dir[];
  /** True if each frame is a separate particle or piece: pick one, don't animate. */
  pieces?: boolean;
  /** Asset type; absent means "sprite". */
  kind?: "sprite" | "sound" | "music" | "font";
  /** Audio only: true for music and ambient loops that should repeat. */
  loop?: boolean;
  /** Audio only: length in milliseconds. */
  durationMs?: number;
  /** 9-slice border insets in pixels (left, top, right, bottom); the centre stretches, the corners don't. */
  slice?: { l: number; t: number; r: number; b: number };
  /** Bitmap-font layout: cell size and column count. chars[i] is the glyph in cell i, read left-to-right, top-to-bottom; \u007f marks an empty cell. */
  grid?: { cellW: number; cellH: number; cols: number; chars: string };
  /** Id of this actor's 38x38 dialog portrait entry. */
  faceset?: string;
}

/** A registered entity type: its sprite and starting tags. */
export interface EntityType { sprite: string; tags: string[] }

/** The `sprite` component every drawn entity carries. */
export interface SpriteComp { id: string; anim?: string; frame?: number; z?: number; offset?: { x: number; y: number } }

/** A `light` component: cuts a soft glow out of the darkness. */
export interface LightComp { radius: number; color: string; strength: number; flicker?: number }

export type { Interaction, Manifest } from "./manifest";

/** Owner id used for engine-made things (base map types, engine events, the engine RNG stream). Not a valid system id. */
export const ENGINE_OWNER = "@engine";
/** Owner id of the base map's entity types. Not a valid system id. */
export const WORLD_OWNER = "@world";
/** System ids: lowercase, start with a letter, up to 40 characters. */
export const SYSTEM_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** The base area every world starts with. */
export const BASE_AREA = "clearing";
