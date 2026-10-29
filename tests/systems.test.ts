import { describe, expect, it } from 'vitest';
import type { Entity } from '../src/engine/api';
import { createTestWorld, runSystemTest } from '../src/engine/test';
import { internals } from '../src/engine/world';
import { ALL_SYSTEMS } from '../src/systems/index';
import carry from '../src/systems/base/carry';
import movement from '../src/systems/base/movement';
import push from '../src/systems/base/push';
import use from '../src/systems/base/use';

// Every shipped system's own tests, each on a fresh world with only that
// system loaded. runSystemTest also fails on contract violations.
for (const def of ALL_SYSTEMS) {
  describe(`system: ${def.id}`, () => {
    for (const t of def.tests) {
      it(t.name, () => {
        const r = runSystemTest(def, t);
        expect(r.messages).toEqual([]);
        expect(r.ok).toBe(true);
      });
    }
    if (def.tests.length === 0) {
      it('has tests', () => expect(def.tests.length).toBeGreaterThan(0));
    }
  });
}

describe('base systems together', () => {
  it('loads in carry-before-use order', () => {
    expect(ALL_SYSTEMS.map((d) => d.id)).toEqual(['movement', 'carry', 'push', 'use', 'daynight']);
  });

  it('walking into a crate pushes it and steps forward', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    world.spawn('crate', { x: 7, y: 6 });
    sim.walk('right');
    expect(world.query('player')[0].pos).toEqual({ x: 7, y: 6 });
    expect(world.query('pushable')[0].pos).toEqual({ x: 8, y: 6 });
  });

  it('kicks up dust on push, pickup, and drop', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    world.spawn('crate', { x: 7, y: 6 });
    sim.walk('right'); // shoves the crate to (8,6)
    expect(
      internals(world).particles.some((p) => p.sprite === 'fx_grass' && p.x === 8 && p.y === 6),
    ).toBe(true);
    world.spawn('branch', { x: 8, y: 6 }); // in front of the player, who faces right
    sim.interact();
    expect(world.query('player')[0].has('held')).toBe(true);
    expect(
      internals(world).particles.some((p) => p.sprite === 'fx_spark' && p.x === 8 && p.y === 6),
    ).toBe(true);
    sim.face('down'); // front (7,7) is free; (8,6) still holds the crate
    sim.interact();
    expect(world.query('item')[0].pos).toEqual({ x: 7, y: 7 });
    expect(
      internals(world).particles.some((p) => p.sprite === 'fx_grass' && p.x === 7 && p.y === 7),
    ).toBe(true);
  });

  it('picks up, walks, and puts down', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    world.spawn('branch', { x: 6, y: 7 });
    sim.interact();
    expect(world.query('player')[0].has('held')).toBe(true);
    sim.walk('right');
    sim.face('down');
    sim.interact();
    expect(world.query('item')[0].pos).toEqual({ x: 7, y: 7 });
    expect(world.query('player')[0].has('held')).toBe(false);
  });

  it('hands a blocked placement to use, which emits entity.used', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    const seen: Array<{ entity: number; held: number | null }> = [];
    world.on('entity.used', (ev) => {
      const held = ev.held as Entity | null;
      seen.push({ entity: (ev.entity as Entity).id, held: held ? held.id : null });
    });
    const branch = sim.give('branch');
    const rock = world.spawn('test_block', { x: 6, y: 7 });
    const ev = sim.press('input.interact', {});
    expect(ev.handled).toBe(true); // use claimed it after carry passed
    expect(seen).toHaveLength(1);
    expect(seen[0].entity).toBe(rock.id);
    expect(seen[0].held).toBe(branch.id);
    expect(world.query('player')[0].get('held')).toEqual({ id: branch.id });
  });

  it('busy blocks every base input at once', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    world.spawn('test_item', { x: 6, y: 7 });
    world.spawn('test_pushable', { x: 7, y: 6 });
    const [p] = world.query('player');
    p.tag('busy');
    const fired = { moved: 0, picked: 0, used: 0, bumped: 0 };
    world.on('player.moved', () => void fired.moved++);
    world.on('item.picked', () => void fired.picked++);
    world.on('entity.used', () => void fired.used++);
    world.on('entity.bumped', () => void fired.bumped++);
    sim.face('up');
    sim.walk('right');
    sim.face('down');
    sim.interact();
    expect(p.pos).toEqual({ x: 6, y: 6 });
    expect(p.get('facing')).toBe('down');
    expect(fired).toEqual({ moved: 0, picked: 0, used: 0, bumped: 0 });
    expect(world.query('item')[0].pos).not.toBeNull();
    expect(world.query('pushable')[0].pos).toEqual({ x: 7, y: 6 });
  });

  it('keeps the clock and the player light across a Shift+R style reload', () => {
    const { world, sim } = createTestWorld(...ALL_SYSTEMS);
    sim.wait(100);
    const day = world.time.day;
    const hour = world.time.hour;
    for (const id of [...world.systems]) world.unloadSystem(id);
    for (const def of ALL_SYSTEMS) world.loadSystem(def);
    expect(world.time.day).toBe(day);
    expect(world.time.hour).toBe(hour);
    expect(world.query('player')[0].has('light')).toBe(true);
    sim.wait(10); // the clock still advances after the reload
    expect(world.time.hour).toBeGreaterThan(hour);
  });

  it('runs the clock alongside walking without interference', () => {
    const { world, sim } = createTestWorld(...ALL_SYSTEMS);
    const hour = world.time.hour;
    sim.walk('right');
    expect(world.query('player')[0].pos).toEqual({ x: 7, y: 6 });
    expect(world.time.hour).toBeGreaterThan(hour);
    expect(world.query('player')[0].has('light')).toBe(true);
  });

  it('keeps the held item across a Shift+R style reload', () => {
    const { world, sim } = createTestWorld(movement, carry, push, use);
    const branch = sim.give('branch');
    for (const id of [...world.systems]) world.unloadSystem(id);
    for (const def of [movement, carry, push, use]) world.loadSystem(def);
    expect(world.query('player')[0].get('held')).toEqual({ id: branch.id });
    sim.interact(); // placing still works after the reload
    expect(branch.pos).toEqual({ x: 6, y: 7 });
    expect(world.query('player')[0].has('held')).toBe(false);
  });
});
