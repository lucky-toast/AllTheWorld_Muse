// The world: entity store, occupancy, events, clock, fx/ui stubs, systems,
// save/restore. This plus the input layer is the whole engine; game logic
// lives in systems that only touch the World interface (see api.d.ts).
import {
  BANNER_TICKS,
  DAY_START_DAY,
  DAY_START_HOUR,
  FLOAT_TEXT_TICKS,
  PARTICLE_TICKS,
  PHASE_HOURS,
  PHASES,
  SLIDE_TICKS,
  TICKS_PER_SECOND,
} from '../tuning';
import { BASE_TYPES } from '../world/types';
import { placeholderMap, type MapData } from '../world/map';
import type {
  Dir,
  Entity,
  EntityTypeDef,
  GameEvent,
  Handler,
  Phase,
  Pos,
  SystemDef,
  World,
} from './api';
import { findSprites, getSprite, hasSprite } from './catalog';
import { mulberry32 } from './rng';

const SAVE_VERSION = 1;
const DT = 1 / TICKS_PER_SECOND;

/** Blockers for the free-tile rule: player, solid, pushable, item. Decor never blocks. */
const BLOCKER_TAGS = ['player', 'solid', 'pushable', 'item'];

interface EntityRecord {
  id: number;
  type: string;
  pos: Pos | null;
  tags: Set<string>;
  comps: Record<string, unknown>;
  alive: boolean;
}

interface LoadedSystem {
  def: SystemDef;
  state: Record<string, unknown>;
}

interface RunContext {
  def: SystemDef | null;
  state: Record<string, unknown>;
}

interface Slide {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number; // world tick the slide began (length is SLIDE_TICKS)
}

interface Tween {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  left: number; // ticks remaining
  total: number; // ticks at creation
}

export interface WorldInternals {
  slides: Map<number, Slide>;
  tweens: Map<number, Tween>;
  violations: string[];
  particles: Array<{ sprite: string; x: number; y: number; ttl: number }>;
  texts: Array<{ text: string; x: number; y: number; color: string; ttl: number }>;
  tintState: { color: string; alpha: number; left: number; total: number } | null;
  bannerState: { text: string; ttl: number } | null;
  hud: Map<string, { icon?: string; text: string; width: number }>;
  mapSize(): { w: number; h: number };
  allEntities(): Entity[];
  withStateContext<T>(systemId: string, fn: () => T): T;
  /** A loaded system's saved state, for engine-side readers like the HUD. */
  systemState(id: string): Record<string, unknown> | undefined;
}

/** Engine-side back door for the renderer, sim, and tests. Systems never use this. */
export function internals(world: World): WorldInternals {
  const inner = (world as unknown as { [k: symbol]: WorldInternals })[INNER];
  if (!inner) throw new Error('internals() needs a world from createWorld()');
  return inner;
}
const INNER = Symbol('world-internals');

export interface CreateWorldOpts {
  seed: number;
  map?: MapData;
  /** Extra entity types (the test harness registers test-only types here). */
  extraTypes?: Record<string, EntityTypeDef>;
}

