import { check, query } from "sdk";

export function onTick(): void {}

export function test_a_spark_is_spawned(): void {
  check(query("spark").length > 0, "a spark is spawned");
}
