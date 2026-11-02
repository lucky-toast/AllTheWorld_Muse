// The E resolver (spec 6): each ranking rule on its own, the Q cycle and its reset,
// perform and interaction.performed, travel through a door, and Shift+R.
import { arena, testSystem } from "./helpers";
import { drawnEntities } from "../src/engine/render";
import { BASE_AREA } from "../src/engine/types";

/** A system with one interaction (verb = label lowercased). */
const act = (id: string, label: string, target: string, held?: string) =>
  testSystem({ id, interactions: [{ verb: label.toLowerCase().replace(/ /g, "_"), label, target, ...(held ? { held } : {}) }] }, () => ({ perform() {} }));

/** Spawn a daisy (a flower decoration: doesn't block, tags flower/plant/decor) on the faced tile (5, 6). */
function faceDaisy(a: ReturnType<typeof arena>) { a.eng.spawn("daisy", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh(); }
/** Put a test_item in the player's hands. */
function holdItem(a: ReturnType<typeof arena>) {
  const r = a.eng.spawn("test_item", null, "@world"); a.eng.setComp(a.player.id, "held", { id: r.id }); a.host.interactions.refresh(); return r.id;
}

describe("ranking (spec 6), one rule at a time", () => {
  test("1. what it acts on: faced entity, then faced tile, then held item; newer systems lose here", () => {
    const a = arena({ before: [act("old_look", "Look", "#flower"), act("mid_dig", "Dig", "tile:grass"), act("new_eat", "Eat", "held")], base: true });
    faceDaisy(a); holdItem(a);
    expect(a.labels()).toEqual(["old_look:Look", "mid_dig:Dig", "new_eat:Eat", "carry:Drop"]);
  });
  test("1. a tile target matches only when no solid, pushable or item entity is on the faced tile", () => {
    const a = arena({ after: [act("dig", "Dig", "tile:grass")] });
    a.host.interactions.refresh();
    expect(a.labels()).toEqual(["dig:Dig"]);
    a.eng.spawn("test_item", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    expect(a.labels()).toEqual(["carry:Pick up"]);
  });
  test("1. Drop is always last, even against an older held action that age would put after it", () => {
    const a = arena({ before: [act("older", "Eat", "held")] });
    holdItem(a);
    expect(a.labels()).toEqual(["older:Eat", "carry:Drop"]);
  });
  test("2. what must be held: exact type, then tag, then left out", () => {
    const a = arena({ before: [act("a_exact", "Exact", "#flower", "test_item"), act("b_tag", "Tag", "#flower", "#item"), act("c_any", "Any", "#flower")] });
    faceDaisy(a); holdItem(a);
    // Reverse load order would put c_any first by age; rule 2 decides before age.
    expect(a.labels().slice(0, 3)).toEqual(["a_exact:Exact", "b_tag:Tag", "c_any:Any"]);
  });
  test("2. \"none\" ranks above left out, and only matches empty hands", () => {
    const a = arena({ before: [act("a_none", "Bare", "#flower", "none"), act("b_any", "Any", "#flower")] });
    faceDaisy(a);
    expect(a.labels()).toEqual(["a_none:Bare", "b_any:Any"]);
    holdItem(a);
    expect(a.labels()).toEqual(["b_any:Any", "carry:Drop"]);
  });
  test("3. how it names the target: exact type, then tag", () => {
    const a = arena({ before: [act("a_type", "Type", "daisy"), act("b_tag", "Tag", "#flower")] });
    faceDaisy(a);
    expect(a.labels()).toEqual(["a_type:Type", "b_tag:Tag"]);
  });
  test("4. age: the newer system wins", () => {
    const a = arena({ before: [act("a_old", "Old", "#flower"), act("b_new", "New", "#flower")] });
    faceDaisy(a);
    expect(a.labels()).toEqual(["b_new:New", "a_old:Old"]);
  });
  test("two systems may use the same verb and label; each keeps its owner", () => {
    const a = arena({ before: [act("one", "Smell", "#flower"), act("two", "Smell", "#flower")] });
    faceDaisy(a);
    expect(a.labels()).toEqual(["two:Smell", "one:Smell"]);
  });
  test("an entity target matches anything on the faced tile; an item comes first, then a pushable, then the rest", () => {
    const a = arena({ after: [act("poke", "Poke", "#plant"), act("kick", "Kick", "test_pushable")] });
    faceDaisy(a);
    expect(a.labels()).toEqual(["poke:Poke"]);
    a.eng.spawn("test_pushable", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    expect(a.labels()).toEqual(["kick:Kick", "poke:Poke"]);
    a.eng.spawn("test_item", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    expect(a.labels()[0]).toBe("carry:Pick up");
    expect(a.host.interactions.current?.target).toBe(a.eng.at(BASE_AREA, 5, 6).find((id) => a.eng.rec(id)!.type === "test_item"));
  });
  test("decoration spawned first on the faced tile doesn't hide the entity a system targets", () => {
    const a = arena({ after: [act("door", "Step inside", "test_pushable")] });
    faceDaisy(a);
    const target = a.eng.spawn("test_pushable", { x: 5, y: 6, area: BASE_AREA }, "@world").id;
    a.host.interactions.refresh();
    expect(a.labels()).toEqual(["door:Step inside"]);
    expect(a.host.interactions.current?.target).toBe(target);
  });
});

describe("prompt and the Q cycle", () => {
  const three = () => {
    const a = arena({ after: [act("look", "Look", "#flower"), act("smell", "Smell", "#plant"), act("dig", "Dig", "tile:grass")] });
    a.eng.spawn("daisy", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.eng.spawn("daisy", { x: 5, y: 7, area: BASE_AREA }, "@world");
    a.host.interactions.refresh();
    return a;
  };
  test("shows E: label with ‹i/n› Q, drawn above the target", () => {
    const a = three();
    expect(a.labels()).toEqual(["smell:Smell", "look:Look", "dig:Dig"]);
    expect(a.eng.prompt).toEqual({ text: "E: Smell ‹1/3› Q", x: 5, y: 6, area: BASE_AREA });
  });
  test("Q moves to the next match and wraps", () => {
    const a = three();
    a.tap("q"); expect(a.eng.prompt?.text).toBe("E: Look ‹2/3› Q");
    a.tap("q"); expect(a.eng.prompt?.text).toBe("E: Dig ‹3/3› Q");
    a.tap("q"); expect(a.eng.prompt?.text).toBe("E: Smell ‹1/3› Q");
  });
  test("turning resets to the default", () => {
    const a = three();
    a.tap("q"); expect(a.host.interactions.index).toBe(1);
    a.tap("left"); a.tap("down");
    expect(a.player.pos).toMatchObject({ x: 5, y: 5 });
    expect(a.eng.prompt?.text).toBe("E: Smell ‹1/3› Q");
  });
  test("stepping resets to the default", () => {
    const a = three();
    a.tap("q"); expect(a.host.interactions.index).toBe(1);
    a.tap("down"); // already facing down: a tap steps onto the daisy, facing the next one
    expect(a.player.pos).toMatchObject({ x: 5, y: 6 });
    expect(a.eng.prompt?.text).toBe("E: Smell ‹1/3› Q");
  });
  test("a single match shows no marker; no match shows nothing", () => {
    const a = arena();
    expect(a.eng.prompt).toBeNull();
    a.eng.spawn("test_item", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    expect(a.eng.prompt?.text).toBe("E: Pick up");
  });
});

describe("perform", () => {
  test("E calls perform(verb, target, held) on the highlighted owner, then emits interaction.performed", () => {
    const seen: unknown[] = []; const performed: unknown[] = [];
    const a = arena({ after: [
      testSystem({ id: "look", interactions: [{ verb: "look", label: "Look", target: "#flower" }] }, () => ({ perform(verb, target, held) { seen.push(["look", verb, target, held]); } })),
      testSystem({ id: "smell", interactions: [{ verb: "smell", label: "Smell", target: "#flower" }] }, () => ({ perform(verb, target, held) { seen.push(["smell", verb, target, held]); } })),
      testSystem({ id: "watcher", reactions: ["interaction.performed"] }, () => ({ onEvent(_n, p) { performed.push(JSON.parse(p)); } })),
    ] });
    faceDaisy(a);
    const daisy = a.eng.at(BASE_AREA, 5, 6)[0];
    a.tap("q"); a.tap("e");
    expect(seen).toEqual([["look", "look", daisy, 0]]);
    expect(performed).toEqual([{ verb: "look", target: { id: daisy, type: "daisy", pos: { x: 5, y: 6, area: BASE_AREA } }, held: null, owner: "look", pos: { x: 5, y: 6, area: BASE_AREA } }]);
  });
  test("Pick up and Drop through E, with the prompt following what is held", () => {
    const a = arena();
    const branch = a.eng.spawn("branch", { x: 5, y: 6, area: BASE_AREA }, "@world").id;
    a.host.interactions.refresh();
    expect(a.eng.prompt?.text).toBe("E: Pick up");
    a.tap("e");
    expect(a.player.comps.get("held")).toEqual({ id: branch });
    expect(a.eng.prompt?.text).toBe("E: Drop");
    expect(a.eng.prompt).toMatchObject({ x: 5, y: 5 }); // a held target draws above the player
    a.tap("e");
    expect(a.player.comps.has("held")).toBe(false);
    expect(a.eng.rec(branch)!.pos).toEqual({ x: 5, y: 6, area: BASE_AREA });
    expect(a.host.events.filter((e) => e.name === "interaction.performed").map((e) => e.payload.verb)).toEqual(["pick_up", "drop"]);
  });
  test("Drop with no room floats \"No room\" and keeps the item", () => {
    const a = arena();
    const item = holdItem(a);
    a.eng.spawn("test_block", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    a.tap("e");
    expect(a.player.comps.get("held")).toEqual({ id: item });
    expect(a.eng.floats.map((f) => f.text)).toEqual(["No room"]);
  });
  test("a perform that throws is rolled back and emits nothing", () => {
    const a = arena({ after: [testSystem({ id: "boom", interactions: [{ verb: "boom", label: "Boom", target: "#flower" }] }, (w) => ({
      perform(_v, target) { w.do("tag", { id: target, tag: "scorched" }); throw new Error("trap"); },
    }))] });
    faceDaisy(a);
    a.tap("e");
    expect(a.eng.rec(a.eng.at(BASE_AREA, 5, 6)[0])!.tags.has("scorched")).toBe(false);
    expect(a.host.faults.at(-1)).toMatchObject({ system: "boom", kind: "perform" });
    expect(a.host.events.some((e) => e.name === "interaction.performed")).toBe(false);
  });
});

describe("areas", () => {
  test("a door's Enter calls travel: the player moves into a second area, which the renderer and the E resolver then use", () => {
    const traveled: unknown[] = [];
    const doors = testSystem({
      id: "doors",
      entities: { door: { sprite: "sign", tags: ["solid"] } },
      interactions: [{ verb: "enter", label: "Enter", target: "door" }],
    }, (w) => ({
      migrate() { if (!(w.r<string[]>("area.list") ?? []).includes("doors.inside")) w.must("area.create", { name: "inside", fill: "grass_dark" }); },
      perform() { w.must("travel", { area: "doors.inside", x: 5, y: 5 }); },
    }));
    const watcher = testSystem({ id: "watcher", reactions: ["player.traveled"] }, () => ({ onEvent(_n, p) { traveled.push(JSON.parse(p)); } }));
    const a = arena({ after: [doors, watcher] });
    const door = a.eng.spawn("door", { x: 5, y: 6, area: BASE_AREA }, "doors").id;
    const inside = a.eng.spawn("test_item", { x: 5, y: 6, area: "doors.inside" }, "@world").id;
    a.host.interactions.refresh();
    expect(a.eng.prompt?.text).toBe("E: Enter");
    a.tap("e");
    expect(a.player.pos).toEqual({ x: 5, y: 5, area: "doors.inside" });
    expect(a.eng.currentArea()).toBe("doors.inside");
    const drawn = drawnEntities(a.eng).map((r) => r.id);
    expect(drawn).toContain(inside); expect(drawn).toContain(a.player.id); expect(drawn).not.toContain(door);
    expect(a.eng.prompt).toEqual({ text: "E: Pick up", x: 5, y: 6, area: "doors.inside" });
    expect(traveled).toEqual([{ from: BASE_AREA, to: "doors.inside", pos: { x: 5, y: 5, area: "doors.inside" } }]);
    a.tap("e");
    expect(a.player.comps.get("held")).toEqual({ id: inside });
  });
  test("travel works while focus is held", () => {
    const a = arena({ after: [testSystem({ id: "hold" }, (w) => ({ migrate() { w.must("area.create", { name: "room", fill: "grass" }); } }))] });
    expect(a.call("hold", { op: "focus", mode: "freeze" })).toMatchObject({ ok: true });
    expect(a.call("hold", { op: "travel", area: "hold.room", x: 2, y: 2 })).toMatchObject({ ok: true });
    expect(a.eng.currentArea()).toBe("hold.room");
  });
});

describe("Shift+R", () => {
  test("re-runs the registry and re-creates every module without losing the world or duplicating anything", () => {
    let created = 0;
    const counter = testSystem({ id: "counter", entities: { token: { sprite: "coin_gold", tags: ["item"] } }, interactions: [{ verb: "count", label: "Count", target: "#flower" }] },
      (w) => { created++; return { migrate() { w.must("spawn", { type: "token", x: 1, y: 1 }); } }; });
    const a = arena({ after: [counter] });
    a.ticks(30);
    const before = a.eng.serialize(); const modules = [...a.host.systems.values()].map((s) => s.module);
    a.host.reloadSystems();
    expect(a.eng.serialize()).toBe(before);
    expect(created).toBe(2);
    expect([...a.eng.entities.values()].filter((r) => r.type === "token")).toHaveLength(1); // migrate didn't run again
    expect([...a.host.systems.keys()]).toEqual(["movement", "carry", "push", "daynight", "counter"]);
    expect([...a.host.systems.values()].every((s, i) => s.module !== modules[i])).toBe(true);
    expect(a.host.registry.interactions.map((i) => i.verb)).toEqual(["pick_up", "drop", "count"]);
    // Still playable afterwards.
    a.host.controls.press("right"); a.ticks(12); a.host.controls.release("right"); a.ticks(1);
    expect(a.player.pos).toMatchObject({ x: 6, y: 5 });
  });
});
