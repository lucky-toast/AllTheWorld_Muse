import type { Dir, Entity, Pos, World } from "../../engine/api";
export const DELTA: Record<Dir, Pos> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
export function player(w: World): Entity { return w.query("player")[0]; }
export function facing(e: Entity): Dir { return (e.get<string>("facing") ?? "down") as Dir; }
export function facedTile(w: World): Pos { const p = player(w); const d = DELTA[facing(p)]; return { x: p.pos!.x + d.x, y: p.pos!.y + d.y }; }
/** The faced entity: prefer an item, then pushable, then anything else (never the player). */
export function facedEntity(w: World): Entity | undefined {
  const p = player(w); const t = facedTile(w);
  const es = w.at(t.x, t.y).filter((e) => e.id !== p.id);
  return es.find((e) => e.has("item")) ?? es.find((e) => e.has("pushable")) ?? es[0];
}
export function footprintTiles(w: World, spriteId: string, x: number, y: number): Pos[] {
  const fp = w.catalog.get(spriteId)?.footprint ?? { w: 1, h: 1 }; const ox = fp.x ?? 0; const out: Pos[] = [];
  for (let i = 0; i < fp.w; i++) for (let j = 0; j < fp.h; j++) out.push({ x: x + ox + i, y: y - j });
  return out;
}
export function spriteId(e: Entity): string { return (e.get<{ id: string }>("sprite"))?.id ?? ""; }
/** Free = walkable terrain and no player/solid/pushable/item entity other than self. Uses only world.at/tiles/catalog. */
export function tileFree(w: World, x: number, y: number, selfId?: number): boolean {
  const tid = w.tiles.get(x, y); if (tid === null) return false;
  const entry = w.catalog.get(tid); if (!entry || !entry.tags.includes("walkable") || entry.tags.includes("water")) return false;
  return w.at(x, y).every((e) => e.id === selfId || !(e.has("player") || e.has("solid") || e.has("pushable") || e.has("item")));
}
export function footprintFree(w: World, e: Entity, x: number, y: number): boolean {
  return footprintTiles(w, spriteId(e), x, y).every((t) => tileFree(w, t.x, t.y, e.id));
}
export function isBusy(w: World): boolean { const p = player(w); return !!p?.has("busy"); }
