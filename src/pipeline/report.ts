// A Report as readable text: the dev panel shows it, and the designer's repair message uses it.
import type { PipelineError, Report } from "./types";

const short = (v: unknown) => { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 157) + "..." : s; };

function errorText(e: PipelineError): string[] {
  const out = [`- ${e.message}`];
  if (e.line !== undefined && e.sourceLine !== undefined && !e.message.includes("\n")) out.push(`  line ${e.line}: ${e.sourceLine.trim()}`);
  if (e.checks?.length) out.push("  checks:", ...e.checks.map((c) => `    ${c.passed ? "pass" : "FAIL"}  ${c.label}`));
  if (e.denied?.length) out.push("  denied requests:", ...e.denied.slice(-20).map((d) => `    ${d.op}: ${d.code}: ${d.msg}`));
  if (e.events?.length) out.push(`  last events (${e.events.length}):`, ...e.events.slice(-20).map((ev) => `    tick ${ev.tick} ${ev.name} ${short(ev.payload)}`));
  if (e.entities?.length) out.push("  entities at the end:", ...e.entities.map((x) => `    ${x.type}#${x.id} at ${x.pos ? `(${x.pos.x}, ${x.pos.y}, ${x.pos.area})` : "(lifted)"} ${short(x.components)}`));
  return out;
}

export function reportText(r: Report): string {
  const head = r.ok
    ? `${r.systemId ?? "?"} passed${r.stage === "Load" ? " and loaded" : " every check"} in ${r.durationMs} ms`
    : `${r.systemId ?? "?"} failed at ${r.stage} after ${r.durationMs} ms`;
  const lines = [head];
  if (r.errors.length) lines.push("", "Errors:", ...r.errors.flatMap(errorText));
  if (r.log.length) lines.push("", "Log:", ...r.log.map((l) => `- ${l}`));
  return lines.join("\n");
}
