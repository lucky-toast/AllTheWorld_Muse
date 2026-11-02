// The one dispatcher (spec section 4). Every world access by a system, base or AI,
// goes through host.call(systemId, request). Each request passes five checks in
// order: shape, phase, blocked actions, budget, invariants. A denial is a normal
// response (never a crash) and is logged with the near-limit log (4.7).
//
// The host also runs the systems: it loads them (registry, module, migrate), calls
// their handlers as transactions, delivers events (spec 8), fires timers and tweens,
// owns focus (spec 7), the controls and the E resolver (spec 6), and the test-only
// sim.* and check requests.
import { catalogGet, catalogFind, footprintOf, footprintTiles } from "./catalog";
import { Engine, cloneJson, type EntRec, type Overlay } from "./engine";
import { ENGINE_OWNER, type Pos, type SpriteComp } from "./types";
import { validateManifest, type Manifest } from "./manifest";
import { Registry, ENGINE_EVENTS } from "./registry";
import { checkPayload } from "./events";
import { Focus, type FocusMode } from "./focus";
import { Controls, KEYS, type Key } from "./input";
import { Interactions } from "./interactions";
import type { LoadedSystem, SystemDef, SystemModule } from "./systems";
import { LIMITS, TUNING } from "../tuning";

export type Code = "bad_request" | "denied" | "missing" | "limit" | "phase";
export type Request = { op: string; [field: string]: unknown };
export type Response = { ok: true; r: unknown } | { ok: false; code: Code; msg: string };
/** live: normal play. test/shot: a pipeline test or shot is running, so sim.* and check are allowed. */
export type HostMode = "live" | "test" | "shot";
/** The handler names a transaction can wrap (spec 4.4). */
export type CallKind = "perform" | "onEvent" | "onTick" | "onTimer" | "onInput" | "onTween" | "migrate" | "test" | "shot";

export interface DenialEntry { tick: number; system: string; op: string; code: Code; msg: string }
/** A spawn or place that didn't go where it was asked, because something was in the way there. */
export interface RelocationEntry { tick: number; system: string; op: string; what: string; asked: Pos; placed: Pos; inTheWay: string }
export interface NearLimitEntry { tick: number; system: string; limit: string; used: number; max: number }
export interface EventEntry { tick: number; name: string; payload: Record<string, unknown> }
/** Two systems wrote the same entity while handling one event (logged, never failed). */
export interface OverlapEntry { tick: number; event: string; entity: number; systems: string[] }
/** A handler call that threw and was rolled back. */
export interface FaultEntry { tick: number; system: string; kind: CallKind; msg: string }
/** A strike against an AI system (spec 10.4): a fault during live play. `count` is strikes in the window. */
export interface StrikeEntry { tick: number; system: string; msg: string; count: number }
/** Systems unloaded together after too many strikes (the struck system first, then its dependents). */
export interface UnloadEntry { tick: number; ids: string[]; reason: string }
/** What the running test has recorded (checks and every event since it started). */
export interface TestCapture { checks: { label: string; passed: boolean }[]; events: EventEntry[] }

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
  "space.find": { ...TILE, w: "int", h: "int" },
  spawn: { type: "name", ...TILE, "exact?": "bool" }, destroy: { id: "id" }, move: { id: "id", ...TILE, "instant?": "bool" },
  lift: { id: "id" }, place: { id: "id", ...TILE, "exact?": "bool" },
  set: { id: "id", comp: "name", value: "json" }, remove: { id: "id", comp: "name" },
  tag: { id: "id", tag: "name" }, untag: { id: "id", tag: "name" },
  anim: { id: "id", name: "name", "callback?": "name" },
  "tile.set": { ...TILE, sprite: "name" }, "tile.stamp": { ...TILE, rows: "json", "exact?": "bool" }, "state.set": { value: "json" },
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
  "sim.time": { phaseOrHour: "json" }, "sim.key": { key: "name", kind: "name" }, "sim.events": { "name?": "name" },
  check: { cond: "bool", label: "text" },
};
const DIRS = ["up", "down", "left", "right"];
/** Errors thrown out of a module carry the id of the system whose handler threw. */
const FAULT_SYSTEM = Symbol("faultSystem");
const PLAYER_GUARDED = new Set(["destroy", "lift", "move", "place"]);
/** Tags and components that make a tile not free, and that may never cover the player's tile. */
const BLOCKERS = ["player", "solid", "pushable", "item"];
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

interface Txn { id: number; system: string; kind: CallKind; effects: (() => void)[] }
interface EmitFrame { event: string; writes: Map<number, Set<string>> }

export class Host {
  /** Loaded systems by id, in load order. */
  systems = new Map<string, LoadedSystem>();
  registry = new Registry([]);
  /** Goes up whenever the registry is rebuilt (the E resolver re-runs). */
  registryVersion = 0;
  focus: Focus;
  controls: Controls;
  interactions: Interactions;
  mode: HostMode = "live";
  /** System whose `migrate` is running, if any (state.getReplaced is allowed only then). */
  migrating: string | null = null;
  /** Succession (spec 11): replaced id -> the id that replaced it. A replaced id in `buildsOn` resolves through this. */
  successors = new Map<string, string>();
  /** Successions made by `load` in this host: new id -> the systems it retired and the load order before. `forget` undoes them. */
  private successions = new Map<string, { retired: LoadedSystem[]; order: string[] }>();
  denials: DenialEntry[] = [];
  /** Spawns and places the host moved to the nearest free spot (failure reports show them). */
  relocations: RelocationEntry[] = [];
  nearLimits: NearLimitEntry[] = [];
  events: EventEntry[] = [];
  overlaps: OverlapEntry[] = [];
  faults: FaultEntry[] = [];
  strikes: StrikeEntry[] = [];
  unloads: UnloadEntry[] = [];
  /** The running test's checks and events, or null outside tests. */
  capture: TestCapture | null = null;
  /** Called when a transaction rolls back (after the fault is logged, before any strike). */
  onFault: ((system: string, kind: CallKind, message: string) => void) | null = null;
  private txn: Txn | null = null;
  private txnCounter = 0;
  /** Recent strike ticks per system, inside the strike window. */
  private strikeTicks = new Map<string, number[]>();
  private emitDepth = 0;
  private emitFrames: EmitFrame[] = [];
  /** Ticks on which the player tried a step (player.moved or player.blocked fired), for sim.walk. */
  private stepAttempts = 0;
  private lastAttemptTick = -1;
  private counterTick = -1;
  private calls = new Map<string, number>();
  private spawnsTick = new Map<string, number>();
  private fxTick = new Map<string, number>();
  private lastBanner = new Map<string, number>();

