// Stage 5, the World check (spec 12), kept apart from the other stages so the live game can run
// it again at Load (spec 13.1 with Phase 5b) without loading the compiler.
import { buildWorld } from "../world/map";
import { Engine } from "../engine/engine";
import { Host, type FaultEntry } from "../engine/host";
import { BASE_SYSTEMS } from "../systems/base";
import { ENGINE_OWNER } from "../engine/types";
import type { SystemDef } from "../engine/systems";
import type { AiSystemDef } from "../sandbox/module";
import { LIMITS } from "../tuning";
import type { PipelineError } from "./types";

/** A system to load into a host, and whether its migrate runs there. */
export interface Entry { def: SystemDef; migrate: boolean }

/** A host on `eng` with these systems loaded. `successors` (replaced id -> replacement) lets a replacement emit the events it inherited when the replaced system isn't loaded here. */
export function hostWith(eng: Engine, entries: Entry[], successors?: Map<string, string>): Host {
  const host = new Host(eng);
  for (const [a, b] of successors ?? []) host.successors.set(a, b);
  for (const e of entries) host.load(e.def, { migrate: e.migrate, announce: e.migrate });
  host.interactions.refresh(true);
  return host;
}
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const idOf = (def: SystemDef) => (def.manifest as { id: string }).id;
const DIRS = ["down", "up", "left", "right"] as const;
const STEP: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };


/** Type, pos and components of what `system` spawned, plus the player. */
export function entitiesOf(host: Host, system: string): NonNullable<PipelineError["entities"]> {
  const eng = host.eng; const out: NonNullable<PipelineError["entities"]> = [];
  const p = eng.player();
  for (const r of eng.entities.values()) {
    if (r !== p && eng.entityOwner.get(r.id) !== system) continue;
    out.push({ id: r.id, type: r.type, pos: r.pos ? { ...r.pos } : null, components: Object.fromEntries(r.comps) });
    if (out.length >= 50) break;
  }
  return out;
}

/** A host on a copy of a serialized world, with the base systems and these AI systems loaded (none migrate). */
export function worldCopy(world: string, loadedDefs: SystemDef[], successors?: Map<string, string>): Host {
  const h = hostWith(buildWorld(), [...BASE_SYSTEMS, ...loadedDefs].map((def) => ({ def, migrate: false })), successors);
  h.eng.restore(world);
  h.interactions.refresh(true);
  return h;
}

/**
 * Stage 5 again, at Load (spec 13.1 with Phase 5b): the player kept playing while the check ran,
 * so the World check runs once more on a copy of the live world as it is now. Returns its errors
 * (empty when it passed); overlaps and near-limit calls go to `log`.
 */
export function rerunWorldCheck(world: string, loadedDefs: SystemDef[], candidate: AiSystemDef, log: string[] = [], successors?: Map<string, string>): PipelineError[] {
  return worldCheck(() => worldCopy(world, loadedDefs, successors), [...BASE_SYSTEMS, ...loadedDefs], candidate, log, successors);
}

/**
 * Stage 5. Returns its errors (empty when it passed); overlaps and near-limit calls go to `log`.
 * Each world copy is released (Host.dispose) as soon as it's done, and the copy re-created from
 * the saved world is only built after the first is released, so the two never hold memories at once.
 */
export function worldCheck(liveCopy: () => Host, others: SystemDef[], candidate: AiSystemDef, log: string[], successors?: Map<string, string>): PipelineError[] {
  let w: Host;
  try { w = liveCopy(); } catch (e) { return [{ message: `the live world couldn't be copied: ${msgOf(e)}` }]; }
  let first: { errors: PipelineError[]; saved: string | null; successors: Map<string, string> };
  try { first = checkCopy(w, candidate, log); } finally { w.dispose(); }
  if (first.saved === null) return first.errors;
  return [...first.errors, ...checkRecreated(first.saved, others, candidate, new Map([...(successors ?? []), ...first.successors]))];
}

/** The modules can be re-created mid-run from the saved world and keep ticking. */
function checkRecreated(saved: string, others: SystemDef[], candidate: AiSystemDef, successors: Map<string, string>): PipelineError[] {
  const replaces = new Set((candidate.manifest as { replaces?: string[] }).replaces ?? []);
  const errors: PipelineError[] = [];
  let again: Host | null = null;
  try {
    again = hostWith(buildWorld(), [...others.filter((d) => !replaces.has(idOf(d))), candidate].map((def) => ({ def, migrate: false })), successors);
    again.eng.restore(saved); again.interactions.refresh(true);
    const g0 = again.faults.length;
    for (let i = 0; i < LIMITS.worldCheckResumeTicks; i++) again.tick();
    for (const f of again.faults.slice(g0)) errors.push({ message: `${faultText(f)} (after re-creating the modules from the saved world)` });
  } catch (e) { errors.push({ message: `the modules couldn't be re-created from the saved world: ${msgOf(e)}` }); }
  finally { again?.dispose(); }
  return errors;
}

const faultText = (f: FaultEntry) => (f.msg.startsWith(`${f.system}.`) ? f.msg : `${f.system}.${f.kind}: ${f.msg}`);

/**
 * The World check on the copy `w`: load the candidate, tick, walk, pick up and drop, invariants,
 * save and load. `saved` is the world as saved at the end, for the re-creation check, or null when
 * the check stopped early. The caller releases `w`.
 */
function checkCopy(w: Host, candidate: AiSystemDef, log: string[]): { errors: PipelineError[]; saved: string | null; successors: Map<string, string> } {
  const id = idOf(candidate);
  const eng = w.eng;
  // Succession (spec 11): loading the candidate into the copy retires what it replaces, and the
  // modules re-created from the saved world are the ones left after the swap (checkRecreated).
  const stop = (errors: PipelineError[]) => ({ errors, saved: null, successors: w.successors });
  try { w.load(candidate); }
  catch (e) { return stop([{ message: `loading into the current world failed: ${msgOf(e)}` }]); }
  for (let i = 1; i <= LIMITS.worldCheckTicks; i++) {
    const f0 = w.faults.length;
    w.tick();
    if (w.faults.length > f0) return stop(w.faults.slice(f0).map((f) => ({ message: `${faultText(f)} (tick ${i} of ${LIMITS.worldCheckTicks} on a copy of the world; the game kept running)` })));
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

  for (const o of w.overlaps) log.push(`overlap: ${o.systems.join(" and ")} both wrote entity ${o.entity} while handling ${o.event} (tick ${o.tick})`);
  for (const n of w.nearLimits) if (n.system === id) log.push(`near limit: ${n.system} used ${n.used} of its ${n.max} ${n.limit} in one call (tick ${n.tick})`);
  return { errors, saved, successors: new Map(w.successors) };
}
