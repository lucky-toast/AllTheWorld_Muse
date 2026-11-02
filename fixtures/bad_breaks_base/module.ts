// bad_breaks_base: fails at World check. migrate turns the four tiles around the player into water.
import { playerPos, player, at, destroy, tileSet, tileGet, check } from "sdk";

function flood(x: i32, y: i32, area: string): void {
  // Whatever stands there would be in the water, so it goes first.
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) if (ids[i] != player()) destroy(ids[i]);
  tileSet(x, y, "pond", area);
}

export function migrate(): void {
  const p = playerPos(); if (!p) return;
  flood(p.x + 1, p.y, p.area);
  flood(p.x - 1, p.y, p.area);
  flood(p.x, p.y + 1, p.area);
  flood(p.x, p.y - 1, p.area);
}

export function test_the_moat_is_there(): void {
  const p = playerPos();
  const t = p ? tileGet(p.x + 1, p.y, p.area) : null;
  check(t != null && t.sprite == "pond", "water lies beside the player");
  const b = p ? tileGet(p.x, p.y + 1, p.area) : null;
  check(b != null && b.sprite == "pond", "water lies below the player");
}
