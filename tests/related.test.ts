// Which loaded systems' tests the Tests stage re-runs for a new system (src/pipeline/related.ts).
import { validateManifest, type Manifest } from "../src/engine/manifest";
import { namesOf, relatedSystems, withoutTests } from "../src/pipeline/related";

const sys = (m: Record<string, unknown>, source: string | null = "") => {
  const v = validateManifest({ why: "x", ...m });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return { manifest: v.manifest as Manifest, source };
};

const pond = sys({ id: "pond", entities: { pond: { sprite: "pond", tags: ["solid"] }, pond_reed: { sprite: "reeds", tags: [] } }, emits: { "pond.ripple": { pond: "entity" } } },
  `export function migrate(): void { spawn("pond", 1, 1); }\nexport function test_a(): void { simGive("branch"); }`);
const crate = sys({ id: "crate_carry", buildsOn: ["carry"] }, `export function migrate(): void { tag(query("crate")[0], "item"); }`);
const reeds = sys({ id: "reed_tug", interactions: [{ verb: "tug", label: "Tug", target: "pond_reed" }] }, `export function perform(v: string, t: i32, h: i32): void {}`);

test("a system that shares nothing with a loaded one skips that one's tests", () => {
  expect(relatedSystems(crate, [pond])).toEqual({ related: [], skipped: ["pond"] });
});

test("sharing a name, building on it, or replacing what it builds on makes two systems related", () => {
  expect(relatedSystems(reeds, [pond]).related).toEqual([{ id: "pond", why: "shares pond_reed" }]);
  const fishing = sys({ id: "fishing", buildsOn: ["pond"] });
  expect(relatedSystems(fishing, [pond]).related).toEqual([{ id: "pond", why: "fishing builds on it" }]);
  const pond2 = sys({ id: "pond_v2", replaces: ["pond"] });
  expect(relatedSystems(pond2, [fishing]).related).toEqual([{ id: "fishing", why: "it builds on pond, which pond_v2 replaces" }]);
});

test("a loaded system whose source isn't known is always re-run", () => {
  expect(relatedSystems(crate, [{ ...pond, source: null }]).related).toEqual([{ id: "pond", why: "its source isn't known" }]);
});

test("the new system's own tests don't link it; the loaded system's tests do", () => {
  // pond's test uses a branch, so a new system that changes branches re-runs pond's tests...
  const burner = sys({ id: "burner" }, `export function onTick(): void { query("branch"); }`);
  expect(relatedSystems(burner, [pond]).related).toEqual([{ id: "pond", why: "shares branch" }]);
  // ...but a new system that only uses a branch in its own test doesn't.
  const prop = sys({ id: "prop" }, `export function test_x(): void { simGive("branch"); if (true) { check(true, "ok"); } }`);
  expect(relatedSystems(prop, [pond]).skipped).toEqual(["pond"]);
  expect(withoutTests(`a("x");\nexport function test_y(): void { if (1) { b("y"); } }\nc("z");`)).toBe(`a("x");\n\nc("z");`);
  expect(namesOf(pond)).toEqual(new Set(["pond", "pond_reed", "pond.ripple", "branch"]));
});
