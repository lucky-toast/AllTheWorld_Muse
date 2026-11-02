import { readFileSync } from "node:fs";
import { buildArena, buildWorld } from "../src/world/map";
import { Engine } from "../src/engine/engine";
import { FixedLoop } from "../src/engine/loop";
import { BASE_AREA, WORLD_OWNER } from "../src/engine/types";
import { TUNING } from "../src/tuning";

const golden = JSON.parse(readFileSync(new URL("./golden/map-24531c5.json", import.meta.url), "utf-8")) as {
  tiles: string[][]; entities: { id: number; type: string; pos: { x: number; y: number }; tags: string[]; comps: Record<string, unknown> }[];
};

describe("map", () => {
  test("is identical to commit 24531c5 (tiles, entity ids, types, positions, tags, components)", () => {
    const eng = buildWorld();
    expect(eng.areas.get(BASE_AREA)!.tiles).toEqual(golden.tiles);
    const now = [...eng.entities.values()].map((r) => ({ id: r.id, type: r.type, pos: { x: r.pos!.x, y: r.pos!.y }, tags: [...r.tags], comps: Object.fromEntries(r.comps) }));
    expect(now).toEqual(golden.entities);
    expect([...eng.entities.values()].every((r) => r.pos!.area === BASE_AREA)).toBe(true);
  });
  test("satisfies every invariant", () => {
    expect(buildWorld().invariantProblems()).toEqual([]);
  });
});

describe("occupancy and footprints", () => {
  test("a 1x2 log covers two tiles, extending upward from pos", () => {
    const eng = buildArena();
    const log = eng.spawn("log_fallen", { x: 3, y: 6, area: BASE_AREA }, WORLD_OWNER);
    expect(eng.at(BASE_AREA, 3, 6)).toContain(log.id);
    expect(eng.at(BASE_AREA, 3, 5)).toContain(log.id);
    expect(eng.at(BASE_AREA, 3, 7)).not.toContain(log.id);
    expect(eng.isFreeFor(BASE_AREA, 3, 5)).toBe(false);
    expect(eng.isFreeFor(BASE_AREA, 3, 6)).toBe(false);
  });
  test("a 3-wide tree blocks only its trunk", () => {
    const eng = buildArena();
    const tree = eng.spawn("tree_big_green", { x: 2, y: 8, area: BASE_AREA }, WORLD_OWNER);
    expect(eng.at(BASE_AREA, 3, 8)).toEqual([tree.id]);
    for (const [x, y] of [[2, 8], [4, 8], [3, 7], [3, 6], [2, 7], [4, 7]]) {
      expect(eng.at(BASE_AREA, x, y)).toEqual([]);
      expect(eng.isFreeFor(BASE_AREA, x, y)).toBe(true);
    }
    expect(eng.isFreeFor(BASE_AREA, 3, 8)).toBe(false);
  });
  test("moving, lifting, placing, sprite changes and destroy keep occupancy exact", () => {
    const eng = buildArena();
    const log = eng.spawn("log_fallen", { x: 3, y: 6, area: BASE_AREA }, WORLD_OWNER);
    eng.setPos(log.id, { x: 7, y: 9, area: BASE_AREA }, true);
    expect(eng.at(BASE_AREA, 3, 6)).toEqual([]);
    expect(eng.at(BASE_AREA, 7, 8)).toEqual([log.id]);
    eng.setComp(log.id, "sprite", { id: "stone" });
    expect(eng.at(BASE_AREA, 7, 8)).toEqual([]);
    expect(eng.at(BASE_AREA, 7, 9)).toEqual([log.id]);
    eng.setPos(log.id, null);
    expect(eng.at(BASE_AREA, 7, 9)).toEqual([]);
    eng.setPos(log.id, { x: 1, y: 1, area: BASE_AREA });
    expect(eng.validateOccupancy()).toBe(true);
    eng.destroy(log.id);
    expect(eng.at(BASE_AREA, 1, 1)).toEqual([]);
    expect(eng.validateOccupancy()).toBe(true);
  });
  test("decorations don't block, water and the map edge do", () => {
    const eng = buildWorld();
    // fern at (21, 8) is a decoration
    expect(eng.at(BASE_AREA, 21, 8).length).toBe(1);
    expect(eng.isFreeFor(BASE_AREA, 21, 8)).toBe(true);
    expect(eng.isFreeFor(BASE_AREA, 5, 16)).toBe(false); // stream
    expect(eng.isFreeFor(BASE_AREA, -1, 5)).toBe(false);
    expect(eng.isFreeFor(BASE_AREA, 30, 5)).toBe(false);
  });
});

