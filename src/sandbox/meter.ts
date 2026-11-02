// Binary fuel meter (spec 10.3 step 4). Deterministic: same input, same output.
// Appends one mutable i64 global, exported as __fuel, and inserts a fixed-cost
// check at every function entry and every loop header. Function indices never change.

export const FUEL_ENTRY_COST = 16;
export const FUEL_LOOP_COST = 16;
export const FUEL_EXPORT_NAME = "__fuel";

export class MeterError extends Error {}

type Reader = { bytes: Uint8Array; pos: number; end: number };

function uleb(r: Reader): number {
  let result = 0; let shift = 0;
  while (true) {
    if (r.pos >= r.end) throw new MeterError("unexpected end of binary in unsigned LEB128");
    const b = r.bytes[r.pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return result;
    shift += 7;
    if (shift > 63) throw new MeterError("unsigned LEB128 too long");
  }
}
function sleb(r: Reader): bigint {
  let result = 0n; let shift = 0n; let count = 0;
  while (true) {
    if (r.pos >= r.end) throw new MeterError("unexpected end of binary in signed LEB128");
    const b = r.bytes[r.pos++];
    count++;
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) {
      if (b & 0x40) result |= -1n << shift;
      return result;
    }
    if (count >= 10) throw new MeterError("signed LEB128 too long");
  }
}
function encUleb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  // values here are small indices/costs; handle up to 2^53 via arithmetic
  let n = value;
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  void v;
  return out;
}
function encSleb(value: number): number[] {
  const out: number[] = [];
  let v = value; let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}
function encName(name: string): number[] {
  const bytes = [...new TextEncoder().encode(name)];
  return [...encUleb(bytes.length), ...bytes];
}

interface Section { id: number; start: number; payloadStart: number; payloadEnd: number; end: number }

function parseSections(bytes: Uint8Array): Section[] {
  if (bytes.length < 8) throw new MeterError("not a WebAssembly binary");
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) throw new MeterError("not a WebAssembly binary");
  const sections: Section[] = [];
  let pos = 8;
  while (pos < bytes.length) {
    const start = pos;
    const id = bytes[pos++];
    const r: Reader = { bytes, pos, end: bytes.length };
    const size = uleb(r);
    pos = r.pos;
    const payloadStart = pos;
    const payloadEnd = pos + size;
    if (payloadEnd > bytes.length) throw new MeterError("section extends past the end of the binary");
    sections.push({ id, start, payloadStart, payloadEnd, end: payloadEnd });
    pos = payloadEnd;
  }
  return sections;
}

function readName(r: Reader): string {
  const len = uleb(r);
  const text = new TextDecoder().decode(r.bytes.subarray(r.pos, r.pos + len));
  r.pos += len;
  return text;
}
function readLimits(r: Reader): void {
  const flags = uleb(r);
  uleb(r);
  if (flags & 0x01) uleb(r);
}
function readValType(r: Reader): void {
  if (r.pos >= r.end) throw new MeterError("unexpected end in value type");
  r.pos++;
}

/** Counts of global imports and defined globals, so the appended global's index is known. */
function globalCounts(bytes: Uint8Array, sections: Section[]): { imported: number; defined: number } {
  let imported = 0; let defined = 0;
  for (const s of sections) {
    if (s.id === 2) {
      const r: Reader = { bytes, pos: s.payloadStart, end: s.payloadEnd };
      const count = uleb(r);
      for (let i = 0; i < count; i++) {
        readName(r); readName(r);
        const kind = bytes[r.pos++];
        if (kind === 0x00) uleb(r);
        else if (kind === 0x01) { readValType(r); readLimits(r); }
        else if (kind === 0x02) readLimits(r);
        else if (kind === 0x03) { readValType(r); r.pos++; imported++; }
        else throw new MeterError(`unknown import kind ${kind}`);
      }
    } else if (s.id === 6) {
      const r: Reader = { bytes, pos: s.payloadStart, end: s.payloadEnd };
      defined = uleb(r);
    }
  }
  return { imported, defined };
}

function fuelCheck(globalIndex: number, cost: number): number[] {
  return [
    0x23, ...encUleb(globalIndex), // global.get fuel
    0x42, ...encSleb(cost), // i64.const cost
    0x53, // i64.lt_s
    0x04, 0x40, // if (empty)
    0x00, // unreachable
    0x0b, // end
    0x23, ...encUleb(globalIndex),
    0x42, ...encSleb(cost),
    0x7d, // i64.sub
    0x24, ...encUleb(globalIndex), // global.set fuel
  ];
}

