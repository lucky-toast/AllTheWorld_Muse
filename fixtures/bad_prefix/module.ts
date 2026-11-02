import { emit, jsonPos } from "sdk";

export function onTick(): void {
  emit("fire.lit", `{"pos":${jsonPos(1, 1)}}`);
}
