// The SDK reference in the designer prompt (devserver/sdkref.ts): the real SDK with bodies and
// internals left out, every export kept.
import { readFileSync } from "node:fs";
import { sdkReference } from "../devserver/sdkref";

// Read with \n line endings, as a Windows checkout may have \r\n.
const sdk = readFileSync("src/sdk/index.ts", "utf8").replace(/\r\n?/g, "\n");
const ref = sdkReference(sdk);
/** Exported names in a source text: functions, classes and consts. */
const exportsOf = (text: string) => [...text.matchAll(/^export (?:function|class|const|let) (\w+)/gm)].map((m) => m[1]);

describe("SDK reference", () => {
  test("keeps every export of the real SDK, in order, at about two thirds of its size", () => {
    expect(exportsOf(ref)).toEqual(exportsOf(sdk));
    expect(ref.length).toBeLessThan(sdk.length * 0.75);
  });
  test("keeps the header notes and the doc comments, and leaves out bodies, imports and internals", () => {
    expect(ref.startsWith(sdk.split("\n")[0])).toBe(true);
    expect(ref).toContain("// Module exports you may write");
    expect(ref).toContain("/** A parsed JSON value.");
    expect(ref).not.toMatch(/^import /m);
    expect(ref).not.toContain("./internal");
    expect(ref).not.toMatch(/\bprivate\b/);
    expect(ref).not.toContain("NO_ITEMS");
    expect(ref).not.toMatch(/^\s+_\w+/m);
    // Every function, method and accessor ends at its signature.
    for (const line of ref.split("\n").filter((l) => /^\s*(export function |(static |get |set )?\w+\(.*\): )/.test(l))) expect(line).toMatch(/;$/);
    // The only braces left open a class.
    for (const line of ref.split("\n").filter((l) => l.trimEnd().endsWith("{") && !/^\s*(\/\/|\*|\/\*)/.test(l))) expect(line).toMatch(/^export class \w+ \{$/);
  });
  test("a CRLF checkout (Windows) gives the same reference", () => {
    expect(sdkReference(sdk.replace(/\r?\n/g, "\r\n"))).toBe(sdkReference(sdk.replace(/\r\n?/g, "\n")));
    expect(sdkReference(sdk.replace(/\r?\n/g, "\r\n"))).not.toContain("\r");
  });
  test("works on a small file: bodies, private members, _ members and non-exported helpers", () => {
    const src = [
      "// Header note.",
      'import { x } from "./internal";',
      "",
      "const HIDDEN = 1;",
      "",
      "/** Adds. */",
      "export function add(a: i32, b: i32): i32 {",
      "  return a + b; // { not a class }",
      "}",
      "",
      "/** A thing. */",
      "export class Thing {",
      "  /** Its size. */",
      "  size: i32 = 0;",
      "  // Plumbing.",
      "  private secret: i32 = 1;",
      "  /** Internal. */",
      '  _op: string = "";',
      "  constructor(size: i32) { this.size = size; }",
      "  /** Twice the size. */",
      "  get double(): i32 { return this.size * 2; }",
      "  /** Grow. */",
      "  grow(by: i32 = 1): Thing { this.size += by; return this; }",
      "}",
      "",
      "function helper(): void {}",
    ].join("\n");
    expect(sdkReference(src)).toBe([
      "// Header note.",
      "",
      "/** Adds. */",
      "export function add(a: i32, b: i32): i32;",
      "",
      "/** A thing. */",
      "export class Thing {",
      "  /** Its size. */",
      "  size: i32 = 0;",
      "  constructor(size: i32);",
      "  /** Twice the size. */",
      "  get double(): i32;",
      "  /** Grow. */",
      "  grow(by: i32 = 1): Thing;",
      "}",
      "",
    ].join("\n"));
  });
});
