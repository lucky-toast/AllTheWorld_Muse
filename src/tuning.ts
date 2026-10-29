// Every feel value for All the World lives here. Nothing else hard-codes these.
export const TUNING = {
  // Ticks per second of game logic; rendering is separate.
  ticksPerSecond: 60,
  // Ticks between steps while a movement key is held (~5 steps/s: calm, deliberate).
  stepTicks: 12,
  // Ticks a sprite takes to slide one tile (matches stepTicks so walks flow).
  slideTicks: 12,
  // Ticks a new direction must be held before walking starts; a shorter tap only turns.
  tapTurnTicks: 9,
  // Seed for the world RNG so every run and test is identical.
  seed: 1337,
  // In-game minutes added per tick at 1x (600 ticks = 1 game hour, a full day ~40 min... shortened below).
  // We use ticks per game hour directly instead:
  ticksPerGameHour: 360, // 6 real seconds per game hour at 1x; full day = 144 s, calm like Stardew.
  // Phase start hours (24h clock). Night (20->5) is shorter than the waking day.
  phases: { dawn: 5, day: 7, dusk: 17, night: 20 } as Record<string, number>,
  // Player's faint glow from daynight.migrate.
  playerLight: { radius: 34, color: "#ffd9a0", strength: 0.85 },
  // Lighting per phase: darkness overlay colour + alpha (0 = full daylight).
  lighting: {
    dawn: { color: "#8fa3c7", alpha: 0.34 },
    day: { color: "#000000", alpha: 0 },
    dusk: { color: "#b5651d", alpha: 0.3 },
    night: { color: "#060d2a", alpha: 0.9 },
  } as Record<string, { color: string; alpha: number }>,
  // Banner / float text lifetimes in ticks.
  bannerTicks: 180,
} as const;
export type Phase = "dawn" | "day" | "dusk" | "night";
export function phaseAt(hour: number): Phase {
  const p = TUNING.phases;
  if (hour >= p.dawn && hour < p.day) return "dawn";
  if (hour >= p.day && hour < p.dusk) return "day";
  if (hour >= p.dusk && hour < p.night) return "dusk";
  return "night";
}
export function phaseStart(phase: Phase): number { return TUNING.phases[phase]; }
