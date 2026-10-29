import { defineSystem } from "../../engine/define";
import type { Entity, World } from "../../engine/api";
import { DELTA, facedEntity, facing, footprintFree, isBusy, player, spriteId } from "./shared";
import { footprintTiles } from "./shared";

function heldEntity(w: World, id: number): Entity | undefined {
  return w.query("item").find((e) => e.id === id);
}
/** Bottom-left pos so the whole footprint sits in front of the player, adjacent in the facing direction. */
export function dropPos(w: World, p: Entity, ent: Entity) {
  const d = DELTA[facing(p)]; const fp = w.catalog.get(spriteId(ent))?.footprint ?? { w: 1, h: 1 };
  const y = d.y > 0 ? p.pos!.y + d.y + (fp.h - 1) : p.pos!.y + d.y;
  return { x: p.pos!.x + d.x, y };
}

export default defineSystem({
  id: "carry", why: "The player can pick things up, carry them, and put them down.", buildsOn: ["movement"],
  contract: {
    claims: ["input.interact: when it picks up a faced item, or when it places the held item on free tiles"],
    emits: {
      "item.picked": { payload: "{ item }", when: "after an item is lifted into the player's hands" },
      "item.dropped": { payload: "{ item, pos }", when: "after the held item is placed on the map" },
    },
    hooks: ["To know what is in hand, read the player's held component ({ id } or absent).", "To react to carrying, listen for item.picked / item.dropped."],
  },
  components: { held: "{ id } of the entity in the player's hands, or absent. The one place that says what is held." },
  on: {
    "input.interact": (ev, w) => {
      if (ev.handled || isBusy(w)) return;
      const p = player(w); if (!p || !p.pos) return;
      const held = p.get<{ id: number }>("held");
      if (!held) {
        const faced = facedEntity(w);
        if (faced && faced.has("item")) {
          faced.lift(); p.set("held", { id: faced.id });
          w.emit("item.picked", { item: faced }); ev.handled = true;
        }
        return;
      }
      const ent = heldEntity(w, held.id); if (!ent) { p.remove("held"); return; }
      const pos = dropPos(w, p, ent);
      void footprintTiles;
      if (footprintFree(w, ent, pos.x, pos.y)) {
        ent.place(pos.x, pos.y); p.remove("held");
        w.emit("item.dropped", { item: ent, pos: { ...pos } }); ev.handled = true;
      }
      // Otherwise leave the input alone so `use` gets it.
    },
  },
  tests: [
    { name: "picks up faced item", ticks: 2, setup(w, sim) { w.spawn("test_item", { x: 5, y: 6 }); sim.face("down"); sim.interact(); }, expect(w, check) { const p = player(w); check(!!p.get("held"), "item is in hand"); const held = w.query("item").find((e) => e.id === (p.get<{ id: number }>("held"))?.id); check(!!held && held.pos === null, "held item is off the map"); } },
    { name: "drops on free tile", ticks: 2, setup(w, sim) { sim.give("test_item"); sim.face("down"); sim.interact(); }, expect(w, check) { check(!player(w).get("held"), "hands empty after drop"); check(w.at(5, 6).some((e) => e.has("item")), "item sits on faced tile"); } },
    { name: "drop onto occupied tile stays in hand", ticks: 2, setup(w, sim) { w.spawn("test_block", { x: 5, y: 6 }); sim.give("test_item"); sim.face("down"); sim.interact(); }, expect(w, check) { check(!!player(w).get("held"), "item stays in hand when drop tile is occupied"); } },
    { name: "log drops only where both tiles are free", ticks: 2, setup(w, sim) { const log = w.spawn("log_fallen", { x: 8, y: 8 }); void log; sim.give("log_fallen"); sim.face("down"); sim.interact(); }, expect(w, check) { const logs = w.query("item").filter((e) => e.type === "log_fallen" && e.pos); check(logs.some((e) => e.pos?.x === 5 && e.pos?.y === 7), "log placed with both tiles in front (bottom at y=7)"); } },
    { name: "busy ignores pickup", ticks: 2, setup(w, sim) { w.spawn("test_item", { x: 5, y: 6 }); player(w).tag("busy"); sim.interact(); }, expect(w, check) { check(!player(w).get("held"), "busy player picked nothing up"); } },
  ],
});
