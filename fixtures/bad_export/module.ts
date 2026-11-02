// bad_export: fails at Module. The manifest lists an interaction, but there is no perform.
import { player, check } from "sdk";

export function onTick(): void {
  player();
}

export function test_the_player_exists(): void { check(player() != 0, "the player exists"); }
