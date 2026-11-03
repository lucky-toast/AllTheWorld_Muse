// {{SYSTEM_EXAMPLES}} (spec 13.3): the manifest and module pairs in src/ai/examples/ named in
// PROMPT_EXAMPLES, as a fenced json and a fenced ts block each. These are prompt text only:
// nothing here is ever compiled or loaded into the world.
const MANIFESTS = import.meta.glob("./examples/*/manifest.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const MODULES = import.meta.glob("./examples/*/module.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export interface Example { name: string; manifest: string; source: string }

export const EXAMPLES: Example[] = Object.keys(MANIFESTS).map((p) => {
  const name = /examples\/([^/]+)\//.exec(p)![1];
  return { name, manifest: MANIFESTS[p], source: MODULES[`./examples/${name}/module.ts`] ?? "" };
}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const eol = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/**
 * The examples the designer sees, by name, each about 10k to 14k characters of every prompt:
 * campfire (reacting to events, timers, anims, tweens, light), cottage (a building with a room in
 * its own area: doors, travel in and out, placing furniture, migrate that is safe to run again)
 * and fishing (a mini-game that takes the controls: focus, onInput, the overlay panel, a round kept
 * in saved state). chop stays on disk as a fixture.
 */
export const PROMPT_EXAMPLES: readonly string[] = ["campfire", "cottage", "fishing"];

export function examplesText(examples: Example[] = EXAMPLES.filter((e) => PROMPT_EXAMPLES.includes(e.name))): string {
  return examples.map((e) => "```json\n" + eol(e.manifest) + "\n```\n\n```ts\n" + eol(e.source) + "\n```").join("\n\n");
}
