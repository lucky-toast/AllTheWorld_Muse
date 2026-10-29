import { defineSystem } from "../../engine/define";
import type { Dir } from "../../engine/api";
import { DELTA, footprintFree } from "./shared";

export default defineSystem({
  id: "push", why: "Walking into crates and logs shoves them along.", buildsOn: ["movement"],
  contract: {
    claims: [],
    emits: { "entity.bumped": { payload: "{ entity, dir }", when: "after a pushable entity is moved one tile by player.blocked" } },
    hooks: ["To react to shoves, listen for entity.bumped.", "Push is not an input handler; it reacts to player.blocked and never re-emits input.* events."],
  },
  on: {
    "player.blocked": (ev, w) => {
      const dir = ev.dir as Dir; const target = ev.target as { x: number; y: number };
      const ent = w.at(target.x, target.y).find((e) => e.has("pushable"));
      if (!ent || !ent.pos) return;
      const d = DELTA[dir]; const nx = ent.pos.x + d.x, ny = ent.pos.y + d.y;
      if (footprintFree(w, ent, nx, ny)) { ent.moveTo(nx, ny); w.emit("entity.bumped", { entity: ent, dir }); }
    },
  },
  tests: [
    { name: "pushes a crate one tile", ticks: 2, setup(w, sim) { w.spawn("test_pushable", { x: 6, y: 5 }); sim.walk("right"); }, expect(w, check) { check(w.at(7, 5).some((e) => e.has("pushable")), "crate moved to x=7"); check(w.query("player")[0].pos?.x === 6, "player followed into the crate's tile"); } },
    { name: "push into a rock fails", ticks: 2, setup(w, sim) { w.spawn("test_pushable", { x: 6, y: 5 }); w.spawn("test_block", { x: 7, y: 5 }); sim.walk("right"); }, expect(w, check) { check(w.at(6, 5).some((e) => e.has("pushable")), "crate stayed put"); check(w.query("player")[0].pos?.x === 5, "player stayed put"); } },
    { name: "both tiles of a log block", ticks: 4, setup(w, sim) { w.spawn("log_fallen", { x: 6, y: 5 }); w.spawn("test_block", { x: 7, y: 5 }); w.spawn("test_block", { x: 6, y: 6 }); sim.walk("right"); const afterRight = w.query("player")[0].pos?.x; (w.state as Record<string, unknown>).__x = afterRight; sim.teleport(6, 3); sim.walk("down"); }, expect(w, check) { check((w.state as Record<string, unknown>).__x === 5, "lower tile of log blocked from the left"); check(w.query("player")[0].pos?.y === 3, "upper tile of log blocked from above"); } },
    { name: "whole log moves when pushed", ticks: 2, setup(w, sim) { w.spawn("log_fallen", { x: 6, y: 5 }); w.tiles.set(7, 4, "grass"); sim.walk("right"); }, expect(w, check) { const log = w.query("pushable").find((e) => e.type === "log_fallen"); check(!!log && log.pos?.x === 7 && log.pos?.y === 5, "log moved whole to x=7"); check(w.at(7, 4).some((e) => e.type === "log_fallen") && w.at(7, 5).some((e) => e.type === "log_fallen"), "both log tiles now at x=7"); } },
    { name: "log pushed into rock fails", ticks: 2, setup(w, sim) { w.spawn("log_fallen", { x: 6, y: 5 }); w.spawn("test_block", { x: 7, y: 5 }); sim.walk("right"); }, expect(w, check) { const log = w.query("pushable").find((e) => e.type === "log_fallen"); check(log?.pos?.x === 6, "log blocked by rock stayed"); } },
  ],
});
