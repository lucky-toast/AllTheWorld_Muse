// A Report as readable text: the dev panel shows it, and the designer's repair message uses it.
import type { PipelineError, Report } from "./types";

const short = (v: unknown) => { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + "..." : s; };

/** Repeated under a report whose failure involves positions (a moved spawn, a blocked step, a taken tile). */
export const POSITIONS_NOTE = "Positions: the map, counts and coordinates in your prompt were captured when it was built and are only a rough guide. Tests run on a fresh map with every system's migrate, and migrate later runs on the live world as it is then. Find spots when the code runs (spaceFind, isFree, at, posOf, doorOf) and check against where things really are, never against fixed coordinates.";

/** Does this failure come down to where things are? */
function aboutPositions(e: PipelineError): boolean {
  return !!e.moved?.length || !!e.events?.some((ev) => ev.blockedBy)
    || !!e.denied?.some((d) => /isn't free|no free spot/.test(d.msg));
}

function errorText(e: PipelineError): string[] {
  const out = [`- ${e.message}`];
  if (e.line !== undefined && e.sourceLine !== undefined && !e.message.includes("\n")) out.push(`  line ${e.line}: ${e.sourceLine.trim()}`);
  if (e.checks?.length) out.push("  checks:", ...e.checks.map((c) => `    ${c.passed ? "pass" : "FAIL"}  ${c.label}`));
  if (e.denied?.length) out.push("  denied requests:", ...e.denied.slice(-20).map((d) => `    ${d.op}: ${d.code}: ${d.msg}`));
  const at = (p: { x: number; y: number; area: string }) => `(${p.x}, ${p.y}, ${p.area})`;
  if (e.moved?.length) out.push("  moved to the nearest free spot (read positions back with posOf):", ...e.moved.slice(-20).map((m) => `    ${m.op} ${m.what}: asked ${at(m.asked)}, placed ${at(m.placed)}${m.inTheWay ? `; in the way: ${m.inTheWay}` : ""}`));
  if (e.events?.length) out.push(`  last events (${e.events.length}):`, ...e.events.slice(-20).map((ev) => `    tick ${ev.tick} ${ev.name} ${short(ev.payload)}${ev.blockedBy ? ` (in the way: ${ev.blockedBy})` : ""}${ev.undone ? ` (undone, ${ev.undone})` : ""}`));
  if (e.entities?.length) out.push("  entities at the end:", ...e.entities.map((x) => `    ${x.type}#${x.id} at ${x.pos ? `(${x.pos.x}, ${x.pos.y}, ${x.pos.area})` : "(lifted)"} ${short(x.components)}`));
  return out;
}

export function reportText(r: Report): string {
  const head = r.ok
    ? `${r.systemId ?? "?"} passed${r.stage === "Load" ? " and loaded" : " every check"} in ${r.durationMs} ms`
    : `${r.systemId ?? "?"} failed at ${r.stage} after ${r.durationMs} ms`;
  const lines = [head];
  if (r.errors.length) lines.push("", "Errors:", ...r.errors.flatMap(errorText));
  if (!r.ok && r.errors.some(aboutPositions)) lines.push("", POSITIONS_NOTE);
  if (r.log.length) lines.push("", "Log:", ...r.log.map((l) => `- ${l}`));
  return lines.join("\n");
}
