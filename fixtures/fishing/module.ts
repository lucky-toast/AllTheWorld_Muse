// fishing: a mini-game that takes over the controls. With the rod in hand, face the stream
// and press E: focus("borrow") sends the arrows, E and Q to onInput instead of moving the
// player. A fish swims back and forth along the line; Left/Right steer the hook under it
// and E strikes. Escape always stops (the engine ends the focus, then sends "escape").
//
// The round lives in the saved state, not in module globals: the module can be re-created
// at any time (a reload, a check), and a round in globals would be lost while the controls
// stay taken. The numbers a later system might tune are components on the rod.
//
// Keys arrive as (key, kind): kind is "down", "up", or "repeat" while a key is held. The E
// that cast the line is still held when the round starts, so its "up" arrives here too:
// act on "down" (and "repeat" for steering), never on "up".
import {
  Obj, Arr, Pos, Tile, query, typeOf, posOf, getNum, setNum, spawn, tileGet, tileFind, spaceFind,
  isFree, facedTile, playerPos, rand, stateGet, stateSet, focus, release, overlay, overlayClear,
  floatText, particles, emit,
  simTeleport, simFace, simGive, simInteract, simKey, simWait, simWalk, simEvents, check,
} from "sdk";

const OUTSIDE = "clearing";
const TRACK = 15;               // cells along the line on the panel
const STEP_TICKS = 12;          // defaults for the rod's components
const ROUND_TICKS = 900;        // 15 s
const CATCH_REACH = 1;

/** A round in play, as kept in the saved state ({ caught, round }). */
class Round {
  rod: i32 = 0;
  spot: Pos = new Pos(0, 0);    // the water tile the line went into
  hook: i32 = 0;
  fish: i32 = 0;
  dir: i32 = 1;                 // the way the fish swims: -1 or 1
  left: i32 = 0;                // ticks before it swims off
  total: i32 = 0;
  next: i32 = 0;                // ticks until the fish's next step
}

function caughtSoFar(): i32 { return stateGet().get("caught").int(); }

/** The round in play, or null. */
function readRound(): Round | null {
  const j = stateGet().get("round");
  if (j.isNull()) return null;
  const spotRaw = Pos.from(j.get("spot"));
  if (!spotRaw) return null;
  const spot: Pos = spotRaw;
  const r = new Round();
  r.rod = j.get("rod").int();
  r.spot = spot;
  r.hook = j.get("hook").int();
  r.fish = j.get("fish").int();
  r.dir = j.get("dir").int(1);
  r.left = j.get("left").int();
  r.total = j.get("total").int(1);
  r.next = j.get("next").int();
  return r;
}

function saveRound(r: Round): void {
  const round = new Obj().int("rod", r.rod).raw("spot", r.spot.toString()).int("hook", r.hook).int("fish", r.fish)
    .int("dir", r.dir).int("left", r.left).int("total", r.total).int("next", r.next);
  stateSet(new Obj().int("caught", caughtSoFar()).raw("round", round.toString()).toString());
}

/** The panel: the water with the fish on it, the hook under it, the keys, and the time left. */
function draw(r: Round): void {
  let water = "", hook = "";
  for (let i = 0; i < TRACK; i++) {
    water += i == r.fish ? (r.dir > 0 ? ">" : "<") : "~";
    hook += i == r.hook ? "^" : " ";
  }
  const lines = new Arr().str(water).str(hook).str("Left/Right: hook   E: strike   Esc: stop");
  const bar = new Obj().num("value", <f64>r.left / <f64>r.total).str("label", "time");
  overlay(new Obj().str("title", "Fishing").raw("lines", lines.toString()).raw("bar", bar.toString()));
}

/**
 * End the round: clear it from the state, hide the panel, give the controls back. After
 * Escape (or a timeout) the engine already took them back, so `released` skips release().
 */
function endRound(released: bool): void {
  stateSet(new Obj().int("caught", caughtSoFar()).nul("round").toString());
  overlayClear();
  if (!released) release();
}

/** The rod by the stream, once. Safe to run again. */
export function migrate(): void {
  const rods = query("fishing_rod");
  for (let i = 0; i < rods.length; i++) if (typeOf(rods[i]) == "fishing_rod") return;
  const water = tileFind("water", OUTSIDE);
  if (!water.length) return;
  // On the bank: the free tile nearest to just above the stream, a little way along it.
  const spotRaw = spaceFind(water[0].x + 2, water[0].y - 1, 1, 1, OUTSIDE);
  if (!spotRaw) return;
  const spot: Pos = spotRaw;
  const rod = spawn("fishing_rod", spot.x, spot.y, OUTSIDE, true);
  if (!rod) return;
  setNum(rod, "fishStepTicks", STEP_TICKS);
  setNum(rod, "roundTicks", ROUND_TICKS);
  setNum(rod, "catchReach", CATCH_REACH);
}

