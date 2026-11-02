// Focus and input routing (spec 7): borrow and freeze, and every guard.
import { arena, testSystem } from "./helpers";
import { BASE_AREA } from "../src/engine/types";
import { LIMITS, TUNING } from "../src/tuning";
import type { Api } from "../src/systems/base/api";

/** A system that records its onInput calls and exposes its Api. */
function recorder(id = "game", extra: Record<string, unknown> = {}, more: (w: Api) => Record<string, unknown> = () => ({})) {
  const inputs: string[] = []; let api!: Api;
  const def = testSystem({ id, ...extra }, (w) => { api = w; return { onInput(k: string, kind: string) { inputs.push(`${k}:${kind}`); }, ...more(w) }; });
  return { def, inputs, api: () => api };
}

describe("borrow", () => {
  test("arrows, E and Q go to the holder's onInput instead of movement and the resolver", () => {
    const r = recorder();
    const a = arena({ after: [r.def] });
    a.eng.spawn("test_item", { x: 5, y: 6, area: BASE_AREA }, "@world");
    expect(a.call("game", { op: "focus", mode: "borrow" })).toMatchObject({ ok: true });
    a.tap("right"); a.tap("e"); a.tap("q");
    expect(r.inputs).toEqual(["right:down", "right:up", "e:down", "e:up", "q:down", "q:up"]);
    expect(a.player.pos).toMatchObject({ x: 5, y: 5 });
    expect(a.player.comps.get("facing")).toBe("down");
    expect(a.player.comps.has("held")).toBe(false);
    expect(a.eng.prompt).toBeNull(); // the prompt hides while focus is held
  });
  test("a held key repeats at the walking pace from the engine's own timer", () => {
    const r = recorder();
    const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "borrow" });
    a.host.controls.press("left"); a.ticks(1 + TUNING.stepTicks * 3);
    expect(r.inputs).toEqual(["left:down", "left:repeat", "left:repeat", "left:repeat"]);
  });
});

describe("freeze", () => {
  test("every key but Escape is ignored", () => {
    const r = recorder();
    const a = arena({ after: [r.def] });
    a.eng.spawn("test_item", { x: 5, y: 6, area: BASE_AREA }, "@world");
    a.call("game", { op: "focus", mode: "freeze" });
    a.host.controls.press("right"); a.ticks(40); a.host.controls.release("right"); a.tap("e"); a.tap("q");
    expect(r.inputs).toEqual([]);
    expect(a.player.pos).toMatchObject({ x: 5, y: 5 });
    expect(a.player.comps.has("held")).toBe(false);
  });
  test("taking focus while a direction is held stops the walk", () => {
    const r = recorder();
    const a = arena({ after: [r.def] });
    a.host.controls.press("right"); a.ticks(TUNING.tapTurnTicks + 1);
    expect(a.player.pos).toMatchObject({ x: 6 });
    a.call("game", { op: "focus", mode: "freeze" });
    a.ticks(TUNING.stepTicks * 4);
    expect(a.player.pos).toMatchObject({ x: 6 });
  });
});

