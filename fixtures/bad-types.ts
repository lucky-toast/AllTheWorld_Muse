import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_types",
  why: "Broken fixture: calls a world method that does not exist.",
  buildsOn: [],
  contract: { claims: [], emits: {}, hooks: [] },
  onTick(w) { w.spawnAt(1, 2); },
  tests: [{ name: "nothing", ticks: 0, setup() {}, expect(_w: any, check: any) { check(true, "trivially passes"); } }],
});
