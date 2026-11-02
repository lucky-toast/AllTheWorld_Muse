import { describe, expect, it } from "vitest";
import { buildWorld } from "../src/world/map";

function setup() {
  const eng = buildWorld();
  const player = eng.playerRec()!;
  return { eng, player };
}

describe("host dispatcher", () => {
  it("spawn of an unregistered type is denied", () => {
    const { eng } = setup();
    const r = eng.host.call("evil", { op: "spawn", type: "dragon", x: 10, y: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied");
    expect(eng.deniedLog.some((e) => e.system === "evil" && e.op === "spawn")).toBe(true);
  });

  it("destroy, lift and move of the player are blocked", () => {
    const { eng, player } = setup();
    for (const req of [
      { op: "destroy", id: player.id },
      { op: "lift", id: player.id },
      { op: "move", id: player.id, x: 10, y: 10 },
      { op: "place", id: player.id, x: 10, y: 10 },
    ]) {
      const r = eng.host.call("evil", req);
      expect(r.ok, req.op).toBe(false);
      if (!r.ok) expect(r.code).toBe("denied");
    }
    expect(eng.recById(player.id)?.pos).toEqual({ x: 15, y: 11, area: "clearing" });
  });

  it("tile.set under the player is blocked", () => {
    const { eng, player } = setup();
    const r = eng.host.call("evil", { op: "tile.set", x: player.pos!.x, y: player.pos!.y, sprite: "stream_h" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied");
    expect(eng.tileAt(player.pos!.x, player.pos!.y)).not.toBe("stream_h");
  });

  it("tint caps are blocked", () => {
    const { eng } = setup();
    const alpha = eng.host.call("evil", { op: "fx.tint", color: "#000000", alpha: 0.61, ms: 100 });
    const duration = eng.host.call("evil", { op: "fx.tint", color: "#000000", alpha: 0.5, ms: 3001 });
    expect(alpha.ok).toBe(false);
    expect(duration.ok).toBe(false);
    if (!alpha.ok) expect(alpha.code).toBe("denied");
    if (!duration.ok) expect(duration.code).toBe("denied");
    expect(eng.screenTint).toBeNull();
  });

  it("text caps are blocked", () => {
    const { eng, player } = setup();
    const long = "x".repeat(61);
    for (const req of [
      { op: "fx.float", x: player.pos!.x, y: player.pos!.y, text: long },
      { op: "fx.float", x: player.pos!.x, y: player.pos!.y, text: "bad\ntext" },
      { op: "ui.banner", text: long },
      { op: "ui.hud.add", key: "x", text: long, width: 10 },
    ]) {
      const r = eng.host.call("evil", req);
      expect(r.ok, req.op).toBe(false);
      if (!r.ok) expect(r.code).toBe("denied");
    }
    expect(eng.fxEffects).toEqual([]);
    expect(eng.banner).toBeNull();
    expect(eng.hudSlots.size).toBe(0);
  });

  it("rolls back the world after a failure mid-transaction", () => {
    const { eng, player } = setup();
    const before = eng.serialize();
    expect(() => eng.host.runInTransaction(() => {
      expect(eng.host.call("testsys", { op: "set", id: player.id, comp: "facing", value: "left" }).ok).toBe(true);
      expect(eng.host.call("testsys", { op: "tile.set", x: 15, y: 9, sprite: "grass_detail" }).ok).toBe(true);
      expect(eng.host.call("testsys", { op: "spawn", type: "branch", x: 15, y: 9 }).ok).toBe(true);
      throw new Error("forced failure");
    })).toThrow("forced failure");
    const after = JSON.parse(eng.serialize()) as { nextId: number };
    const beforeParsed = JSON.parse(before) as { nextId: number };
    // Spawned ids are never reused, so only the id counter may differ.
    after.nextId = beforeParsed.nextId;
    expect(JSON.stringify(after)).toBe(JSON.stringify(beforeParsed));
    expect(eng.validateOccupancy()).toBe(true);
  });

  it("later-phase requests return a phase denial for now", () => {
    const { eng } = setup();
    for (const op of ["emit", "focus", "timer", "sim.walk", "check"]) {
      const r = eng.host.call("testsys", { op });
      expect(r.ok, op).toBe(false);
      if (!r.ok) expect(r.code).toBe("phase");
    }
  });
});