describe("guards", () => {
  test("Escape ends borrow focus and the holder gets onInput(\"escape\", \"down\")", () => {
    const r = recorder(); const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "borrow" });
    a.tap("escape");
    expect(a.host.focus.holder).toBeNull();
    expect(r.inputs).toEqual(["escape:down"]);
    expect(a.host.focus.lastEnd).toMatchObject({ system: "game", reason: "escape" });
  });
  test("Escape ends freeze focus too, and nothing can block it", () => {
    const r = recorder("game", {}, (w) => ({ onInput(k: string) { r.inputs.push(k); w.must("focus", { mode: "freeze" }); } }));
    const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "freeze" });
    a.tap("escape");
    expect(r.inputs).toEqual(["escape"]);
    expect(a.host.focus.holder).toBeNull(); // re-taking focus in the escape callback is refused (cooldown), so it can't trap the player
    a.tap("right");
    expect(a.player.comps.get("facing")).toBe("right");
  });
  test("borrow is taken back after 60 s and freeze after 30 s", () => {
    for (const [mode, limit] of [["borrow", LIMITS.focusBorrowTicks], ["freeze", LIMITS.focusFreezeTicks]] as const) {
      const r = recorder(); const a = arena({ after: [r.def] });
      a.call("game", { op: "focus", mode });
      a.ticks(limit - 1);
      expect(a.host.focus.holder).toBe("game");
      a.ticks(1);
      expect(a.host.focus.holder).toBeNull();
      expect(r.inputs).toEqual(["escape:down"]);
      expect(a.host.focus.lastEnd?.reason).toBe("timeout");
    }
  });
  test("cooldown: 10 s after its focus ends, a system can't take focus again", () => {
    const r = recorder(); const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "borrow" });
    a.call("game", { op: "release" });
    expect(r.inputs).toEqual([]); // release doesn't call onInput
    expect(a.call("game", { op: "focus", mode: "borrow" })).toMatchObject({ ok: false, code: "denied", msg: expect.stringMatching(/cooldown/) });
    a.ticks(LIMITS.focusCooldownTicks - 1);
    expect(a.call("game", { op: "focus", mode: "borrow" })).toMatchObject({ ok: false });
    a.ticks(1);
    expect(a.call("game", { op: "focus", mode: "borrow" })).toMatchObject({ ok: true });
  });
  test("the cooldown is waived when focus is taken inside the system's own perform", () => {
    const r = recorder("chopper", { interactions: [{ verb: "chop", label: "Chop", target: "#flower" }] }, (w) => ({
      perform() { w.must("focus", { mode: "freeze" }); w.must("timer", { ticks: 5, name: "done" }); },
      onTimer() { w.must("release"); },
    }));
    const a = arena({ after: [r.def] });
    a.eng.spawn("daisy", { x: 5, y: 6, area: BASE_AREA }, "@world"); a.host.interactions.refresh();
    // A focus taken outside perform puts "chopper" on cooldown...
    a.call("chopper", { op: "focus", mode: "borrow" }); a.call("chopper", { op: "release" });
    expect(a.call("chopper", { op: "focus", mode: "borrow" })).toMatchObject({ ok: false });
    // ...but the player pressing E still works, and again right after it ends.
    a.tap("e");
    expect(a.host.focus).toMatchObject({ holder: "chopper", mode: "freeze" });
    a.ticks(6);
    expect(a.host.focus.holder).toBeNull();
    a.tap("e");
    expect(a.host.focus.holder).toBe("chopper");
    expect(a.host.faults).toEqual([]);
  });
  test("one holder at a time: a second request is denied", () => {
    const a = arena({ after: [recorder("one").def, recorder("two").def] });
    expect(a.call("one", { op: "focus", mode: "borrow" })).toMatchObject({ ok: true });
    expect(a.call("two", { op: "focus", mode: "freeze" })).toMatchObject({ ok: false, code: "denied", msg: expect.stringMatching(/one holder/) });
    expect(a.call("two", { op: "release" })).toMatchObject({ ok: false, code: "denied" });
    expect(a.host.focus.holder).toBe("one");
  });
  test("released when the holder faults, with onInput(\"escape\")", () => {
    let boom = false;
    const r = recorder("game", {}, () => ({ onTick() { if (boom) throw new Error("trap"); } }));
    const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "borrow" });
    boom = true; a.ticks(1); boom = false;
    expect(a.host.focus.holder).toBeNull();
    expect(a.host.focus.lastEnd?.reason).toBe("fault");
    expect(r.inputs).toEqual(["escape:down"]);
  });
  test("released when the holder unloads", () => {
    const r = recorder(); const a = arena({ after: [r.def] });
    a.call("game", { op: "focus", mode: "freeze" });
    a.host.unload("game", "test");
    expect(a.host.focus.holder).toBeNull();
    expect(a.host.focus.lastEnd?.reason).toBe("unload");
    a.tap("right");
    expect(a.player.comps.get("facing")).toBe("right");
  });
  test("focus taken in a call that rolls back is given back", () => {
    const r = recorder("game", {}, (w) => ({ onTick() { w.must("focus", { mode: "freeze" }); throw new Error("trap"); } }));
    const a = arena({ after: [r.def] });
    a.ticks(1);
    expect(a.host.focus.holder).toBeNull();
    expect(r.inputs).toEqual([]);
  });
  test("an unknown mode is a bad request", () => {
    const a = arena({ after: [recorder().def] });
    expect(a.call("game", { op: "focus", mode: "grab" })).toMatchObject({ ok: false, code: "bad_request" });
  });
});
