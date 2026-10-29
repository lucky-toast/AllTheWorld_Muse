import * as ts from "typescript";
import { catalogGet } from "../engine/catalog";
import type { PipelineError } from "./types";

const FORBIDDEN = new Set(["window", "document", "fetch", "eval", "Function", "setTimeout", "setInterval", "setImmediate", "requestAnimationFrame", "globalThis", "process", "require", "localStorage", "sessionStorage", "XMLHttpRequest", "WebSocket", "alert"]);

function lineOf(sf: ts.SourceFile, node: ts.Node, source: string): PipelineError {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { message: "", line: line + 1, sourceLine: source.split("\n")[line]?.trim() };
}

/** Static rules stage: parse the source and reject anything outside the world API. */
export function staticCheck(source: string, loadedIds: string[], baseIds: string[]): { errors: PipelineError[]; systemId: string | null } {
  const errors: PipelineError[] = [];
  const sf = ts.createSourceFile("system.ts", source, ts.ScriptTarget.ES2022, true);
  // Parse errors are also static (clearer here than in Compile).
  for (const d of (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []) {
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    errors.push({ message: "parse error: " + ts.flattenDiagnosticMessageText(d.messageText, " "), line: line + 1, sourceLine: source.split("\n")[line]?.trim() });
  }
  let systemId: string | null = null;
  const err = (node: ts.Node, msg: string) => { const e = lineOf(sf, node, source); e.message = msg; errors.push(e); };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.getText(sf).replace(/["']/g, "");
      if (spec !== "engine/define") err(node, `import from "${spec}" is not allowed; the only allowed import is: import { defineSystem } from "engine/define"`);
    }
    if (ts.isImportEqualsDeclaration(node)) err(node, "import = declarations are not allowed");
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) err(node, "dynamic import() is not allowed");
    if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) {
      // Allow the identifier when it is a property name (x.fetch) — property accesses are caught below by name too, which is intended.
      err(node, `"${node.text}" is outside the world API and may not be used`);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "Math" && node.name.text === "random") err(node, "Math.random is not allowed; use world.rand()");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "pos") err(node, "assigning to e.pos is not allowed; use e.moveTo / e.lift / e.place");
    }
    // Entity sprite ids must exist in the catalog.
    if (ts.isPropertyAssignment(node) && node.name.getText(sf).replace(/["']/g, "") === "sprite" && ts.isStringLiteral(node.initializer)) {
      const id = node.initializer.text;
      if (!catalogGet(id)) err(node, `sprite "${id}" is not in the catalog (src/catalog.json)`);
    }
    // System id from defineSystem({ id: "..." })
    if (ts.isPropertyAssignment(node) && node.name.getText(sf).replace(/["']/g, "") === "id" && ts.isStringLiteral(node.initializer) && systemId === null) {
      const parent = node.parent;
      if (ts.isObjectLiteralExpression(parent)) systemId = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (systemId === null) errors.push({ message: "could not find a system id: the source must default-export defineSystem({ id: \"...\", ... })" });
  else {
    if (baseIds.includes(systemId)) errors.push({ message: `system id "${systemId}" belongs to a base system and may not be reused`, sourceLine: source.split("\n").find((l) => l.includes(`"${systemId}"`))?.trim() });
    else if (loadedIds.includes(systemId)) errors.push({ message: `system id "${systemId}" is already loaded`, sourceLine: source.split("\n").find((l) => l.includes(`"${systemId}"`))?.trim() });
  }
  // Determinism note: dedupe identical forbidden hits on one line (e.g. property name + access).
  const seen = new Set<string>(); const uniq = errors.filter((e) => { const k = e.message + "@" + (e.line ?? ""); if (seen.has(k)) return false; seen.add(k); return true; });
  return { errors: uniq, systemId };
}
