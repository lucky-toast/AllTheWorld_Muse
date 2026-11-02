// Storage (spec 13.2), seen from the game. Two backends with one interface:
//
// - DevServerStore: the dev server's /__data endpoints (devserver/storage.ts), which keep
//   data/systems/<id>/{manifest.json, source.as, module.wasm, module.sha256}, data/systems.json,
//   data/world.json, data/journal.json and data/ai-log.jsonl.
// - LocalStore (built copies): manifests, source and order in localStorage; compiled modules in
//   IndexedDB keyed by the source's hash, compiled again from source when missing.
//
// No screenshots are stored anywhere.

/** One row of systems.json: load order, dependencies, succession and when it was saved. */
export interface IndexEntry { id: string; order: number; buildsOn: string[]; replacedBy: string | null; timestamp: string }
/** A stored system's files. `wasm` is null when the module is missing (it is compiled again). */
export interface SystemFiles { manifestJson: string; source: string; wasm: Uint8Array<ArrayBuffer> | null; sha256: string | null }

export interface Store {
  readonly kind: "dev" | "local";
  index(): Promise<IndexEntry[]>;
  read(id: string): Promise<SystemFiles>;
  /** Write one system's files and the whole new index. */
  save(entry: IndexEntry, files: { manifestJson: string; source: string; wasm: Uint8Array<ArrayBuffer> }, index: IndexEntry[]): Promise<void>;
  /** Remove one system's files and write the new index (without it). */
  remove(id: string, index: IndexEntry[]): Promise<void>;
  /** Keep a module compiled again at startup. */
  cacheModule(id: string, source: string, wasm: Uint8Array<ArrayBuffer>): Promise<void>;
  loadWorld(): Promise<string | null>;
  saveWorld(json: string): Promise<void>;
  /** Save the world while the page goes away (no waiting). */
  saveWorldOnExit(json: string): void;
  loadJournal(): Promise<unknown[]>;
  saveJournal(entries: unknown[]): Promise<void>;
  appendAiLog(line: string): Promise<void>;
  /** Start fresh: delete saved systems, world, journal and log. */
  clear(): Promise<void>;
}

