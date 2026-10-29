// Systems API: the ONLY calls a gameplay system may use. Systems never touch the
// DOM, the keyboard, Math.random, or wall-clock time; everything goes through
// the `world` object below. This file is the contract a future AI reads.

/** A compass direction, as named in input events and the player's `facing`. */
export type Dir = 'up' | 'down' | 'left' | 'right';

/** Time of day, derived from the hour (see PHASES in tuning). */
export type Phase = 'dawn' | 'day' | 'dusk' | 'night';

/** A tile position. Entity `pos` is the tile of the sprite's bottom-left corner. */
export interface Pos {
  x: number;
  y: number;
}

/** An event on the bus. Payload fields sit directly on the object. */
export interface GameEvent {
  /** Event name, e.g. "input.move". */
  name: string;
  /** Input only: a handler that acts sets this; later handlers must do nothing. */
  handled: boolean;
  /** Payload fields, e.g. `dir` on input events. */
  [key: string]: unknown;
}

/** An event handler. Runs with the handler's system as the `state` owner. */
export type Handler = (ev: GameEvent, world: World) => void;

/** The `sprite` component: what the renderer draws for an entity. */
export interface SpriteComp {
  /** Catalog sprite id. */
  id: string;
  /** Animation or pose name from the catalog entry; default idle frame. */
  anim?: string;
  /** Explicit frame, overriding `anim`. */
  frame?: number;
  /** Draw order within one tile; higher draws in front. */
  z?: number;
}

/** The `light` component: cuts a soft glow out of the darkness. */
export interface LightComp {
  /** Glow radius in tiles. */
  radius: number;
  /** Glow color, e.g. "#ffca7a". */
  color: string;
  /** Brightness 0-1; overlapping lights add together. */
  strength: number;
  /** Optional flicker amount 0-1. */
  flicker?: number;
}

/** A live entity. Handles stay valid until `destroy()`; `pos` is a copy. */
export interface Entity {
  /** Unique id, stable across save/restore. */
  readonly id: number;
  /** Registered type name, e.g. "log_fallen". */
  readonly type: string;
  /** Tile of the sprite's bottom-left corner, or null while off the map. */
  readonly pos: Pos | null;
  /** True if the entity has this tag OR component (one namespace). */
  has(name: string): boolean;
  /** Adds a tag. */
  tag(name: string): void;
  /** Removes a tag (missing tags are a no-op). */
  untag(name: string): void;
  /** Reads a component (undefined when absent). */
  get<T = unknown>(name: string): T;
  /** Writes a component; `sprite` must be { id: catalogId } and re-indexes. */
  set(name: string, value: unknown): void;
  /** Writes a component that must not exist yet; throws if it does. */
  add(name: string, value: unknown): void;
  /** Removes a component (missing names are a no-op). */
  remove(name: string): void;
  /** Moves on the map; slides by default, `instant` teleports. No collision checks. */
  moveTo(x: number, y: number, opts?: { instant?: boolean }): void;
  /** Takes the entity off the map (`pos` becomes null). */
  lift(): void;
  /** Puts a lifted entity back on the map. */
  place(x: number, y: number): void;
  /** Removes the entity for good; every later handle call throws. */
  destroy(): void;
}

/** The terrain grid: sprite ids plus tag-derived walkability. */
export interface TilesApi {
  /** Sprite id at a tile, or null out of bounds. Never throws. */
  get(x: number, y: number): string | null;
  /** Paints a tile; throws on unknown sprites or out-of-bounds coords. */
  set(x: number, y: number, spriteId: string): void;
  /** Every tile whose sprite carries this catalog tag, in row-major order. */
  find(tag: string): Pos[];
}

/** The world clock. The engine holds it; `daynight` advances it. */
export interface TimeApi {
  /** Day number; starts at 1, goes up at each dawn. */
  readonly day: number;
  /** Current phase, derived from the hour. */
  readonly phase: Phase;
  /** Hour 0-24, fractional. */
  readonly hour: number;
  /** Jumps the clock; emits time.jumped, plus time.phase if the phase changed. */
  set(to: Phase | number): void;
  /** Moves the clock forward silently, rolling the day over at dawn; daynight's per-tick step. */
  advance(deltaHours: number): void;
}

