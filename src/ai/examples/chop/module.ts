// chop: hold the axe, face a fallen log and press E. The player freezes for a short chop
// (the axe's chopTicks), wood chips fly, then the log becomes two branches. A log being
// chopped carries the tag "chopping"; Escape stops the chop and leaves the log whole.
import {
  Obj, query, info, typeOf, at, spawn, destroy, setNum, getNum, tag, untag, has,
  focus, release, timer, particles, emit, posOf, isFree, held,
  simTeleport, simGive, simFace, simInteract, simCycle, simKey, simWait, simWalk, simEvents, check, playerPos,
} from "sdk";

const CHOP_TICKS = 40;  // used when an axe has no chopTicks of its own

export function migrate(): void {
  if (query("axe").length) return; // safe to run again: one axe is enough
  const stumps = query("stump");
  for (let s = 0; s < stumps.length; s++) {
    if (typeOf(stumps[s]) != "stump_big") continue;
    const p = posOf(stumps[s]); if (!p) continue;
    // Beside the stump: right of it, left of it, then below and above.
    const xs: i32[] = [p.x + 2, p.x - 1, p.x, p.x + 1, p.x, p.x + 1];
    const ys: i32[] = [p.y, p.y, p.y + 1, p.y + 1, p.y - 1, p.y - 1];
    for (let i = 0; i < xs.length; i++) {
      if (!isFree(xs[i], ys[i], 0, p.area)) continue;
      const axe = spawn("axe", xs[i], ys[i], p.area);
      if (axe) { setNum(axe, "chopTicks", CHOP_TICKS); return; }
    }
  }
}

export function perform(verb: string, target: i32, heldItem: i32): void {
  if (verb != "chop") return;
  const p = posOf(target); if (!p) return;
  if (!focus("freeze")) return;
  tag(target, "chopping");
  particles("fx_wood", p.x, p.y, 8, p.area);
  timer(<i32>getNum(heldItem, "chopTicks", CHOP_TICKS), "chop:" + target.toString());
}

export function onTimer(name: string): void {
  if (!name.startsWith("chop:")) return;
  const log = I32.parseInt(name.substr(5));
  const i = info(log);
  if (!i) { release(); return; }             // the log is gone: nothing to chop
  if (!i.tags.includes("chopping")) return;  // Escape stopped this chop
  const p = i.pos; if (!p) { release(); return; }
  destroy(log);
  // Two branches on free tiles around where the log lay.
  let made = 0;
  for (let r = 1; r <= 2 && made < 2; r++)
    for (let dy = -r - 1; dy <= r && made < 2; dy++)
      for (let dx = -r; dx <= r && made < 2; dx++) {
        const x = p.x + dx, y = p.y + dy;
        if (!isFree(x, y, 0, p.area)) continue;
        if (spawn("branch", x, y, p.area)) made++;
      }
  particles("fx_wood", p.x, p.y, 12, p.area);
  emit("chop.chopped", new Obj().raw("pos", p.toString()).int("log", log));
  release();
}

export function onInput(key: string, kind: string): void {
  if (key != "escape") return;
  const logs = query("chopping");
  for (let i = 0; i < logs.length; i++) untag(logs[i], "chopping");
}

// ---------------- tests (fresh real map; a fallen log lies at (12, 8) covering (12, 7)) ----------------

function theLog(): i32 {
  const ids = at(12, 8);
  for (let i = 0; i < ids.length; i++) if (typeOf(ids[i]) == "log_fallen") return ids[i];
  return 0;
}

/** How many branches lie on the map (branch is a type, not a tag, so count items by type). */
function branchCount(): i32 {
  const items = query("item"); let n = 0;
  for (let i = 0; i < items.length; i++) if (typeOf(items[i]) == "branch") n++;
  return n;
}

/** Stand below the log, facing it. */
function faceLog(): void { simTeleport(12, 9); simFace("up"); }

function lastVerb(): string {
  const ev = simEvents("interaction.performed");
  return ev.at(ev.length - 1).get("payload").get("verb").str();
}

export function test_migrate_places_one_axe_by_the_stump(): void {
  const axes = query("axe");
  check(axes.length == 1, "there is one axe");
  const p = posOf(axes.length ? axes[0] : 0);
  check(p != null && p.x == 9 && p.y == 7, "the axe lies beside the stump");
  check(getNum(axes[0], "chopTicks") > 0, "the axe knows how long a chop takes");
  migrate();
  check(query("axe").length == 1, "running migrate again adds no second axe");
}

export function test_chopping_turns_a_log_into_branches(): void {
  const log = theLog();
  const before = branchCount();
  simGive("axe");
  faceLog();
  simInteract();
  check(has(log, "chopping"), "the log is being chopped");
  simWait(CHOP_TICKS + 5);
  check(info(log) == null, "the log is gone");
  check(branchCount() == before + 2, "two branches appeared");
  check(simEvents("chop.chopped").length == 1, "chop.chopped fired");
  simWalk("down");
  const p = playerPos();
  check(p != null && p.y == 10, "the controls are back after the chop");
}

export function test_without_the_axe_chop_isnt_offered(): void {
  const log = theLog();
  faceLog();
  simInteract();
  check(held() == log, "with empty hands E picks the log up");
  check(lastVerb() == "pick_up", "the default action was Pick up");
  check(simEvents("chop.chopped").length == 0, "nothing was chopped");
}

export function test_escape_during_the_chop_keeps_the_log(): void {
  const log = theLog();
  simGive("axe");
  faceLog();
  simInteract();
  simKey("escape", "down");
  simKey("escape", "up");
  simWait(CHOP_TICKS + 5);
  check(info(log) != null, "the log is still there");
  check(!has(log, "chopping"), "the log isn't being chopped");
  check(simEvents("chop.chopped").length == 0, "nothing was chopped");
  simWalk("down");
  const p = playerPos();
  check(p != null && p.y == 10, "focus was released");
}

export function test_with_the_axe_chop_is_default_and_drop_is_on_q(): void {
  const log = theLog();
  const axe = simGive("axe");
  faceLog();
  simCycle();
  simInteract();
  check(lastVerb() == "drop", "Q then E runs Drop");
  check(held() == axe, "the axe stays in hand (no room on the log's tile)");
  simFace("left");
  simFace("up");
  simCycle();
  simCycle();
  simInteract();
  check(lastVerb() == "chop", "two presses of Q wrap back to Chop: Pick up isn't offered");
  check(has(log, "chopping"), "the chop started");
}

// ---------------- shots ----------------

export function shot_mid_chop(): void {
  simGive("axe");
  faceLog();
  simInteract();
}
