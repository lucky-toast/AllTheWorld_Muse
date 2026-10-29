// Map format (stable: the final hand-made map below keeps this shape) plus
// the simple placeholder clearing the early engine tests still use.
import { getSprite } from '../engine/catalog';
import { mulberry32 } from '../engine/rng';
import type { Pos } from '../engine/api';
import { BASE_TYPES } from './types';

/** One entity to spawn when the world boots. */
export interface MapSpawn {
  type: string;
  x: number;
  y: number;
}

/** The map: terrain sprite ids row-major, spawns, and the player's start. */
export interface MapData {
  width: number;
  height: number;
  tiles: string[];
  spawns: MapSpawn[];
  playerStart: Pos;
}

/** Simple placeholder clearing: open grass inside, trees all around. */
export function placeholderMap(): MapData {
  const width = 30;
  const height = 20;
  const rng = mulberry32(7); // fixed seed: the placeholder never shifts
  const tiles: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = Math.min(x, width - 1 - x, y, height - 1 - y);
      if (edge === 0) tiles.push('grass_dark'); // shade under the border trees
      else if (edge === 1) tiles.push(rng.next() < 0.5 ? 'grass_dark' : 'grass');
      else tiles.push(rng.next() < 0.08 ? 'grass_detail' : 'grass'); // sunlit meadow
    }
  }

  // Border ring: tree pairs top/bottom (2-wide footprints, no inward spill),
  // log pairs down the sides (tall 1x2 footprints, like a palisade).
  const spawns: MapSpawn[] = [];
  const topTrees = ['tree_round', 'tree_pine'];
  for (let x = 0; x < width; x += 2) {
    spawns.push({ type: topTrees[(x / 2) % 2], x, y: 0 });
    spawns.push({ type: topTrees[(x / 2 + 1) % 2], x, y: height - 1 });
  }
  const sideLogs = ['log_fallen', 'log_fallen_mossy'];
  for (let y = 2; y < height - 1; y += 2) {
    spawns.push({ type: sideLogs[(y / 2) % 2], x: 0, y });
    spawns.push({ type: sideLogs[(y / 2 + 1) % 2], x: width - 1, y });
  }

  return { width, height, tiles, spawns, playerStart: { x: 15, y: 10 } };
}

/**
 * The hand-made forest clearing: a sparse calm canvas with an open sunlit
 * meadow in the middle, grass_dark shade toward the trees, an organic forest
 * border with varied depth, one short stream, and a handful of interactables.
 */