export function createWorld(opts: CreateWorldOpts): World {
  const map = opts.map ?? placeholderMap();
  if (map.tiles.length !== map.width * map.height) {
    throw new Error(`bad map: ${map.tiles.length} tiles for a ${map.width}x${map.height} grid`);
  }
  if (!inMap(map, map.playerStart.x, map.playerStart.y)) {
    throw new Error('bad map: playerStart is out of bounds');
  }

  const rng = mulberry32(opts.seed);
  let tiles = [...map.tiles];
  let ticks = 0;
  let nextId = 1;
  let day = DAY_START_DAY;
  let hour = DAY_START_HOUR;

  const entities = new Map<number, EntityRecord>();
  const handles = new Map<number, Entity>();
  const occupancy = new Map<number, Set<number>>(); // tile index -> entity ids
  const registry = new Map<string, { def: EntityTypeDef; owner: string | null }>();
  for (const [name, def] of Object.entries(BASE_TYPES)) registry.set(name, { def, owner: null });
  for (const [name, def] of Object.entries(opts.extraTypes ?? {})) {
    registry.set(name, { def, owner: 'extra' });
  }

  const order: LoadedSystem[] = [];
  const byId = new Map<string, LoadedSystem>();
  const states = new Map<string, Record<string, unknown>>();
  const direct = new Map<string, Handler[]>();
  const slides = new Map<number, Slide>();
  const tweens = new Map<number, Tween>();
  const violations: string[] = [];
  let particles: WorldInternals['particles'] = [];
  let texts: WorldInternals['texts'] = [];
  let tint: WorldInternals['tintState'] = null;
  let banner: WorldInternals['bannerState'] = null;
  const hud = new Map<string, { icon?: string; text: string; width: number }>();

  // Attribution + state stacks. The top entry owns `state` and any emit checks.
  const stack: RunContext[] = [];
  const current = () => (stack.length > 0 ? stack[stack.length - 1] : null);

  function withCtx<T>(def: SystemDef | null, state: Record<string, unknown>, fn: () => T): T {
    stack.push({ def, state });
    try {
      return fn();
    } finally {
      stack.pop();
    }
  }

  const tileIndex = (x: number, y: number): number => y * map.width + x;
  const inBounds = (x: number, y: number): boolean =>
    Number.isInteger(x) && Number.isInteger(y) && inMap(map, x, y);

  /** Tiles a footprint covers from pos. Height extends upward (y-h+1..y). */
  function footprintTiles(spriteId: string, pos: Pos): Array<{ x: number; y: number }> {
    const fp = getSprite(spriteId).footprint ?? { w: 1, h: 1 };
    const out: Array<{ x: number; y: number }> = [];
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        out.push({ x: pos.x + (fp.x ?? 0) + dx, y: pos.y - dy });
      }
    }
    return out;
  }

  function spriteOf(rec: EntityRecord): string {
    return (rec.comps.sprite as { id: string }).id;
  }

  function index(rec: EntityRecord): void {
    if (!rec.pos) return;
    for (const t of footprintTiles(spriteOf(rec), rec.pos)) {
      if (!inMap(map, t.x, t.y)) continue;
      const key = tileIndex(t.x, t.y);
      let set = occupancy.get(key);
      if (!set) {
        set = new Set();
        occupancy.set(key, set);
      }
      set.add(rec.id);
    }
  }

  function unindex(rec: EntityRecord): void {
    if (!rec.pos) return;
    for (const t of footprintTiles(spriteOf(rec), rec.pos)) {
      if (!inMap(map, t.x, t.y)) continue;
      const set = occupancy.get(tileIndex(t.x, t.y));
      if (set) {
        set.delete(rec.id);
        if (set.size === 0) occupancy.delete(tileIndex(t.x, t.y));
      }
    }
  }

  function handle(rec: EntityRecord): Entity {
    let h = handles.get(rec.id);
    if (h) return h;
    const alive = () => {
      if (!rec.alive) throw new Error(`entity #${rec.id} (${rec.type}) was destroyed`);
    };
    h = {
      get id() {
        return rec.id;
      },
      get type() {
        return rec.type;
      },
      get pos() {
        return rec.pos ? { ...rec.pos } : null;
      },
      has: (name) => rec.tags.has(name) || name in rec.comps,
      tag: (name) => {
        alive();
        rec.tags.add(name);
      },
      untag: (name) => {
        alive();
        rec.tags.delete(name);
      },
      get: ((name: string): unknown => rec.comps[name]) as Entity['get'],
      set: (name, value) => {
        alive();
        if (name === 'sprite') {
          const id = (value as { id?: unknown } | null)?.id;
          if (typeof value !== 'object' || value === null || typeof id !== 'string') {
            throw new Error("'sprite' components need { id: catalogId }");
          }
          getSprite(id); // throws unknown sprite
          unindex(rec);
          rec.comps.sprite = { ...(value as Record<string, unknown>) };
          index(rec);
          return;
        }
        rec.comps[name] = value;
      },
      add: (name, value) => {
        alive();
        if (rec.tags.has(name) || name in rec.comps) {
          throw new Error(`entity #${rec.id} already has "${name}"`);
        }
        rec.comps[name] = value;
      },
      remove: (name) => {
        alive();
        delete rec.comps[name];
      },
      moveTo: (x, y, moveOpts) => {
        alive();
        if (!rec.pos) {
          throw new Error(`entity #${rec.id} is off the map: use place(), not moveTo()`);
        }
        if (!inBounds(x, y)) throw new Error(`moveTo (${x},${y}): out of bounds`);
        if (x === rec.pos.x && y === rec.pos.y) return;
        const from = { ...rec.pos };
        unindex(rec);
        rec.pos = { x, y };
        index(rec);
        if (moveOpts?.instant) slides.delete(rec.id);
        else slides.set(rec.id, { fx: from.x, fy: from.y, tx: x, ty: y, t0: ticks });
      },
      lift: () => {
        alive();
        if (!rec.pos) throw new Error(`entity #${rec.id} is already off the map`);
        unindex(rec);
        rec.pos = null;
        slides.delete(rec.id);
      },
      place: (x, y) => {
        alive();
        if (rec.pos) throw new Error(`entity #${rec.id} is already on the map`);
        if (!inBounds(x, y)) throw new Error(`place (${x},${y}): out of bounds`);
        rec.pos = { x, y };
        index(rec);
      },
      destroy: () => {
        alive();
        unindex(rec);
        slides.delete(rec.id);
        rec.alive = false;
        entities.delete(rec.id);
      },
    };
    handles.set(rec.id, h);
    return h;
  }

  function phaseOf(h: number): Phase {
    if (h >= PHASES.dawn.start && h < PHASES.dawn.end) return 'dawn';
    if (h >= PHASES.day.start && h < PHASES.day.end) return 'day';
    if (h >= PHASES.dusk.start && h < PHASES.dusk.end) return 'dusk';
    return 'night';
  }

  function claimedInputs(def: SystemDef): Set<string> {
    // Claims read "event: situation"; only the event name matters here.
    return new Set(def.contract.claims.map((c) => c.split(':')[0].trim()));
  }

  const world: World = {
    at: (x, y) => {
      if (!inBounds(x, y)) return [];
      const set = occupancy.get(tileIndex(x, y));
      if (!set) return [];
      const out: Entity[] = [];
      for (const id of [...set].sort((a, b) => a - b)) {
        const rec = entities.get(id);
        if (rec) out.push(handle(rec));
      }
      return out;
    },

    query: (tagOrComponent) => {
      const out: Entity[] = [];
      for (const rec of [...entities.values()].sort((a, b) => a.id - b.id)) {
        if (rec.tags.has(tagOrComponent) || tagOrComponent in rec.comps) out.push(handle(rec));
      }
      return out;
    },

    spawn: (type, pos) => {
      const entry = registry.get(type);
      if (!entry) {
        if (hasSprite(type)) {
          throw new Error(
            `unknown entity type "${type}" — that is a catalog sprite id, not an entity type ` +
              `(register it in a system's entities or src/world/types.ts)`,
          );
        }
        throw new Error(
          `unknown entity type "${type}" (register it in a system's entities or src/world/types.ts)`,
        );
      }
      if (!inBounds(pos.x, pos.y)) throw new Error(`spawn ${type} at (${pos.x},${pos.y}): out of bounds`);
      const rec: EntityRecord = {
        id: nextId++,
        type,
        pos: { x: pos.x, y: pos.y },
        tags: new Set(entry.def.tags),
        comps: { sprite: { id: entry.def.sprite } },
        alive: true,
      };
      entities.set(rec.id, rec);
      index(rec);
      return handle(rec);
    },

    isFree: (x, y, except) => {
      if (!inBounds(x, y)) return false; // the map edge always blocks
      if (!getSprite(tiles[tileIndex(x, y)]).tags.includes('walkable')) return false;
      for (const e of world.at(x, y)) {
        if (except !== undefined && e.id === except.id) continue;
        if (BLOCKER_TAGS.some((t) => e.has(t))) return false;
      }
      return true;
    },

    tiles: {
      get: (x, y) => (inBounds(x, y) ? tiles[tileIndex(x, y)] : null),
      set: (x, y, spriteId) => {
        getSprite(spriteId); // throws unknown sprite
        if (!inBounds(x, y)) throw new Error(`tiles.set (${x},${y}): out of bounds`);
        tiles[tileIndex(x, y)] = spriteId;
      },
      find: (tag) => {
        const out: Pos[] = [];
        for (let y = 0; y < map.height; y++) {
          for (let x = 0; x < map.width; x++) {
            if (getSprite(tiles[tileIndex(x, y)]).tags.includes(tag)) out.push({ x, y });
          }
        }
        return out;
      },
    },

    on: (name, handler) => {
      const list = direct.get(name) ?? [];
      list.push(handler);
      direct.set(name, list);
      return () => {
        const kept = (direct.get(name) ?? []).filter((h) => h !== handler);
        if (kept.length > 0) direct.set(name, kept);
        else direct.delete(name);
      };
    },

    emit: (name, data) => {
      // Contract check, attributed to the innermost running system (if any).
      const emitter = current()?.def ?? null;
      if (emitter) {
        if (name.startsWith('input.')) {
          violations.push(`system "${emitter.id}" must never re-emit inputs (tried "${name}").`);
        } else if (!(name in emitter.contract.emits)) {
          violations.push(`system "${emitter.id}" emitted undeclared event "${name}".`);
        }
      }
      const ev: GameEvent = { ...(data ?? {}), name, handled: false };
      for (const fn of [...(direct.get(name) ?? [])]) fn(ev, world);
      for (const sys of [...order]) {
        const fn = sys.def.on[name];
        if (!fn) continue;
        withCtx(sys.def, sys.state, () => {
          const before = ev.handled;
          fn(ev, world);
          if (!before && ev.handled && name.startsWith('input.')) {
            if (!claimedInputs(sys.def).has(name)) {
              violations.push(`system "${sys.def.id}" set handled on unclaimed input "${name}".`);
            }
          }
        });
      }
      return ev;
    },

    time: {
      get day() {
        return day;
      },
      get phase() {
        return phaseOf(hour);
      },
      get hour() {
        return hour;
      },
      set: (to: Phase | number) => {
        const from = { day, hour };
        if (typeof to === 'number') {
          day += Math.floor(to / 24);
          hour = to - Math.floor(to / 24) * 24;
        } else if (to in PHASE_HOURS) {
          hour = PHASE_HOURS[to as Phase];
        } else {
          throw new Error(`unknown phase "${to}" (want dawn, day, dusk, or night, or an hour 0-24)`);
        }
        const previous = phaseOf(from.hour);
        world.emit('time.jumped', { from, to: { day, hour } });
        const next = phaseOf(hour);
        if (next !== previous) world.emit('time.phase', { phase: next, previous, day });
      },
      advance: (deltaHours: number) => {
        if (!Number.isFinite(deltaHours) || deltaHours < 0) {
          throw new Error(`time.advance needs a forward step in hours (got ${deltaHours})`);
        }
        // The day rolls over at dawn, not midnight: count dawn crossings in the step.
        const dawn = PHASES.dawn.start;
        day += Math.floor((hour + deltaHours - dawn) / 24) - Math.floor((hour - dawn) / 24);
        hour = (hour + deltaHours) % 24;
      },
    },

    rand: () => rng.next(),

    catalog: {
      find: (tag) => findSprites(tag),
      get: (id) => getSprite(id),
    },

    fx: {
      tween: (entity, x, y, n) => {
        const from = entity.pos;
        if (!from) throw new Error(`cannot tween entity #${entity.id} while it is off the map`);
        const total = Math.max(1, Math.floor(n));
        tweens.set(entity.id, { fx: from.x, fy: from.y, tx: x, ty: y, left: total, total });
      },
      particles: (spriteId, pos) => {
        getSprite(spriteId); // throws unknown sprite
        particles.push({ sprite: spriteId, x: pos.x, y: pos.y, ttl: PARTICLE_TICKS });
      },
      floatText: (text, pos, color) => {
        texts.push({ text, x: pos.x, y: pos.y, color: color ?? '#fff', ttl: FLOAT_TEXT_TICKS });
      },
      tint: (color, alpha, durationMs) => {
        const total = Math.max(1, Math.ceil((durationMs / 1000) * TICKS_PER_SECOND));
        tint = { color, alpha, left: total, total };
      },
    },

    ui: {
      banner: (text) => {
        banner = { text, ttl: BANNER_TICKS };
      },
      hud: {
        add: (id, hudOpts) => {
          if (hudOpts.icon !== undefined) getSprite(hudOpts.icon); // throws unknown sprite
          hud.set(id, { icon: hudOpts.icon, text: hudOpts.text, width: hudOpts.width });
        },
        remove: (id) => {
          hud.delete(id);
        },
      },
    },

    get state() {
      const ctx = current();
      if (!ctx) {
        throw new Error(
          'world.state is only available while a system runs (migrate, onTick, event handler, or test setup/expect)',
        );
      }
      return ctx.state;
    },

    loadSystem: (def) => {
      if (byId.has(def.id)) throw new Error(`system "${def.id}" is already loaded`);
      for (const dep of def.buildsOn) {
        if (!byId.has(dep)) throw new Error(`system "${def.id}" needs "${dep}" loaded first (buildsOn)`);
      }
      for (const [type, typeDef] of Object.entries(def.entities)) {
        getSprite(typeDef.sprite); // throws unknown sprite
        if (registry.has(type)) {
          throw new Error(`entity type "${type}" is already registered (system "${def.id}" cannot take it)`);
        }
      }
      for (const [type, typeDef] of Object.entries(def.entities)) {
        registry.set(type, { def: { sprite: typeDef.sprite, tags: [...typeDef.tags] }, owner: def.id });
      }
      // Reloads reuse the surviving state, so Shift+R loses nothing.
      if (!states.has(def.id)) states.set(def.id, {});
      const sys: LoadedSystem = { def, state: states.get(def.id)! };
      order.push(sys);
      byId.set(def.id, sys);
      withCtx(def, sys.state, () => def.migrate?.(world));
    },

    unloadSystem: (id) => {
      const sys = byId.get(id);
      if (!sys) throw new Error(`system "${id}" is not loaded`);
      order.splice(order.indexOf(sys), 1);
      byId.delete(id);
      for (const [type, entry] of [...registry.entries()]) {
        if (entry.owner === id) registry.delete(type);
      }
      // State deliberately survives, so a reload keeps the world intact.
    },

    get systems() {
      return order.map((s) => s.def.id);
    },

    tick: () => {
      ticks++;
      for (const sys of [...order]) {
        withCtx(sys.def, sys.state, () => sys.def.onTick?.(world, DT));
      }
      for (const [id, slide] of [...slides.entries()]) {
        if (ticks >= slide.t0 + SLIDE_TICKS) slides.delete(id);
      }
      for (const [id, tween] of [...tweens.entries()]) {
        if (--tween.left <= 0) tweens.delete(id);
      }
      particles = particles.filter((p) => --p.ttl > 0);
      texts = texts.filter((t) => --t.ttl > 0);
      if (tint && --tint.left <= 0) tint = null;
      if (banner && --banner.ttl <= 0) banner = null;
    },

    get ticks() {
      return ticks;
    },

    serialize: () =>
      JSON.stringify({
        v: SAVE_VERSION,
        ticks,
        nextId,
        day,
        hour,
        rng: rng.state,
        tiles,
        entities: [...entities.values()]
          .sort((a, b) => a.id - b.id)
          .map((e) => ({
            id: e.id,
            type: e.type,
            pos: e.pos ? { ...e.pos } : null,
            tags: [...e.tags],
            comps: e.comps,
          })),
        states: Object.fromEntries(states),
      }),

    deserialize: (save) => {
      const data = JSON.parse(save) as {
        v: number;
        ticks: number;
        nextId: number;
        day: number;
        hour: number;
        rng: number;
        tiles: string[];
        entities: Array<{
          id: number;
          type: string;
          pos: Pos | null;
          tags: string[];
          comps: Record<string, unknown>;
        }>;
        states: Record<string, Record<string, unknown>>;
      };
      if (data.v !== SAVE_VERSION) {
        throw new Error(`unsupported save version ${data.v} (expected ${SAVE_VERSION})`);
      }
      for (const e of data.entities) {
        if (!registry.has(e.type)) {
          throw new Error(`cannot restore: entity type "${e.type}" is not registered (load its system first)`);
        }
      }
      for (const spriteId of data.tiles) getSprite(spriteId); // throws unknown sprite
      for (const rec of entities.values()) rec.alive = false; // old handles now throw
      entities.clear();
      handles.clear();
      occupancy.clear();
      slides.clear();
      tweens.clear();
      violations.length = 0;
      particles = [];
      texts = [];
      tint = null;
      banner = null;
      ticks = data.ticks;
      nextId = data.nextId;
      day = data.day;
      hour = data.hour;
      rng.state = data.rng;
      tiles = [...data.tiles];
      states.clear();
      for (const [id, state] of Object.entries(data.states)) states.set(id, state);
      for (const e of data.entities) {
        const rec: EntityRecord = {
          id: e.id,
          type: e.type,
          pos: e.pos ? { ...e.pos } : null,
          tags: new Set(e.tags),
          comps: e.comps,
          alive: true,
        };
        entities.set(rec.id, rec);
        index(rec);
      }
    },

    snapshot: () => world.serialize(),
    restore: (save: string) => world.deserialize(save),
  };

  (world as unknown as { [k: symbol]: WorldInternals })[INNER] = {
    slides,
    tweens,
    violations,
    get particles() {
      return particles;
    },
    get texts() {
      return texts;
    },
    get tintState() {
      return tint;
    },
    get bannerState() {
      return banner;
    },
    hud,
    mapSize: () => ({ w: map.width, h: map.height }),
    allEntities: () =>
      [...entities.values()].sort((a, b) => a.id - b.id).map((rec) => handle(rec)),
    withStateContext: <T>(systemId: string, fn: () => T): T => {
      if (!states.has(systemId)) states.set(systemId, {});
      // Test/harness code gets the system's state but is never the emitting
      // system, so its sim inputs and trigger events stay unattributed.
      return withCtx(null, states.get(systemId)!, fn);
    },
    systemState: (id: string) => states.get(id),
  };

  for (const spawn of map.spawns) world.spawn(spawn.type, { x: spawn.x, y: spawn.y });
  const player = world.spawn('player', { ...map.playerStart });
  player.set('facing', 'down' satisfies Dir);

  return world;
}

function inMap(map: MapData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}
