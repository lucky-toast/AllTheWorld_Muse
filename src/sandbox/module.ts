// Module loader (spec 10.3) and registry adapter for metered AI systems.
import { validateManifest, type Manifest } from "../engine/manifest";
import type { LoadedSystem } from "../engine/registry";
import type { Game } from "../engine/runtime";
import { TUNING } from "../tuning";
import { meterBinary, FUEL_EXPORT_NAME } from "./meter";

export class ModuleLoadError extends Error {}

type WasmExport = WebAssembly.ExportValue;
type ExportsMap = Record<string, WasmExport>;

export interface WasmModuleHandle {
  manifest: Manifest;
  system: LoadedSystem;
  bytes: Uint8Array;
  meteredBytes: Uint8Array;
  exportNames: string[];
  testNames: string[];
  shotNames: string[];
  lastFuelUsed: number;
  lastFuelLimit: number;
  strikeTicks: number[];
  strikesEnabled: boolean;
  unloaded: boolean;
  runNamed: (name: string) => boolean;
  fuelRemaining: () => number;
}

const HANDLER_EXPORTS = ["perform", "onEvent", "onTick", "onTimer", "onInput", "onTween", "migrate"] as const;

export function listModuleImports(bytes: Uint8Array): WebAssembly.ModuleImportDescriptor[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes as unknown as BufferSource));
}
export function listModuleExports(bytes: Uint8Array): WebAssembly.ModuleExportDescriptor[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(bytes as unknown as BufferSource));
}

function fuelLimitFor(handler: string): number {
  if (handler === "migrate" || handler.startsWith("test_") || handler.startsWith("shot_")) return TUNING.limits.fuelPerSetup;
  return TUNING.limits.fuelPerLiveCall;
}

