// Manifest type and validator for spec 5.1. The pipeline Manifest stage reuses this.
export type PayloadKind = "number" | "string" | "bool" | "entity" | "pos" | "list" | "object";
export const PAYLOAD_KINDS: PayloadKind[] = ["number", "string", "bool", "entity", "pos", "list", "object"];
export const SYSTEM_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;

export interface InteractionDef { verb: string; label: string; target: string; held?: string }
export interface ShotDef { name: string; ticks: number; focus: { x: number; y: number; area?: string }; time?: string }
export interface Manifest {
  id: string; why: string; buildsOn: string[]; replaces: string[];
  entities: Record<string, { sprite: string; tags: string[] }>;
  components: Record<string, string>;
  interactions: InteractionDef[]; reactions: string[];
  emits: Record<string, Record<string, PayloadKind>>;
  shots: ShotDef[];
}
export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x); Object.freeze(v); }
  return v;
}
export function freezeManifest(m: Manifest): Manifest { return deepFreeze(JSON.parse(JSON.stringify(m)) as Manifest); }

export function validateManifest(input: unknown, opts?: { checkSprite?: (id: string) => boolean }): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["manifest must be a JSON object"] };
  const m = input;
  if (typeof m.id !== "string" || !SYSTEM_ID_RE.test(m.id)) errors.push("id must match ^[a-z][a-z0-9_]{0,39}$");
  if (typeof m.why !== "string" || !m.why.trim()) errors.push("why must be a non-empty one-line string");
  const idList = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !SYSTEM_ID_RE.test(x))) { errors.push(`${field} must be an array of system ids`); return []; }
    return [...v as string[]];
  };
  const buildsOn = idList(m.buildsOn, "buildsOn");
  const replaces = idList(m.replaces, "replaces");
  const entities: Manifest["entities"] = {};
  if (m.entities !== undefined) {
    if (!isRecord(m.entities)) errors.push("entities must be an object");
    else for (const [name, def] of Object.entries(m.entities)) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) { errors.push(`entity type "${name}" has an invalid name`); continue; }
      if (!isRecord(def) || typeof def.sprite !== "string" || !def.sprite) { errors.push(`entity "${name}" needs a sprite string`); continue; }
      if (opts?.checkSprite && !opts.checkSprite(def.sprite)) errors.push(`entity "${name}" sprite "${def.sprite}" is not in the catalog`);
      if (!Array.isArray(def.tags) || def.tags.some((t) => typeof t !== "string")) { errors.push(`entity "${name}" tags must be strings`); continue; }
      entities[name] = { sprite: def.sprite, tags: [...def.tags as string[]] };
    }
  }
  const components: Record<string, string> = {};
  if (m.components !== undefined) {
    if (!isRecord(m.components)) errors.push("components must be an object");
    else for (const [k, v] of Object.entries(m.components)) {
      if (typeof v !== "string") errors.push(`component "${k}" needs a shape description string`); else components[k] = v;
    }
  }
  const interactions: InteractionDef[] = [];
  if (m.interactions !== undefined) {
    if (!Array.isArray(m.interactions)) errors.push("interactions must be an array");
    else m.interactions.forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.verb !== "string" || !raw.verb || typeof raw.label !== "string" || !raw.label || typeof raw.target !== "string" || !raw.target) { errors.push(`interactions[${i}] needs verb, label and target strings`); return; }
      if (raw.held !== undefined && typeof raw.held !== "string") { errors.push(`interactions[${i}].held must be a string`); return; }
      interactions.push({ verb: raw.verb, label: raw.label, target: raw.target, ...(raw.held !== undefined ? { held: raw.held as string } : {}) });
    });
  }
  let reactions: string[] = [];
  if (m.reactions !== undefined) {
    if (!Array.isArray(m.reactions) || m.reactions.some((x) => typeof x !== "string" || !x.includes("."))) errors.push("reactions must be an array of event names");
    else reactions = [...m.reactions as string[]];
  }
  const emits: Manifest["emits"] = {};
  if (m.emits !== undefined) {
    if (!isRecord(m.emits)) errors.push("emits must be an object");
    else for (const [name, shape] of Object.entries(m.emits)) {
      if (!isRecord(shape)) { errors.push(`emits.${name} must be a payload shape object`); continue; }
      const out: Record<string, PayloadKind> = {};
      for (const [field, kind] of Object.entries(shape)) {
        if (!PAYLOAD_KINDS.includes(kind as PayloadKind)) errors.push(`emits.${name}.${field} has unknown payload kind "${String(kind)}"`);
        else out[field] = kind as PayloadKind;
      }
      emits[name] = out;
    }
  }
  const shots: ShotDef[] = [];
  if (m.shots !== undefined) {
    if (!Array.isArray(m.shots)) errors.push("shots must be an array");
    else m.shots.forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name || !Number.isInteger(raw.ticks) || (raw.ticks as number) < 0 || !isRecord(raw.focus) || !Number.isInteger(raw.focus.x) || !Number.isInteger(raw.focus.y)) { errors.push(`shots[${i}] needs name, ticks and focus {x,y}`); return; }
      if (raw.focus.area !== undefined && typeof raw.focus.area !== "string") { errors.push(`shots[${i}].focus.area must be a string`); return; }
      if (raw.time !== undefined && typeof raw.time !== "string") { errors.push(`shots[${i}].time must be a string`); return; }
      shots.push({ name: raw.name, ticks: raw.ticks as number, focus: { x: raw.focus.x as number, y: raw.focus.y as number, ...(raw.focus.area ? { area: raw.focus.area as string } : {}) }, ...(raw.time ? { time: raw.time as string } : {}) });
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: freezeManifest({ id: m.id as string, why: m.why as string, buildsOn, replaces, entities, components, interactions, reactions, emits, shots }) };
}
