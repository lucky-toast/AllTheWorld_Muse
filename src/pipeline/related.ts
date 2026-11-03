// Which loaded AI systems a new one could affect, so the Tests stage re-runs only their tests
// (base systems' tests always run, and the World check still runs everything together).
//
// Two systems are related when one builds on the other (directly or through a chain), when the
// new one replaces something the other builds on, or when they share a specific name: an entity
// type, tag, component, event, interaction target or any identifier-like string literal in their
// sources. Common words every system uses (directions, phases, the base systems' own vocabulary)
// don't count, since they would make everything related. When in doubt, a system counts as related:
// a test that runs for nothing only costs time, while a skipped one could miss a break.
import type { Manifest } from "../engine/manifest";

/** One system as the relatedness check sees it. `source` null means unknown: always related. */
export interface SystemFacts { manifest: Manifest; source: string | null }

/** Names too common to link two systems. */
const COMMON = new Set([
  // the base systems' vocabulary
  "sdk", "none", "player", "item", "solid", "pushable", "slippery", "facing", "held", "sprite", "light", "moveDelay",
  "movement", "carry", "push", "daynight",
  "player.moved", "player.blocked", "player.traveled", "item.picked", "item.dropped", "interaction.performed",
  "time.phase", "time.dawn", "time.daytime", "time.dusk", "time.night", "time.newDay", "time.hour", "time.jumped",
  "system.loaded", "system.unloaded",
  // directions, keys, phases, common anims and fields
  "up", "down", "left", "right", "e", "q", "escape", "borrow", "freeze",
  "dawn", "day", "dusk", "night", "idle", "walk", "run",
  "x", "y", "w", "h", "id", "area", "pos", "type", "tags", "name", "phase", "radius", "color", "strength", "flicker",
  "anim", "frame", "z", "offset", "target", "dir", "from", "to", "value", "count", "ticks",
]);

const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
const NAME = /^[a-z][a-z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/** The source without its test_ functions (and shot_ ones, in systems built before shots were removed): what the system does when it runs. */
export function withoutTests(source: string): string {
  let out = ""; let i = 0;
  const start = /export\s+function\s+(?:test|shot)_\w*\s*\(/g;
  for (let m = start.exec(source); m; m = start.exec(source)) {
    if (m.index < i) continue;
    out += source.slice(i, m.index);
    let j = source.indexOf("{", m.index); if (j < 0) { i = source.length; break; }
    let depth = 0;
    for (; j < source.length; j++) { const c = source[j]; if (c === "{") depth++; else if (c === "}" && --depth === 0) { j++; break; } }
    i = j; start.lastIndex = j;
  }
  return out + source.slice(i);
}

/**
 * The specific names a system uses: its manifest's names and its source's identifier-like string
 * literals. With `runtimeOnly`, its tests' literals are left out: a new system can only affect others
 * through what it does when it runs, while another system's tests can be broken through any name they use.
 */
export function namesOf(s: SystemFacts, runtimeOnly = false): Set<string> {
  const m = s.manifest; const out = new Set<string>();
  const add = (n: string | undefined) => { if (n && NAME.test(n) && !COMMON.has(n)) out.add(n); };
  for (const [type, t] of Object.entries(m.entities)) { add(type); t.tags.forEach(add); }
  Object.keys(m.components).forEach(add);
  Object.keys(m.emits).forEach(add);
  m.reactions.forEach(add);
  for (const i of m.interactions) { add(i.target); add(i.held); }
  const src = s.source && runtimeOnly ? withoutTests(s.source) : s.source;
  if (src) for (const lit of src.matchAll(LITERAL)) add(lit[1] ?? lit[2]);
  return out;
}

/** Ids `id` builds on, directly or through a chain, among `all`. */
function dependencies(id: string, all: Map<string, Manifest>): Set<string> {
  const seen = new Set<string>(); const todo = [...(all.get(id)?.buildsOn ?? [])];
  while (todo.length) { const d = todo.pop()!; if (seen.has(d)) continue; seen.add(d); todo.push(...(all.get(d)?.buildsOn ?? [])); }
  return seen;
}

/**
 * For each loaded AI system (`kept`, in load order), whether the new system could affect it, and why.
 * `skipped` lists the rest with nothing shared.
 */
export function relatedSystems(candidate: SystemFacts, kept: SystemFacts[]): { related: { id: string; why: string }[]; skipped: string[] } {
  const all = new Map([candidate, ...kept].map((s) => [s.manifest.id, s.manifest]));
  const mine = namesOf(candidate, true);
  const myDeps = dependencies(candidate.manifest.id, all);
  const related: { id: string; why: string }[] = []; const skipped: string[] = [];
  for (const other of kept) {
    const id = other.manifest.id;
    const why = (() => {
      if (other.source === null) return "its source isn't known";
      if (myDeps.has(id)) return `${candidate.manifest.id} builds on it`;
      if (dependencies(id, all).has(candidate.manifest.id)) return `it builds on ${candidate.manifest.id}`;
      const rep = candidate.manifest.replaces.find((r) => other.manifest.buildsOn.includes(r));
      if (rep) return `it builds on ${rep}, which ${candidate.manifest.id} replaces`;
      const theirs = namesOf(other);
      const shared = [...mine].filter((n) => theirs.has(n) || n === id);
      if (theirs.has(candidate.manifest.id)) shared.unshift(candidate.manifest.id);
      return shared.length ? `shares ${shared.slice(0, 4).join(", ")}` : null;
    })();
    if (why) related.push({ id, why }); else skipped.push(id);
  }
  return { related, skipped };
}
