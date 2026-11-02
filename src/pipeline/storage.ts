// Storage (spec 13.2): one interface, three backends.
// - DevServerStorage: the Vite dev server writes data/systems/<id>/ + JSON files.
// - LocalStorageStorage: built copies; manifests/source/order in localStorage,
//   compiled modules in an IndexedDB cache keyed by source hash.
// - MemoryStorage: tests and in-process use.
import { compileSystem } from "../sandbox/compile";
export interface StoredSystem {
  id: string;
  manifestJson: string;
  source: string;
  wasm: Uint8Array;
  sha256: string;
  buildsOn: string[];
  replacedBy?: string;
  timestamp: number;
}

export interface SystemStorage {
  listRecords(): Promise<StoredSystem[]>;
  getSystem(id: string): Promise<StoredSystem | null>;
  putSystem(rec: StoredSystem): Promise<void>;
  removeSystem(id: string): Promise<void>;
  saveWorld(json: string): Promise<void>;
  loadWorld(): Promise<string | null>;
  appendJournal(entry: Record<string, unknown>): Promise<void>;
  loadJournal(): Promise<Record<string, unknown>[]>;
  appendAiLog(line: string): Promise<void>;
  startFresh(): Promise<void>;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback (no subtle crypto): FNV-1a, only a cache key, never a security check.
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); }
  return `fnv${(h >>> 0).toString(16)}`;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class MemoryStorage implements SystemStorage {
  records = new Map<string, StoredSystem>();
  order: string[] = [];
  world: string | null = null;
  journal: Record<string, unknown>[] = [];
  aiLog: string[] = [];
  async listRecords(): Promise<StoredSystem[]> { return this.order.map((id) => this.records.get(id)!).filter(Boolean); }
  async getSystem(id: string): Promise<StoredSystem | null> { return this.records.get(id) ?? null; }
  async putSystem(rec: StoredSystem): Promise<void> { if (!this.records.has(rec.id)) this.order.push(rec.id); this.records.set(rec.id, { ...rec, wasm: rec.wasm.slice() }); }
  async removeSystem(id: string): Promise<void> { this.records.delete(id); this.order = this.order.filter((x) => x !== id); }
  async saveWorld(json: string): Promise<void> { this.world = json; }
  async loadWorld(): Promise<string | null> { return this.world; }
  async appendJournal(entry: Record<string, unknown>): Promise<void> { this.journal.push(entry); }
  async loadJournal(): Promise<Record<string, unknown>[]> { return [...this.journal]; }
  async appendAiLog(line: string): Promise<void> { this.aiLog.push(line); }
  async startFresh(): Promise<void> { this.records.clear(); this.order = []; this.world = null; this.journal = []; this.aiLog = []; }
}

