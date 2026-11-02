import { describe, expect, it } from "vitest";
import { buildArena } from "../src/world/map";
import { createGame } from "../src/systems/base/index";
import { runBaseTests } from "../src/systems/base/runner";
import { validateManifest, type Manifest } from "../src/engine/manifest";
import { compareMatches, type Match } from "../src/engine/interactions";
import type { LoadedSystem } from "../src/engine/registry";
import type { Game } from "../src/engine/runtime";
import { Input } from "../src/engine/input";

function arena() { const eng = buildArena(); const game = createGame(eng); game.testMode = true; return { eng, game }; }
function spawn(game: Game, type: string, x: number, y: number, area?: string) {
  const r = game.call("test", { op: "spawn", type, x, y, ...(area ? { area } : {}) });
  if (!r.ok) throw new Error(r.msg); return r.r as number;
}
function sys(game: Game, partial: Partial<Manifest> & { id: string }, handlers: Partial<LoadedSystem> = {}): LoadedSystem {
  const manifest: Manifest = { why: "test", buildsOn: [], replaces: [], entities: {}, components: {}, interactions: [], reactions: [], emits: {}, shots: [], ...partial } as Manifest;
  const s: LoadedSystem = { manifest, ...handlers };
  game.loadSystem(s, { migrate: false });
  return s;
}
const entry = (owner: string, loadIndex: number, over: Partial<Match["entry"]> = {}): Match["entry"] => ({ verb: "act", label: "Act", target: "test_block", owner, loadIndex, ...over });
const match = (e: Match["entry"], kind: Match["kind"] = "entity"): Match => ({ entry: e, targetId: 1, targetPos: { x: 5, y: 6, area: "clearing" }, kind });

describe("manifest (spec 5.1)", () => {
  it("validates and freezes", () => {
    const r = validateManifest({ id: "chop", why: "Chop logs.", entities: { axe: { sprite: "axe", tags: ["item"] } }, interactions: [{ verb: "chop", label: "Chop", target: "log_fallen", held: "axe" }], emits: { "chop.chopped": { log: "entity" } } });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(Object.isFrozen(r.manifest)).toBe(true); expect(Object.isFrozen(r.manifest.interactions)).toBe(true); expect(r.manifest.replaces).toEqual([]); }
  });
  it("rejects bad ids and payload kinds", () => {
    expect(validateManifest({ id: "Bad Id", why: "x" }).ok).toBe(false);
    expect(validateManifest({ id: "ok_id", why: "x", emits: { "ok_id.ev": { f: "widget" } } }).ok).toBe(false);
  });
});

describe("base systems (spec 9)", () => {
  it("all base-system tests pass", () => {
    const results = runBaseTests();
    for (const r of results) expect(r.passed, `${r.system}: ${r.name} -> ${JSON.stringify(r.checks)}`).toBe(true);
    expect(results.length).toBe(21);
  });
});

describe("ranking rules, one by one (spec 6)", () => {
  it("rule 1: faced entity, then faced tile, then held only; Drop always last", () => {
    expect(compareMatches(match(entry("a", 0), "entity"), match(entry("b", 1), "tile"))).toBeLessThan(0);
    expect(compareMatches(match(entry("a", 0), "tile"), match(entry("b", 1), "held"))).toBeLessThan(0);
    const drop = match(entry("carry", 0, { verb: "drop", label: "Drop", target: "held" }), "held");
    expect(compareMatches(match(entry("a", 0), "held"), drop)).toBeLessThan(0);
  });
  it("rule 2: held exact type, then tag, then none, then left out", () => {
    const mk = (held?: string) => match(entry("a", 0, { held }));
    expect(compareMatches(mk("axe"), mk("#tool"))).toBeLessThan(0);
    expect(compareMatches(mk("#tool"), mk("none"))).toBeLessThan(0);
    expect(compareMatches(mk("none"), mk(undefined))).toBeLessThan(0);
  });
  it("rule 3: target exact type, then tag", () => {
    expect(compareMatches(match(entry("a", 0, { target: "log_fallen" })), match(entry("b", 0, { target: "#item" })))).toBeLessThan(0);
  });
  it("rule 4: the newer system wins", () => {
    expect(compareMatches(match(entry("old", 0)), match(entry("new", 5)))).toBeGreaterThan(0);
  });
});

