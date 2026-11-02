import { at, destroy, infoPos, player, tileSet } from "sdk";

function flood(x: i32, y: i32, area: string, playerId: i32): void {
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] != playerId) destroy(ids[i]);
  }
  tileSet(x, y, "stream_h", area);
}

export function migrate(): void {
  const p = player();
  const pos = p ? infoPos(p) : null;
  if (!pos) return;
  flood(pos.x + 1, pos.y, pos.area, p);
  flood(pos.x - 1, pos.y, pos.area, p);
  flood(pos.x, pos.y + 1, pos.area, p);
  flood(pos.x, pos.y - 1, pos.area, p);
}
