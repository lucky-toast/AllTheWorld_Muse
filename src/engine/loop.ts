import { TICKS_PER_SECOND } from '../tuning';
import type { World } from './api';

/** Fixed-step game loop (60 ticks/s) plus an optional renderer. Returns a stopper. */
export function startLoop(world: World, renderer?: { start(): void; stop(): void }): () => void {
  const timer = setInterval(() => world.tick(), 1000 / TICKS_PER_SECOND);
  renderer?.start();
  return () => {
    clearInterval(timer);
    renderer?.stop();
  };
}
