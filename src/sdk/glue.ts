// Internal: the export glue every module gets (re-exported from the compiler's entry
// file) and the replacements for the runtime's abort, trace and seed imports, so the
// only imports left are host.call and env.memory. See README.md.
import { rand } from "./index";

/** Host -> module: a pinned ArrayBuffer of `len` bytes for a UTF-8 response. The module unpins it. */
export function __atw_alloc(len: i32): usize {
  return __pin(__new(<usize>len, idof<ArrayBuffer>()));
}

/** Host -> module: a pinned String of `units` UTF-16 code units for a handler argument. */
export function __atw_string(units: i32): usize {
  return __pin(__new(<usize>units << 1, idof<String>()));
}

/** Host -> module: unpin a String made by __atw_string once the handler returned. */
export function __atw_unpin(ptr: usize): void {
  __unpin(ptr);
}

// Plain numbers (not managed references) so abort works even before the start function ran.
// The trap follows at once, so the strings can't be collected in between.
@lazy let abortMessage: usize = 0;
@lazy let abortFile: usize = 0;
@lazy let abortLine: u32 = 0;
@lazy let abortColumn: u32 = 0;

/** Replaces the runtime's `abort`: remember where, then trap. The host reads it back after the trap. */
export function atwAbort(message: string | null, fileName: string | null, line: u32, column: u32): void {
  abortMessage = changetype<usize>(message); abortFile = changetype<usize>(fileName); abortLine = line; abortColumn = column;
  unreachable();
}
/** Pointer to the last abort message (a String), or 0. */
export function __atw_abort_message(): usize { return abortMessage; }
/** Pointer to the file name of the last abort (a String), or 0. */
export function __atw_abort_file(): usize { return abortFile; }
/** Line of the last abort, or 0. */
export function __atw_abort_line(): u32 { return abortLine; }
/** Column of the last abort, or 0. */
export function __atw_abort_column(): u32 { return abortColumn; }

/** Replaces the runtime's `trace`: modules have no console, so it does nothing. */
export function atwTrace(message: string, n: i32 = 0, a0: f64 = 0, a1: f64 = 0, a2: f64 = 0, a3: f64 = 0, a4: f64 = 0): void {}

/** Replaces the runtime's `seed` (Math.random's seed): taken from the system's own host stream. */
export function atwSeed(): f64 { return rand() * 9007199254740991.0 + 1.0; }