  constructor(public eng: Engine) {
    this.focus = new Focus(eng);
    this.focus.onForcedEnd = (system) => this.deliverInput(system, "escape", "down", true);
    this.controls = new Controls(this);
    this.interactions = new Interactions(this);
  }

  // ======================= systems =======================
  /**
   * Load a system: validate and freeze its manifest, register its entity types and components,
   * rebuild the registry, create its module, run `migrate` (one transaction) and emit system.loaded.
   * Throws (and loads nothing) if the manifest is invalid, the id is taken or migrate fails.
   * `migrate: false` skips migrate (the system is joining a saved world it already set up, or a
   * test arena); `announce: false` leaves system.loaded for the caller to emit.
   */
  load(def: SystemDef, opts: { migrate?: boolean; announce?: boolean } = {}): LoadedSystem {
    const raw = def.manifest as { id?: unknown; replaces?: unknown; emits?: unknown };
    const res = validateManifest(def.manifest, { base: def.base, inherited: this.inheritedEvents(raw) });
    if (!res.ok) throw new Error(`manifest of "${String(raw?.id)}" is invalid: ${res.errors.join("; ")}`);
    const manifest = res.manifest;
    if (this.systems.has(manifest.id)) throw new Error(`system "${manifest.id}" is already loaded`);
    // Succession (spec 11): the loaded systems it replaces retire in the same step. A replaced id
    // that isn't loaded (a startup from storage, or a check world without it) is left alone.
    const retired: LoadedSystem[] = [];
    for (const r of manifest.replaces) {
      const old = this.systems.get(r); if (!old) continue;
      if (old.base) throw new Error(`"${manifest.id}" can't replace "${r}": base systems can't be replaced`);
      retired.push(old);
    }
    const snap = this.eng.snapshot();
    const order = [...this.systems.keys()];
    for (const old of retired) {
      this.clearRuntime(old.id);
      this.systems.delete(old.id);
      this.eng.transferOwnership(old.id, manifest.id);
      this.successors.set(old.id, manifest.id);
    }
    for (const [n, t] of Object.entries(manifest.entities)) this.eng.registerType(n, t, manifest.id);
    for (const c of Object.keys(manifest.components)) this.eng.declareComponent(c, manifest.id);
    const sys: LoadedSystem = { id: manifest.id, manifest, base: def.base, def, module: {} };
    this.systems.set(sys.id, sys);
    this.rebuildRegistry();
    const undo = () => { this.systems.delete(sys.id); this.reinstate(retired, order); this.eng.restore(snap); };
    try { sys.module = def.create((req) => this.call(sys.id, req), this); }
    catch (e) { undo(); throw e; }
    if (sys.module.migrate && opts.migrate !== false) {
      const prev = this.migrating; this.migrating = sys.id;
      const r = this.invoke(sys.id, "migrate", () => sys.module.migrate!());
      this.migrating = prev;
      if (!r.ok) { undo(); throw new Error(`migrate of "${sys.id}" failed: ${r.error}`); }
    }
    // The replaced systems' saved state was readable during migrate only (state.getReplaced).
    for (const old of retired) this.eng.systemState.delete(old.id);
    if (retired.length) this.successions.set(sys.id, { retired, order });
    if (opts.announce !== false) {
      for (const old of retired) this.emitEngine("system.unloaded", { id: old.id, reason: `replaced by ${sys.id}` });
      this.emitEngine("system.loaded", { id: sys.id });
    }
    return sys;
  }

  /**
   * Events a manifest may emit without its own prefix because it replaces their owner (spec 11):
   * every event a loaded replaced system emits, and, when the replaced system isn't loaded here
   * (startup from storage, a test world without it), its events by name: those whose prefix is
   * the replaced id or an id that it replaced in turn. The Manifest stage already checked them.
   */
  inheritedEvents(raw: { replaces?: unknown; emits?: unknown }): string[] {
    const replaces = Array.isArray(raw?.replaces) ? raw.replaces.filter((r): r is string => typeof r === "string") : [];
    const out = replaces.flatMap((r) => Object.keys(this.systems.get(r)?.manifest.emits ?? {}));
    const emits = raw?.emits && typeof raw.emits === "object" ? Object.keys(raw.emits) : [];
    for (const ev of emits) {
      const prefix = ev.slice(0, ev.indexOf("."));
      if (replaces.some((r) => r === prefix || (!this.systems.has(r) && this.resolvesTo(prefix, r)))) out.push(ev);
    }
    return out;
  }
  /** True when following successions from `id` reaches `target`. */
  private resolvesTo(id: string, target: string): boolean {
    const seen = new Set<string>();
    while (this.successors.has(id) && !seen.has(id)) { seen.add(id); id = this.successors.get(id)!; if (id === target) return true; }
    return false;
  }

