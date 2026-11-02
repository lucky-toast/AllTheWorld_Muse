// Base system: push. Reacts to player.blocked (spec 9).
import type { Game } from "../../engine/runtime";
import type { LoadedSystem } from "../../engine/registry";
import { DELTA, type Dir } from "../../engine/interactions";

export function createPush(game: Game): LoadedSystem {
  return {
    isBase: true,
    manifest: {
      id: "push", why: "Walking into crates and logs shoves them along.", buildsOn: ["movement"], replaces: [],
      entities: {}, components: {}, interactions: [], reactions: ["player.blocked"], emits: {}, shots: [],
    },
    onEvent: (name, payloadJson) => {
      if (name !== "player.blocked") return;
      const payload = JSON.parse(payloadJson) as { dir: string; target: { x: number; y: number; area: string } };
      const d = DELTA[payload.dir as Dir]; if (!d) return;
      const area = payload.target.area ?? game.eng.currentAreaId;
      const ids = game.eng.atIds(payload.target.x, payload.target.y, area);
      const id = ids.find((i) => game.eng.recById(i)?.tags.has("pushable"));
      if (id === undefined) return;
      const rec = game.eng.recById(id)!; if (!rec.pos) return;
      const nx = rec.pos.x + d.x, ny = rec.pos.y + d.y;
      if (!game.eng.footprintFreeFor(game.eng.spriteIdOf(rec), nx, ny, rec.id, rec.pos.area)) return;
      if (!game.call("push", { op: "move", id, x: nx, y: ny, area: rec.pos.area }).ok) return;
      game.emit("(engine)", "entity.bumped", { entity: id, dir: payload.dir });
    },
  };
}
