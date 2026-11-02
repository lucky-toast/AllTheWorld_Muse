import raw from "../catalog.json";

export interface CatalogEntry {
  id: string;
  file: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  frameW?: number;
  frameH?: number;
  frames?: number;
  tags: string[];
  footprint?: { x?: number; w: number; h: number };
  layer?: string;
  anims?: Record<string, { from?: number; to?: number; rows?: number[]; fps?: number; loop?: boolean }>;
  dirs?: string[];
  poses?: Record<string, [number, number]>;
  pieces?: boolean;
  offset?: { x: number; y: number };
  desc?: string;
}

export interface CatalogFile {
  root: string;
  tileSize: number;
  sprites: CatalogEntry[];
}

export const CATALOG = raw as unknown as CatalogFile;
const byId = new Map(CATALOG.sprites.map((s) => [s.id, s]));

export function catalogGet(id: string): CatalogEntry | undefined {
  return byId.get(id);
}

export function catalogFind(tag: string): string[] {
  return CATALOG.sprites.filter((s) => s.tags.includes(tag)).map((s) => s.id);
}

/** Tiles an entity with this sprite occupies, relative to its bottom-left pos. Footprint extends up (decreasing y). */
export function footprintTiles(spriteId: string, x: number, y: number): { x: number; y: number }[] {
  const fp = catalogGet(spriteId)?.footprint ?? { w: 1, h: 1 };
  const ox = fp.x ?? 0;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < fp.w; i++) for (let j = 0; j < fp.h; j++) out.push({ x: x + ox + i, y: y - j });
  return out;
}

export function footprintOf(spriteId: string) {
  return catalogGet(spriteId)?.footprint ?? { w: 1, h: 1 };
}
