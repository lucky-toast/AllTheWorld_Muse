// cottage: a wooden cottage in the clearing with a furnished room inside, in its own area.
// Go in: stand on the doorstep (doorOf), face the door and press E. Go out: step onto the
// lit doorway tile at the bottom of the room. The room is an area the size a small room
// should be (8x6); its edge blocks like the map's, so no wall tiles are needed. The back
// row is lined with solid windows, and tall furniture stands on the row below them and
// draws up over them, so nothing can be walked behind.
// The cottage keeps what later systems need on itself: "inside" (the area id) and
// "insideDoor" (the doorway tile). Every way in or out emits an event.
import {
  Obj, parse, Pos, query, typeOf, posOf, getStr, get, set, setStr, setNum, spawn, destroy,
  spaceFind, isFree, doorOf, playerPos, tileGet, tileSet, tileStamp, floatText, emit,
  areaCreate, areaList, areaSize, areaCurrent, travel,
  simTeleport, simFace, simInteract, simWalk, simEvents, check,
} from "sdk";

const OUTSIDE = "clearing";       // the main map's area id
const SPOT_X = 19, SPOT_Y = 4;    // where to look for room for the cottage: north-east of the start
const ROOM_W = 8, ROOM_H = 6;     // the room, in tiles
const DOOR_X = 3;                 // the doorway's column, on the room's bottom row
const FLOOR = "interior_floor_brown_plain";
const RUG = "interior_floor_tan_ornate";
const DOORWAY = "interior_doorway_light";

/** The cottage, or 0. query takes a tag, never a type: the cottage type carries the "cottage" tag. */
function theHouse(): i32 {
  const ids = query("cottage");
  for (let i = 0; i < ids.length; i++) if (typeOf(ids[i]) == "cottage") return ids[i];
  return 0;
}

/** `p`, or the nearest free tile to it in its area, or null when the area has none. */
function freeNear(p: Pos): Pos | null {
  if (isFree(p.x, p.y, 0, p.area)) return p;
  return spaceFind(p.x, p.y, 1, 1, p.area);
}

/** Spawn one piece of furniture exactly at (x, y) in the room. 0 when refused. */
function put(type: string, x: i32, y: i32, inside: string, house: i32): i32 {
  const id = spawn(type, x, y, inside, true);
  if (id) setNum(id, "houseOf", house);
  return id;
}

/**
 * The room, on a fresh area:
 *   row 0  B B W W s s d p   windows (W) line the back wall; the tall shelf (s), drawers (d)
 *   row 1  B B L . S S D P   and plant (p) stand on row 1 and draw up over row 0
 *   row 2  B B . . . . . .   B bed (2x3), L lamp
 *   row 3  . r r r . T T t   r rug (floor tiles), T table (2x1), t stool
 *   row 4  . r r r . . . .   the player arrives at (3, 4)
 *   row 5  . . . D . . . .   D the lit doorway: stepping on it leads out
 */
function furnish(inside: string, house: i32): void {
  const rug = new Array<Array<string | null>>();
  for (let r = 0; r < 2; r++) {
    const row = new Array<string | null>();
    for (let c = 0; c < 3; c++) row.push(RUG);
    rug.push(row);
  }
  tileStamp(1, 3, rug, inside, true);
  tileSet(DOOR_X, ROOM_H - 1, DOORWAY, inside);
  put("cottage_bed", 0, 2, inside, house);       // its footprint is 2x3: rows 0 to 2
  put("cottage_window", 2, 0, inside, house);
  put("cottage_window", 3, 0, inside, house);
  put("cottage_shelf", 4, 1, inside, house);     // 2 wide; draws over (4, 0) and (5, 0)
  put("cottage_drawers", 6, 1, inside, house);
  put("cottage_plant", 7, 1, inside, house);
  put("cottage_table", 5, 3, inside, house);
  put("cottage_stool", 7, 3, inside, house);
  const lamp = put("cottage_lamp", 2, 1, inside, house);
  if (lamp) set(lamp, "light", new Obj().num("radius", 44).str("color", "#ffcf87").num("strength", 0.8).num("flicker", 1).toString());
}

