// The All the World SDK for AI systems (AssemblyScript). Import everything from "sdk".
//
// All game logic runs in ticks (60 per second), never wall-clock time.
//
// Every helper is one request to the host, which checks it and may say no. A denied call never
// crashes your module: a refused read returns an empty value (0, "", [], null JSON) and a
// refused write returns false; lastError() then says why. Entities are numeric ids, 0 means
// "none". Tags and components share one namespace. Tiles default to the player's current area
// when `area` is "".
//
// Module exports you may write (all optional, except as your manifest requires). migrate runs once
// when the system loads into a world and must be safe to run more than once.
//   export function perform(verb: string, target: i32, held: i32): void
//   export function onEvent(name: string, payload: string): void   // payload is JSON
//   export function onTick(): void
//   export function onTimer(name: string): void
//   export function onInput(key: string, kind: string): void
//   export function onTween(id: i32, value: f64): void
//   export function migrate(): void
//   export function test_<name>(): void
//   export function shot_<name>(): void
// Globals don't survive a reload: keep lasting state in components, tags or stateSet.
//
// Every call into your module has a fuel budget: 50,000,000 units for onTick (it runs every frame),
// 200,000,000 for the other handlers (perform, onEvent, onTimer, onInput, onTween), 500,000,000 for
// migrate, a test or a shot (a handler that runs during a test keeps its own budget). Running out
// undoes everything the call did. Helpers are the expensive part: each one costs roughly 100,000 to
// 700,000 units (info and query are among the dearest), so onTick has room for about a hundred. Call info once per entity and keep what it returned
// (posOf and typeOf each call it again), and narrow a query by a specific tag first.
//
// Placing things: pick a spot and let the host find the nearest fit. The player keeps playing
// while you are built, so the tile you chose may be taken by the time your code runs (the
// player stands there, or dropped a branch on it). spawn, place and tileStamp use (x, y) when it
// is free and otherwise the closest spot where the whole thing fits, and say where they put it.
// Pass exact = true only when nowhere else will do: then a taken spot is refused instead.
// Nothing solid, pushable or an item ever lands on the player's tile.
// So never assume the spot you asked for: read it back (posOf(id) after spawn, place's return)
// and work from that, in code and in tests. A test that checks p.x == 21 because migrate asked
// for 21 fails whenever a tree stood there; check against posOf, or where the thing really is.
// The same goes for every position in your prompt (the map image, entity counts, coordinates in
// the task): they were captured when the prompt was built and are only a rough guide. Tests run
// on a fresh map with every system's migrate, and migrate later runs on the live world as it is
// then, so neither matches that capture. Find spots when the code runs: spaceFind, isFree, at,
// posOf, doorOf.
import { send, failure, truncated, op, tileReq, done, numText, JsonParser } from "./internal";

// ============================== JSON ==============================

/** A parsed JSON value. Reading a missing field or index gives a null value, never a crash. */
export class Json {
  /** 0 null, 1 bool, 2 number, 3 string, 4 array, 5 object. */
  kind: i32 = 0;
  private b: bool = false;
  private n: f64 = 0;
  private s: string = "";
  private items: Json[] = [];
  private names: string[] = [];

