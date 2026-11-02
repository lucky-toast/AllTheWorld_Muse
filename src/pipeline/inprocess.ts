// A stand-in for the pipeline Web Worker that runs the same protocol handler in this
// thread (Node tests). Messages are delivered asynchronously, as with a real worker.
// terminate() drops every later message; it can't stop code that is already running.
import { handleMessage } from "./protocol";
import type { WorkerLike } from "./client";
import type { FromWorker, ToWorker } from "./types";

export function inProcessWorker(): WorkerLike {
  let handler: ((m: FromWorker) => void) | null = null;
  let dead = false;
  return {
    postMessage(msg) {
      setTimeout(() => { if (!dead) void handleMessage(msg as ToWorker, (m) => { if (!dead) setTimeout(() => { if (!dead) handler?.(m); }, 0); }); }, 0);
    },
    terminate() { dead = true; },
    setHandler(fn) { handler = fn; },
  };
}
