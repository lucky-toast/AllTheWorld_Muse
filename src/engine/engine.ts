// Engine core (spec section 3): areas, entities, types, tiles, occupancy, clock,
// per-system RNG, ownership records, serialize/snapshot. Only the host dispatcher
// (src/engine/host.ts) writes the world on behalf of systems; the map builder and
// the renderer use this class directly because they are engine code.
//
// Every write goes through a primitive below that records its inverse in the open
// undo journal (if any), so a transaction can be rolled back exactly (spec 4.4).
import { catalogGet, footprintTiles } from "./catalog";
import { mulberryStep, streamSeed } from "./rng";
import { ENGINE_OWNER, type EntityType, type Pos, type SpriteComp } from "./types";
import { TUNING, phaseAt, type Phase } from "../tuning";

export interface EntRec {
  id: number; type: string; pos: Pos | null; tags: Set<string>; comps: Map<string, unknown>;
  /** Render-only slide state: where the last non-instant move started and ticks left. */
  slideFrom: Pos | null; slideT: number;
}
export interface Area { id: string; owner: string; tiles: string[][] }
export interface Particle { area: string; sprite: string; x: number; y: number; vx: number; vy: number; life: number; maxLife: number; frame: number }
export interface FloatText { area: string; text: string; color: string; x: number; y: number; life: number; maxLife: number }
export interface HudSlot { owner: string; key: string; text: string; width: number; icon?: string }
export interface Overlay { title?: string; lines: string[]; bar?: { value: number; label?: string } }
/** A pending `timer` or `anim` callback: onTimer(name) on `system` at tick `at`. */
export interface Timer { system: string; name: string; at: number; seq: number }
/** A running fx.tween: onTween(id, value) on `system` each tick until `t` reaches `ticks`. */
export interface Tween { id: number; system: string; from: number; to: number; ticks: number; t: number }
/** The E prompt: text drawn above tile (x, y) of `area`. */
export interface Prompt { text: string; x: number; y: number; area: string }

/** Deep copy of a plain-JSON value. */
export function cloneJson<T>(v: T): T { return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T); }

type Undo = () => void;

export class Engine {
  readonly width: number; readonly height: number; readonly seed: number;
  areas = new Map<string, Area>();
  entities = new Map<number, EntRec>();
  nextId = 1;
  tickCount = 0;
  // Clock. Advances only while `clockRunning` (daynight sets it when it loads, Phase 2).
  day = 1; hour: number = TUNING.startHour; timeSpeed = 1; clockRunning = false;
  // Registries and ownership records (spec 4.5). These restrict nothing.
  types = new Map<string, EntityType>();
  typeOwner = new Map<string, string>();
  componentOwner = new Map<string, string>();
  entityOwner = new Map<number, string>();
  /** Live entities per owner, for the per-system entity limit. */
  ownedCount = new Map<string, number>();
  systemState = new Map<string, unknown>();
  /** Saved RNG position per owner (spec 4.6). */
  rngState = new Map<string, number>();
  /** area id -> tile index (y * width + x) -> entity ids. All collision goes through this. */
  occupancy = new Map<string, Map<number, Set<number>>>();
  /** Undo journal of the open transaction, or null when none is open. */
  journal: Undo[] | null = null;
  /** Pending timer and anim callbacks, and running tweens (saved with the world). */
  timers: Timer[] = [];
  tweens: Tween[] = [];
  nextTimerSeq = 1;
  nextTweenId = 1;
  private playerCache = 0;

  // ---- Transient, render-only state (not serialized) ----
  particles: Particle[] = [];
  floats: FloatText[] = [];
  tint: { color: string; alpha: number; t: number; max: number } | null = null;
  banner: { text: string; t: number } | null = null;
  hudSlots = new Map<string, HudSlot>();
  overlay: { owner: string; value: Overlay } | null = null;
  /** Tick each entity's current sprite anim started, so anims play from their first frame. */
  animStart = new Map<number, number>();
  /** The E prompt the interaction resolver wants drawn, or null. */
  prompt: Prompt | null = null;

  constructor(width: number = TUNING.areaW, height: number = TUNING.areaH, seed: number = TUNING.seed) {
    this.width = width; this.height = height; this.seed = seed;
  }

