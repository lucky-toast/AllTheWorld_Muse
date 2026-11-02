// Shared engine types. Nothing here is a system API: systems only see host requests (section 4.2).

/** A tile position. `area` is the id of the area the tile is in. */
export interface Pos { x: number; y: number; area: string }

/** One sprite entry from src/catalog.json. */
export interface CatalogEntry {
  id: string; file: string; x?: number; y?: number; w?: number; h?: number;
  frameW?: number; frameH?: number; frames?: number; tags: string[];
  footprint?: { x?: number; w: number; h: number }; layer?: string;
  anims?: Record<string, { from?: number; to?: number; rows?: number[]; fps?: number; loop?: boolean }>;
  dirs?: string[]; poses?: Record<string, [number, number]>; pieces?: boolean;
  offset?: { x: number; y: number }; desc?: string; materials?: string[];
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
