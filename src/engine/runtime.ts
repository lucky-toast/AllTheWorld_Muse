// Game runtime: systems, event bus (spec 8), timers/tweens (spec 4/5), transactions, sim/check.
import { catalogGet } from "./catalog";
import type { Engine, Pos } from "./engine";
import type { HostResponse } from "./host";
import { validateManifest, type Manifest } from "./manifest";
import { Registry, type LoadedSystem } from "./registry";
import { FocusManager } from "./focus";
import { Interactions, heldIdOf, type Match } from "./interactions";
import { TUNING } from "../tuning";

export type SystemFactory = () => LoadedSystem;
interface TimerRec { systemId: string; name: string; due: number }
interface TweenRec { id: number; systemId: string; from: number; to: number; ticks: number; elapsed: number }
const ok = (r: unknown): HostResponse => ({ ok: true, r });
const fail = (code: "bad_request" | "denied" | "missing" | "limit" | "phase", msg: string): HostResponse => ({ ok: false, code, msg });
function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }

export class Game {
  readonly registry = new Registry();
  readonly focus: FocusManager;
  readonly interactions: Interactions;
  factories: SystemFactory[] = [];
  timers: TimerRec[] = [];
  tweens: TweenRec[] = [];
  checks: { label: string; passed: boolean }[] = [];
  eventLog: { tick: number; name: string; payload: unknown }[] = [];
  faults: { tick: number; system: string; handler: string; message: string }[] = [];
  testMode = false;
  private emitDepth = 0;
  private nextTweenId = 1;
  /** Movement entry points, set by the base-systems loader. */
  movementApi: { turn: (dir: string) => void; step: (dir: string) => void } | null = null;
  input: { tick: () => void; reset: () => void } | null = null;

  constructor(readonly eng: Engine) {
    this.focus = new FocusManager({
      tickNow: () => eng.tickCount,
      onEscape: (id) => { const s = this.registry.byId(id); if (s?.onInput) this.invoke(s, "onInput", () => s.onInput!("escape", "down")); },
    });
    this.interactions = new Interactions({ eng, entries: () => this.registry.interactions, perform: (m) => this.performMatch(m) });
    eng.host.hooks = {
      emit: (sid, name, payload) => this.emitChecked(sid, name, payload),
      timer: (sid, ticks, name) => {
        if (!Number.isInteger(ticks) || ticks < 0 || !name) return fail("bad_request", "timer needs integer ticks and a name");
        this.timers.push({ systemId: sid, name, due: eng.tickCount + ticks });
        return ok(true);
      },
      focus: (sid, mode) => {
        if (mode !== "borrow" && mode !== "freeze") return fail("bad_request", 'focus mode must be "borrow" or "freeze"');
        const err = this.focus.take(sid, mode);
        return err ? fail("denied", err) : ok(true);
      },
      release: (sid) => { const err = this.focus.releaseBy(sid); return err ? fail("denied", err) : ok(true); },
      tween: (sid, from, to, ticks) => {
        if (typeof from !== "number" || typeof to !== "number" || !Number.isInteger(ticks) || ticks < 1) return fail("bad_request", "fx.tween needs from, to and integer ticks >= 1");
        const id = this.nextTweenId++;
        this.tweens.push({ id, systemId: sid, from, to, ticks, elapsed: 0 });
        return ok(id);
      },
      sim: (sid, op, req) => this.sim(op, req),
      check: (_sid, req) => {
        const label = typeof req.label === "string" ? req.label : "(unnamed)";
        const passed = req.cond === true;
        this.checks.push({ label, passed });
        return ok(passed);
      },
      animCallback: (sid, id, name, callback) => {
        const entry = catalogGet(this.eng.spriteIdOf(this.eng.recById(id)!));
        const anim = entry?.anims?.[name];
        let ticks = 12;
        if (anim) { const span = (anim.to ?? anim.from ?? 0) - (anim.from ?? 0) + 1; ticks = Math.max(1, span * Math.max(1, Math.round(60 / (anim.fps ?? 8)))); }
        this.timers.push({ systemId: sid, name: callback, due: eng.tickCount + ticks });
      },
      traveled: (_sid, from, to) => { this.emit("(engine)", "player.traveled", { from, to: to.area, pos: to }); },
      testMode: () => this.testMode,
    };
  }

  get systems(): LoadedSystem[] { return this.registry.systems; }
  call(systemId: string, req: { op: string; [k: string]: unknown }): HostResponse { return this.eng.host.call(systemId, req); }
  must(systemId: string, req: { op: string; [k: string]: unknown }): unknown {
    const r = this.call(systemId, req);
    if (!r.ok) throw new Error(`${systemId} ${req.op} failed: ${r.msg}`);
    return r.r;
  }

