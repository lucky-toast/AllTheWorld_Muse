// campfire_v2: replaces campfire. The same three branches make the same fire pit and it emits
// the same events, but the fire burns brighter and wider, and longer on each later day
// (half as long again per day, up to three times as long).
// States are tags on the pit: lit, then dying, then ash. Each change emits an event.
// Its saved state counts the fires lit so far: { "lit": n }, carried over from campfire.
// Its migrate takes over the fires campfire left: lit ones keep burning here, a dying one
// turns to ash (campfire's timers and tweens left with it).
import {
  Obj, parse, Pos, at, typeOf, has, tileGet, spawn, destroy, set, setNum, getNum, remove,
  tag, untag, anim, emit, query, tween, get, posOf,
  stateGet, stateSet, stateGetReplaced, time,
  simTimeHour, simTeleport, simGive, simFace, simInteract, simWait, simWalk, simEvents, check, playerPos,
} from "sdk";

const BURN_TICKS = 1800;    // 30 s on day 1, about a third of a night
const BURN_PER_DAY = 900;   // 15 s more for each later day
const BURN_MAX = 5400;      // never more than three times as long
const LIGHT_STRENGTH = 1.0; // campfire's was 0.9
const LIGHT_RADIUS = 70;    // campfire's was 46
const LIGHT_COLOR = "#ff9a3c";
const DIE_TICKS = 60;       // length of the flame's die anim (6 frames at 6 fps)
// The 8x12 flame sits centered on the 32x30 pit, its bottom edge 18 px below the pit's top edge.
const FLAME_SPRITE = '{"id":"fx_fire","z":8,"offset":{"x":12,"y":-12}}';

const DX: i32[] = [1, -1, 0, 0];
const DY: i32[] = [0, 0, 1, -1];

/** The branch lying on (x, y), or 0. */
function branchAt(x: i32, y: i32, area: string): i32 {
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) if (typeOf(ids[i]) == "branch") return ids[i];
  return 0;
}

/** Branches on the four tiles next to (x, y), leaving out `skip`. */
function neighbourBranches(x: i32, y: i32, area: string, skip: i32): i32[] {
  const out = new Array<i32>();
  for (let d = 0; d < 4; d++) {
    const b = branchAt(x + DX[d], y + DY[d], area);
    if (b && b != skip) out.push(b);
  }
  return out;
}

/** Free for the pit: walkable, and nothing blocking but the branches it replaces. */
function freeForPit(x: i32, y: i32, area: string, branches: i32[]): bool {
  const t = tileGet(x, y, area);
  if (!t || !t.tags.includes("walkable") || t.tags.includes("water")) return false;
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (branches.includes(id)) continue;
    if (has(id, "player") || has(id, "solid") || has(id, "pushable") || has(id, "item")) return false;
  }
  return true;
}

export function onEvent(name: string, payload: string): void {
  if (name != "item.dropped") return;
  const item = parse(payload).get("item");
  if (item.get("type").str() != "branch") return;
  const d = Pos.from(item.get("pos"));
  if (!d) return;
  const dropped = item.get("id").int();

  // Three branches in a row or an L: find the middle one (next to both others).
  let middle = dropped;
  let mx = d.x, my = d.y;
  let chain = neighbourBranches(d.x, d.y, d.area, 0);
  if (chain.length == 1) {
    const n = chain[0];
    const np = posOf(n); if (!np) return;
    const more = neighbourBranches(np.x, np.y, d.area, dropped);
    if (!more.length) return;
    middle = n; mx = np.x; my = np.y;
    chain = [dropped, more[0]];
  }
  if (chain.length < 2) return;
  const branches: i32[] = [middle, chain[0], chain[1]];

  // A 2x2 pit covering the middle branch's tile, where all four tiles are free.
  // Prefer the spot that covers the most of the three branches.
  let bestX = 0, bestY = 0, bestScore = -1;
  for (let c = 0; c < 4; c++) {
    const bx = mx - 1 + (c & 1), by = my + (c >> 1); // bottom-left; the pit extends up and right
    let ok = true, score = 0;
    for (let i = 0; i < 2 && ok; i++) for (let j = 0; j < 2 && ok; j++) {
      const x = bx + i, y = by - j;
      if (!freeForPit(x, y, d.area, branches)) ok = false;
      for (let k = 0; k < 3; k++) { const bp = posOf(branches[k]); if (bp && bp.x == x && bp.y == y) score++; }
    }
    if (ok && score > bestScore) { bestScore = score; bestX = bx; bestY = by; }
  }
  if (bestScore < 0) return;

  // The branches go first: the pit takes their tiles (a spawn onto them would be moved aside).
  for (let k = 0; k < 3; k++) destroy(branches[k]);
  const fire = spawn("campfire", bestX, bestY, d.area);
  if (!fire) return;
  light(fire, new Pos(bestX, bestY, d.area));
}

