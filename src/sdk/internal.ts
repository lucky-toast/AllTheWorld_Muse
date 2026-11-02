// Internal plumbing behind index.ts: request sending, the last error, request
// builders, number formatting and the JSON parser. Not part of the reference.
import { Json, Obj, parse } from "./index";
import { callHost } from "./host";

let lastErr = "";
let lastTruncated = false;

/** Send a request; remember why it was refused (or "" when it succeeded). */
export function send(req: Obj): Json {
  const res = parse(callHost(req.toString()));
  if (res.get("ok").bool()) {
    lastErr = "";
    const r = res.get("r");
    lastTruncated = r.isObject() && r.get("truncated").bool();
    return r;
  }
  lastErr = res.get("code").str("bad_request") + ": " + res.get("msg").str();
  return new Json();
}
export function failure(): string { return lastErr; }
export function truncated(): bool { return lastTruncated; }
export function op(name: string): Obj { return new Obj().str("op", name); }
export function tileReq(name: string, x: i32, y: i32, area: string): Obj { const o = op(name).int("x", x).int("y", y); if (area.length) o.str("area", area); return o; }
export function done(req: Obj): bool { send(req); return lastErr.length == 0; }


export function numText(v: f64): string {
  if (!isFinite(v)) return "null";
  if (v == Math.floor(v) && Math.abs(v) < 1e15) return (<i64>v).toString();
  return v.toString();
}

export class JsonParser {
  i: i32 = 0;
  ok: bool = true;
  constructor(public t: string) {}
  space(): void {
    while (this.i < this.t.length) {
      const c = this.t.charCodeAt(this.i);
      if (c == 32 || c == 9 || c == 10 || c == 13) this.i++; else break;
    }
  }
  fail(): Json { this.ok = false; return new Json(); }
  value(): Json {
    this.space();
    if (!this.ok || this.i >= this.t.length) return this.fail();
    const c = this.t.charCodeAt(this.i);
    if (c == 123) return this.object();
    if (c == 91) return this.array();
    if (c == 34) { const s = this.string(); return this.ok ? Json.fromStr(s) : this.fail(); }
    if (this.word("true")) return Json.fromBool(true);
    if (this.word("false")) return Json.fromBool(false);
    if (this.word("null")) return new Json();
    return this.number();
  }
  word(w: string): bool {
    // Compared in place: no substring is made.
    const n = w.length;
    if (this.i + n > this.t.length) return false;
    for (let k = 0; k < n; k++) if (this.t.charCodeAt(this.i + k) != w.charCodeAt(k)) return false;
    this.i += n;
    return true;
  }
  number(): Json {
    const start = this.i;
    // Plain integers (ids, coordinates, counts) are read directly; anything else goes through parseFloat.
    let neg = false; let v: f64 = 0; let plain = true;
    if (this.i < this.t.length && this.t.charCodeAt(this.i) == 45) { neg = true; this.i++; }
    const digits = this.i;
    while (this.i < this.t.length) {
      const c = this.t.charCodeAt(this.i);
      if (c >= 48 && c <= 57) { v = v * 10 + <f64>(c - 48); this.i++; }
      else if (c == 45 || c == 43 || c == 46 || c == 101 || c == 69) { plain = false; this.i++; }
      else break;
    }
    if (this.i == start) return this.fail();
    if (plain && this.i > digits && this.i - digits <= 15) return Json.fromNum(neg ? -v : v);
    const n = parseFloat(this.t.substring(start, this.i));
    return isNaN(n) ? this.fail() : Json.fromNum(n);
  }
  string(): string {
    this.i++; // opening quote
    let out = "";
    let run = this.i;
    while (this.i < this.t.length) {
      const c = this.t.charCodeAt(this.i);
      if (c == 34) { const s = this.t.substring(run, this.i); this.i++; return out.length ? out + s : s; }
      if (c == 92) {
        out += this.t.substring(run, this.i);
        const e = this.t.charCodeAt(this.i + 1);
        if (e == 110) out += "\n"; else if (e == 116) out += "\t"; else if (e == 114) out += "\r";
        else if (e == 98) out += "\b"; else if (e == 102) out += "\f";
        else if (e == 117) { out += String.fromCharCode(<i32>parseInt(this.t.substr(this.i + 2, 4), 16)); this.i += 4; }
        else out += String.fromCharCode(e);
        this.i += 2; run = this.i;
        continue;
      }
      this.i++;
    }
    this.ok = false;
    return out;
  }
  array(): Json {
    this.i++;
    const items = new Array<Json>();
    this.space();
    if (this.i < this.t.length && this.t.charCodeAt(this.i) == 93) { this.i++; return Json.fromList(items); }
    while (this.ok) {
      items.push(this.value());
      this.space();
      if (this.i >= this.t.length) return this.fail();
      const c = this.t.charCodeAt(this.i++);
      if (c == 93) return Json.fromList(items);
      if (c != 44) return this.fail();
    }
    return this.fail();
  }
  object(): Json {
    this.i++;
    const names = new Array<string>(); const items = new Array<Json>();
    this.space();
    if (this.i < this.t.length && this.t.charCodeAt(this.i) == 125) { this.i++; return Json.fromFields(names, items); }
    while (this.ok) {
      this.space();
      if (this.i >= this.t.length || this.t.charCodeAt(this.i) != 34) return this.fail();
      names.push(this.string());
      this.space();
      if (this.i >= this.t.length || this.t.charCodeAt(this.i++) != 58) return this.fail();
      items.push(this.value());
      this.space();
      if (this.i >= this.t.length) return this.fail();
      const c = this.t.charCodeAt(this.i++);
      if (c == 125) return Json.fromFields(names, items);
      if (c != 44) return this.fail();
    }
    return this.fail();
  }
}
