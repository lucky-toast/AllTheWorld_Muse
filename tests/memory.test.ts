// Module memories: every AI module instance holds a WebAssembly.Memory, and a browser tab can
// only hold so many at once across all its threads. Finished worlds release theirs (Host.dispose),
// the World check never holds two copies of the world at once, and a worker that ran a check is
// ended instead of kept. Uses the hand-built minimal module from wasm.ts, so no compiler is needed.
import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { BASE_SYSTEMS } from "../src/systems/base";
import { aiSystem, moduleMemories, prepareModule, resetMemoryPeak, type AiSystemDef } from "../src/sandbox/module";
import { hostWith, worldCheck } from "../src/pipeline/worldcheck";
import { Pipeline, type LiveSide, type WorkerLike } from "../src/pipeline/client";
import type { FromWorker, Report, ToWorker } from "../src/pipeline/types";
import { baseModule } from "./wasm";
import { arena, testSystem } from "./helpers";

/** An AI system whose module exports an empty onTick: every tick runs it, so it makes its memory on the first one. */
function ticker(id: string): AiSystemDef {
  return aiSystem(prepareModule(baseModule({ funcs: [{ type: 4, body: [0x0b] }], exports: [{ name: "onTick", func: 8 }] }), { id, why: "Ticks, for the memory tests." }));
}
const live = () => moduleMemories().live;

describe("module memories", () => {
  test("a module makes its memory on its first call, and Host.dispose releases it", () => {
    const before = live();
    const a = arena({ after: [ticker("tick_a")] });
    expect(live()).toBe(before); // nothing ran yet: modules are created lazily
    a.ticks(1);
    expect(live()).toBe(before + 1);
    a.host.dispose();
    expect(live()).toBe(before);
    // A released module never makes a memory again.
    expect(() => a.host.systems.get("tick_a")!.module.onTick!()).toThrow(/after its world was released/);
    expect(live()).toBe(before);
  });

  test("worlds built and released one after another never hold more than one set at once", () => {
    const before = live();
    resetMemoryPeak();
    for (let i = 0; i < 40; i++) {
      const a = arena({ after: [ticker("tick_a"), ticker("tick_b"), ticker("tick_c")] });
      a.ticks(2);
      a.host.dispose();
    }
    expect(live()).toBe(before);
    expect(moduleMemories().peak - before).toBe(3);
  });

  test("Shift+R releases the old modules' memories when it re-creates them", () => {
    const a = arena({ after: [ticker("tick_a"), ticker("tick_b")] });
    a.ticks(1);
    const held = live();
    for (let i = 0; i < 5; i++) { a.host.reloadSystems(); a.ticks(1); }
    expect(live()).toBe(held);
    a.host.dispose();
  });

  test("base systems and modules without dispose are fine to release", () => {
    const a = arena({ after: [testSystem({ id: "plain" })] });
    expect(() => a.host.dispose()).not.toThrow();
  });

  test("the World check holds one copy of the world's memories at a time, and releases both", () => {
    const others = ["tick_a", "tick_b", "tick_c", "tick_d"].map(ticker);
    const candidate = ticker("tick_new");
    const liveCopy = (): Host => hostWith(buildWorld(), [...BASE_SYSTEMS, ...others].map((def) => ({ def, migrate: true })));
    const before = live();
    resetMemoryPeak();
    worldCheck(liveCopy, [...BASE_SYSTEMS, ...others], candidate, []);
    expect(live()).toBe(before);
    // One copy: the 4 loaded systems and the candidate. Before the fix, the re-created copy was
    // built while the first still held its memories: twice this.
    expect(moduleMemories().peak - before).toBe(others.length + 1);
  });
});

describe("pipeline workers", () => {
  /** Fake workers that answer a check with a passed-looking report, and a compile with bytes. */
  function fakes() {
    const made: { terminated: boolean }[] = [];
    const createWorker = (): WorkerLike => {
      const me = { terminated: false }; made.push(me);
      let handler: ((m: FromWorker) => void) | null = null;
      return {
        postMessage(msg: ToWorker) {
          setTimeout(() => {
            if (msg.type === "compile") handler?.({ type: "compiled", ok: true, wasm: new Uint8Array(8) });
            else handler?.({ type: "done", report: { ok: false, stage: "Tests", systemId: "x", errors: [{ message: "x" }], shots: [], durationMs: 1, log: [], stageMs: {} } as Report });
          }, 0);
        },
        terminate() { me.terminated = true; },
        setHandler(fn) { handler = fn; },
      };
    };
    const liveSide: LiveSide = { checkInputs: () => ({ loaded: [], loadedIds: [], world: "{}" }), load: async (r) => r };
    return { made, pipeline: new Pipeline({ createWorker, live: liveSide }) };
  }

  test("a worker that ran a check is ended, and a fresh spare starts in its place", async () => {
    const { made, pipeline } = fakes();
    await pipeline.checkSystem("{}", "");
    expect(made).toHaveLength(2);
    expect(made[0].terminated).toBe(true);
    expect(made[1].terminated).toBe(false);
    // The next check uses that spare, and ends it too.
    await pipeline.checkSystem("{}", "");
    expect(made).toHaveLength(3);
    expect(made[1].terminated).toBe(true);
  });

  test("a worker that only compiled is kept for the next job", async () => {
    const { made, pipeline } = fakes();
    await pipeline.compile({}, "");
    await pipeline.compile({}, "");
    expect(made).toHaveLength(1);
    expect(made[0].terminated).toBe(false);
  });
});
