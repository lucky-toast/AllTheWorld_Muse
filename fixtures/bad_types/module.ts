// bad_types: fails at Compile. summonDragon isn't in the SDK.
import { player, summonDragon, check } from "sdk";

export function onTick(): void {
  summonDragon(player());
}

export function test_nothing(): void { check(true, "nothing to test"); }
