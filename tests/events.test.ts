// Manifests (spec 5.1), the registry, the event bus (spec 8), timers and tweens.
import { arena, testSystem } from "./helpers";
import { validateManifest, checkManifestContext } from "../src/engine/manifest";
import { BASE_AREA } from "../src/engine/types";
import { LIMITS } from "../src/tuning";
import { BASE_SYSTEMS } from "../src/systems/base";

const good = {
  id: "chop", why: "Chop fallen logs with an axe to get branches.", buildsOn: ["carry"], replaces: [],
  entities: { axe: { sprite: "axe", tags: ["item"] } }, components: { chopTicks: "number: ticks a chop takes, on the axe" },
  interactions: [{ verb: "chop", label: "Chop", target: "log_fallen", held: "axe" }], reactions: [],
  emits: { "chop.chopped": { pos: "pos", log: "entity" } },
  shots: [{ name: "mid_chop", ticks: 30, focus: { x: 12, y: 8 }, time: "day" }],
};

describe("manifest", () => {
  test("the spec's example is valid, gets defaults, and is frozen", () => {
    const r = validateManifest(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.manifest)).toBe(true);
    expect(Object.isFrozen(r.manifest.interactions[0])).toBe(true);
    expect(Object.isFrozen(r.manifest.emits["chop.chopped"])).toBe(true);
    const min = validateManifest({ id: "tiny", why: "Small." });
    expect(min).toMatchObject({ ok: true, manifest: { buildsOn: [], replaces: [], entities: {}, interactions: [], reactions: [], emits: {}, shots: [] } });
  });
  test.each([
    [{ ...good, id: "Chop" }, /id must match/],
    [{ ...good, id: "time" }, /reserved/],
    [{ ...good, why: "" }, /why/],
    [{ ...good, entities: { dragon: { sprite: "dragon_huge", tags: [] } } }, /dragon_huge.*isn't in the catalog/],
    [{ ...good, emits: { "fire.lit": {} } }, /must start with "chop\."/],
    [{ ...good, emits: { "chop.x": { a: "float" } } }, /isn't one of/],
    [{ ...good, interactions: [{ verb: "chop", label: "Chop", target: "@@" }] }, /target/],
    [{ ...good, interactions: [{ verb: "chop", label: "Chop", target: "held", held: "" }] }, /held/],
    [{ ...good, shots: [{ name: "x", ticks: 1, focus: { x: 1 } }] }, /focus/],
    [{ ...good, colour: "red" }, /unknown field/],
  ])("rejects %#", (m, msg) => {
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("; ")).toMatch(msg);
  });
  test("base systems may use the engine's reserved prefixes; an inherited event needs no prefix", () => {
    expect(validateManifest({ id: "movement", why: "x", emits: { "player.moved": {} } }, { base: true }).ok).toBe(true);
    expect(validateManifest({ id: "movement2", why: "x", emits: { "player.moved": {} } }).ok).toBe(false);
    expect(validateManifest({ id: "fire2", why: "x", replaces: ["fire"], emits: { "fire.lit": {} } }, { inherited: ["fire.lit"] }).ok).toBe(true);
  });
  test("context checks: id unused, buildsOn loaded, reactions exist, named types exist", () => {
    const r = validateManifest({ ...good, reactions: ["item.dropped", "nobody.emits"], buildsOn: ["carry", "ghost"], interactions: [{ verb: "chop", label: "Chop", target: "log_fallen", held: "spade" }] });
    if (!r.ok) throw new Error(r.errors.join());
    const errs = checkManifestContext(r.manifest, { loaded: new Set(["carry", "chop"]), aiLoaded: new Set(["chop"]), events: new Set(["item.dropped"]), types: new Set(["log_fallen"]) });
    expect(errs.join("\n")).toMatch(/already loaded/);
    expect(errs.join("\n")).toMatch(/"ghost" isn't loaded/);
    expect(errs.join("\n")).toMatch(/no system emits "nobody.emits"/);
    expect(errs.join("\n")).toMatch(/no entity type "spade"/);
    expect(errs.join("\n")).not.toMatch(/item\.dropped/);
  });
  test("a host refuses to load an invalid manifest or a duplicate id", () => {
    const a = arena();
    expect(() => a.host.load(testSystem({ id: "bad", emits: { "fire.lit": {} } }))).toThrow(/must start with "bad\."/);
    expect(() => a.host.load(BASE_SYSTEMS[0])).toThrow(/already loaded/);
  });
});

describe("registry", () => {
  test("is built from every manifest in load order", () => {
    const a = arena({ after: [testSystem({ id: "late", reactions: ["player.moved"], entities: { lamp: { sprite: "crystal_blue", tags: [] } } })] });
    const reg = a.host.registry;
    expect(reg.order).toEqual(["movement", "carry", "push", "daynight", "late"]);
    expect(reg.interactions.map((i) => `${i.owner}:${i.verb}`)).toEqual(["carry:pick_up", "carry:drop"]);
    expect(reg.reactors("player.blocked")).toEqual(["push"]);
    expect(reg.reactors("player.moved")).toEqual(["late"]);
    expect(reg.eventOwner.get("player.moved")).toBe("movement");
    expect(reg.eventOwner.get("time.dusk")).toBe("daynight");
    expect(reg.eventOwner.get("interaction.performed")).toBe("@engine");
    expect(a.eng.types.has("lamp")).toBe(true);
    expect(a.eng.typeOwner.get("lamp")).toBe("late");
  });
});

/** A system that emits `<id>.ping` and records what reactors see. */
function pinger(shape: Record<string, string>) {
  return testSystem({ id: "pinger", emits: { "pinger.ping": shape } });
}

describe("event bus", () => {
  test("a system may emit only events it owns", () => {
    const a = arena({ after: [pinger({}), testSystem({ id: "other", emits: { "other.boom": {} } })] });
    for (const name of ["player.moved", "other.boom", "interaction.performed", "pinger.unknown"])
      expect(a.call("pinger", { op: "emit", name, payload: {} })).toMatchObject({ ok: false, code: "denied" });
    expect(a.call("pinger", { op: "emit", name: "pinger.ping", payload: {} })).toEqual({ ok: true, r: null });
  });
  test("the payload is checked against the declared shape", () => {
    const a = arena({ after: [pinger({ n: "number", s: "string", b: "bool", l: "list", o: "object", p: "pos", e: "entity" })] });
    const ok = { n: 1, s: "x", b: true, l: [1], o: { a: 1 }, p: { x: 1, y: 2 }, e: null };
    expect(a.call("pinger", { op: "emit", name: "pinger.ping", payload: ok })).toMatchObject({ ok: true });
    for (const bad of [{ ...ok, n: "1" }, { ...ok, extra: 1 }, (({ s: _s, ...rest }) => rest)(ok), { ...ok, p: { x: 1.5, y: 2 } }, { ...ok, e: "player" }, { ...ok, l: {} }])
      expect(a.call("pinger", { op: "emit", name: "pinger.ping", payload: bad })).toMatchObject({ ok: false, code: "denied" });
  });
  test("a payload with a fake entity type is corrected by the host to the real { id, type, pos }", () => {
    const got: unknown[] = [];
    const a = arena({ after: [pinger({ who: "entity", at: "pos" }), testSystem({ id: "ear", reactions: ["pinger.ping"] }, () => ({ onEvent(_n, p) { got.push(JSON.parse(p)); } }))] });
    a.call("pinger", { op: "emit", name: "pinger.ping", payload: { who: { id: a.player.id, type: "dragon", pos: { x: 0, y: 0 } }, at: { x: 3, y: 4 } } });
    expect(got).toEqual([{ who: { id: a.player.id, type: "player", pos: { x: 5, y: 5, area: BASE_AREA } }, at: { x: 3, y: 4, area: BASE_AREA } }]);
  });
  test("delivery reaches every reactor in load order, inside the emitter's transaction", () => {
    const order: string[] = [];
    const ear = (id: string) => testSystem({ id, reactions: ["pinger.ping"] }, (w) => ({ onEvent() { order.push(id); w.must("tag", { id: w.player(), tag: `heard_by_${id}` }); } }));
    const emitter = testSystem({ id: "pinger", emits: { "pinger.ping": {} } }, (w) => ({
      onTimer(name) { w.must("emit", { name: "pinger.ping", payload: {} }); if (name === "fail") throw new Error("trap after emit"); },
    }));
    const a = arena({ after: [ear("zeta"), emitter, ear("alpha")] });
    a.host.callHandler("pinger", "onTimer", (m) => m.onTimer!("ok"));
    expect(order).toEqual(["zeta", "alpha"]);
    expect(a.player.tags.has("heard_by_zeta") && a.player.tags.has("heard_by_alpha")).toBe(true);
    a.eng.setTag(a.player.id, "heard_by_zeta", false); a.eng.setTag(a.player.id, "heard_by_alpha", false);
    const res = a.host.callHandler("pinger", "onTimer", (m) => m.onTimer!("fail"));
    expect(res.ok).toBe(false);
    expect(order).toEqual(["zeta", "alpha", "zeta", "alpha"]);
    // The emitter failed after the emit, so the reactors' writes are rolled back with it.
    expect(a.player.tags.has("heard_by_zeta") || a.player.tags.has("heard_by_alpha")).toBe(false);
  });
  test("a reactor that throws rolls back the emitter's whole transaction; the fault names the reactor", () => {
    const a = arena({ after: [pinger({}), testSystem({ id: "bad_ear", reactions: ["pinger.ping"] }, () => ({ onEvent() { throw new Error("ear trap"); } }))] });
    const res = a.host.invoke("pinger", "onTick", () => { a.call("pinger", { op: "tag", id: a.player.id, tag: "pinged" }); a.call("pinger", { op: "emit", name: "pinger.ping", payload: {} }); });
    expect(res).toEqual({ ok: false, error: "ear trap" });
    expect(a.player.tags.has("pinged")).toBe(false);
    expect(a.host.faults.at(-1)).toMatchObject({ system: "bad_ear" });
  });
  test("nesting is capped at 16 levels", () => {
    let depth = 0; let denied: unknown = null;
    const echo = testSystem({ id: "echo", reactions: ["echo.ping"], emits: { "echo.ping": {} } }, (w) => ({
      onEvent() { depth++; const r = w.call({ op: "emit", name: "echo.ping", payload: {} }); if (!r.ok) denied = r; },
    }));
    const a = arena({ after: [echo] });
    const res = a.host.invoke("echo", "onTick", () => { a.call("echo", { op: "emit", name: "echo.ping", payload: {} }); });
    expect(res.ok).toBe(true);
    expect(depth).toBe(LIMITS.emitDepth);
    expect(denied).toMatchObject({ ok: false, code: "limit" });
  });
  test("two systems writing the same entity while handling one event are logged, not failed", () => {
    const writer = (id: string) => testSystem({ id, reactions: ["pinger.ping"] }, (w) => ({ onEvent() { w.must("set", { id: w.player(), comp: `${id}_mark`, value: 1 }); } }));
    const a = arena({ after: [pinger({}), writer("w1"), writer("w2")] });
    expect(a.call("pinger", { op: "emit", name: "pinger.ping", payload: {} })).toMatchObject({ ok: true });
    expect(a.host.overlaps).toEqual([{ tick: a.eng.tickCount, event: "pinger.ping", entity: a.player.id, systems: ["w1", "w2"] }]);
    expect(a.player.comps.get("w1_mark")).toBe(1); expect(a.player.comps.get("w2_mark")).toBe(1);
  });
  test("system.loaded and system.unloaded reach reactors (a system hears its own load)", () => {
    const got: string[] = [];
    const a = arena({ after: [testSystem({ id: "ear", reactions: ["system.loaded", "system.unloaded"] }, () => ({ onEvent(n, p) { got.push(`${n}:${JSON.parse(p).id}`); } }))] });
    a.host.load(testSystem({ id: "newcomer" }));
    a.host.unload("newcomer", "test");
    expect(got).toEqual(["system.loaded:ear", "system.loaded:newcomer", "system.unloaded:newcomer"]);
  });
});

describe("timers and tweens", () => {
  test("timer(ticks, name) calls onTimer(name), each its own transaction", () => {
    const fired: string[] = [];
    const a = arena({ after: [testSystem({ id: "clock" }, () => ({ onTimer(n) { fired.push(n); if (n === "bad") throw new Error("trap"); } }))] });
    a.call("clock", { op: "timer", ticks: 3, name: "bad" });
    a.call("clock", { op: "timer", ticks: 3, name: "good" });
    a.call("clock", { op: "timer", ticks: 5, name: "later" });
    a.ticks(2); expect(fired).toEqual([]);
    a.ticks(1); expect(fired).toEqual(["bad", "good"]);
    a.ticks(2); expect(fired).toEqual(["bad", "good", "later"]);
    expect(a.host.faults.map((f) => f.kind)).toEqual(["onTimer"]);
  });
  test("a timer firing after its entity was destroyed gets \"missing\", not a fault", () => {
    let res: unknown = null;
    const sys = testSystem({ id: "fuse" }, (w) => ({
      onTimer() { const id = w.r<number>("state.get")!; res = w.call({ op: "get", id, comp: "sprite" }); w.call({ op: "tag", id, tag: "lit" }); },
    }));
    const a = arena({ after: [sys] });
    const id = a.eng.spawn("test_item", { x: 2, y: 2, area: BASE_AREA }, "fuse").id;
    a.call("fuse", { op: "state.set", value: id });
    a.call("fuse", { op: "timer", ticks: 4, name: "boom" });
    a.call("fuse", { op: "destroy", id });
    a.ticks(4);
    expect(res).toMatchObject({ ok: false, code: "missing" });
    expect(a.host.faults).toEqual([]);
  });
  test("anim(..., callback) calls onTimer(callback) when a non-looping anim ends", () => {
    const fired: number[] = [];
    const a = arena({ after: [testSystem({ id: "chest" }, () => ({ onTimer() { fired.push(a.eng.tickCount); } }))] });
    const fire = a.eng.spawn("test_item", { x: 2, y: 2, area: BASE_AREA }, "chest").id;
    a.eng.setComp(fire, "sprite", { id: "fx_fire" });
    // fx_fire "ignite" is non-looping frames 0-3 (or as the catalog says) at its fps.
    const start = a.eng.tickCount;
    expect(a.call("chest", { op: "anim", id: fire, name: "ignite", callback: "lit" })).toMatchObject({ ok: true });
    a.ticks(600);
    expect(fired).toHaveLength(1);
    expect(fired[0] - start).toBeGreaterThan(1);
  });
  test("a timer set in a call that rolls back is dropped", () => {
    const fired: string[] = [];
    const a = arena({ after: [testSystem({ id: "clock" }, (w) => ({ onTick() { if (a.eng.tickCount === 1) { w.must("timer", { ticks: 2, name: "x" }); throw new Error("trap"); } }, onTimer(n) { fired.push(n); } }))] });
    a.ticks(10);
    expect(fired).toEqual([]);
  });
  test("fx.tween calls onTween(id, value) each tick from just past `from` to `to`", () => {
    const seen: [number, number][] = [];
    const a = arena({ after: [testSystem({ id: "fade" }, () => ({ onTween(id, v) { seen.push([id, v]); } }))] });
    const r = a.call("fade", { op: "fx.tween", from: 0, to: 1, ticks: 4 });
    expect(r).toMatchObject({ ok: true });
    a.ticks(6);
    const id = (r as { r: number }).r;
    expect(seen).toEqual([[id, 0.25], [id, 0.5], [id, 0.75], [id, 1]]);
  });
  test("timers and tweens are saved with the world", () => {
    const a = arena({ after: [testSystem({ id: "clock" })] });
    a.call("clock", { op: "timer", ticks: 50, name: "x" });
    a.call("clock", { op: "fx.tween", from: 0, to: 1, ticks: 50 });
    const s = a.eng.serialize();
    expect(JSON.parse(s).timers).toHaveLength(1);
    expect(JSON.parse(s).tweens).toHaveLength(1);
  });
});

describe("overlay", () => {
  test("ui.overlay shows a plain panel, null clears it, and unloading the owner clears it", () => {
    const a = arena({ after: [testSystem({ id: "fish" })] });
    expect(a.call("fish", { op: "ui.overlay", panel: { title: "Fishing", lines: ["Wait for a bite"], bar: { value: 0.4, label: "tension" } } })).toMatchObject({ ok: true });
    expect(a.eng.overlay).toEqual({ owner: "fish", value: { title: "Fishing", lines: ["Wait for a bite"], bar: { value: 0.4, label: "tension" } } });
    a.call("fish", { op: "ui.overlay", panel: null });
    expect(a.eng.overlay).toBeNull();
    a.call("fish", { op: "ui.overlay", panel: { lines: ["again"] } });
    a.host.unload("fish", "test");
    expect(a.eng.overlay).toBeNull();
  });
});
