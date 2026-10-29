// Every feel value in the game lives here. Nothing else hard-codes these numbers.

export const TICKS_PER_SECOND = 60; // fixed-step sim rate; the loop and slide math assume this

export const STEPS_PER_SECOND = 3; // walking pace: calm and deliberate, Zelda-like, not twitchy
export const SLIDE_MS = 200; // slide between tiles in ms (input/renderer wall-clock side)
export const SLIDE_TICKS = 12; // same slide in ticks (60/s sim side); finishes inside one step
export const TAP_TURN_MS = 180; // a press shorter than this turns (or steps once) instead of walking

export const DAY_START_HOUR = 9; // a fresh world starts mid-morning, in the day phase
export const DAY_START_DAY = 1; // day numbers start at 1 and go up at each dawn

// Phase boundaries in hours (0-24). Night wraps past midnight. Night is 9h,
// shorter than the 11h day so it never feels like a chore.
export const PHASES = {
  dawn: { start: 5, end: 7 },
  day: { start: 7, end: 18 },
  dusk: { start: 18, end: 20 },
  night: { start: 20, end: 5 },
} as const;

// Representative hour to jump to on time.set("phase"): each phase's start.
export const PHASE_HOURS = { dawn: 5, day: 7, dusk: 18, night: 20 } as const;

// A full day lasts 8 real minutes; each phase's real length scales from PHASES.
export const DAY_LENGTH_SECONDS = 480;

// Darkness overlay per phase: night is deep blue and genuinely dark, dawn is
// pale, dusk is warm gold, day has none. The renderer reads these.
export const PHASE_DARKNESS = {
  dawn: { color: '#ffd9b3', alpha: 0.18 },
  day: { color: '#000000', alpha: 0 },
  dusk: { color: '#ff9a3c', alpha: 0.36 },
  night: { color: '#0a1a4d', alpha: 0.72 },
} as const;

// The player's faint glow: shows the ground right around them at night, not much else.
export const PLAYER_LIGHT = { radius: 2.5, color: '#ffca7a', strength: 0.85 } as const;

// The HUD bar below the map: height in native px; the canvas grows by this.
export const HUD_BAR_HEIGHT = 20;

// HUD bar background: dark warm brown matching the art; text sits on top of it.
export const HUD_BG = '#14100b';
// HUD text: warm cream, readable on the dark bar at native size.
export const HUD_TEXT = '#f5eeda';
// HUD pixel font size: the pack font at its native size (falls back if missing).
export const HUD_FONT_PX = 8;

// Day-bar swatches: each phase in its own color, opaque so they read on the bar.
export const HUD_PHASE_COLORS = { dawn: '#ffd9b3', day: '#ffe45e', dusk: '#ff9a3c', night: '#1c2f6b' } as const;

// Short-lived presentation state, in ticks.
export const BANNER_TICKS = 180; // ui.banner stays up ~3s, then fades
export const PARTICLE_TICKS = 30; // fx.particles burst lasts ~0.5s
export const FLOAT_TEXT_TICKS = 60; // fx.floatText floats for ~1s