const NO_IMM_SINGLE = new Set<number>();
for (let op = 0x45; op <= 0xc4; op++) NO_IMM_SINGLE.add(op); // numeric ops incl. sign extension
for (const op of [0x00, 0x01, 0x0f, 0x1a, 0x1b, 0xd1]) NO_IMM_SINGLE.add(op);

/** Rewrite one function body, inserting fuel checks. Rejects opcodes the meter does not understand. */
function rewriteBody(bytes: Uint8Array, bodyStart: number, bodyEnd: number, globalIndex: number, funcIndex: number): Uint8Array {
  const r: Reader = { bytes, pos: bodyStart, end: bodyEnd };
  const localRuns = uleb(r);
  for (let i = 0; i < localRuns; i++) { uleb(r); readValType(r); }
  const localsEnd = r.pos;
  const out: number[] = [...bytes.subarray(bodyStart, localsEnd), ...fuelCheck(globalIndex, FUEL_ENTRY_COST)];
  let depth = 0;
  while (r.pos < bodyEnd) {
    const opStart = r.pos;
    const op = bytes[r.pos++];
    const afterOp = r.pos;
    let insertAfter = -1;
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      sleb(r); // blocktype
      depth++;
      if (op === 0x03) insertAfter = r.pos;
    } else if (op === 0x05) {
      // else: no immediate
    } else if (op === 0x0b) {
      depth--;
      out.push(...bytes.subarray(opStart, r.pos));
      if (depth < 0) {
        if (r.pos !== bodyEnd) throw new MeterError(`function ${funcIndex}: trailing bytes after final end`);
        return new Uint8Array(out);
      }
      continue;
    } else if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25 || op === 0x26) {
      uleb(r);
    } else if (op === 0x0e) {
      const n = uleb(r);
      for (let i = 0; i <= n; i++) uleb(r);
    } else if (op === 0x11) {
      uleb(r); uleb(r); // type index, table index
    } else if (op === 0x1c) {
      const n = uleb(r);
      for (let i = 0; i < n; i++) readValType(r);
    } else if (op >= 0x28 && op <= 0x3e) {
      uleb(r); uleb(r); // memarg align, offset
    } else if (op === 0x3f || op === 0x40) {
      if (bytes[r.pos++] !== 0x00) throw new MeterError(`function ${funcIndex}: bad memory instruction reserved byte`);
    } else if (op === 0x41) {
      sleb(r);
    } else if (op === 0x42) {
      sleb(r);
    } else if (op === 0x43) {
      r.pos += 4;
    } else if (op === 0x44) {
      r.pos += 8;
    } else if (op === 0xd0) {
      sleb(r); // heap type
    } else if (op === 0xd2) {
      uleb(r);
    } else if (op === 0xfc) {
      const sub = uleb(r);
      if (sub >= 0 && sub <= 7) {
        // trunc_sat: the result type is encoded in the sub-opcode, no immediate
      } else if (sub === 8) { uleb(r); r.pos++; } // memory.init dataidx, memory byte
      else if (sub === 9) uleb(r); // data.drop
      else if (sub === 10) { r.pos += 2; } // memory.copy
      else if (sub === 11) { r.pos++; } // memory.fill
      else if (sub === 12) { uleb(r); uleb(r); } // table.init
      else if (sub === 13) uleb(r); // elem.drop
      else if (sub === 14) { uleb(r); uleb(r); } // table.copy
      else if (sub === 15 || sub === 16 || sub === 17) { uleb(r); } // table.grow/size/fill
      else throw new MeterError(`function ${funcIndex}: unknown opcode 0xfc 0x${sub.toString(16)} at byte ${opStart}`);
    } else if (NO_IMM_SINGLE.has(op)) {
      // no immediate
    } else {
      throw new MeterError(`function ${funcIndex}: unknown opcode 0x${op.toString(16).padStart(2, "0")} at byte ${opStart}`);
    }
    if (r.pos > bodyEnd) throw new MeterError(`function ${funcIndex}: instruction overruns the function body`);
    void afterOp;
    out.push(...bytes.subarray(opStart, r.pos));
    if (insertAfter >= 0) out.push(...fuelCheck(globalIndex, FUEL_LOOP_COST));
  }
  throw new MeterError(`function ${funcIndex}: missing final end opcode`);
}

export interface MeterResult { bytes: Uint8Array; fuelGlobalIndex: number }

