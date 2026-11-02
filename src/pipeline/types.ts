// Pipeline types (spec 12). A Report is what checkSystem returns and loadChecked takes.

export const STAGES = ["Manifest", "Compile", "Module", "Tests", "World check", "Shots", "Load"] as const;
export type Stage = (typeof STAGES)[number];

/** One problem a stage found. Fields beyond `message` appear where they apply. */
export interface PipelineError {
  message: string;
  /** Line in module.ts (Compile). */
  line?: number;
  sourceLine?: string;
  /** The test that failed (Tests), as "<system>.test_<name>". */
  test?: string;
  /** Every named check the test ran. */
  checks?: { label: string; passed: boolean }[];
  /** The last events of the test. */
  events?: { tick: number; name: string; payload: Record<string, unknown> }[];
  /** Requests denied during the test. */
  denied?: { op: string; code: string; msg: string }[];
  /** Spawns and places (in migrate or the test) that the host moved off the asked spot, and what was in the way. */
  moved?: { op: string; what: string; asked: { x: number; y: number; area: string }; placed: { x: number; y: number; area: string }; inTheWay: string }[];
  /** What the system spawned, plus the player, at the end. */
  entities?: { id: number; type: string; pos: { x: number; y: number; area: string } | null; components: Record<string, unknown> }[];
}

/** One shot: a PNG data URL, or null when rendering wasn't possible (logged, never blocks). */
export interface ShotImage { name: string; png: string | null }

/** What a passed check carries to Load (never shown to the model). */
export interface Checked {
  manifestJson: string;
  source: string;
  /** The compiled, unmetered module. Load runs the Module stage on it again. */
  wasm: Uint8Array<ArrayBuffer>;
  /** Loaded system ids, in load order, when the check ran. */
  loaded: string[];
}

export interface Report {
  ok: boolean;
  /** The stage that failed, or the last stage reached ("Shots" after a passed check, "Load" after a load). */
  stage: Stage;
  systemId: string | null;
  errors: PipelineError[];
  shots: ShotImage[];
  durationMs: number;
  /** Things worth knowing that don't fail a stage: overlapping writes, near-limit calls, render failures. */
  log: string[];
  /** Milliseconds each finished stage took. */
  stageMs: Partial<Record<Stage, number>>;
  /** Present on a passed check. */
  checked?: Checked;
}

/** A loaded AI system as the worker needs it to rebuild the world: its manifest and compiled module. */
export interface LoadedModule { manifest: unknown; wasm: Uint8Array<ArrayBuffer> }

export interface CheckRequest {
  manifestJson: string;
  source: string;
  /** Loaded AI systems in load order (base systems are always there). */
  loaded: LoadedModule[];
  /** Ids of every loaded system, base ones included, in load order. */
  loadedIds: string[];
  /** The live world, serialized. */
  world: string;
  /** Replaced id -> the id that replaced it (spec 11), so a replaced id in `buildsOn` resolves. */
  successors?: Record<string, string>;
}

export type StageStatus = "start" | "pass" | "fail";
export interface StageEvent { stage: Stage; status: StageStatus; ms?: number }

/** Messages between the client and the pipeline worker. */
export type ToWorker =
  | { type: "check"; req: CheckRequest; baseUrl: string }
  | { type: "compile"; manifest: unknown; source: string };
export type FromWorker =
  | { type: "ready" }
  | { type: "stage"; event: StageEvent }
  /** The Tests stage is starting this test ("<system>.test_<name>"); the client times each one. */
  | { type: "test"; name: string }
  | { type: "done"; report: Report }
  | { type: "compiled"; ok: true; wasm: Uint8Array<ArrayBuffer> }
  | { type: "compiled"; ok: false; message: string }
  | { type: "error"; message: string };
