import { catalogGet } from "../engine/catalog";
import type { EntityType } from "../engine/engine";
// Base map entity types: name -> sprite + tags. Log is item+pushable on purpose.
function fromCatalog(id: string, extra: string[] = []): EntityType {
  const e = catalogGet(id)!;
  const tags = [...new Set([...e.tags.filter((t) => t !== "terrain"), ...extra])];
  return { sprite: id, tags };
}
export const WORLD_TYPES: Record<string, EntityType> = {
  player: { sprite: "player", tags: ["player"] },
  tree_pine_cluster: fromCatalog("tree_pine_cluster"), tree_cluster: fromCatalog("tree_cluster"),
  tree_big_green: fromCatalog("tree_big_green"), tree_round: fromCatalog("tree_round"),
  tree_round_light: fromCatalog("tree_round_light"), tree_pine: fromCatalog("tree_pine"),
  stump_big: fromCatalog("stump_big"), rock_brown: fromCatalog("rock_brown"), rock_gray: fromCatalog("rock_gray"),
  rock_brown_small: fromCatalog("rock_brown_small"),
  bush: fromCatalog("bush"), fern: fromCatalog("fern"), grass_tuft: fromCatalog("grass_tuft"),
  daisy: fromCatalog("daisy"), flower_red: fromCatalog("flower_red"),
  log_fallen: fromCatalog("log_fallen", ["item"]), crate: fromCatalog("crate"),
  branch: fromCatalog("branch"), stone: fromCatalog("stone"),
};
export function registerWorldTypes(eng: { registerType: (n: string, t: EntityType, o: string) => void }) {
  for (const [n, t] of Object.entries(WORLD_TYPES)) eng.registerType(n, t, "world");
}