/** Add fuel metering to a wasm binary. The result is deterministic for a given input. */
export function meterBinary(input: Uint8Array): MeterResult {
  const bytes = input;
  const sections = parseSections(bytes);
  const counts = globalCounts(bytes, sections);
  const fuelIndex = counts.imported + counts.defined;

  const hasFuelExport = sections.some((s) => {
    if (s.id !== 7) return false;
    const r: Reader = { bytes, pos: s.payloadStart, end: s.payloadEnd };
    const n = uleb(r);
    for (let i = 0; i < n; i++) { const name = readName(r); r.pos++; uleb(r); if (name === FUEL_EXPORT_NAME) return true; }
    return false;
  });
  if (hasFuelExport) throw new MeterError(`module already exports "${FUEL_EXPORT_NAME}"`);

  // Rewrite the code section first (validates every opcode).
  let newCodePayload: Uint8Array | null = null;
  const codeSection = sections.find((s) => s.id === 10);
  if (codeSection) {
    const r: Reader = { bytes, pos: codeSection.payloadStart, end: codeSection.payloadEnd };
    const funcCount = uleb(r);
    const funcs: number[][] = [];
    const importedFuncs = (() => {
      let n = 0;
      for (const s of sections) if (s.id === 2) {
        const rr: Reader = { bytes, pos: s.payloadStart, end: s.payloadEnd };
        const c = uleb(rr);
        for (let i = 0; i < c; i++) { readName(rr); readName(rr); const kind = bytes[rr.pos++]; if (kind === 0x00) { uleb(rr); n++; } else if (kind === 0x01) { readValType(rr); readLimits(rr); } else if (kind === 0x02) readLimits(rr); else if (kind === 0x03) { readValType(rr); rr.pos++; } }
      }
      return n;
    })();
    for (let i = 0; i < funcCount; i++) {
      const bodySize = uleb(r);
      const bodyStart = r.pos;
      const bodyEnd = bodyStart + bodySize;
      if (bodyEnd > codeSection.payloadEnd) throw new MeterError("function body extends past the code section");
      const rewritten = rewriteBody(bytes, bodyStart, bodyEnd, fuelIndex, importedFuncs + i);
      funcs.push([...encUleb(rewritten.length), ...rewritten]);
      r.pos = bodyEnd;
    }
    const payload: number[] = [...encUleb(funcCount)];
    for (const f of funcs) payload.push(...f);
    newCodePayload = new Uint8Array(payload);
  }

  // i64, mutable, i64.const 500M so the start function can run at instantiation; the host resets it before every call.
  const newGlobalEntry = [0x7e, 0x01, 0x42, ...encSleb(500_000_000), 0x0b];
  const newExportEntry = [...encName(FUEL_EXPORT_NAME), 0x03, ...encUleb(fuelIndex)];

  // Rebuild the binary section by section, inserting or extending global/export sections.
  const out: number[] = [...bytes.subarray(0, 8)];
  const emitSection = (id: number, payload: Uint8Array) => { out.push(id, ...encUleb(payload.length), ...payload); };
  let globalDone = false; let exportDone = false;
  const flushGlobal = () => {
    if (globalDone) return;
    globalDone = true;
    const existing = sections.find((s) => s.id === 6);
    if (existing) {
      const r: Reader = { bytes, pos: existing.payloadStart, end: existing.payloadEnd };
      const n = uleb(r);
      const payload = [...encUleb(n + 1), ...bytes.subarray(r.pos, existing.payloadEnd), ...newGlobalEntry];
      emitSection(6, new Uint8Array(payload));
    } else {
      emitSection(6, new Uint8Array([...encUleb(1), ...newGlobalEntry]));
    }
  };
  const flushExport = () => {
    if (exportDone) return;
    exportDone = true;
    const existing = sections.find((s) => s.id === 7);
    if (existing) {
      const r: Reader = { bytes, pos: existing.payloadStart, end: existing.payloadEnd };
      const n = uleb(r);
      const payload = [...encUleb(n + 1), ...bytes.subarray(r.pos, existing.payloadEnd), ...newExportEntry];
      emitSection(7, new Uint8Array(payload));
    } else {
      emitSection(7, new Uint8Array([...encUleb(1), ...newExportEntry]));
    }
  };
  for (const s of sections) {
    if (s.id !== 0) {
      if (!globalDone && s.id > 6) flushGlobal();
      if (!exportDone && s.id > 7) flushExport();
    }
    if (s.id === 6) { flushGlobal(); continue; }
    if (s.id === 7) { flushExport(); continue; }
    if (s.id === 10 && newCodePayload) { emitSection(10, newCodePayload); continue; }
    out.push(...bytes.subarray(s.start, s.end));
  }
  if (!globalDone) flushGlobal();
  if (!exportDone) flushExport();
  return { bytes: new Uint8Array(out), fuelGlobalIndex: fuelIndex };
}