describe("Q cycle and reset (spec 6)", () => {
  function twoActions() {
    const { eng, game } = arena();
    spawn(game, "test_item", 5, 6);
    sys(game, { id: "alpha", interactions: [{ verb: "alpha", label: "Alpha", target: "#item", held: "none" }] }, { perform: () => {} });
    sys(game, { id: "beta", interactions: [{ verb: "beta", label: "Beta", target: "#item", held: "none" }] }, { perform: () => {} });
    game.call("test", { op: "sim.face", dir: "down" });
    game.interactions.refresh();
    return { eng, game };
  }
  it("Q cycles and wraps; prompt shows the marker", () => {
    const { eng, game } = twoActions();
    expect(game.interactions.matches.length).toBe(3); // Pick up + Alpha + Beta
    expect(eng.interactionPrompt).toContain("‹1/3›");
    game.interactions.cycle(); expect(game.interactions.selected).toBe(1);
    game.interactions.cycle(); expect(game.interactions.selected).toBe(2);
    game.interactions.cycle(); expect(game.interactions.selected).toBe(0);
  });
  it("turning resets the cycle", () => {
    const { game } = twoActions();
    game.interactions.cycle(); expect(game.interactions.selected).toBe(1);
    game.call("test", { op: "sim.face", dir: "left" });
    game.interactions.refresh();
    expect(game.interactions.selected).toBe(0);
  });
  it("stepping resets the cycle", () => {
    const { game } = twoActions();
    game.interactions.cycle();
    game.call("test", { op: "sim.walk", dir: "down" }); // steps onto/past? blocked by item tile re-check happens in refresh
    game.interactions.refresh();
    expect(game.interactions.selected).toBe(0);
  });
  it("E performs and emits interaction.performed", () => {
    const { game } = arena();
    const id = spawn(game, "test_item", 5, 6);
    game.call("test", { op: "sim.face", dir: "down" });
    game.call("test", { op: "sim.interact" });
    const held = game.eng.playerRec()!.comps.get("held") as { id: number };
    expect(held.id).toBe(id);
    expect(game.eventLog.some((e) => e.name === "interaction.performed")).toBe(true);
    expect(game.eventLog.some((e) => e.name === "item.picked")).toBe(true);
  });
  it("facing a branch shows E: Pick up; holding it shows E: Drop", () => {
    const { eng, game } = arena();
    spawn(game, "branch", 5, 6);
    game.call("test", { op: "sim.face", dir: "down" });
    game.interactions.refresh();
    expect(eng.interactionPrompt).toBe("E: Pick up");
    game.call("test", { op: "sim.interact" });
    game.interactions.refresh();
    expect(eng.interactionPrompt).toBe("E: Drop");
    game.call("test", { op: "sim.interact" });
    expect(game.eng.playerRec()!.comps.get("held")).toBeUndefined();
  });
});

describe("events (spec 8)", () => {
  it("unowned emit is denied", () => {
    const { game } = arena();
    const r = game.call("alpha", { op: "emit", name: "beta.boom", payload: {} });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("denied");
  });
  it("a fake entity type in the payload is corrected by the host", () => {
    const { game } = arena();
    const branch = spawn(game, "branch", 5, 6);
    let seen: { type: string } | null = null;
    sys(game, { id: "sender", emits: { "sender.ping": { item: "entity" } } });
    sys(game, { id: "hearer", reactions: ["sender.ping"] }, { onEvent: (_n, p) => { seen = (JSON.parse(p) as { item: { type: string } }).item; } });
    const r = game.call("sender", { op: "emit", name: "sender.ping", payload: { item: { id: branch, type: "dragon_fake" } } });
    expect(r.ok).toBe(true);
    expect(seen!.type).toBe("branch");
  });
  it("bad payloads are denied", () => {
    const { game } = arena();
    sys(game, { id: "sender", emits: { "sender.ping": { n: "number" } } });
    expect(game.call("sender", { op: "emit", name: "sender.ping", payload: { n: "x" } }).ok).toBe(false);
  });
  it("nesting is capped", () => {
    const { game } = arena();
    let deliveries = 0;
    sys(game, { id: "loop", reactions: ["loop.tick"], emits: { "loop.tick": {} } }, {
      onEvent: () => { deliveries++; game.call("loop", { op: "emit", name: "loop.tick", payload: {} }); },
    });
    const r = game.call("loop", { op: "emit", name: "loop.tick", payload: {} });
    expect(r.ok).toBe(true);
    expect(deliveries).toBeGreaterThan(0);
    expect(deliveries).toBeLessThanOrEqual(17);
  });
  it("overlap: two systems writing one entity on one event are logged", () => {
    const { eng, game } = arena();
    const target = spawn(game, "branch", 5, 6);
    sys(game, { id: "evsrc", emits: { "evsrc.go": {} } });
    sys(game, { id: "w1", reactions: ["evsrc.go"] }, { onEvent: () => { game.call("w1", { op: "set", id: target, comp: "a", value: 1 }); } });
    sys(game, { id: "w2", reactions: ["evsrc.go"] }, { onEvent: () => { game.call("w2", { op: "set", id: target, comp: "b", value: 2 }); } });
    expect(game.call("evsrc", { op: "emit", name: "evsrc.go", payload: {} }).ok).toBe(true);
    expect(eng.overlapLog.some((o) => o.entity === target)).toBe(true);
  });
});

