import { defineSystem } from "engine/define";
export default defineSystem({
  id: "bad_loop",
  why: "Broken fixture: enters an infinite loop on its 50th tick.",
  buildsOn: [],
  contract: { claims: [], emits: {}, hooks: [] },
  onTick(w: any) {
    const n = ((w.state as any).n ?? 0) + 1;
    (w.state as any).n = n;
    if (n >= 50) { for (;;) { /* never returns */ } }
  },
  tests: [{ name: "nothing", ticks: 0, setup() {}, expect(_w: any, check: any) { check(true, "trivially passes"); } }],
});