/** Dev-server backend: every call goes to the /__systems endpoints in vite.config.ts. */
export class DevServerStorage implements SystemStorage {
  constructor(private base = "/__systems") {}
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const r = await fetch(this.base + path, init);
    if (!r.ok) throw new Error(`storage ${path} failed: ${r.status}`);
    return r.json();
  }
  async listRecords(): Promise<StoredSystem[]> {
    const data = (await this.json("")) as { systems: { id: string }[] };
    const out: StoredSystem[] = [];
    for (const meta of data.systems ?? []) {
      const rec = await this.getSystem(meta.id);
      if (rec) out.push(rec);
    }
    return out;
  }
  async getSystem(id: string): Promise<StoredSystem | null> {
    try {
      const manifestJson = await (await fetch(`${this.base}/system?id=${encodeURIComponent(id)}&file=manifest.json`)).text();
      const source = await (await fetch(`${this.base}/system?id=${encodeURIComponent(id)}&file=source.as`)).text();
      const wasmRes = await fetch(`${this.base}/system?id=${encodeURIComponent(id)}&file=module.wasm`);
      if (!wasmRes.ok) return null;
      const wasm = new Uint8Array(await wasmRes.arrayBuffer());
      const meta = (await this.json("")) as { systems: { id: string; buildsOn?: string[]; replacedBy?: string; sha256?: string; timestamp?: number }[] };
      const m = (meta.systems ?? []).find((s) => s.id === id);
      return { id, manifestJson, source, wasm, sha256: m?.sha256 ?? (await sha256Hex(wasm)), buildsOn: m?.buildsOn ?? [], replacedBy: m?.replacedBy, timestamp: m?.timestamp ?? 0 };
    } catch { return null; }
  }
  async putSystem(rec: StoredSystem): Promise<void> {
    await this.json("/system", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: rec.id, manifestJson: rec.manifestJson, source: rec.source, wasmB64: bytesToB64(rec.wasm), buildsOn: rec.buildsOn, replacedBy: rec.replacedBy ?? null, timestamp: rec.timestamp }) });
  }
  async removeSystem(id: string): Promise<void> { await fetch(`${this.base}/system?id=${encodeURIComponent(id)}`, { method: "DELETE" }); }
  async saveWorld(json: string): Promise<void> { await this.json("/world", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ world: json }) }); }
  async loadWorld(): Promise<string | null> { const d = (await this.json("/world").catch(() => ({ world: null }))) as { world: string | null }; return d.world; }
  async appendJournal(entry: Record<string, unknown>): Promise<void> { await this.json("/journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry }) }); }
  async loadJournal(): Promise<Record<string, unknown>[]> { const d = (await this.json("/journal").catch(() => ({ journal: [] }))) as { journal: Record<string, unknown>[] }; return d.journal ?? []; }
  async appendAiLog(line: string): Promise<void> { await this.json("/ai-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line }) }); }
  async startFresh(): Promise<void> { await this.json("/fresh", { method: "POST" }); }
}

// --- IndexedDB module cache (built copies): source hash -> compiled bytes. ---
function openModuleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("atw-modules", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("modules"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function idbGetModule(hash: string): Promise<Uint8Array | null> {
  try {
    const db = await openModuleDb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction("modules").objectStore("modules").get(hash);
      r.onsuccess = () => resolve(r.result ? new Uint8Array(r.result as ArrayBuffer) : null);
      r.onerror = () => reject(r.error);
    });
  } catch { return null; }
}
export async function idbPutModule(hash: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openModuleDb();
    await new Promise<void>((resolve, reject) => {
      const r = db.transaction("modules", "readwrite").objectStore("modules").put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), hash);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  } catch { /* cache is best-effort */ }
}
export async function idbClearModules(): Promise<void> {
  try {
    const db = await openModuleDb();
    await new Promise<void>((resolve, reject) => {
      const r = db.transaction("modules", "readwrite").objectStore("modules").clear();
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  } catch { /* best effort */ }
}

/** Built-copy backend: localStorage for manifests/source/order/world/journal. */
export class LocalStorageStorage implements SystemStorage {
  private key = "atw.";
  private read<T>(k: string, fallback: T): T { try { const v = localStorage.getItem(this.key + k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } }
  private write(k: string, v: unknown): void { try { localStorage.setItem(this.key + k, JSON.stringify(v)); } catch { /* full/blocked: best effort */ } }
  async listRecords(): Promise<StoredSystem[]> {
    const metas = this.read<{ id: string; manifestJson: string; source: string; buildsOn: string[]; replacedBy?: string; timestamp: number }[]>("systems", []);
    const out: StoredSystem[] = [];
    for (const m of metas) {
      const hash = await sha256Hex(m.source);
      let wasm = await idbGetModule(hash);
      if (!wasm) {
        // Recompiled from source when the cache is missing (spec 13.2).
        const r = await compileSystem(JSON.parse(m.manifestJson), m.source);
        if (!r.ok) continue;
        wasm = r.bytes;
        await idbPutModule(hash, wasm);
      }
      out.push({ id: m.id, manifestJson: m.manifestJson, source: m.source, wasm, sha256: await sha256Hex(wasm), buildsOn: m.buildsOn, replacedBy: m.replacedBy, timestamp: m.timestamp });
    }
    return out;
  }
  async getSystem(id: string): Promise<StoredSystem | null> { return (await this.listRecords()).find((r) => r.id === id) ?? null; }
  async putSystem(rec: StoredSystem): Promise<void> {
    const metas = this.read<{ id: string; manifestJson: string; source: string; buildsOn: string[]; replacedBy?: string; timestamp: number }[]>("systems", []).filter((m) => m.id !== rec.id);
    metas.push({ id: rec.id, manifestJson: rec.manifestJson, source: rec.source, buildsOn: rec.buildsOn, replacedBy: rec.replacedBy, timestamp: rec.timestamp });
    this.write("systems", metas);
    await idbPutModule(await sha256Hex(rec.source), rec.wasm);
  }
  async removeSystem(id: string): Promise<void> { this.write("systems", this.read<unknown[]>("systems", []).filter((m) => (m as { id: string }).id !== id)); }
  async saveWorld(json: string): Promise<void> { this.write("world", json); }
  async loadWorld(): Promise<string | null> { return this.read<string | null>("world", null); }
  async appendJournal(entry: Record<string, unknown>): Promise<void> { const j = this.read<Record<string, unknown>[]>("journal", []); j.push(entry); this.write("journal", j); }
  async loadJournal(): Promise<Record<string, unknown>[]> { return this.read<Record<string, unknown>[]>("journal", []); }
  async appendAiLog(line: string): Promise<void> { const j = this.read<string[]>("aiLog", []); j.push(line); this.write("aiLog", j); }
  async startFresh(): Promise<void> { for (const k of ["systems", "world", "journal", "aiLog"]) localStorage.removeItem(this.key + k); await idbClearModules(); }
}

/** Pick the storage backend: dev server when it answers, localStorage otherwise. */
export async function detectStorage(): Promise<SystemStorage> {
  try {
    const r = await fetch("/__systems", { method: "GET" });
    if (r.ok) {
      // A built copy may still serve a stale shell; require the JSON shape.
      const d = (await r.json()) as { systems?: unknown };
      if (Array.isArray(d.systems)) return new DevServerStorage();
    }
  } catch { /* not the dev server */ }
  return new LocalStorageStorage();
}
