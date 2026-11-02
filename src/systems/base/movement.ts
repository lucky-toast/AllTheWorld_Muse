// Base system: movement. Turn sets facing; a step faces that way and moves if free (spec 9).
import { TUNING } from "../../tuning";
import type { Game } from "../../engine/runtime";
import type { LoadedSystem } from "../../engine/registry";
import { DELTA, type Dir } from "../../engine/interactions";

export function createMovement(game: Game): LoadedSystem {
  let cooldownUntil = 0;
  const player = () => game.eng.playerRec();
  function turn(dir: string): void {
    const p = player(); if (!p) return;
    game.call("movement", { op: "set", id: p.id, comp: "facing", value: dir });
    game.interactions.resetCycle();
    game.interactions.refresh();
  }
  function step(dir: string): void {
    const p = player(); if (!p?.pos) return;
    if (game.focus.held) return; // focus blocks walking
    game.interactions.resetCycle();
    turn(dir);
    if (game.eng.tickCount < cooldownUntil) return;
    const delay = p.comps.get("moveDelay");
    const extra = typeof delay === "number" && delay > 0 ? Math.floor(delay) : 0;
    const d = DELTA[dir as Dir]; if (!d) return;
    const from = { ...p.pos };
    const target = { x: p.pos.x + d.x, y: p.pos.y + d.y, area: p.pos.area };
    const doStep = (dest: { x: number; y: number; area: string }): boolean => {
      const cur = player(); if (!cur?.pos) return false;
      const r = game.call("movement", { op: "move", id: cur.id, x: dest.x, y: dest.y, area: dest.area });
      if (!r.ok) return false;
      cooldownUntil = game.eng.tickCount + extra;
      game.emit("(engine)", "player.moved", { from: { ...from }, to: dest, dir });
      return true;
    };
    if (game.eng.isFreeFor(target.x, target.y, p.id, target.area)) {
      if (doStep(target)) slip(dir);
      return;
    }
    game.emit("(engine)", "player.blocked", { dir, target });
    // Re-check after reactions (push may have cleared the way).
    const p2 = player();
    if (p2?.pos && game.eng.isFreeFor(target.x, target.y, p2.id, target.area)) {
      from.x = p2.pos.x; from.y = p2.pos.y; from.area = p2.pos.area;
      if (doStep(target)) slip(dir);
    }
  }
  function slip(dir: string): void {
    // Slippery: an entity tagged slippery under the player keeps them going one more step if free.
    const p = player(); if (!p?.pos) return;
    const under = game.eng.atIds(p.pos.x, p.pos.y, p.pos.area).some((id) => game.eng.recById(id)?.tags.has("slippery"));
    if (!under) return;
    const d = DELTA[dir as Dir];
    const target = { x: p.pos.x + d.x, y: p.pos.y + d.y, area: p.pos.area };
    if (!game.eng.isFreeFor(target.x, target.y, p.id, target.area)) return;
    const from = { ...p.pos };
    const r = game.call("movement", { op: "move", id: p.id, x: target.x, y: target.y, area: target.area });
    if (r.ok) game.emit("(engine)", "player.moved", { from, to: target, dir });
  }
  game.movementApi = { turn, step };
  void TUNING;
  return {
    isBase: true,
    manifest: {
      id: "movement", why: "The player can walk the clearing.", buildsOn: [], replaces: [],
      entities: {}, components: { facing: "string: direction the player faces, on the player", moveDelay: "number: extra ticks per step, on the player" },
      interactions: [], reactions: [], emits: {}, shots: [],
    },
    migrate: () => { const p = player(); if (p && p.comps.get("facing") === undefined) game.call("movement", { op: "set", id: p.id, comp: "facing", value: "down" }); },
  };
}
