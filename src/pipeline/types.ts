export type Stage = "Static rules" | "Compile" | "Sandbox run" | "Tests" | "Invariants" | "Shots" | "Load";
export const STAGES: Stage[] = ["Static rules", "Compile", "Sandbox run", "Tests", "Invariants", "Shots", "Load"];

export interface PipelineError {
  message: string;
  line?: number;
  sourceLine?: string;
  test?: string;
  checks?: { label: string; passed: boolean }[];
  events?: { tick: number; name: string; payload: Record<string, unknown> }[];
  inputs?: { name: string; handledBy: string; receivedBy: string[] }[];
  entities?: { type: string; pos: { x: number; y: number } | null; components: Record<string, unknown> }[];
  thrown?: { system: string; handler: string; message: string } | null;
}

export interface Report {
  ok: boolean;
  stage: Stage; // stage reached (failing stage, or "Load" when fully passed/loaded)
  systemId: string | null;
  errors: PipelineError[];
  shots: { name: string; png: string }[];
  durationMs: number;
  source: string; // exact source that was checked
  loadedSystems: string[]; // loaded system ids at check time
  stageMs?: Partial<Record<Stage, number>>;
}

export interface LoadedSystemSource { id: string; source: string; buildsOn: string[] }
export interface CheckRequest {
  source: string;
  loaded: LoadedSystemSource[]; // runtime systems already loaded (not base)
  snapshot: string; // live world snapshot at check time
  baseUrl: string;
}
export type StageEvent = { stage: Stage; status: "start" | "pass" | "fail"; ms?: number };
