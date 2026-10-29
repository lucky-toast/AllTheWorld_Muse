import { describe, expect, it } from 'vitest';
import type { Dir } from '../src/engine/api';
import { defineSystem } from '../src/engine/define';
import { Input, type Clock } from '../src/engine/input';
import { createSim } from '../src/engine/sim';
import { arenaMap, createTestWorld, runSystemTest, TEST_SEED } from '../src/engine/test';
import { TAP_TURN_MS, STEPS_PER_SECOND } from '../src/tuning';
import { createWorld, internals } from '../src/engine/world';
import { formatClock } from '../src/engine/render';
import { placeholderMap } from '../src/world/map';

const STEP_MS = 1000 / STEPS_PER_SECOND;

// A controllable clock for input tests: advance(ms) fires due timers in order.
function fakeClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  let id = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      const h = ++id;
      timeouts.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h) => {
      timeouts.delete(h as number);
    },
    setInterval: (fn, ms) => {
      const h = ++id;
      intervals.set(h, { every: ms, next: now + ms, fn });
      return h;
    },
    clearInterval: (h) => {
      intervals.delete(h as number);
    },
  };
  function advance(ms: number): void {
    const end = now + ms;
    for (let guard = 0; guard < 10000; guard++) {
      let best: { oneShot: boolean; h: number; at: number } | null = null;
      for (const [h, t] of timeouts) {
        if (t.at <= end && (!best || t.at < best.at)) best = { oneShot: true, h, at: t.at };
      }
      for (const [h, t] of intervals) {
        if (t.next <= end && (!best || t.next < best.at)) best = { oneShot: false, h, at: t.next };
      }
      if (!best) break;
      now = best.at;
      if (best.oneShot) {
        const t = timeouts.get(best.h)!;
        timeouts.delete(best.h);
        t.fn();
      } else {
        const t = intervals.get(best.h);
        if (!t) continue;
        t.next += t.every;
        t.fn();
      }
    }
    now = end;
  }
  return { clock, advance };
}

describe('world boot', () => {
  it('boots an arena with the player at the center, facing down', () => {
    const { world } = createTestWorld();
    expect(world.tiles.get(0, 0)).toBe('grass');
    const [player] = world.query('player');
    expect(player.pos).toEqual({ x: 6, y: 6 });
    expect(player.get('facing')).toBe('down');
    expect(player.has('player')).toBe(true);
  });

  it('gives a fresh world from the fixed seed every time', () => {
    const a = createTestWorld().world;
    const b = createTestWorld().world;
    const seqA = [a.rand(), a.rand(), a.rand()];
    const seqB = [b.rand(), b.rand(), b.rand()];
    expect(seqA).toEqual(seqB);
    expect(TEST_SEED).toBe(20261028);
  });
});

describe('spawn + types', () => {
  it('throws a clear error on an unregistered type', () => {
    const { world } = createTestWorld();
    expect(() => world.spawn('dragon', { x: 1, y: 1 })).toThrow('unknown entity type "dragon"');
  });

  it('tells sprite ids apart from entity types', () => {
    const { world } = createTestWorld();
    expect(() => world.spawn('grass', { x: 1, y: 1 })).toThrow(
      'that is a catalog sprite id, not an entity type',
    );
  });

  it('spawns test-only types on test worlds', () => {
    const { world } = createTestWorld();
    expect(world.spawn('test_item', { x: 1, y: 1 }).has('item')).toBe(true);
    expect(world.spawn('test_block', { x: 2, y: 1 }).has('solid')).toBe(true);
    expect(world.spawn('test_pushable', { x: 3, y: 1 }).has('pushable')).toBe(true);
  });

  it('refuses out-of-bounds spawns', () => {
    const { world } = createTestWorld();
    expect(() => world.spawn('test_block', { x: 99, y: 99 })).toThrow('out of bounds');
  });
});

