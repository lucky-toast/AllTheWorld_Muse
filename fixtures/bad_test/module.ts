// bad_test: fails at Tests. Dropping a stone is meant to strike a spark, but it only floats text.
import { parse, floatText, query, simTeleport, simFace, simGive, simInteract, check } from "sdk";

export function onEvent(name: string, payload: string): void {
  const p = parse(payload).get("pos");
  floatText("tick", <i32>p.get("x").num(), <i32>p.get("y").num());
}

export function test_dropping_a_stone_strikes_a_spark(): void {
  simTeleport(15, 11);
  simGive("stone");
  simFace("down");
  simInteract();
  check(query("spark").length == 1, "a spark appeared");
}