  // ======================= journal =======================
  private record(u: Undo) { if (this.journal) this.journal.push(u); }
  /** Journal an undo step for engine state kept outside the world primitives (focus, for example). */
  recordUndo(u: Undo) { this.record(u); }
  /** Undo every journaled write after `mark` (newest first). */
  rollbackTo(mark: number) {
    const j = this.journal; if (!j) return;
    this.journal = null;
    try { while (j.length > mark) j.pop()!(); } finally { this.journal = j; }
  }

  // ======================= registries =======================
  registerType(name: string, t: EntityType, owner: string) {
    this.types.set(name, { sprite: t.sprite, tags: [...t.tags] }); this.typeOwner.set(name, owner);
  }
  declareComponent(name: string, owner: string) { if (!this.componentOwner.has(name)) this.componentOwner.set(name, owner); }

  // ======================= areas & tiles =======================
  /** Create an area from a full tile grid. Journaled. */
  createArea(id: string, tiles: string[][], owner: string): Area {
    if (this.areas.has(id)) throw new Error(`area ${id} exists`);
    const a: Area = { id, owner, tiles: tiles.map((r) => [...r]) };
    this.areas.set(id, a); this.occupancy.set(id, new Map());
    this.record(() => { this.areas.delete(id); this.occupancy.delete(id); });
    return a;
  }
  inMap(x: number, y: number) { return x >= 0 && y >= 0 && x < this.width && y < this.height && Number.isInteger(x) && Number.isInteger(y); }
  tileAt(area: string, x: number, y: number): string | null {
    const a = this.areas.get(area); if (!a || !this.inMap(x, y)) return null; return a.tiles[y][x];
  }
  /** Set a terrain tile. Journaled. */
  setTile(area: string, x: number, y: number, sprite: string) {
    const a = this.areas.get(area)!; const old = a.tiles[y][x];
    a.tiles[y][x] = sprite;
    this.record(() => { a.tiles[y][x] = old; });
  }
  /** Walkable terrain: in the map, tagged walkable and not water. The map edge always blocks. */
  isWalkable(area: string, x: number, y: number): boolean {
    const id = this.tileAt(area, x, y); if (id === null) return false;
    const e = catalogGet(id); if (!e) return false;
    return e.tags.includes("walkable") && !e.tags.includes("water");
  }