describe('occupancy + at() + isFree', () => {
  it('covers every tile of a multi-tile footprint', () => {
    const { world } = createTestWorld();
    world.spawn('log_fallen', { x: 5, y: 5 }); // 1x2: pos plus the tile above
    expect(world.at(5, 5).map((e) => e.type)).toContain('log_fallen');
    expect(world.at(5, 4).map((e) => e.type)).toContain('log_fallen');
    expect(world.at(5, 3)).toEqual([]);
    expect(world.at(6, 5)).toEqual([]);
  });

  it('re-indexes when entities move or change sprite', () => {
    const { world } = createTestWorld();
    const log = world.spawn('log_fallen', { x: 5, y: 5 });
    log.moveTo(2, 2, { instant: true });
    expect(world.at(5, 5)).toEqual([]);
    expect(world.at(2, 2).map((e) => e.type)).toContain('log_fallen');
    expect(world.at(2, 1).map((e) => e.type)).toContain('log_fallen');
  });

  it('blocks on player/solid/pushable/item but not decor', () => {
    const { world } = createTestWorld();
    const [player] = world.query('player');
    expect(world.isFree(6, 6)).toBe(false); // the player stands there
    expect(world.isFree(6, 6, player)).toBe(true); // ...but not for themselves
    world.spawn('test_block', { x: 1, y: 1 });
    world.spawn('test_item', { x: 2, y: 1 });
    world.spawn('test_pushable', { x: 3, y: 1 });
    world.spawn('bush', { x: 4, y: 1 });
    expect(world.isFree(1, 1)).toBe(false);
    expect(world.isFree(2, 1)).toBe(false);
    expect(world.isFree(3, 1)).toBe(false);
    expect(world.isFree(4, 1)).toBe(true); // decorations never block
    expect(world.isFree(5, 5)).toBe(true);
  });

  it('blocks the map edge and water', () => {
    const { world } = createTestWorld();
    expect(world.isFree(-1, 5)).toBe(false);
    expect(world.isFree(5, -1)).toBe(false);
    expect(world.isFree(12, 5)).toBe(false);
    world.tiles.set(5, 5, 'stream_h');
    expect(world.isFree(5, 5)).toBe(false);
  });

  it('requires both tiles of a log to be free', () => {
    const { world } = createTestWorld();
    world.spawn('log_fallen', { x: 5, y: 5 });
    expect(world.isFree(5, 5)).toBe(false);
    expect(world.isFree(5, 4)).toBe(false);
  });
});

describe('entity handles', () => {
  it('reads tags and components through one namespace', () => {
    const { world } = createTestWorld();
    const e = world.spawn('test_item', { x: 1, y: 1 });
    expect(e.has('item')).toBe(true);
    expect(e.has('sprite')).toBe(true);
    expect(e.has('nope')).toBe(false);
    e.tag('hot');
    expect(e.has('hot')).toBe(true);
    e.untag('hot');
    expect(e.has('hot')).toBe(false);
    e.set('count', 3);
    expect(e.get('count')).toBe(3);
    expect(() => e.add('count', 4)).toThrow('already has "count"');
    e.add('fresh', 1);
    expect(e.get('fresh')).toBe(1);
    e.remove('fresh');
    expect(e.has('fresh')).toBe(false);
  });

  it('copies pos so systems cannot desync occupancy', () => {
    const { world } = createTestWorld();
    const e = world.spawn('test_item', { x: 1, y: 1 });
    e.pos!.x = 99;
    expect(e.pos).toEqual({ x: 1, y: 1 });
    expect(world.at(1, 1)).toContain(e);
  });

  it('lifts, places, and destroys', () => {
    const { world } = createTestWorld();
    const e = world.spawn('test_item', { x: 1, y: 1 });
    e.lift();
    expect(e.pos).toBeNull();
    expect(world.at(1, 1)).toEqual([]);
    expect(() => e.moveTo(2, 2)).toThrow('use place(), not moveTo()');
    e.place(2, 2);
    expect(e.pos).toEqual({ x: 2, y: 2 });
    expect(() => e.place(3, 3)).toThrow('already on the map');
    e.destroy();
    expect(world.at(2, 2)).toEqual([]);
    expect(() => e.moveTo(1, 1)).toThrow('was destroyed');
  });

  it('validates sprite changes against the catalog', () => {
    const { world } = createTestWorld();
    const e = world.spawn('test_item', { x: 1, y: 1 });
    expect(() => e.set('sprite', { id: 'nope' })).toThrow('unknown sprite "nope"');
    expect(() => e.set('sprite', { id: 7 })).toThrow('need { id: catalogId }');
  });

  it('slides by default and teleports with instant', () => {
    const { world } = createTestWorld();
    const e = world.spawn('test_item', { x: 1, y: 1 });
    e.moveTo(2, 2);
    expect(internals(world).slides.get(e.id)).toMatchObject({ fx: 1, fy: 1 });
    e.moveTo(3, 3, { instant: true });
    expect(internals(world).slides.has(e.id)).toBe(false);
  });
});

