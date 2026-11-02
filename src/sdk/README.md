# AssemblyScript sandbox ABI

The ABI between a compiled AI system and the host is two sentences: a module imports exactly `host.call` and `env.memory`, and every other interaction with the world is a UTF-8 JSON request passed to `host.call` and a UTF-8 JSON response written back by the host. The host calls the module's exported handlers (`perform`, `onEvent`, `onTick`, `onTimer`, `onInput`, `onTween`, `migrate`, `test_*`, `shot_*`) directly, lowering strings itself, so a system never sees a pointer.

## Imports (exact, nothing else may be imported)

| Module | Name | Type |
| --- | --- | --- |
| `host` | `call` | `(reqPtr: i32, reqLen: i32, resPtr: i32, resCap: i32) -> i32` |
| `env` | `memory` | memory, initial size chosen by the host, maximum 256 pages (16 MB) |

`abort`, `trace` and `seed` are redirected at compile time to SDK functions (`--use abort=~lib/sdk/index/sdkAbort` and likewise for `trace` and `seed`), so no `env.abort`, `env.trace` or `env.seed` import remains. The `.js` bindings asc can generate are never run.

## Requests: module to host

The SDK encodes the request object (`{ "op": "<name>", ...fields }`, spec 4.2) as UTF-8 JSON. It passes a pointer to those bytes in the module's own memory and their byte length as `reqPtr` and `reqLen`. The request is at most 64 KB.

## Responses: host to module

The SDK also passes `resPtr` and `resCap`: a pointer to, and the capacity of, a 128 KB scratch buffer inside the module's memory that the SDK allocates once and exports no other way (the SDK's response allocator). The host writes the UTF-8 JSON response (`{ "ok": true, "r": <result> }` or `{ "ok": false, "code": "<code>", "msg": "<reason>" }`) into that buffer and returns the number of bytes written, or `-1` when the response does not fit. The SDK then decodes those bytes as UTF-8 JSON and unwraps `r` for the typed helper that made the request; a denial sets `lastErrorCode()` and `lastErrorMsg()` instead of throwing.

## Handler calls: host to module

Strings cross into the module as AssemblyScript strings. The host allocates each string with the module's exported runtime (`__new(byteLength, 2)`, the string type id, writing UTF-16 code units after the object header the runtime returns), pins it for the duration of the call, and passes the resulting pointer where the AssemblyScript signature expects a `string`. Integer arguments (`target`, `held`, tween `id`) are plain `i32`; the tween value is `f64`. Handlers that take no arguments are called with none. The host reads no return value: every effect is a `host.call` request.

## Fuel

After metering (spec 10.3 step 4) the binary also exports a mutable `i64` global named `__fuel`. The host sets it to the call budget before every handler call and reads it back afterwards; running it to zero traps. That global is added by the meter, never by the compiler, so a stored binary cannot opt out of it.