  // ======================= entities =======================
  has(rec: EntRec, name: string) { return rec.tags.has(name) || rec.comps.has(name); }
  spriteIdOf(rec: EntRec): string { const s = rec.comps.get("sprite") as SpriteComp | undefined; return s?.id ?? this.types.get(rec.type)?.sprite ?? ""; }
  footprintOfRec(rec: EntRec, pos: Pos | null = rec.pos): { x: number; y: number }[] {
    if (!pos) return []; return footprintTiles(this.spriteIdOf(rec), pos.x, pos.y);
  }
  private occAdd(rec: EntRec) {
    if (!rec.pos) return; const m = this.occupancy.get(rec.pos.area); if (!m) return;
    for (const t of this.footprintOfRec(rec)) {
      if (!this.inMap(t.x, t.y)) continue;
      const k = t.y * this.width + t.x; let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(rec.id);
    }
  }
  private occRemove(rec: EntRec) {
    if (!rec.pos) return; const m = this.occupancy.get(rec.pos.area); if (!m) return;
    for (const t of this.footprintOfRec(rec)) {
      if (!this.inMap(t.x, t.y)) continue;
      const k = t.y * this.width + t.x; const s = m.get(k); if (s) { s.delete(rec.id); if (!s.size) m.delete(k); }
    }
  }
  private insertRaw(rec: EntRec, owner: string) {
    this.entities.set(rec.id, rec); this.occAdd(rec);
    this.entityOwner.set(rec.id, owner); this.ownedCount.set(owner, (this.ownedCount.get(owner) ?? 0) + 1);
  }
  private deleteRaw(rec: EntRec) {
    this.occRemove(rec); this.entities.delete(rec.id);
    const owner = this.entityOwner.get(rec.id); this.entityOwner.delete(rec.id);
    if (owner !== undefined) this.ownedCount.set(owner, (this.ownedCount.get(owner) ?? 1) - 1);
    this.animStart.delete(rec.id);
  }
  /** Spawn a registered type at a position. Throws on an unknown type. Journaled. */
  spawn(type: string, pos: Pos | null, owner: string): EntRec {
    const t = this.types.get(type);
    if (!t) throw new Error(`unknown entity type "${type}"`);
    const prevNext = this.nextId;
    const rec: EntRec = { id: this.nextId++, type, pos: pos ? { ...pos } : null, tags: new Set(t.tags), comps: new Map([["sprite", { id: t.sprite }]]), slideFrom: null, slideT: 0 };
    this.insertRaw(rec, owner);
    this.record(() => { this.deleteRaw(rec); this.nextId = prevNext; });
    return rec;
  }
  /** Remove an entity. Journaled (the record is kept intact for undo). */
  destroy(id: number) {
    const rec = this.entities.get(id); if (!rec) return;
    const owner = this.entityOwner.get(id) ?? ENGINE_OWNER;
    this.deleteRaw(rec);
    this.record(() => this.insertRaw(rec, owner));
  }
  /** Move, place (pos) or lift (null) an entity. `slide` animates the step. Journaled. */
  setPos(id: number, pos: Pos | null, slide = false) {
    const rec = this.entities.get(id)!;
    const old = { pos: rec.pos, slideFrom: rec.slideFrom, slideT: rec.slideT };
    this.occRemove(rec);
    rec.pos = pos ? { ...pos } : null;
    if (slide && old.pos && pos && old.pos.area === pos.area) { rec.slideFrom = { ...old.pos }; rec.slideT = TUNING.slideTicks; }
    else { rec.slideFrom = null; rec.slideT = 0; }
    this.occAdd(rec);
    this.record(() => { this.occRemove(rec); rec.pos = old.pos; rec.slideFrom = old.slideFrom; rec.slideT = old.slideT; this.occAdd(rec); });
  }
  /** Set (or with `undefined`, remove) a component. A sprite change updates occupancy. Journaled. */
  setComp(id: number, name: string, value: unknown) {
    const rec = this.entities.get(id)!;
    const had = rec.comps.has(name); const old = rec.comps.get(name);
    const apply = (present: boolean, v: unknown) => {
      if (name === "sprite") this.occRemove(rec);
      if (present) rec.comps.set(name, v); else rec.comps.delete(name);
      if (name === "sprite") this.occAdd(rec);
    };
    apply(value !== undefined, value);
    this.record(() => apply(had, old));
  }
  /** Add or remove a tag. Journaled. */
  setTag(id: number, name: string, on: boolean) {
    const rec = this.entities.get(id)!; const had = rec.tags.has(name);
    if (on) rec.tags.add(name); else rec.tags.delete(name);
    this.record(() => { if (had) rec.tags.add(name); else rec.tags.delete(name); });
  }
  setState(owner: string, value: unknown) {
    const had = this.systemState.has(owner); const old = this.systemState.get(owner);
    if (value === undefined) this.systemState.delete(owner); else this.systemState.set(owner, value);
    this.record(() => { if (had) this.systemState.set(owner, old); else this.systemState.delete(owner); });
  }
  /** Next number in [0, 1) from `owner`'s own stream. Journaled, so a rollback rewinds it. */
  rand(owner: string): number {
    const had = this.rngState.has(owner);
    const cur = had ? this.rngState.get(owner)! : streamSeed(this.seed, owner);
    const { state, value } = mulberryStep(cur);
    this.rngState.set(owner, state);
    this.record(() => { if (had) this.rngState.set(owner, cur); else this.rngState.delete(owner); });
    return value;
  }

