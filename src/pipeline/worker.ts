// The pipeline Web Worker (spec 12): stages 1 to 5 with its own engine copies, plus
// recompiles at startup. The client's watchdog terminates it when a stage runs over.
import { handleMessage } from "./protocol";
import type { ToWorker } from "./types";

self.onmessage = (e: MessageEvent<ToWorker>) => { void handleMessage(e.data, (m) => self.postMessage(m)); };
// The compiler's modules use top-level await, so this script finishes evaluating late; a message
// sent before then would be lost. The client waits for this before sending anything.
self.postMessage({ type: "ready" });
