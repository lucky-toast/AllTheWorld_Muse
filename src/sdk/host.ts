// Internal: the one import. A request leaves as UTF-8 JSON (pointer + length); the
// host writes the UTF-8 JSON response into an ArrayBuffer it allocates through the
// exported __atw_alloc (pinned), and returns that buffer's pointer. See README.md.

@external("host", "call")
declare function host_call(ptr: usize, len: i32): usize;

/** Send one JSON request to the host and return the JSON response text. */
export function callHost(json: string): string {
  const req = String.UTF8.encode(json);
  const ptr = host_call(changetype<usize>(req), req.byteLength);
  const res = changetype<ArrayBuffer>(ptr);
  __unpin(ptr);
  return String.UTF8.decode(res);
}
