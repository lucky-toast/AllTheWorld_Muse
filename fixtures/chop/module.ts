import {
  check, destroy, emit, focus, fxParticles, get, getNum, info, infoPos, infoType,
  isFree, jsonInt, jsonPos, jsonRaw, player, query, releaseFocus, setNum, simFace,
  simGive, simInteract, simKey, simTeleport, simWait, simWalk, spawn, stateGet,
  stateSet, timer,
} from "sdk";

const CHOP_TICKS: i32 = 12;

function findType(type: string, tagName: string): i32 {
  const ids = query(tagName);
  for (let i = 0; i < ids.length; i++) if (infoType(ids[i]) == type) return ids[i];
  return 0;
}

function countType(type: string, tagName: string): i32 {
  const ids = query(tagName);
  let n = 0;
  for (let i = 0; i < ids.length; i++) if (infoType(ids[i]) == type) n++;
  return n;
}

function heldId(): i32 {
  const p = player();
  if (!p) return 0;
  return jsonInt(get(p, "held"), "id");
}

export function migrate(): void {
  if (findType("axe", "item")) return;
  const stump = findType("stump_big", "stump");
  if (!stump) return;
  const pos = infoPos(stump);
  if (!pos) return;
  const dx: i32[] = [2, -1, 0, 2];
  const dy: i32[] = [0, 0, 1, 1];
  for (let i = 0; i < dx.length; i++) {
    const x = pos.x + dx[i];
    const y = pos.y + dy[i];
    if (isFree(x, y)) { spawn("axe", x, y, pos.area); return; }
  }
}

export function perform(verb: string, target: i32, held: i32): void {
  if (verb != "chop" || !target) return;
  const pos = infoPos(target);
  if (!pos) return;
  setNum(held, "chopTicks", CHOP_TICKS);
  stateSet(`{"log":${target},"axe":${held},"cancelled":false}`);
  fxParticles("fx_wood", pos.x, pos.y, 8, pos.area);
  focus("freeze");
  timer(CHOP_TICKS, "chop_done");
}

export function onTimer(name: string): void {
  if (name != "chop_done") return;
  const saved = stateGet();
  if (jsonRaw(saved, "cancelled") == "true") { stateSet("{}"); releaseFocus(); return; }
  const log = jsonInt(saved, "log");
  const pos = log ? infoPos(log) : null;
  if (!log || !pos) { stateSet("{}"); releaseFocus(); return; }
  destroy(log);
  const dx: i32[] = [1, -1, 0, 0, 1, -1, 1, -1];
  const dy: i32[] = [0, 0, 1, -1, 1, 1, -1, -1];
  let made = 0;
  for (let i = 0; i < dx.length && made < 2; i++) {
    const x = pos.x + dx[i];
    const y = pos.y + dy[i];
    if (isFree(x, y, 0, pos.area)) { spawn("branch", x, y, pos.area); made++; }
  }
  emit("chop.chopped", `{"pos":${jsonPos(pos.x, pos.y, pos.area)},"log":${log}}`);
  stateSet("{}");
  releaseFocus();
}

export function onInput(key: string, kind: string): void {
  if (key != "escape") return;
  const saved = stateGet();
  const log = jsonInt(saved, "log");
  stateSet(`{"log":${log},"cancelled":true}`);
  releaseFocus();
}

export function test_chops_log_into_branches(): void {
  const log = findType("log_fallen", "pushable");
  const before = countType("branch", "item");
  simTeleport(12, 9);
  simGive("axe");
  simFace("up");
  simInteract();
  simWait(30);
  check(infoType(log).length == 0, "chopping destroyed the log");
  check(countType("branch", "item") >= before + 2, "chopping spawned two branches");
}

export function test_without_axe_pick_up_is_the_default(): void {
  const log = findType("log_fallen", "pushable");
  simTeleport(12, 9);
  simFace("up");
  simInteract();
  check(heldId() == log, "without an axe the log is picked up instead of chopped");
}

export function test_escape_during_the_chop_leaves_the_log(): void {
  const log = findType("log_fallen", "pushable");
  simTeleport(12, 9);
  simGive("axe");
  simFace("up");
  simInteract();
  simKey("escape", "down");
  simWait(30);
  check(infoType(log) == "log_fallen", "Escape during the chop leaves the log intact");
  simWalk("left");
  const p = infoPos(player());
  check(p != null && p.x == 11, "focus is released after Escape");
}

export function test_with_an_axe_chop_is_the_default(): void {
  const log = findType("log_fallen", "pushable");
  simTeleport(12, 9);
  simGive("axe");
  simFace("up");
  simInteract();
  simWait(30);
  check(infoType(log).length == 0, "with an axe in hand E chops instead of dropping");
  check(getNum(heldId(), "chopTicks") == CHOP_TICKS, "the chop length is stored on the axe");
}

export function shot_mid_chop(): void {
  simTeleport(12, 9);
  simGive("axe");
  simFace("up");
  simInteract();
}