  // ======================= reads =======================
  rec(id: number): EntRec | undefined { return this.entities.get(id); }
  player(): EntRec | undefined {
    const c = this.entities.get(this.playerCache);
    if (c && c.tags.has("player")) return c;
    for (const r of this.entities.values()) if (r.tags.has("player")) { this.playerCache = r.id; return r; }
    return undefined;
  }
  /** The player's current area (the one that is drawn and used by the E resolver). */
  currentArea(): string { return this.player()?.pos?.area ?? [...this.areas.keys()][0]; }
  /** Ids whose footprint covers the tile, ascending. */
  at(area: string, x: number, y: number): number[] {
    if (!this.inMap(x, y)) return [];
    const s = this.occupancy.get(area)?.get(y * this.width + x); return s ? [...s].sort((a, b) => a - b) : [];
  }
  /** Ids of entities with this tag or component, ascending. */
  query(name: string): number[] {
    const out: number[] = []; for (const r of this.entities.values()) if (this.has(r, name)) out.push(r.id);
    return out.sort((a, b) => a - b);
  }
  /** Free tile for entity X: walkable and no player, solid, pushable or item entity other than X. Decorations don't count. */
  isFreeFor(area: string, x: number, y: number, selfId = 0): boolean {
    if (!this.isWalkable(area, x, y)) return false;
    for (const id of this.at(area, x, y)) {
      if (id === selfId) continue; const r = this.entities.get(id)!;
      if (this.has(r, "player") || this.has(r, "solid") || this.has(r, "pushable") || this.has(r, "item")) return false;
    }
    return true;
  }
  /** Every footprint tile of `spriteId` at `pos` is free for `selfId`. */
  footprintFree(spriteId: string, pos: Pos, selfId = 0): boolean {
    return footprintTiles(spriteId, pos.x, pos.y).every((t) => this.isFreeFor(pos.area, t.x, t.y, selfId));
  }

  // ======================= invariants =======================
  /** Why this entity breaks an invariant (footprint off walkable terrain), or null. */
  entityProblem(rec: EntRec): string | null {
    if (!rec.pos) return null;
    if (!this.areas.has(rec.pos.area)) return `${rec.type}#${rec.id} is in unknown area ${rec.pos.area}`;
    for (const t of this.footprintOfRec(rec)) if (!this.isWalkable(rec.pos.area, t.x, t.y)) return `${rec.type}#${rec.id} would stand on unwalkable tile (${t.x}, ${t.y}) in ${rec.pos.area}`;
    return null;
  }
  /** True when the occupancy lookup exactly matches every live entity's footprint, in every area. */
  validateOccupancy(): boolean {
    const want = new Map<string, Set<number>>();
    for (const r of this.entities.values()) {
      if (!r.pos) continue;
      for (const t of this.footprintOfRec(r)) { if (!this.inMap(t.x, t.y)) continue; const k = `${r.pos.area}|${t.y * this.width + t.x}`; if (!want.has(k)) want.set(k, new Set()); want.get(k)!.add(r.id); }
    }
    const have = new Map<string, Set<number>>();
    for (const [area, m] of this.occupancy) for (const [k, s] of m) if (s.size) have.set(`${area}|${k}`, s);
    const norm = (m: Map<string, Set<number>>) => [...m.entries()].map(([k, s]) => k + ":" + [...s].sort((a, b) => a - b).join(".")).sort().join(" ");
    return norm(want) === norm(have);
  }
  /** Every invariant over the whole world (used by tests and the world check). */
  invariantProblems(): string[] {
    const out: string[] = [];
    if (!this.player()) out.push("the player does not exist");
    for (const r of this.entities.values()) { const p = this.entityProblem(r); if (p) out.push(p); }
    if (!this.validateOccupancy()) out.push("occupancy does not match positions");
    return out;
  }

  // ======================= clock =======================
  get phase(): Phase { return phaseAt(this.hour); }
  /** Jump the clock to a phase start or an hour. Returns the hours before and after. */
  jumpClock(to: string | number): { from: number; to: number } {
    const from = this.hour;
    if (typeof to === "number") this.hour = ((to % 24) + 24) % 24;
    else { const starts: Record<string, number> = { ...TUNING.phases, daytime: TUNING.phases.day }; if (starts[to] !== undefined) this.hour = starts[to]; }
    return { from, to: this.hour };
  }
  private tickClock() {
    if (!this.clockRunning) return;
    const prev = this.hour;
    this.hour += this.timeSpeed / TUNING.ticksPerGameHour;
    if (this.hour >= 24) this.hour -= 24;
    // The day goes up when the clock crosses dawn.
    const dawn = TUNING.phases.dawn;
    if (prev < dawn && this.hour >= dawn && this.hour < dawn + 1) this.day++;
  }

