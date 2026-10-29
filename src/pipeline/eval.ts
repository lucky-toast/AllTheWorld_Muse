import * as ts from "typescript";
import { defineSystem } from "../engine/define";
import type { SystemDef } from "../engine/api";

/** Transpile system source to CommonJS JS text (no type-check; see compile.ts). */
export function transpile(source: string): { js: string; errors: string[] } {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true, fileName: "system.ts",
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  return { js: out.outputText, errors };
}

/** Evaluate transpiled system JS with only defineSystem available. Throws on any problem. */
export function evalTranspiled(js: string): SystemDef {
  const module = { exports: {} as Record<string, unknown> };
  const requireFn = (spec: string): unknown => {
    if (spec === "engine/define") return { defineSystem };
    throw new Error(`import of "${spec}" is not allowed; only "engine/define" may be imported`);
  };
  const fn = new Function("module", "exports", "require", js);
  fn(module, module.exports, requireFn);
  const def = (module.exports as { default?: unknown }).default;
  if (!def || typeof def !== "object" || typeof (def as SystemDef).id !== "string") throw new Error("system source must default-export the result of defineSystem({ id, ... })");
  return def as SystemDef;
}

export function evalSystem(source: string): SystemDef {
  const { js, errors } = transpile(source);
  if (errors.length) throw new Error(errors.join("; "));
  return evalTranspiled(js);
}
