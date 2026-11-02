// Every base-system test (spec 9), each on a fresh 12x12 arena with all base systems loaded.
import { BASE_SYSTEMS } from "../src/systems/base";
import { arenaHost, runArenaTest } from "../src/engine/testrun";
import { testNames } from "../src/engine/systems";

const host = arenaHost(BASE_SYSTEMS);
for (const sys of host.systems.values()) {
  describe(`base system ${sys.id}`, () => {
    for (const name of testNames(sys.module)) {
      test(name.replace(/_/g, " "), () => {
        const r = runArenaTest(BASE_SYSTEMS, sys.id, name);
        const report = { error: r.error, failed: r.checks.filter((c) => !c.passed).map((c) => c.label), denied: r.denied };
        expect(report).toEqual({ error: null, failed: [], denied: expect.any(Array) });
        expect(r.checks.length).toBeGreaterThan(0);
        expect(r.passed).toBe(true);
      });
    }
  });
}
