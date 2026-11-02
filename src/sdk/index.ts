// All the World SDK: every helper a system may use. Import only from "sdk".
// Requests return plain values; a denied request returns false, -1, 0 or "" and sets lastErrorCode()/lastErrorMsg().

/** A tile position in an area. */
export class TilePos {
  constructor(public x: i32 = 0, public y: i32 = 0, public area: string = "") {}
}

/** Escape a string for use inside JSON. */
export function jsonEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) out += '\\"';
    else if (c == 92) out += "\\\\";
    else if (c == 10) out += "\\n";
    else if (c == 13) out += "\\r";
    else if (c == 9) out += "\\t";
    else if (c < 32) out += " ";
    else out += s.charAt(i);
  }
  return out;
}

/** Quote a string as a JSON string. */
export function jsonQuote(s: string): string { return "\"" + jsonEscape(s) + "\""; }

/** Build a JSON pos value from tile coordinates. */
export function jsonPos(x: i32, y: i32, area: string = ""): string {
  return area.length ? `{"x":${x},"y":${y},"area":${jsonQuote(area)}}` : `{"x":${x},"y":${y}}`;
}

/** Decode a raw JSON string value (with quotes) to a plain string. */
export function jsonUnquote(raw: string): string {
  if (raw.length < 2 || raw.charCodeAt(0) != 34) return "";
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw.charCodeAt(i);
    if (c == 92 && i + 1 < raw.length - 1) {
      const n = raw.charCodeAt(++i);
      if (n == 110) out += "\n";
      else if (n == 116) out += "\t";
      else if (n == 114) out += "\r";
      else if (n == 117 && i + 4 < raw.length) { out += String.fromCharCode(I32.parseInt(raw.substring(i + 1, i + 5), 16)); i += 4; }
      else out += raw.charAt(i);
    } else out += raw.charAt(i);
  }
  return out;
}

/** Raw JSON text of one top-level field of a JSON object, or "" when absent. */
export function jsonRaw(json: string, key: string): string {
  const needle = "\"" + key + "\"";
  let from = 0;
  while (true) {
    const at = json.indexOf(needle, from);
    if (at < 0) return "";
    let i = at + needle.length;
    while (i < json.length && (json.charAt(i) == " " || json.charAt(i) == "\t")) i++;
    if (i >= json.length || json.charAt(i) != ":") { from = at + needle.length; continue; }
    i++;
    while (i < json.length && json.charAt(i) == " ") i++;
    let depth = 0; let inStr = false; let esc = false; let j = i;
    for (; j < json.length; j++) {
      const c = json.charCodeAt(j);
      if (inStr) { if (esc) esc = false; else if (c == 92) esc = true; else if (c == 34) inStr = false; }
      else if (c == 34) inStr = true;
      else if (c == 123 || c == 91) depth++;
      else if (c == 125 || c == 93) { if (depth == 0) break; depth--; }
      else if (c == 44 && depth == 0) break;
    }
    return json.substring(i, j).trim();
  }
}

/** True when a JSON object has a top-level field. */
export function jsonHas(json: string, key: string): bool { return jsonRaw(json, key).length > 0; }

/** String field of a JSON object, or "" when absent. */
export function jsonStr(json: string, key: string): string { return jsonUnquote(jsonRaw(json, key)); }

/** Integer field of a JSON object, or 0 when absent. */
export function jsonInt(json: string, key: string): i32 { const r = jsonRaw(json, key); return r.length ? I32.parseInt(r) : 0; }

/** Number field of a JSON object, or 0 when absent. */
export function jsonNum(json: string, key: string): f64 { const r = jsonRaw(json, key); return r.length ? parseFloat(r) : 0; }

/** Boolean field of a JSON object, or false when absent. */
export function jsonBool(json: string, key: string): bool { return jsonRaw(json, key) == "true"; }

/** Every integer in a raw JSON number array. */
export function jsonIds(raw: string): Array<i32> {
  const out = new Array<i32>();
  let cur = ""; let neg = false;
  for (let i = 0; i <= raw.length; i++) {
    const c = i < raw.length ? raw.charCodeAt(i) : 44;
    if (c == 45 && cur.length == 0) neg = true;
    else if (c >= 48 && c <= 57) cur += raw.charAt(i);
    else if (cur.length) { out.push((neg ? -1 : 1) * I32.parseInt(cur)); cur = ""; neg = false; }
    else neg = false;
  }
  return out;
}

