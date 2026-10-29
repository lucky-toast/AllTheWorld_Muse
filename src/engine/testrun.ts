import type { SystemDef } from "./api";
import type { Engine } from "./engine";
import { makeSim } from "./sim";

export interface DetailedResult {
  system: string; name: string;
  checks: { label: string; passed: boolean }[];
  failures: string[];
  events: { tick: number; name: string; payload: Record<string, unknown> }[];
  inputs: { name: string; handledBy: string; receivedBy: string[] }[];
  entities: { type: string; pos: { x: number; y: number } | null; components: Record<string, unknown> }[];
  thrown: { system: string; handler: string; message: string } | null;
}

/** Run one system test on an already-loaded engine, with full pipeline capture. */
export function runOneTest(eng: Engine, sys: SystemDef, t: SystemDef["tests"][number]): DetailedResult {
  const loaded = eng.systems.find((s) => s.def.id === sys.id);
  const w = eng.facade(loaded ?? null);
  const sim = makeSim(eng, w);
  const checks: { label: string; passed: boolean }[] = [];
  let thrown: DetailedResult["thrown"] = null;
  eng.beginCapture();
  try {
    t.setup?.(w, sim);
    for (let i = 0; i < (t.ticks ?? 0); i++) eng.tick();
    t.expect(w, (cond, what) => checks.push({ label: what, passed: !!cond }));
  } catch (e) {
    thrown = eng.thrownInfo ?? { system: sys.id, handler: "(test)", message: (e as Error).message };
  }
  const spawned = eng.capSpawned.map((id) => eng.entitySummary(id)).filter(Boolean) as DetailedResult["entities"];
  const playerEnt = eng.player();
  const entities = [...spawned];
  if (playerEnt && !entities.some((e) => e.components && spawned.length && false)) { const ps = eng.entitySummary(playerEnt.id); if (ps) entities.push(ps); }
  const events = eng.capEvents.slice(-100);
  const inputs = [...eng.capInputs];
  eng.endCapture();
  if (checks.length === 0 && !thrown) checks.push({ label: "at least one check ran", passed: false });
  const failures = checks.filter((c) => !c.passed).map((c) => c.label);
  if (thrown) failures.push("threw: " + thrown.message);
  return { system: sys.id, name: t.name, checks, failures, events, inputs, entities, thrown };
}

export function runSystemTests(eng: Engine, sys: SystemDef): DetailedResult[] {
  return sys.tests.map((t) => runOneTest(eng, sys, t));
}
