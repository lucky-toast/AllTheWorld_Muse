import { describe, expect, it } from "vitest";
import { buildArena, buildWorld } from "../src/world/map";

function entityAt(eng: ReturnType<typeof buildWorld>, type: string, x: number, y: number, area = "clearing") {
  return [...eng.entities.values()].find((r) => r.type === type && r.pos?.x === x && r.pos?.y === y && r.pos.area === area);
}

describe("engine, areas and occupancy", () => {
  it("a 1x2 log covers two tiles", () => {
    const eng = buildWorld();
    const log = entityAt(eng, "log_fallen", 12, 8)!;
    expect(eng.atIds(12, 8)).toContain(log.id);
    expect(eng.atIds(12, 7)).toContain(log.id);
    expect(eng.atIds(12, 9)).not.toContain(log.id);
    expect(eng.validateOccupancy()).toBe(true);
  });

  it("a 3-wide tree blocks only its trunk tile", () => {
    const eng = buildWorld();
    const tree = entityAt(eng, "tree_big_green", 4, 6)!;
    // The sprite is 48px wide, but its footprint is the middle tile only.
    expect(eng.atIds(5, 6)).toContain(tree.id);
    expect(eng.atIds(4, 6)).not.toContain(tree.id);
    expect(eng.atIds(6, 6)).not.toContain(tree.id);
  });

  it("serialize then deserialize is identical, with two areas", () => {
    const eng = buildWorld();
    const area = eng.host.call("forest", { op: "area.create", name: "east", fill: "grass" });
    expect(area).toEqual({ ok: true, r: "forest.east" });
    expect(eng.host.call("forest", { op: "spawn", type: "branch", x: 4, y: 4, area: "forest.east" }).ok).toBe(true);
    const before = eng.serialize();
    eng.restore(before);
    expect(eng.serialize()).toBe(before);
    expect(eng.areaOrder).toEqual(["clearing", "forest.east"]);
  });

  it("an entity in another area doesn't block or appear in at() for the current one", () => {
    const eng = buildWorld();
    expect(eng.host.call("forest", { op: "area.create", name: "east", fill: "grass" }).ok).toBe(true);
    const spawned = eng.host.call("forest", { op: "spawn", type: "tree_big_green", x: 15, y: 9, area: "forest.east" });
    expect(spawned.ok).toBe(true);
    const otherId = spawned.ok ? spawned.r as number : -1;
    expect(eng.atIds(16, 9, "clearing")).not.toContain(otherId);
    expect(eng.atIds(16, 9, "forest.east")).toContain(otherId);
    expect(eng.isFreeFor(15, 9, 0, "clearing")).toBe(true);
  });

  it("travel to a blocked tile is denied", () => {
    const eng = buildArena();
    expect(eng.host.call("forest", { op: "area.create", name: "east", fill: "grass" }).ok).toBe(true);
    expect(eng.host.call("forest", { op: "spawn", type: "test_block", x: 5, y: 5, area: "forest.east" }).ok).toBe(true);
    const blocked = eng.host.call("travel", { op: "travel", area: "forest.east", x: 5, y: 5 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("denied");
    expect(eng.currentAreaId).toBe("clearing");
    const clear = eng.host.call("travel", { op: "travel", area: "forest.east", x: 6, y: 5 });
    expect(clear).toEqual({ ok: true, r: true });
    expect(eng.currentAreaId).toBe("forest.east");
    expect(eng.playerRec()?.pos).toEqual({ x: 6, y: 5, area: "forest.east" });
  });

  it("two systems' RNG streams are independent", () => {
    const eng = buildArena();
    const a1 = eng.host.call("alpha", { op: "rand" });
    const a2 = eng.host.call("alpha", { op: "rand" });
    const b1 = eng.host.call("beta", { op: "rand" });

    const fresh = buildArena();
    const freshA1 = fresh.host.call("alpha", { op: "rand" });
    const freshA2 = fresh.host.call("alpha", { op: "rand" });
    const freshB1 = fresh.host.call("beta", { op: "rand" });
    expect([a1, a2, b1]).toEqual([freshA1, freshA2, freshB1]);
    expect(a1).not.toEqual(b1);
  });
});
