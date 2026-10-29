// Stage D checks: the final hand-made map, the full headless boot, the dev
// tools, and the Done-checklist items that can be verified without a browser.
import { describe, expect, it } from 'vitest';
import type { World } from '../src/engine/api';
import { CATALOG } from '../src/engine/catalog';
import {
  DevKeys,
  DevPanel,
  cycleTimeSpeed,
  nextSpeed,
  reloadAllSystems,
  spriteCells,
  type DevKeyEvent,
  type DevKeyTarget,
} from '../src/engine/dev';
import { Renderer } from '../src/engine/render';
import { createSim } from '../src/engine/sim';
import { createTestWorld } from '../src/engine/test';
import { createWorld, internals } from '../src/engine/world';
import daynight from '../src/systems/base/daynight';
import { ALL_SYSTEMS } from '../src/systems/index';
import { HUD_BAR_HEIGHT, PHASE_DARKNESS } from '../src/tuning';
import { finalMap } from '../src/world/map';

const byType = (world: World, type: string) =>
  world.query('sprite').filter((e) => e.type === type);

describe('final map', () => {
  it('keeps the stable 30x20 format', () => {
    const map = finalMap();
    expect([map.width, map.height]).toEqual([30, 20]);
    expect(map.tiles).toHaveLength(map.width * map.height);
    expect(map.spawns.length).toBeGreaterThan(0);
    expect(map.playerStart).toEqual({ x: 15, y: 10 });
  });

  it('seals the whole border with forest', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    for (let x = 0; x < 30; x++) {
      expect(world.isFree(x, 0)).toBe(false);
      expect(world.isFree(x, 19)).toBe(false);
    }
    for (let y = 0; y < 20; y++) {
      expect(world.isFree(0, y)).toBe(false);
      expect(world.isFree(29, y)).toBe(false);
    }
    // Border reads as forest with varied depth, not a ring: clusters jut in.
    const clusters = world
      .query('solid')
      .filter((e) => e.type === 'tree_pine_cluster' || e.type === 'tree_cluster');
    expect(clusters.length).toBeGreaterThanOrEqual(30);
    expect(clusters.some((e) => e.pos!.x > 0 && e.pos!.x < 26 && e.pos!.y > 2)).toBe(true);
  });

  it('keeps the middle open and sunlit', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    const [me] = world.query('player');
    for (const [x, y] of [
      [15, 10],
      [12, 9],
      [18, 11],
      [15, 8],
      [10, 10],
    ]) {
      expect(world.tiles.get(x, y)).toMatch(/^grass/);
      expect(world.isFree(x, y, me)).toBe(true);
    }
    const tiles = finalMap().tiles;
    expect(tiles.filter((t) => t === 'grass_dark').length).toBeGreaterThan(100);
    expect(tiles.filter((t) => t === 'grass_detail').length).toBeGreaterThan(0);
  });

  it('has no dirt anywhere', () => {
    for (const t of finalMap().tiles) expect(t.startsWith('dirt')).toBe(false);
  });

  it('has one short straight stream near the south edge', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    expect(world.tiles.get(6, 15)).toBe('stream_h_left');
    expect(world.tiles.get(7, 15)).toBe('stream_h');
    expect(world.tiles.get(8, 15)).toBe('stream_h');
    expect(world.tiles.get(9, 15)).toBe('stream_h');
    expect(world.tiles.get(10, 15)).toBe('stream_h_right');
    expect(world.tiles.find('water')).toHaveLength(5);
    for (let x = 6; x <= 10; x++) {
      expect(world.isFree(x, 15)).toBe(false); // water is never walkable
      expect(world.at(x, 15).some((e) => e.has('solid'))).toBe(false);
    }
  });

  it('spawns the handful of interactables', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    expect(byType(world, 'log_fallen')).toHaveLength(2);
    expect(byType(world, 'crate')).toHaveLength(1);
    expect(byType(world, 'branch')).toHaveLength(3);
    expect(byType(world, 'stone')).toHaveLength(3);
    for (const log of byType(world, 'log_fallen')) {
      expect(log.has('item')).toBe(true);
      expect(log.has('pushable')).toBe(true);
      // Both tiles of the 1x2 log sit on free ground.
      expect(world.isFree(log.pos!.x, log.pos!.y, log)).toBe(true);
      expect(world.isFree(log.pos!.x, log.pos!.y - 1, log)).toBe(true);
    }
    expect(byType(world, 'crate')[0].has('pushable')).toBe(true);
  });

  it('blocks trunks but not canopy air, and never lets the player leave', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    // tree_big_green at (7, 6) blocks only its trunk tile (8, 6).
    expect(world.at(8, 6).some((e) => e.type === 'tree_big_green')).toBe(true);
    expect(world.isFree(8, 6)).toBe(false);
    expect(world.isFree(7, 6)).toBe(true); // under the canopy: free air
    expect(world.isFree(9, 6)).toBe(true);
    expect(world.isFree(-1, 10)).toBe(false);
    expect(world.isFree(30, 10)).toBe(false);
    expect(world.isFree(15, -1)).toBe(false);
    expect(world.isFree(15, 20)).toBe(false);
  });

  it('keeps the interior sparse and calm', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    const interior = world
      .query('solid')
      .filter((e) => e.type !== 'tree_pine_cluster' && e.type !== 'tree_cluster');
    expect(interior.length).toBeLessThanOrEqual(8);
    expect(world.query('decor')).toHaveLength(7);
    // No light sources on the map itself; the player glow comes from daynight.
    expect(world.query('light')).toHaveLength(0);
  });
});

