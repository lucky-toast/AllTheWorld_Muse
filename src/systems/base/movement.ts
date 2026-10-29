import { defineSystem } from "../../engine/define";
import type { Dir } from "../../engine/api";
import { DELTA, facing, isBusy, player, tileFree } from "./shared";

export default defineSystem({
  id: "movement", why: "The player can walk the clearing.", buildsOn: [],
  contract: {
    claims: ["input.move: always, for the player", "input.turn: always, for the player"],
    emits: {
      "player.moved": { payload: "{ from, to, dir }", when: "after every completed step" },
      "player.blocked": { payload: "{ dir, target: {x, y} }", when: "when a step is blocked, before movement re-checks the tile" },
    },
    hooks: ["To react to walking, listen for player.moved.", "To clear the way when the player is blocked, handle player.blocked."],
  },
  components: { facing: "Dir string on the player; the one place facing is stored." },
  migrate(w) { const p = player(w); if (p && p.get("facing") === undefined) p.set("facing", "down"); },
  on: {
    "input.turn": (ev, w) => {
      if (ev.handled || isBusy(w)) return;
      const p = player(w); if (!p) return;
      p.set("facing", ev.dir as Dir); ev.handled = true;
    },
    "input.move": (ev, w) => {
      if (ev.handled || isBusy(w)) return;
      const p = player(w); if (!p || !p.pos) return;
      const dir = ev.dir as Dir; p.set("facing", dir);
      const d = DELTA[dir]; const target = { x: p.pos.x + d.x, y: p.pos.y + d.y };
      if (!tileFree(w, target.x, target.y, p.id)) {
        w.emit("player.blocked", { dir, target });
        if (!tileFree(w, target.x, target.y, p.id)) { ev.handled = true; return; }
      }
      const from = { ...p.pos }; p.moveTo(target.x, target.y);
      w.emit("player.moved", { from, to: { ...target }, dir });
      ev.handled = true;
    },
  },
  tests: [
    { name: "walks one tile", ticks: 2, setup(w, sim) { sim.walk("right"); }, expect(w, check) { const p = player(w); check(p.pos?.x === 6 && p.pos?.y === 5, "player stepped right"); check(facing(p) === "right", "facing follows walk"); } },
    { name: "turn only faces", ticks: 2, setup(w, sim) { sim.face("left"); }, expect(w, check) { const p = player(w); check(p.pos?.x === 5 && p.pos?.y === 5, "turn did not move"); check(facing(p) === "left", "turn set facing"); } },
    { name: "wall blocks", ticks: 2, setup(w, sim) { w.tiles.set(6, 5, "stream_h"); sim.walk("right"); }, expect(w, check) { check(player(w).pos?.x === 5, "water tile blocked the step"); } },
    { name: "solid blocks", ticks: 2, setup(w, sim) { w.spawn("test_block", { x: 6, y: 5 }); sim.walk("right"); }, expect(w, check) { check(player(w).pos?.x === 5, "solid entity blocked the step"); } },
    { name: "map edge blocks", ticks: 2, setup(w, sim) { sim.teleport(0, 5); sim.walk("left"); }, expect(w, check) { check(player(w).pos?.x === 0, "map edge blocked the step"); } },
    { name: "busy ignores input", ticks: 2, setup(w, sim) { player(w).tag("busy"); sim.walk("right"); }, expect(w, check) { check(player(w).pos?.x === 5, "busy player did not move"); } },
  ],
});
