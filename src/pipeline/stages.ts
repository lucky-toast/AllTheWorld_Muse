// Pipeline stages 1 to 6 (spec 12). Pure: no DOM, no storage, no live game. The worker
// runs this with its own engine copies; Node tests run the very same code in-process.
//
//   1 Manifest     schema, then the checks that need the loaded systems
//   2 Compile      asc with the fixed settings
//   3 Module       the loader (validate, imports, exports, metering)
//   4 Tests        its own test_* on fresh real maps; base tests in their arena; every
//                  loaded AI system's tests on fresh real maps; all with it loaded (a system
//                  it replaces is left out, own tests and all: spec 11)
//   5 World check  load into a copy of the live world, migrate, worldCheckTicks ticks, then
//                  walk / pick up / drop with sim, invariants, save round trip, and the
//                  modules re-created from the saved world keep ticking
//   6 Shots        each shot's setup and ticks on a fresh copy, rendered by a hook
// Stage 5 lives in worldcheck.ts, so Load can run it again on the live world.
import { buildArena, buildWorld } from "../world/map";
import { Engine } from "../engine/engine";
import type { Host } from "../engine/host";
import { BASE_SYSTEMS } from "../systems/base";
import { validateManifest, checkManifestContext, type Manifest, type Shot } from "../engine/manifest";
import { testNames, type SystemDef } from "../engine/systems";
import { compileSystem, formatCompileError, MODULE_FILE } from "../sandbox/compile";
import { aiSystem, prepareModule, ModuleError, type AiSystemDef } from "../sandbox/module";
import { runShot } from "../sandbox/runners";
import { entitiesOf, hostWith, worldCheck, worldCopy, type Entry } from "./worldcheck";
import { LIMITS } from "../tuning";
import type { CheckRequest, PipelineError, Report, Stage, StageEvent } from "./types";

