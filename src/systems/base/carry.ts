// Base system: carry. Pick up and Drop as interactions (spec 6, 9).
import { footprintTiles } from "../../engine/catalog";
import type { Game } from "../../engine/runtime";
import type { LoadedSystem } from "../../engine/registry";
import { DELTA, facedEntityId, type Dir } from "../../engine/interactions";

export function dropPosFor(game: Game, heldTypeSprite: string): { x: number; y: number; area: string } | null {
  const p = game.eng.playerRec(); if (!p?.pos) return null;
  const facing = (p.comps.get("facing") as Dir) ?? "down";
  const d = DELTA[facing] ?? DELTA.down;
  const fpTiles = footprintTiles(heldTypeSprite, 0, 0);
  const h = Math.max(...fpTiles.map((t) => -t.y)) + 1;
  const y = d.y > 0 ? p.pos.y + d.y + (h - 1) : p.pos.y + d.y;
  return { x: p.pos.x + d.x, y, area: p.pos.area };
}

export function createCarry(game: Game): LoadedSystem {
  return {
    isBase: true,
    manifest: {
      id: "carry", why: "The player can pick things up, carry them, and put them down.", buildsOn: ["movement"], replaces: [],
      entities: {}, components: { held: "{ id } of the entity in the player's hands, or absent" },
      interactions: [
        { verb: "pick_up", label: "Pick up", target: "#item", held: "none" },
        { verb: "drop", label: "Drop", target: "held" },
      ],
      reactions: [], emits: {}, shots: [],
    },
    perform: (verb, target, held) => {
      const eng = game.eng;
      const p = eng.playerRec(); if (!p?.pos) return;
      if (verb === "pick_up") {
        const id = target || facedEntityId(eng);
        const rec = eng.recById(id);
        if (!rec || !rec.tags.has("item")) return;
        if (!game.call("carry", { op: "lift", id }).ok) return;
        game.call("carry", { op: "set", id: p.id, comp: "held", value: { id } });
        game.emit("(engine)", "item.picked", { item: id });
      } else if (verb === "drop") {
        const id = held || (p.comps.get("held") as { id?: number } | undefined)?.id || 0;
        const rec = id ? eng.recById(id) : undefined;
        if (!rec) { game.call("carry", { op: "remove", id: p.id, comp: "held" }); return; }
        const pos = dropPosFor(game, eng.spriteIdOf(rec));
        if (!pos) return;
        const free = eng.footprintFreeFor(eng.spriteIdOf(rec), pos.x, pos.y, rec.id, pos.area);
        if (!free) {
          game.call("carry", { op: "fx.float", text: "No room", x: p.pos.x, y: p.pos.y, area: p.pos.area });
          return;
        }
        if (!game.call("carry", { op: "place", id, x: pos.x, y: pos.y, area: pos.area }).ok) return;
        game.call("carry", { op: "remove", id: p.id, comp: "held" });
        game.emit("(engine)", "item.dropped", { item: id, pos });
      }
    },
  };
}
