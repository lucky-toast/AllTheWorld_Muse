import { Engine, mulberry } from "../engine/engine";
import { registerWorldTypes } from "./types";
import { TUNING } from "../tuning";
export const MAP_W = 30, MAP_H = 20;
// Hand-made forest clearing, ~30x20. Organic meadow in the middle, forest border
// of varying depth, one short stream near the south edge, sparse natural clusters.
export function buildWorld(): Engine {
  const rand = mulberry(42);
  const grid: string[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < MAP_W; x++) {
      const dx = (x - 14.5) / 10.5, dy = (y - 9.5) / 6.8;
      const meadow = dx * dx + dy * dy < 0.92 + rand() * 0.22;
      const r = rand();
      row.push(meadow ? (r < 0.16 ? "grass_detail" : "grass") : (r < 0.2 ? "grass_dark_detail" : "grass_dark"));
    }
    grid.push(row);
  }
  const sy = 16;
  grid[sy][3] = "stream_h_left"; for (let x = 4; x <= 7; x++) grid[sy][x] = "stream_h"; grid[sy][8] = "stream_h_right";
  const eng = new Engine(MAP_W, MAP_H, grid, TUNING.seed);
  registerWorldTypes(eng);
  const w = eng.world();
  const spawn = (t: string, x: number, y: number) => w.spawn(t, { x, y });
  // Border: dense clusters of varying depth so it reads as forest, not a ring.
  for (let i = 0; i < 8; i++) {
    const x = i * 4 - (i % 2);
    spawn(i % 3 === 0 ? "tree_cluster" : "tree_pine_cluster", x, [2, 3, 2, 3, 2, 2, 3, 2][i]);
    spawn(i % 2 ? "tree_pine_cluster" : "tree_cluster", x, 19);
  }
  for (let y = 5; y < 19; y += 4) { spawn("tree_pine_cluster", 0, y); spawn("tree_cluster", 26, y); }
  spawn("tree_cluster", 0, 19); spawn("tree_pine_cluster", 26, 3);
  // Sparse interior trees / rocks, in small natural clusters.
  spawn("tree_big_green", 4, 6); spawn("stump_big", 7, 7); spawn("tree_round", 23, 6);
  spawn("tree_round_light", 5, 13); spawn("tree_pine", 24, 13);
  spawn("rock_brown", 9, 17); spawn("rock_gray", 20, 15); spawn("rock_brown_small", 11, 15);
  for (const [t, x, y] of [["bush", 8, 5], ["fern", 21, 8], ["grass_tuft", 12, 6], ["grass_tuft", 17, 12], ["daisy", 13, 9], ["daisy", 16, 11], ["flower_red", 14, 8], ["flower_red", 18, 9], ["bush", 22, 11], ["fern", 9, 11]] as const) spawn(t, x, y);
  spawn("log_fallen", 12, 8); spawn("log_fallen", 20, 12); spawn("crate", 17, 9);
  spawn("branch", 11, 10); spawn("branch", 18, 13); spawn("stone", 14, 11); spawn("stone", 21, 10);
  const player = spawn("player", 15, 11);
  player.set("facing", "down");
  return eng;
}
/** Empty walkable arena used by every base-system test so map changes can't break them. */
export function buildArena(w = 12, h = 12): Engine {
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => "grass"));
  const eng = new Engine(w, h, grid, TUNING.seed);
  registerWorldTypes(eng);
  eng.registerType("test_item", { sprite: "branch", tags: ["item"] }, "test");
  eng.registerType("test_block", { sprite: "rock_gray_small", tags: ["solid"] }, "test");
  eng.registerType("test_pushable", { sprite: "crate", tags: ["pushable"] }, "test");
  const p = eng.world().spawn("player", { x: 5, y: 5 }); p.set("facing", "down");
  return eng;
}