  /** True for JSON null (also for anything missing). */
  isNull(): bool { return this.kind == 0; }
  /** True for a JSON object. */
  isObject(): bool { return this.kind == 5; }
  /** True for a JSON array. */
  isArray(): bool { return this.kind == 4; }
  /** Field `key` of an object, or null. */
  get(key: string): Json {
    for (let i = 0; i < this.names.length; i++) if (this.names[i] == key) return this.items[i];
    return new Json();
  }
  /** True when an object has field `key` (even if its value is null). */
  has(key: string): bool { return this.names.includes(key); }
  /** Item `i` of an array, or null. */
  at(i: i32): Json { return this.kind == 4 && i >= 0 && i < this.items.length ? this.items[i] : new Json(); }
  /** Number of items in an array or fields in an object. */
  get length(): i32 { return this.items.length; }
  /** Field names of an object, in order. */
  keys(): string[] { return this.names.slice(0); }
  /** The number, or `fallback` when this isn't a number. */
  num(fallback: f64 = 0): f64 { return this.kind == 2 ? this.n : fallback; }
  /** The number as an integer, or `fallback`. */
  int(fallback: i32 = 0): i32 { return this.kind == 2 ? <i32>this.n : fallback; }
  /** The string, or `fallback` when this isn't a string. */
  str(fallback: string = ""): string { return this.kind == 3 ? this.s : fallback; }
  /** The boolean, or `fallback` when this isn't a boolean. */
  bool(fallback: bool = false): bool { return this.kind == 1 ? this.b : fallback; }
  /** The items of an array of integers (entity ids, for example). */
  ints(): i32[] { const out = new Array<i32>(); for (let i = 0; i < this.items.length; i++) out.push(this.items[i].int()); return out; }
  /** The items of an array of strings. */
  strs(): string[] { const out = new Array<string>(); for (let i = 0; i < this.items.length; i++) out.push(this.items[i].str()); return out; }
  /** Compact JSON text of this value. */
  toString(): string {
    if (this.kind == 1) return this.b ? "true" : "false";
    if (this.kind == 2) return numText(this.n);
    if (this.kind == 3) return quote(this.s);
    if (this.kind == 4) {
      let t = "[";
      for (let i = 0; i < this.items.length; i++) { if (i) t += ","; t += this.items[i].toString(); }
      return t + "]";
    }
    if (this.kind == 5) {
      let t = "{";
      for (let i = 0; i < this.items.length; i++) { if (i) t += ","; t += quote(this.names[i]) + ":" + this.items[i].toString(); }
      return t + "}";
    }
    return "null";
  }

  /** A JSON boolean. */
  static fromBool(v: bool): Json { const j = new Json(); j.kind = 1; j.b = v; return j; }
  /** A JSON number. */
  static fromNum(v: f64): Json { const j = new Json(); j.kind = 2; j.n = v; return j; }
  /** A JSON string. */
  static fromStr(v: string): Json { const j = new Json(); j.kind = 3; j.s = v; return j; }
  /** A JSON array of these items. */
  static fromList(items: Json[]): Json { const j = new Json(); j.kind = 4; j.items = items; return j; }
  /** A JSON object with these field names and values. */
  static fromFields(names: string[], items: Json[]): Json { const j = new Json(); j.kind = 5; j.names = names; j.items = items; return j; }
}

/** Parse JSON text. Invalid text gives a null value. */
export function parse(text: string): Json {
  const p = new JsonParser(text);
  const v = p.value();
  p.space();
  return p.ok && p.i == text.length ? v : new Json();
}

/** A JSON string literal for `s`, with quotes and escapes. */
export function quote(s: string): string {
  let t = "\"";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) t += "\\\"";
    else if (c == 92) t += "\\\\";
    else if (c == 10) t += "\\n";
    else if (c == 13) t += "\\r";
    else if (c == 9) t += "\\t";
    else if (c < 32) t += "\\u00" + (c < 16 ? "0" : "") + c.toString(16);
    else t += String.fromCharCode(c);
  }
  return t + "\"";
}

/** Builds a JSON object: new Obj().int("x", 3).str("name", "a").toString() is {"x":3,"name":"a"}. */
export class Obj {
  private body: string = "";
  /** Add a number field. */
  num(key: string, v: f64): Obj { return this.raw(key, numText(v)); }
  /** Add an integer field. */
  int(key: string, v: i32): Obj { return this.raw(key, v.toString()); }
  /** Add a string field. */
  str(key: string, v: string): Obj { return this.raw(key, quote(v)); }
  /** Add a boolean field. */
  bool(key: string, v: bool): Obj { return this.raw(key, v ? "true" : "false"); }
  /** Add a null field. */
  nul(key: string): Obj { return this.raw(key, "null"); }
  /** Add a field whose value is already JSON text (an Obj, Arr or Pos turned into a string). */
  raw(key: string, json: string): Obj {
    if (this.body.length) this.body += ",";
    this.body += quote(key) + ":" + json;
    return this;
  }
  /** The JSON text. */
  toString(): string { return "{" + this.body + "}"; }
}