/** How long a fire lit on `day` burns. */
function burnFor(day: i32): i32 { return min(BURN_TICKS + BURN_PER_DAY * max(day - 1, 0), BURN_MAX); }

/** The wide, warm light of a burning fire. */
function fireLight(strength: f64): string {
  return new Obj().num("radius", LIGHT_RADIUS).str("color", LIGHT_COLOR).num("strength", strength).num("flicker", 1).toString();
}

/** Light a new pit: the flame (ignite, then burn), a warm flickering light, and campfire.lit. */
function light(fire: i32, p: Pos): void {
  const burn = burnFor(time().day);
  setNum(fire, "burnTicks", burn);
  setNum(fire, "burnLeft", burn);
  set(fire, "light", fireLight(LIGHT_STRENGTH));
  tag(fire, "lit");
  const flame = spawn("campfire_flame", p.x, p.y, p.area);
  if (flame) {
    set(flame, "sprite", FLAME_SPRITE);
    setNum(flame, "flameOf", fire);
    setNum(fire, "flame", flame);
    anim(flame, "ignite", "burn:" + fire.toString());
  }
  stateSet(new Obj().int("lit", stateGet().get("lit").int() + 1).toString());
  emit("campfire.lit", new Obj().int("fire", fire).raw("pos", p.toString()));
}

export function onTick(): void {
  const lit = query("lit");
  for (let i = 0; i < lit.length; i++) {
    const fire = lit[i];
    if (!has(fire, "campfire")) continue;
    const left = getNum(fire, "burnLeft") - 1;
    if (left > 0) { setNum(fire, "burnLeft", left); continue; }
    // Burned down: the flame dies, the light fades over the same time.
    remove(fire, "burnLeft");
    untag(fire, "lit");
    tag(fire, "dying");
    const flame = <i32>getNum(fire, "flame");
    if (flame) anim(flame, "die", "out:" + fire.toString());
    const strength = get(fire, "light").get("strength").num(LIGHT_STRENGTH);
    setNum(fire, "fadeTween", tween(strength, 0, DIE_TICKS));
    emit("campfire.dying", new Obj().int("fire", fire));
  }
}

export function onTween(id: i32, value: f64): void {
  const dying = query("dying");
  for (let i = 0; i < dying.length; i++) {
    const fire = dying[i];
    if (<i32>getNum(fire, "fadeTween") != id) continue;
    const l = get(fire, "light");
    if (l.isNull()) continue;
    set(fire, "light", new Obj().num("radius", l.get("radius").num(LIGHT_RADIUS)).str("color", l.get("color").str(LIGHT_COLOR)).num("strength", value).num("flicker", 1).toString());
  }
}

export function onTimer(name: string): void {
  if (name.startsWith("burn:")) {
    const fire = I32.parseInt(name.substr(5));
    const flame = <i32>getNum(fire, "flame");
    if (flame && has(fire, "lit")) anim(flame, "burn");
    return;
  }
  if (name.startsWith("out:")) {
    const fire = I32.parseInt(name.substr(4));
    if (has(fire, "dying")) toAsh(fire);
  }
}

/** A dying fire's flame is gone: the pit becomes a ring of ash and campfire.out fires. */
function toAsh(fire: i32): void {
  const flame = <i32>getNum(fire, "flame");
  if (flame) destroy(flame);
  set(fire, "sprite", '{"id":"firepit_ash"}');
  untag(fire, "dying");
  untag(fire, "solid");
  tag(fire, "ash");
  remove(fire, "light");
  remove(fire, "flame");
  remove(fire, "fadeTween");
  const p = posOf(fire);
  emit("campfire.out", new Obj().int("fire", fire).raw("pos", p ? p.toString() : new Pos(0, 0).toString()));
}

/**
 * Take over from campfire. Its saved count of fires lit is readable here only, once. Fires it
 * left keep going: a lit one goes on burning under this system (its flame on the burn loop, the
 * new wider light), and a dying one turns to ash, since campfire's die timer left with it.
 * Safe to run again: the count is carried over only while this system has no state of its own.
 */