  // ======================= tick =======================
  /** One fixed logic step of the engine itself: clock, slides and effects. Systems run from Host.tick. */
  tick() {
    this.tickCount++;
    this.tickClock();
    for (const r of this.entities.values()) if (r.slideT > 0 && --r.slideT === 0) r.slideFrom = null;
    for (const p of this.particles) { p.life++; p.x += p.vx; p.y += p.vy; }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);
    for (const f of this.floats) { f.life++; f.y -= 0.02; }
    this.floats = this.floats.filter((f) => f.life < f.maxLife);
    if (this.tint && ++this.tint.t >= this.tint.max) this.tint = null;
    if (this.banner && --this.banner.t <= 0) this.banner = null;
  }

  // ======================= save =======================
  serialize(): string {
    const sorted = [...this.entities.values()].sort((a, b) => a.id - b.id);
    return JSON.stringify({
      v: 1, width: this.width, height: this.height, seed: this.seed, nextId: this.nextId, tickCount: this.tickCount,
      clock: { day: this.day, hour: this.hour, running: this.clockRunning },
      areas: [...this.areas.values()].map((a) => ({ id: a.id, owner: a.owner, tiles: a.tiles })),
      entities: sorted.map((r) => ({ id: r.id, type: r.type, pos: r.pos, tags: [...r.tags], comps: Object.fromEntries(r.comps), owner: this.entityOwner.get(r.id) ?? ENGINE_OWNER })),
      types: Object.fromEntries([...this.types].map(([n, t]) => [n, { ...t, owner: this.typeOwner.get(n) ?? ENGINE_OWNER }])),
      components: Object.fromEntries(this.componentOwner),
      state: Object.fromEntries(this.systemState),
      rng: Object.fromEntries(this.rngState),
      timers: this.timers, tweens: this.tweens, nextTimerSeq: this.nextTimerSeq, nextTweenId: this.nextTweenId,
    });
  }
  deserialize(json: string) {
    const d = JSON.parse(json) as SaveFile;
    if (d.width !== this.width || d.height !== this.height) throw new Error("saved world has a different size");
    this.journal = null;
    this.nextId = d.nextId; this.tickCount = d.tickCount;
    this.day = d.clock.day; this.hour = d.clock.hour; this.clockRunning = d.clock.running;
    this.areas.clear(); this.occupancy.clear();
    for (const a of d.areas) { this.areas.set(a.id, { id: a.id, owner: a.owner, tiles: a.tiles.map((r) => [...r]) }); this.occupancy.set(a.id, new Map()); }
    for (const [n, t] of Object.entries(d.types)) { this.types.set(n, { sprite: t.sprite, tags: [...t.tags] }); this.typeOwner.set(n, t.owner); }
    this.componentOwner = new Map(Object.entries(d.components));
    this.entities.clear(); this.entityOwner.clear(); this.ownedCount.clear(); this.animStart.clear(); this.playerCache = 0;
    for (const e of d.entities) this.insertRaw({ id: e.id, type: e.type, pos: e.pos, tags: new Set(e.tags), comps: new Map(Object.entries(e.comps)), slideFrom: null, slideT: 0 }, e.owner);
    this.systemState = new Map(Object.entries(d.state));
    this.rngState = new Map(Object.entries(d.rng));
    this.timers = (d.timers ?? []).map((t) => ({ ...t })); this.tweens = (d.tweens ?? []).map((t) => ({ ...t }));
    this.nextTimerSeq = d.nextTimerSeq ?? 1; this.nextTweenId = d.nextTweenId ?? 1;
  }
  snapshot(): string { return this.serialize(); }
  restore(snap: string) {
    this.deserialize(snap);
    this.particles = []; this.floats = []; this.tint = null; this.banner = null;
  }
}

interface SaveFile {
  v: number; width: number; height: number; seed: number; nextId: number; tickCount: number;
  clock: { day: number; hour: number; running: boolean };
  areas: { id: string; owner: string; tiles: string[][] }[];
  entities: { id: number; type: string; pos: Pos | null; tags: string[]; comps: Record<string, unknown>; owner: string }[];
  types: Record<string, EntityType & { owner: string }>;
  components: Record<string, string>;
  state: Record<string, unknown>;
  rng: Record<string, number>;
  timers?: Timer[]; tweens?: Tween[]; nextTimerSeq?: number; nextTweenId?: number;
}