/** E facing water with the rod in hand: take the controls and start a round. */
export function perform(verb: string, target: i32, held: i32): void {
  if (verb != "cast") return;
  if (readRound() != null) return;
  const meRaw = playerPos();
  if (!meRaw) return;
  const me: Pos = meRaw;
  const spot = facedTile();
  const tileRaw = tileGet(spot.x, spot.y, spot.area);
  if (!tileRaw) return;
  const tile: Tile = tileRaw;
  if (!tile.tags.includes("water")) return;
  // Taken inside perform, so there is no cooldown. Denied if another system holds the controls.
  if (!focus("borrow")) { floatText("Not now.", me.x, me.y - 1, "", me.area); return; }

  const r = new Round();
  r.rod = held;
  r.spot = spot;
  r.total = <i32>getNum(held, "roundTicks", ROUND_TICKS);
  r.left = r.total;
  r.fish = <i32>(rand() * <f64>TRACK);
  r.dir = rand() < 0.5 ? -1 : 1;
  r.hook = TRACK / 2;
  r.next = <i32>getNum(held, "fishStepTicks", STEP_TICKS);
  saveRound(r);
  draw(r);
  particles("fx_rain_splash", spot.x, spot.y, 4, spot.area);
  emit("fishing.cast", new Obj().int("rod", held).raw("pos", spot.toString()));
}

/** Each tick of a round: the fish swims a step now and then; when time runs out it's gone. */
export function onTick(): void {
  const rRaw = readRound();
  if (!rRaw) return;
  const r: Round = rRaw;
  r.left--;
  if (r.left <= 0) {
    endRound(false);
    floatText("The fish swam off.", r.spot.x, r.spot.y, "", r.spot.area);
    emit("fishing.escaped", new Obj().raw("pos", r.spot.toString()).str("reason", "time"));
    return;
  }
  r.next--;
  if (r.next <= 0) {
    r.next = <i32>getNum(r.rod, "fishStepTicks", STEP_TICKS);
    if (rand() < 0.2) r.dir = -r.dir;                                // now and then it turns
    if (r.fish + r.dir < 0 || r.fish + r.dir >= TRACK) r.dir = -r.dir; // and always at the ends
    r.fish += r.dir;
  }
  saveRound(r);
  draw(r);
}

/** The keys, while the round holds the controls. */
export function onInput(key: string, kind: string): void {
  const rRaw = readRound();
  if (!rRaw) return;
  const r: Round = rRaw;
  if (key == "escape") {
    endRound(true);
    emit("fishing.escaped", new Obj().raw("pos", r.spot.toString()).str("reason", "stopped"));
    return;
  }
  if (kind == "up") return;
  if (key == "left" || key == "right") {
    const h = r.hook + (key == "left" ? -1 : 1);
    if (h < 0 || h >= TRACK) return;
    r.hook = h;
    saveRound(r);
    draw(r);
    return;
  }
  if (key == "e" && kind == "down") strike(r);
}

/** E: land the fish when the hook is close enough under it, else it's gone. Either way the round ends. */
function strike(r: Round): void {
  const off = r.hook > r.fish ? r.hook - r.fish : r.fish - r.hook;
  endRound(false);
  if (off > <i32>getNum(r.rod, "catchReach", CATCH_REACH)) {
    floatText("It got away!", r.spot.x, r.spot.y, "", r.spot.area);
    emit("fishing.missed", new Obj().raw("pos", r.spot.toString()));
    return;
  }
  const meRaw = playerPos();
  if (!meRaw) return;
  const me: Pos = meRaw;
  // Nothing that is an item can land on the player's tile, so this lands beside the player.
  const fish = spawn("river_fish", me.x, me.y, me.area);
  if (!fish) return;
  const atRaw = posOf(fish);
  if (!atRaw) return;
  const at: Pos = atRaw;
  const caught = caughtSoFar() + 1;
  stateSet(new Obj().int("caught", caught).nul("round").toString());
  particles("fx_rain_splash", r.spot.x, r.spot.y, 8, r.spot.area);
  floatText("A fish!", at.x, at.y, "#9fd8ff", at.area);
  emit("fishing.caught", new Obj().int("fish", fish).raw("pos", at.toString()).num("caught", caught));
}

// ---------------- tests (fresh real map; the player starts at (15, 11) facing down) ----------------

const STILL = 1000000; // fishStepTicks that keep the fish where it is for a whole test

function firedInTest(name: string): i32 {
  const evs = simEvents(name);
  let n = 0;
  for (let i = 0; i < evs.length; i++) if (evs.at(i).get("during").str() == "test") n++;
  return n;
}

/** Stand on the bank above the stream, facing the water. False when there's no free spot. */
function standOnTheBank(): bool {
  const water = tileFind("water", OUTSIDE);
  for (let i = 0; i < water.length; i++) {
    const w = water[i];
    if (isFree(w.x, w.y - 1, 0, OUTSIDE) && simTeleport(w.x, w.y - 1, OUTSIDE)) { simFace("down"); return true; }
  }
  return false;
}