describe('full game boot (headless)', () => {
  it('boots the final map with every system and walks', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    for (const def of ALL_SYSTEMS) world.loadSystem(def);
    const sim = createSim(world);
    const [me] = world.query('player');
    expect(me.pos).toEqual({ x: 15, y: 10 });
    expect(me.get('facing')).toBe('down');
    expect(me.has('light')).toBe(true);
    const hour = world.time.hour;
    for (let i = 0; i < 60; i++) world.tick();
    expect(world.time.hour).toBeGreaterThan(hour);
    sim.walk('right');
    expect(world.query('player')[0].pos).toEqual({ x: 16, y: 10 });
    const snap = world.snapshot();
    sim.walk('right');
    world.restore(snap);
    expect(world.query('player')[0].pos).toEqual({ x: 16, y: 10 });
    expect(internals(world).violations).toEqual([]);
  });
});

describe('dev tools', () => {
  it('cycles the time speed 1x -> 4x -> 16x', () => {
    expect(nextSpeed(1)).toBe(4);
    expect(nextSpeed(4)).toBe(16);
    expect(nextSpeed(16)).toBe(1);
    expect(nextSpeed(undefined)).toBe(1);
    expect(nextSpeed('fast')).toBe(1);
    expect(nextSpeed(0)).toBe(1);
  });

  it('writes the speed into daynight state', () => {
    const { world } = createTestWorld(daynight);
    expect(cycleTimeSpeed(world)).toBe(4);
    expect(cycleTimeSpeed(world)).toBe(16);
    expect(cycleTimeSpeed(world)).toBe(1);
    expect(internals(world).systemState('daynight')?.speed).toBe(1);
  });

  it('cycles harmlessly when daynight is absent', () => {
    const { world } = createTestWorld();
    expect(cycleTimeSpeed(world)).toBe(1);
  });

  it('reloads all systems without losing the world or duplicating handlers', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    for (const def of ALL_SYSTEMS) world.loadSystem(def);
    const sim = createSim(world);
    const branch = sim.give('branch');
    sim.walk('right');
    sim.wait(30);
    const before = world.serialize();
    const order = [...world.systems];
    reloadAllSystems(world, ALL_SYSTEMS);
    expect([...world.systems]).toEqual(order);
    expect(world.serialize()).toBe(before); // entities, tiles, clock, held: identical
    expect(world.query('player')[0].get('held')).toEqual({ id: branch.id });
    let moved = 0;
    world.on('player.moved', () => void moved++);
    sim.walk('up'); // exactly one handler answers per step: no duplicates
    expect(moved).toBe(1);
    expect(internals(world).violations).toEqual([]);
  });

  it('preventDefaults dev hotkeys and dispatches them', () => {
    const listeners = new Map<string, Array<(e: DevKeyEvent) => void>>();
    const target: DevKeyTarget = {
      addEventListener: (type, fn) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: (type, fn) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((h) => h !== fn));
      },
    };
    const calls: string[] = [];
    let panelOpen = false;
    const keys = new DevKeys({
      cycleSpeed: () => void calls.push('speed'),
      reload: () => void calls.push('reload'),
      togglePanel: () => {
        panelOpen = !panelOpen;
        calls.push('toggle');
      },
      closePanel: () => {
        const was = panelOpen;
        panelOpen = false;
        return was;
      },
    });
    keys.attach(target);
    const press = (key: string, extra?: Partial<DevKeyEvent>): boolean => {
      let prevented = false;
      const ev: DevKeyEvent = { key, preventDefault: () => void (prevented = true), ...extra };
      for (const fn of listeners.get('keydown') ?? []) fn(ev);
      return prevented;
    };
    expect(press('t')).toBe(true);
    expect(press('T')).toBe(true);
    expect(press('R', { shiftKey: true })).toBe(true);
    expect(press('`')).toBe(true);
    expect(panelOpen).toBe(true);
    expect(press('Escape')).toBe(true); // closes the open panel
    expect(panelOpen).toBe(false);
    expect(calls).toEqual(['speed', 'speed', 'reload', 'toggle']);
    expect(press('r')).toBe(false); // plain r is not a dev key
    expect(press('x')).toBe(false);
    expect(press('Escape')).toBe(false); // nothing to close: untouched
    keys.detach();
    expect(listeners.get('keydown')).toHaveLength(0);
  });

  it('keeps the panel a no-op without a DOM', () => {
    const panel = new DevPanel({ imageFor: () => undefined });
    expect(panel.openPanel()).toBe(false);
    expect(panel.open).toBe(false);
    expect(panel.closePanel()).toBe(false);
    expect(panel.toggle()).toBe(false);
  });

  it('covers every catalog sprite with a cell', () => {
    const cells = spriteCells();
    expect(cells).toHaveLength(CATALOG.length);
    expect(new Set(cells.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const entry of CATALOG) {
      expect(cells.some((c) => c.id === entry.id)).toBe(true);
    }
    const player = cells.find((c) => c.id === 'player')!;
    expect(player.anims).toContain('walk');
    expect(player.anims).toContain('pose:dead');
    expect(cells.find((c) => c.id === 'fx_leaf')!.anims).toEqual(['pieces']);
    for (const cell of cells) expect(cell.anims.length).toBeGreaterThanOrEqual(1);
  });
});