/** Every string in a raw JSON string array. */
export function jsonStrList(raw: string): Array<string> {
  const out = new Array<string>();
  let inStr = false; let esc = false; let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!inStr) { if (c == 34) { inStr = true; cur = ""; } }
    else if (esc) { cur += raw.charAt(i); esc = false; }
    else if (c == 92) esc = true;
    else if (c == 34) { out.push(cur); inStr = false; }
    else cur += raw.charAt(i);
  }
  return out;
}

/** Host error code of the last denied request ("denied", "missing", "limit", "bad_request", "phase"). */
export function lastErrorCode(): string { return __lastCode; }

/** Readable host reason for the last denied request. */
export function lastErrorMsg(): string { return __lastMsg; }

/** Ids of entities that have a tag or component, truncated at the query cap. */
export function query(name: string): Array<i32> { const r = __result(`{"op":"query","with":${jsonQuote(name)}}`); return r.length ? jsonIds(jsonRaw(r, "ids")) : new Array<i32>(); }

/** Ids whose footprint covers a tile. */
export function at(x: i32, y: i32, area: string = ""): Array<i32> { const r = __result(`{"op":"at","x":${x},"y":${y}${__areaField(area)}}`); return r.length ? jsonIds(r) : new Array<i32>(); }

/** Raw JSON { type, pos, tags } of an entity, or "null". */
export function info(id: i32): string { return __result(`{"op":"info","id":${id}}`); }

/** Type name of an entity, or "" when it is gone. */
export function infoType(id: i32): string { return jsonStr(info(id), "type"); }

/** Position of an entity, or null when it is lifted or gone. */
export function infoPos(id: i32): TilePos | null { const p = jsonRaw(info(id), "pos"); if (p.length == 0 || p == "null") return null; return new TilePos(jsonInt(p, "x"), jsonInt(p, "y"), jsonStr(p, "area")); }

/** Raw JSON value of one component, or "null" when absent. */
export function get(id: i32, comp: string): string { return __result(`{"op":"get","id":${id},"comp":${jsonQuote(comp)}}`); }

/** Number component of an entity, or 0 when absent. */
export function getNum(id: i32, comp: string): f64 { const r = get(id, comp); return r.length && r != "null" ? parseFloat(r) : 0; }

/** String component of an entity, or "" when absent. */
export function getStr(id: i32, comp: string): string { return jsonUnquote(get(id, comp)); }

/** Boolean component of an entity, or false when absent. */
export function getBool(id: i32, comp: string): bool { return get(id, comp) == "true"; }

/** Raw JSON { sprite, tags } of a tile, or "null" outside the map. */
export function tileGet(x: i32, y: i32, area: string = ""): string { return __result(`{"op":"tile.get","x":${x},"y":${y}${__areaField(area)}}`); }

/** Positions of every tile whose terrain has a tag. */
export function tileFind(tag: string): Array<TilePos> { return __posList(__result(`{"op":"tile.find","tag":${jsonQuote(tag)}}`)); }

/** Raw JSON catalog entry of a sprite, or "null". */
export function catalogGet(id: string): string { return __result(`{"op":"catalog.get","id":${jsonQuote(id)}}`); }

/** Sprite ids in the catalog that carry a tag. */
export function catalogFind(tag: string): Array<string> { const r = __result(`{"op":"catalog.find","tag":${jsonQuote(tag)}}`); return r.length ? jsonStrList(r) : new Array<string>(); }

/** Raw JSON { day, hour, phase } of the clock. */
export function time(): string { return __result(`{"op":"time"}`); }

/** Current day number. */
export function timeDay(): i32 { return jsonInt(time(), "day"); }

/** Current hour, fractional, from 0 to 24. */
export function timeHour(): f64 { return jsonNum(time(), "hour"); }

/** Current phase name: dawn, day, dusk or night. */
export function timePhase(): string { return jsonStr(time(), "phase"); }

/** Next number in this system's own random stream, from 0 to 1. */
export function rand(): f64 { const r = __result(`{"op":"rand"}`); return r.length ? parseFloat(r) : 0; }

/** This system's saved state as raw JSON, or "null". */
export function stateGet(): string { return __result(`{"op":"state.get"}`); }

/** Saved state of a system this one replaces; only works inside migrate. */
export function stateGetReplaced(id: string): string { return __result(`{"op":"state.getReplaced","id":${jsonQuote(id)}}`); }

/** Spawn an entity of a registered type on a tile; returns its id or -1. */
export function spawn(type: string, x: i32, y: i32, area: string = ""): i32 { const r = __result(`{"op":"spawn","type":${jsonQuote(type)},"x":${x},"y":${y}${__areaField(area)}}`); return r.length ? I32.parseInt(r) : -1; }

