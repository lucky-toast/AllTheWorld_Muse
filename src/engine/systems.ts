// What a loaded system looks like to the engine (spec 5). Base systems are TypeScript
// objects; AI systems (Phase 3) are WebAssembly modules wrapped to the same shape.
// Both reach the world only through the `call` they are given, bound to their id.
import type { Manifest } from "./manifest";
import type { Request, Response } from "./host";

/** host.call bound to one system id. */
export type HostCall = (request: Request) => Response;

/** The handlers a system module may export (spec 5.2). All optional except as the manifest requires. */
export interface SystemModule {
  /** The player pressed E and this system owns the highlighted action. `target` is the faced entity, 0 for a tile, or the held id. */
  perform?(verb: string, target: number, held: number): void;
  /** An event in `reactions` fired. `payload` is JSON; entity fields arrive as { id, type, pos }. */
  onEvent?(name: string, payload: string): void;
  onTick?(): void;
  /** A `timer` or `anim` callback fired. */
  onTimer?(name: string): void;
  /** A key while this system holds borrow focus: key is up/down/left/right/e/q (or "escape" when focus is taken back). */
  onInput?(key: string, kind: string): void;
  onTween?(id: number, value: number): void;
  /** Once, when the system loads into a world. Must be safe to run again. */
  migrate?(): void;
  /** `test_<name>` and `shot_<name>` exports. */
  [exportName: `test_${string}` | `shot_${string}`]: (() => void) | undefined;
}

/** A loadable system: its manifest plus a factory that creates a fresh module on every load. */
export interface SystemDef {
  manifest: unknown;
  /** Base systems are trusted TypeScript and may use the engine's reserved event prefixes. */
  base: boolean;
  /** Create the module. Called on every load and on Shift+R; module globals never survive it. */
  create(call: HostCall): SystemModule;
}

/** A system loaded into a host: validated, frozen manifest plus its live module. */
export interface LoadedSystem { id: string; manifest: Manifest; base: boolean; def: SystemDef; module: SystemModule }

/** The names of a module's `test_*` exports, without the prefix, in declaration order. */
export function testNames(module: SystemModule): string[] {
  return Object.keys(module).filter((k) => k.startsWith("test_") && typeof module[k as `test_${string}`] === "function").map((k) => k.slice(5));
}
