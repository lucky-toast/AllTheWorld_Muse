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
 * The examples the designer sees, by name. Each is about 6k to 11k characters of every prompt, so
 * only campfire goes for now: it shows the most (timers, anims, emitted events, components, tests).
 */
export const PROMPT_EXAMPLES: readonly string[] = ["campfire"];

export function examplesText(examples: Example[] = EXAMPLES.filter((e) => PROMPT_EXAMPLES.includes(e.name))): string {
  return examples.map((e) => "```json\n" + eol(e.manifest) + "\n```\n\n```ts\n" + eol(e.source) + "\n```").join("\n\n");
}
