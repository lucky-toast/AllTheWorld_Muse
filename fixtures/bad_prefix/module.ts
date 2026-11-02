// bad_prefix: fails at Manifest. It emits "fire.lit", which doesn't start with "bad_prefix.".
import { emit, Obj, playerPos, check } from "sdk";

export function onEvent(name: string, payload: string): void {
  const p = playerPos(); if (!p) return;
  emit("fire.lit", new Obj().raw("pos", p.toString()));
}

export function test_nothing(): void { check(true, "nothing to test"); }