describe("areas", () => {
  test("an entity in another area doesn't block or appear in at() for the current one", () => {
    const eng = buildWorld();
    eng.createArea("cave.inside", Array.from({ length: 20 }, () => Array(30).fill("grass")), "cave");
    const rock = eng.spawn("rock_gray", { x: 15, y: 9, area: "cave.inside" }, WORLD_OWNER);
    expect(eng.currentArea()).toBe(BASE_AREA);
    expect(eng.at(BASE_AREA, 15, 9)).toEqual([]);
    expect(eng.isFreeFor(BASE_AREA, 15, 9)).toBe(true);
    expect(eng.at("cave.inside", 15, 9)).toEqual([rock.id]);
    expect(eng.isFreeFor("cave.inside", 15, 9)).toBe(false);
    expect(eng.validateOccupancy()).toBe(true);
  });
});

describe("serialize", () => {
  test("serialize then deserialize is identical, with two areas", () => {
    const eng = buildWorld();
    eng.createArea("cave.inside", Array.from({ length: 20 }, () => Array(30).fill("grass_dark")), "cave");
    eng.spawn("crate", { x: 4, y: 4, area: "cave.inside" }, "cave");
    eng.setTile("cave.inside", 2, 2, "grass");
    eng.setState("cave", { lit: true, n: [1, 2] });
    eng.rand("cave"); eng.rand("other");
    eng.declareComponent("glow", "cave");
    for (let i = 0; i < 10; i++) eng.tick();
    const s = eng.serialize();
    const copy = new Engine(30, 20);
    copy.deserialize(s);
    expect(copy.serialize()).toBe(s);
    expect(copy.validateOccupancy()).toBe(true);
    expect(copy.at("cave.inside", 4, 4).length).toBe(1);
    expect(copy.entityOwner.get(copy.at("cave.inside", 4, 4)[0])).toBe("cave");
    // RNG positions are saved: the next number matches.
    expect(copy.rand("cave")).toBe(eng.rand("cave"));
  });
  test("snapshot and restore bring the world back", () => {
    const eng = buildWorld();
    const snap = eng.snapshot();
    eng.spawn("crate", { x: 15, y: 8, area: BASE_AREA }, WORLD_OWNER);
    eng.setTile(BASE_AREA, 1, 1, "grass");
    eng.restore(snap);
    expect(eng.serialize()).toBe(snap);
  });
});

describe("rng", () => {
  test("two systems' streams are independent", () => {
    const a = buildWorld();
    const solo = [1, 2, 3, 4, 5].map(() => a.rand("alpha"));
    const b = buildWorld();
    const mixed: number[] = [];
    for (let i = 0; i < 5; i++) { b.rand("beta"); mixed.push(b.rand("alpha")); b.rand("beta"); }
    expect(mixed).toEqual(solo);
    const beta = buildWorld();
    expect([1, 2, 3, 4, 5].map(() => beta.rand("beta"))).not.toEqual(solo);
    expect(solo.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe("clock and loop", () => {
  test("the clock only advances while running, and the day goes up at dawn", () => {
    const eng = buildWorld();
    for (let i = 0; i < 100; i++) eng.tick();
    expect(eng.hour).toBe(TUNING.startHour);
    eng.clockRunning = true; eng.jumpClock(4.99);
    for (let i = 0; i < 10; i++) eng.tick();
    expect(eng.day).toBe(2);
    expect(eng.phase).toBe("dawn");
    expect(eng.jumpClock("night").to).toBe(TUNING.phases.night);
  });
  test("the fixed-step loop runs whole ticks and caps a stalled frame", () => {
    const loop = new FixedLoop(); let n = 0;
    expect(loop.advance(1000 / 60 * 3 + 1, () => n++)).toBe(3);
    expect(loop.advance(10_000, () => n++)).toBe(Math.floor((TUNING.maxFrameMs + 1) / (1000 / 60)));
  });
});