export function migrate(): void {
  if (stateGet().isNull()) {
    const old = stateGetReplaced("campfire");
    stateSet(new Obj().int("lit", old.get("lit").int()).toString());
  }
  const fires = query("campfire");
  for (let i = 0; i < fires.length; i++) {
    const fire = fires[i];
    if (has(fire, "lit")) {
      const flame = <i32>getNum(fire, "flame");
      if (flame) anim(flame, "burn");
      set(fire, "light", fireLight(LIGHT_STRENGTH));
    } else if (has(fire, "dying")) toAsh(fire);
  }
}

// ---------------- tests (fresh real map; the player starts at (15, 11) facing down) ----------------

/** Stand on (x, y), take a branch and drop it on the tile in direction `dir`. */
function dropBranch(x: i32, y: i32, dir: string): void {
  simTeleport(x, y);
  simGive("branch");
  simFace(dir);
  simInteract();
}

/** Drop three branches in an L at (15, 10), (16, 9) and (16, 10), like a player would. */
function buildFire(): void {
  dropBranch(15, 9, "down");
  dropBranch(15, 9, "right");
  dropBranch(16, 11, "up");
}

function firstFire(): i32 { const f = query("campfire"); return f.length ? f[0] : 0; }

export function test_three_branches_make_a_fire_two_dont(): void {
  dropBranch(15, 9, "down");
  dropBranch(15, 9, "right");
  check(query("campfire").length == 0, "two branches don't make a fire");
  dropBranch(16, 11, "up");
  const fire = firstFire();
  check(fire != 0, "the third branch makes a campfire");
  const p = posOf(fire);
  check(p != null && p.x == 15 && p.y == 10, "the pit covers the three branches");
  check(has(fire, "lit") && has(fire, "solid"), "the new fire is lit and solid");
  check(query("campfire_flame").length == 1, "the fire has one flame");
  check(at(16, 10).every((id: i32): bool => typeOf(id) != "branch"), "the branches are used up");
  check(simEvents("campfire.lit").length == 1, "campfire.lit fired once");
}

export function test_the_fire_has_a_wide_light(): void {
  buildFire();
  const light = get(firstFire(), "light");
  check(!light.isNull(), "the campfire has a light");
  check(light.get("radius").num() == LIGHT_RADIUS, "the light is the wide one");
  check(light.get("flicker").num() > 0, "the light flickers");
}

export function test_it_burns_longer_on_a_later_day(): void {
  simTimeHour(4.95); // just before dawn, so the day goes up
  simWait(30);
  check(time().day == 2, "it is day 2");
  buildFire();
  check(getNum(firstFire(), "burnTicks") == BURN_TICKS + BURN_PER_DAY, "a day 2 fire burns half as long again");
}

export function test_migrate_keeps_the_count_and_is_safe_to_run_again(): void {
  buildFire();
  check(stateGet().get("lit").int() == 1, "the count of fires lit went up");
  migrate();
  check(stateGet().get("lit").int() == 1, "running migrate again keeps the count");
  check(has(firstFire(), "lit"), "the fire still burns");
}

export function test_it_burns_out_to_ash(): void {
  buildFire();
  const fire = firstFire();
  simWait(<i32>getNum(fire, "burnTicks") + DIE_TICKS + 30);
  check(get(fire, "sprite").get("id").str() == "firepit_ash", "the pit became ash");
  check(has(fire, "ash") && !has(fire, "lit") && !has(fire, "dying"), "the fire is tagged ash");
  check(!has(fire, "solid"), "the ash isn't solid");
  check(get(fire, "light").isNull(), "the light is gone");
  check(query("campfire_flame").length == 0, "the flame is gone");
  check(simEvents("campfire.dying").length == 1, "campfire.dying fired");
  check(simEvents("campfire.out").length == 1, "campfire.out fired");
}

export function test_the_player_cant_walk_through_a_lit_fire(): void {
  buildFire();
  simTeleport(15, 11);
  simFace("up");
  simWalk("up");
  const p = playerPos();
  check(p != null && p.x == 15 && p.y == 11, "the lit fire blocks the player");
}

// ---------------- shots ----------------

export function shot_lit_at_night(): void { buildFire(); }

export function shot_ash_ring(): void {
  buildFire();
  simWait(<i32>getNum(firstFire(), "burnTicks") + DIE_TICKS + 30);
}