/** Validate, meter and instantiate a module, then plug it into the registry like a base system. */
export function loadWasmModule(game: Game, manifestInput: unknown, bytes: Uint8Array, opts?: { migrate?: boolean }): WasmModuleHandle {
  const mv = validateManifest(manifestInput);
  if (!mv.ok) throw new ModuleLoadError(`invalid manifest: ${mv.errors.join("; ")}`);
  const manifest = mv.manifest;

  // 1. Validate.
  if (!WebAssembly.validate(bytes as unknown as BufferSource)) throw new ModuleLoadError("module bytes do not validate as WebAssembly");

  // 2. Imports must be exactly host.call and env.memory.
  let imports: WebAssembly.ModuleImportDescriptor[];
  let exportDescs: WebAssembly.ModuleExportDescriptor[];
  try {
    imports = listModuleImports(bytes);
    exportDescs = listModuleExports(bytes);
  } catch (e) {
    throw new ModuleLoadError(e instanceof Error ? e.message : String(e));
  }
  const importKeys = imports.map((i) => `${i.module}.${i.name}`).sort();
  const expectedImports = ["env.memory", "host.call"];
  if (JSON.stringify(importKeys) !== JSON.stringify(expectedImports)) {
    const extra = importKeys.filter((k) => !expectedImports.includes(k));
    const missing = expectedImports.filter((k) => !importKeys.includes(k));
    const parts: string[] = [];
    if (extra.length) parts.push(`unexpected import${extra.length > 1 ? "s" : ""} ${extra.join(", ")}`);
    if (missing.length) parts.push(`missing import${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
    throw new ModuleLoadError(`module imports must be exactly host.call and env.memory (${parts.join("; ")})`);
  }
  const callImport = imports.find((i) => i.module === "host" && i.name === "call")!;
  if (callImport.kind !== "function") throw new ModuleLoadError("import host.call must be a function");
  const memImport = imports.find((i) => i.module === "env" && i.name === "memory")!;
  if (memImport.kind !== "memory") throw new ModuleLoadError("import env.memory must be a memory");

  // 3. Exports must cover the manifest.
  const exportKinds = new Map(exportDescs.map((e) => [e.name, e.kind]));
  for (const name of HANDLER_EXPORTS) {
    if (exportKinds.has(name) && exportKinds.get(name) !== "function") throw new ModuleLoadError(`export "${name}" must be a function`);
  }
  if (manifest.interactions.length > 0 && exportKinds.get("perform") !== "function") {
    throw new ModuleLoadError(`manifest declares ${manifest.interactions.length} interaction(s) but module does not export "perform"`);
  }
  if (manifest.reactions.length > 0 && exportKinds.get("onEvent") !== "function") {
    throw new ModuleLoadError(`manifest declares reactions but module does not export "onEvent"`);
  }
  for (const shot of manifest.shots) {
    if (exportKinds.get(`shot_${shot.name}`) !== "function") {
      throw new ModuleLoadError(`manifest declares shot "${shot.name}" but module does not export "shot_${shot.name}"`);
    }
  }

  // 4. Meter.
  let meteredBytes: Uint8Array;
  try {
    meteredBytes = meterBinary(bytes).bytes;
  } catch (e) {
    throw new ModuleLoadError(e instanceof Error ? e.message : String(e));
  }
  if (!WebAssembly.validate(meteredBytes as unknown as BufferSource)) throw new ModuleLoadError("metered module does not validate");

  // 5. Instantiate with a fresh capped memory and a bound host.call.
  const memory = new WebAssembly.Memory({ initial: 16, maximum: TUNING.limits.memoryPerModuleBytes / 65536 });
  let instance: WebAssembly.Instance;
  const handleRef: { handle: WasmModuleHandle | null } = { handle: null };

  const hostCall = (reqPtr: number, reqLen: number, resPtr: number, resCap: number): number => {
    try {
      const reqBytes = new Uint8Array(memory.buffer, reqPtr >>> 0, reqLen >>> 0).slice();
      const reqText = new TextDecoder().decode(reqBytes);
      let request: { op: string; [k: string]: unknown };
      try { request = JSON.parse(reqText) as { op: string }; }
      catch { request = { op: "" }; }
      const response = request.op ? game.call(manifest.id, request) : { ok: false as const, code: "bad_request" as const, msg: "request is not valid JSON" };
      const out = new TextEncoder().encode(JSON.stringify(response));
      if (out.length > resCap) return -1;
      new Uint8Array(memory.buffer).set(out, resPtr >>> 0);
      return out.length;
    } catch {
      const out = new TextEncoder().encode(JSON.stringify({ ok: false, code: "bad_request", msg: "host call failed" }));
      try { new Uint8Array(memory.buffer).set(out, resPtr >>> 0); return out.length; } catch { return -1; }
    }
  };

  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(meteredBytes as unknown as BufferSource), {
      host: { call: hostCall },
      env: { memory },
    });
  } catch (e) {
    throw new ModuleLoadError(`module could not be instantiated: ${e instanceof Error ? e.message : String(e)}`);
  }
  const exportsMap = instance.exports as ExportsMap;
  const fuel = exportsMap[FUEL_EXPORT_NAME] as WebAssembly.Global | undefined;
  if (!fuel || typeof fuel !== "object" || !("value" in fuel)) throw new ModuleLoadError(`metered module does not export the "${FUEL_EXPORT_NAME}" global`);

  const lowerString = (value: string): number => {
    const newFn = exportsMap["__new"] as ((size: number, id: number) => number) | undefined;
    const pinFn = exportsMap["__pin"] as ((ptr: number) => number) | undefined;
    if (!newFn) throw new ModuleLoadError("module does not export the runtime __new needed for string passing");
    const ptr = newFn((value.length << 1) >>> 0, 2) >>> 0;
    if (pinFn) pinFn(ptr);
    const mem = new Uint16Array(memory.buffer);
    for (let i = 0; i < value.length; i++) mem[(ptr >>> 1) + i] = value.charCodeAt(i);
    return ptr;
  };
  const unpin = (ptr: number) => {
    const unpinFn = exportsMap["__unpin"] as ((ptr: number) => void) | undefined;
    if (unpinFn && ptr) { try { unpinFn(ptr); } catch { /* best effort */ } }
  };

  const testNames = exportDescs.filter((e) => e.kind === "function" && e.name.startsWith("test_")).map((e) => e.name).sort();
  const shotNames = exportDescs.filter((e) => e.kind === "function" && e.name.startsWith("shot_")).map((e) => e.name).sort();

  const invokeExport = (handler: string, args: unknown[]): void => {
    const fn = exportsMap[handler] as ((...a: unknown[]) => void) | undefined;
    if (!fn) throw new ModuleLoadError(`module does not export "${handler}"`);
    const limit = fuelLimitFor(handler);
    fuel.value = BigInt(limit);
    if (handleRef.handle) handleRef.handle.lastFuelLimit = limit;
    const lowered: number[] = [];
    try {
      const callArgs = args.map((a) => {
        if (typeof a === "string") { const p = lowerString(a); lowered.push(p); return p; }
        return a;
      });
      fn(...callArgs);
      const remaining = Number(fuel.value as bigint);
      if (handleRef.handle) handleRef.handle.lastFuelUsed = Math.max(0, limit - remaining);
    } catch (e) {
      const remaining = Number(fuel.value as bigint);
      if (handleRef.handle) {
        handleRef.handle.lastFuelUsed = Math.max(0, limit - remaining);
        if (handleRef.handle.strikesEnabled) handleRef.handle.strikeTicks.push(game.eng.tickCount);
      }
      throw e;
    } finally {
      for (const p of lowered) unpin(p);
    }
  };

  const has = (name: string) => exportKinds.get(name) === "function";
  const system: LoadedSystem = {
    manifest,
    ...(has("perform") ? { perform: (verb: string, target: number, held: number) => invokeExport("perform", [verb, target, held]) } : {}),
    ...(has("onEvent") ? { onEvent: (name: string, payload: string) => invokeExport("onEvent", [name, payload]) } : {}),
    ...(has("onTick") ? { onTick: () => invokeExport("onTick", []) } : {}),
    ...(has("onTimer") ? { onTimer: (name: string) => invokeExport("onTimer", [name]) } : {}),
    ...(has("onInput") ? { onInput: (key: string, kind: string) => invokeExport("onInput", [key, kind]) } : {}),
    ...(has("onTween") ? { onTween: (id: number, value: number) => invokeExport("onTween", [id, value]) } : {}),
    ...(has("migrate") ? { migrate: () => invokeExport("migrate", []) } : {}),
  };

  const handle: WasmModuleHandle = {
    manifest,
    system,
    bytes,
    meteredBytes,
    exportNames: exportDescs.map((e) => e.name),
    testNames,
    shotNames,
    lastFuelUsed: 0,
    lastFuelLimit: 0,
    strikeTicks: [],
    strikesEnabled: true,
    unloaded: false,
    runNamed: (name: string) => game.invoke(system, name, () => invokeExport(name, [])),
    fuelRemaining: () => Number(fuel.value as bigint),
  };
  handleRef.handle = handle;
  system.faulted = () => {
    const windowTicks = TUNING.limits.strikesWindowSeconds * TUNING.ticksPerSecond;
    handle.strikeTicks = handle.strikeTicks.filter((t) => game.eng.tickCount - t <= windowTicks);
    if (handle.strikeTicks.length >= TUNING.limits.strikesBeforeUnload && !handle.unloaded) {
      handle.unloaded = true;
      game.unloadWithDependents(manifest.id, "three strikes in 60 s");
    }
  };

  game.loadSystem(system, { migrate: false });
  if (opts?.migrate && has("migrate")) game.invoke(system, "migrate", () => invokeExport("migrate", []));
  return handle;
}