/** Build the cottage and its room once. Safe to run again: an existing cottage means nothing to do. */
export function migrate(): void {
  if (theHouse()) return;
  // A 3x3 block: the cottage's 3x2 footprint on its top two rows, its doorstep on the third.
  const spotRaw = spaceFind(SPOT_X, SPOT_Y, 3, 3, OUTSIDE);
  if (!spotRaw) return;
  const spot: Pos = spotRaw;
  const house = spawn("cottage", spot.x, spot.y + 1, OUTSIDE, true); // bottom-left of the footprint
  if (!house) return;

  // The room is made once. A cottage that is gone left its room behind: use that.
  let inside = "cottage.inside";
  if (!areaList().includes(inside)) {
    inside = areaCreate("inside", FLOOR, ROOM_W, ROOM_H);
    if (inside == "") { destroy(house); return; }
    furnish(inside, house);
  }
  setStr(house, "inside", inside);
  set(house, "insideDoor", new Pos(DOOR_X, ROOM_H - 1, inside).toString());

  const pRaw = posOf(house);
  if (!pRaw) return;
  const p: Pos = pRaw;
  emit("cottage.built", new Obj().int("house", house).raw("pos", p.toString()).str("inside", inside));
}

/** E on the cottage. It only opens from the doorstep: anywhere else, a hint and nothing more. */
export function perform(verb: string, target: i32, held: i32): void {
  if (verb != "enter") return;
  const meRaw = playerPos();
  if (!meRaw) return;
  const me: Pos = meRaw;
  const stepRaw = doorOf(target);
  if (!stepRaw) return;
  const step: Pos = stepRaw;
  if (!me.equals(step)) {
    floatText("The door is round the front.", me.x, me.y - 1, "", me.area);
    return;
  }
  const inside = getStr(target, "inside");
  if (inside == "") return;
  const doorRaw = Pos.from(get(target, "insideDoor"));
  if (!doorRaw) return;
  const door: Pos = doorRaw;
  // travel is refused unless that exact tile is free, so find one first.
  const arriveRaw = freeNear(new Pos(door.x, door.y - 1, inside));
  if (!arriveRaw) { floatText("Something blocks the doorway.", me.x, me.y - 1, "", me.area); return; }
  const arrive: Pos = arriveRaw;
  if (!travel(inside, arrive.x, arrive.y)) return;
  emit("cottage.entered", new Obj().int("house", target).str("inside", inside));
}

/** Stepping onto a cottage's inside doorway leads out to its doorstep. */
export function onEvent(name: string, payload: string): void {
  if (name != "player.moved") return;
  const toRaw = Pos.from(parse(payload).get("to"));
  if (!toRaw) return;
  const to: Pos = toRaw;
  const houses = query("cottage");
  for (let i = 0; i < houses.length; i++) {
    const house = houses[i];
    if (typeOf(house) != "cottage" || getStr(house, "inside") != to.area) continue;
    const doorRaw = Pos.from(get(house, "insideDoor"));
    if (!doorRaw) continue;
    const door: Pos = doorRaw;
    if (door.x != to.x || door.y != to.y) continue;
    leave(house, to);
    return;
  }
}

/** Out to the doorstep, or the nearest free tile when something was dropped on it. */
function leave(house: i32, from: Pos): void {
  const stepRaw = doorOf(house);
  if (!stepRaw) return;
  const outRaw = freeNear(stepRaw);
  if (!outRaw) { floatText("Something blocks the door outside.", from.x, from.y - 1, "", from.area); return; }
  const out: Pos = outRaw;
  if (!travel(out.area, out.x, out.y)) return;
  emit("cottage.left", new Obj().int("house", house).raw("pos", out.toString()));
}

// ---------------- tests (fresh real map; the player starts at (15, 11) facing down) ----------------

/** Events named `name` that the test's own actions caused (not migrate's). */
function firedInTest(name: string): i32 {
  const evs = simEvents(name);
  let n = 0;
  for (let i = 0; i < evs.length; i++) if (evs.at(i).get("during").str() == "test") n++;
  return n;
}

/** Put the player on the cottage's doorstep, facing the door. False when there is none. */
function standAtTheDoor(house: i32): bool {
  const stepRaw = doorOf(house);
  if (!stepRaw) return false;
  const step: Pos = stepRaw;
  if (!simTeleport(step.x, step.y, step.area)) return false;
  simFace("up");
  return true;
}

export function test_the_cottage_stands_in_the_clearing_with_a_clear_doorstep(): void {
  const house = theHouse();
  check(house != 0, "a cottage stands in the clearing");
  const p = posOf(house);
  check(p != null && p.area == OUTSIDE, "it is on the main map");
  const step = doorOf(house);
  check(step != null && isFree(step.x, step.y, 0, step.area), "its doorstep is free to stand on");
  const size = areaSize(getStr(house, "inside"));
  check(size.w == ROOM_W && size.h == ROOM_H, "its room is an 8x6 area");
  check(simEvents("cottage.built").length == 1, "cottage.built fired once");
}