describe('events + handled', () => {
  it('puts payload fields directly on the event', () => {
    const { world } = createTestWorld();
    let seen: string | null = null;
    world.on('ping', (ev) => {
      seen = `${ev.name}:${String(ev.dir)}`;
    });
    world.emit('ping', { dir: 'up' });
    expect(seen).toBe('ping:up');
  });

  it('runs handlers in load order', () => {
    const { world } = createTestWorld();
    const calls: string[] = [];
    const mk = (id: string) =>
      defineSystem({ id, on: { 'input.move': () => void calls.push(id) } });
    world.loadSystem(mk('a'));
    world.loadSystem(mk('b'));
    world.emit('input.move', { dir: 'up' });
    expect(calls).toEqual(['a', 'b']);
  });

  it('lets a second handler see handled and do nothing once the first acts', () => {
    const { world } = createTestWorld();
    const acted: string[] = [];
    const mk = (id: string, act: boolean) =>
      defineSystem({
        id,
        contract: { claims: ['input.move: test'], emits: {}, hooks: [] },
        on: {
          'input.move': (ev) => {
            if (ev.handled) return;
            if (act) {
              acted.push(id);
              ev.handled = true;
            }
          },
        },
      });
    world.loadSystem(mk('first', true));
    world.loadSystem(mk('second', true));
    const ev = world.emit('input.move', { dir: 'up' });
    expect(ev.handled).toBe(true);
    expect(acted).toEqual(['first']);
    expect(internals(world).violations).toEqual([]);
  });
});

describe('contract enforcement', () => {
  it('fails systems that emit undeclared events', () => {
    const def = defineSystem({
      id: 'loud',
      on: { 'input.move': (_ev, w) => void w.emit('sneaky.event', {}) },
    });
    const { world } = createTestWorld(def);
    world.emit('input.move', { dir: 'up' });
    expect(internals(world).violations).toEqual([
      'system "loud" emitted undeclared event "sneaky.event".',
    ]);
  });

  it('allows declared events', () => {
    const def = defineSystem({
      id: 'polite',
      contract: { claims: [], emits: { 'hello.there': { payload: '{}', when: 'always' } }, hooks: [] },
      on: { 'input.move': (_ev, w) => void w.emit('hello.there', {}) },
    });
    const { world } = createTestWorld(def);
    world.emit('input.move', { dir: 'up' });
    expect(internals(world).violations).toEqual([]);
  });

  it('fails systems that set handled on unclaimed inputs', () => {
    const def = defineSystem({
      id: 'grabby',
      on: { 'input.move': (ev) => void (ev.handled = true) },
    });
    const { world } = createTestWorld(def);
    world.emit('input.move', { dir: 'up' });
    expect(internals(world).violations).toEqual([
      'system "grabby" set handled on unclaimed input "input.move".',
    ]);
  });

  it('fails systems that re-emit inputs', () => {
    const def = defineSystem({
      id: 'echo',
      contract: { claims: ['input.move: test'], emits: {}, hooks: [] },
      on: { 'input.interact': (_ev, w) => void w.emit('input.move', { dir: 'up' }) },
    });
    const { world } = createTestWorld(def);
    world.emit('input.interact', {});
    expect(internals(world).violations.join('\n')).toMatch('must never re-emit inputs');
  });

  it('exempts engine emissions (time.set from a test)', () => {
    const { world } = createTestWorld();
    world.time.set('night');
    expect(internals(world).violations).toEqual([]);
  });
});