/** Read-only art lookup so systems can pick sprites by meaning. */
export interface CatalogApi {
  /** Sprite ids carrying this catalog tag, in catalog order. */
  find(tag: string): string[];
  /** One sprite's catalog entry; throws on unknown ids. */
  get(id: string): CatalogEntry;
}

/** One entry of src/catalog.json (all art metadata is optional). */
export interface CatalogEntry {
  /** Sprite id, e.g. "tree_round". */
  id: string;
  /** Sheet path under the pack root, e.g. "Backgrounds/Tilesets/TilesetFloor.png". */
  file: string;
  /** Meaning tags, e.g. ["terrain","grass","walkable"]. */
  tags: string[];
  /** Footprint in tiles from pos; default 1x1 ({x? shifts right}). */
  footprint?: { x?: number; w: number; h: number };
  /** Draw layer for entities: ground, object, above, or overlay. */
  layer?: 'ground' | 'object' | 'above' | 'overlay';
  /** Pixel nudge applied when drawing. */
  offset?: { x: number; y: number };
  /** Sheet crop for tileset sprites (pixels). */
  x?: number;
  /** Sheet crop for tileset sprites (pixels). */
  y?: number;
  /** Sprite width in pixels (defaults to the frame/image width). */
  w?: number;
  /** Sprite height in pixels (defaults to the frame/image height). */
  h?: number;
  /** Strip frame width in pixels, for multi-frame sheets. */
  frameW?: number;
  /** Strip frame height in pixels (player sheet). */
  frameH?: number;
  /** Frame count of a horizontal strip. */
  frames?: number;
  /** Direction columns for sheets like the player (down, up, left, right). */
  dirs?: string[];
  /** Named frame ranges ({from,to,fps?,loop?}) or row ranges ({rows:[a,b]}). */
  anims?: Record<string, { from?: number; to?: number; fps?: number; loop?: boolean; rows?: [number, number] }>;
  /** Single-frame poses as [col,row]. */
  poses?: Record<string, [number, number]>;
  /** True when each frame is a separate particle piece, not an animation. */
  pieces?: boolean;
}

/** Short screen effects. Simple versions; systems never draw directly. */
export interface FxApi {
  /** Visual-only glide of an entity toward a tile over N ticks (grid pos untouched). */
  tween(entity: Entity, x: number, y: number, ticks: number): void;
  /** Spawns a one-shot particle burst of this sprite at a tile. */
  particles(spriteId: string, pos: Pos): void;
  /** Floating text over a tile, fading after ~1s. */
  floatText(text: string, pos: Pos, color?: string): void;
  /** Full-screen color flash fading over durationMs. */
  tint(color: string, alpha: number, durationMs: number): void;
}

/** Banner plus the HUD bar below the map. Text slots never shift layout. */
export interface UiApi {
  /** Brief centered banner at the top of the map, then fades. */
  banner(text: string): void;
  /** HUD slots on the bar below the map. */
  hud: {
    /** Adds a slot; `width` reserves characters for the widest value. */
    add(id: string, opts: { icon?: string; text: string; width: number }): void;
    /** Removes a slot (missing ids are a no-op). */
    remove(id: string): void;
  };
}

/** A registered entity type: its art plus starting tags. */
export interface EntityTypeDef {
  /** Catalog sprite id new entities of this type draw. */
  sprite: string;
  /** Tags new entities of this type carry. */
  tags: string[];
}

/** A system's contract: what it claims, emits, and how to build on it. */
export interface SystemContract {
  /** Inputs it sets `handled` on, as "event: situation". */
  claims: string[];
  /** Events it may emit, each with payload shape and when it fires. */
  emits: Record<string, { payload: string; when: string }>;
  /** One-line instructions for building on this system. */
  hooks: string[];
}

/** One headless test. Passes only if every check passes and at least one ran. */
export interface SystemTest {
  /** Test name, shown on failure. */
  name: string;
  /** Optional setup; shares the world's system `state` with `expect`. */
  setup?: (w: World, sim: Sim) => void;
  /** Ticks to run after setup, before `expect`. */
  ticks: number;
  /** Verifies via check(condition, "what it means"). */
  expect: (w: World, check: (condition: unknown, message: string) => void) => void;
}

