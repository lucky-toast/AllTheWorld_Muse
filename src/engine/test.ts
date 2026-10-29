// Test harness: fresh seeded worlds, the walkable arena, and the system-test
// runner with check() semantics and contract enforcement.
import type { MapData } from '../world/map';
import type { EntityTypeDef, Sim, SystemDef, SystemTest, World } from './api';
import { createSim } from './sim';
import { createWorld, internals } from './world';

/** Fixed seed: every test world starts identical, every run. */
export const TEST_SEED = 20261028;

/** Test-only types, drawn with neutral catalog sprites, registered only in tests. */
export const TEST_TYPES: Record<string, EntityTypeDef> = {
  test_item: { sprite: 'stone', tags: ['item'] },
  test_block: { sprite: 'rock_gray_small', tags: ['solid'] },
  test_pushable: { sprite: 'crate', tags: ['pushable'] },
};

/** Empty walkable arena, so map changes can never break base tests. */
export function arenaMap(): MapData {
  const width = 12;
  const height = 12;
  return {
    width,
    height,
    tiles: new Array(width * height).fill('grass') as string[],
    spawns: [],
    playerStart: { x: 6, y: 6 },
  };
}

/** A fresh world from the fixed seed, with test types and optional systems. */
export function createTestWorld(...defs: SystemDef[]): { world: World; sim: Sim } {
  const world = createWorld({ seed: TEST_SEED, map: arenaMap(), extraTypes: TEST_TYPES });
  for (const def of defs) world.loadSystem(def);
  return { world, sim: createSim(world) };
}

/** Runs one system test: setup, ticks, and expect share one world and state. */
export function runSystemTest(
  def: SystemDef,
  test: SystemTest,
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  let checks = 0;
  const check = (condition: unknown, message: string): void => {
    checks++;
    if (!condition) messages.push(`check failed: ${message}`);
  };
  try {
    const { world, sim } = createTestWorld(def);
    const inner = internals(world);
    withState(world, def.id, () => test.setup?.(world, sim));
    for (let i = 0; i < test.ticks; i++) world.tick();
    withState(world, def.id, () => test.expect(world, check));
    for (const v of inner.violations) messages.push(v);
  } catch (err) {
    messages.push(err instanceof Error ? err.message : String(err));
  }
  if (checks === 0 && messages.length === 0) {
    messages.push(`test "${test.name}": no checks ran (expect must call check at least once)`);
  }
  return { ok: messages.length === 0, messages };
}

function withState(world: World, systemId: string, fn: () => void): void {
  internals(world).withStateContext(systemId, fn);
}
