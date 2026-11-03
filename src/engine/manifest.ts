// System manifests (spec 5.1): the type, a schema validator the pipeline's Manifest
// stage reuses, and the context checks that need the loaded systems. A manifest is
// read once at load and frozen.
import { catalogGet } from "./catalog";
import { SYSTEM_ID_RE } from "./types";

/** Field types a payload shape may use (spec 5.1). Entity fields may be null. */
export const PAYLOAD_TYPES = ["number", "string", "bool", "entity", "pos", "list", "object"] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];
/** An event's payload shape: field name -> type. */
export type PayloadShape = Record<string, PayloadType>;

/** One interaction a manifest adds to E (spec 6). */
export interface Interaction { verb: string; label: string; target: string; held?: string }

/** A system manifest (spec 5.1). */
export interface Manifest {
  id: string;
  why: string;
  buildsOn: string[];
  replaces: string[];
  entities: Record<string, { sprite: string; tags: string[] }>;
  components: Record<string, string>;
  interactions: Interaction[];
  reactions: string[];
  emits: Record<string, PayloadShape>;
}

/** Event-name prefixes owned by the engine and the base systems (spec 8). No AI system may use them as its id. */
export const RESERVED_PREFIXES = ["player", "item", "entity", "interaction", "time", "system"] as const;
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const TAG_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const FIELDS = ["id", "why", "buildsOn", "replaces", "entities", "components", "interactions", "reactions", "emits"];
/** Fields systems built before shots were removed may still carry. Accepted and dropped. */
const LEGACY_FIELDS = ["shots"];

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function isStrList(v: unknown): v is string[] { return Array.isArray(v) && v.every((x) => typeof x === "string"); }

/** Freeze a plain value and everything inside it. */
export function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}

/**
 * Check a manifest against the schema in spec 5.1 and return a frozen copy with defaults filled in.
 * `base` allows the engine's reserved event prefixes (base systems only). `inherited` names events the
 * system may emit without its own prefix because it replaces their owner (spec 11).
 */