/** A stored screenshot recipe, rendered by a later pipeline (not run by tests). */
export interface SystemShot {
  /** Shot name. */
  name: string;
  /** Optional setup before capturing. */
  setup?: (w: World, sim: Sim) => void;
  /** Ticks to run after setup, before capturing. */
  ticks: number;
  /** Map focus tile for the capture. */
  focus: Pos;
}

/** A gameplay system module, built with defineSystem. */
export interface SystemDef {
  /** Unique id, e.g. "movement". */
  id: string;
  /** One line: what this gives the player. */
  why: string;
  /** Ids of systems that must be loaded first. */
  buildsOn: string[];
  /** The contract other systems (and future AI) build on. */
  contract: SystemContract;
  /** New component shapes this system adds (documentation). */
  components: Record<string, string>;
  /** New entity types: { name: { sprite: catalogId, tags } }. */
  entities: Record<string, EntityTypeDef>;
  /** One-time setup; must be safe to run more than once. */
  migrate?: (world: World) => void;
  /** Per-tick logic; dt is 1/60. */
  onTick?: (world: World, dt: number) => void;
  /** Event handlers, run in system load order after direct listeners. */
  on: Record<string, Handler>;
  /** Headless tests, each on a fresh world from the fixed seed. */
  tests: SystemTest[];
  /** Screenshot recipes for the later render pipeline. */
  shots: SystemShot[];
}

/** The world: every call below is the whole surface a system gets. */
export interface World {
  /** Entities whose footprint covers a tile. The ONLY way to test collision. */
  at(x: number, y: number): Entity[];
  /** Entities with this tag or component, in spawn order (includes lifted). */
  query(tagOrComponent: string): Entity[];
  /** Spawns a registered type; throws on unknown types, sprite ids, or bounds. */
  spawn(type: string, pos: Pos): Entity;
  /** True when a tile is walkable and holds no blocker besides `except`. */
  isFree(x: number, y: number, except?: Entity): boolean;
  /** The terrain grid. */
  tiles: TilesApi;
  /** Subscribes a direct listener (runs before system handlers); returns unsub. */
  on(name: string, handler: Handler): () => void;
  /** Emits an event to direct listeners then systems in load order; returns it. */
  emit(name: string, data?: Record<string, unknown>): GameEvent;
  /** The world clock. */
  time: TimeApi;
  /** Seeded RNG stream; systems must use this instead of Math.random. */
  rand(): number;
  /** Read-only art lookup. */
  catalog: CatalogApi;
  /** Short screen effects. */
  fx: FxApi;
  /** Banner and HUD. */
  ui: UiApi;
  /** This system's own saved state; only while that system runs. */
  state: Record<string, unknown>;
  /** Registers a system, runs migrate, wires onTick/on; throws on doubles. */
  loadSystem(def: SystemDef): void;
  /** Removes a system; its state and types' entities survive for reload. */
  unloadSystem(id: string): void;
  /** Loaded system ids, in load order. */
  readonly systems: readonly string[];
  /** Advances one tick (harness/sim only; systems never call this). */
  tick(): void;
  /** Ticks elapsed since this world was created. */
  readonly ticks: number;
  /** Saves entities, tiles, clock, rng, and system state to a string. */
  serialize(): string;
  /** Restores a serialize() string; throws on bad versions or missing types. */
  deserialize(save: string): void;
  /** Alias of serialize(), for save points. */
  snapshot(): string;
  /** Alias of deserialize(), for save points. */
  restore(save: string): void;
}

/** Test/shoot helper: plays the game through real input events plus ticks. */
export interface Sim {
  /** Sends input.move per step with step ticks between (default 1 step). */
  walk(dir: Dir, steps?: number): void;
  /** Sends input.turn for a direction. */
  face(dir: Dir): void;
  /** Sends input.interact. */
  interact(): void;
  /** Sends input.secondary. */
  secondary(): void;
  /** Puts the player on a tile instantly. */
  teleport(x: number, y: number): void;
  /** Spawns an item straight into the player's hands, as carry does. */
  give(type: string): Entity;
  /** Runs this many ticks. */
  wait(ticks: number): void;
  /** Sends any input event by name, for inputs added later; returns it. */
  press(inputEvent: string, data?: Record<string, unknown>): GameEvent;
}