/** Builds a JSON array: new Arr().int(1).str("a").toString() is [1,"a"]. */
export class Arr {
  private body: string = "";
  /** Add a number. */
  num(v: f64): Arr { return this.raw(numText(v)); }
  /** Add an integer. */
  int(v: i32): Arr { return this.raw(v.toString()); }
  /** Add a string. */
  str(v: string): Arr { return this.raw(quote(v)); }
  /** Add a boolean. */
  bool(v: bool): Arr { return this.raw(v ? "true" : "false"); }
  /** Add a value that is already JSON text. */
  raw(json: string): Arr { if (this.body.length) this.body += ","; this.body += json; return this; }
  /** The JSON text. */
  toString(): string { return "[" + this.body + "]"; }
}

// ============================== value types ==============================

/** A tile position. `area` "" means the player's current area. */
export class Pos {
  x: i32 = 0;
  y: i32 = 0;
  area: string = "";
  constructor(x: i32, y: i32, area: string = "") { this.x = x; this.y = y; this.area = area; }
  /** JSON text { x, y, area? }, for payloads and components. */
  toString(): string { const o = new Obj().int("x", this.x).int("y", this.y); if (this.area.length) o.str("area", this.area); return o.toString(); }
  /** True when both name the same tile (an empty area matches any). */
  equals(o: Pos): bool { return this.x == o.x && this.y == o.y && (this.area == o.area || this.area == "" || o.area == ""); }
  /** A JSON { x, y, area? } as a Pos, or null when it isn't one. */
  static from(j: Json): Pos | null { return j.isObject() ? new Pos(j.get("x").int(), j.get("y").int(), j.get("area").str()) : null; }
}

/** What `info` returns about an entity. */
export class Info {
  type: string = "";
  /** Tile of the sprite's bottom-left corner, or null while lifted or held. The footprint extends
   *  upward and rightward from it as the catalog's footprint says; taller sprites draw upward. */
  pos: Pos | null = null;
  tags: string[] = [];
}

/** A width and height in tiles. */
export class Size {
  w: i32 = 0;
  h: i32 = 0;
}

/** A terrain tile: its sprite id and catalog tags. */
export class Tile {
  sprite: string = "";
  tags: string[] = [];
}

/** The clock. */
export class Time {
  /** Starts at 1 and goes up at each dawn. */
  day: i32 = 1;
  /** 0 to 24, fractional. */
  hour: f64 = 0;
  /** "dawn", "day", "dusk" or "night". */
  phase: string = "";
}

// ============================== requests ==============================

/** Send any request ({ op, ...fields } as an Obj) and return its result; null JSON when refused. */
export function request(req: Obj): Json { return send(req); }
/** Why the last request was refused ("code: reason"), or "" when it succeeded. */
export function lastError(): string { return failure(); }

// ---- reads ----

/** Ids of every entity with this tag or component, ascending (at most 5,000; see queryTruncated). */
export function query(tagOrComponent: string): i32[] {
  return request(op("query").str("with", tagOrComponent)).get("ids").ints();
}
/** True when the last query had more than 5,000 matches and was cut. */
export function queryTruncated(): bool { return truncated(); }
/**
 * Top-left of the closest w x h block, from (x, y), where every tile is free (walkable, with no
 * player, solid, pushable or item on it), or null when there is none in the area. Use it to place
 * things that belong together. The answer holds only for the rest of this same call: nothing
 * else runs until your handler returns, but after a timer or the next tick, find it again.
 */
