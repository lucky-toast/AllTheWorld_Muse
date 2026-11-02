// Base carry (spec 9.2). Pick up and Drop are interactions on E (spec 6). The player's
// `held` component ({ id } or absent) is the one place that says what is in hand; the
// renderer draws the held item above the player. Drop places the item in front of the
// player only if every tile of its footprint is free, otherwise it floats "No room".
import type { SystemDef } from "../../engine/systems";
import { Api, DELTA } from "./api";

export const carry: SystemDef = {
  base: true,
  manifest: {
    id: "carry",
    why: "The player can pick things up, carry them, and put them down.",
    buildsOn: ["movement"],
    components: { held: "{ id } of the entity in the player's hands, or absent; the one place that says what is held" },
    interactions: [
      { verb: "pick_up", label: "Pick up", target: "#item", held: "none" },
      { verb: "drop", label: "Drop", target: "held" },
    ],
    emits: {
      "item.picked": { item: "entity" },
      "item.dropped": { item: "entity", pos: "pos" },
    },
  },
  create(call) {
    const w = new Api(call);

    /** Bottom-left tile that puts the whole footprint right in front of the player. */
    function dropPos(p: number, item: number) {
      const pos = w.pos(p)!; const d = DELTA[w.facing(p)];
      const tiles = w.footprint(item, 0, 0); const h = Math.max(...tiles.map((t) => -t.y)) + 1;
      // Footprints extend upward from pos, so dropping downward puts the bottom h-1 tiles further down.
      return { x: pos.x + d.x, y: d.y > 0 ? pos.y + d.y + (h - 1) : pos.y + d.y, area: pos.area };
    }

    return {
      perform(verb, target) {
        const p = w.player(); if (!p) return;
        if (verb === "pick_up") {
          if (!w.do("lift", { id: target })) return;
          w.do("set", { id: p, comp: "held", value: { id: target } });
          w.emit("item.picked", { item: target });
          return;
        }
        if (verb === "drop") {
          const item = w.get<{ id: number }>(p, "held")?.id;
          if (!item || !w.info(item)) { w.do("remove", { id: p, comp: "held" }); return; }
          const at = dropPos(p, item); const front = w.pos(p)!; const d = DELTA[w.facing(p)];
          if (!w.footprintFree(item, at.x, at.y, at.area) || !w.do("place", { id: item, x: at.x, y: at.y, area: at.area })) {
            w.do("fx.float", { text: "No room", x: front.x + d.x, y: front.y + d.y, area: front.area });
            return;
          }
          w.do("remove", { id: p, comp: "held" });
          w.emit("item.dropped", { item, pos: at });
        }
      },

      // ---- tests (run in the 12x12 arena, player at (5, 5) facing down) ----
      test_picks_up_faced_item() {
        const p = w.player();
        const item = w.must<number>("spawn", { type: "test_item", x: 5, y: 6 });
        w.must("sim.interact");
        w.check(w.get<{ id: number }>(p, "held")?.id === item, "the item is in hand");
        w.check(w.pos(item) === null, "the held item is off the map");
        w.check(w.events("item.picked").length === 1, "item.picked fired");
      },
      test_drops_on_free_tile() {
        const p = w.player();
        const item = w.must<number>("sim.give", { type: "test_item" });
        w.must("sim.interact");
        w.check(w.get(p, "held") === null, "hands are empty after the drop");
        const pos = w.pos(item);
        w.check(pos?.x === 5 && pos?.y === 6, "the item sits on the faced tile");
        w.check(w.events("item.dropped").length === 1, "item.dropped fired");
      },
      test_drop_onto_occupied_tile_keeps_it() {
        const p = w.player();
        w.must("spawn", { type: "test_block", x: 5, y: 6 });
        const item = w.must<number>("sim.give", { type: "test_item" });
        w.must("sim.interact");
        w.check(w.get<{ id: number }>(p, "held")?.id === item, "the item stays in hand");
        w.check(w.events("item.dropped").length === 0, "nothing was dropped");
      },
      test_log_drops_only_where_both_tiles_are_free() {
        const p = w.player();
        const log = w.must<number>("sim.give", { type: "log_fallen" });
        w.must("spawn", { type: "test_block", x: 5, y: 7 });
        w.must("sim.interact");
        w.check(w.get<{ id: number }>(p, "held")?.id === log, "a block on the log's second tile keeps it in hand");
        w.must("sim.face", { dir: "right" });
        w.must("sim.interact");
        const pos = w.pos(log);
        w.check(pos?.x === 6 && pos?.y === 5, "the log drops to the right, extending upward");
        w.check(w.at(6, 4).includes(log) && w.at(6, 5).includes(log), "both log tiles are on the map");
      },
    };
  },
};
