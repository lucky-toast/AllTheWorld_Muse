// Fuel metering (spec 10.3, step 4): a binary rewriter. It appends one mutable i64
// global (exported as __atw_fuel) and, at every function entry and every loop header,
// inserts code that subtracts a static cost from it and traps once it goes below zero.
// No function is added or reordered and no index changes, so the module keeps its
// meaning. The cost of a function entry is the number of instructions in the function
// outside any loop; the cost of a loop header is the number of instructions in that
// loop's body outside nested loops. Both are fixed by the bytes, so the same module
// always burns the same fuel for the same work.
//
// The rewriter understands the MVP instruction set plus the asc default features
// (sign-extension, non-trapping float-to-int, bulk memory; mutable globals need no
// opcode). Any other opcode, value type or section shape is rejected.

export class WasmError extends Error {}

/** The name the fuel global is exported under. */
export const FUEL_EXPORT = "__atw_fuel";

export interface FuncType { params: number[]; results: number[] }
export interface Limits { min: number; max: number | null; flags: number }
export type ImportDesc =
  | { kind: "func"; type: number }
  | { kind: "table"; limits: Limits }
  | { kind: "memory"; limits: Limits }
  | { kind: "global"; type: number; mutable: boolean };
export interface WasmImport { module: string; name: string; desc: ImportDesc }
export interface WasmExport { name: string; kind: "func" | "table" | "memory" | "global"; index: number }
/** What the loader needs to know about a module. */
export interface WasmInfo {
  types: FuncType[];
  imports: WasmImport[];
  /** Type index of every function, imported ones first. */
  funcTypes: number[];
  exports: WasmExport[];
  memories: number;
  hasStart: boolean;
  importedGlobals: number;
  definedGlobals: number;
}

const NUM_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
const TYPE_NAMES: Record<number, string> = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64" };
export function typeName(t: number): string { return TYPE_NAMES[t] ?? `0x${t.toString(16)}`; }
const EXPORT_KINDS = ["func", "table", "memory", "global"] as const;
// Section ids in the order they must appear (custom sections, id 0, may sit anywhere).
const SECTION_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11];
const GLOBAL_SECTION = 6, EXPORT_SECTION = 7, CODE_SECTION = 10;

class Reader {
  constructor(readonly b: Uint8Array, public p = 0, readonly end = b.length) {}
  get done() { return this.p >= this.end; }
  byte(): number { if (this.p >= this.end) throw new WasmError("unexpected end of the module"); return this.b[this.p++]; }
  u32(): number {
    let r = 0, shift = 0, byte = 0;
    do { byte = this.byte(); if (shift >= 35) throw new WasmError("integer too long"); r += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    if (r > 0xffffffff) throw new WasmError("integer out of range");
    return r;
  }
  /** Skip a signed LEB128 of at most `bits` bits. */
  skipSleb(bits: number) { let n = 0; let byte = 0; do { byte = this.byte(); if (++n > Math.ceil(bits / 7)) throw new WasmError("integer too long"); } while (byte & 0x80); }
  bytes(n: number): Uint8Array { if (this.p + n > this.end) throw new WasmError("unexpected end of the module"); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  name(): string { return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(this.u32())); }
}

function uleb(n: number): number[] { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; }
function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f; n = Math.floor(n / 128);
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}
function nameBytes(s: string): number[] { const b = new TextEncoder().encode(s); return [...uleb(b.length), ...b]; }

function valType(r: Reader): number {
  const t = r.byte();
  if (!NUM_TYPES.has(t)) throw new WasmError(`value type 0x${t.toString(16)} isn't supported (only i32, i64, f32, f64)`);
  return t;
}
function limits(r: Reader): Limits {
  const flags = r.byte();
  if (flags > 1) throw new WasmError(flags & 2 ? "shared memory isn't supported" : "memory64 and other limit flags aren't supported");
  const min = r.u32(); const max = flags & 1 ? r.u32() : null;
  return { min, max, flags };
}

