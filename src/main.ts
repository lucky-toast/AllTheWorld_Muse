// Entry point: boots the world, loads the base systems, wires input, the
// renderer, and the dev tools, and starts the fixed-step loop.
import { DevKeys, DevPanel, cycleTimeSpeed, reloadAllSystems } from './engine/dev';
import { Input } from './engine/input';
import { startLoop } from './engine/loop';
import { Renderer } from './engine/render';
import { createWorld } from './engine/world';
import { ALL_SYSTEMS } from './systems/index';
import { finalMap } from './world/map';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const world = createWorld({ seed: (Date.now() % 2 ** 31) >>> 0, map: finalMap() });
for (const sys of ALL_SYSTEMS) world.loadSystem(sys);

const input = new Input(world);
input.attach(window);
const renderer = new Renderer(canvas, world);
window.addEventListener('resize', () => renderer.resize());

const panel = new DevPanel({
  imageFor: (file) => renderer.imageFor(file),
  onOpenChange: (open) => {
    input.enabled = !open; // the dev panel swallows game input while open
  },
});
const devKeys = new DevKeys({
  cycleSpeed: () => void cycleTimeSpeed(world),
  reload: () => reloadAllSystems(world, ALL_SYSTEMS),
  togglePanel: () => void panel.toggle(),
  closePanel: () => panel.closePanel(),
});
devKeys.attach(window);

renderer
  .load()
  .then(() => {
    renderer.resize();
    startLoop(world, renderer);
  })
  .catch((err: unknown) => {
    document.body.dataset.error = err instanceof Error ? err.message : String(err);
  });
