import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_sprite",
  why: "Broken fixture: declares a sprite that is not in the catalog.",
  buildsOn: [],
  contract: { claims: [], emits: {}, hooks: [] },
  entities: { dragon: { sprite: "dragon_huge", tags: ["solid"] } },
  tests: [{ name: "nothing", ticks: 0, setup() {}, expect(_w: any, check: any) { check(true, "trivially passes"); } }],
});
