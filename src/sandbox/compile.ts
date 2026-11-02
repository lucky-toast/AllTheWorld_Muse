// AssemblyScript compilation (spec 10.1), in memory, for a Web Worker or Node (Vitest).
// Pinned compiler: assemblyscript 0.28.20 (devDependency, exact version).
// Fixed flags, which the model cannot change:
//   module.ts --outFile module.wasm
//   --importMemory        memory comes from the host as env.memory
//   --maximumMemory 256   256 pages = 16 MB cap (spec 15)
//   --exportRuntime       the ABI needs __new/__pin/__unpin for string passing
//   --runtime incremental pinned runtime so SDK strings can be collected
//   --noExportMemory      the only memory is the imported one
//   --optimizeLevel 0 --shrinkLevel 0   deterministic output for the meter
//   --disable simd        no SIMD; threads and other features stay off by default
//   --use abort=~lib/sdk/index/sdkAbort --use trace=~lib/sdk/index/sdkTrace --use seed=~lib/sdk/index/sdkSeed
//                         so the only imports left are host.call and env.memory
//   --noColors
// The SDK (src/sdk/index.ts) is the only library: "sdk" resolves to it in the
// in-memory file system below, and nothing else is readable.
import * as asc from "assemblyscript/asc";
import sdkSource from "../sdk/index.ts?raw";
import { TUNING } from "../tuning";

export const ASC_VERSION = "0.28.20";
export const ASC_FLAGS: string[] = [
  "--importMemory",
  "--maximumMemory", "256",
  "--exportRuntime",
  "--runtime", "incremental",
  "--noExportMemory",
  "--optimizeLevel", "0",
  "--shrinkLevel", "0",
  "--disable", "simd",
  "--use", "abort=~lib/sdk/index/sdkAbort",
  "--use", "trace=~lib/sdk/index/sdkTrace",
  "--use", "seed=~lib/sdk/index/sdkSeed",
  "--noColors",
];

export interface CompileError { message: string; line?: number; sourceLine?: string }
export type CompileResult =
  | { ok: true; bytes: Uint8Array; ascVersion: string; flags: string[]; durationMs: number }
  | { ok: false; errors: CompileError[]; ascVersion: string; flags: string[]; durationMs: number };

type AscMain = (
  args: string[],
  options: {
    stdout: unknown; stderr: unknown;
    readFile: (name: string) => string | null;
    writeFile: (name: string, contents: Uint8Array | string) => void;
    listFiles: (dirname: string) => string[];
  },
) => Promise<{ error: Error | null }>;

function parseErrors(stderr: string, source: string, sdk: string): CompileError[] {
  const errors: CompileError[] = [];
  const sourceLines = source.split("\n");
  const sdkLines = sdk.split("\n");
  let pending = "";
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.trim();
    const loc = line.match(/in (module\.ts|~lib\/sdk\/index\.ts)\((\d+),(\d+)\)/);
    if (loc) {
      const lineNo = Number(loc[2]);
      const lines = loc[1] === "module.ts" ? sourceLines : sdkLines;
      errors.push({ message: pending || line, line: lineNo, sourceLine: lines[lineNo - 1]?.trim() });
      pending = "";
      continue;
    }
    if (/^(ERROR|FAILURE)/.test(line)) { pending = line; continue; }
    if (line && !/^[│└~^ ]*$/.test(line) && pending === "" && errors.length === 0 && /error/i.test(line)) pending = line;
  }
  if (errors.length === 0) {
    const first = stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    errors.push({ message: first ?? "compilation failed" });
  }
  // Attach the source line to errors that named a line in the message itself.
  for (const e of errors) {
    if (e.line === undefined) {
      const m = e.message.match(/\((\d+),(\d+)\)/);
      if (m) { e.line = Number(m[1]); e.sourceLine = sourceLines[e.line - 1]?.trim(); }
    }
  }
  return errors;
}

/** Compile one system's AssemblyScript source against the SDK. The manifest is accepted for stage parity; compilation does not read it. */
export async function compileSystem(_manifest: unknown, source: string, opts?: { sdkSource?: string }): Promise<CompileResult> {
  const started = Date.now();
  const sdk = opts?.sdkSource ?? sdkSource;
  const files = new Map<string, Uint8Array | string>();
  let stderrText = "";
  const stdout = (asc as unknown as { createMemoryStream: () => { write: (s: string) => void; toString: () => string } }).createMemoryStream();
  const stderr = { write: (s: string) => { stderrText += s; } };
  const readFile = (name: string): string | null => {
    const key = name.replace(/\\/g, "/");
    if (key === "module.ts") return source;
    if (key === "__sdkhost.ts") return `import { player } from "sdk";\n// Keeps host.call imported even in a module that makes no requests itself.\nexport function __sdkHostAlive(): i32 { return player(); }\n`;
    if (key.includes("sdk")) return sdk;
    return null;
  };
  const writeFile = (name: string, contents: Uint8Array | string) => { files.set(name.replace(/\\/g, "/"), contents); };
  const main = (asc as unknown as { main: AscMain }).main;
  let result: { error: Error | null };
  try {
    result = await main(["module.ts", "__sdkhost.ts", "--outFile", "module.wasm", ...ASC_FLAGS], {
      stdout, stderr, readFile, writeFile, listFiles: () => [],
    });
  } catch (error) {
    return { ok: false, errors: [{ message: error instanceof Error ? error.message : String(error) }], ascVersion: ASC_VERSION, flags: [...ASC_FLAGS], durationMs: Date.now() - started };
  }
  const durationMs = Date.now() - started;
  if (durationMs > TUNING.limits.compileTimeMs) {
    return { ok: false, errors: [{ message: `compile took ${durationMs} ms, over the ${TUNING.limits.compileTimeMs} ms cap` }], ascVersion: ASC_VERSION, flags: [...ASC_FLAGS], durationMs };
  }
  const wasm = files.get("module.wasm");
  if (result.error || !wasm) {
    return { ok: false, errors: parseErrors(stderrText || (result.error?.message ?? ""), source, sdk), ascVersion: ASC_VERSION, flags: [...ASC_FLAGS], durationMs };
  }
  const bytes = typeof wasm === "string" ? new TextEncoder().encode(wasm) : wasm;
  return { ok: true, bytes, ascVersion: ASC_VERSION, flags: [...ASC_FLAGS], durationMs };
}