export function spaceFind(x: i32, y: i32, w: i32, h: i32, area: string = ""): Pos | null {
  return Pos.from(request(tileReq("space.find", x, y, area).int("w", w).int("h", h)));
}
/** Ids of entities whose footprint covers tile (x, y). With isFree, the way to test collision. */
export function at(x: i32, y: i32, area: string = ""): i32[] { return request(tileReq("at", x, y, area)).ints(); }
/** Type, position and tags of an entity, or null when it no longer exists. pos: see Info.pos. */
export function info(id: i32): Info | null {
  const r = request(op("info").int("id", id));
  if (!r.isObject()) return null;
  const i = new Info();
  i.type = r.get("type").str();
  i.pos = Pos.from(r.get("pos"));
  i.tags = r.get("tags").strs();
  return i;
}
/** A component's value (null when absent or the entity is gone). */
export function get(id: i32, comp: string): Json { return request(op("get").int("id", id).str("comp", comp)); }
/** A number component, or `fallback`. */
export function getNum(id: i32, comp: string, fallback: f64 = 0): f64 { return get(id, comp).num(fallback); }
/** A string component, or `fallback`. */
export function getStr(id: i32, comp: string, fallback: string = ""): string { return get(id, comp).str(fallback); }
/** A boolean component, or `fallback`. */
export function getBool(id: i32, comp: string, fallback: bool = false): bool { return get(id, comp).bool(fallback); }
/** The terrain at (x, y), or null outside the area. */
export function tileGet(x: i32, y: i32, area: string = ""): Tile | null {
  const r = request(tileReq("tile.get", x, y, area));
  if (!r.isObject()) return null;
  const t = new Tile();
  t.sprite = r.get("sprite").str();
  t.tags = r.get("tags").strs();
  return t;
}
/** Every tile whose terrain has this catalog tag, such as "water" or "walkable". */
export function tileFind(tag: string, area: string = ""): Pos[] {
  const o = op("tile.find").str("tag", tag); if (area.length) o.str("area", area);
  const r = request(o); const out = new Array<Pos>();
  for (let i = 0; i < r.length; i++) { const p = Pos.from(r.at(i)); if (p) out.push(p); }
  return out;
}
/** A catalog entry as JSON (id, tags, materials, desc, footprint, anims, ...), or null. A size like
 *  "3x3 tiles" is ONE entity, not a grid of copies. Anim names come from "anims". */
export function catalogGet(sprite: string): Json { return request(op("catalog.get").str("id", sprite)); }
/** Sprite ids with this catalog tag. Pick art by meaning (tags, materials, desc), not by id. */
export function catalogFind(tag: string): string[] { return request(op("catalog.find").str("tag", tag)).strs(); }
/** The clock: day (from 1, up at each dawn), hour (0 to 24, fractional) and phase. */
export function time(): Time {
  const r = request(op("time")); const t = new Time();
  t.day = r.get("day").int(1); t.hour = r.get("hour").num(); t.phase = r.get("phase").str();
  return t;
}
/** A number in [0, 1) from this system's own seeded stream. Always use it, never Math.random. */
export function rand(): f64 { return request(op("rand")).num(); }
/** This system's saved state (null when none). Saved with the world; the module itself is
 *  re-created on every load. */
export function stateGet(): Json { return request(op("state.get")); }
/** The saved state of a system this one replaces. Only during migrate. */
export function stateGetReplaced(id: string): Json { return request(op("state.getReplaced").str("id", id)); }

// ---- writes ----

/**
 * Spawn a registered entity type (a base map type, one in this system's manifest "entities", or
 * one another loaded system registered), never a bare catalog sprite id: declare new types in
 * "entities" first. Its bottom-left goes at (x, y), or, when its footprint doesn't fit there, at
 * the closest spot in the area where it does: always read where with posOf(id), never assume
 * (x, y). Returns its id, or 0 when refused. With exact = true a spot that doesn't fit is refused instead.
 */