/** Destroy an entity. */
export function destroy(id: i32): bool { return __ok(`{"op":"destroy","id":${id}}`); }

/** Move an entity to a tile, sliding unless instant is set. */
export function move(id: i32, x: i32, y: i32, instant: bool = false, area: string = ""): bool { return __ok(`{"op":"move","id":${id},"x":${x},"y":${y},"instant":${instant}${__areaField(area)}}`); }

/** Lift an entity off the map. */
export function lift(id: i32): bool { return __ok(`{"op":"lift","id":${id}}`); }

/** Place a lifted entity on a tile. */
export function place(id: i32, x: i32, y: i32, area: string = ""): bool { return __ok(`{"op":"place","id":${id},"x":${x},"y":${y}${__areaField(area)}}`); }

/** Set a component from raw JSON value text. */
export function set(id: i32, comp: string, valueJson: string): bool { return __ok(`{"op":"set","id":${id},"comp":${jsonQuote(comp)},"value":${valueJson}}`); }

/** Set a numeric component. */
export function setNum(id: i32, comp: string, value: f64): bool { return set(id, comp, `${value}`); }

/** Set a string component. */
export function setStr(id: i32, comp: string, value: string): bool { return set(id, comp, jsonQuote(value)); }

/** Set a boolean component. */
export function setBool(id: i32, comp: string, value: bool): bool { return set(id, comp, value ? "true" : "false"); }

/** Remove a component from an entity. */
export function remove(id: i32, comp: string): bool { return __ok(`{"op":"remove","id":${id},"comp":${jsonQuote(comp)}}`); }

/** Add a tag to an entity. */
export function tag(id: i32, name: string): bool { return __ok(`{"op":"tag","id":${id},"tag":${jsonQuote(name)}}`); }

/** Remove a tag from an entity. */
export function untag(id: i32, name: string): bool { return __ok(`{"op":"untag","id":${id},"tag":${jsonQuote(name)}}`); }

/** Play a sprite animation; callback names an onTimer call when it ends or loops. */
export function anim(id: i32, name: string, callback: string = ""): bool { return __ok(`{"op":"anim","id":${id},"name":${jsonQuote(name)}${callback.length ? `,"callback":${jsonQuote(callback)}` : ""}}`); }

/** Change the terrain sprite of a tile. */
export function tileSet(x: i32, y: i32, sprite: string, area: string = ""): bool { return __ok(`{"op":"tile.set","x":${x},"y":${y},"sprite":${jsonQuote(sprite)}${__areaField(area)}}`); }

/** Replace this system's whole saved state with raw JSON. */
export function stateSet(valueJson: string): bool { return __ok(`{"op":"state.set","value":${valueJson}}`); }

/** Emit an event this system owns, with a raw JSON payload object. */
export function emit(name: string, payloadJson: string = "{}"): bool { return __ok(`{"op":"emit","name":${jsonQuote(name)},"payload":${payloadJson}}`); }

/** Call onTimer(name) after a number of ticks. */
export function timer(ticks: i32, name: string): bool { return __ok(`{"op":"timer","ticks":${ticks},"name":${jsonQuote(name)}}`); }

/** Take the controls: "borrow" routes keys to onInput, "freeze" ignores keys. */
export function focus(mode: string): bool { return __ok(`{"op":"focus","mode":${jsonQuote(mode)}}`); }

/** Give the controls back after focus. */
export function releaseFocus(): bool { return __ok(`{"op":"release"}`); }

/** Create an area filled with one terrain sprite; returns its id or "". */
export function areaCreate(name: string, fill: string): string { return jsonUnquote(__result(`{"op":"area.create","name":${jsonQuote(name)},"fill":${jsonQuote(fill)}}`)); }

/** Ids of every area in creation order. */
export function areaList(): Array<string> { const r = __result(`{"op":"area.list"}`); return r.length ? jsonStrList(r) : new Array<string>(); }

/** Id of the area the player is in. */
export function areaCurrent(): string { return jsonUnquote(__result(`{"op":"area.current"}`)); }

/** Move the player to a free tile, in another area or the same one. */
export function travel(area: string, x: i32, y: i32): bool { return __ok(`{"op":"travel","area":${jsonQuote(area)},"x":${x},"y":${y}}`); }

/** Burst of particles of one sprite over a tile. */
export function fxParticles(sprite: string, x: i32, y: i32, count: i32 = 6, area: string = ""): bool { return __ok(`{"op":"fx.particles","sprite":${jsonQuote(sprite)},"x":${x},"y":${y},"count":${count}${__areaField(area)}}`); }

