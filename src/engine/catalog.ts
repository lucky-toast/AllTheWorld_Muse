// Catalog index: sprites by id and by tag, from src/catalog.json.
import catalogData from '../catalog.json';
import type { CatalogEntry } from './api';

const raw = catalogData as unknown as {
  pack: string;
  root: string;
  tileSize: number;
  sprites: CatalogEntry[];
};

export const CATALOG_ROOT = raw.root; // asset path prefix under public/assets/
export const TILE_SIZE = raw.tileSize; // 16px tiles everywhere
export const CATALOG: readonly CatalogEntry[] = raw.sprites;

const byId = new Map<string, CatalogEntry>();
const byTag = new Map<string, string[]>();
for (const sprite of raw.sprites) {
  byId.set(sprite.id, sprite);
  for (const tag of sprite.tags ?? []) {
    const list = byTag.get(tag) ?? [];
    list.push(sprite.id);
    byTag.set(tag, list);
  }
}

/** True when this catalog sprite id exists. */
export function hasSprite(id: string): boolean {
  return byId.has(id);
}

/** One sprite's entry; throws a clear error on unknown ids. */
export function getSprite(id: string): CatalogEntry {
  const entry = byId.get(id);
  if (!entry) throw new Error(`unknown sprite "${id}" (nothing by that id in src/catalog.json)`);
  return entry;
}

/** Sprite ids carrying a catalog tag, in catalog order. */
export function findSprites(tag: string): string[] {
  return [...(byTag.get(tag) ?? [])];
}

/** True when the sprite's tags include "walkable" (water never is). */
export function isWalkableSprite(id: string): boolean {
  return getSprite(id).tags.includes('walkable');
}
