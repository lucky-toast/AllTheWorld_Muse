// The module loader (spec 10.3) and the adapter that makes a loaded WebAssembly module
// look like any other system to the host (spec 5.2).
//
// Loading, every time (from the pipeline, from storage or from a cache):
//   1. WebAssembly.validate the bytes.
//   2. Imports must be exactly host.call (i32, i32) -> i32 and env.memory.
//   3. Exports must have the expected names, kinds and signatures and cover the manifest:
//      every interaction needs perform, every reaction onEvent, every shot shot_<name>.
//   4. Meter the binary (meter.ts). A stored binary that was tampered with is metered too.
//   5. Instantiate with a fresh capped WebAssembly.Memory and a host.call bound to the system.
//
// Fuel: before each call into a module the host sets the module's fuel global, and reads
// it back after. A call opens a fuel account (50M units live, 500M for migrate, tests and
// shots); calls nested inside the same transaction (an emit reaching another AI system)
// draw from the caller's account. A trap (fuel, memory, abort, anything) throws out of the
// handler, so the host rolls the whole transaction back and records a strike; the
// module's instance is then thrown away and re-created on its next call, because the
// AssemblyScript runtime can't be trusted after a trap.
import { inspect, meter, typeName, WasmError, FUEL_EXPORT, type FuncType, type WasmInfo } from "./meter";
import { START_EXPORT } from "./abi";
import type { HostCall, SystemDef, SystemModule } from "../engine/systems";
import type { Host, Request } from "../engine/host";
import { LIMITS } from "../tuning";

const PAGE = 65536;
const MAX_PAGES = LIMITS.memoryBytes / PAGE;
const I32 = 0x7f, F64 = 0x7c;

/** Signatures of every export the host knows (spec 5.2 plus the glue in src/sdk/README.md). */
const HANDLERS: Record<string, FuncType> = {
  perform: { params: [I32, I32, I32], results: [] },
  onEvent: { params: [I32, I32], results: [] },
  onTick: { params: [], results: [] },
  onTimer: { params: [I32], results: [] },
  onInput: { params: [I32, I32], results: [] },
  onTween: { params: [I32, F64], results: [] },
  migrate: { params: [], results: [] },
};
const GLUE: Record<string, FuncType> = {
  __atw_alloc: { params: [I32], results: [I32] },
  __atw_string: { params: [I32], results: [I32] },
  __atw_unpin: { params: [I32], results: [] },
  __atw_abort_message: { params: [], results: [I32] },
  __atw_abort_file: { params: [], results: [I32] },
  __atw_abort_line: { params: [], results: [I32] },
  __atw_abort_column: { params: [], results: [I32] },
  [START_EXPORT]: { params: [], results: [] },
};
/** asc adds this when an exported function has optional parameters. Allowed, never called. */
const OPTIONAL_EXPORTS: Record<string, FuncType> = { __setArgumentsLength: { params: [I32], results: [] } };
const NO_ARGS: FuncType = { params: [], results: [] };

export class ModuleError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); }
}

/** What the loader needs from a manifest. */
interface ManifestShape { id: string; interactions: unknown[]; reactions: unknown[]; shots: { name: string }[] }
function shapeOf(manifest: unknown): ManifestShape {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    id: typeof m.id === "string" ? m.id : "?",
    interactions: list(m.interactions), reactions: list(m.reactions),
    shots: list(m.shots).filter((s): s is { name: string } => !!s && typeof (s as { name?: unknown }).name === "string"),
  };
}

const sig = (t: FuncType) => `(${t.params.map(typeName).join(", ")}) -> (${t.results.map(typeName).join(", ")})`;
const sameSig = (a: FuncType, b: FuncType) => sig(a) === sig(b);