interface Section { id: number; start: number; end: number; bodyStart: number }
function sections(b: Uint8Array): Section[] {
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d || b[4] !== 1 || b[5] || b[6] || b[7]) throw new WasmError("not a WebAssembly 1.0 module");
  const r = new Reader(b, 8); const out: Section[] = []; let last = -1;
  while (!r.done) {
    const start = r.p; const id = r.byte(); const size = r.u32(); const bodyStart = r.p;
    if (bodyStart + size > b.length) throw new WasmError("a section runs past the end of the module");
    r.p = bodyStart + size;
    if (id !== 0) {
      const rank = SECTION_ORDER.indexOf(id);
      if (rank < 0) throw new WasmError(`section ${id} isn't supported`);
      if (rank <= last) throw new WasmError(`section ${id} is out of order or repeated`);
      last = rank;
    }
    out.push({ id, start, end: r.p, bodyStart });
  }
  return out;
}

/** Read a module's types, imports, functions, exports and the shape checks the loader needs. */
export function inspect(bytes: Uint8Array): WasmInfo {
  const info: WasmInfo = { types: [], imports: [], funcTypes: [], exports: [], memories: 0, hasStart: false, importedGlobals: 0, definedGlobals: 0 };
  for (const s of sections(bytes)) {
    const r = new Reader(bytes, s.bodyStart, s.end);
    switch (s.id) {
      case 1: for (let n = r.u32(); n > 0; n--) {
        if (r.byte() !== 0x60) throw new WasmError("only function types are supported");
        const params: number[] = []; for (let k = r.u32(); k > 0; k--) params.push(valType(r));
        const results: number[] = []; for (let k = r.u32(); k > 0; k--) results.push(valType(r));
        info.types.push({ params, results });
      } break;
      case 2: for (let n = r.u32(); n > 0; n--) {
        const module = r.name(), name = r.name(); const kind = r.byte();
        let desc: ImportDesc;
        if (kind === 0) { desc = { kind: "func", type: r.u32() }; info.funcTypes.push(desc.type); }
        else if (kind === 1) { const t = r.byte(); if (t !== 0x70) throw new WasmError("only funcref tables are supported"); desc = { kind: "table", limits: limits(r) }; }
        else if (kind === 2) { desc = { kind: "memory", limits: limits(r) }; info.memories++; }
        else if (kind === 3) { desc = { kind: "global", type: valType(r), mutable: r.byte() === 1 }; info.importedGlobals++; }
        else throw new WasmError(`import kind ${kind} isn't supported`);
        info.imports.push({ module, name, desc });
      } break;
      case 3: for (let n = r.u32(); n > 0; n--) info.funcTypes.push(r.u32()); break;
      case 4: for (let n = r.u32(); n > 0; n--) { if (r.byte() !== 0x70) throw new WasmError("only funcref tables are supported"); limits(r); } break;
      case 5: for (let n = r.u32(); n > 0; n--) { limits(r); info.memories++; } break;
      case 6: for (let n = r.u32(); n > 0; n--) { valType(r); r.byte(); skipExpr(r); info.definedGlobals++; } break;
      case 7: for (let n = r.u32(); n > 0; n--) {
        const name = r.name(); const k = r.byte(); const index = r.u32();
        if (k > 3) throw new WasmError(`export kind ${k} isn't supported`);
        info.exports.push({ name, kind: EXPORT_KINDS[k], index });
      } break;
      case 8: info.hasStart = true; break;
    }
  }
  for (const t of info.funcTypes) if (t >= info.types.length) throw new WasmError(`function type ${t} doesn't exist`);
  return info;
}

/** Skip a constant expression up to and including its `end`. */
function skipExpr(r: Reader) {
  for (;;) {
    const op = r.byte();
    if (op === 0x0b) return;
    if (op === 0x41) r.skipSleb(32); else if (op === 0x42) r.skipSleb(64);
    else if (op === 0x43) r.bytes(4); else if (op === 0x44) r.bytes(8);
    else if (op === 0x23) r.u32();
    else throw new WasmError(`opcode 0x${op.toString(16)} isn't allowed in a constant expression`);
  }
}

