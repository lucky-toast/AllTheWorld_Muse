// The worker side of the pipeline protocol, shared by the real Web Worker (worker.ts) and
// the in-process stand-in Node tests use (inprocess.ts), so both run the same code.
import { runCheck, type CheckHooks } from "./stages";
import { compileSystem, formatCompileError } from "../sandbox/compile";
import type { FromWorker, ToWorker } from "./types";

export async function handleMessage(msg: ToWorker, post: (m: FromWorker) => void, renderShot?: CheckHooks["renderShot"]): Promise<void> {
  try {
    if (msg.type === "check") {
      const report = await runCheck(msg.req, { onStage: (event) => post({ type: "stage", event }), renderShot });
      post({ type: "done", report });
    } else if (msg.type === "compile") {
      const r = await compileSystem(msg.manifest, msg.source);
      post(r.ok ? { type: "compiled", ok: true, wasm: r.wasm } : { type: "compiled", ok: false, message: r.errors.map(formatCompileError).join("\n") });
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
