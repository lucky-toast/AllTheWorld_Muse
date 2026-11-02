// Base movement (spec 9.1). The engine sends arrow keys here as onInput(dir, "down"/"up")
// while nobody holds focus; movement keeps the old tap-to-turn and hold-to-walk timing on
// its own timer (onTick). A step faces that way and moves if the tile is free for the
// player; otherwise it emits player.blocked, then re-checks and steps if the tile is free
// now. Reads `moveDelay` (extra ticks per step) on the player, and an entity tagged
// `slippery` under the player keeps it going one more step if free.
import type { SystemDef } from "../../engine/systems";
import { TUNING } from "../../tuning";
import { Api, DELTA, isDir, type Dir } from "./api";

export const movement: SystemDef = {
  base: true,
  manifest: {
    id: "movement",
    why: "The player walks the world: tap a direction to turn, hold it to walk.",
    buildsOn: [],
    components: {
      facing: "\"up\" | \"down\" | \"left\" | \"right\" on the player; the one place facing is stored",
      moveDelay: "number: extra ticks per step, on the player",
    },
    emits: {
      "player.moved": { from: "pos", to: "pos", dir: "string" },
      "player.blocked": { dir: "string", target: "pos" },
    },
  },
  create(call) {
    const w = new Api(call);
    // Keyboard state is transient: it lives in the module and is gone after a reload.
    let held: Dir[] = [];
    let holdTicks = 0, stepTimer = 0, slipTimer = 0;
    let slipDir: Dir | null = null;

    const interval = (p: number) => TUNING.stepTicks + Math.max(0, Math.floor(w.get<number>(p, "moveDelay") ?? 0));
    const turn = (p: number, dir: Dir) => { if (w.facing(p) !== dir) w.do("set", { id: p, comp: "facing", value: dir }); };

    /** One step attempt. A slide (slippery) never pushes: it only continues onto a free tile. */
    function step(p: number, dir: Dir, sliding = false): boolean {
      const from = w.pos(p); if (!from) return false;
      turn(p, dir);
      const to = { x: from.x + DELTA[dir].x, y: from.y + DELTA[dir].y, area: from.area };
      if (!w.isFree(to.x, to.y, p, to.area)) {
        if (sliding) return false;
        w.emit("player.blocked", { dir, target: to });
        if (!w.isFree(to.x, to.y, p, to.area)) return false;
      }
      if (!w.do("move", { id: p, x: to.x, y: to.y, area: to.area })) return false;
      w.emit("player.moved", { from, to, dir });
      if (w.at(to.x, to.y, to.area).some((id) => id !== p && !!w.info(id)?.tags.includes("slippery"))) { slipDir = dir; slipTimer = interval(p); }
      return true;
    }

    return {
      migrate() {
        const p = w.player();
        if (p && w.get(p, "facing") === null) w.do("set", { id: p, comp: "facing", value: "down" });
      },
      onInput(key, kind) {
        if (kind === "escape" || key === "escape") { held = []; return; }
        if (!isDir(key)) return;
        if (kind === "up") { held = held.filter((d) => d !== key); return; }
        if (kind !== "down") return;
        held = held.filter((d) => d !== key); held.push(key); // last pressed wins
        holdTicks = 0; stepTimer = 0;
        if (slipDir) return; // sliding: the key counts once the slide stops
        const p = w.player(); if (!p) return;
        // A new direction only turns; the direction already faced steps at once.
        if (w.facing(p) !== key) turn(p, key);
        else { step(p, key); stepTimer = interval(p); }
      },
      onTick() {
        const p = w.player(); if (!p) return;
        if (slipDir) {
          if (--slipTimer > 0) return;
          const d = slipDir; slipDir = null; step(p, d, true);
          return;
        }
        if (!held.length) return;
        const dir = held[held.length - 1];
        holdTicks++;
        if (dir !== w.facing(p)) { turn(p, dir); holdTicks = 0; return; }
        if (stepTimer > 0) { if (--stepTimer === 0) { step(p, dir); stepTimer = interval(p); } return; }
        // Held past the tap time: start walking.
        if (holdTicks === TUNING.tapTurnTicks) { step(p, dir); stepTimer = interval(p); }
      },

      // ---- tests (run in the 12x12 arena, player at (5, 5) facing down) ----
      test_walk() {
        const p = w.player();
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 6 && w.pos(p)?.y === 5, "player stepped one tile right");
        w.check(w.facing(p) === "right", "facing follows the walk");
        w.check(w.events("player.moved").length === 1, "player.moved fired once");
        w.must("sim.walk", { dir: "right", steps: 3 });
        w.check(w.pos(p)?.x === 9, "holding walks three more tiles");
      },
      test_turn_only() {
        const p = w.player();
        w.must("sim.face", { dir: "left" });
        w.check(w.pos(p)?.x === 5 && w.pos(p)?.y === 5, "a tap on a new direction doesn't move");
        w.check(w.facing(p) === "left", "a tap turns");
      },
      test_hold_pace() {
        const p = w.player();
        w.must("sim.face", { dir: "right" });
        w.must("sim.key", { key: "right", kind: "down" }); // facing right already: steps at once
        w.must("sim.wait", { ticks: TUNING.stepTicks * 3 - 1 });
        w.check(w.pos(p)?.x === 9, "holding steps once per stepTicks");
        w.must("sim.key", { key: "right", kind: "up" });
      },
      test_water_blocks() {
        const p = w.player();
        w.must("tile.set", { x: 6, y: 5, sprite: "stream_h" });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 5, "water blocked the step");
        w.check(w.events("player.blocked").length === 1, "player.blocked fired");
      },
      test_solid_blocks() {
        const p = w.player();
        w.must("spawn", { type: "test_block", x: 6, y: 5 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 5, "a solid entity blocked the step");
      },
      test_map_edge_blocks() {
        const p = w.player();
        w.must("sim.teleport", { x: 0, y: 5 });
        w.must("sim.walk", { dir: "left" });
        w.check(w.pos(p)?.x === 0, "the map edge blocked the step");
      },
      test_focus_blocks_walking() {
        const p = w.player();
        w.must("focus", { mode: "freeze" });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 5, "no step while focus is held");
        w.must("release");
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 6, "walking works again after release");
      },
      test_log_blocks_both_tiles() {
        const p = w.player();
        // Log at (6, 5) covers (6, 5) and (6, 4); blocks behind and below keep push from moving it.
        w.must("spawn", { type: "log_fallen", x: 6, y: 5 });
        w.must("spawn", { type: "test_block", x: 7, y: 5 });
        w.must("spawn", { type: "test_block", x: 6, y: 6 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 5, "the log's lower tile blocks from the left");
        w.must("sim.teleport", { x: 5, y: 4 });
        w.must("sim.walk", { dir: "right" });
        w.check(w.pos(p)?.x === 5 && w.pos(p)?.y === 4, "the log's upper tile blocks from the left");
        w.must("sim.teleport", { x: 6, y: 3 });
        w.must("sim.walk", { dir: "down" });
        w.check(w.pos(p)?.y === 3, "the log's upper tile blocks from above");
      },
      test_move_delay() {
        const p = w.player();
        w.must("set", { id: p, comp: "moveDelay", value: 12 });
        w.must("sim.face", { dir: "right" });
        w.must("sim.key", { key: "right", kind: "down" });
        w.must("sim.wait", { ticks: TUNING.stepTicks * 3 - 1 });
        w.must("sim.key", { key: "right", kind: "up" });
        w.check(w.pos(p)?.x === 7, "moveDelay 12 halves the pace");
      },
      test_slippery() {
        const p = w.player();
        const ice = w.must<number>("spawn", { type: "daisy", x: 6, y: 5 });
        w.must("tag", { id: ice, tag: "slippery" });
        w.must("sim.walk", { dir: "right" });
        w.must("sim.wait", { ticks: TUNING.stepTicks * 2 });
        w.check(w.pos(p)?.x === 7, "slippery ground carried the player one more tile");
      },
    };
  },
};
