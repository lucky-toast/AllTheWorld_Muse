import type { SystemDef } from "../engine/api";
import { BASE_SYSTEMS } from "../systems/base/index";
import { buildArena, buildWorld } from "../world/map";
import { makeSim } from "../engine/sim";
import { runOneTest, type DetailedResult } from "../engine/testrun";
import { staticCheck } from "./static";
import { compileCheck } from "./compile";
import { evalTranspiled } from "./eval";
import { TUNING } from "../tuning";
import { footprintTiles } from "../engine/catalog";
import type { CheckRequest, PipelineError, Report, Stage } from "./types";

export const BASE_IDS = BASE_SYSTEMS.map((s) => s.id);
export type ShotRenderer = (eng: import("../engine/engine").Engine, shot: SystemDef["shots"][number], world: import("../engine/api").World) => Promise<string>;

function errFromTest(r: DetailedResult): PipelineError {
  return {
    message: `test "${r.name}" (${r.system}) failed: ${r.failures.join("; ")}`,
    test: r.name, checks: r.checks, events: r.events, inputs: r.inputs, entities: r.entities, thrown: r.thrown,
  };
}

export async function runCheck(req: CheckRequest, opts: {
  onStage?: (stage: Stage, status: "start" | "pass" | "fail", ms?: number) => void;
  renderShot: ShotRenderer;
}): Promise<Report> {
  const started = performance.now();
  const stageMs: Report["stageMs"] = {};
  const report: Report = { ok: false, stage: "Static rules", systemId: null, errors: [], shots: [], durationMs: 0, source: req.source, loadedSystems: req.loaded.map((l) => l.id), stageMs };
  const begin = (s: Stage) => { report.stage = s; opts.onStage?.(s, "start"); return performance.now(); };
  const pass = (s: Stage, t: number) => { stageMs[s] = Math.round(performance.now() - t); opts.onStage?.(s, "pass", stageMs[s]); };
  const fail = (s: Stage, t: number, errors: PipelineError[]) => { stageMs[s] = Math.round(performance.now() - t); report.errors = errors; opts.onStage?.(s, "fail", stageMs[s]); report.durationMs = Math.round(performance.now() - started); return report; };

  // ---- Static rules ----
  let t = begin("Static rules");
  const stat = staticCheck(req.source, req.loaded.map((l) => l.id), BASE_IDS);
  report.systemId = stat.systemId;
  if (stat.errors.length) return fail("Static rules", t, stat.errors);
  pass("Static rules", t);

  // ---- Compile ----
  t = begin("Compile");
  const comp = compileCheck(req.source);
  if (comp.errors.length) return fail("Compile", t, comp.errors);
  let def: SystemDef;
  try { def = evalTranspiled(comp.js); } catch (e) { return fail("Compile", t, [{ message: "compiled system could not be evaluated: " + (e as Error).message }]); }
  report.systemId = def.id;
  pass("Compile", t);

  const loadInto = (eng: import("../engine/engine").Engine, withCandidate: boolean) => {
    for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    for (const l of req.loaded) eng.loadSystem(evalSource(l.source));
    if (withCandidate) eng.loadSystem(def);
  };
  const evalSource = (src: string): SystemDef => evalTranspiled(compileCheck(src).js);

  // ---- Sandbox run ----
  t = begin("Sandbox run");
  let sandboxEng!: ReturnType<typeof buildWorld>;
  const contractLogs: { sys: string; name: string }[] = [];
  const handledLogs: { sys: string; name: string }[] = [];
  try {
    sandboxEng = buildWorld(); loadInto(sandboxEng, false); sandboxEng.restore(req.snapshot); sandboxEng.loadSystem(def);
    for (let i = 0; i < TUNING.pipeline.sandboxTicks; i++) {
      const s = performance.now(); sandboxEng.tick();
      const dt = performance.now() - s;
      if (dt > TUNING.pipeline.tickBudgetMs) return fail("Sandbox run", t, [{ message: `tick ${i} took ${dt.toFixed(1)}ms, over the ${TUNING.pipeline.tickBudgetMs}ms tick budget` }]);
    }
  } catch (e) {
    return fail("Sandbox run", t, [{ message: "sandbox run threw: " + (e as Error).message, thrown: sandboxEng?.thrownInfo ?? { system: def.id, handler: "onTick/migrate", message: (e as Error).message } }]);
  }
  contractLogs.push(...sandboxEng.emitLog); handledLogs.push(...sandboxEng.handledLog);
  pass("Sandbox run", t);

  // ---- Tests ----
  t = begin("Tests");
  const detailed: DetailedResult[] = [];
  try {
    for (const test of def.tests) { const eng = buildWorld(); loadInto(eng, true); detailed.push(runOneTest(eng, def, test)); contractLogs.push(...eng.emitLog); handledLogs.push(...eng.handledLog); }
    for (const base of BASE_SYSTEMS) for (const test of base.tests) { const eng = buildArena(); loadInto(eng, true); detailed.push(runOneTest(eng, base, test)); contractLogs.push(...eng.emitLog); handledLogs.push(...eng.handledLog); }
  } catch (e) { return fail("Tests", t, [{ message: "test run threw: " + (e as Error).message }]); }
  const failedTests = detailed.filter((r) => r.failures.length);
  if (failedTests.length) return fail("Tests", t, failedTests.map(errFromTest));
  pass("Tests", t);

  // ---- Invariants ----
  t = begin("Invariants");
  const invErrors: PipelineError[] = [];
  for (const e of contractLogs) {
    if (e.sys !== def.id) continue;
    if (!(e.name in def.contract.emits)) invErrors.push({ message: `event "${e.name}" was emitted by "${def.id}" but is not listed in its contract emits` });
  }
  for (const h of handledLogs) {
    if (h.sys !== def.id) continue;
    const claimed = def.contract.claims.map((c) => c.split(":")[0].trim());
    if (!claimed.includes(h.name)) invErrors.push({ message: `input "${h.name}" was set handled by "${def.id}" but is not listed in its contract claims` });
  }
  // World invariants on the sandbox world after its run.
  try {
    const w = sandboxEng.world();
    if (!sandboxEng.player()) invErrors.push({ message: "invariant failed: the player no longer exists after the run", test: "invariants" });
    for (const ent of [...sandboxEng.entities.values()]) {
      if (!ent.pos) continue;
      const spriteId = sandboxEng.spriteIdOf(ent);
      for (const tile of footprintTiles(spriteId, ent.pos.x, ent.pos.y)) {
        if (!sandboxEng.isWalkable(tile.x, tile.y)) { invErrors.push({ message: `invariant failed: entity "${ent.type}" at ${ent.pos.x},${ent.pos.y} has a footprint tile on non-walkable terrain at ${tile.x},${tile.y}`, test: "invariants" }); break; }
      }
    }
    if (!sandboxEng.validateOccupancy()) invErrors.push({ message: "invariant failed: occupancy lookup does not match entity positions", test: "invariants" });
    JSON.parse(sandboxEng.serialize()); void w;
  } catch (e) { invErrors.push({ message: "invariant failed: world no longer serializes: " + (e as Error).message, test: "invariants" }); }
  // Replay: base behaviour must be identical with and without the new system.
  const replay = (withCandidate: boolean): { outcome: string; detail: DetailedResult | null } => {
    const eng = buildWorld(); loadInto(eng, withCandidate);
    const w = eng.world(); const sim = makeSim(eng, w);
    eng.beginCapture();
    sim.teleport(11, 11); sim.face("up"); sim.interact(); // pick up the branch
    sim.face("down"); sim.interact(); // drop it
    sim.face("down"); sim.interact(); // pick it up again
    sim.teleport(11, 8); sim.face("right"); sim.walk("right"); // push the log
    sim.teleport(7, 8); sim.face("up"); sim.interact(); // use the stump while holding the branch
    const p = eng.player()!;
    const held = p.get<{ id: number }>("held");
    const outcome = JSON.stringify({
      events: eng.capEvents.filter((e) => ["player.moved", "player.blocked", "item.picked", "item.dropped", "entity.bumped", "entity.used"].includes(e.name)).map((e) => [e.name, e.payload]),
      player: p.pos, facing: p.get("facing"), heldType: held ? eng.recById(held.id)?.type ?? null : null,
      branches: eng.query("item").filter((e) => e.type === "branch").map((e) => e.pos).sort(),
      log: eng.query("pushable").find((e) => e.type === "log_fallen")?.pos,
    });
    const detail: DetailedResult = { system: def.id, name: "replay", checks: [{ label: "base behaviour identical with and without the new system", passed: true }], failures: [], events: eng.capEvents.slice(-100), inputs: eng.capInputs, entities: eng.capSpawned.map((id) => eng.entitySummary(id)).filter(Boolean) as DetailedResult["entities"], thrown: eng.thrownInfo };
    const ps = eng.entitySummary(p.id); if (ps) detail.entities.push(ps);
    eng.endCapture();
    return { outcome, detail };
  };
  try {
    const base = replay(false); const cand = replay(true);
    if (base.outcome !== cand.outcome) {
      const d = cand.detail!; d.checks[0].passed = false; d.failures = ["replay outcome differs from the base game"];
      invErrors.push({ message: "invariant failed (replay): base systems behave differently with the new system loaded", test: "replay", checks: d.checks, events: d.events, inputs: d.inputs, entities: d.entities, thrown: d.thrown });
    }
  } catch (e) { invErrors.push({ message: "invariant replay threw: " + (e as Error).message, test: "replay" }); }
  if (invErrors.length) {
    // Attach the last test's detail to contract mismatches so an AI can see the run.
    const seenMsg = new Set<string>(); const uniq = invErrors.filter((e) => { if (seenMsg.has(e.message)) return false; seenMsg.add(e.message); return true; });
    invErrors.length = 0; invErrors.push(...uniq);
    const last = detailed[detailed.length - 1];
    for (const e of invErrors) if (!e.test && last) { e.test = last.name; e.checks = last.checks; e.events = last.events; e.inputs = last.inputs; e.entities = last.entities; }
    return fail("Invariants", t, invErrors);
  }
  pass("Invariants", t);

  // ---- Shots ----
  t = begin("Shots");
  try {
    for (const shot of def.shots) {
      const eng = buildWorld(); loadInto(eng, true);
      const loaded = eng.systems.find((s) => s.def.id === def.id)!;
      const w = eng.facade(loaded); const sim = makeSim(eng, w);
      try { shot.setup?.(w, sim); for (let i = 0; i < (shot.ticks ?? 0); i++) eng.tick(); }
      catch (e) { return fail("Shots", t, [{ message: `shot "${shot.name}" setup threw: ${(e as Error).message}`, test: shot.name, thrown: eng.thrownInfo ?? { system: def.id, handler: "shot setup", message: (e as Error).message } }]); }
      const png = await opts.renderShot(eng, shot, w);
      report.shots.push({ name: shot.name, png });
    }
  } catch (e) { return fail("Shots", t, [{ message: "shots stage threw: " + (e as Error).message }]); }
  pass("Shots", t);

  report.ok = true; report.stage = "Load"; report.durationMs = Math.round(performance.now() - started);
  return report;
}
