// Event payloads (spec 8): checked against the declared shape on emit. Entity fields
// carry ids; the host replaces each with the entity's real { id, type, pos }, so a
// payload can't lie about an entity.
import type { Engine } from "./engine";
import type { PayloadShape } from "./manifest";

/** An entity as it arrives in an event payload. `type` and `pos` are null when the entity no longer exists. */
export interface EntityRef { id: number; type: string | null; pos: { x: number; y: number; area: string } | null }

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }

/**
 * Check `payload` against `shape` and return the payload the reactors get, or an error message.
 * Every declared field must be present and no other field may be. An entity field takes an id
 * (or any object with a numeric `id`, whose other fields are ignored) or null. A pos field takes
 * { x, y, area? }; a missing area is the player's current area.
 */
export function checkPayload(eng: Engine, name: string, shape: PayloadShape, payload: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; msg: string } {
  const p = payload === undefined ? {} : payload;
  if (!isObj(p)) return { ok: false, msg: `the payload of ${name} must be an object` };
  for (const k of Object.keys(p)) if (!(k in shape)) return { ok: false, msg: `${name} has no payload field "${k}"` };
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(shape)) {
    const v = p[field];
    const bad = (what: string) => ({ ok: false as const, msg: `${name}.${field} must be ${what}` });
    if (v === undefined && type !== "entity") return { ok: false, msg: `${name} needs payload field "${field}"` };
    switch (type) {
      case "number": if (typeof v !== "number" || !Number.isFinite(v)) return bad("a number"); out[field] = v; break;
      case "string": if (typeof v !== "string") return bad("a string"); out[field] = v; break;
      case "bool": if (typeof v !== "boolean") return bad("true or false"); out[field] = v; break;
      case "list": if (!Array.isArray(v)) return bad("a list"); out[field] = structuredClone(v); break;
      case "object": if (!isObj(v)) return bad("an object"); out[field] = structuredClone(v); break;
      case "pos": {
        if (!isObj(v) || !Number.isInteger(v.x) || !Number.isInteger(v.y) || (v.area !== undefined && typeof v.area !== "string")) return bad("a position { x, y, area? }");
        out[field] = { x: v.x, y: v.y, area: (v.area as string | undefined) ?? eng.currentArea() };
        break;
      }
      case "entity": {
        if (v === undefined || v === null) { out[field] = null; break; }
        const id = typeof v === "number" ? v : isObj(v) ? v.id : undefined;
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return bad("an entity id or null");
        out[field] = entityRef(eng, id);
        break;
      }
    }
  }
  return { ok: true, payload: out };
}

/** The real { id, type, pos } of an entity, filled in by the host. */
export function entityRef(eng: Engine, id: number): EntityRef {
  const r = eng.rec(id);
  return { id, type: r?.type ?? null, pos: r?.pos ? { ...r.pos } : null };
}
