// Base push (spec 9.3). Reacts to player.blocked: if the blocked tile holds a pushable
// entity, it moves the whole entity one tile when its whole new footprint is free, and
// emits entity.bumped. Movement then re-checks the tile and steps into the gap.
import type { SystemDef } from "../../engine/systems";
import { Api, DELTA, isDir } from "./api";

export const push: SystemDef = {
  base: true,
  manifest: {
    id: "push",
    why: "Walking into crates and logs shoves them along.",
    buildsOn: ["movement"],
    reactions: ["player.blocked"],
    emits: { "entity.bumped": { entity: "entity", dir: "string" } },
  },
  create(call) {
    const w = new Api(call);
    return {
      onEvent(name, payload) {
        if (name !== "player.blocked") return;
        const ev = JSON.parse(payload) as { dir: string; target: { x: number; y: number; area: string } };
        if (!isDir(ev.dir)) return;
        const id = w.at(ev.target.x, ev.target.y, ev.target.area).find((e) => w.has(e, "pushable"));
        const pos = id ? w.pos(id) : null; if (!id || !pos) return;
        const d = DELTA[ev.dir]; const to = { x: pos.x + d.x, y: pos.y + d.y, area: pos.area };
        if (!w.footprintFree(id, to.x, to.y, to.area)) return;
        if (w.do("move", { id, x: to.x, y: to.y, area: to.area })) w.emit("entity.bumped", { entity: id, dir: ev.dir });
      },

      // ---- tests (run in the 12x12 arena, player at (5, 5) facing down) ----
      test_pushes_a_crate() {
        const p = w.player();
        const crate = w.must<number>("spawn", { type: "test_pushable", x: 6, y: 5 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(crate)?.x === 7, "the crate moved one tile right");
        w.check(w.pos(p)?.x === 6, "the player stepped into the crate's old tile");
        w.check(w.events("entity.bumped").length === 1, "entity.bumped fired");
      },
      test_crate_into_rock_stays() {
        const p = w.player();
        const crate = w.must<number>("spawn", { type: "test_pushable", x: 6, y: 5 });
        w.must("spawn", { type: "test_block", x: 7, y: 5 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(crate)?.x === 6, "the crate stayed put");
        w.check(w.pos(p)?.x === 5, "the player stayed put");
      },
      test_whole_log_moves() {
        const log = w.must<number>("spawn", { type: "log_fallen", x: 6, y: 5 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(log)?.x === 7 && w.pos(log)?.y === 5, "the log moved whole to x=7");
        w.check(w.at(7, 4).includes(log) && w.at(7, 5).includes(log), "both log tiles are now at x=7");
        w.check(w.at(6, 4).length === 0, "nothing is left on the old upper tile");
      },
      test_log_into_rock_stays() {
        const log = w.must<number>("spawn", { type: "log_fallen", x: 6, y: 5 });
        w.must("spawn", { type: "test_block", x: 7, y: 4 }); // blocks only the log's upper tile
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(log)?.x === 6, "a rock in front of either log tile stops it");
      },
    };
  },
};
