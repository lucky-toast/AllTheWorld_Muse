// Registry built at load from every manifest (spec 5, 6, 8). Load order is kept.
import type { InteractionDef, Manifest, PayloadKind } from "./manifest";

export interface SystemHandlers {
  perform?: (verb: string, target: number, held: number) => void;
  onEvent?: (name: string, payload: string) => void;
  onTick?: () => void;
  onTimer?: (name: string) => void;
  onInput?: (key: string, kind: string) => void;
  onTween?: (id: number, value: number) => void;
  migrate?: () => void;
}
export interface LoadedSystem extends SystemHandlers {
  manifest: Manifest;
  isBase?: boolean;
  tests?: { name: string; run: () => void }[];
}
export interface InteractionEntry extends InteractionDef { owner: string; loadIndex: number }

export const BASE_EVENT_PREFIXES = ["player.", "item.", "entity.", "interaction.", "time.", "system."];
export const BASE_EVENTS: Record<string, Record<string, PayloadKind>> = {
  "player.moved": { from: "pos", to: "pos", dir: "string" },
  "player.blocked": { dir: "string", target: "pos" },
  "item.picked": { item: "entity" },
  "item.dropped": { item: "entity", pos: "pos" },
  "entity.bumped": { entity: "entity", dir: "string" },
  "time.phase": { phase: "string", previous: "string", day: "number" },
  "time.dawn": { phase: "string", previous: "string", day: "number" },
  "time.daytime": { phase: "string", previous: "string", day: "number" },
  "time.dusk": { phase: "string", previous: "string", day: "number" },
  "time.night": { phase: "string", previous: "string", day: "number" },
  "time.newDay": { day: "number" },
  "time.hour": { hour: "number", day: "number" },
  "time.jumped": { from: "number", to: "number" },
  "player.traveled": { from: "string", to: "string", pos: "pos" },
  "interaction.performed": { verb: "string", target: "entity", held: "entity", owner: "string", pos: "pos" },
  "system.loaded": { id: "string" },
  "system.unloaded": { id: "string", reason: "string" },
};

export class Registry {
  systems: LoadedSystem[] = [];
  interactions: InteractionEntry[] = [];
  reactions = new Map<string, string[]>();
  eventOwner = new Map<string, string>();
  eventShapes = new Map<string, Record<string, PayloadKind>>();
  entityTypes = new Map<string, { sprite: string; tags: string[]; owner: string }>();
  loadOrder: string[] = [];

  constructor() { this.reset(); }
  reset(): void {
    this.systems = []; this.interactions = []; this.reactions.clear();
    this.eventOwner.clear(); this.eventShapes.clear(); this.entityTypes.clear(); this.loadOrder = [];
    for (const [name, shape] of Object.entries(BASE_EVENTS)) { this.eventOwner.set(name, "(engine)"); this.eventShapes.set(name, shape); }
  }
  rebuild(systems: LoadedSystem[]): void {
    this.reset();
    for (const s of systems) this.add(s);
  }
  add(system: LoadedSystem): void {
    const m = system.manifest;
    const idx = this.systems.length;
    this.systems.push(system); this.loadOrder.push(m.id);
    for (const [name, def] of Object.entries(m.entities)) this.entityTypes.set(name, { ...def, tags: [...def.tags], owner: m.id });
    for (const ix of m.interactions) this.interactions.push({ ...ix, owner: m.id, loadIndex: idx });
    for (const ev of m.reactions) {
      if (!this.reactions.has(ev)) this.reactions.set(ev, []);
      this.reactions.get(ev)!.push(m.id);
    }
    for (const [name, shape] of Object.entries(m.emits)) { this.eventOwner.set(name, m.id); this.eventShapes.set(name, { ...shape }); }
  }
  remove(id: string): void { this.rebuild(this.systems.filter((s) => s.manifest.id !== id)); }
  byId(id: string): LoadedSystem | undefined { return this.systems.find((s) => s.manifest.id === id); }
  reactorsTo(name: string): LoadedSystem[] {
    const ids = this.reactions.get(name) ?? [];
    return ids.map((id) => this.byId(id)).filter((s): s is LoadedSystem => !!s && !!s.onEvent);
  }
  ownsEvent(systemId: string, name: string): boolean {
    if (systemId === "(engine)") return true;
    if (this.eventOwner.get(name) === systemId) return true;
    // Engine and base systems own the base prefixes (spec 8).
    const sys = this.byId(systemId);
    if (sys?.isBase && BASE_EVENT_PREFIXES.some((p) => name.startsWith(p))) return true;
    return false;
  }
}
