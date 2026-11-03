# The SDK and the module ABI

`src/sdk/` is an AssemblyScript library compiled into every AI system. System code imports only from `"sdk"` (`index.ts`, the reference the designer prompt shows as `{{API}}`). The other files are internal:

| File | What it is |
| --- | --- |
| `index.ts` | Every request as a typed helper, the JSON reader (`Json`, `parse`) and writers (`Obj`, `Arr`, `quote`), and the helpers built from requests (`player`, `facing`, `facedTile`, `isFree`, `footprintFree`, `giveToPlayer`, ...) |
| `internal.ts` | Request sending, the last error, request builders, number formatting, the JSON parser |
| `host.ts` | The one import, `host.call`, and the string plumbing around it |
| `glue.ts` | The exports the host needs, and the `abort`, `trace` and `seed` replacements |

The compiler settings live in `src/sandbox/compile.ts` and can't be changed by a system. asc is pinned to **0.28.20**.

## Imports

A module imports exactly two things, and the loader rejects anything else:

| Import | Kind | Signature |
| --- | --- | --- |
| `host.call` | function | `(reqPtr: i32, reqLen: i32) -> i32` |
| `env.memory` | memory | the host's memory: a fresh `WebAssembly.Memory` per instance, at most 256 pages (16 MB) |

`abort`, `trace` and `seed`, which the AssemblyScript runtime would normally import from `env`, are redirected at compile time (`--use abort=~lib/sdk/glue/atwAbort` and so on), so they never appear as imports.

## Exports

| Export | Signature | Purpose |
| --- | --- | --- |
| `__atw_start` | `() -> ()` | The module's start function (`--exportStart`). The host calls it once, under fuel, right after instantiating; the binary has no start section |
| `__atw_alloc` | `(len: i32) -> i32` | Allocates a pinned `ArrayBuffer` of `len` bytes for a response and returns its address |
| `__atw_string` | `(units: i32) -> i32` | Allocates a pinned `String` of `units` UTF-16 code units for a handler argument |
| `__atw_unpin` | `(ptr: i32) -> ()` | Unpins a `String` made by `__atw_string` |
| `__atw_abort_message`, `__atw_abort_file` | `() -> i32` | Address of the last `abort`'s message and file name (`String`s), or 0 |
| `__atw_abort_line`, `__atw_abort_column` | `() -> i32` | Line and column of the last `abort` |
| `perform` | `(verb: i32, target: i32, held: i32) -> ()` | `verb` is a `String` address; `target` and `held` are entity ids |
| `onEvent` | `(name: i32, payload: i32) -> ()` | Both `String` addresses; `payload` is JSON text |
| `onTick`, `migrate` | `() -> ()` | |
| `onTimer` | `(name: i32) -> ()` | `String` address |
| `onInput` | `(key: i32, kind: i32) -> ()` | `String` addresses |
| `onTween` | `(id: i32, value: f64) -> ()` | |
| `test_<name>` | `() -> ()` | |
| `__setArgumentsLength` | `(n: i32) -> ()` | Added by asc when an export has optional parameters. Allowed, never called |

Any other export name, a non-function export, or a wrong signature is rejected by the loader. The manifest must be covered: interactions need `perform`, reactions need `onEvent`. At load the meter adds one more export, `__atw_fuel`, a mutable `i64` global.

## Strings and JSON across the boundary

**Module to host (a request).** The SDK builds the request as JSON text, encodes it as UTF-8 into an `ArrayBuffer` (`String.UTF8.encode`) and calls `host.call(ptr, len)` with that buffer's address and byte length. The host copies the bytes out of memory, decodes UTF-8, and parses the JSON. A request over 64 KB, out of bounds or not valid JSON gets a `bad_request` response without being run.

**Host to module (the response).** The host serializes the response, `{ "ok": true, "r": <result> }` or `{ "ok": false, "code": "<code>", "msg": "<reason>" }`, as UTF-8 JSON. It calls the module's `__atw_alloc(len)`, which returns the address of a fresh, pinned `ArrayBuffer` of exactly `len` bytes, writes the bytes there (re-reading `memory.buffer`, since the allocation may have grown memory), and returns that address from `host.call`. The SDK treats the address as an `ArrayBuffer` (its length is in the object header), unpins it, and decodes it with `String.UTF8.decode`. The allocation runs inside the module, so it costs the caller's fuel and counts against its memory.

**Host to module (handler arguments).** Strings passed to `perform`, `onEvent`, `onTimer` and `onInput` are AssemblyScript `String` objects, so system code receives ordinary `string` parameters. For each one the host calls `__atw_string(length)` (length in UTF-16 code units), writes the code units little-endian at the returned address, calls the handler with the addresses, and after a clean return calls `__atw_unpin` on each. Numbers pass as plain `i32` and `f64`.

**Module to host (an abort).** The SDK's `abort` stores the message and file name addresses and the line and column, then executes `unreachable`. After a trap the host reads them back through the `__atw_abort_*` exports (an AssemblyScript `String` is UTF-16 with its byte length in the 4 bytes before its address) to name the failure.

The `.js` bindings asc can generate are never produced or run.

## Fuel, traps and memory

Before every call into a module the host sets `__atw_fuel`; after the call it reads it back. The meter charges a static cost at every function entry and loop header and traps when fuel drops below zero. A call opens an account of 50M units (live handlers) or 500M (`migrate`, `test_*`); calls nested in the same transaction (an emit reaching another AI system) draw from the caller's account.

Any trap (fuel, memory, `abort`, an out-of-bounds access) ends the call. The host rolls back the transaction and, during live play, records a strike. The instance is then discarded and re-created with fresh memory on its next call, because the AssemblyScript runtime's state can't be trusted after a trap. Module globals never survive a reload anyway: lasting state lives in components, tags and `stateSet`.
