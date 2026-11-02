// Small typed helpers over host.call for the base systems, mirroring the SDK that AI
// systems get in Phase 3. Everything here is a request: no base system touches the
// engine directly.
import type { HostCall } from "../../engine/systems";
import type { Request } from "../../engine/host";

export type Dir = "up" | "down" | "left" | "right";
export interface P { x: number; y: number; area: string }
export const DELTA: Record<Dir, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
export const isDir = (v: unknown): v is Dir => typeof v === "string" && v in DELTA;
/** Tags and components that make a tile not free (spec 3). */
const BLOCKERS = ["player", "solid", "pushable", "item"];

export class Api {
  constructor(readonly call: HostCall) {}
  /** Send a request; the result, or null when it was denied. */
  r<T = unknown>(op: string, fields: Record<string, unknown> = {}): T | null {
    const res = this.call({ op, ...fields } as Request);
    return res.ok ? (res.r as T) : null;
  }
  /** Send a write; true when the host accepted it. */
  do(op: string, fields: Record<string, unknown> = {}): boolean { return this.call({ op, ...fields } as Request).ok; }
  /** Send a request that must succeed in a test (a denial throws, which fails the test). */
  must<T = unknown>(op: string, fields: Record<string, unknown> = {}): T {
    const res = this.call({ op, ...fields } as Request);
    if (!res.ok) throw new Error(`${op} was refused: ${res.code}: ${res.msg}`);
    return res.r as T;
  }

  player(): number { return this.r<{ ids: number[] }>("query", { with: "player" })?.ids[0] ?? 0; }
  info(id: number) { return this.r<{ type: string; pos: P | null; tags: string[] }>("info", { id }); }
  pos(id: number): P | null { return this.info(id)?.pos ?? null; }
  get<T = unknown>(id: number, comp: string): T | null { return this.r<T>("get", { id, comp }); }
  facing(id: number): Dir { const f = this.get<string>(id, "facing"); return isDir(f) ? f : "down"; }
  has(id: number, name: string): boolean { return !!this.info(id)?.tags.includes(name) || this.get(id, name) !== null; }
  at(x: number, y: number, area?: string): number[] { return this.r<number[]>("at", area ? { x, y, area } : { x, y }) ?? []; }
  emit(name: string, payload: Record<string, unknown>) { return this.call({ op: "emit", name, payload }); }

  /** The tiles `id`'s sprite covers with its bottom-left at (x, y): footprints extend upward. */
  footprint(id: number, x: number, y: number): { x: number; y: number }[] {
    const sprite = this.get<{ id: string }>(id, "sprite")?.id;
    const fp = (sprite ? this.r<{ footprint?: { x?: number; w: number; h: number } }>("catalog.get", { id: sprite })?.footprint : undefined) ?? { w: 1, h: 1 };
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < fp.w; i++) for (let j = 0; j < fp.h; j++) out.push({ x: x + (fp.x ?? 0) + i, y: y - j });
    return out;
  }
  /** Walkable terrain with no player, solid, pushable or item entity other than `self`. Off the map is never free. */
  isFree(x: number, y: number, self: number, area: string): boolean {
    const t = this.r<{ tags: string[] } | null>("tile.get", { x, y, area });
    if (!t || !t.tags.includes("walkable") || t.tags.includes("water")) return false;
    return this.at(x, y, area).every((id) => id === self || !BLOCKERS.some((b) => this.has(id, b)));
  }
  /** Every tile of `id`'s footprint at (x, y) is free for it. */
  footprintFree(id: number, x: number, y: number, area: string): boolean {
    return this.footprint(id, x, y).every((t) => this.isFree(t.x, t.y, id, area));
  }

  // ---- test only ----
  check(cond: boolean, label: string) { this.must("check", { cond, label }); }
  /** Events of this name fired since the test started. */
  events(name: string): { tick: number; name: string; payload: Record<string, unknown> }[] { return this.must("sim.events", { name }); }
}
