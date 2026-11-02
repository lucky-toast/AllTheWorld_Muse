// bad_loop: fails at World check. On its 50th tick onTick loops forever, so it runs out of fuel.
import { player, check } from "sdk";

let ticks = 0;

export function onTick(): void {
  ticks++;
  if (ticks < 50) return;
  let n: i64 = 0;
  while (true) { n++; }
}

export function test_the_player_exists(): void { check(player() != 0, "the player exists"); }