/** Steps 1 to 3: validate, check the imports and the exports against the manifest. Returns every problem found. */
export function checkModule(bytes: Uint8Array<ArrayBuffer>, manifest: unknown): { ok: true; info: WasmInfo } | { ok: false; errors: string[] } {
  if (!WebAssembly.validate(bytes)) return { ok: false, errors: ["the bytes aren't a valid WebAssembly module"] };
  let info: WasmInfo;
  try { info = inspect(bytes); } catch (e) { return { ok: false, errors: [e instanceof Error ? e.message : String(e)] }; }
  const errors: string[] = [];
  const m = shapeOf(manifest);

  // ---- imports: exactly host.call and env.memory ----
  const names = info.imports.map((i) => `${i.module}.${i.name}`);
  for (const n of names) if (n !== "host.call" && n !== "env.memory") errors.push(`import "${n}" isn't allowed; the only imports are host.call and env.memory`);
  if (names.filter((n) => n === "host.call").length !== 1) errors.push("the module must import host.call exactly once");
  if (names.filter((n) => n === "env.memory").length !== 1) errors.push("the module must import env.memory exactly once");
  for (const imp of info.imports) {
    if (imp.module === "host" && imp.name === "call") {
      if (imp.desc.kind !== "func") errors.push("host.call must be a function");
      else if (!sameSig(info.types[imp.desc.type], { params: [I32, I32], results: [I32] })) errors.push(`host.call must be (i32, i32) -> (i32), not ${sig(info.types[imp.desc.type])}`);
    }
    if (imp.module === "env" && imp.name === "memory") {
      if (imp.desc.kind !== "memory") errors.push("env.memory must be a memory");
      else if (imp.desc.limits.min > MAX_PAGES) errors.push(`env.memory asks for ${imp.desc.limits.min} pages; the cap is ${MAX_PAGES}`);
    }
  }
  if (info.memories !== 1) errors.push("the module may not define memories of its own");
  if (info.hasStart) errors.push(`a start section isn't allowed; the host runs ${START_EXPORT}`);

  // ---- exports: known names, function kind, right signatures ----
  const exported = new Map<string, FuncType>();
  for (const e of info.exports) {
    const known = HANDLERS[e.name] ?? GLUE[e.name] ?? OPTIONAL_EXPORTS[e.name] ?? (/^(test|shot)_[A-Za-z0-9_]+$/.test(e.name) ? NO_ARGS : null);
    if (!known) { errors.push(`unexpected export "${e.name}"; a module exports only the handlers in the SDK reference, test_* and shot_*`); continue; }
    if (e.kind !== "func") { errors.push(`export "${e.name}" must be a function`); continue; }
    const t = info.types[info.funcTypes[e.index]];
    if (!t) { errors.push(`export "${e.name}" names a missing function`); continue; }
    if (!sameSig(t, known)) errors.push(`export "${e.name}" has the signature ${sig(t)}; it must be ${sig(known)}`);
    exported.set(e.name, t);
  }
  for (const g of Object.keys(GLUE)) if (!exported.has(g)) errors.push(`the SDK export "${g}" is missing (compile with the pipeline's settings)`);

  // ---- the exports cover the manifest ----
  if (m.interactions.length && !exported.has("perform")) errors.push(`the manifest lists ${m.interactions.length} interaction(s) but the module exports no perform`);
  if (m.reactions.length && !exported.has("onEvent")) errors.push(`the manifest lists reactions but the module exports no onEvent`);
  for (const s of m.shots) if (!exported.has(`shot_${s.name}`)) errors.push(`the manifest lists the shot "${s.name}" but the module exports no shot_${s.name}`);
  return errors.length ? { ok: false, errors } : { ok: true, info };
}

/** A module that passed the loader: metered and compiled, ready to instantiate any number of times. */
export interface PreparedModule {
  systemId: string;
  manifest: unknown;
  /** The metered binary. */
  metered: Uint8Array<ArrayBuffer>;
  module: WebAssembly.Module;
  /** Exported function names, in export order. */
  exports: string[];
  /** Memory pages to start with and the cap. */
  memory: { initial: number; maximum: number };
}

function prepareParts(bytes: Uint8Array<ArrayBuffer>, manifest: unknown) {
  const chk = checkModule(bytes, manifest);
  if (!chk.ok) throw new ModuleError(chk.errors);
  let metered: Uint8Array<ArrayBuffer>;
  try { metered = meter(bytes); } catch (e) { throw new ModuleError([`metering failed: ${e instanceof Error ? e.message : String(e)}`]); }
  const mem = chk.info.imports.find((i) => i.desc.kind === "memory")!.desc as { limits: { min: number; max: number | null } };
  const maximum = Math.min(MAX_PAGES, mem.limits.max ?? MAX_PAGES);
  return {
    metered,
    base: { systemId: shapeOf(manifest).id, manifest, metered, exports: chk.info.exports.filter((e) => e.kind === "func").map((e) => e.name), memory: { initial: Math.max(1, mem.limits.min), maximum } },
  };
}

/** Steps 1 to 4, synchronously (Node, Web Workers). Throws ModuleError listing every problem. */
export function prepareModule(bytes: Uint8Array<ArrayBuffer>, manifest: unknown): PreparedModule {
  const { metered, base } = prepareParts(bytes, manifest);
  return { ...base, module: new WebAssembly.Module(metered) };
}

/** Steps 1 to 4 with an asynchronous compile (for the main thread, where big synchronous compiles are refused). */
export async function prepareModuleAsync(bytes: Uint8Array<ArrayBuffer>, manifest: unknown): Promise<PreparedModule> {
  const { metered, base } = prepareParts(bytes, manifest);
  return { ...base, module: await WebAssembly.compile(metered) };
}

// ======================= traps =======================