export function finalMap(): MapData {
  const width = 30;
  const height = 20;
  // Open meadow, one [from, to] x-range per row: wide in the middle, ragged
  // and asymmetric at the edges so the clearing reads as organic, not a box.
  const meadow: Record<number, [number, number]> = {
    4: [11, 16],
    5: [8, 21],
    6: [7, 23],
    7: [6, 22],
    8: [7, 25],
    9: [5, 24],
    10: [6, 25],
    11: [5, 23],
    12: [7, 24],
    13: [8, 22],
    14: [10, 20],
  };
  const rng = mulberry32(11); // fixed seed: the detail sprinkle never shifts
  const tiles: string[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = meadow[y];
      if (m && x >= m[0] && x <= m[1]) {
        tiles.push(rng.next() < 0.12 ? 'grass_detail' : 'grass'); // sunlit meadow
      } else {
        tiles.push('grass_dark'); // shade toward the trees
      }
    }
  }
  const set = (x: number, y: number, id: string): void => {
    tiles[y * width + x] = id;
  };
  // One short straight stream near the south edge. No dirt paths anywhere.
  set(6, 15, 'stream_h_left');
  set(7, 15, 'stream_h');
  set(8, 15, 'stream_h');
  set(9, 15, 'stream_h');
  set(10, 15, 'stream_h_right');

  const spawns: MapSpawn[] = [];
  const pine = 'tree_pine_cluster';
  const leafy = 'tree_cluster';
  // Border back rows seal every edge tile; inward accents add varied depth.
  const edgeXs = [0, 4, 8, 12, 16, 20, 24, 26];
  const topMix = [pine, leafy, pine, pine, leafy, pine, leafy, pine];
  edgeXs.forEach((x, i) => spawns.push({ type: topMix[i], x, y: 2 }));
  const bottomMix = [leafy, pine, leafy, pine, pine, leafy, pine, leafy];
  edgeXs.forEach((x, i) => spawns.push({ type: bottomMix[i], x, y: 19 }));
  const sideYs = [5, 8, 11, 14, 17];
  const leftMix = [leafy, pine, pine, leafy, pine];
  sideYs.forEach((y, i) => spawns.push({ type: leftMix[i], x: 0, y }));
  const rightMix = [pine, leafy, pine, pine, leafy];
  sideYs.forEach((y, i) => spawns.push({ type: rightMix[i], x: 26, y }));
  // Inward accents, staggered and never mirrored.
  spawns.push(
    { type: pine, x: 6, y: 4 },
    { type: leafy, x: 17, y: 4 },
    { type: pine, x: 23, y: 5 },
    { type: leafy, x: 2, y: 16 },
    { type: pine, x: 14, y: 16 },
    { type: pine, x: 24, y: 15 },
    { type: leafy, x: 3, y: 8 },
    { type: pine, x: 2, y: 12 },
    { type: leafy, x: 22, y: 9 },
    { type: pine, x: 22, y: 14 },
  );
  // Sparing interior: trees at the meadow edge, a stump by the east trees,
  // and rocks along the stream. All solid.
  spawns.push(
    { type: 'tree_big_green', x: 7, y: 6 },
    { type: 'tree_round', x: 11, y: 3 },
    { type: 'tree_round', x: 24, y: 6 },
    { type: 'stump_big', x: 24, y: 11 },
    { type: 'rock_gray', x: 6, y: 14 },
    { type: 'rock_brown', x: 11, y: 15 },
  );
  // A handful of interactables, spread through the open middle.
  spawns.push(
    { type: 'log_fallen', x: 8, y: 9 },
    { type: 'log_fallen', x: 20, y: 12 },
    { type: 'crate', x: 16, y: 8 },
    { type: 'branch', x: 10, y: 11 },
    { type: 'branch', x: 17, y: 10 },
    { type: 'branch', x: 12, y: 7 },
    { type: 'stone', x: 8, y: 16 },
    { type: 'stone', x: 12, y: 14 },
    { type: 'stone', x: 21, y: 9 },
  );
  // Light decoration: a bush, a fern, tufts, and flowers in the sunny patches.
  spawns.push(
    { type: 'bush', x: 5, y: 9 },
    { type: 'fern', x: 20, y: 14 },
    { type: 'grass_tuft', x: 9, y: 12 },
    { type: 'grass_tuft', x: 16, y: 5 },
    { type: 'daisy', x: 15, y: 7 },
    { type: 'daisy', x: 11, y: 10 },
    { type: 'flower_red', x: 19, y: 13 },
  );

  // Shade: grass_dark under every tree, stump, and rock footprint, so meadow
  // grass never peeks out from under a canopy. Water is never overwritten.
  const shadeTypes = new Set([
    'tree_pine_cluster',
    'tree_cluster',
    'tree_big_green',
    'tree_round',
    'stump_big',
    'rock_gray',
    'rock_brown',
  ]);
  for (const s of spawns) {
    if (!shadeTypes.has(s.type)) continue;
    const sprite = BASE_TYPES[s.type]?.sprite;
    if (!sprite) continue;
    const fp = getSprite(sprite).footprint ?? { w: 1, h: 1 };
    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const tx = s.x + (fp.x ?? 0) + dx;
        const ty = s.y - dy;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        const cur = tiles[ty * width + tx];
        if (getSprite(cur).tags.includes('water')) continue;
        tiles[ty * width + tx] = 'grass_dark';
      }
    }
  }

  return { width, height, tiles, spawns, playerStart: { x: 15, y: 10 } };
}