describe("timers and tweens (spec 4)", () => {
  it("timer fires onTimer; a missing entity inside gets missing, not a fault", () => {
    const { game } = arena();
    const gone = spawn(game, "branch", 5, 6);
    let fired = "", missingCode = "";
    sys(game, { id: "timed", emits: {} }, {
      onTimer: (name) => {
        fired = name;
        const r = game.call("timed", { op: "get", id: gone, comp: "x" });
        if (!r.ok) missingCode = r.code;
      },
    });
    expect(game.call("timed", { op: "timer", ticks: 3, name: "later" }).ok).toBe(true);
    game.call("timed", { op: "destroy", id: gone });
    for (let i = 0; i < 4; i++) game.tick();
    expect(fired).toBe("later");
    expect(missingCode).toBe("missing");
    expect(game.faults).toEqual([]);
  });
  it("tween progress calls onTween each tick", () => {
    const { game } = arena();
    const values: number[] = [];
    sys(game, { id: "tw" }, { onTween: (_id, v) => values.push(v) });
    const r = game.call("tw", { op: "fx.tween", from: 0, to: 10, ticks: 5 });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 5; i++) game.tick();
    expect(values).toEqual([2, 4, 6, 8, 10]);
  });
  it("anim callback fires onTimer", () => {
    const { game } = arena();
    const id = spawn(game, "branch", 5, 6);
    let fired = "";
    sys(game, { id: "an" }, { onTimer: (n) => { fired = n; } });
    expect(game.call("an", { op: "anim", id, name: "whatever", callback: "done" }).ok).toBe(true);
    for (let i = 0; i < 14; i++) game.tick();
    expect(fired).toBe("done");
  });
});

describe("focus guards (spec 7)", () => {
  function focusGame() {
    const { eng, game } = arena();
    const inputs: string[] = [];
    sys(game, { id: "mini", emits: {} }, { onInput: (k, kind) => inputs.push(`${k}:${kind}`) });
    return { eng, game, inputs };
  }
  it("one holder at a time; a second request is denied", () => {
    const { game } = focusGame();
    expect(game.call("mini", { op: "focus", mode: "borrow" }).ok).toBe(true);
    expect(game.call("carry", { op: "focus", mode: "borrow" }).ok).toBe(false);
  });
  it("Escape ends borrow and notifies onInput escape", () => {
    const { game, inputs } = focusGame();
    game.call("mini", { op: "focus", mode: "borrow" });
    game.focus.escape();
    expect(game.focus.holder).toBeNull();
    expect(inputs).toContain("escape:down");
  });
  it("Escape during freeze ends it too", () => {
    const { game, inputs } = focusGame();
    game.call("mini", { op: "focus", mode: "freeze" });
    const input = new Input(game);
    input.keyDown("ArrowRight"); // frozen: ignored
    expect(inputs).toEqual([]);
    game.focus.escape();
    expect(game.focus.holder).toBeNull();
    expect(inputs).toContain("escape:down");
  });
  it("cooldown after focus ends, waived when taken inside perform", () => {
    const { game } = focusGame();
    game.call("mini", { op: "focus", mode: "borrow" });
    game.focus.escape(); // not a release -> cooldown applies
    expect(game.call("mini", { op: "focus", mode: "borrow" }).ok).toBe(false);
    game.focus.inPerform = true; // as the runtime sets during perform
    expect(game.call("mini", { op: "focus", mode: "borrow" }).ok).toBe(true);
    game.focus.inPerform = false;
  });
  it("release does not send escape; timeout takes the controls back", () => {
    const { eng, game, inputs } = focusGame();
    game.call("mini", { op: "focus", mode: "borrow" });
    expect(game.call("mini", { op: "release" }).ok).toBe(true);
    expect(inputs).not.toContain("escape:down");
    game.focus.clearCooldown("mini");
    game.call("mini", { op: "focus", mode: "borrow" });
    eng.tickCount += 61 * 60;
    game.focus.checkTimeout();
    expect(game.focus.holder).toBeNull();
    expect(inputs).toContain("escape:down");
  });
  it("borrow routes keys to onInput with engine-timed repeat; freeze blocks walking", () => {
    const { game, inputs } = focusGame();
    const input = new Input(game);
    game.call("mini", { op: "focus", mode: "borrow" });
    input.keyDown("ArrowRight");
    expect(inputs).toContain("right:down");
    for (let i = 0; i < 24; i++) input.tick();
    expect(inputs).toContain("right:repeat");
    game.focus.escape(); inputs.length = 0;
    game.focus.clearCooldown("mini");
    game.call("mini", { op: "focus", mode: "freeze" });
    game.call("test", { op: "sim.walk", dir: "right" });
    expect(game.eng.playerRec()!.pos!.x).toBe(5);
  });
});