/** Short floating text over a tile. */
export function fxFloat(text: string, x: i32, y: i32, color: string = ""): bool { return __ok(`{"op":"fx.float","text":${jsonQuote(text)},"x":${x},"y":${y}${color.length ? `,"color":${jsonQuote(color)}` : ""}}`); }

/** Soft screen tint for at most 3 seconds and alpha at most 0.6. */
export function fxTint(color: string, alpha: f64, ms: i32): bool { return __ok(`{"op":"fx.tint","color":${jsonQuote(color)},"alpha":${alpha},"ms":${ms}}`); }

/** Start a tween; onTween(id, value) runs each tick; returns the tween id or -1. */
export function fxTween(from: f64, to: f64, ticks: i32): i32 { const r = __result(`{"op":"fx.tween","from":${from},"to":${to},"ticks":${ticks}}`); return r.length ? I32.parseInt(r) : -1; }

/** Show a one-line banner to the player. */
export function uiBanner(text: string): bool { return __ok(`{"op":"ui.banner","text":${jsonQuote(text)}}`); }

/** Add or replace a HUD slot of fixed width. */
export function uiHudAdd(key: string, text: string, width: i32, icon: string = ""): bool { return __ok(`{"op":"ui.hud.add","key":${jsonQuote(key)},"text":${jsonQuote(text)},"width":${width}${icon.length ? `,"icon":${jsonQuote(icon)}` : ""}}`); }

/** Remove a HUD slot added by this system. */
export function uiHudRemove(key: string): bool { return __ok(`{"op":"ui.hud.remove","key":${jsonQuote(key)}}`); }

/** Show an overlay panel from a raw JSON object { title?, lines, bar? }. */
export function uiOverlay(overlayJson: string): bool { return __ok(`{"op":"ui.overlay","value":${overlayJson}}`); }

/** Hide the overlay panel. */
export function uiOverlayClear(): bool { return __ok(`{"op":"ui.overlay","value":null}`); }

/** Test only: walk the player like the keys do. */
export function simWalk(dir: string, steps: i32 = 1): bool { return __ok(`{"op":"sim.walk","dir":${jsonQuote(dir)},"steps":${steps}}`); }

/** Test only: turn the player like a tap does. */
export function simFace(dir: string): bool { return __ok(`{"op":"sim.face","dir":${jsonQuote(dir)}}`); }

/** Test only: press E on the highlighted action. */
export function simInteract(): bool { return __ok(`{"op":"sim.interact"}`); }

/** Test only: press Q to cycle the highlighted action. */
export function simCycle(): bool { return __ok(`{"op":"sim.cycle"}`); }

/** Test only: spawn a type straight into the player's hands; returns its id or -1. */
export function simGive(type: string): i32 { const r = __result(`{"op":"sim.give","type":${jsonQuote(type)}}`); return r.length ? I32.parseInt(r) : -1; }

/** Test only: move the player to a free tile. */
export function simTeleport(x: i32, y: i32, area: string = ""): bool { return __ok(`{"op":"sim.teleport","x":${x},"y":${y}${__areaField(area)}}`); }

/** Test only: run a number of ticks. */
export function simWait(ticks: i32): bool { return __ok(`{"op":"sim.wait","ticks":${ticks}}`); }

/** Test only: jump the clock to a phase name such as "night". */
export function simTime(phase: string): bool { return __ok(`{"op":"sim.time","phaseOrHour":${jsonQuote(phase)}}`); }

/** Test only: send a key to whoever holds focus. */
export function simKey(key: string, kind: string): bool { return __ok(`{"op":"sim.key","key":${jsonQuote(key)},"kind":${jsonQuote(kind)}}`); }

/** Test only: record one named check in a test; the test passes when every check passed. */
export function check(cond: bool, label: string): bool { return __ok(`{"op":"check","cond":${cond},"label":${jsonQuote(label)}}`); }

/** Id of the player, or 0 when there is none. */
export function player(): i32 { const ids = query("player"); return ids.length ? ids[0] : 0; }

/** Direction the player faces: up, down, left or right. */
export function facing(): string { const p = player(); return p ? getStr(p, "facing") : ""; }

/** Tile the player is facing. */
export function facedTile(): TilePos { const p = player(); const pos = p ? infoPos(p) : null; const out = pos ? new TilePos(pos.x, pos.y, pos.area) : new TilePos(0, 0, ""); if (!pos) return out; const f = facing(); if (f == "up") out.y -= 1; else if (f == "down") out.y += 1; else if (f == "left") out.x -= 1; else if (f == "right") out.x += 1; return out; }