/** Kinds of structured instruction the cost counter tracks. */
const enum Ctl { None, Open, Loop, End }

function blockType(r: Reader) {
  const b = r.b[r.p];
  if (b === 0x40 || NUM_TYPES.has(b)) { r.p++; return; }
  if (b >= 0x40 && b < 0x80) throw new WasmError(`block type 0x${b.toString(16)} isn't supported`);
  r.skipSleb(33); // a type index (multi-value block)
}
function zeroByte(r: Reader, what: string) { if (r.byte() !== 0) throw new WasmError(`${what} must name memory 0`); }

/** Decode one instruction at r.p (advancing past its immediates). Throws on anything not understood. */
function instr(r: Reader): Ctl {
  const at = r.p; const op = r.byte();
  if (op === 0x02 || op === 0x04) { blockType(r); return Ctl.Open; }
  if (op === 0x03) { blockType(r); return Ctl.Loop; }
  if (op === 0x0b) return Ctl.End;
  if (op === 0x00 || op === 0x01 || op === 0x05 || op === 0x0f || op === 0x1a || op === 0x1b) return Ctl.None;
  if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24)) { r.u32(); return Ctl.None; }
  if (op === 0x0e) { for (let n = r.u32(); n > 0; n--) r.u32(); r.u32(); return Ctl.None; }
  if (op === 0x11) { r.u32(); r.u32(); return Ctl.None; }
  if (op >= 0x28 && op <= 0x3e) { const align = r.u32(); if (align >= 64) throw new WasmError(`multiple memories aren't supported (byte ${at})`); r.u32(); return Ctl.None; }
  if (op === 0x3f || op === 0x40) { zeroByte(r, "memory.size and memory.grow"); return Ctl.None; }
  if (op === 0x41) { r.skipSleb(32); return Ctl.None; }
  if (op === 0x42) { r.skipSleb(64); return Ctl.None; }
  if (op === 0x43) { r.bytes(4); return Ctl.None; }
  if (op === 0x44) { r.bytes(8); return Ctl.None; }
  if (op >= 0x45 && op <= 0xc4) return Ctl.None; // numeric (0xc0-0xc4 are sign-extension)
  if (op === 0xfc) {
    const sub = r.u32();
    if (sub <= 7) return Ctl.None; // non-trapping float-to-int
    if (sub === 8) { r.u32(); zeroByte(r, "memory.init"); return Ctl.None; }
    if (sub === 9 || sub === 13) { r.u32(); return Ctl.None; }
    if (sub === 10) { zeroByte(r, "memory.copy"); zeroByte(r, "memory.copy"); return Ctl.None; }
    if (sub === 11) { zeroByte(r, "memory.fill"); return Ctl.None; }
    if (sub === 12 || sub === 14) { r.u32(); r.u32(); return Ctl.None; }
    throw new WasmError(`unknown opcode 0xfc ${sub} at byte ${at}`);
  }
  throw new WasmError(`unknown opcode 0x${op.toString(16)} at byte ${at}`);
}

/** The charge snippet: fuel -= cost; if (fuel < 0) unreachable. */
function charge(global: number, cost: number): number[] {
  const g = uleb(global);
  return [0x23, ...g, 0x42, ...sleb(cost), 0x7d, 0x24, ...g, 0x23, ...g, 0x42, 0x00, 0x53, 0x04, 0x40, 0x00, 0x0b];
}