describe('system loader', () => {
  it('rejects double loads and unknown unloads', () => {
    const { world } = createTestWorld();
    const def = defineSystem({ id: 'solo' });
    world.loadSystem(def);
    expect(() => world.loadSystem(def)).toThrow('already loaded');
    expect(() => world.unloadSystem('ghost')).toThrow('is not loaded');
  });

  it('reloads without losing state, order, or duplicating handlers', () => {
    const { world } = createTestWorld();
    let migrates = 0;
    let ticks = 0;
    const mk = (id: string) =>
      defineSystem({
        id,
        migrate: (w) => {
          migrates++;
          w.state.count = ((w.state.count as number | undefined) ?? 0) + 1;
        },
        onTick: () => void ticks++,
        on: { 'input.move': () => void ticks++ },
      });
    world.loadSystem(mk('a'));
    world.loadSystem(mk('b'));
    world.tick();
    world.emit('input.move', { dir: 'up' });
    expect(migrates).toBe(2);
    // Shift+R: unload all, reload all in the same order.
    const ids = [...world.systems];
    const defs = [defineSystem({ id: 'a' }), defineSystem({ id: 'b' })];
    for (const id of ids) world.unloadSystem(id);
    expect(world.systems).toEqual([]);
    world.loadSystem(mk('a'));
    world.loadSystem(mk('b'));
    void defs;
    expect(world.systems).toEqual(['a', 'b']);
    world.tick();
    world.emit('input.move', { dir: 'up' });
    expect(ticks).toBe(8); // 2 systems x (1 tick + 1 event) x 2 rounds: no duplicates
  });

  it('keeps per-system state separate', () => {
    const { world } = createTestWorld();
    const mk = (id: string, v: number) =>
      defineSystem({ id, migrate: (w) => void (w.state.v = v) });
    world.loadSystem(mk('a', 1));
    world.loadSystem(mk('b', 2));
    expect(internals(world).withStateContext('a', () => world.state.v)).toBe(1);
    expect(internals(world).withStateContext('b', () => world.state.v)).toBe(2);
    expect(() => world.state).toThrow('only available while a system runs');
  });

  it('registers system entity types and rejects bad art', () => {
    const { world } = createTestWorld();
    expect(() =>
      world.loadSystem(defineSystem({ id: 'bad', entities: { wisp: { sprite: 'nope', tags: [] } } })),
    ).toThrow('unknown sprite "nope"');
    world.loadSystem(defineSystem({ id: 'good', entities: { wisp: { sprite: 'stone', tags: ['item'] } } }));
    expect(world.spawn('wisp', { x: 1, y: 1 }).has('item')).toBe(true);
  });
});

