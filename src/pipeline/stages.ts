// Pipeline stages 1 to 6 (spec 12). Pure: no DOM, no storage, no live game. The worker
// runs this with its own engine copies; Node tests run the very same code in-process.
//
//   1 Manifest     schema, then the checks that need the loaded systems
//   2 Compile      asc with the fixed settings
//   3 Module       the loader (validate, imports, exports, metering)
//   4 Tests        its own test_* on fresh real maps; base tests in their arena; every
//                  loaded AI system's tests on fresh real maps; all with it loaded
//   5 World check  load into a copy of the live world, migrate, worldCheckTicks ticks, then
//                  walk / pick up / drop with sim, invariants, save round trip, and the
//                  modules re-created from the saved world keep ticking
//   6 Shots        each shot's setup and ticks on a fresh copy, rendered by a hook
import { buildArena, buildWorld } from "../world/map";
import { Engine } from "../engine/engine";
import { Host, type FaultEntry } from "../engine/host";
import { BASE_SYSTEMS } from "../systems/base";
import { validateManifest, checkManifestContext, type Manifest, type Shot } from "../engine/manifest";
import { ENGINE_OWNER } from "../engine/types";
import { testNames, type SystemDef } from "../engine/systems";
import { compileSystem, formatCompileError, MODULE_FILE } from "../sandbox/compile";
import { aiSystem, prepareModule, ModuleError, type AiSystemDef } from "../sandbox/module";
import { runShot } from "../sandbox/runners";
import { LIMITS } from "../tuning";
import type { CheckRequest, PipelineError, Report, Stage, StageEvent } from "./types";

export interface CheckHooks {
  onStage?(e: StageEvent): void;
  /** Render a shot's world to a PNG data URL, or null when this environment can't render. */
  renderShot?(host: Host, shot: Shot): Promise<string | null>;
}

/** A system to load into a host, and whether its migrate runs there. */
interface Entry { def: SystemDef; migrate: boolean }