export function spawn(type: string, x: i32, y: i32, area: string = "", exact: bool = false): i32 {
  const o = tileReq("spawn", x, y, area).str("type", type); if (exact) o.bool("exact", true);
  return request(o).int();
}
/** Remove an entity. */
export function destroy(id: i32): bool { return done(op("destroy").int("id", id)); }
/** Move an entity so its bottom-left is (x, y): slides one step by default, instant = true teleports.
 *  The player can't be moved. Refused (never moved elsewhere) if it would block the player's tile. */
export function move(id: i32, x: i32, y: i32, instant: bool = false, area: string = ""): bool { return done(tileReq("move", x, y, area).int("id", id).bool("instant", instant)); }
/** Take an entity off the map (pos becomes null); place puts it back. */
export function lift(id: i32): bool { return done(op("lift").int("id", id)); }
/**
 * Put a lifted entity back on the map at (x, y), or at the closest spot where its footprint fits.
 * Returns where it went, or null when refused. With exact = true a spot that doesn't fit is refused.
 */
export function place(id: i32, x: i32, y: i32, area: string = "", exact: bool = false): Pos | null {
  const o = tileReq("place", x, y, area).int("id", id); if (exact) o.bool("exact", true);
  return Pos.from(request(o));
}
/** Set a component to a JSON value (text, e.g. an Obj's toString()). Setting "sprite" ({ id, anim?,
 *  frame?, z?, offset? }) changes what's drawn and the footprint, and updates occupancy. A "light"
 *  component { radius, color, strength, flicker? } makes something glow; the renderer does the rest. */
export function set(id: i32, comp: string, json: string): bool { return done(op("set").int("id", id).str("comp", comp).raw("value", json)); }
/** Set a number component. */
export function setNum(id: i32, comp: string, v: f64): bool { return set(id, comp, numText(v)); }
/** Set a string component. */
export function setStr(id: i32, comp: string, v: string): bool { return set(id, comp, quote(v)); }
/** Set a boolean component. */
export function setBool(id: i32, comp: string, v: bool): bool { return set(id, comp, v ? "true" : "false"); }
/** Remove a component. */
export function remove(id: i32, comp: string): bool { return done(op("remove").int("id", id).str("comp", comp)); }
/** Add a tag. */
export function tag(id: i32, name: string): bool { return done(op("tag").int("id", id).str("tag", name)); }
/** Remove a tag. */
export function untag(id: i32, name: string): bool { return done(op("untag").int("id", id).str("tag", name)); }
/** Play a sprite anim (names from its catalog "anims"); with a callback, onTimer(callback) fires
 *  when it ends (or after one loop). */
export function anim(id: i32, name: string, callback: string = ""): bool {
  const o = op("anim").int("id", id).str("name", name); if (callback.length) o.str("callback", callback);
  return done(o);
}
/**
 * Set a block of terrain at once: rows[0] is the top row, starting at (x, y); each entry is a
 * terrain sprite id, or null to leave that tile as it is. A stream's pieces or a 3x3 pond go down
 * together, all or nothing. If a tile that changes isn't free for its new terrain (the player, or
 * anything solid, pushable or an item, stands on it; for terrain you can't walk on, anything at all), the whole block
 * moves to the closest place where every changing tile is free. Returns the top-left used, or null
 * when refused. With exact = true a block that doesn't fit at (x, y) is refused instead.
 */
export function tileStamp(x: i32, y: i32, rows: Array<Array<string | null>>, area: string = "", exact: bool = false): Pos | null {
  let t = "[";
  for (let j = 0; j < rows.length; j++) {
    if (j) t += ",";
    t += "[";
    const row = rows[j];
    for (let i = 0; i < row.length; i++) {
      if (i) t += ",";
      const s = row[i];
      if (s === null) t += "null"; else t += quote(s!);
    }
    t += "]";
  }
  const o = tileReq("tile.stamp", x, y, area).raw("rows", t + "]"); if (exact) o.bool("exact", true);
  return Pos.from(request(o));
}
/** Change the terrain sprite of a tile. Refused if it would make the player's tile unwalkable. */
export function tileSet(x: i32, y: i32, sprite: string, area: string = ""): bool { return done(tileReq("tile.set", x, y, area).str("sprite", sprite)); }
/** Replace this system's whole saved state with a JSON value (text). Saved with the world. */
export function stateSet(json: string): bool { return done(op("state.set").raw("value", json)); }

