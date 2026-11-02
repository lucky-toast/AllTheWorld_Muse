// The one dispatcher (spec section 4). Every world access by a system, base or AI,
// goes through host.call(systemId, request). Each request passes five checks in
// order: shape, phase, blocked actions, budget, invariants. A denial is a normal
// response (never a crash) and is logged with the near-limit log (4.7).
import { catalogGet, catalogFind } from "./catalog";
import { Engine, cloneJson, type EntRec, type Overlay } from "./engine";
import { ENGINE_OWNER, SYSTEM_ID_RE, type Manifest, type Pos, type SpriteComp } from "./types";
import { LIMITS, TUNING } from "../tuning";

export type Code = "bad_request" | "denied" | "missing" | "limit" | "phase";
export type Request = { op: string; [field: string]: unknown };
export type Response = { ok: true; r: unknown } | { ok: false; code: Code; msg: string };
/** live: normal play. test/shot: a pipeline test or shot is running, so sim.* and check are allowed. */
export type HostMode = "live" | "test" | "shot";
/** The handler names a transaction can wrap (spec 4.4). */
export type CallKind = "perform" | "onEvent" | "onTick" | "onTimer" | "onInput" | "onTween" | "migrate" | "test" | "shot";

export interface SystemEntry { id: string; manifest: Manifest; base: boolean; order: number; ownedEvents: Set<string> }
export interface DenialEntry { tick: number; system: string; op: string; code: Code; msg: string }
export interface NearLimitEntry { tick: number; system: string; limit: string; used: number; max: number }
export interface EventEntry { tick: number; name: string; payload: Record<string, unknown> }

class Denial extends Error { constructor(public code: Code, msg: string) { super(msg); } }
const deny = (code: Code, msg: string): never => { throw new Denial(code, msg); };

// ---------------------------------------------------------------------------
// Shapes (check 1). Each op lists its fields; unknown fields are a bad_request.
// int: integer · num: finite number · name: short printable string · text: any string
// (text caps are check 3) · bool · json: plain JSON · id: entity id · ? = optional
// ---------------------------------------------------------------------------
type FieldType = "int" | "num" | "name" | "text" | "bool" | "json" | "id";
const TILE = { x: "int", y: "int", "area?": "name" } as const;
const OPS: Record<string, Record<string, FieldType>> = {
  query: { with: "name" }, at: { ...TILE }, info: { id: "id" }, get: { id: "id", comp: "name" },
  "tile.get": { ...TILE }, "tile.find": { tag: "name", "area?": "name" },
  "catalog.get": { id: "name" }, "catalog.find": { tag: "name" },
  time: {}, rand: {}, "state.get": {}, "state.getReplaced": { id: "name" },
  spawn: { type: "name", ...TILE }, destroy: { id: "id" }, move: { id: "id", ...TILE, "instant?": "bool" },
  lift: { id: "id" }, place: { id: "id", ...TILE },
  set: { id: "id", comp: "name", value: "json" }, remove: { id: "id", comp: "name" },
  tag: { id: "id", tag: "name" }, untag: { id: "id", tag: "name" },
  anim: { id: "id", name: "name", "callback?": "name" },
  "tile.set": { ...TILE, sprite: "name" }, "state.set": { value: "json" },
  emit: { name: "name", "payload?": "json" }, timer: { ticks: "int", name: "name" },
  focus: { mode: "name" }, release: {},
  "area.create": { name: "name", fill: "name" }, "area.list": {}, "area.current": {},
  travel: { area: "name", x: "int", y: "int" },
  "fx.particles": { sprite: "name", ...TILE, "count?": "int" },
  "fx.float": { text: "text", ...TILE, "color?": "name" },
  "fx.tint": { color: "name", alpha: "num", ms: "num" },
  "fx.tween": { from: "num", to: "num", ticks: "int" },
  "ui.banner": { text: "text" },
  "ui.hud.add": { key: "name", text: "text", width: "int", "icon?": "name" }, "ui.hud.remove": { key: "name" },
  "ui.overlay": { panel: "json" },
  "sim.walk": { dir: "name", "steps?": "int" }, "sim.face": { dir: "name" }, "sim.interact": {}, "sim.cycle": {},
  "sim.give": { type: "name" }, "sim.teleport": { ...TILE }, "sim.wait": { ticks: "int" },
  "sim.time": { phaseOrHour: "json" }, "sim.key": { key: "name", kind: "name" },
  check: { cond: "bool", label: "text" },
};
/** Requests that need later phases. They pass the shape and phase checks, then are denied with "not yet". */
const NOT_YET: Record<string, string> = {
  timer: "timer callbacks arrive in Phase 2", focus: "focus arrives in Phase 2", release: "focus arrives in Phase 2",
  "fx.tween": "onTween arrives in Phase 3", "sim.walk": "sim arrives in Phase 2", "sim.face": "sim arrives in Phase 2",
  "sim.interact": "sim arrives in Phase 2", "sim.cycle": "sim arrives in Phase 2", "sim.give": "sim arrives in Phase 2",
  "sim.teleport": "sim arrives in Phase 2", "sim.wait": "sim arrives in Phase 2", "sim.time": "sim arrives in Phase 2",
  "sim.key": "sim arrives in Phase 2", check: "check arrives in Phase 2",
};
const PLAYER_GUARDED = new Set(["destroy", "lift", "move", "place"]);
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const NONPRINT_RE = /\p{C}/u;