export function test_go_in_at_the_door_and_walk_out_over_the_doorway(): void {
  const house = theHouse();
  const stepRaw = doorOf(house);
  check(stepRaw != null && standAtTheDoor(house), "the player stands on the doorstep facing the door");
  if (!stepRaw) return;
  const step: Pos = stepRaw;
  simInteract();
  const inside = getStr(house, "inside");
  check(areaCurrent() == inside, "Go inside takes the player into the room");
  const inPos = playerPos();
  check(inPos != null && inPos.x == DOOR_X && inPos.y == ROOM_H - 2, "the player stands just inside the doorway");
  check(firedInTest("cottage.entered") == 1, "cottage.entered fired once");

  simWalk("down");
  check(areaCurrent() == step.area, "stepping onto the doorway leads back outside");
  const outPos = playerPos();
  check(outPos != null && outPos.equals(step), "the player is back on the doorstep");
  check(firedInTest("cottage.left") == 1, "cottage.left fired once");
}

export function test_the_walls_are_not_a_door(): void {
  const house = theHouse();
  const pRaw = posOf(house);
  if (!pRaw) { check(false, "the cottage is on the map"); return; }
  const p: Pos = pRaw;
  // Beside the cottage, facing its wall: left of the bottom-left corner, else right of the bottom-right.
  let side = "right";
  if (!simTeleport(p.x - 1, p.y, p.area)) { side = "left"; simTeleport(p.x + 3, p.y, p.area); }
  simFace(side);
  simInteract();
  check(areaCurrent() == OUTSIDE, "pressing E at a wall doesn't go inside");
  check(firedInTest("cottage.entered") == 0, "cottage.entered didn't fire");
}

export function test_leaving_onto_a_taken_doorstep_steps_out_beside_it(): void {
  const house = theHouse();
  const stepRaw = doorOf(house);
  check(stepRaw != null && standAtTheDoor(house), "the player stands on the doorstep facing the door");
  if (!stepRaw) return;
  const step: Pos = stepRaw;
  simInteract();
  // While the player is inside, something is left on the doorstep.
  check(spawn("stone", step.x, step.y, step.area, true) != 0, "a stone lies on the doorstep");
  simWalk("down");
  check(areaCurrent() == step.area, "the player still gets out");
  const outPos = playerPos();
  check(outPos != null && !outPos.equals(step), "the player steps out beside the stone, not onto it");
  check(firedInTest("cottage.left") == 1, "cottage.left fired once");
}

export function test_the_room_is_furnished_and_the_way_through_is_clear(): void {
  const house = theHouse();
  const inside = getStr(house, "inside");
  const furniture = query("cottage_furniture");
  check(furniture.length == 9, "the room has its nine pieces");
  let allInside = true, lit = false, bed = false;
  for (let i = 0; i < furniture.length; i++) {
    const id = furniture[i];
    const qRaw = posOf(id);
    if (!qRaw) { allInside = false; continue; }
    const q: Pos = qRaw;
    if (q.area != inside) allInside = false;
    if (typeOf(id) == "cottage_lamp" && !get(id, "light").isNull()) lit = true;
    if (typeOf(id) == "cottage_bed") bed = true;
  }
  check(allInside, "every piece stands inside the room");
  check(bed, "there is a bed");
  check(lit, "the lamp glows");
  const door = tileGet(DOOR_X, ROOM_H - 1, inside);
  check(door != null && door.sprite == DOORWAY, "the doorway is marked on the floor");
  check(isFree(DOOR_X, ROOM_H - 1, 0, inside) && isFree(DOOR_X, ROOM_H - 2, 0, inside), "the way in and out is clear");
  // Windows fill the back row; the shelf, drawers and plant block row 1 under the rest of it.
  let lined = true;
  for (let x = 2; x < 4; x++) if (isFree(x, 0, 0, inside)) lined = false;
  for (let x = 4; x < ROOM_W; x++) if (isFree(x, 1, 0, inside)) lined = false;
  check(lined, "the back wall is lined, so nothing can be walked behind");
}

export function test_running_migrate_again_builds_nothing_more(): void {
  const houses = query("cottage").length;
  const furniture = query("cottage_furniture").length;
  const areas = areaList().length;
  migrate();
  check(query("cottage").length == houses, "still one cottage");
  check(query("cottage_furniture").length == furniture, "no extra furniture");
  check(areaList().length == areas, "no extra area");
  check(simEvents("cottage.built").length == 1, "cottage.built didn't fire again");
}