// ---- events, timers, controls ----

/** Emit an event this system owns (listed in its manifest's emits) with a JSON object payload. */
export function emit(name: string, payload: Obj): bool { return done(op("emit").str("name", name).raw("payload", payload.toString())); }
/** onTimer(name) fires after `ticks` ticks (60 per second). */
export function timer(ticks: i32, name: string): bool { return done(op("timer").int("ticks", ticks).str("name", name)); }
/** Take the controls: "borrow" sends keys to onInput, "freeze" ignores every key but Escape. */
export function focus(mode: string): bool { return done(op("focus").str("mode", mode)); }
/** Give the controls back. */
export function release(): bool { return done(op("release")); }

// ---- areas ----

/** Create an area filled with one walkable terrain sprite (catalog tag "walkable"; water, pits and
 *  cliffs are refused). Returns its id ("<system>.<name>"), or "".
 *  `w` x `h` is its size in tiles: anything from 1x1 up to the main map's size (30x20). 0 (the
 *  default) means the map's width or height. Make an area the size the place should be: a hut's
 *  inside can be 8x6 and a hall 16x10. Tiles run from (0, 0) to (w - 1, h - 1); the screen shows a
 *  smaller area centred with darkness around it, and its edge blocks like the map edge does.
 *  Positions outside it are refused, so use areaSize to read the size back at run time. */
export function areaCreate(name: string, fill: string, w: i32 = 0, h: i32 = 0): string {
  const o = op("area.create").str("name", name).str("fill", fill);
  if (w > 0) o.int("w", w); if (h > 0) o.int("h", h);
  return request(o).str();
}
/** An area's size in tiles ("" means the player's current area); 0x0 for an unknown area. */
export function areaSize(area: string = ""): Size {
  const o = op("area.size"); if (area.length) o.str("area", area);
  const r = request(o); const s = new Size();
  if (r.isObject()) { s.w = r.get("w").int(); s.h = r.get("h").int(); }
  return s;
}
/** Ids of every area. */
export function areaList(): string[] { return request(op("area.list")).strs(); }
/** The player's current area id. */
export function areaCurrent(): string { return request(op("area.current")).str(); }
/** Move the player to a free tile in an area (the only way a system moves the player). */
export function travel(area: string, x: i32, y: i32): bool { return done(op("travel").str("area", area).int("x", x).int("y", y)); }

// ---- effects and UI ----

/** Burst of particles from a sprite at tile (x, y), one random piece each when the sprite has
 *  pieces. `count` 0 means the default. */
export function particles(sprite: string, x: i32, y: i32, count: i32 = 0, area: string = ""): bool {
  const o = tileReq("fx.particles", x, y, area).str("sprite", sprite); if (count > 0) o.int("count", count);
  return done(o);
}
/** Text that floats up from tile (x, y) and fades. `color` is a hex colour like "#ffcc66" ("" for white). */
export function floatText(text: string, x: i32, y: i32, color: string = "", area: string = ""): bool {
  const o = tileReq("fx.float", x, y, area).str("text", text); if (color.length) o.str("color", color);
  return done(o);
}
/** A brief full-screen colour that fades (alpha at most 0.6, at most 3000 ms). */
export function tint(color: string, alpha: f64, ms: f64): bool { return done(op("fx.tint").str("color", color).num("alpha", alpha).num("ms", ms)); }
/** Tween from `from` to `to` over `ticks`; onTween(id, value) each tick. Returns the tween id, or 0. */
export function tween(from: f64, to: f64, ticks: i32): i32 { return request(op("fx.tween").num("from", from).num("to", to).int("ticks", ticks)).int(); }
/** Show a short banner that fades on its own (one per 2 s per system). */
export function banner(text: string): bool { return done(op("ui.banner").str("text", text)); }
/** Add or replace the HUD slot with this key. `width` is the characters to reserve, so the HUD never
 *  shifts; `icon` a sprite id or "". */