describe('serialize + snapshot', () => {
  it('round-trips entities, tiles, clock, rng, and system state', () => {
    const { world } = createTestWorld(
      defineSystem({ id: 'keeper', migrate: (w) => void (w.state.gold = 7) }),
    );
    world.spawn('test_item', { x: 1, y: 1 });
    world.tiles.set(2, 2, 'stream_h');
    world.time.set(15.5);
    world.tick();
    world.tick();
    const snap = world.snapshot();
    const before = world.rand();
    // Wreck everything, then restore.
    world.spawn('test_block', { x: 3, y: 3 });
    world.time.set('night');
    world.restore(snap);
    expect(world.at(1, 1).map((e) => e.type)).toContain('test_item');
    expect(world.at(3, 3)).toEqual([]);
    expect(world.tiles.get(2, 2)).toBe('stream_h');
    expect(world.time.hour).toBeCloseTo(15.5, 9);
    expect(world.ticks).toBe(2);
    expect(world.serialize()).toBe(snap); // byte-identical second save
    expect(internals(world).withStateContext('keeper', () => world.state.gold)).toBe(7);
    expect(world.rand()).toBe(before); // rng stream resumes exactly
  });

  it('refuses unknown versions and missing types', () => {
    const { world } = createTestWorld();
    expect(() => world.deserialize('{"v":99}')).toThrow('version 99');
    const snap = JSON.parse(world.snapshot()) as any;
    snap.entities.push({ id: 50, type: 'dragon', pos: { x: 1, y: 1 }, tags: [], comps: {} });
    expect(() => world.deserialize(JSON.stringify(snap))).toThrow('"dragon" is not registered');
  });
});

describe('clock', () => {
  it('derives phases from the hour', () => {
    const { world } = createTestWorld();
    const cases: Array<[number, string]> = [
      [5, 'dawn'],
      [6.9, 'dawn'],
      [7, 'day'],
      [12, 'day'],
      [17.9, 'day'],
      [18, 'dusk'],
      [19.9, 'dusk'],
      [20, 'night'],
      [0, 'night'],
      [4.9, 'night'],
    ];
    for (const [hour, phase] of cases) {
      world.time.set(hour);
      expect(world.time.phase).toBe(phase);
    }
  });

  it('jumps by phase name and overflows hours into days', () => {
    const { world } = createTestWorld();
    world.time.set('dusk');
    expect(world.time.phase).toBe('dusk');
    world.time.set(25);
    expect(world.time.day).toBe(2);
    expect(world.time.hour).toBeCloseTo(1, 9);
    expect(() => world.time.set('eclipse' as never)).toThrow('unknown phase');
  });

  it('emits time.jumped and time.phase on jumps', () => {
    const { world } = createTestWorld();
    const seen: string[] = [];
    world.on('time.jumped', () => void seen.push('jumped'));
    world.on('time.phase', (ev) => void seen.push(`phase:${String(ev.phase)}`));
    world.time.set('night');
    expect(seen).toEqual(['jumped', 'phase:night']);
  });

  it('advances silently and rolls the day over at dawn, not midnight', () => {
    const { world } = createTestWorld();
    world.time.set(4.9);
    const seen: string[] = [];
    world.on('time.jumped', () => void seen.push('jumped'));
    world.on('time.phase', () => void seen.push('phase'));
    world.time.advance(0.2); // across the 5:00 dawn line
    expect(world.time.day).toBe(2);
    expect(world.time.phase).toBe('dawn');
    world.time.advance(19); // across midnight to 0:06
    expect(world.time.hour).toBeCloseTo(0.1, 9);
    expect(world.time.day).toBe(2);
    expect(seen).toEqual([]);
    expect(() => world.time.advance(-1)).toThrow('forward step');
  });

  it('formats the HUD clock in 10-minute steps', () => {
    expect(formatClock(9)).toBe('9:00 AM');
    expect(formatClock(19.6)).toBe('7:30 PM');
    expect(formatClock(19.66)).toBe('7:30 PM');
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(12)).toBe('12:00 PM');
    expect(formatClock(23.99)).toBe('11:50 PM');
  });
});

