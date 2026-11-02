// Interactions on E and Q (spec 6). The resolver reads the interaction table and the
// world; no system code runs until the player presses E.
//
// Ranking, one rule at a time (the first rule that separates two matches decides):
// 1. what it acts on: faced entity, faced tile, held item only; Drop is always last
// 2. what must be held: exact type, tag, "none", left out
// 3. how it names the target: exact type, then tag
// 4. age: the newer system wins (then manifest order)
import type { Engine, EntRec } from "./engine";
import type { Host } from "./host";
import type { InteractionEntry } from "./registry";
import { catalogGet } from "./catalog";

/** carry's Drop, which always ranks last. */
export const DROP = { owner: "carry", verb: "drop" };
const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BLOCKING = ["solid", "pushable", "item"];

/** One action E can run right now. `target` is the faced entity id, 0 for a tile, or the held id. */
export interface Match { entry: InteractionEntry; target: number; held: number; rank: [number, number, number, number, number] }

/** Where the player is looking, read straight from the engine. */
export interface Facing {
  player: EntRec; area: string; tile: { x: number; y: number };
  /** The faced entity: an item first, then pushable, then anything else (never the player). */
  entity: EntRec | null;
  /** Every entity on the faced tile, in that same order (never the player). */
  entities: EntRec[];
  /** True when a solid, pushable or item entity stands on the faced tile. */
  tileBlocked: boolean;
  terrainTags: string[];
  held: EntRec | null;
}

export function readFacing(eng: Engine): Facing | null {
  const player = eng.player(); if (!player?.pos) return null;
  const dir = (player.comps.get("facing") as string | undefined) ?? "down";
  const d = DELTA[dir] ?? DELTA.down;
  const tile = { x: player.pos.x + d[0], y: player.pos.y + d[1] }; const area = player.pos.area;
  const recs = eng.at(area, tile.x, tile.y).filter((id) => id !== player.id).map((id) => eng.rec(id)!);
  const pref = (r: EntRec) => (eng.has(r, "item") ? 0 : eng.has(r, "pushable") ? 1 : 2);
  const entities = recs.map((r, i) => ({ r, i })).sort((a, b) => pref(a.r) - pref(b.r) || a.i - b.i).map((x) => x.r);
  const entity = entities[0] ?? null;
  const heldId = (player.comps.get("held") as { id?: number } | undefined)?.id;
  const held = typeof heldId === "number" ? eng.rec(heldId) ?? null : null;
  const terrain = eng.tileAt(area, tile.x, tile.y);
  return {
    player, area, tile, entity, entities, held,
    tileBlocked: recs.some((r) => BLOCKING.some((b) => eng.has(r, b))),
    terrainTags: terrain ? catalogGet(terrain)?.tags ?? [] : [],
  };
}

/** Does `entry` match what the player faces and holds? Returns the match with its rank, or null. */
export function matchEntry(eng: Engine, f: Facing, entry: InteractionEntry): Match | null {
  let acts: number; let target: number; let naming: number;
  if (entry.target === "held") {
    if (!f.held) return null;
    acts = entry.owner === DROP.owner && entry.verb === DROP.verb ? 3 : 2; target = f.held.id; naming = 1;
  } else if (entry.target.startsWith("tile:")) {
    if (f.tileBlocked || !f.terrainTags.includes(entry.target.slice(5))) return null;
    acts = 1; target = 0; naming = 1;
  } else {
    // Any entity on the faced tile can be the target, so a flower or a floor laid on the same
    // tile doesn't hide a building or a doormat. The first one in facing order that fits wins.
    const tagged = entry.target.startsWith("#");
    const e = f.entities.find((r) => (tagged ? eng.has(r, entry.target.slice(1)) : r.type === entry.target));
    if (!e) return null;
    naming = tagged ? 1 : 0; acts = 0; target = e.id;
  }
  let heldRank: number;
  if (entry.held === undefined) heldRank = 3;
  else if (entry.held === "none") { if (f.held) return null; heldRank = 2; }
  else if (entry.held.startsWith("#")) { if (!f.held || !eng.has(f.held, entry.held.slice(1))) return null; heldRank = 1; }
  else { if (!f.held || f.held.type !== entry.held) return null; heldRank = 0; }
  return { entry, target, held: f.held?.id ?? 0, rank: [acts, heldRank, naming, -entry.order, entry.index] };
}

