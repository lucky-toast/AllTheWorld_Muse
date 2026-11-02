// Every feel value and every limit for All the World lives here.
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
  // Ticks per in-game hour at 1x; a full day is 144 real seconds.
  ticksPerGameHour: 360,
  // Phase start hours on a 24-hour clock.
  phases: { dawn: 5, day: 7, dusk: 17, night: 20 } as Record<string, number>,
  // The player's faint glow, given by daynight in a later phase.
  playerLight: { radius: 34, color: "#ffd9a0", strength: 0.85 },
  // Lighting per phase: darkness overlay colour and alpha.
  lighting: {
    dawn: { color: "#8fa3c7", alpha: 0.34 },
    day: { color: "#000000", alpha: 0 },
    dusk: { color: "#b5651d", alpha: 0.3 },
    night: { color: "#060d2a", alpha: 0.9 },
  } as Record<string, { color: string; alpha: number }>,
  // Banner lifetime in ticks.
  bannerTicks: 180,
  // Every sandbox and pipeline limit from spec section 15.
  limits: {
    // Fuel for one live system call, including nested emits.
    fuelPerLiveCall: 50_000_000,
    // Fuel for one migrate, test or shot call.
    fuelPerSetup: 500_000_000,
    // Maximum linear memory for one module.
    memoryPerModuleBytes: 16 * 1024 * 1024,
    // Host requests allowed in one invocation.
    hostCallsPerInvocation: 100_000,
    // Maximum UTF-8 JSON request size.
    requestSizeBytes: 64 * 1024,
    // Maximum UTF-8 JSON response size.
    responseSizeBytes: 64 * 1024,
    // Entity ids returned by one query before truncation.
    queryResults: 5_000,
    // Spawns allowed per system in one tick.
    spawnsPerTickPerSystem: 200,
    // Live entities one system may own.
    liveEntitiesPerSystem: 5_000,
    // Particles and float texts kept per tick.
    effectsPerTick: 64,
    // Minimum ticks between banners from one system.
    bannerIntervalTicks: 120,
    // Maximum nested emit depth.
    emitNesting: 16,
    // Maximum saved JSON state per system.
    stateSizeBytes: 1024 * 1024,
    // Maximum AssemblyScript compile time.
    compileTimeMs: 30_000,
    // Maximum time for any other pipeline stage.
    stageTimeMs: 20_000,
    // Ticks run by the pipeline world check.
    worldCheckTicks: 300,
    // Seconds borrow focus may be held.
    focusBorrowSeconds: 60,
    // Seconds freeze focus may be held.
    focusFreezeSeconds: 30,
    // Seconds before a system may take focus again.
    focusCooldownSeconds: 10,
    // Strikes in the window that unload a system.
    strikesBeforeUnload: 3,
    // Strike counting window in seconds.
    strikesWindowSeconds: 60,
    // Designer repairs allowed per planner step.
    repairsPerStep: 3,
    // Planner steps kept from one wish.
    planMaxSteps: 4,
    // Characters kept from a player wish.
    wishMaxChars: 100,
    // Fraction of a limit that triggers a near-limit log entry.
    nearLimitThreshold: 0.5,
  },
} as const;

export type Phase = "dawn" | "day" | "dusk" | "night";
export function phaseAt(hour: number): Phase {
  const p = TUNING.phases;
  if (hour >= p.dawn && hour < p.day) return "dawn";
  if (hour >= p.day && hour < p.dusk) return "day";
  if (hour >= p.dusk && hour < p.night) return "dusk";
  return "night";
}
export function phaseStart(phase: Phase): number {
  return TUNING.phases[phase];
}