export type TrapKind = "fuel" | "memory" | "abort" | "trap";
/** A module trapped. The host rolls the transaction back; during live play it is a strike. */
export class SandboxTrap extends Error {
  constructor(public system: string, public trap: TrapKind, msg: string) { super(msg); }
}

// ======================= fuel accounts =======================

interface Account { remaining: bigint; limit: bigint; txn: number; host: Host }
interface Frame { runner: Runner; acc: Account }
/** Module calls in progress, innermost last (shared by every host in this thread). */
const frames: Frame[] = [];
const CHECK_KINDS = new Set(["migrate", "test", "shot"]);

/** Fuel used per call, for the near-limit log and the determinism test. */
export interface FuelStats {
  /** Total fuel used by every call that opened its own account. */
  total: bigint;
  /** The most recent calls (export name and fuel used), oldest first. */
  calls: { name: string; used: bigint }[];
}
const STATS_KEPT = 1000;

// ======================= one live instance =======================

class Runner {
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private ex: Record<string, (...a: number[]) => number> = {};
  private fuel: WebAssembly.Global | null = null;

  constructor(private prep: PreparedModule, private call: HostCall, private host: Host, private stats: FuelStats) {}

  /** A fresh instance with a fresh capped memory; its start function runs under fuel. */
  private ensure() {
    if (this.instance) return;
    const memory = new WebAssembly.Memory({ initial: this.prep.memory.initial, maximum: this.prep.memory.maximum });
    const instance = new WebAssembly.Instance(this.prep.module, { host: { call: (ptr: number, len: number) => this.hostCall(ptr, len) }, env: { memory } });
    this.memory = memory; this.instance = instance;
    this.ex = instance.exports as unknown as Record<string, (...a: number[]) => number>;
    this.fuel = instance.exports[FUEL_EXPORT] as WebAssembly.Global;
    this.run(START_EXPORT, "start", (ex) => { ex[START_EXPORT](); });
  }

  /** Call into the module under fuel. Any throw marks the instance dead so the next call re-creates it. */
  run(name: string, kind: string, body: (ex: Record<string, (...a: number[]) => number>) => void): void {
    if (kind !== "start") this.ensure();
    const fuel = this.fuel!;
    const outer = frames[frames.length - 1];
    if (outer) outer.acc.remaining = outer.runner.fuel!.value as bigint; // the paused caller's fuel, up to date
    const txn = this.host.transactionId;
    const shared = !!outer && txn !== 0 && outer.acc.txn === txn && outer.acc.host === this.host && !CHECK_KINDS.has(kind);
    const limit = BigInt(CHECK_KINDS.has(kind) ? LIMITS.fuelCheck : LIMITS.fuelLive);
    const acc: Account = shared ? outer.acc : { remaining: limit, limit, txn, host: this.host };
    frames.push({ runner: this, acc });
    fuel.value = acc.remaining;
    let threw = true;
    try { body(this.ex); threw = false; }
    catch (e) { throw this.explain(e, name, acc); }
    finally {
      const left = fuel.value as bigint;
      acc.remaining = left < 0n ? 0n : left;
      frames.pop();
      if (outer) outer.runner.fuel!.value = outer.acc.remaining;
      if (threw) this.instance = null;
      if (!shared) {
        const used = acc.limit - acc.remaining;
        this.stats.total += used;
        this.stats.calls.push({ name, used }); if (this.stats.calls.length > STATS_KEPT) this.stats.calls.shift();
        this.host.logNearLimit(this.prep.systemId, "fuel", Number(used), Number(acc.limit));
      }
    }
  }

  /** Turn a trap into a readable SandboxTrap. Errors from deeper calls (another module's trap, a host bug) pass through. */
  private explain(e: unknown, name: string, acc: Account): unknown {
    if (!(e instanceof WebAssembly.RuntimeError)) return e;
    const id = this.prep.systemId;
    if ((this.fuel!.value as bigint) < 0n) return new SandboxTrap(id, "fuel", `${id}.${name} ran out of fuel (${acc.limit} units)`);
    const abort = this.abortInfo();
    if (abort) return new SandboxTrap(id, "abort", `${id}.${name} aborted: ${abort}`);
    const bytes = this.memory!.buffer.byteLength;
    if (bytes >= this.prep.memory.maximum * PAGE * 0.9) return new SandboxTrap(id, "memory", `${id}.${name} ran out of memory (${this.prep.memory.maximum * PAGE} bytes)`);
    return new SandboxTrap(id, "trap", `${id}.${name} trapped: ${e.message}`);
  }

  /** The message an SDK abort left behind ("message at file:line:column"), or null. */
  private abortInfo(): string | null {
    try {
      const msg = this.readString(this.ex.__atw_abort_message() >>> 0);
      if (msg === null) return null;
      const file = this.readString(this.ex.__atw_abort_file() >>> 0);
      return `${msg}${file ? ` at ${file}:${this.ex.__atw_abort_line()}:${this.ex.__atw_abort_column()}` : ""}`;
    } catch { return null; }
  }

