// bad_memory: fails at World check. Every onTick keeps another megabyte, so memory runs out.
import { player, check } from "sdk";

const hoard = new Array<ArrayBuffer>();

export function onTick(): void {
  hoard.push(new ArrayBuffer(1 << 20));
}

export function test_the_player_exists(): void { check(player() != 0, "the player exists"); }