function hostWith(eng: Engine, entries: Entry[]): Host {
  const host = new Host(eng);
  for (const e of entries) host.load(e.def, { migrate: e.migrate, announce: e.migrate });
  host.interactions.refresh(true);
  return host;
}
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const idOf = (def: SystemDef) => (def.manifest as { id: string }).id;
const DIRS = ["down", "up", "left", "right"] as const;
const STEP: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

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
  const liveCopy = (): Host => {
    const h = hostWith(buildWorld(), [...BASE_SYSTEMS, ...loadedDefs].map((def) => ({ def, migrate: false })));
    h.eng.restore(req.world);
    h.interactions.refresh(true);
    return h;
  };
  let ctxHost: Host;
  try { ctxHost = liveCopy(); } catch (e) { return fail([{ message: `the live world couldn't be copied for the check: ${msgOf(e)}` }]); }
  const replaces = Array.isArray((raw as { replaces?: unknown })?.replaces) ? ((raw as { replaces: unknown[] }).replaces.filter((r) => typeof r === "string") as string[]) : [];
  const inherited = replaces.flatMap((r) => Object.keys(ctxHost.systems.get(r)?.manifest.emits ?? {}));
  const v = validateManifest(raw, { inherited });
  if (!v.ok) return fail(v.errors.map((message) => ({ message })));
  const manifest: Manifest = v.manifest;
  const errs = checkManifestContext(manifest, {
    loaded: new Set(ctxHost.systems.keys()),
    aiLoaded: new Set([...ctxHost.systems.values()].filter((s) => !s.base).map((s) => s.id)),
    events: new Set(ctxHost.registry.eventOwner.keys()),
    types: new Set(ctxHost.eng.types.keys()),
  });
  for (const r of manifest.replaces) {
    const old = ctxHost.systems.get(r); if (!old || old.base) continue;
    for (const ev of Object.keys(old.manifest.emits)) if (!(ev in manifest.emits)) errs.push(`replaces "${r}": its event "${ev}" must stay in emits under the same name`);
  }
  if (!errs.length && manifest.replaces.length) errs.push("replaces isn't supported yet: succession arrives in a later phase");
  if (errs.length) return fail(errs.map((message) => ({ message })));
  pass();

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
  pass();

  // ======================= 3. Module =======================
  await breathe();
  begin("Module");
  let candidate: AiSystemDef;
  try { candidate = aiSystem(prepareModule(wasm, manifest)); }
  catch (e) { return fail(e instanceof ModuleError ? e.errors.map((message) => ({ message })) : [{ message: msgOf(e) }]); }
  pass();

  const id = manifest.id;
  const real = (withCandidate: boolean): Entry[] => [...BASE_SYSTEMS, ...loadedDefs, ...(withCandidate ? [candidate] : [])].map((def) => ({ def, migrate: true }));

  // ======================= 4. Tests =======================
  await breathe();
  begin("Tests");
  const own = candidate.prepared.exports.filter((n) => n.startsWith("test_")).map((n) => n.slice(5));
  if (!own.length) return fail([{ message: `${id} exports no test_* functions; every system needs at least one test` }]);
  const failures: PipelineError[] = [];
  for (const name of own) {
    const r = runOne(buildWorld, real(true), id, name, true);
    if (r) failures.push(r);
  }
  if (!failures.length) {
    // Base systems' tests, in their arena, with it loaded (only base systems migrate there: the arena isn't a world).
    const arenaEntries: Entry[] = [...BASE_SYSTEMS.map((def) => ({ def, migrate: true })), ...[...loadedDefs, candidate].map((def) => ({ def, migrate: false }))];
    for (const base of BASE_SYSTEMS) {
      const names = namesOf(() => buildArena(), arenaEntries, idOf(base));
      for (const name of names) { const r = runOne(() => buildArena(), arenaEntries, idOf(base), name, false); if (r) failures.push(r); }
    }
    // Every loaded AI system's tests on fresh real maps, with it loaded.
    for (const def of loadedDefs) {
      const sid = idOf(def);
      for (const name of def.prepared.exports.filter((n) => n.startsWith("test_")).map((n) => n.slice(5))) {
        const r = runOne(buildWorld, real(true), sid, name, true); if (r) failures.push(r);
      }
    }
  }
  if (failures.length) return fail(failures);
  pass();

  // ======================= 5. World check =======================
  await breathe();
  begin("World check");
  const wc = worldCheck(liveCopy, [...BASE_SYSTEMS, ...loadedDefs], candidate, report.log);
  if (wc.length) return fail(wc);
  pass();

  // ======================= 6. Shots =======================
  await breathe();
  begin("Shots");
  const shotErrors: PipelineError[] = [];
  for (const shot of manifest.shots) {
    const run = runShot(candidate, shot.name, loadedDefs);
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
function namesOf(build: () => Engine, entries: Entry[], system: string): string[] {
  try { const h = hostWith(build(), entries); const s = h.systems.get(system); return s ? testNames(s.module) : []; }
  catch { return []; }
}

/** Run one test on a fresh host. Returns its error, or null when it passed. `ownFaults`: the system's own faults fail it. */
function runOne(build: () => Engine, entries: Entry[], system: string, name: string, ownFaults: boolean): PipelineError | null {
  const test = `${system}.test_${name}`;
  let host: Host;
  try { host = hostWith(build(), entries); }
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
    entities: entitiesOf(host, system),
  };
}

/** Type, pos and components of what `system` spawned, plus the player. */
function entitiesOf(host: Host, system: string): NonNullable<PipelineError["entities"]> {
  const eng = host.eng; const out: NonNullable<PipelineError["entities"]> = [];
  const p = eng.player();
  for (const r of eng.entities.values()) {
    if (r !== p && eng.entityOwner.get(r.id) !== system) continue;
    out.push({ id: r.id, type: r.type, pos: r.pos ? { ...r.pos } : null, components: Object.fromEntries(r.comps) });
    if (out.length >= 50) break;
  }
  return out;
}

