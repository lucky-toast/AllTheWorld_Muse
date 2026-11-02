import { catalogGet, footprintTiles } from "./catalog";
import { TUNING, phaseAt, type Phase } from "../tuning";
import { Host } from "./host";

export interface Pos { x: number; y: number; area: string }
export interface EntityType { sprite: string; tags: string[] }

export interface EntRec {
  id: number;
  type: string;
  pos: Pos | null;
  tags: Set<string>;
  comps: Map<string, unknown>;
  slideFrom: Pos | null;
  slideTo: Pos | null;
  slideT: number;
}

export interface Area {
  id: string;
  tiles: string[][];
  occupancy: Map<string, Set<number>>;
}

export interface FxEffect {
  kind: "particle" | "text";
  spriteId?: string;
  text?: string;
  color?: string;
  x: number;
  y: number;
  area: string;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  frame: number;
}

export interface HudSlot { owner: string; icon?: string; text: string; width: number }
export interface OverlayState { title?: string; lines: string[]; bar?: { value: number; label?: string } }

interface RngStream { a: number; calls: number }

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine {
  readonly host: Host;
  areas = new Map<string, Area>();
  areaOrder: string[] = [];
  currentAreaId = "clearing";
  entities = new Map<number, EntRec>();
  nextId = 1;
  tickCount = 0;
  day = 1;
  hour = 9;
  timeSpeed = 1;
  clockEnabled = false;
  types = new Map<string, EntityType>();
  typeOwner = new Map<string, string>();
  componentOwner = new Map<string, string>();
  entityOwner = new Map<number, string>();
  systemState = new Map<string, unknown>();
  fxEffects: FxEffect[] = [];
  effectsThisTick = { particles: 0, floats: 0 };
  screenTint: { color: string; alpha: number; t: number; max: number } | null = null;
  banner: { text: string; t: number } | null = null;
  hudSlots = new Map<string, HudSlot>();
  overlay: OverlayState | null = null;
  interactionPrompt: string | null = null;
  interactionPromptAt: Pos | null = null;
  overlapLog: { tick: number; event: string; entity: number; systems: string[] }[] = [];
  deniedLog: { tick: number; system: string; op: string; code: string; msg: string }[] = [];
  nearLimitLog: { tick: number; system: string; op: string; used: number; limit: number }[] = [];
  private rngStreams = new Map<string, RngStream>();
  private playerEverSpawned = false;

  constructor(
    readonly width: number,
    readonly height: number,
    tiles: string[][],
    readonly seed: number = TUNING.seed,
  ) {
    this.createAreaRecord("clearing", tiles);
    this.host = new Host(this);
  }

  private createAreaRecord(id: string, tiles: string[][]): Area {
    const area: Area = { id, tiles: tiles.map((row) => [...row]), occupancy: new Map() };
    this.areas.set(id, area);
    this.areaOrder.push(id);
    return area;
  }

  createArea(id: string, fill: string): Area {
    if (this.areas.has(id)) throw new Error(`area "${id}" already exists`);
    const tiles = Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => fill));
    return this.createAreaRecord(id, tiles);
  }

  area(id = this.currentAreaId): Area {
    const area = this.areas.get(id);
    if (!area) throw new Error(`unknown area "${id}"`);
    return area;
  }

  registerType(name: string, type: EntityType, owner: string): void {
    this.types.set(name, { sprite: type.sprite, tags: [...type.tags] });
    this.typeOwner.set(name, owner);
  }

  declareComponent(name: string, owner: string): void {
    this.componentOwner.set(name, owner);
  }

  key(x: number, y: number): string {
    return `${x},${y}`;
  }

  spriteIdOf(rec: EntRec): string {
    const sprite = rec.comps.get("sprite") as { id?: unknown } | string | undefined;
    if (typeof sprite === "string") return sprite;
    if (sprite && typeof sprite.id === "string") return sprite.id;
    return this.types.get(rec.type)?.sprite ?? "";
  }

  footprintOf(rec: EntRec, pos: Pos): Pos[] {
    return footprintTiles(this.spriteIdOf(rec), pos.x, pos.y).map((t) => ({ ...t, area: pos.area }));
  }

  removeOccupancyFor(rec: EntRec): void {
    for (const area of this.areas.values()) {
      for (const ids of area.occupancy.values()) ids.delete(rec.id);
    }
  }

  rebuildOccupancyFor(rec: EntRec): void {
    this.removeOccupancyFor(rec);
    if (!rec.pos) return;
    const area = this.areas.get(rec.pos.area);
    if (!area) return;
    for (const tile of footprintTiles(this.spriteIdOf(rec), rec.pos.x, rec.pos.y)) {
      const key = this.key(tile.x, tile.y);
      if (!area.occupancy.has(key)) area.occupancy.set(key, new Set());
      area.occupancy.get(key)!.add(rec.id);
    }
  }

  atIds(x: number, y: number, areaId = this.currentAreaId): number[] {
    const area = this.areas.get(areaId);
    return area ? [...(area.occupancy.get(this.key(x, y)) ?? [])] : [];
  }

  recById(id: number): EntRec | undefined {
    return this.entities.get(id);
  }

  playerRec(): EntRec | undefined {
    for (const rec of this.entities.values()) if (rec.tags.has("player")) return rec;
    return undefined;
  }

  hasPlayer(): boolean {
    return this.playerRec() !== undefined;
  }

  notePlayerSpawned(): void {
    this.playerEverSpawned = true;
  }

  get playerEverCreated(): boolean {
    return this.playerEverSpawned;
  }

  isInside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  tileAt(x: number, y: number, areaId = this.currentAreaId): string | null {
    const area = this.areas.get(areaId);
    if (!area || !this.isInside(x, y)) return null;
    return area.tiles[y][x];
  }

  isWalkable(x: number, y: number, areaId = this.currentAreaId): boolean {
    const id = this.tileAt(x, y, areaId);
    if (!id) return false;
    const entry = catalogGet(id);
    return !!entry && entry.tags.includes("walkable") && !entry.tags.includes("water");
  }

  /** Free for X: walkable terrain and no player, solid, pushable or item entity other than X. */
  isFreeFor(x: number, y: number, selfId = 0, areaId = this.currentAreaId): boolean {
    if (!this.isWalkable(x, y, areaId)) return false;
    for (const id of this.atIds(x, y, areaId)) {
      if (id === selfId) continue;
      const rec = this.entities.get(id);
      if (!rec) continue;
      if (rec.tags.has("player") || rec.tags.has("solid") || rec.tags.has("pushable") || rec.tags.has("item")) return false;
      if (rec.comps.has("player") || rec.comps.has("solid") || rec.comps.has("pushable") || rec.comps.has("item")) return false;
    }
    return true;
  }

  footprintFreeFor(spriteId: string, x: number, y: number, selfId = 0, areaId = this.currentAreaId): boolean {
    return footprintTiles(spriteId, x, y).every((tile) => this.isFreeFor(tile.x, tile.y, selfId, areaId));
  }

  footprintWalkable(spriteId: string, x: number, y: number, areaId: string): boolean {
    return footprintTiles(spriteId, x, y).every((tile) => this.isWalkable(tile.x, tile.y, areaId));
  }

  validateOccupancy(): boolean {
    const wanted = new Map<string, Map<string, Set<number>>>();
    for (const areaId of this.areaOrder) wanted.set(areaId, new Map());
    for (const rec of this.entities.values()) {
      if (!rec.pos) continue;
      const areaMap = wanted.get(rec.pos.area);
      if (!areaMap) return false;
      for (const tile of footprintTiles(this.spriteIdOf(rec), rec.pos.x, rec.pos.y)) {
        const key = this.key(tile.x, tile.y);
        if (!areaMap.has(key)) areaMap.set(key, new Set());
        areaMap.get(key)!.add(rec.id);
      }
    }
    const normalize = (map: Map<string, Set<number>>): string => [...map.entries()]
      .filter(([, ids]) => ids.size > 0)
      .map(([key, ids]) => `${key}:${[...ids].sort((a, b) => a - b).join(".")}`)
      .sort()
      .join("|");
    for (const area of this.areas.values()) {
      if (normalize(area.occupancy) !== normalize(wanted.get(area.id)!)) return false;
    }
    return true;
  }

  private rngStream(systemId: string): RngStream {
    let stream = this.rngStreams.get(systemId);
    if (!stream) {
      stream = { a: (this.seed ^ hashString(systemId)) >>> 0, calls: 0 };
      this.rngStreams.set(systemId, stream);
    }
    return stream;
  }

  randFor(systemId: string): number {
    const stream = this.rngStream(systemId);
    stream.calls++;
    stream.a |= 0;
    stream.a = (stream.a + 0x6d2b79f5) | 0;
    let t = Math.imul(stream.a ^ (stream.a >>> 15), 1 | stream.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  rngSnapshot(systemId: string): { a: number; calls: number } {
    const stream = this.rngStream(systemId);
    return { a: stream.a, calls: stream.calls };
  }

  restoreRng(systemId: string, snapshot: { a: number; calls: number }): void {
    this.rngStreams.set(systemId, { ...snapshot });
  }

  phase(): Phase {
    return phaseAt(this.hour);
  }

  jumpTime(value: string | number): void {
    if (typeof value === "number") {
      this.hour = ((value % 24) + 24) % 24;
      return;
    }
    const starts: Record<string, number> = {
      dawn: TUNING.phases.dawn,
      day: TUNING.phases.day,
      daytime: TUNING.phases.day,
      dusk: TUNING.phases.dusk,
      night: TUNING.phases.night,
    };
    if (value in starts) this.hour = starts[value];
  }

  tick(): void {
    this.tickCount++;
    this.effectsThisTick = { particles: 0, floats: 0 };
    this.host.resetTick();
    if (this.clockEnabled) {
      const previousHour = this.hour;
      this.hour += this.timeSpeed / TUNING.ticksPerGameHour;
      if (this.hour >= 24) this.hour -= 24;
      const dawn = TUNING.phases.dawn;
      if (previousHour < dawn && this.hour >= dawn && this.hour < dawn + 1) this.day++;
    }
    for (const rec of this.entities.values()) if (rec.slideT > 0) rec.slideT--;
    for (const fx of this.fxEffects) {
      fx.life++;
      fx.x += fx.vx;
      fx.y += fx.vy;
    }
    this.fxEffects = this.fxEffects.filter((fx) => fx.life < fx.maxLife);
    if (this.screenTint && ++this.screenTint.t >= this.screenTint.max) this.screenTint = null;
    if (this.banner && --this.banner.t <= 0) this.banner = null;
  }

  /** Render interpolation position in tiles, for the renderer only. */
  renderPos(rec: EntRec): Pos | null {
    if (!rec.pos) return null;
    if (rec.slideFrom && rec.slideTo && rec.slideT > 0) {
      const k = 1 - rec.slideT / TUNING.slideTicks;
      return {
        x: rec.slideFrom.x + (rec.slideTo.x - rec.slideFrom.x) * k,
        y: rec.slideFrom.y + (rec.slideTo.y - rec.slideFrom.y) * k,
        area: rec.pos.area,
      };
    }
    return { ...rec.pos };
  }

  serialize(): string {
    return JSON.stringify({
      width: this.width,
      height: this.height,
      seed: this.seed,
      areas: this.areaOrder.map((id) => ({ id, tiles: this.areas.get(id)!.tiles })),
      currentAreaId: this.currentAreaId,
      day: this.day,
      hour: this.hour,
      timeSpeed: this.timeSpeed,
      clockEnabled: this.clockEnabled,
      tickCount: this.tickCount,
      nextId: this.nextId,
      playerEverSpawned: this.playerEverSpawned,
      entities: [...this.entities.values()].map((rec) => ({
        id: rec.id,
        type: rec.type,
        pos: rec.pos,
        tags: [...rec.tags],
        comps: [...rec.comps.entries()],
      })),
      types: [...this.types.entries()],
      systemState: [...this.systemState.entries()],
      rngStreams: [...this.rngStreams.entries()].map(([id, stream]) => [id, { a: stream.a, calls: stream.calls }]),
      ownership: {
        types: [...this.typeOwner.entries()],
        components: [...this.componentOwner.entries()],
        entities: [...this.entityOwner.entries()],
      },
    });
  }

  deserialize(json: string): void {
    const data = JSON.parse(json) as {
      areas: { id: string; tiles: string[][] }[];
      currentAreaId: string;
      day: number;
      hour: number;
      timeSpeed: number;
      clockEnabled: boolean;
      tickCount: number;
      nextId: number;
      playerEverSpawned: boolean;
      entities: { id: number; type: string; pos: Pos | null; tags: string[]; comps: [string, unknown][] }[];
      types: [string, EntityType][];
      systemState: [string, unknown][];
      rngStreams: [string, RngStream][];
      ownership: { types: [string, string][]; components: [string, string][]; entities: [number, string][] };
    };
    this.areas.clear();
    this.areaOrder = [];
    for (const area of data.areas) this.createAreaRecord(area.id, area.tiles);
    this.currentAreaId = data.currentAreaId;
    this.day = data.day;
    this.hour = data.hour;
    this.timeSpeed = data.timeSpeed;
    this.clockEnabled = data.clockEnabled;
    this.tickCount = data.tickCount;
    this.nextId = data.nextId;
    this.playerEverSpawned = data.playerEverSpawned;
    this.entities.clear();
    for (const entity of data.entities) {
      const rec: EntRec = {
        id: entity.id,
        type: entity.type,
        pos: entity.pos ? { ...entity.pos } : null,
        tags: new Set(entity.tags),
        comps: new Map(entity.comps),
        slideFrom: null,
        slideTo: null,
        slideT: 0,
      };
      this.entities.set(rec.id, rec);
    }
    for (const rec of this.entities.values()) this.rebuildOccupancyFor(rec);
    this.types = new Map(data.types);
    this.systemState = new Map(data.systemState);
    this.rngStreams = new Map(data.rngStreams.map(([id, stream]) => [id, { ...stream }]));
    this.typeOwner = new Map(data.ownership.types);
    this.componentOwner = new Map(data.ownership.components);
    this.entityOwner = new Map(data.ownership.entities);
    this.fxEffects = [];
    this.screenTint = null;
    this.banner = null;
    this.hudSlots.clear();
    this.overlay = null;
  }

  snapshot(): string {
    return this.serialize();
  }

  restore(snapshot: string): void {
    this.deserialize(snapshot);
  }
}
