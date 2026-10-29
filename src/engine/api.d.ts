// Systems API contract. A future system (human or AI) reads only this file.
// Systems are modules created with defineSystem() from "engine/define".
// They receive a `world` object with exactly the calls documented below.
// All game logic runs in ticks (60/s), never wall-clock time.

/** Cardinal direction names used for movement and facing. */
export type Dir = "up" | "down" | "left" | "right";
/** A tile coordinate on the map. */
export interface Pos { x: number; y: number }
/** Payload passed to event handlers; input events also carry `handled`. */
export interface GameEvent { handled: boolean; [key: string]: unknown }

/** A handle to one entity. Obtain via world.spawn / world.query / world.at. */
export interface Entity {
  /** Unique numeric id of this entity. */
  readonly id: number;
  /** Registered entity type name, e.g. "log_fallen". */
  readonly type: string;
  /** Tile of the sprite's bottom-left corner, or null while off the map (held). Read-only: use moveTo/lift/place to change it. */
  readonly pos: Pos | null;
  /** True if the entity has this tag or a component with this name (one shared namespace). */
  has(tagOrComponent: string): boolean;
  /** Add a plain tag to this entity. */
  tag(name: string): void;
  /** Remove a plain tag from this entity. */
  untag(name: string): void;
  /** Read a component's value (plain JSON data), or undefined if absent. */
  get<T = unknown>(component: string): T | undefined;
  /** Set a component to a plain-JSON value. Setting "sprite" updates occupancy. */
  set(component: string, value: unknown): void;
  /** Add a component (same as set; use whichever reads better). */
  add(component: string, value: unknown): void;
  /** Remove a component entirely. */
  remove(component: string): void;
  /** Move to a tile, sliding by default; pass { instant: true } to teleport. Does not check collision. */
  moveTo(x: number, y: number, opts?: { instant?: boolean }): void;
  /** Take this entity off the map (pos becomes null), e.g. into the player's hands. */
  lift(): void;
  /** Put a lifted entity back on the map at a tile. Does not check collision. */
  place(x: number, y: number): void;
  /** Remove this entity from the world permanently. */
  destroy(): void;
}

/** One sprite entry from src/catalog.json. */
export interface CatalogEntry {
  id: string; file: string; x?: number; y?: number; w?: number; h?: number;
  frameW?: number; frameH?: number; frames?: number; tags: string[];
  footprint?: { x?: number; w: number; h: number }; layer?: string;
  anims?: Record<string, { from?: number; to?: number; rows?: number[]; fps?: number; loop?: boolean }>;
  dirs?: string[]; poses?: Record<string, [number, number]>; pieces?: boolean;
  offset?: { x: number; y: number }; desc?: string;
}