  /** Read an AssemblyScript String (UTF-16, byte length in the header word before it). */
  private readString(ptr: number): string | null {
    if (!ptr) return null;
    const buf = this.memory!.buffer;
    if (ptr < 4 || ptr > buf.byteLength) return null;
    const bytes = new DataView(buf).getUint32(ptr - 4, true);
    if (ptr + bytes > buf.byteLength || bytes % 2) return null;
    return String.fromCharCode(...new Uint16Array(buf, ptr, Math.min(bytes / 2, 4096)));
  }

  /** Put a handler's string argument into the module (a pinned AssemblyScript String). */
  newString(text: string): number {
    const ptr = this.ex.__atw_string(text.length) >>> 0;
    const view = new Uint16Array(this.memory!.buffer, ptr, text.length);
    for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i);
    return ptr;
  }
  unpin(ptr: number) { this.ex.__atw_unpin(ptr); }

  /** The host.call import: UTF-8 JSON request in, UTF-8 JSON response written through __atw_alloc. */
  private hostCall(ptr: number, len: number): number {
    ptr >>>= 0; len >>>= 0;
    const buf = this.memory!.buffer;
    let req: unknown = null;
    if (len > LIMITS.requestBytes) req = { op: "__too_big__" };
    else if (ptr + len > buf.byteLength) req = { op: "__out_of_bounds__" };
    else { try { req = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, ptr, len))); } catch { req = null; } }
    const res = this.call(req as Request);
    const out = new TextEncoder().encode(JSON.stringify(res));
    const at = this.ex.__atw_alloc(out.length) >>> 0;
    new Uint8Array(this.memory!.buffer, at, out.length).set(out); // the buffer may have grown: read it again
    return at;
  }
}

// ======================= the adapter =======================

/** A loaded AI system: a SystemDef the host loads like a base system, plus its fuel stats. */
export interface AiSystemDef extends SystemDef { prepared: PreparedModule; stats: FuelStats }

/** Wrap a prepared module as a system. Every create() (load, Shift+R) gets a fresh instance and memory. */
export function aiSystem(prep: PreparedModule): AiSystemDef {
  const stats: FuelStats = { total: 0n, calls: [] };
  const has = new Set(prep.exports);
  return {
    base: false, manifest: prep.manifest, prepared: prep, stats,
    create(call, host) {
      const r = new Runner(prep, call, host, stats);
      /** Call an export with string arguments made inside the module (and unpinned after a clean return). */
      const withStrings = (name: string, kind: string, strs: string[], rest: (ptrs: number[], ex: Record<string, (...a: number[]) => number>) => void) =>
        r.run(name, kind, (ex) => { const ptrs = strs.map((s) => r.newString(s)); rest(ptrs, ex); for (const p of ptrs) r.unpin(p); });
      const mod: SystemModule = {};
      if (has.has("perform")) mod.perform = (verb, target, held) => withStrings("perform", "perform", [verb], ([v], ex) => ex.perform(v, target | 0, held | 0));
      if (has.has("onEvent")) mod.onEvent = (name, payload) => withStrings("onEvent", "onEvent", [name, payload], ([n, p], ex) => ex.onEvent(n, p));
      if (has.has("onTick")) mod.onTick = () => r.run("onTick", "onTick", (ex) => ex.onTick());
      if (has.has("onTimer")) mod.onTimer = (name) => withStrings("onTimer", "onTimer", [name], ([n], ex) => ex.onTimer(n));
      if (has.has("onInput")) mod.onInput = (key, kind) => withStrings("onInput", "onInput", [key, kind], ([k, d], ex) => ex.onInput(k, d));
      if (has.has("onTween")) mod.onTween = (id, value) => r.run("onTween", "onTween", (ex) => ex.onTween(id | 0, value));
      if (has.has("migrate")) mod.migrate = () => r.run("migrate", "migrate", (ex) => ex.migrate());
      for (const name of prep.exports) {
        if (name.startsWith("test_")) mod[name as `test_${string}`] = () => r.run(name, "test", (ex) => ex[name]());
        else if (name.startsWith("shot_")) mod[name as `shot_${string}`] = () => r.run(name, "shot", (ex) => ex[name]());
      }
      return mod;
    },
  };
}

/** Load bytes as a system in one step (synchronous). Throws ModuleError when the loader refuses it. */
export function loadAiSystem(bytes: Uint8Array<ArrayBuffer>, manifest: unknown): AiSystemDef {
  return aiSystem(prepareModule(bytes, manifest));
}

export { WasmError };
