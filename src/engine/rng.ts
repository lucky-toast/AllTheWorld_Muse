// Seeded randomness (spec 4.6). Every system gets its own stream, seeded from the
// world seed and a hash of its id, so adding a system never changes another's outcomes.

/** Mulberry32 as a plain generator (used by the map builder, unchanged from the old engine). */
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One step of mulberry32 on an explicit state, so the position can be saved and restored. */
export function mulberryStep(state: number): { state: number; value: number } {
  const a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { state: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Starting state of the stream for `owner` in a world with `worldSeed`. */
export function streamSeed(worldSeed: number, owner: string): number {
  // Mix so that nearby seeds or similar ids still give unrelated streams.
  let h = (worldSeed ^ hashString(owner)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}
