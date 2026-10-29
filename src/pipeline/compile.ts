import * as ts from "typescript";
import apiText from "../engine/api.d.ts?raw";
import type { PipelineError } from "./types";

const DEFINE_STUB = `import type { SystemDef, World, GameEvent } from "./api";
export interface SystemInput {
  id: string; why: string; buildsOn?: string[];
  contract?: SystemDef["contract"]; components?: SystemDef["components"]; entities?: SystemDef["entities"];
  migrate?: (world: World) => void;
  onTick?: (world: World, dt: number) => void;
  on?: Record<string, (ev: GameEvent, world: World) => void>;
  tests?: SystemDef["tests"]; shots?: SystemDef["shots"];
}
export declare function defineSystem(def: SystemInput): SystemDef;
`;
// Missing-lib noise when running with noLib (no DOM/ES lib files inside a worker).
const IGNORE_CODES = new Set([2304, 2318, 2580, 2583, 2584, 6053, 2688, 7016, 2591]);

/** Compile stage: type-check against src/engine/api.d.ts, then transpile. */
export function compileCheck(source: string): { errors: PipelineError[]; js: string } {
  const files = new Map<string, string>([
    ["/system.ts", source],
    ["/engine/api.d.ts", apiText as unknown as string],
    ["/engine/define.d.ts", DEFINE_STUB],
  ]);
  const host: ts.CompilerHost = {
    getSourceFile: (name, lang) => {
      const text = files.get(name) ?? (name.startsWith("/lib") ? "" : undefined);
      return text === undefined ? undefined : ts.createSourceFile(name, text, lang, true);
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (n) => files.has(n) || n.startsWith("/lib"),
    readFile: (n) => files.get(n),
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "/lib.d.ts",
    resolveModuleNames: (names, containing) => names.map((name) => {
      if (name === "engine/define") return { resolvedFileName: "/engine/define.d.ts" };
      if (name === "engine/api" || name === "./api") return { resolvedFileName: "/engine/api.d.ts" };
      void containing;
      return { resolvedFileName: "/unresolved/" + name };
    }),
  };
  const program = ts.createProgram(["/system.ts"], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noLib: true, skipLibCheck: true, noEmit: true, types: [],
  }, host);
  const lines = source.split("\n");
  const errors: PipelineError[] = [];
  const API_TYPES = /'(World|Entity|Sim|CatalogEntry|SystemDef|SystemTest|SystemShot|Pos|Dir|GameEvent)'/;
  const pushDiag = (d: ts.Diagnostic) => {
    if (IGNORE_CODES.has(d.code)) return;
    const rawMsg = ts.flattenDiagnosticMessageText(d.messageText, " ");
    // With noLib (no ES/DOM lib files inside a worker), ordinary array/string
    // operations report missing-lib noise. The Compile stage exists to catch
    // misuse of the world API, so keep syntactic errors plus diagnostics that
    // name an api.d.ts type (e.g. Property 'spawnAt' does not exist on type 'World').
    const isSyntax = d.category === ts.DiagnosticCategory.Error && d.code < 2000;
    if (!isSyntax && !API_TYPES.test(rawMsg)) return;
    const msg = rawMsg;
    if (d.file && d.start !== undefined && d.file.fileName === "/system.ts") {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      errors.push({ message: `TS${d.code}: ${msg}`, line: line + 1, sourceLine: lines[line]?.trim() });
    } else if (d.file?.fileName === "/system.ts" || !d.file) {
      errors.push({ message: `TS${d.code}: ${msg}` });
    }
  };
  program.getSyntacticDiagnostics().forEach(pushDiag);
  program.getSemanticDiagnostics().forEach(pushDiag);
  // Transpile for execution.
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: "system.ts" });
  return { errors, js: out.outputText };
}
