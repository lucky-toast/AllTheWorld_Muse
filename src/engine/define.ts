import type { SystemDef } from "./api";
/** Define a system module. Fill every field; contract/tests are checked by `npm test`. */
export function defineSystem(def: Partial<SystemDef> & { id: string; why: string }): SystemDef {
  return {
    buildsOn: [], contract: { claims: [], emits: {}, hooks: [] }, components: {}, entities: {},
    migrate() {}, onTick() {}, on: {}, tests: [], shots: [], ...def,
  } as SystemDef;
}