export function hudAdd(key: string, text: string, width: i32, icon: string = ""): bool {
  const o = op("ui.hud.add").str("key", key).str("text", text).int("width", width); if (icon.length) o.str("icon", icon);
  return done(o);
}
/** Remove a HUD slot. */
export function hudRemove(key: string): bool { return done(op("ui.hud.remove").str("key", key)); }
/** Show the overlay panel: JSON { title?, lines: string[], bar?: { value, label? } }. */
export function overlay(panel: Obj): bool { return done(op("ui.overlay").raw("panel", panel.toString())); }
/** Hide the overlay panel. */
export function overlayClear(): bool { return done(op("ui.overlay").nul("panel")); }

// ---- tests and shots only ----
// sim.* plays through the same paths as real keys, and each call runs enough ticks to finish.

/** Hold a direction key until the player tried `steps` steps (moved or blocked). */
export function simWalk(dir: string, steps: i32 = 1): bool { return done(op("sim.walk").str("dir", dir).int("steps", steps)); }
/** Turn the player to face a direction (a tap; does nothing if already facing it). */
export function simFace(dir: string): bool { return done(op("sim.face").str("dir", dir)); }
/** Press E. */
export function simInteract(): bool { return done(op("sim.interact")); }
/** Press Q. */
export function simCycle(): bool { return done(op("sim.cycle")); }
/** Spawn a registered entity type into the player's empty hands, exactly as Pick up does. Returns its id, or 0. */
export function simGive(type: string): i32 { return request(op("sim.give").str("type", type)).int(); }
/** Put the player on a free tile. */
export function simTeleport(x: i32, y: i32, area: string = ""): bool { return done(tileReq("sim.teleport", x, y, area)); }
/** Run the world for `ticks` ticks. */
export function simWait(ticks: i32): bool { return done(op("sim.wait").int("ticks", ticks)); }
/** Jump the clock to a phase ("dawn", "day", "dusk", "night"). Does not change the day. Emits
 *  time.jumped, then runs one tick, so time.phase (if the phase changed) and every system's
 *  reaction to it have already happened when this returns. */
export function simTime(phase: string): bool { return done(op("sim.time").str("phaseOrHour", phase)); }
/** Jump the clock to an hour (0 to 24). Does not change the day. Events and the one tick as simTime. */
export function simTimeHour(hour: f64): bool { return done(op("sim.time").num("phaseOrHour", hour)); }
/** Send a key ("up", "down", "left", "right", "e", "q", "escape") "down" or "up", then run one tick. */
export function simKey(key: string, kind: string): bool { return done(op("sim.key").str("key", key).str("kind", kind)); }
/** Events fired since the world was built (all, or only `name`): a JSON array of
 *  { tick, name, payload, during }. `during` is "migrate" for events fired while the world was set
 *  up (every system's migrate, before the test began) and "test" for the rest, so a check like
 *  "x.placed fired once" sees migrate's announcement. Count only during == "test" to check what
 *  the test's own actions caused. */
export function simEvents(name: string = ""): Json { const o = op("sim.events"); if (name.length) o.str("name", name); return request(o); }
/** Record a named check. A test passes only if every check passed and at least one ran. Cover the
 *  cases where your action should do nothing, too. */
export function check(cond: bool, label: string): void { request(op("check").bool("cond", cond).str("label", label)); }

// ============================== helpers ==============================

/** The player's entity id. */
export function player(): i32 { const ids = query("player"); return ids.length ? ids[0] : 0; }
/** The direction the player faces ("up", "down", "left" or "right"), read from the player's
 *  "facing" component, the one place facing is stored. */