  /** Systems `id` retired when it loaded in this host (empty when it replaced nothing). */
  retiredBy(id: string): string[] { return this.successions.get(id)?.retired.map((s) => s.id) ?? []; }

  /** `id`, or the system that replaced it (following successions to the newest). */
  resolve(id: string): string {
    const seen = new Set<string>();
    while (this.successors.has(id) && !seen.has(id)) { seen.add(id); id = this.successors.get(id)!; }
    return id;
  }

  /** Put retired systems back (their modules as they were) and the load order as it was. */
  private reinstate(retired: LoadedSystem[], order: string[]) {
    for (const old of retired) { this.systems.set(old.id, old); this.successors.delete(old.id); }
    if (retired.length) {
      const ids = [...order.filter((id) => this.systems.has(id)), ...[...this.systems.keys()].filter((id) => !order.includes(id))];
      this.systems = new Map(ids.map((id) => [id, this.systems.get(id)!]));
    }
    this.rebuildRegistry();
  }

  /** Clear a leaving system's focus, timers, tweens, HUD slots and overlay. */
  private clearRuntime(id: string) {
    if (this.focus.holder === id) this.focus.endIfHolder(id, "unload");
    this.eng.timers = this.eng.timers.filter((t) => t.system !== id);
    this.eng.tweens = this.eng.tweens.filter((t) => t.system !== id);
    for (const [k, slot] of this.eng.hudSlots) if (slot.owner === id) this.eng.hudSlots.delete(k);
    if (this.eng.overlay?.owner === id) this.eng.overlay = null;
  }

  /**
   * Take a system out without a trace (no system.unloaded): a live load that failed, or Undo,
   * which restores the snapshot taken before the load right after. Clears its focus, timers,
   * tweens, HUD slots and overlay like unload. If its load retired systems (succession), they
   * come back in their old place in the load order.
   */
  forget(id: string) {
    if (!this.systems.has(id)) return;
    this.clearRuntime(id);
    this.systems.delete(id);
    const s = this.successions.get(id); this.successions.delete(id);
    this.reinstate(s?.retired ?? [], s?.order ?? []);
  }

  /** Load a manifest with no handlers (tests and tools). Missing fields get defaults. */
  addSystem(m: Partial<Manifest> & { id: string }, base: boolean): LoadedSystem {
    return this.load({ manifest: { why: "(test)", ...m }, base, create: () => ({}) });
  }

  /**
   * Unload a system: its entities, components and tags stay in the world without behaviour; its
   * focus, timers, tweens, HUD slots and overlay are cleared. Emits system.unloaded.
   */
  unload(id: string, reason: string) {
    if (!this.systems.has(id)) return;
    this.clearRuntime(id);
    this.systems.delete(id);
    this.successions.delete(id);
    this.rebuildRegistry();
    this.emitEngine("system.unloaded", { id, reason });
  }

  /** Shift+R: rebuild the registry and re-create every loaded module, keeping the world. Nothing is migrated or duplicated. */
  reloadSystems() {
    this.rebuildRegistry();
    for (const sys of this.systems.values()) sys.module = sys.def.create((req) => this.call(sys.id, req), this);
  }

  private rebuildRegistry() {
    this.registry = new Registry([...this.systems.values()].map((s) => s.manifest));
    this.registryVersion++;
    // The clock advances only while daynight is loaded.
    this.eng.clockRunning = this.systems.has("daynight");
  }

  // ======================= transactions (4.4) =======================
  /** Run one system call as a transaction. If it throws, every write is undone and its queued effects are dropped. */
  invoke(system: string, kind: CallKind, fn: () => void): { ok: true } | { ok: false; error: string } {
    if (this.txn) { fn(); return { ok: true }; } // nested (an emit reaching another system): part of the outer transaction
    this.syncCounters();
    this.calls.clear();
    const txn: Txn = { id: ++this.txnCounter, system, kind, effects: [] };
    this.txn = txn; this.eng.journal = [];
    const depth = this.emitDepth; const frames = this.emitFrames.length;
    try { fn(); }
    catch (e) {
      this.eng.rollbackTo(0);
      this.eng.journal = null; this.txn = null;
      this.emitDepth = depth; this.emitFrames.length = frames;
      const msg = e instanceof Error ? e.message : String(e);
      const who = (e as { [FAULT_SYSTEM]?: string } | null)?.[FAULT_SYSTEM] ?? system;
      this.pushLog(this.faults, { tick: this.eng.tickCount, system: who, kind, msg });
      // The holder faulted: the engine takes the controls back.
      this.focus.endIfHolder(who, "fault");
      this.onFault?.(who, kind, msg);
      if (this.mode === "live" && kind !== "migrate") this.strike(who, msg);
      return { ok: false, error: msg };
    }
    this.eng.journal = null; this.txn = null;
    for (const fx of txn.effects) fx();
    return { ok: true };
  }
  get inTransaction() { return this.txn !== null; }
  /** Id of the open transaction (unique per host), or 0 when none is open. Nested calls share it. */
  get transactionId(): number { return this.txn?.id ?? 0; }

  // ======================= strikes (10.4) =======================
  /** A fault during live play counts as a strike against an AI system. Three in a minute unload it and its dependents. */
  private strike(system: string, msg: string) {
    const sys = this.systems.get(system); if (!sys || sys.base) return;
    const now = this.eng.tickCount;
    const ticks = (this.strikeTicks.get(system) ?? []).filter((t) => now - t < LIMITS.strikeWindowTicks);
    ticks.push(now); this.strikeTicks.set(system, ticks);
    this.pushLog(this.strikes, { tick: now, system, msg, count: ticks.length });
    if (ticks.length >= LIMITS.strikesToUnload) { this.strikeTicks.delete(system); this.unloadWithDependents(system, "strikes"); }
  }