describe('sim', () => {
  it('drives real input events plus ticks', () => {
    const { world, sim } = createTestWorld();
    const seen: string[] = [];
    world.on('input.move', (ev) => void seen.push(`move:${String(ev.dir)}@${world.ticks}`));
    world.on('input.turn', (ev) => void seen.push(`turn:${String(ev.dir)}`));
    sim.walk('up', 2);
    sim.face('left');
    expect(seen[0]).toBe('move:up@0');
    expect(seen[1]).toMatch(/^move:up@\d+$/);
    expect(Number(seen[1].split('@')[1])).toBeGreaterThan(0); // ticks ran between steps
    expect(seen[2]).toBe('turn:left');
  });

  it('interacts, teleports, gives, waits, and presses', () => {
    const { world, sim } = createTestWorld();
    let interacts = 0;
    world.on('input.interact', () => void interacts++);
    sim.interact();
    expect(interacts).toBe(1);
    sim.teleport(1, 1);
    expect(world.query('player')[0].pos).toEqual({ x: 1, y: 1 });
    const item = sim.give('test_item');
    expect(item.pos).toBeNull(); // lifted into the hands
    expect(world.query('player')[0].get('held')).toEqual({ id: item.id });
    const t = world.ticks;
    sim.wait(5);
    expect(world.ticks).toBe(t + 5);
    const ev = sim.press('input.secondary', {});
    expect(ev.name).toBe('input.secondary');
  });
});

describe('runSystemTest', () => {
  it('passes a proving test and enforces check semantics', () => {
    const good = defineSystem({
      id: 'good',
      tests: [{ name: 'proves it', ticks: 3, expect: (w, check) => check(w.ticks === 3, 'ticks ran') }],
    });
    expect(runSystemTest(good, good.tests[0]).ok).toBe(true);

    const silent = defineSystem({
      id: 'silent',
      tests: [{ name: 'checks nothing', ticks: 0, expect: () => undefined }],
    });
    const r1 = runSystemTest(silent, silent.tests[0]);
    expect(r1.ok).toBe(false);
    expect(r1.messages.join()).toMatch('no checks ran');

    const liar = defineSystem({
      id: 'liar',
      tests: [{ name: 'lies', ticks: 0, expect: (_w, check) => check(false, 'the sky is green') }],
    });
    const r2 = runSystemTest(liar, liar.tests[0]);
    expect(r2.ok).toBe(false);
    expect(r2.messages.join()).toMatch('the sky is green');
  });

  it('reports throws and contract violations as failures', () => {
    const boom = defineSystem({
      id: 'boom',
      tests: [
        {
          name: 'explodes',
          ticks: 0,
          setup: () => {
            throw new Error('kaput');
          },
          expect: (_w, check) => check(true, 'unreached'),
        },
      ],
    });
    expect(runSystemTest(boom, boom.tests[0]).messages.join()).toMatch('kaput');

    const loud = defineSystem({
      id: 'loud',
      on: { 'input.move': (_ev, w) => void w.emit('undeclared', {}) },
      tests: [
        {
          name: 'sneaky',
          ticks: 0,
          setup: (_w, sim) => void sim.walk('up'),
          expect: (_w, check) => check(true, 'setup ran'),
        },
      ],
    });
    const r = runSystemTest(loud, loud.tests[0]);
    expect(r.ok).toBe(false);
    expect(r.messages.join()).toMatch('undeclared event');
  });

  it('gives setup, ticks, and expect one shared world with own state', () => {
    const def = defineSystem({
      id: 'shared',
      tests: [
        {
          name: 'shares',
          ticks: 2,
          setup: (w) => void (w.state.n = 41),
          expect: (w, check) => {
            check((w.state.n as number) + 1 === 42, 'state survived setup->expect');
            check(w.ticks === 2, 'test ticks ran');
          },
        },
      ],
    });
    expect(runSystemTest(def, def.tests[0])).toEqual({ ok: true, messages: [] });
  });
});

