import { buildWorld } from "../src/world/map";
import { Host } from "../src/engine/host";
import { BASE_AREA } from "../src/engine/types";

function setup() {
  const eng = buildWorld();
  const host = new Host(eng);
  host.addSystem({ id: "tester", entities: { spark: { sprite: "fx_spark", tags: [] } }, emits: { "tester.ping": { n: "number" } } }, false);
  host.addSystem({ id: "movement" }, true);
  const player = eng.player()!;
  return { eng, host, player, call: (req: Record<string, unknown>, sys = "tester") => host.call(sys, req as { op: string }) };
}
const denied = (res: { ok: boolean }, code = "denied") => expect(res).toMatchObject({ ok: false, code });

describe("host basics", () => {
  test("reads go through the dispatcher", () => {
    const { call, player } = setup();
    expect(call({ op: "query", with: "player" })).toEqual({ ok: true, r: { ids: [player.id], truncated: false } });
    expect(call({ op: "at", x: 15, y: 11 })).toEqual({ ok: true, r: [player.id] });
    expect(call({ op: "info", id: player.id })).toEqual({ ok: true, r: { type: "player", pos: { x: 15, y: 11, area: BASE_AREA }, tags: ["player"] } });
    expect(call({ op: "get", id: player.id, comp: "facing" })).toEqual({ ok: true, r: "down" });
    expect(call({ op: "tile.get", x: 99, y: 0 })).toEqual({ ok: true, r: null });
    expect(call({ op: "time" })).toMatchObject({ ok: true, r: { day: 1, phase: "day" } });
    expect(call({ op: "area.current" })).toEqual({ ok: true, r: BASE_AREA });
  });
  test("spawn of an unregistered type is denied", () => {
    const { call, eng } = setup();
    const before = eng.entities.size;
    denied(call({ op: "spawn", type: "dragon_huge", x: 15, y: 8 }));
    denied(call({ op: "spawn", type: "axe", x: 15, y: 8 })); // a catalog sprite, but not a registered type
    expect(eng.entities.size).toBe(before);
    expect(call({ op: "spawn", type: "spark", x: 15, y: 8 })).toMatchObject({ ok: true });
  });
  test("bad shapes, unknown ops and gone entities", () => {
    const { call, eng } = setup();
    denied(call({ op: "nope" }), "bad_request");
    denied(call({ op: "spawn", type: "crate", x: 1.5, y: 8 }), "bad_request");
    denied(call({ op: "spawn", type: "crate", x: 30, y: 8 }), "bad_request");
    denied(call({ op: "spawn", type: "crate", x: 3, y: 8, extra: 1 }), "bad_request");
    denied(call({ op: "set", id: 1, comp: "x", value: () => 1 }), "bad_request");
    denied(call({ op: "set", id: 1, comp: "x", value: "y".repeat(70_000) }), "bad_request");
    denied(call({ op: "query", with: "player" }, "stranger"));
    const id = (call({ op: "spawn", type: "crate", x: 15, y: 8 }) as { r: number }).r;
    eng.destroy(id);
    denied(call({ op: "get", id, comp: "sprite" }), "missing");
  });
  test("test-only requests are refused outside tests", () => {
    const { call, host } = setup();
    denied(call({ op: "sim.wait", ticks: 1 }), "phase");
    denied(call({ op: "check", cond: true, label: "x" }), "phase");
    host.mode = "test";
    expect(call({ op: "sim.wait", ticks: 1 })).toMatchObject({ ok: true });
    denied(call({ op: "state.getReplaced", id: "old" }), "phase");
  });
});

