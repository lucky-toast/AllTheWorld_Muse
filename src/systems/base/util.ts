// Shared helpers for the base systems. Pure functions over the world API:
// direction math, the faced-entity rule, and catalog footprint tiles.
import type { Dir, Entity, Pos, World } from 'engine/api';

/** Tile step per direction (y grows downward, so up is y - 1). */
export const DELTAS: Record<Dir, Pos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** True when this value is a real direction (guards malformed input events). */
export function isDir(value: unknown): value is Dir {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right';
}

/** The tile one step from pos toward dir. */
export function stepFrom(pos: Pos, dir: Dir): Pos {
  const d = DELTAS[dir];
  return { x: pos.x + d.x, y: pos.y + d.y };
}

/** The player entity, or undefined when this world has none. */
export function playerOf(world: World): Entity | undefined {
  return world.query('player')[0];
}

/** Finds any entity by id (every spawned entity carries a sprite component). */
export function byId(world: World, id: number): Entity | undefined {
  return world.query('sprite').find((e) => e.id === id);
}

/**
 * The faced entity: the one on the tile in front of the player, preferring
 * an item, then a pushable, then anything else (spawn order breaks ties).
 */
export function facedEntity(world: World, player: Entity): Entity | undefined {
  if (!player.pos) return undefined;
  const facing: unknown = player.get('facing');
  if (!isDir(facing)) return undefined;
  const front = stepFrom(player.pos, facing);
  const cands = world.at(front.x, front.y).filter((e) => e.id !== player.id);
  return cands.find((e) => e.has('item')) ?? cands.find((e) => e.has('pushable')) ?? cands[0];
}

/** Tiles a sprite's footprint covers from pos (mirrors the engine's rule). */
export function footprintTiles(world: World, spriteId: string, pos: Pos): Pos[] {
  const fp = world.catalog.get(spriteId).footprint ?? { w: 1, h: 1 };
  const xoff = fp.x ?? 0;
  const out: Pos[] = [];
  for (let dy = 0; dy < fp.h; dy++) {
    for (let dx = 0; dx < fp.w; dx++) {
      out.push({ x: pos.x + xoff + dx, y: pos.y - dy });
    }
  }
  return out;
}
