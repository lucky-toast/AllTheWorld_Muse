// Pipeline stages 1-6 (spec 12). Runs in the Web Worker in the browser and
// in-process in Node; either way it works on its own engine copies and never
// touches the live game. Stage 7 (Load) lives in load.ts/client.ts.
import { catalogGet, catalogFind } from "../engine/catalog";
import { validateManifest, type Manifest } from "../engine/manifest";
import { BASE_EVENTS } from "../engine/registry";
import type { Game } from "../engine/runtime";
import { compileSystem } from "../sandbox/compile";
import { loadWasmModule, ModuleLoadError } from "../sandbox/module";
import { runSystemTests } from "../sandbox/runner";
import { runBaseTests } from "../systems/base/runner";
import { buildWorld } from "../world/map";
import { createGame } from "../systems/base/index";
import { TUNING } from "../tuning";
import { b64ToBytes } from "./storage";
import type { CheckRequest, PipelineError, Report, Stage, StageEvent } from "./types";

export const BASE_SYSTEM_IDS = ["movement", "carry", "push", "daynight"];
const FALLBACK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export interface CoreHooks {
  onStage?: (e: StageEvent) => void;
  renderShot?: (game: Game, shot: Manifest["shots"][number]) => Promise<string>;
}

function stageLimit(stage: Stage): number {
  return stage === "Compile" ? TUNING.limits.compileTimeMs : TUNING.limits.stageTimeMs;
}

function errorFromFaults(game: Game, before: number, what: string): PipelineError {
  const f = game.faults[before];
  return { message: f ? `${what}: ${f.system} ${f.handler} failed — ${f.message}` : `${what} failed`, events: game.eventLog.slice(-100), denied: [...game.eng.deniedLog].slice(-20) };
}