/** Rewrite one function body (without its size prefix) with charges at entry and at every loop header. */
function meterBody(b: Uint8Array, start: number, end: number, global: number, fn: number): number[] {
  const r = new Reader(b, start, end);
  for (let n = r.u32(); n > 0; n--) { r.u32(); valType(r); }
  const codeStart = r.p;
  // Pass 1: count instructions per region (the function, or the innermost enclosing loop).
  const costs: number[] = [0]; // region 0 is the function
  const inserts: { at: number; region: number }[] = [{ at: codeStart, region: 0 }];
  const stack: { loop: boolean; region: number }[] = [];
  let region = 0;
  for (;;) {
    if (r.p >= end) throw new WasmError(`function ${fn} has no final end`);
    let ctl: Ctl;
    try { ctl = instr(r); } catch (e) { throw e instanceof WasmError ? new WasmError(`function ${fn}: ${e.message}`) : e; }
    costs[region]++;
    if (ctl === Ctl.Open) stack.push({ loop: false, region });
    else if (ctl === Ctl.Loop) { stack.push({ loop: true, region }); region = costs.length; costs.push(0); inserts.push({ at: r.p, region }); }
    else if (ctl === Ctl.End) {
      const top = stack.pop();
      if (!top) { if (r.p !== end) throw new WasmError(`function ${fn} has bytes after its final end`); break; }
      region = top.region;
    }
  }
  // Pass 2: copy the body with the charges inserted.
  const out: number[] = Array.from(b.subarray(start, codeStart));
  let p = codeStart;
  for (const ins of inserts) {
    for (; p < ins.at; p++) out.push(b[p]);
    out.push(...charge(global, Math.max(1, costs[ins.region])));
  }
  for (; p < end; p++) out.push(b[p]);
  return out;
}

/**
 * Add fuel metering to a module. Deterministic: the same input gives the same bytes.
 * Throws WasmError for anything it doesn't understand (unknown opcodes, value types or sections).
 */
export function meter(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const info = inspect(bytes);
  if (info.exports.some((e) => e.name === FUEL_EXPORT)) throw new WasmError(`the module already exports "${FUEL_EXPORT}"`);
  const global = info.importedGlobals + info.definedGlobals;
  const secs = sections(bytes);
  const out: number[] = Array.from(bytes.subarray(0, 8));
  const emit = (id: number, body: number[]) => { out.push(id, ...uleb(body.length), ...body); };
  const fuelGlobal = [0x7e, 0x01, 0x42, 0x00, 0x0b]; // mutable i64, initially 0 (so a start section traps at once)
  const fuelExport = [...nameBytes(FUEL_EXPORT), 0x03, ...uleb(global)];
  let addedGlobal = false, addedExport = false;
  const rank = (id: number) => SECTION_ORDER.indexOf(id);
  const flushBefore = (id: number) => {
    if (!addedGlobal && rank(id) > rank(GLOBAL_SECTION)) { emit(GLOBAL_SECTION, [1, ...fuelGlobal]); addedGlobal = true; }
    if (!addedExport && rank(id) > rank(EXPORT_SECTION)) { emit(EXPORT_SECTION, [1, ...fuelExport]); addedExport = true; }
  };
  const importedFuncs = info.imports.filter((i) => i.desc.kind === "func").length;
  for (const s of secs) {
    if (s.id !== 0) flushBefore(s.id);
    const r = new Reader(bytes, s.bodyStart, s.end);
    if (s.id === GLOBAL_SECTION) {
      const n = r.u32();
      emit(GLOBAL_SECTION, [...uleb(n + 1), ...bytes.subarray(r.p, s.end), ...fuelGlobal]); addedGlobal = true;
    } else if (s.id === EXPORT_SECTION) {
      const n = r.u32();
      emit(EXPORT_SECTION, [...uleb(n + 1), ...bytes.subarray(r.p, s.end), ...fuelExport]); addedExport = true;
    } else if (s.id === CODE_SECTION) {
      const n = r.u32(); const body: number[] = [...uleb(n)];
      for (let i = 0; i < n; i++) {
        const size = r.u32(); const fStart = r.p; const fEnd = fStart + size;
        if (fEnd > s.end) throw new WasmError("a function body runs past its section");
        const metered = meterBody(bytes, fStart, fEnd, global, importedFuncs + i);
        body.push(...uleb(metered.length), ...metered);
        r.p = fEnd;
      }
      emit(CODE_SECTION, body);
    } else out.push(...bytes.subarray(s.start, s.end));
  }
  if (!addedGlobal) emit(GLOBAL_SECTION, [1, ...fuelGlobal]);
  if (!addedExport) emit(EXPORT_SECTION, [1, ...fuelExport]);
  return new Uint8Array(out);
}