export interface CheckHooks {
  onStage?(e: StageEvent): void;
  /** A test ("<system>.test_<name>") is about to run, world build included. */
  onTest?(name: string): void;
  /** Render a shot's world to a PNG data URL, or null when this environment can't render. */
  renderShot?(host: Host, shot: Shot): Promise<string | null>;
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const idOf = (def: SystemDef) => (def.manifest as { id: string }).id;

/** Run stages 1 to 6 on a candidate system. Never touches anything outside the engine copies it makes. */
export async function runCheck(req: CheckRequest, hooks: CheckHooks = {}): Promise<Report> {
  const t0 = Date.now();
  const report: Report = { ok: false, stage: "Manifest", systemId: null, errors: [], shots: [], durationMs: 0, log: [], stageMs: {} };
  let stageStart = 0;
  const begin = (s: Stage) => { report.stage = s; stageStart = Date.now(); hooks.onStage?.({ stage: s, status: "start" }); };
  const end = (status: "pass" | "fail") => {
    const ms = Date.now() - stageStart; report.stageMs[report.stage] = ms;
    hooks.onStage?.({ stage: report.stage, status, ms });
  };
  const fail = (errors: PipelineError[]): Report => { report.errors = errors; end("fail"); report.durationMs = Date.now() - t0; return report; };
  const pass = () => end("pass");
  // Let the stage message leave before a long synchronous stage starts.
  const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

  // ======================= 1. Manifest =======================
  begin("Manifest");
  let raw: unknown;
  try { raw = JSON.parse(req.manifestJson); } catch (e) { return fail([{ message: `manifest.json isn't valid JSON: ${msgOf(e)}` }]); }
  const rawId = (raw as { id?: unknown } | null)?.id;
  report.systemId = typeof rawId === "string" ? rawId : null;
  let loadedDefs: AiSystemDef[];
  try { loadedDefs = req.loaded.map((l) => aiSystem(prepareModule(l.wasm, l.manifest))); }
  catch (e) { return fail([{ message: `a loaded system couldn't be rebuilt for the check: ${msgOf(e)}` }]); }
  const successors = new Map(Object.entries(req.successors ?? {}));
  const liveCopy = () => worldCopy(req.world, loadedDefs, successors);
  let ctxHost: Host;
  try { ctxHost = liveCopy(); } catch (e) { return fail([{ message: `the live world couldn't be copied for the check: ${msgOf(e)}` }]); }
  const inherited = ctxHost.inheritedEvents(raw as { replaces?: unknown; emits?: unknown });
  const v = validateManifest(raw, { inherited });
  if (!v.ok) return fail(v.errors.map((message) => ({ message })));
  const manifest: Manifest = v.manifest;
  const errs = checkManifestContext(manifest, {
    loaded: new Set(ctxHost.systems.keys()),
    aiLoaded: new Set([...ctxHost.systems.values()].filter((s) => !s.base).map((s) => s.id)),
    events: new Set(ctxHost.registry.eventOwner.keys()),
    types: new Set(ctxHost.eng.types.keys()),
    successors,
    manifests: new Map([...ctxHost.systems.values()].map((s) => [s.id, s.manifest])),
  });
  if (errs.length) return fail(errs.map((message) => ({ message })));
  pass();
  // Succession (spec 11): from here on the replaced systems are gone. Their own tests are dropped,
  // everything else runs with the replacement instead, and the World check swaps them on a copy.
  const kept = loadedDefs.filter((d) => !manifest.replaces.includes(idOf(d)));
  const after = new Map(successors); for (const r of manifest.replaces) after.set(r, manifest.id);

  // ======================= 2. Compile =======================
  await breathe();
  begin("Compile");
  const comp = await compileSystem(manifest, req.source);
  if (!comp.ok) {
    return fail(comp.errors.map((e) => {
      const out: PipelineError = { message: formatCompileError(e) };
      if (e.line !== undefined && (e.file ?? MODULE_FILE) === MODULE_FILE) { out.line = e.line; out.sourceLine = e.sourceLine; }
      return out;
    }));
  }
  const wasm = comp.wasm;
  if (comp.importsAdded) report.log.push(`compile: added missing imports from "sdk": ${comp.importsAdded.join(", ")}`);
  pass();

  // ======================= 3. Module =======================
  await breathe();
  begin("Module");
  let candidate: AiSystemDef;
  try { candidate = aiSystem(prepareModule(wasm, manifest)); }
  catch (e) { return fail(e instanceof ModuleError ? e.errors.map((message) => ({ message })) : [{ message: msgOf(e) }]); }
  pass();

  const id = manifest.id;
  const real = (): Entry[] => [...BASE_SYSTEMS, ...kept, candidate].map((def) => ({ def, migrate: true }));

  // ======================= 4. Tests =======================
  await breathe();
  begin("Tests");
  const own = candidate.prepared.exports.filter((n) => n.startsWith("test_")).map((n) => n.slice(5));
  if (!own.length) return fail([{ message: `${id} exports no test_* functions; every system needs at least one test` }]);
  const failures: PipelineError[] = [];
  for (const name of own) {
    const r = runOne(buildWorld, real(), id, name, true, after, hooks);
    if (r) failures.push(r);
  }
  if (!failures.length) {
    // Base systems' tests, in their arena, with it loaded (only base systems migrate there: the arena isn't a world).
    const arenaEntries: Entry[] = [...BASE_SYSTEMS.map((def) => ({ def, migrate: true })), ...[...kept, candidate].map((def) => ({ def, migrate: false }))];
    for (const base of BASE_SYSTEMS) {
      const names = namesOf(() => buildArena(), arenaEntries, idOf(base), after);
      for (const name of names) { const r = runOne(() => buildArena(), arenaEntries, idOf(base), name, false, after, hooks); if (r) failures.push(r); }
    }
    // Every remaining AI system's tests on fresh real maps, with it loaded (a replaced system's own tests are dropped).
    for (const def of kept) {
      const sid = idOf(def);
      for (const name of def.prepared.exports.filter((n) => n.startsWith("test_")).map((n) => n.slice(5))) {
        const r = runOne(buildWorld, real(), sid, name, true, after, hooks); if (r) failures.push(r);
      }
    }
  }
  if (failures.length) return fail(failures);
  pass();

  // ======================= 5. World check =======================
  await breathe();
  begin("World check");
  const wc = worldCheck(liveCopy, [...BASE_SYSTEMS, ...loadedDefs], candidate, report.log, successors);
  if (wc.length) return fail(wc);
  pass();

  // ======================= 6. Shots =======================
  await breathe();
  begin("Shots");
  const shotErrors: PipelineError[] = [];
  for (const shot of manifest.shots) {
    const run = runShot(candidate, shot.name, kept, after);
    if (run.error) { shotErrors.push({ message: `shot "${shot.name}": its setup failed: ${run.error}` }); continue; }
    if (run.faults.length) { shotErrors.push({ message: `shot "${shot.name}": ${run.faults.map((f) => f.msg).join("; ")}` }); continue; }
    let png: string | null = null;
    try { png = hooks.renderShot ? await hooks.renderShot(run.host, shot) : null; if (!png) report.log.push(`shot "${shot.name}" wasn't rendered here (no OffscreenCanvas)`); }
    catch (e) { report.log.push(`shot "${shot.name}" failed to render: ${msgOf(e)}`); }
    report.shots.push({ name: shot.name, png });
  }
  if (shotErrors.length) return fail(shotErrors);
  pass();

  report.ok = true;
  report.checked = { manifestJson: req.manifestJson, source: req.source, wasm, loaded: [...req.loadedIds] };
  report.durationMs = Date.now() - t0;
  return report;
}

/** The test names `system` exports, read from a host built the way its tests run. */
function namesOf(build: () => Engine, entries: Entry[], system: string, successors: Map<string, string>): string[] {
  try { const h = hostWith(build(), entries, successors); const s = h.systems.get(system); return s ? testNames(s.module) : []; }
  catch { return []; }
}

/** Run one test on a fresh host. Returns its error, or null when it passed. `ownFaults`: the system's own faults fail it. */
function runOne(build: () => Engine, entries: Entry[], system: string, name: string, ownFaults: boolean, successors: Map<string, string>, hooks: CheckHooks = {}): PipelineError | null {
  const test = `${system}.test_${name}`;
  hooks.onTest?.(test);
  let host: Host;
  try { host = hostWith(build(), entries, successors); }
  catch (e) { return { message: `${test}: the world for the test couldn't be set up: ${msgOf(e)}`, test }; }
  const d0 = host.denials.length; const f0 = host.faults.length;
  const r = host.runTest(system, name);
  const faults = host.faults.slice(f0).filter((f) => f.system === system);
  const passed = r.passed && (!ownFaults || !faults.length);
  if (passed) return null;
  const failed = r.checks.filter((c) => !c.passed).map((c) => `"${c.label}"`);
  const why = r.error ? `it threw: ${r.error}`
    : failed.length ? `check${failed.length > 1 ? "s" : ""} ${failed.join(", ")} failed`
    : faults.length ? `${faults.map((f) => f.msg).join("; ")}`
    : "no check ran";
  const extra = !r.error && failed.length && faults.length ? ` (and ${faults.map((f) => f.msg).join("; ")})` : "";
  return {
    message: `${test} failed: ${why}${extra}`, test, checks: r.checks, events: r.events.slice(-LIMITS.eventLogMax),
    denied: host.denials.slice(d0).filter((x) => x.system === system).map((x) => ({ op: x.op, code: x.code, msg: x.msg })),
    // From the start, migrate included: a spawn moved there is what a test's fixed coordinates miss.
    moved: host.relocations.filter((x) => x.system === system).map((x) => ({ op: x.op, what: x.what, asked: x.asked, placed: x.placed, inTheWay: x.inTheWay })),
    entities: entitiesOf(host, system),
  };
}