/** True when a tile is walkable and no player, solid, pushable or item entity other than selfId is on it. */
export function isFree(x: i32, y: i32, selfId: i32 = 0, area: string = ""): bool {
  const t = tileGet(x, y, area);
  if (t.length == 0 || t == "null") return false;
  const tags = jsonRaw(t, "tags");
  if (!jsonStrList(tags).includes("walkable") || jsonStrList(tags).includes("water")) return false;
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] == selfId) continue;
    const itags = jsonRaw(info(ids[i]), "tags");
    const list = jsonStrList(itags);
    if (list.includes("player") || list.includes("solid") || list.includes("pushable") || list.includes("item")) return false;
  }
  return true;
}

/** True when every tile of an entity's footprint would be free at a new position. */
export function footprintFree(id: i32, x: i32, y: i32): bool {
  const pos = infoPos(id);
  const area = pos ? pos.area : "";
  const spriteRaw = get(id, "sprite");
  const sprite = jsonStr(spriteRaw, "id").length ? jsonStr(spriteRaw, "id") : spriteRaw;
  const cat = catalogGet(sprite);
  const fp = jsonRaw(cat, "footprint");
  let w = 1; let h = 1; let ox = 0;
  if (fp.length && fp != "null") { w = jsonInt(fp, "w"); h = jsonInt(fp, "h"); ox = jsonHas(fp, "x") ? jsonInt(fp, "x") : 0; if (w < 1) w = 1; if (h < 1) h = 1; }
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (!isFree(x + ox + i, y - j, id, area)) return false;
  return true;
}

/** Put an entity in the player's hands, exactly as picking it up does. */
export function giveToPlayer(id: i32): bool { const p = player(); if (!p) return false; if (!lift(id)) return false; return set(p, "held", `{"id":${id}}`); }

// Sandbox plumbing below this line is compiled into every module. It is not part of the API above.
// The module's own exported handlers (perform, onEvent, onTick, onTimer, onInput, onTween, migrate,
// test_* and shot_*) are the wasm exports; this plumbing only carries JSON to and from the host.

let __lastCode: string = "";
let __lastMsg: string = "";
const __resCap: i32 = 131072;
const __resBytes = new Uint8Array(__resCap);

// @ts-ignore: decorator
@external("host", "call")
declare function __hostCall(reqPtr: usize, reqLen: i32, resPtr: usize, resCap: i32): i32;

function __areaField(area: string): string { return area.length ? `,"area":${jsonQuote(area)}` : ""; }

function __posList(raw: string): Array<TilePos> {
  const out = new Array<TilePos>();
  let from = 0;
  while (true) {
    const open = raw.indexOf("{", from);
    if (open < 0) break;
    const close = raw.indexOf("}", open);
    if (close < 0) break;
    const obj = raw.substring(open, close + 1);
    out.push(new TilePos(jsonInt(obj, "x"), jsonInt(obj, "y"), jsonStr(obj, "area")));
    from = close + 1;
  }
  return out;
}

function __send(req: string): string {
  __lastCode = ""; __lastMsg = "";
  const buf = String.UTF8.encode(req);
  const n = __hostCall(changetype<usize>(buf), buf.byteLength, __resBytes.dataStart, __resCap);
  if (n < 0) { __lastCode = "limit"; __lastMsg = "host response did not fit the response buffer"; return ""; }
  const out = new ArrayBuffer(n);
  for (let i = 0; i < n; i++) store<u8>(changetype<usize>(out) + <usize>i, load<u8>(__resBytes.dataStart + <usize>i));
  return String.UTF8.decode(out);
}

function __envelope(req: string): string { return __send(req); }

function __ok(req: string): bool {
  const res = __envelope(req);
  if (res.startsWith("{\"ok\":true")) return true;
  __lastCode = jsonStr(res, "code"); __lastMsg = jsonStr(res, "msg");
  return false;
}

function __result(req: string): string {
  const res = __envelope(req);
  if (!res.startsWith("{\"ok\":true")) { __lastCode = jsonStr(res, "code"); __lastMsg = jsonStr(res, "msg"); return ""; }
  const atR = res.indexOf("\"r\":");
  if (atR < 0 || !res.endsWith("}")) return "";
  return res.substring(atR + 4, res.length - 1);
}

function sdkAbort(message: string | null, fileName: string | null, line: u32, column: u32): void { unreachable(); }
function sdkTrace(message: string, count: i32 = 0, a: f64 = 0, b: f64 = 0, c: f64 = 0, d: f64 = 0, e: f64 = 0): void { }
function sdkSeed(): f64 { return 2718281828.0; }
