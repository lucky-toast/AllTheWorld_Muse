// The journal (spec 13.3) and the AI log (spec 13.5), kept through the game's Store
// (data/journal.json and data/ai-log.jsonl on the dev server, localStorage in built copies).
import type { Store } from "../pipeline/store";
import type { UpdateMeta } from "./designer";
import { estTokens } from "./template";

/** One journal entry, appended when a designer step loads. */
export interface JournalEntry extends UpdateMeta { systemId: string; wish: string; step: string; timestamp: string }

export class Journal {
  entries: JournalEntry[] = [];
  constructor(private store: Pick<Store, "loadJournal" | "saveJournal">) {}
  async load() { try { this.entries = (await this.store.loadJournal()) as JournalEntry[]; } catch { this.entries = []; } }
  async append(e: JournalEntry) { this.entries.push(e); await this.store.saveJournal(this.entries); }
  /** Drop the entry of a system that was undone. */
  async forget(systemId: string) {
    const n = this.entries.length; this.entries = this.entries.filter((e) => e.systemId !== systemId);
    if (this.entries.length !== n) await this.store.saveJournal(this.entries);
  }
}

export type AiRole = "planner" | "designer";
/** One line of the AI log: a sent message, a reply, or a note (dropped, nothing to build, a warning). */
export interface AiLogEntry { kind: "sent" | "reply" | "note"; role: AiRole | "chain"; text: string; chars: number; tokensEst: number; timestamp: string; wish?: string; step?: number }

export class AiLog {
  entries: AiLogEntry[] = [];
  onAppend: (e: AiLogEntry) => void = () => {};
  /** Appends are sent one after another, so the file keeps their order. */
  private pending: Promise<void> = Promise.resolve();
  constructor(private store: Pick<Store, "appendAiLog">, private now: () => string = () => new Date().toISOString()) {}
  add(kind: AiLogEntry["kind"], role: AiLogEntry["role"], text: string, extra: { wish?: string; step?: number } = {}) {
    const e: AiLogEntry = { kind, role, text, chars: text.length, tokensEst: estTokens(text.length), timestamp: this.now(), ...extra };
    this.entries.push(e); this.onAppend(e);
    const line = JSON.stringify(e);
    this.pending = this.pending.then(() => this.store.appendAiLog(line)).catch((err) => console.warn("AI log append failed:", err));
    return e;
  }
  /** Resolves when every append so far is written. */
  flushed(): Promise<void> { return this.pending; }
}