describe("blocked actions (4.3)", () => {
  test("destroying the player is denied", () => {
    const { call, player, eng } = setup();
    denied(call({ op: "destroy", id: player.id }));
    expect(eng.player()).toBe(player);
  });
  test("lifting the player is denied", () => {
    const { call, player } = setup();
    denied(call({ op: "lift", id: player.id }));
    expect(player.pos).toEqual({ x: 15, y: 11, area: BASE_AREA });
  });
  test("moving or placing the player is denied, except for base movement", () => {
    const { call, player } = setup();
    denied(call({ op: "move", id: player.id, x: 15, y: 10 }));
    denied(call({ op: "place", id: player.id, x: 15, y: 10 }));
    expect(player.pos).toEqual({ x: 15, y: 11, area: BASE_AREA });
    expect(call({ op: "move", id: player.id, x: 15, y: 10 }, "movement")).toMatchObject({ ok: true });
    expect(player.pos).toEqual({ x: 15, y: 10, area: BASE_AREA });
  });
  test("tile.set can't make the tile under the player unwalkable", () => {
    const { call, eng } = setup();
    denied(call({ op: "tile.set", x: 15, y: 11, sprite: "stream_h" }));
    expect(eng.tileAt(BASE_AREA, 15, 11)).not.toBe("stream_h");
    expect(call({ op: "tile.set", x: 15, y: 11, sprite: "grass_dark" })).toMatchObject({ ok: true });
    expect(call({ op: "tile.set", x: 15, y: 14, sprite: "stream_h" })).toMatchObject({ ok: true });
  });
  test("emitting an event the caller doesn't own is denied", () => {
    const { call } = setup();
    expect(call({ op: "emit", name: "player.moved", payload: {} })).toMatchObject({ ok: false, code: "denied", msg: expect.stringMatching(/doesn't own/) });
  });
  test("fx.tint is capped at alpha 0.6 and 3 s", () => {
    const { call, eng } = setup();
    denied(call({ op: "fx.tint", color: "#000000", alpha: 0.7, ms: 500 }));
    denied(call({ op: "fx.tint", color: "#000000", alpha: 0.5, ms: 3001 }));
    expect(eng.tint).toBeNull();
    expect(call({ op: "fx.tint", color: "#000000", alpha: 0.6, ms: 3000 })).toMatchObject({ ok: true });
    expect(eng.tint).not.toBeNull();
  });
  test("ui and float text over 60 characters or non-printable is denied", () => {
    const { call, eng } = setup();
    denied(call({ op: "ui.banner", text: "x".repeat(61) }));
    denied(call({ op: "ui.banner", text: "bell\u0007" }));
    denied(call({ op: "fx.float", text: "y".repeat(61), x: 3, y: 3 }));
    denied(call({ op: "ui.hud.add", key: "k", text: "tab\there", width: 8 }));
    denied(call({ op: "ui.overlay", panel: { title: "ok", lines: ["z".repeat(61)] } }));
    expect(eng.banner).toBeNull();
    expect(call({ op: "ui.banner", text: "x".repeat(60) })).toMatchObject({ ok: true });
    expect(eng.banner?.text).toBe("x".repeat(60));
  });
});

describe("invariants", () => {
  test("a write that would put a footprint on water is denied and undone", () => {
    const { call, eng } = setup();
    const before = eng.serialize();
    denied(call({ op: "spawn", type: "crate", x: 5, y: 16, exact: true }));
    const crate = eng.query("crate")[0];
    denied(call({ op: "move", id: crate, x: 5, y: 16, instant: true }));
    denied(call({ op: "tile.set", x: 17, y: 9, sprite: "stream_h" })); // under the crate
    denied(call({ op: "untag", id: eng.player()!.id, tag: "player" }));
    expect(eng.serialize()).toBe(before);
  });
});

describe("transactions (4.4)", () => {
  test("a failure mid-transaction rolls the world back and drops queued effects", () => {
    const { host, eng, call } = setup();
    const before = eng.serialize();
    const res = host.invoke("tester", "onTick", () => {
      const id = (call({ op: "spawn", type: "spark", x: 15, y: 8 }) as { r: number }).r;
      call({ op: "set", id, comp: "glow", value: { a: 1 } });
      call({ op: "tile.set", x: 2, y: 2, sprite: "grass" });
      call({ op: "move", id: eng.query("crate")[0], x: 16, y: 9 });
      call({ op: "destroy", id: eng.query("stone")[0] });
      call({ op: "area.create", name: "cave", fill: "grass" });
      call({ op: "state.set", value: { n: 1 } });
      call({ op: "rand" });
      call({ op: "ui.banner", text: "should never show" });
      call({ op: "fx.particles", sprite: "fx_spark", x: 3, y: 3 });
      throw new Error("trap");
    });
    expect(res).toEqual({ ok: false, error: "trap" });
    expect(eng.serialize()).toBe(before);
    expect(eng.validateOccupancy()).toBe(true);
    expect(eng.banner).toBeNull();
    expect(eng.particles).toEqual([]);
    expect(host.inTransaction).toBe(false);
  });
  test("a call that finishes commits its writes and effects", () => {
    const { host, eng, call } = setup();
    const res = host.invoke("tester", "onTick", () => {
      call({ op: "spawn", type: "spark", x: 15, y: 8 });
      call({ op: "ui.banner", text: "hello" });
      expect(eng.banner).toBeNull(); // queued until commit
    });
    expect(res).toEqual({ ok: true });
    expect(eng.banner?.text).toBe("hello");
    expect([...eng.entities.values()].some((r) => r.type === "spark")).toBe(true);
  });
});

describe("areas and travel", () => {
  test("area.create, spawn into it, and travel to a free tile", () => {
    const { call, eng, player } = setup();
    const r = call({ op: "area.create", name: "cave", fill: "grass_dark" });
    expect(r).toEqual({ ok: true, r: "tester.cave" });
    denied(call({ op: "area.create", name: "cave", fill: "grass_dark" }));
    denied(call({ op: "area.create", name: "pool", fill: "crate" }), "bad_request");
    // Terrain nobody can stand on is refused as a fill: the area would have no room for anything.
    denied(call({ op: "area.create", name: "pit", fill: "pit_fill" }), "bad_request");
    denied(call({ op: "area.create", name: "lake", fill: "stream_h" }), "bad_request");
    // Interior floors are walkable, so a room can be made of one.
    expect(call({ op: "area.create", name: "room", fill: "interior_floor_brown_plain" })).toMatchObject({ ok: true });
    expect(call({ op: "spawn", type: "crate", x: 5, y: 5, area: "tester.room" })).toMatchObject({ ok: true });
    expect(call({ op: "spawn", type: "crate", x: 15, y: 11, area: "tester.cave" })).toMatchObject({ ok: true });
    expect(call({ op: "at", x: 15, y: 11 })).toEqual({ ok: true, r: [player.id] });
    denied(call({ op: "travel", area: "tester.cave", x: 15, y: 11 }));
    expect(player.pos!.area).toBe(BASE_AREA);
    expect(call({ op: "travel", area: "tester.cave", x: 4, y: 4 })).toMatchObject({ ok: true });
    expect(player.pos).toEqual({ x: 4, y: 4, area: "tester.cave" });
    expect(call({ op: "area.current" })).toEqual({ ok: true, r: "tester.cave" });
    expect(eng.validateOccupancy()).toBe(true);
    expect(call({ op: "area.list" })).toEqual({ ok: true, r: [BASE_AREA, "tester.cave", "tester.room"] });
  });
  test("travel to a blocked tile is denied", () => {
    const { call, player } = setup();
    denied(call({ op: "travel", area: BASE_AREA, x: 5, y: 16 })); // stream
    denied(call({ op: "travel", area: BASE_AREA, x: 17, y: 9 })); // crate
    denied(call({ op: "travel", area: BASE_AREA, x: 5, y: 6 }));  // trunk of the big tree at (4, 6)
    expect(player.pos).toEqual({ x: 15, y: 11, area: BASE_AREA });
    expect(call({ op: "travel", area: BASE_AREA, x: 4, y: 6 })).toMatchObject({ ok: true }); // beside the trunk
  });
});

describe("limits and logs (4.7)", () => {
  test("denials are logged, and using over half a limit is logged once", () => {
    const { call, host, eng } = setup();
    call({ op: "destroy", id: eng.player()!.id });
    expect(host.denials.at(-1)).toMatchObject({ system: "tester", op: "destroy", code: "denied" });
    for (let i = 0; i < 101; i++) call({ op: "spawn", type: "spark", x: 15, y: 8 });
    expect(host.nearLimits.filter((n) => n.limit === "spawnsPerTick")).toHaveLength(1);
  });
  test("spawns per tick are capped", () => {
    const { call, host } = setup();
    let ok = 0; for (let i = 0; i < 205; i++) if (call({ op: "spawn", type: "spark", x: 15, y: 8 }).ok) ok++;
    expect(ok).toBe(200);
    expect(host.denials.at(-1)).toMatchObject({ code: "limit" });
    host.tick();
    expect(call({ op: "spawn", type: "spark", x: 15, y: 8 }).ok).toBe(true);
  });
  test("particles over the per-tick cap are dropped, banners are rate limited", () => {
    const { call, eng, host } = setup();
    for (let i = 0; i < 3; i++) call({ op: "fx.particles", sprite: "fx_spark", x: 3, y: 3, count: 30 });
    expect(eng.particles.length).toBe(64);
    expect(call({ op: "ui.banner", text: "a" })).toEqual({ ok: true, r: { shown: true } });
    expect(call({ op: "ui.banner", text: "b" })).toEqual({ ok: true, r: { shown: false } });
    for (let i = 0; i < 120; i++) host.tick();
    expect(call({ op: "ui.banner", text: "c" })).toEqual({ ok: true, r: { shown: true } });
  });
  test("rand comes from the caller's own stream", () => {
    const a = setup(); const b = setup();
    b.host.addSystem({ id: "other" }, false);
    const solo = [0, 1, 2].map(() => (a.call({ op: "rand" }) as { r: number }).r);
    const mixed = [0, 1, 2].map(() => { b.call({ op: "rand" }, "other"); return (b.call({ op: "rand" }) as { r: number }).r; });
    expect(mixed).toEqual(solo);
  });
});
