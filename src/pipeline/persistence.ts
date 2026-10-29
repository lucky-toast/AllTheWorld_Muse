// Saving accepted systems. With a dev server, sources live in
// data/systems/<id>.ts + data/systems.json via the /__systems endpoint.
// Without one (built/deployed copy), localStorage is used instead.
export interface SavedSystem { id: string; source: string; buildsOn: string[]; order: number; timestamp: string }

const LS_SYSTEMS = "atw.systems";
const LS_WORLD = "atw.world";

function lsSaved(): SavedSystem[] { try { return JSON.parse(localStorage.getItem(LS_SYSTEMS) ?? "[]"); } catch { return []; } }
function lsStore(systems: SavedSystem[]) { try { localStorage.setItem(LS_SYSTEMS, JSON.stringify(systems)); } catch { /* private mode */ } }

export async function loadSavedSystems(): Promise<SavedSystem[]> {
  try {
    const r = await fetch("/__systems", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const data = (await r.json()) as { systems: SavedSystem[] };
      if (Array.isArray(data.systems)) { lsStore(data.systems); return [...data.systems].sort((a, b) => a.order - b.order); }
    }
  } catch { /* no dev server */ }
  return lsSaved().sort((a, b) => a.order - b.order);
}

export async function loadSavedWorld(): Promise<string | null> {
  try {
    const r = await fetch("/__systems", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      const data = (await r.json()) as { world: string | null };
      if (data.world) return data.world;
    }
  } catch { /* no dev server */ }
  try { return localStorage.getItem(LS_WORLD); } catch { return null; }
}

export async function saveSystem(sys: SavedSystem): Promise<void> {
  const all = lsSaved().filter((s) => s.id !== sys.id); all.push(sys); all.forEach((s, i) => (s.order = i)); lsStore(all);
  try { await fetch("/__systems/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sys) }); } catch { /* localStorage already saved */ }
}

export async function saveWorld(world: string): Promise<void> {
  try { localStorage.setItem(LS_WORLD, world); } catch { /* ignore */ }
  try { await fetch("/__systems/world", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ world }) }); } catch { /* ignore */ }
}

/** Start fresh: delete saved systems and the saved world. Caller reloads the page. */
export async function startFresh(): Promise<void> {
  try { localStorage.removeItem(LS_SYSTEMS); localStorage.removeItem(LS_WORLD); } catch { /* ignore */ }
  try { await fetch("/__systems/fresh", { method: "POST" }); } catch { /* ignore */ }
}