/** Hex SHA-256 of bytes or text. */
export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class DevServerStore implements Store {
  readonly kind = "dev" as const;
  constructor(private fetchFn: FetchFn = (u, i) => fetch(u, i), private base = "/__data") {}
  private async req(method: string, path: string, body?: BodyInit, type = "application/json"): Promise<Response> {
    const r = await this.fetchFn(this.base + path, { method, body, headers: body !== undefined ? { "content-type": type } : undefined, cache: "no-store" });
    if (!r.ok && r.status !== 404) throw new Error(`${method} ${path}: ${r.status} ${await r.text().catch(() => "")}`);
    return r;
  }
  private async text(path: string): Promise<string | null> { const r = await this.req("GET", path); return r.status === 404 ? null : r.text(); }
  async index(): Promise<IndexEntry[]> { const t = await this.text("/systems.json"); return t ? (JSON.parse(t) as IndexEntry[]) : []; }
  async read(id: string): Promise<SystemFiles> {
    const dir = `/systems/${id}`;
    const [manifestJson, source, sha] = await Promise.all([this.text(`${dir}/manifest.json`), this.text(`${dir}/source.as`), this.text(`${dir}/module.sha256`)]);
    if (manifestJson === null || source === null) throw new Error(`the stored files of "${id}" are missing`);
    const w = await this.req("GET", `${dir}/module.wasm`);
    const wasm = w.status === 404 ? null : new Uint8Array(await w.arrayBuffer());
    return { manifestJson, source, wasm, sha256: sha === null ? null : sha.trim() };
  }
  async save(entry: IndexEntry, files: { manifestJson: string; source: string; wasm: Uint8Array<ArrayBuffer> }, index: IndexEntry[]) {
    const dir = `/systems/${entry.id}`;
    await this.req("PUT", `${dir}/manifest.json`, files.manifestJson);
    await this.req("PUT", `${dir}/source.as`, files.source, "text/plain");
    await this.req("PUT", `${dir}/module.wasm`, files.wasm, "application/wasm");
    await this.req("PUT", `${dir}/module.sha256`, await sha256Hex(files.wasm), "text/plain");
    await this.req("PUT", "/systems.json", JSON.stringify(index, null, 1));
  }
  async remove(id: string, index: IndexEntry[]) {
    await this.req("DELETE", `/systems/${id}`);
    await this.req("PUT", "/systems.json", JSON.stringify(index, null, 1));
  }
  async cacheModule(id: string, _source: string, wasm: Uint8Array<ArrayBuffer>) {
    await this.req("PUT", `/systems/${id}/module.wasm`, wasm, "application/wasm");
    await this.req("PUT", `/systems/${id}/module.sha256`, await sha256Hex(wasm), "text/plain");
  }
  loadWorld() { return this.text("/world.json"); }
  async saveWorld(json: string) { await this.req("PUT", "/world.json", json); }
  saveWorldOnExit(json: string) {
    const blob = new Blob([json], { type: "application/json" });
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.(this.base + "/world.json", blob)) return;
    void this.fetchFn(this.base + "/world.json", { method: "PUT", body: json, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  }
  async loadJournal() { const t = await this.text("/journal.json"); return t ? (JSON.parse(t) as unknown[]) : []; }
  async saveJournal(entries: unknown[]) { await this.req("PUT", "/journal.json", JSON.stringify(entries, null, 1)); }
  async appendAiLog(line: string) { await this.req("POST", "/ai-log.jsonl", line, "text/plain"); }
  async clear() { await this.req("POST", "/fresh"); }
}

/** Compiled modules for built copies, keyed by the source's hash. */
export interface ModuleCache {
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  put(key: string, wasm: Uint8Array<ArrayBuffer>): Promise<void>;
  clear(): Promise<void>;
}

/** The IndexedDB module cache (database "atw", store "modules"). */
export class IdbModuleCache implements ModuleCache {
  static readonly DB = "atw";
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((res, rej) => {
      const r = indexedDB.open(IdbModuleCache.DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("modules"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this.db;
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((res, rej) => { const q = fn(db.transaction("modules", mode).objectStore("modules")); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async get(key: string) { try { const v = await this.tx("readonly", (s) => s.get(key)); return v ? new Uint8Array(v as ArrayBuffer) : null; } catch { return null; } }
  async put(key: string, wasm: Uint8Array<ArrayBuffer>) { await this.tx("readwrite", (s) => s.put(wasm.slice().buffer, key)); }
  async clear() {
    if (this.db) { (await this.db).close(); this.db = null; }
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(IdbModuleCache.DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
}

interface LocalRow extends IndexEntry { manifestJson: string; source: string }
const LS = { systems: "atw.systems", world: "atw.world", journal: "atw.journal", aiLog: "atw.aiLog" };

export class LocalStore implements Store {
  readonly kind = "local" as const;
  constructor(private ls: Pick<Storage, "getItem" | "setItem" | "removeItem">, private cache: ModuleCache) {}
  private rows(): LocalRow[] { try { return JSON.parse(this.ls.getItem(LS.systems) ?? "[]") as LocalRow[]; } catch { return []; } }
  private set(key: string, v: string) { this.ls.setItem(key, v); }
  async index(): Promise<IndexEntry[]> { return this.rows().map(({ manifestJson: _m, source: _s, ...e }) => e); }
  async read(id: string): Promise<SystemFiles> {
    const row = this.rows().find((r) => r.id === id); if (!row) throw new Error(`"${id}" isn't stored`);
    const key = await sha256Hex(row.source);
    return { manifestJson: row.manifestJson, source: row.source, wasm: await this.cache.get(key), sha256: null };
  }
  async save(entry: IndexEntry, files: { manifestJson: string; source: string; wasm: Uint8Array<ArrayBuffer> }, index: IndexEntry[]) {
    const old = new Map(this.rows().map((r) => [r.id, r]));
    old.set(entry.id, { ...entry, manifestJson: files.manifestJson, source: files.source });
    this.set(LS.systems, JSON.stringify(index.map((e) => ({ ...old.get(e.id)!, ...e }))));
    await this.cache.put(await sha256Hex(files.source), files.wasm);
  }
  async remove(id: string, index: IndexEntry[]) {
    const old = new Map(this.rows().map((r) => [r.id, r]));
    this.set(LS.systems, JSON.stringify(index.filter((e) => e.id !== id && old.has(e.id)).map((e) => ({ ...old.get(e.id)!, ...e }))));
  }
  async cacheModule(_id: string, source: string, wasm: Uint8Array<ArrayBuffer>) { await this.cache.put(await sha256Hex(source), wasm); }
  async loadWorld() { return this.ls.getItem(LS.world); }
  async saveWorld(json: string) { this.set(LS.world, json); }
  saveWorldOnExit(json: string) { try { this.set(LS.world, json); } catch { /* storage full or blocked */ } }
  async loadJournal() { try { return JSON.parse(this.ls.getItem(LS.journal) ?? "[]") as unknown[]; } catch { return []; } }
  async saveJournal(entries: unknown[]) { this.set(LS.journal, JSON.stringify(entries)); }
  async appendAiLog(line: string) { this.set(LS.aiLog, (this.ls.getItem(LS.aiLog) ?? "") + line + "\n"); }
  async clear() { for (const k of Object.values(LS)) this.ls.removeItem(k); await this.cache.clear(); }
}

/** The dev server's storage when it answers, otherwise localStorage and IndexedDB. */
export async function detectStore(): Promise<Store> {
  try {
    const r = await fetch("/__data/systems.json", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) return new DevServerStore();
  } catch { /* no dev server */ }
  return new LocalStore(localStorage, new IdbModuleCache());
}