function isPlainJson(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isPlainJson(x, depth + 1));
  if (typeof v === "object") { const p = Object.getPrototypeOf(v); return (p === Object.prototype || p === null) && Object.values(v as object).every((x) => isPlainJson(x, depth + 1)); }
  return false;
}
function utf8Len(s: string): number { return s.length * 3 <= LIMITS.requestBytes ? s.length : new TextEncoder().encode(s).length; }

interface Txn { system: string; kind: CallKind; effects: (() => void)[] }

export class Host {
  systems = new Map<string, SystemEntry>();
  mode: HostMode = "live";
  /** System whose `migrate` is running, if any (state.getReplaced is allowed only then). */
  migrating: string | null = null;
  denials: DenialEntry[] = [];
  nearLimits: NearLimitEntry[] = [];
  events: EventEntry[] = [];
  /** Called when a transaction rolls back (strikes arrive in Phase 3). */
  onFault: ((system: string, kind: CallKind, message: string) => void) | null = null;
  private txn: Txn | null = null;
  private counterTick = -1;
  private calls = new Map<string, number>();
  private spawnsTick = new Map<string, number>();
  private fxTick = new Map<string, number>();
  private lastBanner = new Map<string, number>();

  constructor(public eng: Engine) {}

  // ======================= systems =======================
  /** Register a system's manifest: its entity types and components (with ownership) and the events it owns. */
  addSystem(m: Partial<Manifest> & { id: string }, base: boolean): SystemEntry {
    if (!SYSTEM_ID_RE.test(m.id)) throw new Error(`bad system id "${m.id}"`);
    if (this.systems.has(m.id)) throw new Error(`system "${m.id}" is already loaded`);
    const manifest: Manifest = Object.freeze({ why: "", buildsOn: [], replaces: [], entities: {}, components: {}, interactions: [], reactions: [], emits: {}, shots: [], ...m }) as Manifest;
    for (const [n, t] of Object.entries(manifest.entities)) this.eng.registerType(n, t, manifest.id);
    for (const c of Object.keys(manifest.components)) this.eng.declareComponent(c, manifest.id);
    const entry: SystemEntry = { id: manifest.id, manifest, base, order: this.systems.size, ownedEvents: new Set(Object.keys(manifest.emits)) };
    this.systems.set(manifest.id, entry);
    return entry;
  }

  // ======================= transactions (4.4) =======================
  /** Run one system call as a transaction. If it throws, every write is undone and its queued effects are dropped. */
  invoke(system: string, kind: CallKind, fn: () => void): { ok: true } | { ok: false; error: string } {
    if (this.txn) { fn(); return { ok: true }; } // nested (an emit reaching another system): part of the outer transaction
    this.syncCounters();
    this.calls.clear();
    const txn: Txn = { system, kind, effects: [] };
    this.txn = txn; this.eng.journal = [];
    try { fn(); }
    catch (e) {
      this.eng.rollbackTo(0);
      this.eng.journal = null; this.txn = null;
      const msg = e instanceof Error ? e.message : String(e);
      this.onFault?.(system, kind, msg);
      return { ok: false, error: msg };
    }
    this.eng.journal = null; this.txn = null;
    for (const fx of txn.effects) fx();
    return { ok: true };
  }
  get inTransaction() { return this.txn !== null; }