export function validateManifest(raw: unknown, opts: { base?: boolean; inherited?: Iterable<string> } = {}): ManifestResult {
  const errors: string[] = [];
  const err = (m: string) => { errors.push(m); };
  if (!isObj(raw)) return { ok: false, errors: ["the manifest must be a JSON object"] };
  for (const k of Object.keys(raw)) if (!FIELDS.includes(k) && !LEGACY_FIELDS.includes(k)) err(`unknown field "${k}"`);
  const m = raw as Record<string, unknown>;
  const id = m.id;
  if (typeof id !== "string" || !SYSTEM_ID_RE.test(id)) err(`id must match ${SYSTEM_ID_RE}`);
  else if (!opts.base && (RESERVED_PREFIXES as readonly string[]).includes(id)) err(`id "${id}" is reserved for engine events`);
  if (typeof m.why !== "string" || !m.why.trim()) err("why must be a one-line string");
  else if (m.why.includes("\n")) err("why must be one line");
  for (const k of ["buildsOn", "replaces", "reactions"] as const) {
    if (m[k] !== undefined && !isStrList(m[k])) err(`${k} must be a list of strings`);
  }
  if (isStrList(m.buildsOn)) for (const b of m.buildsOn) if (!SYSTEM_ID_RE.test(b)) err(`buildsOn: "${b}" isn't a system id`);
  if (isStrList(m.replaces)) for (const b of m.replaces) if (!SYSTEM_ID_RE.test(b)) err(`replaces: "${b}" isn't a system id`);
  if (isStrList(m.reactions)) for (const r of m.reactions) if (!EVENT_RE.test(r)) err(`reactions: "${r}" isn't an event name`);

  if (m.entities !== undefined) {
    if (!isObj(m.entities)) err("entities must be an object of { sprite, tags }");
    else for (const [name, t] of Object.entries(m.entities)) {
      if (!NAME_RE.test(name)) err(`entities: "${name}" must be lowercase letters, digits and _`);
      if (!isObj(t) || typeof t.sprite !== "string" || !isStrList(t.tags) || Object.keys(t).some((k) => k !== "sprite" && k !== "tags")) { err(`entities.${name} must be { sprite, tags }`); continue; }
      if (!catalogGet(t.sprite)) err(`entities.${name}: sprite "${t.sprite}" isn't in the catalog`);
      for (const tag of t.tags) if (!TAG_RE.test(tag)) err(`entities.${name}: tag "${tag}" must be lowercase`);
    }
  }
  if (m.components !== undefined) {
    if (!isObj(m.components)) err("components must be an object of name -> shape description");
    else for (const [name, d] of Object.entries(m.components)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(name)) err(`components: "${name}" isn't a valid name`);
      if (typeof d !== "string") err(`components.${name} must be a one-line description`);
    }
  }
  if (m.interactions !== undefined) {
    if (!Array.isArray(m.interactions)) err("interactions must be a list");
    else m.interactions.forEach((it, i) => {
      if (!isObj(it) || Object.keys(it).some((k) => !["verb", "label", "target", "held"].includes(k))) { err(`interactions[${i}] must be { verb, label, target, held? }`); return; }
      if (typeof it.verb !== "string" || !NAME_RE.test(it.verb)) err(`interactions[${i}].verb must be lowercase letters, digits and _`);
      if (typeof it.label !== "string" || !it.label.trim() || it.label.length > 24) err(`interactions[${i}].label must be 1 to 24 characters`);
      if (typeof it.target !== "string" || !validTarget(it.target)) err(`interactions[${i}].target must be a type, "#tag", "tile:tag" or "held"`);
      if (it.held !== undefined && (typeof it.held !== "string" || !validHeld(it.held))) err(`interactions[${i}].held must be a type, "#tag" or "none"`);
    });
  }
  const inherited = new Set(opts.inherited ?? []);
  if (m.emits !== undefined) {
    if (!isObj(m.emits)) err("emits must be an object of event name -> payload shape");
    else for (const [name, shape] of Object.entries(m.emits)) {
      if (!EVENT_RE.test(name)) { err(`emits: "${name}" isn't an event name`); continue; }
      const prefix = name.slice(0, name.indexOf("."));
      const ownPrefix = prefix === id || (opts.base && (RESERVED_PREFIXES as readonly string[]).includes(prefix));
      if (!ownPrefix && !inherited.has(name)) err(`emits: "${name}" must start with "${String(id)}."`);
      if (!isObj(shape)) { err(`emits.${name} must be a payload shape`); continue; }
      for (const [f, t] of Object.entries(shape)) if (!(PAYLOAD_TYPES as readonly string[]).includes(t as string)) err(`emits.${name}.${f}: "${String(t)}" isn't one of ${PAYLOAD_TYPES.join(", ")}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const manifest: Manifest = {
    id: id as string, why: m.why as string,
    buildsOn: [...((m.buildsOn as string[]) ?? [])], replaces: [...((m.replaces as string[]) ?? [])],
    entities: structuredClone((m.entities as Manifest["entities"]) ?? {}),
    components: { ...((m.components as Record<string, string>) ?? {}) },
    interactions: structuredClone((m.interactions as Interaction[]) ?? []),
    reactions: [...((m.reactions as string[]) ?? [])],
    emits: structuredClone((m.emits as Manifest["emits"]) ?? {}),
  };
  return { ok: true, manifest: deepFreeze(manifest) };
}

function validTarget(t: string): boolean {
  if (t === "held") return true;
  if (t.startsWith("#")) return TAG_RE.test(t.slice(1));
  if (t.startsWith("tile:")) return TAG_RE.test(t.slice(5));
  return NAME_RE.test(t);
}
function validHeld(h: string): boolean { return h === "none" || (h.startsWith("#") ? TAG_RE.test(h.slice(1)) : NAME_RE.test(h)); }

/** What the context checks need to know about the world the manifest loads into. */
export interface ManifestContext {
  /** Ids of loaded systems. */
  loaded: Set<string>;
  /** Loaded AI systems (only these can be replaced). */
  aiLoaded: Set<string>;
  /** Every event that exists: engine, base and loaded systems' emits. */
  events: Set<string>;
  /** Registered entity types. */
  types: Set<string>;
  /** Replaced id -> the id that replaced it (spec 11). A replaced id in `buildsOn` counts as its replacement. */
  successors?: Map<string, string>;
  /** Manifests of the loaded AI systems, for the `replaces` event checks. */
  manifests?: Map<string, Manifest>;
}

/** `id`, or the newest system that replaced it. */
export function resolveSuccessor(id: string, successors: Map<string, string> | undefined): string {
  const seen = new Set<string>();
  while (successors?.has(id) && !seen.has(id)) { seen.add(id); id = successors.get(id)!; }
  return id;
}

/** The Manifest-stage checks that depend on the loaded systems (spec 12, stage 1). */
export function checkManifestContext(m: Manifest, ctx: ManifestContext): string[] {
  const errors: string[] = [];
  if (ctx.loaded.has(m.id)) errors.push(`a system with id "${m.id}" is already loaded`);
  for (const b of m.buildsOn) if (!ctx.loaded.has(resolveSuccessor(b, ctx.successors))) errors.push(`buildsOn: "${b}" isn't loaded`);
  // Succession (spec 11): only loaded AI systems can be replaced, and every event the replaced
  // system emitted (its own and any it inherited) stays in emits under the same name.
  for (const r of m.replaces) {
    if (r === m.id) errors.push(`replaces: a system can't replace itself`);
    else if (ctx.aiLoaded.has(r)) {
      const old = ctx.manifests?.get(r);
      for (const ev of Object.keys(old?.emits ?? {})) if (!(ev in m.emits)) errors.push(`replaces "${r}": it emits "${ev}", so "${ev}" must stay in emits under the same name (systems that react to it rely on it)`);
    } else if (ctx.loaded.has(r)) errors.push(`replaces: "${r}" is a base system, and base systems can't be replaced`);
    else if (ctx.successors?.has(r)) errors.push(`replaces: "${r}" was already replaced by "${resolveSuccessor(r, ctx.successors)}"; replace that instead`);
    else errors.push(`replaces: "${r}" isn't a loaded AI system`);
  }
  for (const r of m.reactions) if (!ctx.events.has(r) && !(r in m.emits)) errors.push(`reactions: no system emits "${r}"`);
  const types = new Set([...ctx.types, ...Object.keys(m.entities)]);
  for (const it of m.interactions) {
    if (!it.target.startsWith("#") && !it.target.startsWith("tile:") && it.target !== "held" && !types.has(it.target)) errors.push(`interaction "${it.verb}": no entity type "${it.target}"`);
    if (it.held && it.held !== "none" && !it.held.startsWith("#") && !types.has(it.held)) errors.push(`interaction "${it.verb}": no entity type "${it.held}"`);
  }
  return errors;
}