describe("movement feel components (spec 7)", () => {
  it("moveDelay adds extra ticks per step", () => {
    const { game } = arena();
    const p = game.eng.playerRec()!;
    game.call("test", { op: "set", id: p.id, comp: "moveDelay", value: 30 });
    game.call("test", { op: "sim.walk", dir: "right" });
    expect(game.eng.playerRec()!.pos!.x).toBe(6);
    game.call("test", { op: "sim.walk", dir: "right" });
    expect(game.eng.playerRec()!.pos!.x).toBe(6); // still cooling down
    game.call("test", { op: "sim.wait", ticks: 40 });
    game.call("test", { op: "sim.walk", dir: "right" });
    expect(game.eng.playerRec()!.pos!.x).toBe(7);
  });
  it("slippery keeps the player going one more step if free", () => {
    const { eng, game } = arena();
    eng.registerType("test_ice", { sprite: "fern", tags: ["slippery"] }, "test");
    spawn(game, "test_ice", 6, 5);
    game.call("test", { op: "sim.walk", dir: "right" });
    expect(game.eng.playerRec()!.pos!.x).toBe(7);
  });
});

describe("door travel to a second area (spec 3, 9)", () => {
  it("perform travel moves the player; resolver and renderer use the new area", () => {
    const { eng, game } = arena();
    eng.registerType("test_door", { sprite: "crate", tags: ["solid"] }, "door");
    spawn(game, "test_door", 5, 6);
    sys(game, { id: "door", interactions: [{ verb: "enter", label: "Enter", target: "test_door" }] }, {
      perform: () => {
        game.call("door", { op: "area.create", name: "cave", fill: "grass" });
        const target = spawn(game, "branch", 5, 6, "door.cave");
        void target;
        game.call("door", { op: "travel", area: "door.cave", x: 5, y: 5 });
      },
    });
    game.call("test", { op: "sim.face", dir: "down" });
    game.interactions.refresh();
    expect(eng.interactionPrompt).toBe("E: Enter");
    game.call("test", { op: "sim.interact" });
    expect(eng.currentAreaId).toBe("door.cave");
    expect(game.eventLog.some((e) => e.name === "player.traveled")).toBe(true);
    game.interactions.refresh();
    expect(eng.interactionPrompt).toBe("E: Pick up"); // branch in the new area
  });
});

describe("Shift+R reload (spec 3)", () => {
  it("re-instantiates systems without losing the world or duplicating anything", () => {
    const { eng, game } = arena();
    const before = eng.entities.size;
    game.call("test", { op: "sim.walk", dir: "right" });
    game.reloadAll();
    expect(game.systems.map((s) => s.manifest.id)).toEqual(["movement", "carry", "push", "daynight"]);
    expect(eng.entities.size).toBe(before);
    expect(eng.playerRec()!.pos!.x).toBe(6);
    expect(game.registry.interactions.length).toBe(2);
  });
});
