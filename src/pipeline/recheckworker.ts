// The Load recheck's Web Worker (see recheck.ts): one World check on the live world, then it is
// ended. It imports the engine and the sandbox, not the compiler, so it starts quickly.
import { runRecheck, type RecheckRequest } from "./recheck";

self.onmessage = (e: MessageEvent<RecheckRequest>) => {
  try { self.postMessage({ type: "done", result: runRecheck(e.data) }); }
  catch (err) { self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }); }
};
self.postMessage({ type: "ready" });
