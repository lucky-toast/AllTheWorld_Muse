// bad_manifest: fails at Manifest. Its dragon's sprite "dragon_huge" isn't in the catalog.
import { query, spawn, check } from "sdk";

export function migrate(): void {
  if (!query("dragon").length) spawn("dragon", 4, 4);
}

export function test_there_is_a_dragon(): void {
  check(query("dragon").length == 1, "a dragon sleeps in the meadow");
}