export function facing(): string { return getStr(player(), "facing", "down"); }
/** The player's tile, or null while the player is off the map. */
export function playerPos(): Pos | null { const i = info(player()); return i ? i.pos : null; }
/** The tile in front of the player. */
export function facedTile(): Pos {
  const p = playerPos(); if (!p) return new Pos(0, 0);
  const f = facing();
  return new Pos(p.x + dirX(f), p.y + dirY(f), p.area);
}
/** -1, 0 or 1: the x step of a direction. */
export function dirX(dir: string): i32 { return dir == "left" ? -1 : dir == "right" ? 1 : 0; }
/** -1, 0 or 1: the y step of a direction (down is +1). */
export function dirY(dir: string): i32 { return dir == "up" ? -1 : dir == "down" ? 1 : 0; }
/** The id of the item in the player's hands, or 0. The player's "held" component ({ id }) is the
 *  one place that says what's in hand. */
export function held(): i32 { return get(player(), "held").get("id").int(); }
/** An entity's bottom-left tile, or null when lifted, held or gone. */
export function posOf(id: i32): Pos | null { const i = info(id); return i ? i.pos : null; }
/** An entity's type, or "" when it is gone. */
export function typeOf(id: i32): string { const i = info(id); return i ? i.type : ""; }
/** True when an entity has this tag or component. */
export function has(id: i32, name: string): bool {
  const i = info(id); if (!i) return false;
  return i.tags.includes(name) || !get(id, name).isNull();
}
/** Walkable terrain with no player, solid, pushable or item entity other than `selfId`. */
export function isFree(x: i32, y: i32, selfId: i32 = 0, area: string = ""): bool {
  const t = tileGet(x, y, area);
  if (!t || !t.tags.includes("walkable") || t.tags.includes("water")) return false;
  const ids = at(x, y, area);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]; if (id == selfId) continue;
    if (has(id, "player") || has(id, "solid") || has(id, "pushable") || has(id, "item")) return false;
  }
  return true;
}
/**
 * The doorstep of a building: the tile in front of (just below) its door, where the player stands
 * and faces up to use it. null when the entity is gone, lifted, or its sprite has no door (catalog
 * "door"). The door itself is part of the solid footprint: nothing can stand in it.
 */
export function doorOf(id: i32): Pos | null {
  if (id <= 0) return null;
  const i = info(id); if (!i) return null;
  const p = i.pos; if (!p) return null;
  const door = catalogGet(get(id, "sprite").get("id").str()).get("door");
  if (!door.isObject()) return null;
  return new Pos(p.x + door.get("x").int(), p.y + 1, p.area);
}
/** The tiles a sprite covers with its bottom-left at (x, y). Footprints extend upward and rightward. */
export function footprintTiles(sprite: string, x: i32, y: i32, area: string = ""): Pos[] {
  const fp = catalogGet(sprite).get("footprint");
  const w = fp.get("w").int(1), h = fp.get("h").int(1), ox = fp.get("x").int(0);
  const out = new Array<Pos>();
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) out.push(new Pos(x + ox + i, y - j, area));
  return out;
}
/** True when every tile of `id`'s footprint at (x, y) is free for it. */
export function footprintFree(id: i32, x: i32, y: i32, area: string = ""): bool {
  const tiles = footprintTiles(get(id, "sprite").get("id").str(), x, y, area);
  for (let i = 0; i < tiles.length; i++) if (!isFree(tiles[i].x, tiles[i].y, id, area)) return false;
  return true;
}
/** Put an item in the player's empty hands exactly as Pick up does (lift it, then set the
 *  player's "held" to { id }). */
export function giveToPlayer(id: i32): bool {
  const p = player();
  if (!get(p, "held").isNull()) return false;
  if (!lift(id)) return false;
  return set(p, "held", new Obj().int("id", id).toString());
}
