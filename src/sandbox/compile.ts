// Compile stage (spec 10.1): an AI system's AssemblyScript module goes through asc's
// programmatic API with in-memory files. The settings are fixed here and the model
// can't change them: imported memory capped at 16 MB, no optional features beyond the
// asc defaults the meter understands (mutable-globals, sign-extension,
// nontrapping-f2i, bulk-memory), the SDK as the only library, the start function
// exported so the host runs it under fuel, and abort/trace/seed redirected to the SDK
// so the only imports left are host.call and env.memory. Runs in a Web Worker and in
// Node (Vitest); the SDK sources come in through Vite's ?raw imports.
//
// asc is pinned to 0.28.20 in package.json (exact version, no range).
import asc from "assemblyscript/asc";
import sdkIndex from "../sdk/index.ts?raw";
import sdkInternal from "../sdk/internal.ts?raw";
import sdkHost from "../sdk/host.ts?raw";
import sdkGlue from "../sdk/glue.ts?raw";
import { LIMITS } from "../tuning";

/** The asc version these flags were checked against. */
export const ASC_VERSION = "0.28.20";

/** The user's module file name inside the compiler (errors name it). */
export const MODULE_FILE = "module.ts";
const ENTRY_FILE = "__atw_entry.ts";
const OUT_FILE = "module.wasm";

import { GLUE_EXPORTS, START_EXPORT } from "./abi";
export { GLUE_EXPORTS, START_EXPORT };

/** The fixed compiler settings (spec 10.1). */
export const ASC_FLAGS: readonly string[] = [
  "--optimizeLevel", "2", "--shrinkLevel", "1",
  "--runtime", "incremental",
  "--importMemory", "--noExportMemory",
  "--maximumMemory", String(LIMITS.memoryBytes / 65536),
  "--exportStart", START_EXPORT,
  "--use", "abort=~lib/sdk/glue/atwAbort",
  "--use", "trace=~lib/sdk/glue/atwTrace",
  "--use", "seed=~lib/sdk/glue/atwSeed",
  "--noUnsafe",
  "--noColors",
];

/** The in-memory files: the module, the entry that re-exports the glue, and the SDK as package "sdk". */
function files(source: string): Record<string, string> {
  return {
    [MODULE_FILE]: source,
    [ENTRY_FILE]: `export { ${GLUE_EXPORTS.join(", ")} } from "sdk/glue";\n`,
    "node_modules/sdk/index.ts": sdkIndex,
    "node_modules/sdk/internal.ts": sdkInternal,
    "node_modules/sdk/host.ts": sdkHost,
    "node_modules/sdk/glue.ts": sdkGlue,
  };
}

export interface CompileError {
  message: string;
  /** asc diagnostic code, e.g. 2304 for an unknown name. */
  code?: number;
  /** File inside the compiler: "module.ts" for the system's own code. */
  file?: string;
  line?: number;
  column?: number;
  /** The source line the error points at. */
  sourceLine?: string;
}
export type CompileResult =
  | { ok: true; wasm: Uint8Array<ArrayBuffer>; durationMs: number; warnings: CompileError[] }
  | { ok: false; errors: CompileError[]; durationMs: number };

interface Diagnostic { code: number; category: number; message: string; range: { start: number; source: { normalizedPath: string } | null } | null }

function toError(d: Diagnostic, fs: Record<string, string>): CompileError {
  const e: CompileError = { message: d.message, code: d.code };
  const path = d.range?.source?.normalizedPath;
  if (!d.range || !path) return e;
  const name = path.startsWith("~lib/sdk/") ? `node_modules/sdk/${path.slice(9)}` : path;
  const text = fs[name];
  e.file = path.replace(/^~lib\//, "");
  if (text === undefined) return e;
  const start = d.range.start;
  const before = text.slice(0, start);
  const lineStart = before.lastIndexOf("\n") + 1;
  let lineEnd = text.indexOf("\n", start); if (lineEnd < 0) lineEnd = text.length;
  e.line = before.split("\n").length;
  e.column = start - lineStart + 1;
  e.sourceLine = text.slice(lineStart, lineEnd).replace(/\r$/, "");
  return e;
}

/**
 * Answer asc's file lookups from the in-memory files. asc looks for package "sdk" in nested
 * node_modules folders that depend on its working directory (different in Node and in a
 * browser, and with backslashes on Windows), so any path ending in node_modules/sdk/<file> is the SDK's <file>.
 */
export function read(fs: Record<string, string>, name: string): string | null {
  name = name.replace(/\\/g, "/"); // asc builds package paths with path.join, so on Windows they use backslashes
  const sdk = /(?:^|\/)node_modules\/sdk\/([a-z]+\.ts)$/.exec(name);
  const key = sdk ? `node_modules/sdk/${sdk[1]}` : name;
  return Object.prototype.hasOwnProperty.call(fs, key) ? fs[key] : null;
}

/**
 * Compile a system's AssemblyScript source with the fixed settings. `manifest` is only read for
 * its id (the result names it); the Manifest stage checks it properly. Errors carry line and source text.
 */
export async function compileSystem(manifest: unknown, source: string): Promise<CompileResult & { systemId: string }> {
  const systemId = typeof (manifest as { id?: unknown })?.id === "string" ? (manifest as { id: string }).id : "?";
  const t0 = Date.now();
  const fs = files(source);
  const out: Record<string, Uint8Array<ArrayBuffer>> = {};
  const errors: CompileError[] = []; const warnings: CompileError[] = [];
  let res: { error: Error | null; stderr: { toString(): string } };
  try {
    res = await asc.main([MODULE_FILE, ENTRY_FILE, "--outFile", OUT_FILE, ...ASC_FLAGS], {
      readFile: (name: string) => read(fs, name),
      writeFile: (name: string, contents: Uint8Array | string) => { if (contents instanceof Uint8Array) out[name] = new Uint8Array(contents); },
      listFiles: () => [],
      reportDiagnostic: (d: unknown) => {
        const diag = d as Diagnostic;
        if (diag.category === 3) errors.push(toError(diag, fs)); else if (diag.category === 2) warnings.push(toError(diag, fs));
      },
    });
  } catch (e) {
    return { ok: false, systemId, errors: [{ message: `the compiler crashed: ${e instanceof Error ? e.message : String(e)}` }], durationMs: Date.now() - t0 };
  }
  const durationMs = Date.now() - t0;
  if (durationMs > LIMITS.compileMs) errors.push({ message: `compiling took ${durationMs} ms, over the ${LIMITS.compileMs} ms cap` });
  const wasm = out[OUT_FILE];
  if (res.error || errors.length || !wasm) {
    if (!errors.length) errors.push({ message: res.error?.message ?? (res.stderr.toString().trim() || "the compiler produced no module") });
    return { ok: false, systemId, errors, durationMs };
  }
  return { ok: true, systemId, wasm, durationMs, warnings };
}

/** One error as readable text: "module.ts:12:5 message" plus the source line. */
export function formatCompileError(e: CompileError): string {
  const where = e.line ? `${e.file ?? MODULE_FILE}:${e.line}:${e.column ?? 1} ` : "";
  return `${where}${e.message}${e.sourceLine !== undefined ? `\n  ${e.sourceLine.trim()}` : ""}`;
}
