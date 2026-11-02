// Interaction resolver (spec 6): ranking, Q cycle and the E prompt. No system code runs here.
import { catalogGet } from "./catalog";
import type { Engine, Pos } from "./engine";
import type { InteractionEntry } from "./registry";

export type Dir = "up" | "down" | "left" | "right";
export const DELTA: Record<Dir, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

export interface Match {
  entry: InteractionEntry;
  targetId: number; // faced entity id, 0 for a tile target, held id for a "held" target
  targetPos: Pos;
  kind: "entity" | "tile" | "held";
}

export interface InteractionHost {
  eng: Engine;
  entries: () => InteractionEntry[];
  perform: (m: Match) => void;
}

function facingOf(eng: Engine): Dir {
  const f = eng.playerRec()?.comps.get("facing");
  return f === "up" || f === "left" || f === "right" ? f : "down";
}
export function facedTilePos(eng: Engine): Pos | null {
  const p = eng.playerRec(); if (!p?.pos) return null;
  const d = DELTA[facingOf(eng)];
  return { x: p.pos.x + d.x, y: p.pos.y + d.y, area: p.pos.area };
}
/** Faced entity: the one on the faced tile, preferring item, then pushable, then anything else (never the player). */
export function facedEntityId(eng: Engine): number {
  const tile = facedTilePos(eng); if (!tile) return 0;
  const ids = eng.atIds(tile.x, tile.y, tile.area).filter((id) => id !== eng.playerRec()?.id);
  const rank = (id: number) => { const r = eng.recById(id)!; return r.tags.has("item") ? 0 : r.tags.has("pushable") ? 1 : 2; };
  ids.sort((a, b) => rank(a) - rank(b) || a - b);
  return ids[0] ?? 0;
}
export function heldIdOf(eng: Engine): number {
  const h = eng.playerRec()?.comps.get("held") as { id?: unknown } | undefined;
  return h && typeof h.id === "number" ? h.id : 0;
}

function heldRank(e: InteractionEntry): number {
  if (e.held === undefined) return 3;
  if (e.held === "none") return 2;
  return e.held.startsWith("#") ? 1 : 0;
}
function targetRank(e: InteractionEntry): number {
  if (e.target.startsWith("#") || e.target.startsWith("tile:") || e.target === "held") return 1;
  return 0;
}
function kindRank(m: Match): number { return m.kind === "entity" ? 0 : m.kind === "tile" ? 1 : 2; }
function isDrop(e: InteractionEntry): boolean { return e.verb === "drop" || e.label === "Drop"; }

/** Compare matches one rule at a time (spec 6). Exported for tests. */
export function compareMatches(a: Match, b: Match): number {
  const drop = Number(isDrop(a.entry)) - Number(isDrop(b.entry)); if (drop) return drop;
  const kind = kindRank(a) - kindRank(b); if (kind) return kind;
  const held = heldRank(a.entry) - heldRank(b.entry); if (held) return held;
  const target = targetRank(a.entry) - targetRank(b.entry); if (target) return target;
  const age = b.entry.loadIndex - a.entry.loadIndex; if (age) return age; // newer system wins
  return a.entry.owner.localeCompare(b.entry.owner) || a.entry.verb.localeCompare(b.entry.verb);
}

export class Interactions {
  matches: Match[] = [];
  selected = 0;
  private signature = "";
  constructor(private host: InteractionHost) {}

  get current(): Match | null { return this.matches[this.selected] ?? null; }
  get prompt(): string | null {
    const m = this.current; if (!m) return null;
    return this.matches.length > 1 ? `E: ${m.entry.label} ‹${this.selected + 1}/${this.matches.length}› Q` : `E: ${m.entry.label}`;
  }

  refresh(): void {
    const eng = this.host.eng;
    const next = this.compute();
    const sig = this.signatureOf(next);
    if (sig !== this.signature) { this.signature = sig; this.selected = 0; }
    if (this.selected >= next.length) this.selected = 0;
    this.matches = next;
    eng.interactionPrompt = this.prompt;
    const cur = this.current;
    eng.interactionPromptAt = cur ? { ...cur.targetPos } : null;
  }
  private signatureOf(matches: Match[]): string {
    const eng = this.host.eng; const p = eng.playerRec();
    return [p?.pos ? `${p.pos.x},${p.pos.y},${p.pos.area}` : "-", facingOf(eng), heldIdOf(eng), facedEntityId(eng),
      matches.map((m) => `${m.entry.owner}:${m.entry.verb}:${m.targetId}`).join(";")].join("|");
  }
  /** Turning or stepping resets the cycle (the signature changes with facing or position). */
  resetCycle(): void { this.selected = 0; this.signature = this.signatureOf(this.matches); }
  cycle(): void {
    if (this.matches.length > 1) this.selected = (this.selected + 1) % this.matches.length;
    this.host.eng.interactionPrompt = this.prompt;
    const cur = this.current; this.host.eng.interactionPromptAt = cur ? { ...cur.targetPos } : null;
  }
  performCurrent(): void {
    this.refresh();
    const m = this.current; if (!m) return;
    this.host.perform(m);
    this.refresh();
  }

  compute(): Match[] {
    const eng = this.host.eng;
    const player = eng.playerRec(); if (!player?.pos) return [];
    const tile = facedTilePos(eng)!;
    const facedId = facedEntityId(eng);
    const faced = facedId ? eng.recById(facedId) : undefined;
    const heldId = heldIdOf(eng);
    const held = heldId ? eng.recById(heldId) : undefined;
    const terrainTags = (() => { const s = eng.tileAt(tile.x, tile.y, tile.area); return s ? catalogGet(s)?.tags ?? [] : []; })();
    const tileBlocked = eng.atIds(tile.x, tile.y, tile.area).some((id) => { const r = eng.recById(id); return !!r && (r.tags.has("solid") || r.tags.has("pushable") || r.tags.has("item")); });
    const out: Match[] = [];
    for (const entry of this.host.entries()) {
      // Held gate.
      if (entry.held === "none") { if (heldId) continue; }
      else if (entry.held !== undefined) {
        if (!held) continue;
        if (entry.held.startsWith("#")) { if (!held.tags.has(entry.held.slice(1))) continue; }
        else if (held.type !== entry.held) continue;
      }
      // Target gate.
      if (entry.target === "held") {
        if (!held || !heldId) continue;
        out.push({ entry, targetId: heldId, targetPos: { ...player.pos }, kind: "held" });
      } else if (entry.target.startsWith("tile:")) {
        if (tileBlocked) continue;
        if (!terrainTags.includes(entry.target.slice(5))) continue;
        out.push({ entry, targetId: 0, targetPos: tile, kind: "tile" });
      } else if (entry.target.startsWith("#")) {
        if (!faced || !faced.tags.has(entry.target.slice(1))) continue;
        out.push({ entry, targetId: facedId, targetPos: tile, kind: "entity" });
      } else {
        if (!faced || faced.type !== entry.target) continue;
        out.push({ entry, targetId: facedId, targetPos: tile, kind: "entity" });
      }
    }
    return out.sort(compareMatches);
  }
}