describe('contracts + tuning + fit', () => {
  it('ships a contract on every base system', () => {
    expect(ALL_SYSTEMS.length).toBeGreaterThan(0);
    for (const def of ALL_SYSTEMS) {
      expect(def.why.length).toBeGreaterThan(0);
      expect(def.contract.hooks.length).toBeGreaterThan(0);
      expect(def.contract.claims.length + Object.keys(def.contract.emits).length).toBeGreaterThan(0);
      expect(Array.isArray(def.buildsOn)).toBe(true);
    }
  });

  it('keeps night dark with its own phase colors', () => {
    expect(PHASE_DARKNESS.night.alpha).toBeGreaterThanOrEqual(0.6);
    expect(PHASE_DARKNESS.day.alpha).toBe(0);
    const colors = [PHASE_DARKNESS.dawn.color, PHASE_DARKNESS.dusk.color, PHASE_DARKNESS.night.color];
    expect(new Set(colors).size).toBe(3);
  });

  it('fits the map plus HUD at a whole scale and resets smoothing', () => {
    const world = createWorld({ seed: 7, map: finalMap() });
    const ctxStub = { imageSmoothingEnabled: true };
    const canvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getContext: () => ctxStub,
    };
    const g = globalThis as Record<string, unknown>;
    const savedWindow = g.window;
    try {
      g.window = { innerWidth: 800, innerHeight: 600 };
      const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, world);
      renderer.resize();
      expect(canvas.width).toBe(30 * 16);
      expect(canvas.height).toBe(20 * 16 + HUD_BAR_HEIGHT);
      expect(canvas.style.width).toBe(`${30 * 16}px`); // scale 1 fits 800x600
      expect(canvas.style.height).toBe(`${20 * 16 + HUD_BAR_HEIGHT}px`);
      expect(ctxStub.imageSmoothingEnabled).toBe(false);
      g.window = { innerWidth: 1600, innerHeight: 1200 };
      renderer.resize();
      expect(canvas.style.width).toBe(`${30 * 16 * 3}px`); // largest whole scale
      expect(canvas.style.height).toBe(`${(20 * 16 + HUD_BAR_HEIGHT) * 3}px`);
      expect(ctxStub.imageSmoothingEnabled).toBe(false);
    } finally {
      if (savedWindow === undefined) delete g.window;
      else g.window = savedWindow;
    }
  });
});