/** Stage 5. Returns its errors (empty when it passed); overlaps and near-limit calls go to `log`. */
function worldCheck(liveCopy: () => Host, others: SystemDef[], candidate: AiSystemDef, log: string[]): PipelineError[] {
  const id = idOf(candidate);
  let w: Host;
  try { w = liveCopy(); } catch (e) { return [{ message: `the live world couldn't be copied: ${msgOf(e)}` }]; }
  const eng = w.eng;
  const faultText = (f: FaultEntry) => (f.msg.startsWith(`${f.system}.`) ? f.msg : `${f.system}.${f.kind}: ${f.msg}`);
  try { w.load(candidate); }
  catch (e) { return [{ message: `loading into the current world failed: ${msgOf(e)}` }]; }
  for (let i = 1; i <= LIMITS.worldCheckTicks; i++) {
    const f0 = w.faults.length;
    w.tick();
    if (w.faults.length > f0) return w.faults.slice(f0).map((f) => ({ message: `${faultText(f)} (tick ${i} of ${LIMITS.worldCheckTicks} on a copy of the world; the game kept running)` }));
  }
  const errors: PipelineError[] = [];

  // The player can still walk, pick up and drop, played with sim like a test.
  w.mode = "test";
  const f0 = w.faults.length;
  const call = (req: Record<string, unknown>) => w.call(ENGINE_OWNER, req as { op: string });
  const player = () => eng.player();
  const posText = () => { const p = player()?.pos; return p ? `(${p.x}, ${p.y})` : "nowhere"; };
  const at0 = posText();
  let walked = false;
  for (const dir of DIRS) {
    const before = posText();
    call({ op: "sim.walk", dir });
    if (posText() !== before) { walked = true; break; }
  }
  if (!walked) errors.push({ message: `the player can't walk any more: no step from ${at0} works`, entities: entitiesOf(w, id) });
  const freeDir = (): string | null => {
    const p = player()?.pos; if (!p) return null;
    return DIRS.find((d) => eng.isFreeFor(p.area, p.x + STEP[d][0], p.y + STEP[d][1], player()!.id)) ?? null;
  };
  /** Face `dir` and run owner/verb through E, cycling with Q until it is highlighted. */
  const act = (dir: string, owner: string, verb: string): boolean => {
    call({ op: "sim.face", dir });
    for (let k = 0; k <= w.interactions.matches.length; k++) {
      const m = w.interactions.current;
      if (m && m.entry.owner === owner && m.entry.verb === verb) { call({ op: "sim.interact" }); return true; }
      call({ op: "sim.cycle" });
    }
    return false;
  };
  const heldId = () => (player()?.comps.get("held") as { id?: number } | undefined)?.id;
  if (walked) {
    let dir = freeDir();
    if (heldId() !== undefined && dir) { act(dir, "carry", "drop"); dir = freeDir(); }
    if (!dir) errors.push({ message: `there's no free tile beside the player at ${posText()} to try pick up and drop` });
    else if (heldId() !== undefined) errors.push({ message: "the player can't drop what they hold" });
    else {
      const p = player()!.pos!; const tx = p.x + STEP[dir][0], ty = p.y + STEP[dir][1];
      const item = eng.spawn("branch", { x: tx, y: ty, area: p.area }, ENGINE_OWNER);
      if (!act(dir, "carry", "pick_up") || heldId() !== item.id) errors.push({ message: `the player can't pick up a branch any more (facing ${dir} at ${posText()})` });
      else if (!act(dir, "carry", "drop") || heldId() !== undefined || item.pos?.x !== tx || item.pos?.y !== ty) errors.push({ message: `the player can't drop a branch any more (facing ${dir} at ${posText()})` });
    }
  }
  w.mode = "live";
  for (const f of w.faults.slice(f0)) errors.push({ message: `${faultText(f)} (while the player walked, picked up and dropped)` });

  // Invariants.
  for (const p of eng.invariantProblems()) errors.push({ message: `invariant broken: ${p}` });

  // The world serializes and deserializes.
  const saved = eng.serialize();
  try {
    const copy = new Engine(eng.width, eng.height, eng.seed); copy.deserialize(saved);
    if (copy.serialize() !== saved) errors.push({ message: "the world doesn't come back the same after saving and loading it" });
  } catch (e) { errors.push({ message: `the world doesn't load back after saving: ${msgOf(e)}` }); }

  // The modules can be re-created mid-run from the saved world and keep ticking.
  try {
    const again = hostWith(buildWorld(), [...others, candidate].map((def) => ({ def, migrate: false })));
    again.eng.restore(saved); again.interactions.refresh(true);
    const g0 = again.faults.length;
    for (let i = 0; i < LIMITS.worldCheckResumeTicks; i++) again.tick();
    for (const f of again.faults.slice(g0)) errors.push({ message: `${faultText(f)} (after re-creating the modules from the saved world)` });
  } catch (e) { errors.push({ message: `the modules couldn't be re-created from the saved world: ${msgOf(e)}` }); }

  for (const o of w.overlaps) log.push(`overlap: ${o.systems.join(" and ")} both wrote entity ${o.entity} while handling ${o.event} (tick ${o.tick})`);
  for (const n of w.nearLimits) if (n.system === id) log.push(`near limit: ${n.system} used ${n.used} of its ${n.max} ${n.limit} in one call (tick ${n.tick})`);
  return errors;
}
