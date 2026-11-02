// fireside_cat: builds on campfire. When campfire.lit fires, a cat comes to sit just right of
// the fire pit (the host moves it to the nearest free tile if that one is taken), with a little
// "purr". When campfire.out fires for that fire, the cat leaves. It only listens to the events,
// so it keeps working with any system that takes over campfire's events.
import {
  parse, query, spawn, destroy, setNum, getNum, floatText, posOf,
  simTeleport, simGive, simFace, simInteract, simWait, check,
} from "sdk";

export function onEvent(name: string, payload: string): void {
  const fire = parse(payload).get("fire");
  const fireId = fire.get("id").int();
  if (name == "campfire.lit") {
    const p = posOf(fireId);
    if (!p) return;
    const cat = spawn("fireside_cat", p.x + 2, p.y, p.area);
    if (!cat) return;
    setNum(cat, "warmingBy", fireId);
    const c = posOf(cat);
    if (c) floatText("purr", c.x, c.y, "#ffd9a0", c.area);
    return;
  }
  if (name == "campfire.out") {
    const cats = query("warmingBy");
    for (let i = 0; i < cats.length; i++) if (<i32>getNum(cats[i], "warmingBy") == fireId) destroy(cats[i]);
  }
}

// ---------------- tests (fresh real map; the player starts at (15, 11) facing down) ----------------

function dropBranch(x: i32, y: i32, dir: string): void {
  simTeleport(x, y);
  simGive("branch");
  simFace(dir);
  simInteract();
}

/** Three branches in an L, the way campfire's own tests build a fire. */
function buildFire(): void {
  dropBranch(15, 9, "down");
  dropBranch(15, 9, "right");
  dropBranch(16, 11, "up");
}

function firstFire(): i32 { const f = query("campfire"); return f.length ? f[0] : 0; }

export function test_a_lit_fire_brings_a_cat(): void {
  buildFire();
  const fire = firstFire();
  check(fire != 0, "the branches made a fire");
  const cats = query("fireside_cat");
  check(cats.length == 1, "one cat came");
  const f = posOf(fire), c = posOf(cats[0]);
  check(f != null && c != null && abs(c.x - f.x) <= 3 && abs(c.y - f.y) <= 3, "the cat sits beside the fire");
  check(<i32>getNum(cats[0], "warmingBy") == fire, "the cat knows its fire");
}

export function test_the_cat_leaves_when_the_fire_goes_out(): void {
  buildFire();
  const fire = firstFire();
  simWait(<i32>getNum(fire, "burnTicks") + 120);
  check(query("ash").length == 1, "the fire burned out");
  check(query("fireside_cat").length == 0, "the cat left");
}

// ---------------- shots ----------------

export function shot_cat_by_the_fire(): void { buildFire(); }