describe('input layer', () => {
  function setup(): {
    input: Input;
    advance: (ms: number) => void;
    turns: Dir[];
    moves: Dir[];
  } {
    const { world } = createTestWorld();
    const { clock, advance } = fakeClock();
    const input = new Input(world, clock);
    const turns: Dir[] = [];
    const moves: Dir[] = [];
    world.on('input.turn', (ev) => void turns.push(ev.dir as Dir));
    world.on('input.move', (ev) => void moves.push(ev.dir as Dir));
    return { input, advance, turns, moves };
  }

  it('turns on a tap to a new direction', () => {
    const { input, advance, turns, moves } = setup(); // facing down
    input.keyDown('w', false);
    advance(TAP_TURN_MS - 1);
    input.keyUp('w');
    expect(turns).toEqual(['up']);
    expect(moves).toEqual([]);
  });

  it('steps once on a tap in the faced direction', () => {
    const { input, advance, turns, moves } = setup();
    input.keyDown('s', false);
    advance(10);
    input.keyUp('s');
    expect(turns).toEqual([]);
    expect(moves).toEqual(['down']);
  });

  it('walks at tuning pace while held, on our own timer', () => {
    const { input, advance, moves } = setup();
    input.keyDown('d', false);
    advance(TAP_TURN_MS + STEP_MS * 3 + 10);
    expect(moves).toEqual(['right', 'right', 'right', 'right']);
    input.keyUp('d');
    advance(STEP_MS * 2);
    expect(moves).toHaveLength(4); // release stops the walk; no trailing step
  });

  it('lets the last-pressed direction win', () => {
    const { input, advance, turns, moves } = setup();
    input.keyDown('w', false);
    input.keyDown('d', false);
    advance(10);
    input.keyUp('d'); // tap on d: facing is down, so this turns
    expect(turns).toEqual(['right']);
    advance(TAP_TURN_MS + STEP_MS); // ...then the still-held w walks
    expect(moves[0]).toBe('up');
  });

  it('ignores OS key repeat', () => {
    const { input, advance, turns, moves } = setup();
    input.keyDown('w', false);
    input.keyDown('w', true);
    input.keyDown('w', true);
    advance(10);
    input.keyUp('w');
    expect(turns).toEqual(['up']);
    expect(moves).toEqual([]);
  });

  it('sends interact and secondary on press', () => {
    const { world } = createTestWorld();
    const { clock } = fakeClock();
    const input = new Input(world, clock);
    const seen: string[] = [];
    world.on('input.interact', () => void seen.push('interact'));
    world.on('input.secondary', () => void seen.push('secondary'));
    input.keyDown(' ', false);
    input.keyDown('e', false);
    input.keyDown('q', false);
    input.keyDown('q', true); // repeat: nothing
    expect(seen).toEqual(['interact', 'interact', 'secondary']);
  });

  it('swallows game keys and leaves the rest alone', () => {
    const { world } = createTestWorld();
    const { clock } = fakeClock();
    const input = new Input(world, clock);
    const listeners: Record<string, (e: any) => void> = {};
    input.attach({
      addEventListener: (t, f) => void (listeners[t] = f),
      removeEventListener: (t) => void delete listeners[t],
    });
    let prevented = 0;
    listeners.keydown({ key: 'w', preventDefault: () => void prevented++ });
    listeners.keydown({ key: 't', preventDefault: () => void prevented++ });
    expect(prevented).toBe(1);
    input.enabled = false;
    const moves: Dir[] = [];
    world.on('input.move', (ev) => void moves.push(ev.dir as Dir));
    listeners.keydown({ key: 's', preventDefault: () => undefined });
    expect(moves).toEqual([]); // dev panel open: game input swallowed
    input.detach();
    expect(Object.keys(listeners)).toEqual([]);
  });
});

