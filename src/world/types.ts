// Base entity-type registry: the map's types with their sprites and tags.
// Systems add more via their `entities`; `spawn` only accepts registered names.
import type { EntityTypeDef } from '../engine/api';

export const BASE_TYPES: Record<string, EntityTypeDef> = {
  // The player.
  player: { sprite: 'player', tags: ['player'] },

  // Things to interact with: logs are both item and pushable on purpose.
  log_fallen: { sprite: 'log_fallen', tags: ['item', 'pushable'] },
  log_fallen_mossy: { sprite: 'log_fallen_mossy', tags: ['item', 'pushable'] },
  crate: { sprite: 'crate', tags: ['pushable'] },
  branch: { sprite: 'branch', tags: ['item'] },
  stone: { sprite: 'stone', tags: ['item'] },

  // Solid trees, stumps, and rocks.
  tree_round: { sprite: 'tree_round', tags: ['solid', 'tree'] },
  tree_pine: { sprite: 'tree_pine', tags: ['solid', 'tree'] },
  tree_big_green: { sprite: 'tree_big_green', tags: ['solid', 'tree'] },
  tree_pine_cluster: { sprite: 'tree_pine_cluster', tags: ['solid', 'tree'] },
  tree_cluster: { sprite: 'tree_cluster', tags: ['solid', 'tree'] },
  stump_big: { sprite: 'stump_big', tags: ['solid', 'stump'] },
  rock_brown: { sprite: 'rock_brown', tags: ['solid', 'rock'] },
  rock_gray: { sprite: 'rock_gray', tags: ['solid', 'rock'] },

  // Light-touch decoration, never solid.
  bush: { sprite: 'bush', tags: ['decor'] },
  fern: { sprite: 'fern', tags: ['decor'] },
  grass_tuft: { sprite: 'grass_tuft', tags: ['decor'] },
  daisy: { sprite: 'daisy', tags: ['decor'] },
  flower_red: { sprite: 'flower_red', tags: ['decor'] },
};