/** Take a rod, tune it (0 keeps a default), and cast. Returns the rod. */
function cast(fishStepTicks: i32, roundTicks: i32): i32 {
  const rod = simGive("fishing_rod");
  if (fishStepTicks > 0) setNum(rod, "fishStepTicks", fishStepTicks);
  if (roundTicks > 0) setNum(rod, "roundTicks", roundTicks);
  simInteract();
  return rod;
}

function inRound(): bool { return !stateGet().get("round").isNull(); }
function hookNow(): i32 { return stateGet().get("round").get("hook").int(); }
function fishNow(): i32 { return stateGet().get("round").get("fish").int(); }

/** Tap Left or Right until the hook is on `cell`. */
function steerTo(cell: i32): void {
  for (let n = 0; n < TRACK && hookNow() != cell; n++) {
    const key = hookNow() < cell ? "right" : "left";
    simKey(key, "down");
    simKey(key, "up");
  }
}

const WALK_DIRS: string[] = ["up", "left", "right"];

/** The player can walk again: a step one way or another changes where they stand. A caught fish
 *  may lie on one side, and the stream is below, so try a few ways. */
function canWalk(): bool {
  for (let i = 0; i < WALK_DIRS.length; i++) {
    const a = playerPos();
    simWalk(WALK_DIRS[i]);
    const b = playerPos();
    if (a != null && b != null && !a.equals(b)) return true;
  }
  return false;
}

export function test_a_tuned_rod_lies_on_the_bank(): void {
  const rods = query("fishing_rod");
  check(rods.length == 1 && typeOf(rods[0]) == "fishing_rod", "one fishing rod lies in the clearing");
  if (!rods.length) return;
  const p = posOf(rods[0]);
  check(p != null && p.area == OUTSIDE, "it is on the main map");
  check(getNum(rods[0], "fishStepTicks") > 0 && getNum(rods[0], "roundTicks") > 0, "its numbers are on it, for later systems to tune");
}

export function test_casting_takes_the_controls_until_escape(): void {
  check(standOnTheBank(), "the player stands on the bank facing the stream");
  const before = playerPos();
  cast(STILL, 0);
  check(inRound(), "casting starts a round");
  check(firedInTest("fishing.cast") == 1, "fishing.cast fired once");
  const hook = hookNow();
  simKey("left", "down");
  simKey("left", "up");
  const after = playerPos();
  check(before != null && after != null && before.equals(after), "the arrows steer the hook, not the player");
  check(hookNow() == hook - 1, "Left moves the hook one step");
  simKey("escape", "down");
  simKey("escape", "up");
  check(!inRound(), "Escape ends the round");
  check(firedInTest("fishing.escaped") == 1, "fishing.escaped fired");
  check(canWalk(), "the controls are back");
}

export function test_a_strike_under_the_fish_lands_it(): void {
  check(standOnTheBank(), "the player stands on the bank facing the stream");
  cast(STILL, 0);
  steerTo(fishNow());
  check(hookNow() == fishNow(), "the hook is under the fish");
  simInteract();
  check(!inRound(), "the strike ends the round");
  check(firedInTest("fishing.caught") == 1, "fishing.caught fired");
  const fish = query("fish");
  check(fish.length == 1 && typeOf(fish[0]) == "river_fish", "a fish lies on the bank");
  const me = playerPos();
  const at = fish.length ? posOf(fish[0]) : null;
  check(me != null && at != null && !me.equals(at), "it landed beside the player, not on them");
  check(stateGet().get("caught").int() == 1, "the catch is counted");
  check(canWalk(), "the controls are back");
}

export function test_a_strike_away_from_the_fish_loses_it(): void {
  check(standOnTheBank(), "the player stands on the bank facing the stream");
  cast(STILL, 0);
  const fish = fishNow();
  steerTo(fish < TRACK / 2 ? fish + 3 : fish - 3);
  simInteract();
  check(!inRound(), "the strike ends the round");
  check(firedInTest("fishing.missed") == 1, "fishing.missed fired");
  check(query("fish").length == 0, "no fish was caught");
  check(stateGet().get("caught").int() == 0, "nothing is counted");
  check(canWalk(), "the controls are back");
}

export function test_the_fish_swims_off_when_time_runs_out(): void {
  check(standOnTheBank(), "the player stands on the bank facing the stream");
  cast(0, 30);
  check(inRound(), "casting starts a round");
  simWait(40);
  check(!inRound(), "the round ends on its own");
  check(firedInTest("fishing.escaped") == 1, "fishing.escaped fired");
  check(canWalk(), "the controls are back");
}

export function test_no_rod_no_fishing(): void {
  check(standOnTheBank(), "the player stands on the bank facing the stream");
  simInteract();
  check(!inRound(), "with empty hands, E at the water starts nothing");
  check(firedInTest("fishing.cast") == 0, "fishing.cast didn't fire");
}
