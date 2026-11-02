// The registry (spec 6 and 8), rebuilt at load from every loaded manifest in load
// order: the interaction table, which systems react to each event, who owns each
// event, and the entity types and components systems declare.
import type { Interaction, Manifest, PayloadShape } from "./manifest";
import { ENGINE_OWNER } from "./types";

/** Events the engine itself emits (spec 8). Base systems declare theirs in their manifests. */
export const ENGINE_EVENTS: Record<string, PayloadShape> = {
  "player.traveled": { from: "string", to: "string", pos: "pos" },
  "interaction.performed": { verb: "string", target: "entity", held: "entity", owner: "string", pos: "pos" },
  "time.jumped": { from: "number", to: "number" },
  "system.loaded": { id: "string" },
  "system.unloaded": { id: "string", reason: "string" },
};

/** One row of the interaction table. `order` is the owner's load position (higher is newer); `index` its place in the manifest. */
export interface InteractionEntry extends Interaction { owner: string; order: number; index: number }

export class Registry {
  /** Loaded system ids in load order. */
  readonly order: string[] = [];
  readonly manifests = new Map<string, Manifest>();
  /** Every interaction, in load order. */
  readonly interactions: InteractionEntry[] = [];
  /** Event name -> systems that react to it, in load order. */
  readonly reactions = new Map<string, string[]>();
  /** Event name -> owning system (or the engine). */
  readonly eventOwner = new Map<string, string>();
  /** Event name -> declared payload shape. */
  readonly eventShape = new Map<string, PayloadShape>();

  constructor(manifests: Manifest[]) {
    for (const [name, shape] of Object.entries(ENGINE_EVENTS)) { this.eventOwner.set(name, ENGINE_OWNER); this.eventShape.set(name, shape); }
    manifests.forEach((m, order) => {
      this.order.push(m.id); this.manifests.set(m.id, m);
      m.interactions.forEach((it, index) => this.interactions.push({ ...it, owner: m.id, order, index }));
      for (const ev of m.reactions) { const list = this.reactions.get(ev) ?? []; if (!list.includes(m.id)) list.push(m.id); this.reactions.set(ev, list); }
      // A later system that lists an event (by replacing its owner) takes it over.
      for (const [ev, shape] of Object.entries(m.emits)) { if (this.eventOwner.get(ev) === ENGINE_OWNER) continue; this.eventOwner.set(ev, m.id); this.eventShape.set(ev, shape); }
    });
  }
  has(id: string) { return this.manifests.has(id); }
  /** Systems reacting to `event`, in load order. */
  reactors(event: string): string[] { return this.reactions.get(event) ?? []; }
  owns(system: string, event: string): boolean { return this.eventOwner.get(event) === system; }
}
