// The SDK reference the designer reads ({{API}} in src/ai/prompts/designer.md): src/sdk/index.ts
// with every function, method, accessor and constructor body left out, and with what a system
// can't use (imports, private and _-named members, non-exported declarations) removed.
// Signatures, doc comments, the file's header notes and section rules stay, so it is a full
// reference at about two thirds of the size.
//
// It is built from the real file whenever it is imported as `sdk/index.ts?sdkref`, by the Vite
// plugin below (dev, build and tests all go through Vite), so it can never drift from the SDK.
// AssemblyScript parses as TypeScript for this purpose: the TypeScript parser only reads its shape.
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Plugin } from "vite";

export const SDKREF_QUERY = "?sdkref";

/** The reference text for an SDK source file. */
export function sdkReference(source: string): string {
  const sf = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const exported = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const hidden = (n: ts.Node) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);

  // A body becomes ";": from the end of the signature (trailing spaces included) to the body's end.
  const dropBody = (body: ts.Node) => {
    let start = body.getStart();
    while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
    edits.push({ start, end: body.getEnd(), text: ";" });
  };
  const visitMembers = (members: ts.NodeArray<ts.ClassElement>) => {
    for (const m of members) {
      // A private member, or one named with a leading _ (the SDK's own plumbing), goes with the
      // comments that lead into it.
      const internal = m.name !== undefined && ts.isIdentifier(m.name) && m.name.text.startsWith("_");
      if (hidden(m) || internal) { edits.push({ start: m.getFullStart(), end: m.getEnd(), text: "" }); continue; }
      if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m)) && m.body) dropBody(m.body);
    }
  };

  for (const st of sf.statements) {
    // Top-level statements keep their leading comments (the file header sits before the import).
    if (!exported(st)) { edits.push({ start: st.getStart(), end: st.getEnd(), text: "" }); continue; }
    if (ts.isFunctionDeclaration(st) && st.body) dropBody(st.body);
    else if (ts.isClassDeclaration(st)) visitMembers(st.members);
  }

  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Vite plugin: `import ref from "../sdk/index.ts?sdkref"` gives the reference text as a string. */
export function sdkRefPlugin(): Plugin {
  return {
    name: "atw-sdkref",
    load(id) {
      const [file, query] = id.split("?");
      if (`?${query}` !== SDKREF_QUERY) return null;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(sdkReference(readFileSync(file, "utf8")))};`;
    },
  };
}