/** The world object passed to every system handler, onTick, migrate and test. */
export interface World {
  /** Entities whose footprint covers tile (x, y). This is the only way systems test collision. */
  at(x: number, y: number): Entity[];
  /** All entities that have this tag or component. */
  query(tagOrComponent: string): Entity[];
  /** Spawn an entity of a registered type at a tile. Throws a clear error for any unregistered name (including bare catalog sprite ids that are not type names). */
  spawn(type: string, pos: Pos): Entity;
  /** Tile map access: terrain sprite ids per tile. */
  tiles: {
    /** Terrain sprite id at a tile, or null outside the map. */
    get(x: number, y: number): string | null;
    /** Replace the terrain sprite at a tile. */
    set(x: number, y: number, spriteId: string): void;
    /** All tiles whose terrain sprite carries this catalog tag, e.g. "water". */
    find(tag: string): Pos[];
  };
  /** Subscribe to an event. Handlers run in system load order. */
  on(name: string, handler: (ev: GameEvent, world: World) => void): void;
  /** Emit an event synchronously to all subscribers. Returns the event object (check/mutate `handled` on input events). */
  emit(name: string, data?: Record<string, unknown>): GameEvent;
  /** World clock, held by the engine and advanced by the daynight system. */
  time: {
    /** Current day number; starts at 1 and goes up at each dawn. */
    readonly day: number;
    /** Current phase: "dawn" | "day" | "dusk" | "night". */
    readonly phase: "dawn" | "day" | "dusk" | "night";
    /** Current hour, 0-24 fractional. */
    readonly hour: number;
    /** Jump the clock to a phase name ("dawn") or an hour number. Emits time.jumped, then time.phase if the phase changed. */
    set(phaseOrHour: string | number): void;
  };
  /** Seeded RNG in [0, 1). Systems must use this instead of Math.random. */
  rand(): number;
  /** Sprite catalog access so systems can pick art by meaning. */
  catalog: {
    /** Sprite ids whose catalog entry carries this tag. */
    find(tag: string): string[];
    /** The catalog entry for a sprite id, or undefined. */
    get(id: string): CatalogEntry | undefined;
  };
  /** Short-lived visual effects (fx.tween, fx.particles, fx.floatText, fx.tint); the renderer owns them, systems only trigger them. */
  fx: {
    /** Tween a numeric value over ticks, calling onUpdate(v) each tick and onDone() at the end. */
    tween(opts: { from: number; to: number; ticks: number; onUpdate: (v: number) => void; onDone?: () => void }): void;
    /** Burst of particles using a catalog sprite (one random piece if the sprite has pieces). */
    particles(spriteId: string, pos: Pos): void;
    /** Small text that floats up from a tile and fades. */
    floatText(text: string, pos: Pos, color?: string): void;
    /** Brief full-screen colour tint that fades over durationMs. */
    tint(color: string, alpha: number, durationMs: number): void;
  };
  /** User interface hooks (ui.banner, ui.hud.add, ui.hud.remove). Text slots reserve fixed width so layout never shifts. */
  ui: {
    /** Show a short banner at the top of the map; it fades on its own. */
    banner(text: string): void;
    hud: {
      /** Add or replace a HUD slot on the right side. width = characters to reserve for text. */
      add(id: string, opts: { icon?: string; text: string; width: number }): void;
      /** Remove a HUD slot previously added with the same id. */
      remove(id: string): void;
    };
  };
  /** This system's own plain object; saved with the world by serialize(). */
  state: Record<string, unknown>;
}

/** Test/shot driver passed as the second setup argument. It plays through real input events. */
export interface Sim {
  /** Face a direction (sends input.turn), then step that way `steps` times (sends input.move per step), waiting for each to finish. */
  walk(dir: Dir, steps?: number): void;
  /** Turn to face a direction without moving (sends input.turn). */
  face(dir: Dir): void;
  /** Press interact (sends input.interact: Space/E in play). */
  interact(): void;
  /** Press the spare secondary key (sends input.secondary: Q in play). */
  secondary(): void;
  /** Put the player on a tile instantly. */
  teleport(x: number, y: number): void;
  /** Spawn a new item of this type and put it in the player's hands, exactly as carry does. */
  give(type: string): Entity;
  /** Run the world forward this many ticks. */
  wait(ticks: number): void;
  /** Send any input event by name, e.g. press("input.move", { dir: "up" }), so inputs added later are covered. */
  press(inputEvent: string, data?: Record<string, unknown>): void;
}

/** One headless test declared by a system. setup/expect share the system's world; w.state is that system's state. */
export interface SystemTest {
  name: string;
  setup?: (w: World, sim: Sim) => void;
  ticks: number;
  expect: (w: World, check: (cond: boolean, what: string) => void) => void;
}
/** One screenshot request declared by a system; stored now, rendered by a later pipeline. */
export interface SystemShot { name: string; setup?: (w: World, sim: Sim) => void; ticks: number; focus: Pos }

/** The shape every system module passes to defineSystem(). */
export interface SystemDef {
  /** Unique system id, e.g. "movement". */
  id: string;
  /** One line: what this gives the player. */
  why: string;
  /** Ids of systems this one relies on. */
  buildsOn: string[];
  /** Machine-checkable contract: claims are "event: situation" the system sets handled on; emits lists every event it may emit; hooks are one-line build-on instructions. */
  contract: {
    claims: string[];
    emits: Record<string, { payload: string; when: string }>;
    hooks: string[];
  };
  /** New component shapes this system adds: name -> description. */
  components: Record<string, string>;
  /** New entity types this system registers: name -> { sprite: catalogId, tags }. */
  entities: Record<string, { sprite: string; tags: string[] }>;
  /** Runs when the system is loaded. Must be safe to run more than once. */
  migrate(world: World): void;
  /** Runs every tick (60/s). */
  onTick(world: World, dt: number): void;
  /** Event handlers by event name. */
  on: Record<string, (ev: GameEvent, world: World) => void>;
  /** Headless tests proving this system's promise, including blocked cases. */
  tests: SystemTest[];
  /** Screenshot requests for a later pipeline. */
  shots: SystemShot[];
}