describe('tiles + catalog + fx/ui stubs', () => {
  it('reads, paints, and finds tiles', () => {
    const { world } = createTestWorld();
    expect(world.tiles.get(-1, 0)).toBeNull();
    expect(() => world.tiles.set(0, 0, 'nope')).toThrow('unknown sprite');
    expect(() => world.tiles.set(99, 99, 'grass')).toThrow('out of bounds');
    expect(world.tiles.find('walkable')).toHaveLength(12 * 12);
    expect(world.tiles.find('water')).toEqual([]);
  });

  it('looks art up by meaning', () => {
    const { world } = createTestWorld();
    expect(world.catalog.find('tree')).toContain('tree_round');
    expect(world.catalog.get('player').dirs).toEqual(['down', 'up', 'left', 'right']);
    expect(() => world.catalog.get('nope')).toThrow('unknown sprite');
  });

  it('runs fx and ui stubs through ticks', () => {
    const { world } = createTestWorld();
    const inner = internals(world);
    const [me] = world.query('player');
    world.fx.tween(me, 7, 6, 10);
    world.fx.particles('fx_spark', { x: 1, y: 1 });
    world.fx.floatText('hi', { x: 1, y: 1 });
    world.fx.tint('#fff', 0.5, 100);
    world.ui.banner('hello');
    world.ui.hud.add('clock', { text: 'day 1', width: 8 });
    expect(inner.tweens.has(me.id)).toBe(true);
    expect(inner.particles).toHaveLength(1);
    expect(inner.texts).toHaveLength(1);
    expect(inner.tintState?.color).toBe('#fff');
    expect(inner.bannerState?.text).toBe('hello');
    expect(inner.hud.get('clock')?.text).toBe('day 1');
    for (let t = 0; t < 200; t++) world.tick();
    expect(inner.tweens.has(me.id)).toBe(false);
    expect(inner.particles).toEqual([]);
    expect(inner.texts).toEqual([]);
    expect(inner.tintState).toBeNull();
    expect(inner.bannerState).toBeNull();
    world.ui.hud.remove('clock');
    expect(inner.hud.has('clock')).toBe(false);
  });
});

describe('defineSystem', () => {
  it('fills defaults and requires an id', () => {
    expect(() => defineSystem({} as never)).toThrow('needs a string "id"');
    const def = defineSystem({ id: 'x' });
    expect(def.buildsOn).toEqual([]);
    expect(def.contract).toEqual({ claims: [], emits: {}, hooks: [] });
    expect(def.tests).toEqual([]);
  });
});

describe('placeholder map', () => {
  it('is a ~30x20 walkable clearing inside a tree border', () => {
    const map = placeholderMap();
    expect([map.width, map.height]).toEqual([30, 20]);
    const world = createWorld({ seed: 1, map });
    const [me] = world.query('player');
    // Interior is open meadow (the player themself stands on (15, 10)).
    expect(world.isFree(15, 10, me)).toBe(true);
    expect(world.isFree(2, 1)).toBe(true);
    // The border ring reads as forest and blocks.
    for (let x = 0; x < 30; x++) {
      expect(world.isFree(x, 0)).toBe(false);
      expect(world.isFree(x, 19)).toBe(false);
    }
    for (let y = 0; y < 20; y++) {
      expect(world.isFree(0, y)).toBe(false);
      expect(world.isFree(29, y)).toBe(false);
    }
    // The player starts in the open, on grass.
    expect(world.query('player')[0].pos).toEqual({ x: 15, y: 10 });
    expect(world.tiles.get(15, 10)).toMatch(/^grass/);
  });

  it('uses the stable map format stage D will replace', () => {
    const map = placeholderMap();
    expect(map.tiles).toHaveLength(map.width * map.height);
    expect(map.spawns.length).toBeGreaterThan(0);
    expect(arenaMap().playerStart).toBeDefined();
  });
});

describe('sim helper (standalone)', () => {
  it('builds on any world', () => {
    const world = createWorld({ seed: 5, map: arenaMap() });
    const sim = createSim(world);
    sim.teleport(3, 3);
    expect(world.query('player')[0].pos).toEqual({ x: 3, y: 3 });
  });
});
