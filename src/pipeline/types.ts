// Pipeline types (spec 12). The Report shape is the contract between the
// worker, the client, Load and the dev panel.
import type { Manifest } from "../engine/manifest";

export type Stage = "Manifest" | "Compile" | "Module" | "Tests" | "World check" | "Shots" | "Load";
export const STAGES: Stage[] = ["Manifest", "Compile", "Module", "Tests", "World check", "Shots", "Load"];

export interface PipelineError {
  message: string;
  line?: number;
  sourceLine?: string;
  test?: string;
  checks?: { label: string; passed: boolean }[];
  events?: { tick: number; name: string; payload: unknown }[];
  denied?: { tick: number; system: string; op: string; code: string; msg: string }[];
  entities?: { type: string; pos: { x: number; y: number; area: string } | null; components: Record<string, unknown> }[];
}

export interface Report {
  ok: boolean;
  /** Stage reached: the failing stage, or "Load" when stages 1-6 passed. */
  stage: Stage;
  systemId: string | null;
  errors: PipelineError[];
  shots: { name: string; png: string }[];
  durationMs: number;
  manifestJson: string;
  source: string;
  /** Loaded system ids (base + AI) at check time; Load refuses if this changed. */
  loadedSystems: string[];
  stageMs: Partial<Record<Stage, number>>;
  /** Internal: parsed manifest and compiled bytes, carried from check to Load. */
  manifest?: Manifest;
  wasm?: Uint8Array;
  /** Non-fatal note, e.g. when the worker fell back to in-process stages. */
  note?: string;
}

export interface LoadedSystemBytes { manifest: Manifest; wasmB64: string }

export interface CheckRequest {
  manifestJson: string;
  source: string;
  /** Live world snapshot (engine serialize()) at check time. */
  snapshot: string;
  /** AI systems already loaded, in load order, with their module bytes. */
  loaded: LoadedSystemBytes[];
  baseUrl: string;
}

export type StageEvent = { stage: Stage; status: "start" | "pass" | "fail"; ms?: number };

/** Render a report as readable text (dev panel and, later, designer repairs). */
export function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(report.ok ? `OK — ${report.systemId ?? "?"} passed every stage` : `FAILED at ${report.stage} — ${report.systemId ?? "unknown system"}`);
  if (report.note) lines.push(`note: ${report.note}`);
  for (const e of report.errors) {
    lines.push(`- ${e.message}`);
    if (e.line !== undefined) lines.push(`  line ${e.line}: ${e.sourceLine ?? ""}`);
    if (e.test) lines.push(`  test: ${e.test}`);
    if (e.checks) for (const c of e.checks) lines.push(`  [${c.passed ? "pass" : "FAIL"}] ${c.label}`);
    if (e.denied?.length) for (const d of e.denied.slice(-10)) lines.push(`  denied: ${d.system} ${d.op} (${d.code}) ${d.msg}`);
    if (e.events?.length) for (const ev of e.events.slice(-10)) lines.push(`  event: ${ev.name} ${JSON.stringify(ev.payload)}`);
    if (e.entities?.length) for (const en of e.entities.slice(0, 20)) lines.push(`  entity: ${en.type} at ${en.pos ? `${en.pos.x},${en.pos.y}` : "held"} ${JSON.stringify(en.components)}`);
  }
  return lines.join("\n");
}