  /** Every loaded system that builds on `id`, directly or through others, in load order. A replaced id in `buildsOn` counts as its replacement. */
  dependentsOf(id: string): string[] {
    const out = new Set<string>([id]);
    for (const s of this.systems.values()) if (s.manifest.buildsOn.some((b) => out.has(this.resolve(b)))) out.add(s.id);
    out.delete(id);
    return [...out];
  }

  /** Unload a system and everything that builds on it (dependents first), with a banner. Their entities stay. */
  unloadWithDependents(id: string, reason: string) {
    if (!this.systems.has(id)) return;
    const ids = [id, ...this.dependentsOf(id)];
    for (const x of [...ids].reverse()) this.unload(x, reason);
    this.pushLog(this.unloads, { tick: this.eng.tickCount, ids, reason });
    const text = `${id} kept failing and was removed`;
    this.eng.banner = { text: text.length <= LIMITS.textMaxChars ? text : "A system kept failing and was removed", t: TUNING.bannerTicks };
  }

  /** Log a system that used more than half of a limit in one call (the sandbox reports fuel this way). */
  logNearLimit(system: string, limit: string, used: number, max: number) {
    if (used > max * LIMITS.nearLimitShare) this.pushLog(this.nearLimits, { tick: this.eng.tickCount, system, limit, used, max });
  }