function compare(a: Match, b: Match): number {
  for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return 0;
}

/** Every match for the current facing, best first. */
export function resolve(eng: Engine, table: readonly InteractionEntry[]): { facing: Facing | null; matches: Match[] } {
  const facing = readFacing(eng); if (!facing) return { facing, matches: [] };
  const matches = table.map((e) => matchEntry(eng, facing, e)).filter((m): m is Match => !!m).sort(compare);
  return { facing, matches };
}

/** The resolver state the engine keeps between ticks: matches, the Q index and the prompt. */
export class Interactions {
  matches: Match[] = [];
  index = 0;
  private place = "";
  private sig = "";
  private facing: Facing | null = null;

  constructor(private host: Host) {}

  get current(): Match | null { return this.matches[this.index] ?? null; }

  /** Re-run the lookup when the player's position, facing, held item or faced tile changed. Turning or stepping resets Q. */
  refresh(force = false) {
    const eng = this.host.eng;
    const f = readFacing(eng);
    const place = f ? `${f.area}|${f.player.pos!.x},${f.player.pos!.y}|${f.player.comps.get("facing")}` : "";
    const sig = `${place}|${this.host.registryVersion}|${f ? this.describeFacing(f) : ""}`;
    if (force || sig !== this.sig) {
      const { facing, matches } = resolve(eng, this.host.registry.interactions);
      const key = (ms: Match[]) => ms.map((m) => `${m.entry.owner}/${m.entry.index}/${m.target}/${m.held}`).join("|");
      // Turning or stepping resets Q to the default, and so does any change in what matches.
      if (place !== this.place || key(matches) !== key(this.matches)) this.index = 0;
      this.facing = facing; this.matches = matches;
      this.place = place; this.sig = sig;
    }
    this.updatePrompt();
  }

  /** Q: the next match, wrapping. */
  cycle() {
    this.refresh();
    if (this.matches.length > 1) this.index = (this.index + 1) % this.matches.length;
    this.updatePrompt();
  }

  /** E: run the highlighted action as one transaction, then emit interaction.performed. */
  perform() {
    this.refresh();
    const m = this.current; const f = this.facing; if (!m || !f) return;
    const res = this.host.runPerform(m.entry.owner, m.entry.verb, m.target, m.held);
    if (res.ok) {
      this.host.emitEngine("interaction.performed", { verb: m.entry.verb, target: m.target || null, held: m.held || null, owner: m.entry.owner, pos: { x: f.tile.x, y: f.tile.y, area: f.area } });
    }
    this.refresh(true);
  }

  /** "E: Chop", or "E: Chop ‹1/3› Q" with more than one match. Hidden while anyone holds focus. */
  promptText(): string | null {
    const m = this.current; if (!m || this.host.focus.holder) return null;
    return this.matches.length > 1 ? `E: ${m.entry.label} ‹${this.index + 1}/${this.matches.length}› Q` : `E: ${m.entry.label}`;
  }

  private updatePrompt() {
    const eng = this.host.eng; const text = this.promptText(); const m = this.current; const f = this.facing;
    if (!text || !m || !f) { eng.prompt = null; return; }
    // Above the target: the top of the faced entity's footprint, the faced tile, or the player for a held target.
    let x = f.tile.x, y = f.tile.y;
    if (m.entry.target === "held") { x = f.player.pos!.x; y = f.player.pos!.y; }
    else if (m.target) { const t = eng.footprintOfRec(eng.rec(m.target)!); if (t.length) y = Math.min(...t.map((p) => p.y)); }
    eng.prompt = { text, x, y, area: f.area };
  }

  private describeFacing(f: Facing): string {
    const eng = this.host.eng;
    const ids = eng.at(f.area, f.tile.x, f.tile.y).map((id) => { const r = eng.rec(id)!; return `${id}:${r.type}:${[...r.tags].join(",")}:${BLOCKING.filter((b) => r.comps.has(b)).join(",")}`; });
    const held = f.held ? `${f.held.id}:${f.held.type}:${[...f.held.tags].join(",")}` : "-";
    return `${eng.tileAt(f.area, f.tile.x, f.tile.y)}|${ids.join(";")}|${held}`;
  }
}