  loadSystem(system: LoadedSystem, opts?: { migrate?: boolean }): void {
    const v = validateManifest(system.manifest);
    if (!v.ok) throw new Error(`invalid manifest for ${system.manifest?.id}: ${v.errors.join("; ")}`);
    system.manifest = v.manifest;
    this.registry.add(system);
    for (const [name, def] of Object.entries(v.manifest.entities)) this.eng.registerType(name, def, v.manifest.id);
    for (const name of Object.keys(v.manifest.components)) this.eng.declareComponent(name, v.manifest.id);
    if (system.manifest.id === "daynight") this.eng.clockEnabled = true;
    if (opts?.migrate !== false && system.migrate) this.invoke(system, "migrate", () => system.migrate!());
    this.interactions.refresh();
  }
  loadFactory(factory: SystemFactory, opts?: { migrate?: boolean }): LoadedSystem {
    this.factories.push(factory);
    const s = factory(); this.loadSystem(s, opts); return s;
  }
  /** Shift+R: rebuild the registry and re-instantiate every loaded system, keeping the world. */
  reloadAll(): void {
    const factories = [...this.factories];
    this.focus.end("reload");
    this.registry.reset(); this.timers = []; this.tweens = []; this.focus.reset();
    for (const f of factories) this.loadSystem(f());
    this.interactions.refresh();
  }
  unloadSystem(id: string, reason = "unloaded"): void {
    if (this.focus.isHolder(id)) this.focus.end("unload");
    this.timers = this.timers.filter((t) => t.systemId !== id);
    this.tweens = this.tweens.filter((t) => t.systemId !== id);
    this.factories = this.factories.filter((f) => { try { return f().manifest.id !== id; } catch { return true; } });
    for (const [key, slot] of [...this.eng.hudSlots]) if (slot.owner === id) this.eng.hudSlots.delete(key);
    this.eng.overlay = null;
    this.registry.remove(id);
    this.emit("(engine)", "system.unloaded", { id, reason });
    this.interactions.refresh();
  }
  /** Unload a system and every system that builds on it, transitively (spec 10.4). */
  unloadWithDependents(id: string, reason = "faulted"): string[] {
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of this.registry.systems) {
        if (!doomed.has(s.manifest.id) && s.manifest.buildsOn.some((b) => doomed.has(b))) { doomed.add(s.manifest.id); grew = true; }
      }
    }
    const ordered = [...this.registry.systems].map((s) => s.manifest.id).filter((x) => doomed.has(x)).reverse();
    for (const x of ordered) this.unloadSystem(x, reason);
    this.eng.banner = { text: `${id} stopped working and was removed`, t: TUNING.bannerTicks };
    return ordered;
  }

  /** One transaction per system call (spec 4.4). Nested calls (via emit) join the outer transaction. */
  invoke(system: LoadedSystem, handler: string, fn: () => void): boolean {
    if (this.eng.host.inTransaction) { fn(); return true; }
    const timersBefore = this.timers.length, tweensBefore = this.tweens.length;
    try {
      this.eng.host.runInTransaction(fn);
      return true;
    } catch (e) {
      this.timers.length = timersBefore; this.tweens.length = tweensBefore;
      this.faults.push({ tick: this.eng.tickCount, system: system.manifest.id, handler, message: e instanceof Error ? e.message : String(e) });
      if (this.focus.isHolder(system.manifest.id)) this.focus.end("fault");
      try { system.faulted?.(); } catch { /* unloading must not mask the fault */ }
      return false;
    }
  }

  // --- Events (spec 8) ---
  emitChecked(systemId: string, name: string, payload: unknown): HostResponse {
    if (!name) return fail("bad_request", "emit needs an event name");
    if (!this.registry.ownsEvent(systemId, name)) return fail("denied", `system ${systemId} does not own event "${name}"`);
    const shape = this.registry.eventShapes.get(name);
    if (!shape) return fail("denied", `event "${name}" is not declared`);
    const checked = this.checkPayload(name, shape, payload);
    if (typeof checked === "string") return fail("denied", checked);
    if (this.emitDepth >= TUNING.limits.emitNesting) return fail("denied", `emit nesting cap (${TUNING.limits.emitNesting}) reached`);
    this.emit(systemId, name, checked);
    return ok(true);
  }
  private checkPayload(name: string, shape: Record<string, string>, payload: unknown): Record<string, unknown> | string {
    if (payload === undefined) payload = {};
    if (!isRecord(payload)) return `payload for ${name} must be an object`;
    const out: Record<string, unknown> = {};
    for (const [field, kind] of Object.entries(shape)) {
      const v = payload[field];
      if (v === undefined) return `payload for ${name} is missing "${field}"`;
      switch (kind) {
        case "number": if (typeof v !== "number" || !Number.isFinite(v)) return `payload ${name}.${field} must be a number`; out[field] = v; break;
        case "string": if (typeof v !== "string") return `payload ${name}.${field} must be a string`; out[field] = v; break;
        case "bool": if (typeof v !== "boolean") return `payload ${name}.${field} must be a bool`; out[field] = v; break;
        case "list": if (!Array.isArray(v)) return `payload ${name}.${field} must be a list`; out[field] = v; break;
        case "object": if (!isRecord(v)) return `payload ${name}.${field} must be an object`; out[field] = v; break;
        case "entity": {
          if (v === null) { out[field] = null; break; }
          const id = typeof v === "number" ? v : isRecord(v) && typeof v.id === "number" ? v.id : NaN;
          if (!Number.isInteger(id)) return `payload ${name}.${field} must be an entity id or null`;
          out[field] = id; break;
        }
        case "pos": {
          if (!isRecord(v) || !Number.isInteger(v.x) || !Number.isInteger(v.y)) return `payload ${name}.${field} must be a pos {x,y}`;
          out[field] = { x: v.x as number, y: v.y as number, area: typeof v.area === "string" ? v.area : this.eng.currentAreaId };
          break;
        }
        default: return `payload ${name}.${field} has unknown kind`;
      }
    }
    return out;
  }
  /** Host fills in each entity's real type and position, so a payload can't lie about an entity. */
  enrich(payload: Record<string, unknown>, shape: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [field, kind] of Object.entries(shape)) {
      const v = payload[field];
      if (kind === "entity") {
        if (v === null || v === undefined) { out[field] = null; continue; }
        const rec = this.eng.recById(v as number);
        out[field] = rec ? { id: rec.id, type: rec.type, pos: rec.pos ? { ...rec.pos } : null } : { id: v, type: null, pos: null };
      } else out[field] = v;
    }
    return out;
  }
  emit(systemId: string, name: string, rawPayload: Record<string, unknown>): void {
    void systemId;
    if (this.emitDepth >= TUNING.limits.emitNesting) return; // nesting cap: further delivery is denied (see emitChecked)
    const shape = this.registry.eventShapes.get(name) ?? {};
    const payload = this.enrich(rawPayload, shape);
    this.eventLog.push({ tick: this.eng.tickCount, name, payload });
    if (this.eventLog.length > 500) this.eventLog.shift();
    const reactors = this.registry.reactorsTo(name);
    if (!reactors.length) return;
    this.emitDepth++;
    try {
      const writers = new Map<number, Set<string>>();
      for (const sys of reactors) {
        const before = this.snapshotEntities();
        this.invoke(sys, "onEvent", () => sys.onEvent!(name, JSON.stringify(payload)));
        const after = this.snapshotEntities();
        for (const [id, sig] of after) if (before.get(id) !== sig) { if (!writers.has(id)) writers.set(id, new Set()); writers.get(id)!.add(sys.manifest.id); }
        for (const id of before.keys()) if (!after.has(id)) { if (!writers.has(id)) writers.set(id, new Set()); writers.get(id)!.add(sys.manifest.id); }
      }
      for (const [id, systems] of writers) if (systems.size > 1) this.eng.overlapLog.push({ tick: this.eng.tickCount, event: name, entity: id, systems: [...systems] });
    } finally { this.emitDepth--; }
  }
  private snapshotEntities(): Map<number, string> {
    const m = new Map<number, string>();
    for (const r of this.eng.entities.values()) m.set(r.id, JSON.stringify({ t: [...r.tags].sort(), c: [...r.comps.entries()], p: r.pos }));
    return m;
  }

  // --- Interactions ---
  performMatch(m: Match): void {
    const owner = this.registry.byId(m.entry.owner);
    if (!owner?.perform) return;
    const held = heldIdOf(this.eng);
    const player = this.eng.playerRec();
    this.focus.inPerform = true;
    try { this.invoke(owner, "perform", () => owner.perform!(m.entry.verb, m.targetId, held)); }
    finally { this.focus.inPerform = false; }
    this.emit("(engine)", "interaction.performed", {
      verb: m.entry.verb,
      target: m.kind === "tile" ? null : m.targetId,
      held: held || null,
      owner: m.entry.owner,
      pos: player?.pos ? { ...player.pos } : m.targetPos,
    });
    this.interactions.resetCycle();
  }

  // --- Main tick ---
  tick(): void {
    this.eng.tick();
    for (const s of [...this.systems]) if (s.onTick) this.invoke(s, "onTick", () => s.onTick!());
    const due = this.timers.filter((t) => t.due <= this.eng.tickCount);
    this.timers = this.timers.filter((t) => t.due > this.eng.tickCount);
    for (const t of due) {
      const s = this.registry.byId(t.systemId);
      if (s?.onTimer) this.invoke(s, "onTimer", () => s.onTimer!(t.name));
    }
    for (const tw of [...this.tweens]) {
      tw.elapsed++;
      const value = tw.elapsed >= tw.ticks ? tw.to : tw.from + (tw.to - tw.from) * (tw.elapsed / tw.ticks);
      const s = this.registry.byId(tw.systemId);
      if (s?.onTween) this.invoke(s, "onTween", () => s.onTween!(tw.id, value));
      if (tw.elapsed >= tw.ticks) this.tweens = this.tweens.filter((x) => x !== tw);
    }
    this.focus.checkTimeout();
    this.input?.tick();
    this.interactions.refresh();
  }

  // --- sim.* and check (spec 4.2), same paths as real keys ---
  private sim(op: string, req: { [k: string]: unknown }): HostResponse {
    const player = this.eng.playerRec();
    switch (op) {
      case "sim.face": {
        if (typeof req.dir !== "string") return fail("bad_request", "sim.face needs a dir");
        this.movementApi?.turn(req.dir); this.interactions.refresh(); return ok(true);
      }
      case "sim.walk": {
        if (typeof req.dir !== "string") return fail("bad_request", "sim.walk needs a dir");
        const steps = req.steps === undefined ? 1 : req.steps;
        if (!Number.isInteger(steps) || (steps as number) < 1) return fail("bad_request", "sim.walk steps must be a positive integer");
        for (let i = 0; i < (steps as number); i++) this.movementApi?.step(req.dir);
        this.interactions.refresh(); return ok(true);
      }
      case "sim.interact": this.interactions.performCurrent(); return ok(true);
      case "sim.cycle": this.interactions.cycle(); return ok(true);
      case "sim.give": {
        if (typeof req.type !== "string" || !player?.pos) return fail("bad_request", "sim.give needs a type");
        const spawn = this.call("(engine)", { op: "spawn", type: req.type, x: player.pos.x, y: player.pos.y, area: player.pos.area });
        if (!spawn.ok) return spawn;
        const id = spawn.r as number;
        // Exactly as pick up does: lift it, then set the player's held.
        this.call("(engine)", { op: "lift", id });
        this.call("(engine)", { op: "set", id: player.id, comp: "held", value: { id } });
        this.emit("(engine)", "item.picked", { item: id });
        this.interactions.refresh();
        return ok(id);
      }
      case "sim.teleport": {
        if (!Number.isInteger(req.x) || !Number.isInteger(req.y)) return fail("bad_request", "sim.teleport needs x and y");
        const r = this.call("(engine)", { op: "travel", x: req.x, y: req.y, ...(typeof req.area === "string" ? { area: req.area } : {}) });
        return r;
      }
      case "sim.wait": {
        if (!Number.isInteger(req.ticks) || (req.ticks as number) < 0) return fail("bad_request", "sim.wait needs integer ticks");
        for (let i = 0; i < (req.ticks as number); i++) this.tick();
        return ok(true);
      }
      case "sim.time": {
        const v = req.phaseOrHour ?? req.value;
        if (typeof v !== "string" && typeof v !== "number") return fail("bad_request", "sim.time needs a phase or hour");
        const from = this.eng.hour;
        this.eng.jumpTime(v);
        this.emit("(engine)", "time.jumped", { from, to: this.eng.hour });
        return ok(true);
      }
      case "sim.key": {
        if (typeof req.key !== "string" || typeof req.kind !== "string") return fail("bad_request", "sim.key needs key and kind");
        const holder = this.focus.holder ? this.registry.byId(this.focus.holder) : undefined;
        if (holder?.onInput) this.invoke(holder, "onInput", () => holder.onInput!(req.key as string, req.kind as string));
        return ok(true);
      }
      default: return fail("bad_request", `unknown sim op "${op}"`);
    }
  }
}