  /** Call one handler of a loaded system as a transaction (or inside the open one). A missing handler does nothing. */
  callHandler(system: string, kind: CallKind, fn: (m: SystemModule) => void): { ok: true } | { ok: false; error: string } {
    const sys = this.systems.get(system); if (!sys) return { ok: true };
    return this.invoke(system, kind, () => {
      try { fn(sys.module); }
      catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!(FAULT_SYSTEM in err)) Object.assign(err, { [FAULT_SYSTEM]: system });
        throw err;
      }
    });
  }

  /** E: perform(verb, target, held) on the owner, as one transaction. */
  runPerform(owner: string, verb: string, target: number, held: number) {
    return this.callHandler(owner, "perform", (m) => m.perform?.(verb, target, held));
  }

  /** A key for a system's onInput (borrow focus, movement without focus, or "escape" when focus is taken back). */
  deliverInput(system: string, key: Key | string, kind: string, ownTransaction = false) {
    if (ownTransaction && this.txn) {
      // Focus ended inside a transaction (the holder unloaded mid-call): tell it once the call is done.
      this.txn.effects.push(() => this.deliverInput(system, key, kind));
      return;
    }
    this.callHandler(system, "onInput", (m) => m.onInput?.(key, kind));
  }

  // ======================= events (spec 8) =======================
  /** Emit an engine-owned event (player.traveled, interaction.performed, time.jumped, system.*). */
  emitEngine(name: string, payload: Record<string, unknown>) {
    const shape = ENGINE_EVENTS[name];
    const chk = checkPayload(this.eng, name, shape, payload);
    if (!chk.ok) throw new Error(chk.msg);
    this.deliver(name, chk.payload);
  }

  /** Deliver an event to every system that reacts to it, in load order, inside the open transaction (or one each). */
  private deliver(name: string, payload: Record<string, unknown>) {
    const entry = { tick: this.eng.tickCount, name, payload };
    this.events.push(entry); if (this.events.length > LIMITS.eventLogMax) this.events.shift();
    this.capture?.events.push(entry);
    if ((name === "player.moved" || name === "player.blocked") && this.lastAttemptTick !== this.eng.tickCount) { this.lastAttemptTick = this.eng.tickCount; this.stepAttempts++; }
    const reactors = this.registry.reactors(name); if (!reactors.length) return;
    const json = JSON.stringify(payload);
    const frame: EmitFrame = { event: name, writes: new Map() };
    this.emitDepth++; this.emitFrames.push(frame);
    try {
      for (const id of reactors) {
        if (!this.systems.has(id)) continue;
        const r = this.callHandler(id, "onEvent", (m) => m.onEvent?.(name, json));
        void r; // outside a transaction each reactor is its own; a fault there is logged and rolled back alone
      }
    } finally {
      this.emitDepth--; this.emitFrames.pop();
    }
    for (const [entity, systems] of frame.writes) if (systems.size > 1) this.pushLog(this.overlaps, { tick: this.eng.tickCount, event: name, entity, systems: [...systems] });
  }

  /** Note that `system` wrote `entity`, for the overlap log. */
  private noteWrite(system: string, entity: number) {
    for (const f of this.emitFrames) { let s = f.writes.get(entity); if (!s) { s = new Set(); f.writes.set(entity, s); } s.add(system); }
  }

  // ======================= ticking =======================
  /** One tick: the engine, then keys, every system's onTick in load order, timers, tweens, focus limits and the E resolver. */
  tick() {
    this.eng.tick();
    this.syncCounters();
    this.controls.tick();
    for (const sys of [...this.systems.values()]) if (sys.module.onTick && this.systems.has(sys.id)) this.callHandler(sys.id, "onTick", (m) => m.onTick!());
    this.fireTimers();
    this.runTweens();
    this.focus.tick();
    this.interactions.refresh();
  }

  private fireTimers() {
    const now = this.eng.tickCount;
    const due = this.eng.timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    if (!due.length) return;
    this.eng.timers = this.eng.timers.filter((t) => t.at > now);
    // Each callback is its own transaction. Requests about an entity that is gone by now answer "missing".
    for (const t of due) this.callHandler(t.system, "onTimer", (m) => m.onTimer?.(t.name));
  }

  private runTweens() {
    if (!this.eng.tweens.length) return;
    for (const tw of [...this.eng.tweens]) {
      tw.t++;
      const value = tw.from + (tw.to - tw.from) * (tw.t / tw.ticks);
      if (tw.t >= tw.ticks) this.eng.tweens = this.eng.tweens.filter((x) => x !== tw);
      this.callHandler(tw.system, "onTween", (m) => m.onTween?.(tw.id, value));
    }
  }

  // ======================= tests (spec 4.2, test-only requests) =======================
  /** Run `test_<name>` of a loaded system on this world. Passes when every check passed and at least one ran. */
  runTest(system: string, name: string): { passed: boolean; checks: { label: string; passed: boolean }[]; events: EventEntry[]; error: string | null } {
    const sys = this.systems.get(system);
    const fn = sys?.module[`test_${name}`];
    const capture: TestCapture = { checks: [], events: [] };
    const mode = this.mode; this.mode = "test"; this.capture = capture;
    let error: string | null = null;
    try { if (!fn) throw new Error(`"${system}" has no test_${name}`); fn.call(sys!.module); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { this.mode = mode; this.capture = null; }
    const passed = !error && capture.checks.length > 0 && capture.checks.every((c) => c.passed);
    return { passed, checks: capture.checks, events: capture.events.slice(-LIMITS.eventLogMax), error };
  }

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
    if ("x" in shape && op !== "tile.get" && op !== "at" && !eng.inMap(req.x as number, req.y as number)) deny("bad_request", `tile (${req.x}, ${req.y}) is outside the ${eng.width}x${eng.height} map`);

    // ---- 2. Phase ----
    if ((op.startsWith("sim.") || op === "check") && this.mode === "live") deny("phase", `${op} is only allowed while tests or shots run`);
    if (op === "state.getReplaced") {
      const id = req.id as string;
      if (this.migrating !== system || !sys?.manifest.replaces.includes(id)) deny("phase", `state.getReplaced("${id}") is only allowed during migrate of a system that replaces "${id}"`);
    }
    if ((op === "sim.walk" || op === "sim.face" || op === "sim.interact" || op === "sim.cycle" || op === "sim.wait" || op === "sim.key") && this.txn)
      deny("phase", `${op} runs ticks, so it can't be used inside a handler call`);

    // Entities named by id must exist (a request on a gone entity is "missing", not a fault).
    const rec = typeof req.id === "number" && op !== "catalog.get" && op !== "state.getReplaced" ? eng.rec(req.id) ?? deny("missing", `entity ${req.id} no longer exists`) : undefined;

    // ---- 3. Blocked actions ----
    const player = eng.player();
    if (rec && PLAYER_GUARDED.has(op) && rec === player && !(op === "move" && sys?.base && system === "movement"))
      deny("denied", `${op} can't act on the player; only base movement, travel and sim.teleport move the player`);
    if (op === "tile.set" && player?.pos && player.pos.area === area && !this.walkableSprite(req.sprite as string)
      && eng.footprintOfRec(player).some((t) => t.x === req.x && t.y === req.y))
      deny("denied", `tile.set can't make the tile under the player unwalkable`);
    if (op === "emit" && system !== ENGINE_OWNER && !this.registry.owns(system, req.name as string))
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
  /** A solid, pushable or item entity (the player aside): one that makes its tiles not free. */
  private blocks(r: EntRec) { return BLOCKERS.some((b) => this.eng.has(r, b)); }
  /** Does `sprite` fit at `pos`: every footprint tile in the map, walkable, and, for a blocking entity, free of the player and other blockers. */
  private fits(sprite: string, blocking: boolean, pos: Pos, selfId: number): boolean {
    const eng = this.eng;
    return footprintTiles(sprite, pos.x, pos.y).every((t) => eng.inMap(t.x, t.y) && (blocking ? eng.isFreeFor(pos.area, t.x, t.y, selfId) : eng.isWalkable(pos.area, t.x, t.y)));
  }
  /**
   * Where an entity goes for spawn and place: (x, y) when it fits there, otherwise the closest
   * position in the area where it fits (by distance from (x, y), then top to bottom, left to right).
   * With exact, (x, y) or a denial.
   */
  /** What keeps `sprite` from fitting at `pos`, e.g. "tree_round#12 at (23, 6)" or "unwalkable stream_h at (4, 16)". */
  private inTheWay(sprite: string, blocking: boolean, pos: Pos, selfId: number): string {
    const eng = this.eng; const out = new Map<string, string[]>(); // what -> its tiles
    const add = (what: string, x: number, y: number) => { const l = out.get(what) ?? []; l.push(`(${x}, ${y})`); out.set(what, l); };
    for (const t of footprintTiles(sprite, pos.x, pos.y)) {
      if (!eng.inMap(t.x, t.y)) { out.set("the map edge", []); continue; }
      if (!eng.isWalkable(pos.area, t.x, t.y)) { add(`unwalkable ${eng.tileAt(pos.area, t.x, t.y)}`, t.x, t.y); continue; }
      if (!blocking) continue;
      for (const id of eng.at(pos.area, t.x, t.y)) {
        if (id === selfId) continue; const r = eng.entities.get(id)!;
        if (BLOCKERS.some((b) => eng.has(r, b))) add(`${r.type}#${r.id}`, t.x, t.y);
      }
    }
    return [...out].map(([what, tiles]) => tiles.length ? `${what} at ${tiles.join(", ")}` : what).join("; ");
  }
  private placement(what: string, sprite: string, blocking: boolean, pos: Pos, exact: boolean, selfId = 0, system = "", op = ""): Pos {
    if (this.fits(sprite, blocking, pos, selfId)) return pos;
    const fp = footprintOf(sprite); const size = `${fp.w}x${fp.h}`;
    if (exact) deny("denied", `(${pos.x}, ${pos.y}) isn't free for ${what} (${size} footprint, extending up from x, y); leave out exact to let the host use the nearest free spot`);
    for (const [dx, dy] of this.offsets()) {
      const p = { x: pos.x + dx, y: pos.y + dy, area: pos.area };
      if (this.eng.inMap(p.x, p.y) && this.fits(sprite, blocking, p, selfId)) {
        this.pushLog(this.relocations, { tick: this.eng.tickCount, system, op, what, asked: { ...pos }, placed: { ...p }, inTheWay: this.inTheWay(sprite, blocking, pos, selfId) });
        return p;
      }
    }
    return deny("denied", `there's no free spot for ${what} (${size} footprint) anywhere in ${pos.area}`);
  }
  private offsetCache: [number, number][] | null = null;
  /** Every (dx, dy) that can stay inside the map, nearest first: the spiral the nearest-fit search walks. */
  private offsets(): [number, number][] {
    if (this.offsetCache) return this.offsetCache;
    const out: [number, number][] = []; const w = this.eng.width, h = this.eng.height;
    for (let dy = -(h - 1); dy < h; dy++) for (let dx = -(w - 1); dx < w; dx++) out.push([dx, dy]);
    out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    return (this.offsetCache = out);
  }
  /** Top-left of the closest w x h block (from (x, y)) where `free(tx, ty)` holds for every cell that counts, or null. */
  private nearestBlock(x: number, y: number, w: number, h: number, cellFree: (tx: number, ty: number, cx: number, cy: number) => boolean, exact: boolean): { x: number; y: number } | null {
    const eng = this.eng;
    const ok = (ox: number, oy: number) => {
      if (!eng.inMap(ox, oy) || !eng.inMap(ox + w - 1, oy + h - 1)) return false;
      for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) if (!cellFree(ox + cx, oy + cy, cx, cy)) return false;
      return true;
    };
    if (exact) return ok(x, y) ? { x, y } : null;
    for (const [dx, dy] of this.offsets()) if (ok(x + dx, y + dy)) return { x: x + dx, y: y + dy };
    return null;
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
    const player = eng.player()!;
    const playerTiles = player.pos ? new Set(eng.footprintOfRec(player).map((t) => `${t.x},${t.y}`)) : new Set<string>();
    const onPlayer = (rec: EntRec) => !!rec.pos && rec.pos.area === player.pos?.area && eng.footprintOfRec(rec).some((t) => playerTiles.has(`${t.x},${t.y}`));
    for (const r of recs) {
      if (!eng.entities.has(r.id)) continue;
      const p = eng.entityProblem(r); if (p) return p;
      // The player can never be trapped: nothing that blocks may cover a tile the player stands on.
      if (r !== player && this.blocks(r) && onPlayer(r)) return `${r.type}#${r.id} would stand on the player's tile`;
      if (r === player && player.pos) for (const t of eng.footprintOfRec(player)) for (const id of eng.at(player.pos.area, t.x, t.y)) {
        const o = eng.rec(id)!; if (o !== player && this.blocks(o)) return `the player would stand on ${o.type}#${o.id}`;
      }
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
      case "space.find": {
        const w = req.w as number, h = req.h as number;
        if (w < 1 || h < 1 || w > eng.width || h > eng.height) deny("bad_request", `w and h must be 1 to ${eng.width} and 1 to ${eng.height}`);
        const b = this.nearestBlock(x, y, w, h, (tx, ty) => eng.isFreeFor(area, tx, ty), false);
        return b ? { ...b, area } : null;
      }
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
        const t = eng.types.get(type)!;
        const at = this.placement(`a ${type}`, t.sprite, t.tags.some((g) => BLOCKERS.includes(g)), pos(), req.exact === true, 0, system, "spawn");
        let id = 0;
        this.write(() => { const r = eng.spawn(type, at, system); id = r.id; return [r]; });
        this.noteWrite(system, id);
        this.spawnsTick.set(system, n);
        this.near(system, "spawnsPerTick", n, LIMITS.spawnsPerTick);
        this.near(system, "liveEntitiesPerSystem", live, LIMITS.liveEntitiesPerSystem);
        return id;
      }
      case "destroy": this.write(() => { eng.destroy(rec!.id); return []; }); this.noteWrite(system, rec!.id); return null;
      case "move": this.write(() => { eng.setPos(rec!.id, pos(), req.instant !== true); return [rec!]; }); this.noteWrite(system, rec!.id); return null;
      case "lift": this.write(() => { eng.setPos(rec!.id, null); return [rec!]; }); this.noteWrite(system, rec!.id); return null;
      case "place": {
        const at = this.placement(`${rec!.type}#${rec!.id}`, eng.spriteIdOf(rec!), this.blocks(rec!), pos(), req.exact === true, rec!.id, system, "place");
        this.write(() => { eng.setPos(rec!.id, at); return [rec!]; }); this.noteWrite(system, rec!.id);
        return { ...at };
      }
      case "set": {
        const comp = req.comp as string; const value = cloneJson(req.value);
        if (comp === "sprite") this.checkSpriteComp(value);
        this.write(() => { eng.setComp(rec!.id, comp, value); return [rec!]; });
        this.noteWrite(system, rec!.id);
        return null;
      }
      case "remove": this.write(() => { eng.setComp(rec!.id, req.comp as string, undefined); return [rec!]; }); this.noteWrite(system, rec!.id); return null;
      case "tag": this.write(() => { eng.setTag(rec!.id, req.tag as string, true); return [rec!]; }); this.noteWrite(system, rec!.id); return null;
      case "untag": this.write(() => { eng.setTag(rec!.id, req.tag as string, false); return [rec!]; }); this.noteWrite(system, rec!.id); return null;
      case "anim": {
        const spr = (rec!.comps.get("sprite") as SpriteComp | undefined) ?? { id: eng.spriteIdOf(rec!) };
        const anim = catalogGet(spr.id)?.anims?.[req.name as string];
        if (!anim) deny("bad_request", `sprite "${spr.id}" has no anim "${req.name}"`);
        this.write(() => { eng.setComp(rec!.id, "sprite", { ...spr, anim: req.name as string }); return [rec!]; });
        this.noteWrite(system, rec!.id);
        const start = eng.animStart.get(rec!.id);
        eng.animStart.set(rec!.id, eng.tickCount);
        eng.recordUndo(() => { if (start === undefined) eng.animStart.delete(rec!.id); else eng.animStart.set(rec!.id, start); });
        // onTimer(callback) when a non-looping anim ends, or after one loop of a looping one.
        if (req.callback !== undefined) this.addTimer(system, req.callback as string, animTicks(anim!));
        return null;
      }
      case "tile.set": {
        const sprite = req.sprite as string;
        if (!catalogGet(sprite)?.tags.includes("terrain")) deny("bad_request", `"${sprite}" isn't a terrain sprite`);
        this.write(() => { eng.setTile(area, x, y, sprite); return eng.at(area, x, y).map((id) => eng.rec(id)!); });
        return null;
      }
      case "tile.stamp": {
        const rows = this.checkRows(req.rows);
        const w = Math.max(...rows.map((r) => r.length)), h = rows.length;
        if (w > eng.width || h > eng.height) deny("bad_request", `rows is at most ${eng.height} rows of ${eng.width}`);
        // A cell is free for its new terrain when no player, solid, pushable or item stands on it,
        // and, when the new terrain isn't walkable, nothing stands on it at all. null cells don't count.
        const cellFree = (tx: number, ty: number, cx: number, cy: number) => {
          const s = rows[cy][cx] ?? null; if (s === null) return true;
          const ids = eng.at(area, tx, ty);
          return this.walkableSprite(s) ? ids.every((id) => !this.blocks(eng.rec(id)!)) : ids.length === 0;
        };
        const o = this.nearestBlock(x, y, w, h, cellFree, req.exact === true);
        if (!o) deny("denied", req.exact === true ? `the ${w}x${h} block at (${x}, ${y}) isn't free (something stands where the terrain changes); leave out exact to let the host move it to the nearest free block` : `there's no free ${w}x${h} block anywhere in ${area}`);
        this.write(() => {
          const touched = new Set<number>();
          rows.forEach((row, cy) => row.forEach((s, cx) => {
            if (s === null) return;
            eng.setTile(area, o!.x + cx, o!.y + cy, s);
            for (const id of eng.at(area, o!.x + cx, o!.y + cy)) touched.add(id);
          }));
          return [...touched].map((id) => eng.rec(id)!);
        });
        return { ...o!, area };
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
        // A fill nobody can stand on makes an area where nothing can be spawned and the player can't travel to.
        if (!this.walkableSprite(fill)) deny("bad_request", `"${fill}" isn't walkable terrain, so nothing could stand in the area; fill it with a walkable floor and tileStamp the rest`);
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
        this.noteWrite(system, player.id);
        this.emitEngine("player.traveled", { from, to: area, pos: { ...to } });
        return null;
      }
      case "emit": {
        const name = req.name as string;
        const shape = this.registry.eventShape.get(name) ?? ENGINE_EVENTS[name];
        if (!shape) deny("denied", `no system declares the event "${name}"`);
        const chk = checkPayload(eng, name, shape!, req.payload);
        if (!chk.ok) deny("denied", chk.msg);
        if (this.emitDepth >= LIMITS.emitDepth) deny("limit", `events nest at most ${LIMITS.emitDepth} levels deep`);
        this.near(system, "emitDepth", this.emitDepth + 1, LIMITS.emitDepth);
        this.deliver(name, (chk as { payload: Record<string, unknown> }).payload);
        return null;
      }
      case "timer": {
        const ticks = req.ticks as number;
        if (ticks < 1) deny("bad_request", "timer ticks must be 1 or more");
        this.addTimer(system, req.name as string, ticks);
        return null;
      }
      case "fx.tween": {
        const ticks = req.ticks as number;
        if (ticks < 1) deny("bad_request", "tween ticks must be 1 or more");
        const id = eng.nextTweenId++;
        this.effect(() => eng.tweens.push({ id, system, from: req.from as number, to: req.to as number, ticks, t: 0 }));
        return id;
      }
      case "focus": {
        const mode = req.mode as FocusMode;
        if (mode !== "borrow" && mode !== "freeze") deny("bad_request", `focus mode is "borrow" or "freeze"`);
        if (system === ENGINE_OWNER) deny("denied", "the engine doesn't take focus");
        const inPerform = this.txn?.kind === "perform" && this.txn.system === system;
        const why = this.focus.take(system, mode, inPerform);
        if (why) deny("denied", why);
        return null;
      }
      case "release": { const why = this.focus.release(system); if (why) deny("denied", why); return null; }

      // ---- test only (spec 4.2): played through the same paths as real keys ----
      case "sim.walk": {
        const dir = this.dir(req.dir); const steps = (req.steps as number | undefined) ?? 1;
        if (steps < 1 || steps > LIMITS.simWalkMaxSteps) deny("bad_request", `steps must be 1 to ${LIMITS.simWalkMaxSteps}`);
        const start = this.stepAttempts; const cap = TUNING.tapTurnTicks + steps * TUNING.simWalkTicksPerStep;
        this.controls.press(dir);
        for (let i = 0; i < cap && this.stepAttempts - start < steps; i++) this.tick();
        this.controls.release(dir); this.tick();
        return { tried: this.stepAttempts - start };
      }
      case "sim.face": {
        const dir = this.dir(req.dir);
        // Tapping the direction the player already faces would step, so a face that is already right does nothing.
        if (eng.player()?.comps.get("facing") === dir) return null;
        this.controls.press(dir); this.tick(); this.controls.release(dir); this.tick();
        return null;
      }
      case "sim.interact": this.controls.press("e"); this.controls.release("e"); this.tick(); return null;
      case "sim.cycle": this.controls.press("q"); this.controls.release("q"); this.tick(); return null;
      case "sim.key": {
        const key = req.key as Key; const kind = req.kind as string;
        if (!KEYS.includes(key)) deny("bad_request", `key is one of ${KEYS.join(", ")}`);
        if (kind !== "down" && kind !== "up") deny("bad_request", `kind is "down" or "up"`);
        if (kind === "down") this.controls.press(key); else this.controls.release(key);
        this.tick();
        return null;
      }
      case "sim.wait": {
        const ticks = req.ticks as number;
        if (ticks < 0 || ticks > TUNING.simWaitMaxTicks) deny("bad_request", `ticks must be 0 to ${TUNING.simWaitMaxTicks}`);
        for (let i = 0; i < ticks; i++) this.tick();
        return null;
      }
      case "sim.give": {
        const type = req.type as string; const player = eng.player()!;
        if (!eng.types.has(type)) deny("denied", `"${type}" isn't a registered entity type`);
        if (player.comps.has("held")) deny("denied", "the player's hands are full");
        if (!player.pos) deny("denied", "the player isn't on the map");
        let id = 0;
        // Spawned on the player's tile, then lifted and put in hand, exactly as pick up does.
        this.write(() => {
          const r = eng.spawn(type, { ...player.pos! }, system); id = r.id;
          eng.setPos(r.id, null); eng.setComp(player.id, "held", { id: r.id });
          return [r, player];
        });
        return id;
      }
      case "sim.teleport": {
        const player = eng.player()!; const to: Pos = { x, y, area };
        if (!eng.footprintFree(eng.spriteIdOf(player), to, player.id)) deny("denied", `(${x}, ${y}) in ${area} isn't free for the player`);
        this.write(() => { eng.setPos(player.id, to); return [player]; });
        return null;
      }
      case "sim.time": {
        const v = req.phaseOrHour;
        if (!(typeof v === "number" && v >= 0 && v < 24) && !(typeof v === "string" && ["dawn", "day", "daytime", "dusk", "night"].includes(v))) deny("bad_request", "phaseOrHour is dawn, day, dusk, night or an hour from 0 to 24");
        const j = eng.jumpClock(v as string | number);
        this.emitEngine("time.jumped", { from: j.from, to: j.to });
        // One tick, so daynight sees the new phase and time.phase (and every reaction to it) has
        // happened by the time the call returns, like every other sim.* call.
        this.tick();
        return null;
      }
      case "sim.events": {
        const name = req.name as string | undefined;
        const evs = this.capture?.events ?? [];
        return evs.filter((e) => !name || e.name === name).slice(-LIMITS.eventLogMax).map((e) => cloneJson(e));
      }
      case "check": {
        this.capture?.checks.push({ label: req.label as string, passed: req.cond as boolean });
        return null;
      }

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

  private dir(v: unknown): Key {
    if (typeof v !== "string" || !DIRS.includes(v)) deny("bad_request", "dir is up, down, left or right");
    return v as Key;
  }
  /** Queue onTimer(name) for `system` after `ticks` (dropped if the call rolls back). */
  private addTimer(system: string, name: string, ticks: number) {
    const eng = this.eng;
    this.effect(() => eng.timers.push({ system, name, at: eng.tickCount + ticks, seq: eng.nextTimerSeq++ }));
  }

  private takeFx(system: string, want: number): number {
    const used = this.fxTick.get(system) ?? 0; const kept = Math.max(0, Math.min(want, LIMITS.fxPerTick - used));
    this.fxTick.set(system, used + kept);
    this.near(system, "fxPerTick", used + kept, LIMITS.fxPerTick, kept);
    return kept;
  }
  /** tile.stamp rows: a list of rows, each a list of terrain sprite ids or null. */
  private checkRows(v: unknown): (string | null)[][] {
    const bad = () => deny("bad_request", "rows is a list of rows, each a list of terrain sprite ids or null (leave as is)");
    if (!Array.isArray(v) || !v.length || !v.every((r) => Array.isArray(r))) bad();
    const rows = v as unknown[][];
    if (!rows.some((r) => r.length)) bad();
    for (const r of rows) for (const s of r) {
      if (s === null) continue;
      if (typeof s !== "string") bad();
      if (!catalogGet(s as string)?.tags.includes("terrain")) deny("bad_request", `"${String(s)}" isn't a terrain sprite`);
    }
    return rows as (string | null)[][];
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

/** Ticks a sprite anim takes to end (non-looping) or to play one loop (looping), at the renderer's frame pace. */
export function animTicks(a: { from?: number; to?: number; rows?: number[]; fps?: number }): number {
  const span = a.rows ? a.rows[1] - a.rows[0] + 1 : (a.to ?? a.from ?? 0) - (a.from ?? 0) + 1;
  return Math.max(1, span * Math.max(1, Math.round(TUNING.ticksPerSecond / (a.fps ?? 8))));
}
