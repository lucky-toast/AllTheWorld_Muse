import { catalogFind, catalogGet, footprintTiles } from "./catalog";
import { TUNING } from "../tuning";
import type { Engine, EntRec, Pos } from "./engine";

export type HostCode = "bad_request" | "denied" | "missing" | "limit" | "phase";
export type HostRequest = { op: string; [key: string]: unknown };
export type HostResponse = { ok: true; r: unknown } | { ok: false; code: HostCode; msg: string };

const PLAYER_MOVERS = new Set(["movement", "travel", "(engine)"]);
const PHASE_STUBS = new Set(["focus", "release", "timer", "emit", "fx.tween", "state.getReplaced", "check"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function jsonBytes(v: unknown): number {
  const text = JSON.stringify(v);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

function cloneJson<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}

function printable(text: string): boolean {
  return ![...text].some((ch) => {
    const code = ch.codePointAt(0)!;
    return code < 32 || code === 127;
  });
}

export class Host {
  private transactionDepth = 0;
  private undoLog: (() => void)[] = [];
  private callsThisInvocation = new Map<string, number>();
  private rngUndoDone = new Set<string>();
  private spawnsThisTick = new Map<string, number>();
  private nearLimitSeen = new Set<string>();
  private bannerLastTick = new Map<string, number>();

  constructor(private eng: Engine) {}

  resetTick(): void {
    this.spawnsThisTick.clear();
    this.nearLimitSeen.clear();
  }

  runInTransaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth = 1;
    this.undoLog = [];
    this.callsThisInvocation.clear();
    this.rngUndoDone.clear();
    try {
      const result = fn();
      this.transactionDepth = 0;
      this.undoLog = [];
      return result;
    } catch (error) {
      const undo = [...this.undoLog].reverse();
      this.transactionDepth = 0;
      this.undoLog = [];
      for (const fnUndo of undo) fnUndo();
      throw error;
    }
  }

  call(systemId: string, request: HostRequest): HostResponse {
    if (this.transactionDepth === 0) return this.runInTransaction(() => this.callInner(systemId, request));
    return this.callInner(systemId, request);
  }

  private callInner(systemId: string, request: HostRequest): HostResponse {
    let response: HostResponse;
    try {
      response = this.dispatch(systemId, request);
    } catch (error) {
      response = this.fail("bad_request", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      this.eng.deniedLog.push({ tick: this.eng.tickCount, system: systemId, op: String(request?.op ?? "?"), code: response.code, msg: response.msg });
    } else if (jsonBytes(response) > TUNING.limits.responseSizeBytes) {
      response = this.fail("bad_request", "response exceeds the 64 KB cap");
      if (!response.ok) this.eng.deniedLog.push({ tick: this.eng.tickCount, system: systemId, op: String(request?.op ?? "?"), code: response.code, msg: response.msg });
    }
    return response;
  }

  private ok(r: unknown): HostResponse {
    return { ok: true, r };
  }

  private fail(code: HostCode, msg: string): HostResponse {
    return { ok: false, code, msg };
  }

  private pushUndo(undo: () => void): void {
    if (this.transactionDepth > 0) this.undoLog.push(undo);
  }

  private noteNearLimit(systemId: string, op: string, used: number, limit: number): void {
    if (used <= limit * TUNING.limits.nearLimitThreshold) return;
    const key = `${systemId}:${op}:${limit}`;
    if (this.nearLimitSeen.has(key)) return;
    this.nearLimitSeen.add(key);
    this.eng.nearLimitLog.push({ tick: this.eng.tickCount, system: systemId, op, used, limit });
  }

  private entity(id: unknown): EntRec | HostResponse {
    if (!isInt(id)) return this.fail("bad_request", "id must be an integer");
    const rec = this.eng.recById(id);
    return rec ?? this.fail("missing", `entity ${id} no longer exists`);
  }

  private areaId(request: HostRequest): string | HostResponse {
    if (request.area === undefined) return this.eng.currentAreaId;
    if (typeof request.area !== "string" || !this.eng.areas.has(request.area)) {
      return this.fail("bad_request", `unknown area "${String(request.area)}"`);
    }
    return request.area;
  }

  private tileCoords(request: HostRequest, allowOutside = false): { x: number; y: number; area: string } | HostResponse {
    if (!isInt(request.x) || !isInt(request.y)) return this.fail("bad_request", "x and y must be integer tiles");
    const area = this.areaId(request);
    if (typeof area !== "string") return area;
    if (!allowOutside && !this.eng.isInside(request.x, request.y)) return this.fail("bad_request", "tile is outside the map");
    return { x: request.x, y: request.y, area };
  }

  private playerBlocked(systemId: string, rec: EntRec, action: string): HostResponse | null {
    if (rec.tags.has("player") && !PLAYER_MOVERS.has(systemId)) {
      return this.fail("denied", `${action} the player is blocked`);
    }
    return null;
  }

  private spriteForWrite(rec: EntRec, comp: string, value: unknown): string | HostResponse {
    if (comp !== "sprite") return this.eng.spriteIdOf(rec);
    if (typeof value === "string") return catalogGet(value) ? value : this.fail("bad_request", `unknown sprite "${value}"`);
    if (isRecord(value) && typeof value.id === "string") {
      return catalogGet(value.id) ? value.id : this.fail("bad_request", `unknown sprite "${value.id}"`);
    }
    return this.fail("bad_request", "sprite must be a sprite id or { id }");
  }

  private footprintDenied(rec: EntRec, pos: Pos, spriteId: string): HostResponse | null {
    if (!this.eng.footprintWalkable(spriteId, pos.x, pos.y, pos.area)) {
      return this.fail("denied", `footprint of entity ${rec.id} would sit on an unwalkable tile`);
    }
    return null;
  }

  private checkText(text: unknown, what: string): HostResponse | null {
    if (typeof text !== "string") return this.fail("bad_request", `${what} must be a string`);
    if (text.length > 60) return this.fail("denied", `${what} is over 60 characters`);
    if (!printable(text)) return this.fail("denied", `${what} contains non-printable characters`);
    return null;
  }

  private dispatch(systemId: string, request: HostRequest): HostResponse {
    if (!isRecord(request) || typeof request.op !== "string") return this.fail("bad_request", "request must be an object with an op");
    if (jsonBytes(request) > TUNING.limits.requestSizeBytes) return this.fail("bad_request", "request exceeds the 64 KB cap");
    const op = request.op;
    const calls = (this.callsThisInvocation.get(systemId) ?? 0) + 1;
    this.callsThisInvocation.set(systemId, calls);
    if (calls > TUNING.limits.hostCallsPerInvocation) return this.fail("limit", "host calls per invocation exceeded");
    this.noteNearLimit(systemId, op, calls, TUNING.limits.hostCallsPerInvocation);

    if (op.startsWith("sim.") || PHASE_STUBS.has(op)) {
      return this.fail("phase", `${op} arrives in a later phase`);
    }

    switch (op) {
      case "query": return this.query(request);
      case "at": return this.at(request);
      case "info": return this.info(request);
      case "get": return this.get(request);
      case "tile.get": return this.tileGet(request);
      case "tile.find": return this.tileFind(request);
      case "catalog.get": return this.ok(typeof request.id === "string" ? cloneJson(catalogGet(request.id) ?? null) : null);
      case "catalog.find": return this.ok(typeof request.tag === "string" ? catalogFind(request.tag) : []);
      case "time": return this.ok({ day: this.eng.day, hour: this.eng.hour, phase: this.eng.phase() });
      case "rand": return this.rand(systemId);
      case "state.get": return this.ok(cloneJson(this.eng.systemState.get(systemId) ?? null));
      case "spawn": return this.spawn(systemId, request);
      case "destroy": return this.destroy(systemId, request);
      case "lift": return this.liftOrMove(systemId, request, "lift");
      case "move": return this.liftOrMove(systemId, request, "move");
      case "place": return this.liftOrMove(systemId, request, "place");
      case "set": return this.set(systemId, request);
      case "remove": return this.remove(request);
      case "tag": return this.tag(request, true);
      case "untag": return this.tag(request, false);
      case "anim": return this.anim(request);
      case "tile.set": return this.tileSet(request);
      case "state.set": return this.stateSet(systemId, request);
      case "area.create": return this.areaCreate(systemId, request);
      case "area.list": return this.ok([...this.eng.areaOrder]);
      case "area.current": return this.ok(this.eng.currentAreaId);
      case "travel": return this.travel(request);
      case "fx.particles": return this.particles(request);
      case "fx.float": return this.floatText(request);
      case "fx.tint": return this.tint(request);
      case "ui.banner": return this.banner(systemId, request);
      case "ui.hud.add": return this.hudAdd(systemId, request);
      case "ui.hud.remove": return this.hudRemove(systemId, request);
      case "ui.overlay": return this.overlay(request);
      default: return this.fail("bad_request", `unknown op "${op}"`);
    }
  }

  private query(request: HostRequest): HostResponse {
    if (typeof request.with !== "string" || !request.with) return this.fail("bad_request", "query needs a non-empty with");
    const ids: number[] = [];
    for (const rec of this.eng.entities.values()) {
      if (rec.tags.has(request.with) || rec.comps.has(request.with)) ids.push(rec.id);
    }
    const truncated = ids.length > TUNING.limits.queryResults;
    const out = truncated ? ids.slice(0, TUNING.limits.queryResults) : ids;
    return this.ok({ ids: out, truncated });
  }

  private at(request: HostRequest): HostResponse {
    const tile = this.tileCoords(request, true);
    if (!("x" in tile)) return tile;
    return this.ok(this.eng.atIds(tile.x, tile.y, tile.area));
  }

  private info(request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    return this.ok({ type: rec.type, pos: rec.pos ? { ...rec.pos } : null, tags: [...rec.tags] });
  }

  private get(request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    if (typeof request.comp !== "string" || !request.comp) return this.fail("bad_request", "get needs a component name");
    return this.ok(cloneJson(rec.comps.get(request.comp) ?? null));
  }

  private tileGet(request: HostRequest): HostResponse {
    const tile = this.tileCoords(request, true);
    if (!("x" in tile)) return tile;
    const sprite = this.eng.tileAt(tile.x, tile.y, tile.area);
    if (!sprite) return this.ok(null);
    return this.ok({ sprite, tags: [...(catalogGet(sprite)?.tags ?? [])] });
  }

  private tileFind(request: HostRequest): HostResponse {
    if (typeof request.tag !== "string" || !request.tag) return this.fail("bad_request", "tile.find needs a tag");
    const out: Pos[] = [];
    for (const area of this.eng.areas.values()) {
      for (let y = 0; y < this.eng.height; y++) {
        for (let x = 0; x < this.eng.width; x++) {
          if (catalogGet(area.tiles[y][x])?.tags.includes(request.tag)) out.push({ x, y, area: area.id });
        }
      }
    }
    return this.ok(out);
  }

  private rand(systemId: string): HostResponse {
    if (!this.rngUndoDone.has(systemId)) {
      const before = this.eng.rngSnapshot(systemId);
      this.pushUndo(() => this.eng.restoreRng(systemId, before));
      this.rngUndoDone.add(systemId);
    }
    return this.ok(this.eng.randFor(systemId));
  }

  private spawn(systemId: string, request: HostRequest): HostResponse {
    if (typeof request.type !== "string" || !request.type) return this.fail("bad_request", "spawn needs a type");
    const type = this.eng.types.get(request.type);
    if (!type) return this.fail("denied", `spawn of unregistered type "${request.type}" is denied`);
    const tile = this.tileCoords(request);
    if (!("x" in tile)) return tile;
    const pos: Pos = { x: tile.x, y: tile.y, area: tile.area };
    if (!this.eng.footprintWalkable(type.sprite, pos.x, pos.y, pos.area)) {
      return this.fail("denied", `footprint of "${request.type}" would sit on an unwalkable tile`);
    }
    const spawns = (this.spawnsThisTick.get(systemId) ?? 0) + 1;
    if (spawns > TUNING.limits.spawnsPerTickPerSystem) return this.fail("limit", "spawns per tick for this system exceeded");
    const liveOwned = [...this.eng.entityOwner.values()].filter((owner) => owner === systemId).length;
    if (liveOwned >= TUNING.limits.liveEntitiesPerSystem) return this.fail("limit", "live entities for this system exceeded");
    this.spawnsThisTick.set(systemId, spawns);
    this.noteNearLimit(systemId, "spawn", spawns, TUNING.limits.spawnsPerTickPerSystem);
    this.noteNearLimit(systemId, "spawn", liveOwned + 1, TUNING.limits.liveEntitiesPerSystem);

    const rec: EntRec = {
      id: this.eng.nextId++,
      type: request.type,
      pos,
      tags: new Set(type.tags),
      comps: new Map(),
      slideFrom: null,
      slideTo: null,
      slideT: 0,
    };
    rec.comps.set("sprite", { id: type.sprite });
    this.eng.entities.set(rec.id, rec);
    this.eng.entityOwner.set(rec.id, systemId);
    if (rec.tags.has("player")) this.eng.notePlayerSpawned();
    this.eng.rebuildOccupancyFor(rec);
    this.pushUndo(() => {
      this.eng.entities.delete(rec.id);
      this.eng.entityOwner.delete(rec.id);
      this.eng.removeOccupancyFor(rec);
    });
    if (!this.eng.validateOccupancy()) throw new Error("occupancy invariant failed after spawn");
    return this.ok(rec.id);
  }

  private destroy(systemId: string, request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    const blocked = this.playerBlocked(systemId, rec, "destroying");
    if (blocked) return blocked;
    const snapshot = {
      pos: rec.pos ? { ...rec.pos } : null,
      tags: new Set(rec.tags),
      comps: new Map(rec.comps),
      slideFrom: rec.slideFrom ? { ...rec.slideFrom } : null,
      slideTo: rec.slideTo ? { ...rec.slideTo } : null,
      slideT: rec.slideT,
      owner: this.eng.entityOwner.get(rec.id),
    };
    this.eng.entities.delete(rec.id);
    this.eng.entityOwner.delete(rec.id);
    this.eng.removeOccupancyFor(rec);
    this.pushUndo(() => {
      rec.pos = snapshot.pos;
      rec.tags = snapshot.tags;
      rec.comps = snapshot.comps;
      rec.slideFrom = snapshot.slideFrom;
      rec.slideTo = snapshot.slideTo;
      rec.slideT = snapshot.slideT;
      this.eng.entities.set(rec.id, rec);
      if (snapshot.owner !== undefined) this.eng.entityOwner.set(rec.id, snapshot.owner);
      this.eng.rebuildOccupancyFor(rec);
    });
    return this.ok(true);
  }

  private liftOrMove(systemId: string, request: HostRequest, op: "lift" | "move" | "place"): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    const blocked = this.playerBlocked(systemId, rec, op === "lift" ? "lifting" : "moving");
    if (blocked) return blocked;
    const before = {
      pos: rec.pos ? { ...rec.pos } : null,
      slideFrom: rec.slideFrom ? { ...rec.slideFrom } : null,
      slideTo: rec.slideTo ? { ...rec.slideTo } : null,
      slideT: rec.slideT,
    };
    if (op === "lift") {
      rec.pos = null;
    } else {
      const tile = this.tileCoords(request);
      if (!("x" in tile)) return tile;
      const pos: Pos = { x: tile.x, y: tile.y, area: tile.area };
      const denied = this.footprintDenied(rec, pos, this.eng.spriteIdOf(rec));
      if (denied) return denied;
      rec.pos = pos;
      if (op === "place" || request.instant === true || !before.pos) {
        rec.slideFrom = null;
        rec.slideTo = null;
        rec.slideT = 0;
      } else {
        rec.slideFrom = before.pos;
        rec.slideTo = { ...pos };
        rec.slideT = TUNING.slideTicks;
      }
    }
    this.eng.rebuildOccupancyFor(rec);
    this.pushUndo(() => {
      rec.pos = before.pos;
      rec.slideFrom = before.slideFrom;
      rec.slideTo = before.slideTo;
      rec.slideT = before.slideT;
      this.eng.rebuildOccupancyFor(rec);
    });
    if (!this.eng.validateOccupancy()) throw new Error(`occupancy invariant failed after ${op}`);
    return this.ok(true);
  }

  private set(systemId: string, request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    if (typeof request.comp !== "string" || !request.comp) return this.fail("bad_request", "set needs a component name");
    const comp = request.comp;
    let value: unknown;
    try {
      value = cloneJson(request.value);
    } catch {
      return this.fail("bad_request", "component value must be JSON");
    }
    const spriteId = this.spriteForWrite(rec, comp, value);
    if (typeof spriteId !== "string") return spriteId;
    if (comp === "sprite" && rec.pos && !this.eng.footprintWalkable(spriteId, rec.pos.x, rec.pos.y, rec.pos.area)) {
      return this.fail("denied", "sprite footprint would sit on an unwalkable tile");
    }
    if (comp === "sprite" && typeof value === "string") value = { id: value };
    const had = rec.comps.has(comp);
    const old = rec.comps.get(comp);
    const hadOwner = this.eng.componentOwner.has(comp);
    rec.comps.set(comp, value);
    if (!hadOwner) this.eng.componentOwner.set(comp, systemId);
    if (comp === "sprite") this.eng.rebuildOccupancyFor(rec);
    this.pushUndo(() => {
      if (had) rec.comps.set(comp, old);
      else rec.comps.delete(comp);
      if (!hadOwner) this.eng.componentOwner.delete(comp);
      if (comp === "sprite") this.eng.rebuildOccupancyFor(rec);
    });
    if (!this.eng.validateOccupancy()) throw new Error("occupancy invariant failed after set");
    return this.ok(true);
  }

  private remove(request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    if (typeof request.comp !== "string" || !request.comp) return this.fail("bad_request", "remove needs a component name");
    const comp = request.comp;
    const had = rec.comps.has(comp);
    const old = rec.comps.get(comp);
    rec.comps.delete(comp);
    if (comp === "sprite") this.eng.rebuildOccupancyFor(rec);
    this.pushUndo(() => {
      if (had) rec.comps.set(comp, old);
      if (comp === "sprite") this.eng.rebuildOccupancyFor(rec);
    });
    return this.ok(true);
  }

  private tag(request: HostRequest, add: boolean): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    if (typeof request.tag !== "string" || !request.tag) return this.fail("bad_request", "tag needs a tag name");
    const tag = request.tag;
    const had = rec.tags.has(tag);
    if (add) rec.tags.add(tag);
    else rec.tags.delete(tag);
    this.pushUndo(() => {
      if (had) rec.tags.add(tag);
      else rec.tags.delete(tag);
    });
    return this.ok(true);
  }

  private anim(request: HostRequest): HostResponse {
    const rec = this.entity(request.id);
    if (!("id" in rec)) return rec;
    if (typeof request.name !== "string" || !request.name) return this.fail("bad_request", "anim needs a name");
    if (request.callback !== undefined) return this.fail("phase", "anim callbacks arrive in a later phase");
    const sprite = rec.comps.get("sprite");
    const next = isRecord(sprite) ? { ...sprite, anim: request.name } : { id: this.eng.spriteIdOf(rec), anim: request.name };
    return this.set("(engine)", { op: "set", id: rec.id, comp: "sprite", value: next });
  }

  private tileSet(request: HostRequest): HostResponse {
    const tile = this.tileCoords(request);
    if (!("x" in tile)) return tile;
    if (typeof request.sprite !== "string" || !catalogGet(request.sprite)) {
      return this.fail("bad_request", `unknown terrain sprite "${String(request.sprite)}"`);
    }
    const area = this.eng.area(tile.area);
    const old = area.tiles[tile.y][tile.x];
    const newEntry = catalogGet(request.sprite)!;
    const newWalkable = newEntry.tags.includes("walkable") && !newEntry.tags.includes("water");
    if (!newWalkable) {
      for (const rec of this.eng.entities.values()) {
        if (!rec.pos || rec.pos.area !== tile.area) continue;
        const covers = footprintTiles(this.eng.spriteIdOf(rec), rec.pos.x, rec.pos.y)
          .some((t) => t.x === tile.x && t.y === tile.y);
        if (covers) {
          return this.fail("denied", rec.tags.has("player")
            ? "tile.set would make the tile under the player unwalkable"
            : `tile.set would leave entity ${rec.id} on an unwalkable tile`);
        }
      }
    }
    area.tiles[tile.y][tile.x] = request.sprite;
    this.pushUndo(() => { area.tiles[tile.y][tile.x] = old; });
    return this.ok(true);
  }

  private stateSet(systemId: string, request: HostRequest): HostResponse {
    let value: unknown;
    try {
      value = cloneJson(request.value);
    } catch {
      return this.fail("bad_request", "state must be JSON");
    }
    if (jsonBytes(value) > TUNING.limits.stateSizeBytes) return this.fail("denied", "saved state exceeds the 1 MB cap");
    const had = this.eng.systemState.has(systemId);
    const old = this.eng.systemState.get(systemId);
    this.eng.systemState.set(systemId, value);
    this.pushUndo(() => {
      if (had) this.eng.systemState.set(systemId, old);
      else this.eng.systemState.delete(systemId);
    });
    return this.ok(true);
  }

  private areaCreate(systemId: string, request: HostRequest): HostResponse {
    if (typeof request.name !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(request.name)) {
      return this.fail("bad_request", "area.create needs a simple area name");
    }
    if (typeof request.fill !== "string" || !catalogGet(request.fill)) {
      return this.fail("bad_request", `unknown fill sprite "${String(request.fill)}"`);
    }
    const id = `${systemId}.${request.name}`;
    if (this.eng.areas.has(id)) return this.fail("denied", `area "${id}" already exists`);
    const area = this.eng.createArea(id, request.fill);
    this.pushUndo(() => {
      this.eng.areas.delete(area.id);
      this.eng.areaOrder = this.eng.areaOrder.filter((x) => x !== area.id);
    });
    return this.ok(id);
  }

  private travel(request: HostRequest): HostResponse {
    const player = this.eng.playerRec();
    if (!player) return this.fail("missing", "there is no player to travel");
    const tile = this.tileCoords(request);
    if (!("x" in tile)) return tile;
    const target: Pos = { x: tile.x, y: tile.y, area: tile.area };
    const spriteId = this.eng.spriteIdOf(player);
    const free = footprintTiles(spriteId, target.x, target.y)
      .every((t) => this.eng.isFreeFor(t.x, t.y, player.id, target.area));
    if (!free) return this.fail("denied", "travel target tile is not free for the player");
    const beforePos = player.pos ? { ...player.pos } : null;
    const beforeArea = this.eng.currentAreaId;
    player.pos = target;
    player.slideFrom = null;
    player.slideTo = null;
    player.slideT = 0;
    this.eng.currentAreaId = target.area;
    this.eng.rebuildOccupancyFor(player);
    this.pushUndo(() => {
      player.pos = beforePos;
      this.eng.currentAreaId = beforeArea;
      this.eng.rebuildOccupancyFor(player);
    });
    return this.ok(true);
  }

  private particles(request: HostRequest): HostResponse {
    const tile = this.tileCoords(request, true);
    if (!("x" in tile)) return tile;
    if (typeof request.sprite !== "string" || !catalogGet(request.sprite)) {
      return this.fail("bad_request", `unknown particle sprite "${String(request.sprite)}"`);
    }
    const wanted = request.count === undefined ? 6 : request.count;
    if (!isInt(wanted) || wanted < 1) return this.fail("bad_request", "particle count must be a positive integer");
    const room = Math.max(0, TUNING.limits.effectsPerTick - this.eng.effectsThisTick.particles);
    const added = Math.min(wanted, room);
    const beforeLength = this.eng.fxEffects.length;
    for (let i = 0; i < added; i++) {
      this.eng.fxEffects.push({
        kind: "particle",
        spriteId: request.sprite,
        x: tile.x,
        y: tile.y,
        area: tile.area,
        vx: (this.eng.randFor("(engine)") - 0.5) * 0.08,
        vy: -this.eng.randFor("(engine)") * 0.08,
        life: 0,
        maxLife: 24,
        frame: Math.floor(this.eng.randFor("(engine)") * 6),
      });
    }
    this.eng.effectsThisTick.particles += added;
    this.pushUndo(() => { this.eng.fxEffects.length = beforeLength; });
    return this.ok({ added, dropped: wanted - added });
  }

  private floatText(request: HostRequest): HostResponse {
    const tile = this.tileCoords(request, true);
    if (!("x" in tile)) return tile;
    const textError = this.checkText(request.text, "float text");
    if (textError) return textError;
    if (request.color !== undefined && typeof request.color !== "string") return this.fail("bad_request", "float color must be a string");
    if (this.eng.effectsThisTick.floats >= TUNING.limits.effectsPerTick) return this.ok({ added: 0, dropped: 1 });
    const beforeLength = this.eng.fxEffects.length;
    this.eng.fxEffects.push({
      kind: "text",
      text: request.text as string,
      color: (request.color as string | undefined) ?? "#fff",
      x: tile.x,
      y: tile.y,
      area: tile.area,
      vx: 0,
      vy: -0.02,
      life: 0,
      maxLife: 50,
      frame: 0,
    });
    this.eng.effectsThisTick.floats++;
    this.pushUndo(() => { this.eng.fxEffects.length = beforeLength; });
    return this.ok({ added: 1, dropped: 0 });
  }

  private tint(request: HostRequest): HostResponse {
    if (typeof request.color !== "string" || !request.color) return this.fail("bad_request", "tint needs a color");
    if (typeof request.alpha !== "number" || !Number.isFinite(request.alpha)) return this.fail("bad_request", "tint alpha must be a number");
    if (!isInt(request.ms) || request.ms < 0) return this.fail("bad_request", "tint ms must be a non-negative integer");
    if (request.alpha > 0.6) return this.fail("denied", "tint alpha over 0.6 is blocked");
    if (request.ms > 3000) return this.fail("denied", "tint longer than 3 s is blocked");
    const before = this.eng.screenTint;
    this.eng.screenTint = {
      color: request.color,
      alpha: request.alpha,
      t: 0,
      max: Math.max(1, Math.round((request.ms / 1000) * TUNING.ticksPerSecond)),
    };
    this.pushUndo(() => { this.eng.screenTint = before; });
    return this.ok(true);
  }

  private banner(systemId: string, request: HostRequest): HostResponse {
    const textError = this.checkText(request.text, "banner text");
    if (textError) return textError;
    const last = this.bannerLastTick.get(systemId) ?? -Infinity;
    if (this.eng.tickCount - last < TUNING.limits.bannerIntervalTicks) return this.ok({ dropped: true });
    const before = this.eng.banner;
    this.eng.banner = { text: request.text as string, t: TUNING.bannerTicks };
    this.bannerLastTick.set(systemId, this.eng.tickCount);
    this.pushUndo(() => { this.eng.banner = before; });
    return this.ok(true);
  }

  private hudAdd(systemId: string, request: HostRequest): HostResponse {
    if (typeof request.key !== "string" || !request.key) return this.fail("bad_request", "hud.add needs a key");
    const textError = this.checkText(request.text, "HUD text");
    if (textError) return textError;
    if (!isInt(request.width) || request.width < 1 || request.width > 60) return this.fail("bad_request", "HUD width must be an integer from 1 to 60");
    if (request.icon !== undefined && typeof request.icon !== "string") return this.fail("bad_request", "HUD icon must be a string");
    const key = `${systemId}\0${request.key}`;
    const before = this.eng.hudSlots.get(key);
    this.eng.hudSlots.set(key, { owner: systemId, icon: request.icon as string | undefined, text: request.text as string, width: request.width });
    this.pushUndo(() => {
      if (before) this.eng.hudSlots.set(key, before);
      else this.eng.hudSlots.delete(key);
    });
    return this.ok(true);
  }

  private hudRemove(systemId: string, request: HostRequest): HostResponse {
    if (typeof request.key !== "string" || !request.key) return this.fail("bad_request", "hud.remove needs a key");
    const key = `${systemId}\0${request.key}`;
    const before = this.eng.hudSlots.get(key);
    this.eng.hudSlots.delete(key);
    this.pushUndo(() => { if (before) this.eng.hudSlots.set(key, before); });
    return this.ok(true);
  }

  private overlay(request: HostRequest): HostResponse {
    if (request.value === null || request.overlay === null) {
      const before = this.eng.overlay;
      this.eng.overlay = null;
      this.pushUndo(() => { this.eng.overlay = before; });
      return this.ok(true);
    }
    const value = isRecord(request.value) ? request.value : isRecord(request.overlay) ? request.overlay : request;
    if (value.title !== undefined) {
      const titleError = this.checkText(value.title, "overlay title");
      if (titleError) return titleError;
    }
    if (!Array.isArray(value.lines)) return this.fail("bad_request", "overlay needs a lines array");
    for (const line of value.lines) {
      const lineError = this.checkText(line, "overlay line");
      if (lineError) return lineError;
    }
    if (value.bar !== undefined) {
      if (!isRecord(value.bar) || typeof value.bar.value !== "number" || !Number.isFinite(value.bar.value)) {
        return this.fail("bad_request", "overlay bar needs a numeric value");
      }
      if (value.bar.label !== undefined) {
        const labelError = this.checkText(value.bar.label, "overlay bar label");
        if (labelError) return labelError;
      }
    }
    const before = this.eng.overlay;
    this.eng.overlay = cloneJson({
      title: value.title as string | undefined,
      lines: value.lines as string[],
      bar: value.bar as { value: number; label?: string } | undefined,
    });
    this.pushUndo(() => { this.eng.overlay = before; });
    return this.ok(true);
  }
}
