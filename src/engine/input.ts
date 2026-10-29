// Input layer: the only code that reads the keyboard. Arrows/WASD walk,
// Space/E interact, Q is secondary. Tap a new direction to turn, tap the
// faced direction to step once, hold to walk on our own timer (never OS
// repeat). Last-pressed direction wins. Facing lives only on the player.
import { STEPS_PER_SECOND, TAP_TURN_MS } from '../tuning';
import type { Dir, World } from './api';

const STEP_MS = 1000 / STEPS_PER_SECOND;

/** Timer source, so tests can drive input with a fake clock. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h) => globalThis.clearTimeout(h),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
  clearInterval: (h) => globalThis.clearInterval(h),
};

/** Minimal key event surface; works with the DOM and with test doubles. */
export interface KeyEventLike {
  key: string;
  repeat?: boolean;
  preventDefault(): void;
}

/** Minimal event target surface; works with window and with test doubles. */
export interface EventTargetLike {
  addEventListener(type: string, fn: (e: KeyEventLike) => void): void;
  removeEventListener(type: string, fn: (e: KeyEventLike) => void): void;
}

type Action = { dir: Dir } | { button: 'interact' | 'secondary' } | null;

function classify(key: string): Action {
  switch (key) {
    case 'ArrowUp':
      return { dir: 'up' };
    case 'ArrowDown':
      return { dir: 'down' };
    case 'ArrowLeft':
      return { dir: 'left' };
    case 'ArrowRight':
      return { dir: 'right' };
  }
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'w':
      return { dir: 'up' };
    case 's':
      return { dir: 'down' };
    case 'a':
      return { dir: 'left' };
    case 'd':
      return { dir: 'right' };
    case ' ':
    case 'Spacebar':
    case 'e':
      return { button: 'interact' };
    case 'q':
      return { button: 'secondary' };
  }
  return null;
}

/** True for every key the game owns (these all preventDefault). */
function isGameKey(key: string): boolean {
  return classify(key) !== null;
}

function normalize(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export class Input {
  private keys: string[] = []; // held direction keys; the last one drives
  private dirs = new Map<string, Dir>();
  private tapTimer: number | null = null;
  private walkTimer: number | null = null;
  private walking = false;
  private _enabled = true;
  private target: EventTargetLike | null = null;
  private onKeyDown = (e: KeyEventLike): void => {
    if (!isGameKey(e.key)) return;
    e.preventDefault();
    if (this._enabled) this.keyDown(e.key, e.repeat ?? false);
  };
  private onKeyUp = (e: KeyEventLike): void => {
    if (!isGameKey(e.key)) return;
    e.preventDefault();
    if (this._enabled) this.keyUp(e.key);
  };

  constructor(
    private world: World,
    private clock: Clock = realClock,
  ) {}

  /** False while the dev panel is open: game input is swallowed. */
  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    this._enabled = v;
    if (!v) this.releaseAll();
  }

  /** Starts listening on a target (window in play). */
  attach(target: EventTargetLike): void {
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
  }

  /** Stops listening and releases held keys. */
  detach(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target.removeEventListener('keyup', this.onKeyUp);
      this.target = null;
    }
    this.releaseAll();
  }

  /** A direction or button press. Repeats and double presses are ignored. */
  keyDown(key: string, repeat: boolean): void {
    if (!this._enabled) return;
    const action = classify(key);
    if (!action) return;
    if ('button' in action) {
      if (!repeat) this.world.emit(`input.${action.button}`, {});
      return;
    }
    const norm = normalize(key);
    if (repeat || this.keys.includes(norm)) return;
    this.keys.push(norm);
    this.dirs.set(norm, action.dir);
    this.drive();
  }

  /** A key release. Releasing before the tap delay turns or steps once. */
  keyUp(key: string): void {
    if (!this._enabled) return;
    const norm = normalize(key);
    const idx = this.keys.indexOf(norm);
    if (idx < 0) return;
    const dir = this.dirs.get(norm)!;
    const wasDriver = idx === this.keys.length - 1;
    this.keys.splice(idx, 1);
    this.dirs.delete(norm);
    if (!wasDriver) return;
    const wasWalking = this.walking;
    this.cancelTimers();
    if (!wasWalking) this.tap(dir);
    this.drive();
  }

  /** The new driver starts a fresh tap timer; the first held step fires it. */
  private drive(): void {
    this.cancelTimers();
    const top = this.keys[this.keys.length - 1];
    if (top === undefined) return;
    const dir = this.dirs.get(top)!;
    this.tapTimer = this.clock.setTimeout(() => {
      this.walking = true;
      this.tapTimer = null;
      this.world.emit('input.move', { dir });
      this.walkTimer = this.clock.setInterval(() => {
        this.world.emit('input.move', { dir });
      }, STEP_MS);
    }, TAP_TURN_MS);
  }

  /** A quick tap: turn to a new direction, step once in the faced one. */
  private tap(dir: Dir): void {
    const facing = this.world.query('player')[0]?.get('facing');
    if (dir === facing) this.world.emit('input.move', { dir });
    else this.world.emit('input.turn', { dir });
  }

  private cancelTimers(): void {
    if (this.tapTimer !== null) {
      this.clock.clearTimeout(this.tapTimer);
      this.tapTimer = null;
    }
    if (this.walkTimer !== null) {
      this.clock.clearInterval(this.walkTimer);
      this.walkTimer = null;
    }
    this.walking = false;
  }

  private releaseAll(): void {
    this.keys = [];
    this.dirs.clear();
    this.cancelTimers();
  }
}
