// Test helpers: test-only systems and arenas.
import { Host, type Request } from "../src/engine/host";
import type { SystemDef, SystemModule } from "../src/engine/systems";
import { Api } from "../src/systems/base/api";
import { BASE_SYSTEMS } from "../src/systems/base";
import { buildArena } from "../src/world/map";

/** A test-only AI-style system: its manifest plus a module built over its own Api. */
export function testSystem(manifest: Record<string, unknown> & { id: string }, make: (w: Api) => SystemModule = () => ({})): SystemDef {
  return { base: false, manifest: { why: "Test-only system.", ...manifest }, create: (call) => make(new Api(call)) };
}

/** A 12x12 arena host with `before` loaded first, then the base systems (unless `base` is false), then `after`. */
export function arena(opts: { before?: SystemDef[]; after?: SystemDef[]; base?: boolean } = {}) {
  const host = new Host(buildArena());
  for (const d of [...(opts.before ?? []), ...(opts.base === false ? [] : BASE_SYSTEMS), ...(opts.after ?? [])]) host.load(d);
  host.interactions.refresh(true);
  const eng = host.eng;
  const player = eng.player()!;
  const call = (system: string, req: Record<string, unknown>) => host.call(system, req as Request);
  const ticks = (n: number) => { for (let i = 0; i < n; i++) host.tick(); };
  /** Press and release a key, handled on the next tick. */
  const tap = (key: Parameters<Host["controls"]["press"]>[0]) => { host.controls.press(key); host.controls.release(key); host.tick(); };
  const labels = () => host.interactions.matches.map((m) => `${m.entry.owner}:${m.entry.label}`);
  return { host, eng, player, call, ticks, tap, labels };
}
