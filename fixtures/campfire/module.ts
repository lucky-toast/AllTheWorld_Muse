import {
  anim, at, check, destroy, emit, get, getNum, infoPos, infoType, isFree, jsonInt,
  jsonPos, jsonRaw, player, query, set, setNum, simFace, simGive, simInteract,
  simTeleport, simTime, simWalk, simWait, spawn, tag, tileGet,
} from "sdk";

const BURN_TICKS: f64 = 900;

function collectBranches(cx: i32, cy: i32, area: string): Array<i32> {
  const out = new Array<i32>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ids = at(cx + dx, cy + dy, area);
      for (let i = 0; i < ids.length; i++) if (infoType(ids[i]) == "branch" && !out.includes(ids[i])) out.push(ids[i]);
    }
  }
  return out;
}

function footprintUsable(px: i32, py: i32, area: string, branches: Array<i32>): bool {
  const xs: i32[] = [px, px + 1, px, px + 1];
  const ys: i32[] = [py, py, py - 1, py - 1];
  for (let i = 0; i < 4; i++) {
    const ids = at(xs[i], ys[i], area);
    for (let j = 0; j < ids.length; j++) {
      if (branches.includes(ids[j])) continue;
      if (infoPos(ids[j])) return false;
    }
    const t = tileGet(xs[i], ys[i], area);
    if (!t.length || t == "null" || !t.includes("walkable") || t.includes("water")) return false;
  }
  return true;
}

export function onEvent(name: string, payload: string): void {
  if (name != "item.dropped") return;
  const item = jsonRaw(payload, "item");
  const itemId = jsonInt(item, "id");
  if (!itemId || infoType(itemId) != "branch") return;
  const dropped = jsonRaw(payload, "pos");
  const cx = jsonInt(dropped, "x");
  const cy = jsonInt(dropped, "y");
  const area = infoPos(itemId) ? infoPos(itemId)!.area : "";
  const branches = collectBranches(cx, cy, area);
  if (branches.length < 3) return;
  const candX: i32[] = [cx, cx - 1, cx, cx - 1];
  const candY: i32[] = [cy, cy, cy + 1, cy + 1];
  let px = 0; let py = 0; let found = false;
  for (let i = 0; i < 4 && !found; i++) {
    if (footprintUsable(candX[i], candY[i], area, branches)) { px = candX[i]; py = candY[i]; found = true; }
  }
  if (!found) return;
  for (let i = 0; i < 3; i++) destroy(branches[i]);
  const pit = spawn("firepit", px, py, area);
  if (pit < 0) return;
  const flame = spawn("flame", px, py, area);
  setNum(pit, "burnTicksLeft", BURN_TICKS);
  setNum(pit, "flameId", flame);
  tag(pit, "burning");
  set(pit, "light", `{"radius":40,"color":"#ff9a3c","strength":0.9,"flicker":true}`);
  if (flame > 0) {
    set(flame, "sprite", `{"id":"fx_fire","anim":"ignite","z":10}`);
    anim(flame, "ignite", "ignite_done");
  }
  emit("campfire.lit", `{"pit":${pit},"pos":${jsonPos(px, py, area)}}`);
}

export function onTimer(name: string): void {
  if (name != "ignite_done") return;
  const flames = query("flame");
  for (let i = 0; i < flames.length; i++) {
    set(flames[i], "sprite", `{"id":"fx_fire","anim":"burn","z":10}`);
    anim(flames[i], "burn");
  }
}

export function onTick(): void {
  const pits = query("burning");
  for (let i = 0; i < pits.length; i++) {
    const pit = pits[i];
    const left = getNum(pit, "burnTicksLeft") - 1;
    if (left > 0) { setNum(pit, "burnTicksLeft", left); continue; }
    const pos = infoPos(pit);
    if (!pos) continue;
    const flame = I32.parseInt(`${getNum(pit, "flameId")}`);
    if (flame > 0 && infoType(flame).length) {
      set(flame, "sprite", `{"id":"fx_fire","anim":"die","z":10}`);
      anim(flame, "die");
      destroy(flame);
    }
    destroy(pit);
    const ash = spawn("firepit_ash", pos.x, pos.y, pos.area);
    emit("campfire.out", `{"pit":${ash},"pos":${jsonPos(pos.x, pos.y, pos.area)}}`);
  }
}

function dropBranchAt(x: i32, y: i32, dir: string): void {
  simGive("branch");
  simTeleport(x, y);
  simFace(dir);
  simInteract();
}

function buildFire(): void {
  dropBranchAt(15, 12, "down");
  dropBranchAt(16, 12, "down");
  dropBranchAt(14, 14, "right");
}

function firstBurning(): i32 {
  const pits = query("burning");
  return pits.length ? pits[0] : 0;
}

export function test_three_branches_make_a_fire(): void {
  buildFire();
  check(firstBurning() > 0, "three branches make a fire");
  check(query("flame").length == 1, "the fire has a flame");
}

export function test_two_branches_do_not_make_a_fire(): void {
  dropBranchAt(15, 12, "down");
  dropBranchAt(16, 12, "down");
  check(firstBurning() == 0, "two branches do not make a fire");
}

export function test_the_fire_has_a_light(): void {
  buildFire();
  const pit = firstBurning();
  check(pit > 0 && get(pit, "light") != "null", "the fire has a light");
}

export function test_it_burns_out_to_ash(): void {
  buildFire();
  const pit = firstBurning();
  setNum(pit, "burnTicksLeft", 3);
  simWait(10);
  check(query("ash").length == 1, "it burns out to ash");
  check(firstBurning() == 0, "no fire is burning after it burns out");
}

export function test_the_player_cannot_walk_through_a_lit_fire(): void {
  buildFire();
  const pit = firstBurning();
  const pos = infoPos(pit);
  check(pos != null, "the fire is placed");
  if (!pos) return;
  simTeleport(pos.x - 1, pos.y, pos.area);
  simFace("right");
  simWalk("right");
  const p = infoPos(player());
  check(p != null && p.x == pos.x - 1, "the player can't walk through a lit fire");
}

export function shot_just_lit(): void {
  buildFire();
  simTime("night");
}

export function shot_ash(): void {
  buildFire();
  const pit = firstBurning();
  if (pit > 0) setNum(pit, "burnTicksLeft", 3);
  simTime("night");
}
