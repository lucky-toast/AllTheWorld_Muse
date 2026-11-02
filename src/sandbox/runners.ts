// The AI test and shot runners (spec 5.2, 12 stages 4 and 6). Each test_* export runs on
// a fresh copy of the real map from the fixed seed, with the base systems, the systems it
// depends on and the system itself loaded; the export itself runs under the test fuel
// limit (the adapter gives test_*, shot_* and migrate 500M units). A test passes when every
// check passed, at least one ran, nothing threw and none of the system's own handlers
// faulted during it. Shots set up the same way, then run their ticks; rendering them is
// the pipeline's job.
import { buildWorld } from "../world/map";
import { Host, type FaultEntry } from "../engine/host";
import { BASE_SYSTEMS } from "../systems/base";
import { testNames, type SystemDef } from "../engine/systems";
import type { TestResult } from "../engine/testrun";
import type { Shot } from "../engine/manifest";
import type { Phase } from "../tuning";

export interface AiTestResult extends TestResult {
  /** Handler calls of this system that trapped or threw during the test (each was rolled back). */
  faults: FaultEntry[];
}

/** A fresh real world with the base systems, then `deps`, then `def` loaded (its migrate runs). */
export function worldHost(def: SystemDef, deps: readonly SystemDef[] = [], successors?: Map<string, string>): Host {
  const host = new Host(buildWorld());
  for (const [a, b] of successors ?? []) host.successors.set(a, b);
  for (const d of [...BASE_SYSTEMS, ...deps, def]) host.load(d);
  host.interactions.refresh(true);
  return host;
}

function idOf(def: SystemDef): string { return (def.manifest as { id: string }).id; }

/** Run test_<name> of `def` on a fresh world. */
export function runAiTest(def: SystemDef, name: string, deps: readonly SystemDef[] = []): AiTestResult {
  const system = idOf(def);
  let host: Host;
  try { host = worldHost(def, deps); }
  catch (e) { return { system, name, passed: false, checks: [], events: [], denied: [], faults: [], error: `loading failed: ${e instanceof Error ? e.message : String(e)}` }; }
  const denials = host.denials.length; const faults = host.faults.length;
  const r = host.runTest(system, name);
  const ownFaults = host.faults.slice(faults).filter((f) => f.system === system);
  const denied = host.denials.slice(denials).filter((d) => d.system === system).map((d) => ({ op: d.op, code: d.code, msg: d.msg }));
  return { system, name, ...r, passed: r.passed && !ownFaults.length, denied, faults: ownFaults };
}

/** Every test_* export of `def`, each on its own fresh world. */
export function runAiTests(def: SystemDef, deps: readonly SystemDef[] = []): AiTestResult[] {
  const host = worldHost(def, deps);
  const sys = host.systems.get(idOf(def))!;
  return testNames(sys.module).map((name) => runAiTest(def, name, deps));
}

export interface ShotRun { name: string; shot: Shot; host: Host; error: string | null; faults: FaultEntry[] }

/** Set up shot `name` on a fresh world: jump the clock to its time, run shot_<name>, then its ticks. */
export function runShot(def: SystemDef, name: string, deps: readonly SystemDef[] = [], successors?: Map<string, string>): ShotRun {
  const host = worldHost(def, deps, successors);
  const system = idOf(def);
  const sys = host.systems.get(system)!;
  const shot = sys.manifest.shots.find((s) => s.name === name);
  if (!shot) return { name, shot: { name, ticks: 0, focus: { x: 0, y: 0 } }, host, error: `"${system}" has no shot "${name}"`, faults: [] };
  const faults = host.faults.length;
  if (shot.time) host.eng.jumpClock(shot.time as Phase);
  const mode = host.mode; host.mode = "shot";
  let error: string | null = null;
  try {
    const fn = sys.module[`shot_${name}`];
    if (!fn) throw new Error(`"${system}" has no shot_${name}`);
    fn.call(sys.module);
    for (let i = 0; i < shot.ticks; i++) host.tick();
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  finally { host.mode = mode; }
  return { name, shot, host, error, faults: host.faults.slice(faults).filter((f) => f.system === system) };
}

/** Every shot in the manifest of `def`. */
export function runShots(def: SystemDef, deps: readonly SystemDef[] = []): ShotRun[] {
  return ((def.manifest as { shots?: Shot[] }).shots ?? []).map((s) => runShot(def, s.name, deps));
}
