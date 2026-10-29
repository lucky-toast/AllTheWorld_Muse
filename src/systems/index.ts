import type { SystemDef } from '../engine/api';
import carry from './base/carry';
import movement from './base/movement';
import push from './base/push';
import use from './base/use';
import daynight from './base/daynight';

// Base systems in load order. Carry runs before use so it can claim
// input.interact for items first; use gets whatever carry leaves alone.
// Daynight runs the clock last; nothing else depends on tick order.
export const ALL_SYSTEMS: SystemDef[] = [movement, carry, push, use, daynight];
