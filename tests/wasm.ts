// A tiny WebAssembly encoder for hand-built test binaries.
export interface FnType { params: number[]; results: number[] }
export const I32 = 0x7f;
export interface BuildOpts {
  types: FnType[];
  imports: { module: string; name: string; kind: "func"; type: number }[] | { module: string; name: string; kind: "memory"; min: number; max?: number }[] | ({ module: string; name: string } & ({ kind: "func"; type: number } | { kind: "memory"; min: number; max?: number }))[];
  funcs: { type: number; body: number[]; locals?: number[] }[];
  exports: { name: string; func: number }[];
}
function uleb(n: number): number[] { const out: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function vec(items: number[][]): number[] { return [...uleb(items.length), ...items.flat()]; }
function name(s: string): number[] { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; }
function section(id: number, body: number[]): number[] { return [id, ...uleb(body.length), ...body]; }

export function buildWasm(o: BuildOpts): Uint8Array<ArrayBuffer> {
  const types = vec(o.types.map((t) => [0x60, ...vec(t.params.map((p) => [p])), ...vec(t.results.map((r) => [r]))]));
  const imports = vec(o.imports.map((i) => i.kind === "func" ? [...name(i.module), ...name(i.name), 0x00, ...uleb(i.type)]
    : [...name(i.module), ...name(i.name), 0x02, ...(i.max === undefined ? [0x00, ...uleb(i.min)] : [0x01, ...uleb(i.min), ...uleb(i.max)])]));
  const funcs = vec(o.funcs.map((f) => uleb(f.type)));
  const exports = vec(o.exports.map((e) => [...name(e.name), 0x00, ...uleb(e.func)]));
  const code = vec(o.funcs.map((f) => { const body = [...vec((f.locals ?? []).map((t) => [1, t])), ...f.body]; return [...uleb(body.length), ...body]; }));
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section(1, types), ...section(2, imports), ...section(3, funcs), ...section(7, exports), ...section(10, code)]);
}

/** A minimal module the loader accepts: the two imports and stub glue exports, plus `extra` (export `func` counts defined functions; extras start at 8). */
export function baseModule(extra: { imports?: BuildOpts["imports"]; funcs?: BuildOpts["funcs"]; exports?: BuildOpts["exports"] } = {}): Uint8Array<ArrayBuffer> {
  const types: FnType[] = [
    { params: [I32, I32], results: [I32] }, // 0 host.call
    { params: [I32], results: [I32] },      // 1 alloc, string
    { params: [I32], results: [] },         // 2 unpin
    { params: [], results: [I32] },         // 3 abort getters
    { params: [], results: [] },            // 4 start, handlers
    { params: [I32, I32, I32], results: [] }, // 5 perform
  ];
  const imports = [
    { module: "host", name: "call", kind: "func" as const, type: 0 },
    { module: "env", name: "memory", kind: "memory" as const, min: 1, max: 256 },
    ...((extra.imports ?? []) as BuildOpts["imports"][number][]),
  ];
  const importedFuncs = imports.filter((i) => i.kind === "func").length;
  const funcs: BuildOpts["funcs"] = [
    { type: 1, body: [0x20, 0x00, 0x0b] }, { type: 1, body: [0x20, 0x00, 0x0b] }, { type: 2, body: [0x0b] },
    { type: 3, body: [0x41, 0x00, 0x0b] }, { type: 3, body: [0x41, 0x00, 0x0b] }, { type: 3, body: [0x41, 0x00, 0x0b] }, { type: 3, body: [0x41, 0x00, 0x0b] },
    { type: 4, body: [0x0b] },
    ...(extra.funcs ?? []),
  ];
  const glue = ["__atw_alloc", "__atw_string", "__atw_unpin", "__atw_abort_message", "__atw_abort_file", "__atw_abort_line", "__atw_abort_column", "__atw_start"];
  const exports = [...glue.map((n, i) => ({ name: n, func: importedFuncs + i })), ...(extra.exports ?? []).map((e) => ({ name: e.name, func: importedFuncs + e.func }))];
  return buildWasm({ types, imports, funcs, exports });
}