  // ======================= the dispatcher =======================
  call(system: string, request: unknown): Response {
    let res: Response;
    let op = "?";
    try {
      if (request && typeof request === "object" && typeof (request as Request).op === "string") op = (request as Request).op;
      res = { ok: true, r: this.dispatch(system, request) };
      if (res.r !== null && typeof res.r === "object" && utf8Len(JSON.stringify(res.r)) > LIMITS.responseBytes) deny("bad_request", `the response is over ${LIMITS.responseBytes} bytes; ask for less`);
    } catch (e) {
      if (!(e instanceof Denial)) throw e;
      res = { ok: false, code: e.code, msg: e.message };
      this.pushLog(this.denials, { tick: this.eng.tickCount, system, op, code: e.code, msg: e.message });
    }
    return res;
  }

  /** Advance one tick (systems' onTick arrives with Phase 2). */
  tick() { this.eng.tick(); }

  // ======================= checks =======================
  private dispatch(system: string, request: unknown): unknown {
    const eng = this.eng;
    // ---- 1. Shape ----
    const sys = this.systems.get(system);
    if (!sys && system !== ENGINE_OWNER) deny("denied", `unknown system "${system}"`);
    this.syncCounters();
    const calls = (this.calls.get(system) ?? 0) + 1; this.calls.set(system, calls);
    if (!request || typeof request !== "object" || Array.isArray(request)) deny("bad_request", "a request is an object { op, ...fields }");
    const req = request as Request;
    const shape = OPS[req.op];
    if (!shape) deny("bad_request", `unknown op "${String(req.op)}"`);
    const raw = JSON.stringify(req);
    if (raw === undefined || utf8Len(raw) > LIMITS.requestBytes) deny("bad_request", `the request is over ${LIMITS.requestBytes} bytes`);
    this.checkShape(req, shape);
    const op = req.op;
    const area = this.resolveArea(req);
    if ("x" in shape && op !== "tile.get" && !eng.inMap(req.x as number, req.y as number)) deny("bad_request", `tile (${req.x}, ${req.y}) is outside the ${eng.width}x${eng.height} map`);

    // ---- 2. Phase ----
    if ((op.startsWith("sim.") || op === "check") && this.mode === "live") deny("phase", `${op} is only allowed while tests or shots run`);
    if (op === "state.getReplaced") {
      const id = req.id as string;
      if (this.migrating !== system || !sys?.manifest.replaces.includes(id)) deny("phase", `state.getReplaced("${id}") is only allowed during migrate of a system that replaces "${id}"`);
    }
    if (NOT_YET[op]) deny("denied", `not yet: ${NOT_YET[op]}`);

    // Entities named by id must exist (a request on a gone entity is "missing", not a fault).
    const rec = typeof req.id === "number" && op !== "catalog.get" && op !== "state.getReplaced" ? eng.rec(req.id) ?? deny("missing", `entity ${req.id} no longer exists`) : undefined;

    // ---- 3. Blocked actions ----
    const player = eng.player();
    if (rec && PLAYER_GUARDED.has(op) && rec === player && !(op === "move" && sys?.base && system === "movement"))
      deny("denied", `${op} can't act on the player; only base movement, travel and sim.teleport move the player`);
    if (op === "tile.set" && player?.pos && player.pos.area === area && !this.walkableSprite(req.sprite as string)
      && eng.footprintOfRec(player).some((t) => t.x === req.x && t.y === req.y))
      deny("denied", `tile.set can't make the tile under the player unwalkable`);
    if (op === "emit" && system !== ENGINE_OWNER && !sys!.ownedEvents.has(req.name as string))
      deny("denied", `"${system}" doesn't own the event "${req.name}"; list it in emits with the "${system}." prefix`);
    if (op === "fx.tint") {
      if ((req.alpha as number) > LIMITS.tintMaxAlpha) deny("denied", `fx.tint alpha is capped at ${LIMITS.tintMaxAlpha}`);
      if ((req.ms as number) > LIMITS.tintMaxMs) deny("denied", `fx.tint lasts at most ${LIMITS.tintMaxMs} ms`);
    }
    for (const t of this.uiTexts(req)) {
      if (t.length > LIMITS.textMaxChars) deny("denied", `text over ${LIMITS.textMaxChars} characters`);
      if (NONPRINT_RE.test(t)) deny("denied", "text with non-printable characters");
    }

    // ---- 4. Budget ----
    this.near(system, "hostCallsPerInvocation", calls, LIMITS.hostCallsPerInvocation);
    if (calls > LIMITS.hostCallsPerInvocation) deny("limit", `over ${LIMITS.hostCallsPerInvocation} host calls in one call`);

    // ---- 5. Run, with invariants checked after each write ----
    return this.run(system, req, rec, area);
  }

