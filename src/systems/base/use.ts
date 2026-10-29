import { defineSystem } from "../../engine/define";
import { facedEntity, isBusy, player } from "./shared";

export default defineSystem({
  id: "use", why: "Pressing interact on things that aren't items uses them.", buildsOn: ["movement", "carry"],
  contract: {
    claims: ["input.interact: when facing a non-item entity (and carry did not act)"],
    emits: { "entity.used": { payload: "{ entity, held }", when: "on input.interact facing a non-item entity; held is the item in hand or null" } },
    hooks: ["To make something usable, listen for entity.used and check ev.entity; never handle input.interact for non-items yourself."],
  },
  on: {
    "input.interact": (ev, w) => {
      if (ev.handled || isBusy(w)) return;
      const p = player(w); const faced = facedEntity(w);
      if (!faced || faced.has("item")) return;
      const heldId = p.get<{ id: number }>("held")?.id;
      const held = heldId === undefined ? null : (w.query("item").find((e) => e.id === heldId) ?? null);
      w.emit("entity.used", { entity: faced, held }); ev.handled = true;
    },
  },
  tests: [
    { name: "uses a faced rock with empty hands", ticks: 2, setup(w, sim) { w.spawn("test_block", { x: 5, y: 6 }); sim.face("down"); (w.state as Record<string, unknown>).__cap = []; w.on("entity.used", (ev) => { ((w.state as Record<string, unknown>).__cap as unknown[]).push(ev); }); sim.interact(); }, expect(w, check) { const cap = (w.state as Record<string, unknown>).__cap as { entity?: { type: string }; held?: unknown }[]; check(cap.length === 1 && cap[0].entity?.type === "test_block" && cap[0].held === null, "entity.used fired with held=null"); } },
    { name: "held branch is passed as held and stays in hand", ticks: 2, setup(w, sim) { w.spawn("test_block", { x: 5, y: 6 }); sim.give("test_item"); sim.face("down"); (w.state as Record<string, unknown>).__cap = []; w.on("entity.used", (ev) => { ((w.state as Record<string, unknown>).__cap as unknown[]).push(ev); }); sim.interact(); }, expect(w, check) { const cap = (w.state as Record<string, unknown>).__cap as { held?: { type: string } | null }[]; check(cap.length === 1 && cap[0].held?.type === "test_item", "entity.used carried the held item"); check(!!player(w).get("held"), "branch stays in hand after use"); } },
    { name: "busy ignores use", ticks: 2, setup(w, sim) { w.spawn("test_block", { x: 5, y: 6 }); player(w).tag("busy"); (w.state as Record<string, unknown>).__n = 0; w.on("entity.used", () => { (w.state as Record<string, number>).__n++; }); sim.interact(); }, expect(w, check) { check(((w.state as Record<string, number>).__n) === 0, "no entity.used while busy"); } },
  ],
});