export async function runCheck(req: CheckRequest, hooks: CoreHooks = {}): Promise<Report> {
  const started = Date.now();
  const loadedIds = [...BASE_SYSTEM_IDS, ...req.loaded.map((l) => l.manifest.id)];
  const report: Report = {
    ok: false, stage: "Manifest", systemId: null, errors: [], shots: [],
    durationMs: 0, manifestJson: req.manifestJson, source: req.source,
    loadedSystems: loadedIds, stageMs: {},
  };
  let manifest: Manifest | null = null;
  let wasm: Uint8Array | null = null;

  const runStage = async <T>(stage: Stage, fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> => {
    hooks.onStage?.({ stage, status: "start" });
    const t0 = Date.now();
    try {
      const value = await fn();
      const ms = Date.now() - t0;
      report.stageMs[stage] = ms;
      if (ms > stageLimit(stage)) {
        report.errors.push({ message: `${stage} stage timed out after ${ms} ms (limit ${stageLimit(stage)} ms); the worker was stopped` });
        hooks.onStage?.({ stage, status: "fail", ms });
        return { ok: false };
      }
      hooks.onStage?.({ stage, status: "pass", ms });
      return { ok: true, value };
    } catch (e) {
      const ms = Date.now() - t0;
      report.stageMs[stage] = ms;
      if (!report.errors.length) report.errors.push({ message: e instanceof Error ? e.message : String(e) });
      hooks.onStage?.({ stage, status: "fail", ms });
      return { ok: false };
    }
  };
  const finish = (): Report => { report.durationMs = Date.now() - started; return report; };

  // --- Stage 1: Manifest ---
  const s1 = await runStage("Manifest", () => {
    let parsed: unknown;
    try { parsed = JSON.parse(req.manifestJson); } catch { throw new Error("manifest is not valid JSON"); }
    const v = validateManifest(parsed, { checkSprite: (id) => !!catalogGet(id) });
    if (!v.ok) throw new Error(v.errors.join("; "));
    const m = v.manifest;
    const errors: string[] = [];
    if (loadedIds.includes(m.id)) errors.push(`system id "${m.id}" is already loaded`);
    // Types named by interactions must exist or be declared.
    const probe = buildWorld();
    const knownTypes = new Set<string>([...probe.types.keys(), ...Object.keys(m.entities)]);
    for (const l of req.loaded) for (const t of Object.keys(l.manifest.entities)) knownTypes.add(t);
    for (const ix of m.interactions) {
      if (ix.target !== "held" && !ix.target.startsWith("#") && !ix.target.startsWith("tile:") && !knownTypes.has(ix.target)) {
        errors.push(`interaction "${ix.verb}" targets unknown entity type "${ix.target}"`);
      }
      if (ix.target.startsWith("tile:") && catalogFind(ix.target.slice(5)).length === 0) errors.push(`interaction "${ix.verb}" targets unknown terrain tag "${ix.target}"`);
      if (ix.held && ix.held !== "none" && !ix.held.startsWith("#") && !knownTypes.has(ix.held)) errors.push(`interaction "${ix.verb}" needs unknown held type "${ix.held}"`);
    }
    // buildsOn / replaces must be loaded.
    for (const b of m.buildsOn) if (!loadedIds.includes(b)) errors.push(`buildsOn "${b}" is not loaded`);
    const loadedAi = new Map(req.loaded.map((l) => [l.manifest.id, l.manifest]));
    for (const r of m.replaces) {
      if (BASE_SYSTEM_IDS.includes(r)) errors.push(`replaces "${r}" is a base system and cannot be replaced`);
      else if (!loadedAi.has(r)) errors.push(`replaces "${r}" is not a loaded AI system`);
    }
    // Emitted names carry the prefix, or are inherited through replaces (spec 11).
    const inherited = new Set<string>();
    for (const r of m.replaces) for (const name of Object.keys(loadedAi.get(r)?.emits ?? {})) inherited.add(name);
    for (const name of Object.keys(m.emits)) {
      if (!name.startsWith(`${m.id}.`) && !inherited.has(name)) errors.push(`emitted event "${name}" does not start with "${m.id}." and is not inherited through replaces`);
    }
    for (const r of m.replaces) {
      for (const name of Object.keys(loadedAi.get(r)?.emits ?? {})) {
        if (!(name in m.emits)) errors.push(`replaces "${r}" emitted "${name}" but the new system does not emit it`);
      }
    }
    // Every reaction must exist: base/engine, a loaded system's emits, or its own.
    const knownEvents = new Set<string>([...Object.keys(BASE_EVENTS), ...Object.keys(m.emits)]);
    for (const l of req.loaded) for (const name of Object.keys(l.manifest.emits)) knownEvents.add(name);
    for (const ev of m.reactions) if (!knownEvents.has(ev)) errors.push(`reaction "${ev}" is not an event any loaded system emits`);
    if (errors.length) throw new Error(errors.join("; "));
    return m;
  });
  if (!s1.ok) { report.stage = "Manifest"; return finish(); }
  manifest = s1.value;
  report.systemId = manifest.id;
  report.manifest = manifest;

  // --- Stage 2: Compile ---
  const s2 = await runStage("Compile", async () => {
    const r = await compileSystem(manifest, req.source);
    if (!r.ok) {
      report.errors = r.errors.map((e) => ({ message: e.message, line: e.line, sourceLine: e.sourceLine }));
      throw new Error(r.errors[0]?.message ?? "compilation failed");
    }
    return r.bytes;
  });
  if (!s2.ok) { report.stage = "Compile"; if (!report.errors.length) report.errors = [{ message: "compilation failed" }]; return finish(); }
  wasm = s2.value;
  report.wasm = wasm;

  // --- Stage 3: Module ---
  const s3 = await runStage("Module", () => {
    const game = createGame(buildWorld());
    try { loadWasmModule(game, manifest!, wasm!, { migrate: false }); }
    catch (e) { throw new Error(e instanceof ModuleLoadError ? e.message : `module failed to load: ${e instanceof Error ? e.message : String(e)}`); }
    return true;
  });
  if (!s3.ok) { report.stage = "Module"; return finish(); }

  // --- Stage 4: Tests ---
  const s4 = await runStage("Tests", () => {
    const own = runSystemTests(manifest!, wasm!);
    for (const t of own) {
      if (!t.passed) {
        report.errors.push({ message: `test ${t.name} failed${t.faults.length ? `: ${t.faults.join("; ")}` : ""}`, test: t.name, checks: t.checks, events: t.events, denied: t.denied, entities: t.entities });
      }
    }
    if (report.errors.length) throw new Error(report.errors[0].message);
    // Every existing system's tests with it loaded: base systems in their arena.
    for (const t of runBaseTests()) {
      if (!t.passed) report.errors.push({ message: `base test ${t.system}/${t.name} failed with ${manifest!.id} loaded`, test: `${t.system}/${t.name}`, checks: t.checks });
    }
    if (report.errors.length) throw new Error(report.errors[0].message);
    // Loaded AI systems' own tests, each on a fresh map with the candidate loaded too.
    for (const loaded of req.loaded) {
      const loadedBytes = b64ToBytes(loaded.wasmB64);
      const probeGame = createGame(buildWorld());
      probeGame.testMode = true;
      const probe = loadWasmModule(probeGame, loaded.manifest, loadedBytes, { migrate: false });
      for (const name of probe.testNames) {
        const game = createGame(buildWorld());
        game.testMode = true;
        game.checks = [];
        const handle = loadWasmModule(game, loaded.manifest, loadedBytes, { migrate: false });
        handle.strikesEnabled = false;
        if (handle.exportNames.includes("migrate")) handle.runNamed("migrate");
        const candidate = loadWasmModule(game, manifest!, wasm!, { migrate: false });
        candidate.strikesEnabled = false;
        if (candidate.exportNames.includes("migrate")) candidate.runNamed("migrate");
        const faultsBefore = game.faults.length;
        const ran = handle.runNamed(name);
        const checks = [...game.checks];
        if (!checks.length) checks.push({ label: "at least one check ran", passed: false });
        if (!ran || !checks.every((c) => c.passed)) {
          report.errors.push({ message: `existing system test ${loaded.manifest.id}/${name} failed with ${manifest!.id} loaded`, test: `${loaded.manifest.id}/${name}`, checks, events: game.eventLog.slice(-100), denied: [...game.eng.deniedLog] });
        }
        void faultsBefore;
      }
    }
    if (report.errors.length) throw new Error(report.errors[0].message);
    return true;
  });
  if (!s4.ok) { report.stage = "Tests"; return finish(); }

  // --- Stage 5: World check ---
  const s5 = await runStage("World check", () => {
    const eng = buildWorld();
    const game = createGame(eng);
    game.testMode = true;
    // Copy of the current world: loaded AI systems first (no migrate), then the snapshot.
    const handles = new Map<string, ReturnType<typeof loadWasmModule>>();
    for (const loaded of req.loaded) {
      const h = loadWasmModule(game, loaded.manifest, b64ToBytes(loaded.wasmB64), { migrate: false });
      h.strikesEnabled = false;
      handles.set(loaded.manifest.id, h);
    }
    eng.restore(req.snapshot);
    const faultsBefore = game.faults.length;
    const candidate = loadWasmModule(game, manifest!, wasm!, { migrate: false });
    candidate.strikesEnabled = false;
    if (candidate.exportNames.includes("migrate")) {
      if (!candidate.runNamed("migrate")) { report.errors.push(errorFromFaults(game, faultsBefore, "migrate failed in the world check")); throw new Error(report.errors[0].message); }
    }
    for (let i = 0; i < TUNING.limits.worldCheckTicks; i++) game.tick();
    if (game.faults.length > faultsBefore) { report.errors.push(errorFromFaults(game, faultsBefore, `world check faulted during ${TUNING.limits.worldCheckTicks} ticks`)); throw new Error(report.errors[0].message); }
    // The player can still walk, pick up and drop (scripted with sim).
    const player = eng.playerRec();
    if (!player?.pos) { report.errors.push({ message: "world check: the player is missing after loading" }); throw new Error(report.errors[0].message); }
    const start = { ...player.pos };
    let walked = false;
    for (const dir of ["right", "left", "down", "up"]) {
      game.call("test", { op: "sim.walk", dir });
      const p = eng.playerRec()!.pos!;
      if (p.x !== start.x || p.y !== start.y) { walked = true; break; }
    }
    if (!walked) { report.errors.push({ message: "world check: the player can no longer walk after this system loads", events: game.eventLog.slice(-100), denied: [...game.eng.deniedLog] }); throw new Error(report.errors[0].message); }
    const give = game.call("test", { op: "sim.give", type: "branch" });
    if (!give.ok) { report.errors.push({ message: `world check: sim.give failed — ${give.msg}` }); throw new Error(report.errors[0].message); }
    game.call("test", { op: "sim.face", dir: "down" });
    game.call("test", { op: "sim.interact" });
    if (eng.playerRec()!.comps.has("held")) { report.errors.push({ message: "world check: the player can no longer drop an item" }); throw new Error(report.errors[0].message); }
    // Invariants: placed footprints on walkable tiles, occupancy matches.
    for (const rec of eng.entities.values()) {
      if (!rec.pos) continue;
      if (!eng.footprintWalkable(eng.spriteIdOf(rec), rec.pos.x, rec.pos.y, rec.pos.area)) {
        report.errors.push({ message: `world check: entity ${rec.type} #${rec.id} sits on an unwalkable tile at ${rec.pos.x},${rec.pos.y}` });
        throw new Error(report.errors[0].message);
      }
    }
    if (!eng.validateOccupancy()) { report.errors.push({ message: "world check: occupancy no longer matches entity positions" }); throw new Error(report.errors[0].message); }
    // Serializes and deserializes.
    const saved = eng.serialize();
    eng.restore(saved);
    if (!eng.validateOccupancy()) { report.errors.push({ message: "world check: occupancy broken after a serialize round-trip" }); throw new Error(report.errors[0].message); }
    // The module can be re-created mid-run from saved state and keep ticking.
    game.unloadSystem(manifest!.id);
    const recreated = loadWasmModule(game, manifest!, wasm!, { migrate: false });
    recreated.strikesEnabled = false;
    const faults2 = game.faults.length;
    for (let i = 0; i < 10; i++) game.tick();
    if (game.faults.length > faults2) { report.errors.push(errorFromFaults(game, faults2, "re-created module faulted")); throw new Error(report.errors[0].message); }
    return true;
  });
  if (!s5.ok) { report.stage = "World check"; return finish(); }

  // --- Stage 6: Shots ---
  await runStage("Shots", async () => {
    for (const shot of manifest!.shots) {
      let png = FALLBACK_PNG;
      try {
        const game = createGame(buildWorld());
        game.testMode = true;
        const handle = loadWasmModule(game, manifest!, wasm!, { migrate: false });
        handle.strikesEnabled = false;
        if (handle.exportNames.includes("migrate")) handle.runNamed("migrate");
        if (shot.time) game.call("test", { op: "sim.time", phaseOrHour: shot.time });
        handle.runNamed(`shot_${shot.name}`);
        for (let i = 0; i < shot.ticks; i++) game.tick();
        if (hooks.renderShot) png = await hooks.renderShot(game, shot);
      } catch { png = FALLBACK_PNG; /* a render failure is logged, never blocking */ }
      report.shots.push({ name: shot.name, png });
    }
    return true;
  });

  report.ok = true;
  report.stage = "Load";
  return finish();
}
