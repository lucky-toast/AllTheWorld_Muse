// The test runner (spec 9): every base-system test runs in a fresh empty walkable 12x12
// arena (test-only types test_item, test_block, test_pushable) with every base system
// loaded, so map changes can't break them. Tests use only requests: the sim.* requests
// play through the same paths as real keys, and `check` records named checks.
import { buildArena } from "../world/map";
import { Host, type EventEntry } from "./host";
import { testNames, type SystemDef } from "./systems";

export interface TestResult {
  system: string; name: string; passed: boolean;
  checks: { label: string; passed: boolean }[];
  error: string | null;
  /** The last events fired during the test. */
  events: EventEntry[];
  /** Requests denied during the test. */
  denied: { op: string; code: string; msg: string }[];
}

/** A fresh arena with `defs` loaded in order. */
export function arenaHost(defs: readonly SystemDef[]): Host {
  const host = new Host(buildArena());
  for (const def of defs) host.load(def);
  return host;
}

/** Run one test of `system` on a fresh arena with `defs` loaded. */
export function runArenaTest(defs: readonly SystemDef[], system: string, name: string): TestResult {
  const host = arenaHost(defs);
  const before = host.denials.length;
  const r = host.runTest(system, name);
  const denied = host.denials.slice(before).map((d) => ({ op: d.op, code: d.code, msg: d.msg }));
  return { system, name, ...r, denied };
}

/** Every test of every system in `defs`, each on its own fresh arena. */
export function runArenaTests(defs: readonly SystemDef[]): TestResult[] {
  const out: TestResult[] = [];
  const host = arenaHost(defs);
  for (const sys of host.systems.values()) for (const name of testNames(sys.module)) out.push(runArenaTest(defs, sys.id, name));
  return out;
}
