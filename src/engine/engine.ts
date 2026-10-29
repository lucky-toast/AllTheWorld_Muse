import type { CatalogEntry, Entity, GameEvent, Pos, SystemDef, World } from "./api";
import { catalogFind, catalogGet, footprintTiles } from "./catalog";
import { TUNING, phaseAt } from "../tuning";

export interface EntityType { sprite: string; tags: string[] }
export type Handler = (ev: GameEvent, world: World) => void;

interface EntRec {
  id: number; type: string; pos: Pos | null; tags: Set<string>;
  comps: Map<string, unknown>; alive: boolean;
  slideFrom: Pos | null; slideTo: Pos | null; slideT: number;
}
interface LoadedSystem { def: SystemDef; state: Record<string, unknown>; order: number }

/** Short, JSON-safe summary of an event payload / component value for pipeline reports. */
export function summarizeValue(v: unknown): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  if (Array.isArray(v)) return v.slice(0, 6).map(summarizeValue);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.id === "number" && typeof o.type === "string" && "pos" in o) return { entity: `${o.type}#${o.id}`, pos: o.pos ?? null };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o).slice(0, 8)) out[k] = summarizeValue(val);
    return out;
  }
  return String(v);
}
export function summarizePayload(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data).slice(0, 8)) out[k] = summarizeValue(v);
  return out;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class Engine {
  width: number; height: number;
  tilesGrid: string[][];
  entities = new Map<number, EntRec>();
  occupancy = new Map<string, Set<number>>();
  nextId = 1;
  tickCount = 0;
  rng: () => number; rngCalls = 0;
  hour = 9; day = 1; // start in the morning
  timeSpeed = 1;
  systems: LoadedSystem[] = [];
  loadOrder: string[] = [];
  types = new Map<string, EntityType>();
  typeOwner = new Map<string, string>(); // type name -> system id or "world"
  handlers = new Map<string, { sys: LoadedSystem | null; fn: Handler }[]>();
  currentSystem: LoadedSystem | null = null;
  emitLog: { sys: string; name: string }[] = [];
  handledLog: { sys: string; name: string }[] = [];
  fxEffects: { kind: string; spriteId?: string; text?: string; color?: string; x: number; y: number; vx: number; vy: number; life: number; maxLife: number; frame: number }[] = [];
  tweens: { from: number; to: number; ticks: number; t: number; onUpdate: (v: number) => void; onDone?: () => void; sys: LoadedSystem | null }[] = [];
  screenTint: { color: string; alpha: number; t: number; max: number } | null = null;
  banner: { text: string; t: number } | null = null;
  hudSlots = new Map<string, { icon?: string; text: string; width: number }>();
  testMode = false;
  // Pipeline instrumentation (capture is off unless a test/sandbox run turns it on).
  capturing = false;
  capEvents: { tick: number; name: string; payload: Record<string, unknown> }[] = [];
  capInputs: { name: string; handledBy: string; receivedBy: string[] }[] = [];
  capSpawned: number[] = [];
  thrownInfo: { system: string; handler: string; message: string } | null = null;
  beginCapture() { this.capturing = true; this.capEvents = []; this.capInputs = []; this.capSpawned = []; this.thrownInfo = null; }
  endCapture() { this.capturing = false; }

  constructor(width: number, height: number, tilesGrid: string[][], seed = TUNING.seed) {
    this.width = width; this.height = height; this.tilesGrid = tilesGrid;
    this.rng = mulberry(seed);
  }
  rand(): number { this.rngCalls++; return this.rng(); }

  // ---- entity types ----
  registerType(name: string, t: EntityType, owner: string) { this.types.set(name, t); this.typeOwner.set(name, owner); }
  unregisterSystemTypes(owner: string) { for (const [n, o] of [...this.typeOwner]) if (o === owner) { this.types.delete(n); this.typeOwner.delete(n); } }

  // ---- occupancy ----
  key(x: number, y: number) { return x + "," + y; }
  spriteIdOf(rec: EntRec): string { const s = rec.comps.get("sprite") as { id: string } | undefined; return s?.id ?? this.types.get(rec.type)?.sprite ?? ""; }
  rebuildOccupancyFor(rec: EntRec) {
    for (const set of this.occupancy.values()) set.delete(rec.id);
    if (!rec.pos || !rec.alive) return;
    for (const t of footprintTiles(this.spriteIdOf(rec), rec.pos.x, rec.pos.y)) {
      const k = this.key(t.x, t.y); if (!this.occupancy.has(k)) this.occupancy.set(k, new Set());
      this.occupancy.get(k)!.add(rec.id);
    }
  }
  atIds(x: number, y: number): number[] { return [...(this.occupancy.get(this.key(x, y)) ?? [])]; }

  handle(rec: EntRec): Entity {
    const eng = this;
    const e: Entity = {
      get id() { return rec.id; }, get type() { return rec.type; },
      get pos() { return rec.pos ? { ...rec.pos } : null; },
      has(n) { return rec.tags.has(n) || rec.comps.has(n); },
      tag(n) { rec.tags.add(n); }, untag(n) { rec.tags.delete(n); },
      get(n) { return rec.comps.get(n) as never; },
      set(n, v) { rec.comps.set(n, v); if (n === "sprite") eng.rebuildOccupancyFor(rec); },
      add(n, v) { rec.comps.set(n, v); if (n === "sprite") eng.rebuildOccupancyFor(rec); },
      remove(n) { rec.comps.delete(n); if (n === "sprite") eng.rebuildOccupancyFor(rec); },
      moveTo(x, y, opts) {
        const from = rec.pos ? { ...rec.pos } : null;
        rec.pos = { x, y }; eng.rebuildOccupancyFor(rec);
        if (opts?.instant || !from) { rec.slideFrom = null; rec.slideTo = null; rec.slideT = 0; }
        else { rec.slideFrom = from; rec.slideTo = { x, y }; rec.slideT = TUNING.slideTicks; }
      },
      lift() { rec.pos = null; rec.slideFrom = null; rec.slideTo = null; eng.rebuildOccupancyFor(rec); },
      place(x, y) { rec.pos = { x, y }; rec.slideFrom = null; rec.slideTo = null; eng.rebuildOccupancyFor(rec); },
      destroy() { rec.alive = false; rec.pos = null; eng.rebuildOccupancyFor(rec); eng.entities.delete(rec.id); },
    };
    return e;
  }
  spawnRec(type: string, pos: Pos): EntRec {
    const t = this.types.get(type);
    if (!t) throw new Error(`spawn: unknown entity type "${type}". Registered types: ${[...this.types.keys()].sort().join(", ")}. (Bare catalog sprite ids are not types unless a type with that name is registered.)`);
    const rec: EntRec = { id: this.nextId++, type, pos: { ...pos }, tags: new Set(t.tags), comps: new Map(), alive: true, slideFrom: null, slideTo: null, slideT: 0 };
    rec.comps.set("sprite", { id: t.sprite });
    this.entities.set(rec.id, rec); this.rebuildOccupancyFor(rec);
    if (this.capturing) this.capSpawned.push(rec.id);
    return rec;
  }
  byId(id: number): Entity | undefined { const r = this.entities.get(id); return r ? this.handle(r) : undefined; }
  player(): Entity | undefined { return this.query("player")[0]; }
  query(tagOrComponent: string): Entity[] { return [...this.entities.values()].filter((r) => r.alive && (r.tags.has(tagOrComponent) || r.comps.has(tagOrComponent))).map((r) => this.handle(r)); }

  isWalkable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const id = this.tilesGrid[y][x]; const entry = catalogGet(id);
    if (!entry) return false;
    return entry.tags.includes("walkable") && !entry.tags.includes("water");
  }
  /** A tile is free for X when walkable and holding no player/solid/pushable/item entity other than X. */
  isFreeFor(x: number, y: number, selfId?: number): boolean {
    if (!this.isWalkable(x, y)) return false;
    for (const id of this.atIds(x, y)) {
      if (id === selfId) continue; const r = this.entities.get(id); if (!r) continue;
      const h = this.handle(r);
      if (h.has("player") || h.has("solid") || h.has("pushable") || h.has("item")) return false;
    }
    return true;
  }
  footprintFreeFor(spriteId: string, x: number, y: number, selfId?: number): boolean {
    return footprintTiles(spriteId, x, y).every((t) => this.isFreeFor(t.x, t.y, selfId));
  }

  // ---- events ----
  on(name: string, sys: LoadedSystem | null, fn: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name)!.push({ sys, fn });
  }
  emitAs(sys: LoadedSystem | null, name: string, data: Record<string, unknown> = {}): GameEvent {
    const ev: GameEvent = { handled: false, ...data };
    this.emitLog.push({ sys: sys?.def.id ?? this.currentSystem?.def.id ?? "(engine)", name });
    if (this.capturing) this.capEvents.push({ tick: this.tickCount, name, payload: summarizePayload(data) });
    const receivedBy: string[] = []; let handledBy = "none";
    for (const h of [...(this.handlers.get(name) ?? [])]) {
      const before = ev.handled; const prev = this.currentSystem; this.currentSystem = h.sys;
      receivedBy.push(h.sys?.def.id ?? "(engine)");
      try { h.fn(ev, this.facade(h.sys)); } catch (err) {
        this.thrownInfo = { system: h.sys?.def.id ?? "(engine)", handler: name, message: (err as Error).message };
        this.currentSystem = prev; throw err;
      }
      if (!before && ev.handled && h.sys) { this.handledLog.push({ sys: h.sys.def.id, name }); handledBy = h.sys.def.id; }
      this.currentSystem = prev;
    }
    if (this.capturing && name.startsWith("input.")) this.capInputs.push({ name, handledBy, receivedBy });
    return ev;
  }
  /** True when the occupancy lookup exactly matches every live entity's footprint. */
  validateOccupancy(): boolean {
    const want = new Map<string, Set<number>>();
    for (const r of this.entities.values()) {
      if (!r.pos) continue;
      for (const t of footprintTiles(this.spriteIdOf(r), r.pos.x, r.pos.y)) { const k = this.key(t.x, t.y); if (!want.has(k)) want.set(k, new Set()); want.get(k)!.add(r.id); }
    }
    const norm = (m: Map<string, Set<number>>) => [...m.entries()].filter(([, s]) => s.size).map(([k, s]) => k + ":" + [...s].sort((a, b) => a - b).join(".")).sort().join("|");
    return norm(want) === norm(this.occupancy);
  }
  entitySummary(id: number): { type: string; pos: Pos | null; components: Record<string, unknown> } | null {
    const r = this.entities.get(id); if (!r) return null;
    const components: Record<string, unknown> = {};
    for (const [k, v] of r.comps) components[k] = summarizeValue(v);
    return { type: r.type, pos: r.pos ? { ...r.pos } : null, components };
  }
  emit(name: string, data: Record<string, unknown> = {}): GameEvent { return this.emitAs(this.currentSystem, name, data); }
  /** Send an input event (handled flag honoured in load order). */
  emitInput(name: string, data: Record<string, unknown> = {}): GameEvent { return this.emitAs(null, name, data); }

  facade(sys: LoadedSystem | null): World {
    const eng = this;
    const w: World = {
      at: (x, y) => eng.atIds(x, y).map((id) => eng.byId(id)!).filter(Boolean),
      query: (t) => eng.query(t),
      spawn: (type, pos) => eng.handle(eng.spawnRec(type, pos)),
      tiles: {
        get: (x, y) => (x < 0 || y < 0 || x >= eng.width || y >= eng.height ? null : eng.tilesGrid[y][x]),
        set: (x, y, id) => { if (x >= 0 && y >= 0 && x < eng.width && y < eng.height) eng.tilesGrid[y][x] = id; },
        find: (tag) => { const out: Pos[] = []; for (let y = 0; y < eng.height; y++) for (let x = 0; x < eng.width; x++) if (catalogGet(eng.tilesGrid[y][x])?.tags.includes(tag)) out.push({ x, y }); return out; },
      },
      on: (name, handler) => eng.on(name, sys, handler),
      emit: (name, data) => eng.emitAs(sys, name, data ?? {}),
      time: {
        get day() { return eng.day; }, get phase() { return phaseAt(eng.hour); }, get hour() { return eng.hour; },
        set(v) { eng.setTime(v, sys); },
      },
      rand: () => eng.rand(),
      catalog: { find: catalogFind, get: catalogGet as (id: string) => CatalogEntry | undefined },
      fx: {
        tween: (o) => eng.tweens.push({ ...o, t: 0, sys }),
        particles: (spriteId, pos) => { for (let i = 0; i < 6; i++) eng.fxEffects.push({ kind: "particle", spriteId, x: pos.x, y: pos.y, vx: (eng.rand() - 0.5) * 0.08, vy: -eng.rand() * 0.08, life: 0, maxLife: 24, frame: Math.floor(eng.rand() * 6) }); },
        floatText: (text, pos, color) => eng.fxEffects.push({ kind: "text", text, color: color ?? "#fff", x: pos.x, y: pos.y, vx: 0, vy: -0.02, life: 0, maxLife: 50, frame: 0 }),
        tint: (color, alpha, durationMs) => { eng.screenTint = { color, alpha, t: 0, max: Math.max(1, Math.round((durationMs / 1000) * 60)) }; },
      },
      ui: {
        banner: (text) => { eng.banner = { text, t: TUNING.bannerTicks }; },
        hud: { add: (id, o) => eng.hudSlots.set(id, o), remove: (id) => eng.hudSlots.delete(id) },
      },
      state: sys ? sys.state : {},
    };
    return w;
  }
  world(): World { return this.facade(null); }

  setTime(v: string | number, sys: LoadedSystem | null) {
    const from = { hour: this.hour, day: this.day, phase: phaseAt(this.hour) };
    if (typeof v === "number") { this.hour = ((v % 24) + 24) % 24; }
    else { const starts: Record<string, number> = { dawn: TUNING.phases.dawn, day: TUNING.phases.day, dusk: TUNING.phases.dusk, night: TUNING.phases.night, daytime: TUNING.phases.day }; this.hour = starts[v] ?? this.hour; }
    const to = { hour: this.hour, day: this.day, phase: phaseAt(this.hour) };
    // Attributed to daynight in contract checks: it owns every time.* event.
    const dn = this.systems.find((s) => s.def.id === "daynight") ?? sys;
    this.emitAs(dn, "time.jumped", { from, to });
    // Phase event itself is emitted by daynight on its next tick (it tracks lastPhase).
  }

  // ---- systems ----
  loadSystem(def: SystemDef) {
    const existing = this.systems.findIndex((s) => s.def.id === def.id);
    this.unloadSystem(def.id, true);
    const loaded: LoadedSystem = { def, state: existing >= 0 ? this.systems[existing]?.state ?? {} : {}, order: existing >= 0 ? existing : this.systems.length };
    // Preserve state/order on reload:
    if (existing >= 0) { loaded.state = (this as unknown as { _saved?: Record<string, unknown> })._saved ?? loaded.state; }
    for (const [name, t] of Object.entries(def.entities)) this.registerType(name, t, def.id);
    if (existing >= 0) this.systems.splice(existing, 0, loaded); else this.systems.push(loaded);
    if (!this.loadOrder.includes(def.id)) this.loadOrder.push(def.id);
    for (const [name, fn] of Object.entries(def.on)) this.on(name, loaded, fn as Handler);
    const prev = this.currentSystem; this.currentSystem = loaded;
    def.migrate(this.facade(loaded));
    this.currentSystem = prev;
    return loaded;
  }
  unloadSystem(id: string, forReload = false) {
    const idx = this.systems.findIndex((s) => s.def.id === id); if (idx < 0) return;
    const [removed] = this.systems.splice(idx, 1);
    if (forReload) (this as unknown as { _saved?: Record<string, unknown> })._saved = removed.state;
    for (const [name, list] of this.handlers) this.handlers.set(name, list.filter((h) => h.sys !== removed));
    this.unregisterSystemTypes(id);
    if (!forReload) this.loadOrder = this.loadOrder.filter((x) => x !== id);
  }
  reloadAll(defs: SystemDef[]) {
    const order = [...this.loadOrder];
    const states = new Map(this.systems.map((s) => [s.def.id, s.state]));
    for (const id of [...order].reverse()) this.unloadSystem(id);
    for (const id of order) { const d = defs.find((x) => x.id === id); if (!d) continue; this.loadSystem(d); const l = this.systems.find((s) => s.def.id === id); if (l && states.has(id)) l.state = states.get(id)!; }
  }

  tick() {
    this.tickCount++;
    // Clock advances only while daynight is loaded; daynight emits the events.
    if (this.systems.some((s) => s.def.id === "daynight")) {
      const prevHour = this.hour;
      this.hour += (this.timeSpeed / TUNING.ticksPerGameHour);
      if (this.hour >= 24) this.hour -= 24;
      // Day goes up at dawn: crossing the dawn start from below.
      const dawn = TUNING.phases.dawn;
      if (prevHour < dawn && this.hour >= dawn && this.hour < dawn + 1) this.day++;
      if (prevHour > this.hour) { /* wrapped midnight: nothing */ }
    }
    for (const s of [...this.systems]) { const prev = this.currentSystem; this.currentSystem = s; s.def.onTick(this.facade(s), 1 / 60); this.currentSystem = prev; }
    for (const rec of this.entities.values()) if (rec.slideT > 0) rec.slideT--;
    for (const fx of this.fxEffects) { fx.life++; fx.x += fx.vx; fx.y += fx.vy; }
    this.fxEffects = this.fxEffects.filter((f) => f.life < f.maxLife);
    for (const tw of [...this.tweens]) { tw.t++; tw.onUpdate(tw.from + (tw.to - tw.from) * Math.min(1, tw.t / tw.ticks)); if (tw.t >= tw.ticks) { tw.onDone?.(); this.tweens.splice(this.tweens.indexOf(tw), 1); } }
    if (this.screenTint && ++this.screenTint.t >= this.screenTint.max) this.screenTint = null;
    if (this.banner && --this.banner.t <= 0) this.banner = null;
  }

  serialize(): string {
    return JSON.stringify({
      width: this.width, height: this.height, tiles: this.tilesGrid, day: this.day, hour: this.hour, tickCount: this.tickCount, nextId: this.nextId,
      entities: [...this.entities.values()].map((r) => ({ id: r.id, type: r.type, pos: r.pos, tags: [...r.tags], comps: [...r.comps.entries()] })),
      systemState: Object.fromEntries(this.systems.map((s) => [s.def.id, s.state])),
      loadOrder: this.loadOrder,
    });
  }
  deserialize(json: string) {
    const d = JSON.parse(json) as ReturnType<Engine["serialize"]> & Record<string, unknown>;
    const data = d as unknown as { tiles: string[][]; day: number; hour: number; tickCount: number; nextId: number; entities: { id: number; type: string; pos: Pos | null; tags: string[]; comps: [string, unknown][] }[]; systemState: Record<string, Record<string, unknown>>; loadOrder: string[] };
    this.tilesGrid = data.tiles.map((r) => [...r]); this.day = data.day; this.hour = data.hour; this.tickCount = data.tickCount; this.nextId = data.nextId;
    this.entities.clear(); this.occupancy.clear();
    for (const e of data.entities) { const rec: EntRec = { id: e.id, type: e.type, pos: e.pos, tags: new Set(e.tags), comps: new Map(e.comps), alive: true, slideFrom: null, slideTo: null, slideT: 0 }; this.entities.set(rec.id, rec); this.rebuildOccupancyFor(rec); }
    for (const s of this.systems) if (data.systemState[s.def.id]) s.state = data.systemState[s.def.id];
    this.loadOrder = data.loadOrder ?? this.loadOrder;
  }
  snapshot(): string { return this.serialize(); }
  restore(snap: string) { this.deserialize(snap); }
  /** Render interpolation position in tiles (float), for the renderer only. */
  renderPos(rec: { pos: Pos | null; slideFrom: Pos | null; slideTo: Pos | null; slideT: number }): Pos | null {
    if (!rec.pos) return null;
    if (rec.slideFrom && rec.slideTo && rec.slideT > 0) { const k = 1 - rec.slideT / TUNING.slideTicks; return { x: rec.slideFrom.x + (rec.slideTo.x - rec.slideFrom.x) * k, y: rec.slideFrom.y + (rec.slideTo.y - rec.slideFrom.y) * k }; }
    return rec.pos;
  }
  recById(id: number) { return this.entities.get(id); }
}