  private checkShape(req: Request, shape: Record<string, FieldType>) {
    const allowed = new Map<string, { t: FieldType; opt: boolean }>();
    for (const [k, t] of Object.entries(shape)) allowed.set(k.replace("?", ""), { t, opt: k.endsWith("?") });
    for (const k of Object.keys(req)) if (k !== "op" && !allowed.has(k)) deny("bad_request", `${req.op} has no field "${k}"`);
    for (const [k, { t, opt }] of allowed) {
      const v = req[k];
      if (v === undefined) { if (opt) continue; deny("bad_request", `${req.op} needs "${k}"`); }
      const bad = (what: string) => deny("bad_request", `${req.op}.${k} must be ${what}`);
      switch (t) {
        case "int": if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1e9) bad("an integer"); break;
        case "num": if (typeof v !== "number" || !Number.isFinite(v)) bad("a number"); break;
        case "id": if (typeof v !== "number" || !Number.isInteger(v) || v < 1) bad("an entity id (integer from 1)"); break;
        case "bool": if (typeof v !== "boolean") bad("true or false"); break;
        case "name": if (typeof v !== "string" || !v.length || v.length > LIMITS.nameMaxChars || NONPRINT_RE.test(v)) bad(`a printable string of 1 to ${LIMITS.nameMaxChars} characters`); break;
        case "text": if (typeof v !== "string") bad("a string"); break;
        case "json": if (!isPlainJson(v)) bad("plain JSON"); break;
      }
    }
  }
  private resolveArea(req: Request): string {
    const a = req.area;
    if (a === undefined) return this.eng.currentArea();
    if (!this.eng.areas.has(a as string)) deny("bad_request", `unknown area "${String(a)}"`);
    return a as string;
  }
  private walkableSprite(id: string) { const e = catalogGet(id); return !!e && e.tags.includes("walkable") && !e.tags.includes("water"); }
  private uiTexts(req: Request): string[] {
    switch (req.op) {
      case "ui.banner": case "fx.float": case "ui.hud.add": return [req.text as string];
      case "ui.overlay": {
        const p = req.panel as Overlay | null; if (!p || typeof p !== "object") return [];
        return [p.title, ...(Array.isArray(p.lines) ? p.lines : []), p.bar?.label].filter((t): t is string => typeof t === "string");
      }
      default: return [];
    }
  }
  private syncCounters() {
    if (this.counterTick === this.eng.tickCount) return;
    this.counterTick = this.eng.tickCount;
    this.spawnsTick.clear(); this.fxTick.clear();
    if (!this.txn) this.calls.clear();
  }
  /** Log once when `used` first goes over the near-limit share of `max`. */
  private near(system: string, limit: string, used: number, max: number, step = 1) {
    const at = max * LIMITS.nearLimitShare;
    if (used > at && used - step <= at) this.pushLog(this.nearLimits, { tick: this.eng.tickCount, system, limit, used, max });
  }
  private pushLog<T>(log: T[], e: T) { log.push(e); if (log.length > LIMITS.logMax) log.splice(0, log.length - LIMITS.logMax); }
  /** Queue an effect in the open transaction (dropped on rollback) or apply it now. */
  private effect(fn: () => void) { if (this.txn) this.txn.effects.push(fn); else fn(); }
  /** Record an engine/base event (delivery to reactions arrives with Phase 2). */
  private logEvent(name: string, payload: Record<string, unknown>) {
    this.events.push({ tick: this.eng.tickCount, name, payload });
    if (this.events.length > LIMITS.eventLogMax) this.events.shift();
  }

  /** Apply a write; if it would break an invariant, undo it and deny. */
  private write(affected: () => EntRec[]): void {
    const eng = this.eng; const own = !eng.journal;
    if (own) eng.journal = [];
    const mark = eng.journal!.length;
    try {
      const recs = affected();
      const problem = this.invariantProblem(recs);
      if (problem) { eng.rollbackTo(mark); deny("denied", `that would break an invariant: ${problem}`); }
    } catch (e) { eng.rollbackTo(mark); throw e; }
    finally { if (own) eng.journal = null; }
  }
  private invariantProblem(recs: EntRec[]): string | null {
    const eng = this.eng;
    if (!eng.player()) return "the player must exist";
    for (const r of recs) {
      if (!eng.entities.has(r.id)) continue;
      const p = eng.entityProblem(r); if (p) return p;
      if (r.pos) for (const t of eng.footprintOfRec(r)) if (eng.inMap(t.x, t.y) && !eng.at(r.pos.area, t.x, t.y).includes(r.id)) return "occupancy would not match positions";
    }
    return null;
  }

  // ======================= running requests =======================
  private run(system: string, req: Request, rec: EntRec | undefined, area: string): unknown {
    const eng = this.eng;
    const x = req.x as number, y = req.y as number;
    const pos = (): Pos => ({ x, y, area });
    switch (req.op) {
      // ---- reads ----
      case "query": {
        const ids = eng.query(req.with as string);
        const truncated = ids.length > LIMITS.queryMax;
        this.near(system, "queryMax", Math.min(ids.length, LIMITS.queryMax), LIMITS.queryMax, Math.min(ids.length, LIMITS.queryMax));
        return { ids: truncated ? ids.slice(0, LIMITS.queryMax) : ids, truncated };
      }
      case "at": return eng.at(area, x, y);
      case "info": return { type: rec!.type, pos: rec!.pos ? { ...rec!.pos } : null, tags: [...rec!.tags] };
      case "get": { const v = rec!.comps.get(req.comp as string); return v === undefined ? null : cloneJson(v); }
      case "tile.get": {
        const id = eng.inMap(x, y) ? eng.tileAt(area, x, y) : null; if (id === null) return null;
        return { sprite: id, tags: [...(catalogGet(id)?.tags ?? [])] };
      }
      case "tile.find": {
        const out: { x: number; y: number; area: string }[] = []; const a = eng.areas.get(area)!;
        for (let ty = 0; ty < eng.height; ty++) for (let tx = 0; tx < eng.width; tx++) if (catalogGet(a.tiles[ty][tx])?.tags.includes(req.tag as string)) out.push({ x: tx, y: ty, area });
        return out;
      }
      case "catalog.get": { const e = catalogGet(req.id as string); return e ? cloneJson(e) : null; }
      case "catalog.find": return catalogFind(req.tag as string);
      case "time": return { day: eng.day, hour: eng.hour, phase: eng.phase };
      case "rand": return eng.rand(system);
      case "state.get": { const v = eng.systemState.get(system); return v === undefined ? null : cloneJson(v); }
      case "state.getReplaced": { const v = eng.systemState.get(req.id as string); return v === undefined ? null : cloneJson(v); }
      case "area.list": return [...eng.areas.keys()];
      case "area.current": return eng.currentArea();

      // ---- writes ----
      case "spawn": {
        const type = req.type as string;
        if (!eng.types.has(type)) deny("denied", `"${type}" isn't a registered entity type; declare it in your manifest's entities`);
        const n = (this.spawnsTick.get(system) ?? 0) + 1;
        if (n > LIMITS.spawnsPerTick) deny("limit", `over ${LIMITS.spawnsPerTick} spawns this tick`);
        const live = (eng.ownedCount.get(system) ?? 0) + 1;
        if (live > LIMITS.liveEntitiesPerSystem) deny("limit", `over ${LIMITS.liveEntitiesPerSystem} live entities spawned by "${system}"`);
        let id = 0;
        this.write(() => { const r = eng.spawn(type, pos(), system); id = r.id; return [r]; });
        this.spawnsTick.set(system, n);
        this.near(system, "spawnsPerTick", n, LIMITS.spawnsPerTick);
        this.near(system, "liveEntitiesPerSystem", live, LIMITS.liveEntitiesPerSystem);
        return id;
      }
      case "destroy": this.write(() => { eng.destroy(rec!.id); return []; }); return null;
      case "move": this.write(() => { eng.setPos(rec!.id, pos(), req.instant !== true); return [rec!]; }); return null;
      case "lift": this.write(() => { eng.setPos(rec!.id, null); return [rec!]; }); return null;
      case "place": this.write(() => { eng.setPos(rec!.id, pos()); return [rec!]; }); return null;
      case "set": {
        const comp = req.comp as string; const value = cloneJson(req.value);
        if (comp === "sprite") this.checkSpriteComp(value);
        this.write(() => { eng.setComp(rec!.id, comp, value); return [rec!]; });
        return null;
      }
      case "remove": this.write(() => { eng.setComp(rec!.id, req.comp as string, undefined); return [rec!]; }); return null;
      case "tag": this.write(() => { eng.setTag(rec!.id, req.tag as string, true); return [rec!]; }); return null;
      case "untag": this.write(() => { eng.setTag(rec!.id, req.tag as string, false); return [rec!]; }); return null;
      case "anim": {
        const spr = (rec!.comps.get("sprite") as SpriteComp | undefined) ?? { id: eng.spriteIdOf(rec!) };
        if (!catalogGet(spr.id)?.anims?.[req.name as string]) deny("bad_request", `sprite "${spr.id}" has no anim "${req.name}"`);
        if (req.callback !== undefined) deny("denied", "not yet: anim callbacks arrive with timers in Phase 2");
        this.write(() => { eng.setComp(rec!.id, "sprite", { ...spr, anim: req.name as string }); return [rec!]; });
        eng.animStart.set(rec!.id, eng.tickCount);
        return null;
      }
      case "tile.set": {
        const sprite = req.sprite as string;
        if (!catalogGet(sprite)?.tags.includes("terrain")) deny("bad_request", `"${sprite}" isn't a terrain sprite`);
        this.write(() => { eng.setTile(area, x, y, sprite); return eng.at(area, x, y).map((id) => eng.rec(id)!); });
        return null;
      }
      case "state.set": {
        const value = cloneJson(req.value); const size = utf8Len(JSON.stringify(value));
        this.near(system, "stateBytes", size, LIMITS.stateBytes, size);
        if (size > LIMITS.stateBytes) deny("limit", `saved state is capped at ${LIMITS.stateBytes} bytes`);
        this.write(() => { eng.setState(system, value); return []; });
        return null;
      }
      case "area.create": {
        const name = req.name as string; const fill = req.fill as string;
        if (!/^[a-z0-9_]{1,40}$/.test(name)) deny("bad_request", "area names are lowercase letters, digits and _");
        if (!catalogGet(fill)?.tags.includes("terrain")) deny("bad_request", `"${fill}" isn't a terrain sprite`);
        const id = `${system}.${name}`;
        if (eng.areas.has(id)) deny("denied", `area "${id}" already exists`);
        const tiles = Array.from({ length: eng.height }, () => Array.from({ length: eng.width }, () => fill));
        this.write(() => { eng.createArea(id, tiles, system); return []; });
        return id;
      }
      case "travel": {
        const player = eng.player()!; const to: Pos = { x, y, area };
        if (!eng.footprintFree(eng.spriteIdOf(player), to, player.id)) deny("denied", `travel target (${x}, ${y}) in ${area} isn't free for the player`);
        const from = player.pos?.area ?? area;
        this.write(() => { eng.setPos(player.id, to); return [player]; });
        this.logEvent("player.traveled", { from, to: area, pos: { ...to } });
        return null;
      }
      case "emit": deny("denied", "not yet: event delivery arrives in Phase 2"); return null;

      // ---- effects (queued in a transaction, dropped on rollback) ----
      case "fx.particles": {
        const sprite = req.sprite as string;
        if (!catalogGet(sprite)) deny("bad_request", `"${sprite}" isn't in the catalog`);
        const count = (req.count as number | undefined) ?? TUNING.particleDefaultCount;
        if (count < 1 || count > LIMITS.particlesPerRequest) deny("bad_request", `count must be 1 to ${LIMITS.particlesPerRequest}`);
        const kept = this.takeFx(system, count);
        if (kept) this.effect(() => {
          const frames = catalogGet(sprite)?.frames ?? 1;
          for (let i = 0; i < kept; i++) eng.particles.push({ area, sprite, x, y, vx: (eng.rand(ENGINE_OWNER) - 0.5) * 0.08, vy: -eng.rand(ENGINE_OWNER) * 0.08, life: 0, maxLife: TUNING.particleTicks, frame: Math.floor(eng.rand(ENGINE_OWNER) * frames) });
        });
        return { shown: kept, dropped: count - kept };
      }
      case "fx.float": {
        const color = (req.color as string | undefined) ?? "#ffffff";
        if (!COLOR_RE.test(color)) deny("bad_request", "color is a hex colour like #ffcc66");
        const kept = this.takeFx(system, 1);
        if (kept) this.effect(() => eng.floats.push({ area, text: req.text as string, color, x, y, life: 0, maxLife: TUNING.floatTicks }));
        return { shown: kept, dropped: 1 - kept };
      }
      case "fx.tint": {
        const color = req.color as string; const alpha = req.alpha as number; const ms = req.ms as number;
        if (!COLOR_RE.test(color)) deny("bad_request", "color is a hex colour like #ffcc66");
        if (alpha < 0 || ms <= 0) deny("bad_request", "alpha must be 0 or more and ms more than 0");
        this.effect(() => { eng.tint = { color, alpha, t: 0, max: Math.max(1, Math.round((ms / 1000) * TUNING.ticksPerSecond)) }; });
        return null;
      }
      case "ui.banner": {
        const last = this.lastBanner.get(system);
        if (last !== undefined && eng.tickCount - last < LIMITS.bannerIntervalTicks) return { shown: false };
        this.lastBanner.set(system, eng.tickCount);
        this.effect(() => { eng.banner = { text: req.text as string, t: TUNING.bannerTicks }; });
        return { shown: true };
      }
      case "ui.hud.add": {
        const width = req.width as number; const icon = req.icon as string | undefined;
        if (width < 1 || width > LIMITS.hudMaxWidth) deny("bad_request", `width must be 1 to ${LIMITS.hudMaxWidth}`);
        if (icon !== undefined && !catalogGet(icon)) deny("bad_request", `icon "${icon}" isn't in the catalog`);
        const key = `${system}:${req.key}`;
        this.effect(() => eng.hudSlots.set(key, { owner: system, key: req.key as string, text: req.text as string, width, icon }));
        return null;
      }
      case "ui.hud.remove": { const key = `${system}:${req.key}`; this.effect(() => eng.hudSlots.delete(key)); return null; }
      case "ui.overlay": {
        const panel = this.checkOverlay(req.panel);
        this.effect(() => { eng.overlay = panel ? { owner: system, value: panel } : null; });
        return null;
      }
    }
    return deny("bad_request", `unknown op "${req.op}"`);
  }

  private takeFx(system: string, want: number): number {
    const used = this.fxTick.get(system) ?? 0; const kept = Math.max(0, Math.min(want, LIMITS.fxPerTick - used));
    this.fxTick.set(system, used + kept);
    this.near(system, "fxPerTick", used + kept, LIMITS.fxPerTick, kept);
    return kept;
  }
  private checkSpriteComp(v: unknown) {
    const s = v as SpriteComp;
    if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.id !== "string") deny("bad_request", "sprite is { id, anim?, frame?, z?, offset? }");
    if (!catalogGet(s.id)) deny("bad_request", `sprite "${s.id}" isn't in the catalog`);
  }
  private checkOverlay(v: unknown): Overlay | null {
    if (v === null) return null;
    const p = v as Overlay; const bad = () => deny("bad_request", "panel is { title?, lines: string[], bar?: { value, label? } } or null");
    if (typeof p !== "object" || Array.isArray(p)) bad();
    for (const k of Object.keys(p)) if (!["title", "lines", "bar"].includes(k)) bad();
    if (p.title !== undefined && typeof p.title !== "string") bad();
    if (!Array.isArray(p.lines) || !p.lines.every((l) => typeof l === "string")) bad();
    if (p.lines.length > LIMITS.overlayMaxLines) deny("bad_request", `the overlay has at most ${LIMITS.overlayMaxLines} lines`);
    if (p.bar !== undefined && (typeof p.bar !== "object" || p.bar === null || typeof p.bar.value !== "number" || (p.bar.label !== undefined && typeof p.bar.label !== "string"))) bad();
    return p;
  }
}
