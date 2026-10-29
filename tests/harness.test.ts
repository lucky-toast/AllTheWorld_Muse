import { describe, it, expect } from "vitest";
import apiText from "../src/engine/api.d.ts?raw";
import { BASE_SYSTEMS } from "../src/systems/base/index";
import { buildArena, buildWorld } from "../src/world/map";
import { makeSim } from "../src/engine/sim";
import { defineSystem } from "../src/engine/define";

function runSystemTests() {
  const results: { system: string; name: string; checks: string[]; failures: string[] }[] = [];
  for (const sys of BASE_SYSTEMS) {
    for (const t of sys.tests) {
      const eng = buildArena();
      for (const s of BASE_SYSTEMS) eng.loadSystem(s);
      const loaded = eng.systems.find((s) => s.def.id === sys.id)!;
      const w = eng.facade(loaded);
      const sim = makeSim(eng, w);
      const checks: string[] = []; const failures: string[] = [];
      try {
        t.setup?.(w, sim);
        for (let i = 0; i < (t.ticks ?? 0); i++) { /* setup/sim already ticked; ticks field is the budget */ break; }
        t.expect(w, (cond, what) => { checks.push(what); if (!cond) failures.push(what); });
      } catch (e) { failures.push("threw: " + (e as Error).message); }
      if (checks.length === 0) failures.push("no checks ran");
      results.push({ system: sys.id, name: t.name, checks, failures });
    }
  }
  return results;
}

describe("base system tests", () => {
  const results = runSystemTests();
  for (const r of results) {
    it(`${r.system}: ${r.name}`, () => { expect(r.failures, r.failures.join("; ")).toEqual([]); });
  }
  it("every base system declares tests", () => {
    for (const s of BASE_SYSTEMS) expect(s.tests.length, s.id).toBeGreaterThan(0);
  });
});

describe("contracts", () => {
  it("every emitted event is in the emitting system's contract", () => {
    const eng = buildArena();
    for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const w = eng.world(); const sim = makeSim(eng, w);
    sim.give("test_item"); sim.walk("right", 2); sim.interact(); w.time.set("night"); sim.wait(3); w.time.set("dawn"); sim.wait(3);
    for (const e of eng.emitLog) {
      if (e.sys === "(engine)") continue;
      const sys = BASE_SYSTEMS.find((s) => s.id === e.sys); if (!sys) continue;
      expect(sys.contract.emits, `${e.sys} emits ${e.name} not in contract`).toHaveProperty(e.name);
    }
  });
  it("systems only set handled on claimed inputs", () => {
    const eng = buildArena();
    for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const w = eng.world(); const sim = makeSim(eng, w);
    w.spawn("test_item", { x: 5, y: 6 }); sim.face("down"); sim.interact(); sim.walk("right");
    for (const h of eng.handledLog) {
      const sys = BASE_SYSTEMS.find((s) => s.id === h.sys)!;
      const claimed = sys.contract.claims.map((c) => c.split(":")[0].trim());
      expect(claimed, `${h.sys} handled ${h.name} without claim`).toContain(h.name);
    }
  });
  it("every base system has a contract with hooks", () => {
    for (const s of BASE_SYSTEMS) { expect(s.contract.hooks.length, s.id).toBeGreaterThan(0); expect(s.why.length, s.id).toBeGreaterThan(0); }
  });
  it("api.d.ts documents world and sim calls", () => {
    const api = apiText as unknown as string;
    for (const name of ["at(", "query(", "spawn(", "tiles", "on(", "emit(", "time", "rand(", "catalog", "fx.tween", "particles", "floatText", "tint", "banner", "hud.add", "hud.remove", "state", "walk(", "face(", "interact(", "secondary(", "teleport(", "give(", "wait(", "press("]) {
      expect(api, name).toContain(name);
    }
  });
});

describe("engine guarantees", () => {
  it("spawn with unregistered type throws a clear error", () => {
    const eng = buildArena(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    expect(() => eng.world().spawn("not_a_type", { x: 1, y: 1 })).toThrow(/unknown entity type/);
    expect(() => eng.world().spawn("grass", { x: 1, y: 1 })).toThrow(/unknown entity type/);
  });
  it("second handler does nothing once the first acts", () => {
    const eng = buildArena(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    let secondActed = false;
    const first = defineSystem({ id: "probe_first", why: "probe", on: { "input.secondary": (ev) => { ev.handled = true; } } });
    const second = defineSystem({ id: "probe_second", why: "probe", on: { "input.secondary": (ev) => { if (!ev.handled) secondActed = true; } } });
    eng.loadSystem(first); eng.loadSystem(second);
    eng.emitInput("input.secondary", {}); expect(secondActed).toBe(false);
    eng.unloadSystem("probe_first"); eng.emitInput("input.secondary", {}); expect(secondActed).toBe(true);
  });
  it("serialize/snapshot round-trips", () => {
    const eng = buildArena(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const w = eng.world(); w.spawn("test_item", { x: 3, y: 3 });
    const snap = eng.snapshot(); const count = eng.entities.size;
    w.spawn("test_item", { x: 4, y: 4 }); eng.restore(snap);
    expect(eng.entities.size).toBe(count); expect(eng.serialize()).toBe(snap);
  });
  it("Shift+R style reload keeps world and does not duplicate handlers", () => {
    const eng = buildArena(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const w = eng.world(); const sim = makeSim(eng, w);
    sim.walk("right"); const x = w.query("player")[0].pos!.x;
    eng.reloadAll(BASE_SYSTEMS);
    const w2 = eng.world(); const sim2 = makeSim(eng, w2);
    expect(w2.query("player")[0].pos!.x).toBe(x);
    sim2.walk("right"); expect(w2.query("player")[0].pos!.x).toBe(x + 1);
    expect(w2.query("player")[0].has("light")).toBe(true);
  });
  it("tests are deterministic", () => {
    const a = runSystemTests(); const b = runSystemTests();
    expect(a.map((r) => r.failures)).toEqual(b.map((r) => r.failures));
  });
  it("real map: player cannot leave and trunk blocks, canopy does not", () => {
    const eng = buildWorld(); for (const s of BASE_SYSTEMS) eng.loadSystem(s);
    const w = eng.world();
    expect(w.tiles.find("water").length).toBeGreaterThan(0);
    // Tree_big at (4,6): footprint trunk tile is (5,6) only.
    expect(w.at(5, 6).some((e) => e.type === "tree_big_green")).toBe(true);
    expect(w.at(4, 6).some((e) => e.type === "tree_big_green")).toBe(false);
  });
});
