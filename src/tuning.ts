// Every feel value and every limit for All the World lives here. Nothing else hard-codes these.
export const TUNING = {
  // ---- Feel (same values as the old game at commit 24531c5) ----
  // Ticks per second of game logic; rendering is separate.
  ticksPerSecond: 60,
  // Ticks between steps while a movement key is held (~5 steps/s: calm, deliberate).
  stepTicks: 12,
  // Ticks a sprite takes to slide one tile (matches stepTicks so walks flow).
  slideTicks: 12,
  // Ticks a new direction must be held before walking starts; a shorter tap only turns.
  tapTurnTicks: 9,
  // World seed: per-system RNG streams are derived from it, so every run and test is identical.
  seed: 1337,
  // Seed of the hand-made map's terrain noise (src/world/map.ts). Changing it changes the map.
  mapSeed: 42,
  // 6 real seconds per game hour at 1x; a full day is 144 s, calm like Stardew.
  ticksPerGameHour: 360,
  // Hour the clock shows when a fresh world starts (day 1, in the morning).
  startHour: 9,
  // Time speeds the T key cycles through.
  timeSpeeds: [1, 4, 16],
  // Phase start hours (24h clock). Night (20->5) is shorter than the waking day.
  phases: { dawn: 5, day: 7, dusk: 17, night: 20 } as Record<string, number>,
  // Player's faint glow, given by daynight.migrate.
  playerLight: { radius: 34, color: "#ffd9a0", strength: 0.85 },
  // Lighting per phase: darkness overlay colour + alpha (0 = full daylight).
  lighting: {
    dawn: { color: "#8fa3c7", alpha: 0.34 },
    day: { color: "#000000", alpha: 0 },
    dusk: { color: "#b5651d", alpha: 0.3 },
    night: { color: "#060d2a", alpha: 0.9 },
  } as Record<string, { color: string; alpha: number }>,
  // Banner lifetime in ticks.
  bannerTicks: 180,
  // Particle lifetime in ticks.
  particleTicks: 24,
  // Particles spawned by fx.particles when no count is given.
  particleDefaultCount: 6,
  // Float text lifetime in ticks.
  floatTicks: 50,
  // Pixels the held item is drawn above the player's feet.
  heldLiftPx: 10,
  // Longest real frame the fixed-step loop catches up on, in ms (a stalled tab doesn't fast-forward).
  maxFrameMs: 250,
  // Most ticks sim.walk holds a key per step before giving up (a blocked or focused player never steps).
  simWalkTicksPerStep: 300,
  // Most ticks one sim.wait may run (10 game minutes at 1x).
  simWaitMaxTicks: 36_000,
  // Live load leaf transition (spec 13.1): ms to fade in until the screen is covered ...
  transitionInMs: 850,
  // ... and ms to fade back out after the load (about 2 s in all).
  transitionOutMs: 1150,
  // fx_leaf pieces swirling across the screen during the transition.
  transitionLeaves: 42,
  // How dark the transition's fade gets at its peak (0 to 1).
  transitionFade: 0.88,
  // Banner shown after a system loads live.
  loadBanner: "The world feels different",
  // Size of a pipeline shot: tiles around the focus (about 9x7) ...
  shotTilesW: 9,
  shotTilesH: 7,
  // ... and its zoom.
  shotZoom: 3,
  // Size of every area in tiles (the clearing and every area systems create).
  areaW: 30,
  areaH: 20,
} as const;

// Limits from spec section 15. All start generous and are tightened only if needed.
export const LIMITS = {
  // Fuel per onTick call, which runs every frame (nested emits included). Trap, rollback, strike.
  fuelLive: 50_000_000,
  // Fuel per other live call (perform, onEvent, onTimer, onInput, onTween, nested emits included):
  // they run now and then, so they may take longer. About 15 ms. Trap, rollback, strike.
  fuelEvent: 200_000_000,
  // Fuel per migrate, test or shot. Check fails.
  fuelCheck: 500_000_000,
  // Memory per module in bytes (16 MB). Allocation fails, trap, rollback, strike.
  memoryBytes: 16 * 1024 * 1024,
  // Host calls per invocation (outside an invocation: per system per tick). Denied.
  hostCallsPerInvocation: 100_000,
  // Request size in bytes (UTF-8 JSON). bad_request.
  requestBytes: 64 * 1024,
  // Response size in bytes (UTF-8 JSON). bad_request.
  responseBytes: 64 * 1024,
  // Entities returned per query. Truncated, with a flag.
  queryMax: 5_000,
  // Spawns per tick per system. Denied.
  spawnsPerTick: 200,
  // Live entities spawned per system. Denied.
  liveEntitiesPerSystem: 5_000,
  // Particles and float texts per tick per system. Dropped.
  fxPerTick: 64,
  // Ticks between banners from one system (1 per 2 s). Dropped.
  bannerIntervalTicks: 120,
  // Emit nesting depth. Denied.
  emitDepth: 16,
  // Saved state per system in bytes (1 MB). state.set denied.
  stateBytes: 1024 * 1024,
  // Compile time in ms. Check fails.
  compileMs: 30_000,
  // Time any other pipeline stage may take in ms. Worker killed, stage fails. The Tests stage
  // uses testMs per test and testsStageMs for the whole stage instead.
  stageMs: 20_000,
  // Time one test may take in ms, building its fresh world included. Worker killed, the report names the test.
  testMs: 5_000,
  // Time the whole Tests stage may take in ms, however many tests it runs. Worker killed, stage fails.
  testsStageMs: 120_000,
  // Ticks the World check runs the system on a copy of the live world.
  worldCheckTicks: 300,
  // Ticks the World check keeps running after re-creating every module from the saved world.
  worldCheckResumeTicks: 60,
  // Autosave interval of the live world in ms (spec 13.2).
  autosaveMs: 5_000,
  // Largest body the dev-server storage accepts, in bytes.
  storageBodyBytes: 16 * 1024 * 1024,
  // Borrow focus time limit in ticks (60 s). Engine takes the controls back.
  focusBorrowTicks: 60 * 60,
  // Freeze focus time limit in ticks (30 s). Engine takes the controls back.
  focusFreezeTicks: 30 * 60,
  // Focus cooldown per system in ticks (10 s), waived when focus started in perform. focus denied.
  focusCooldownTicks: 10 * 60,
  // Strikes that unload a system (and its dependents) ...
  strikesToUnload: 3,
  // ... within this many ticks (60 s).
  strikeWindowTicks: 60 * 60,
  // Repairs per designer step. Step dropped, chain stops.
  repairsPerStep: 3,
  // Most steps the planner may return. Extra steps dropped with a warning.
  PLAN_MAX_STEPS: 4,
  // Longest cleaned wish. Wish cut.
  WISH_MAX_CHARS: 100,
  // Example ids per tag in the catalog tag index the planner and designer see.
  TAG_INDEX_EXAMPLES: 5,
  // Most tags or entry ids the planner may pick for one step. Extra picks dropped with a warning.
  STEP_MAX_TAGS: 8,
  // Tool rounds (replies that call tools) per designer step, across its repairs. Past it, tool calls
  // get "write the system now" instead of a result; LOOKUP_GRACE_ROUNDS later the attempt fails.
  LOOKUP_ROUNDS_PER_STEP: 6,
  LOOKUP_GRACE_ROUNDS: 2,
  // Longest single tool result. Longer results are cut with a note to narrow the search.
  TOOL_RESULT_MAX_CHARS: 12000,
  // catalog_search: entry groups per page by default, and the most one call may ask for.
  CATALOG_SEARCH_LIMIT: 25,
  CATALOG_SEARCH_MAX: 60,
  // catalog_get: most ids per call.
  CATALOG_GET_MAX_IDS: 20,
  // Most area maps sent to the designer (current area first, then the newest). The rest are left out.
  MAP_IMAGE_MAX_AREAS: 4,
  // Share of a limit used in one call that gets logged.
  nearLimitShare: 0.5,
  // Characters allowed in ui.* and fx.float text. Denied.
  textMaxChars: 60,
  // fx.tint highest alpha. Denied.
  tintMaxAlpha: 0.6,
  // fx.tint longest duration in ms. Denied.
  tintMaxMs: 3_000,
  // Longest id-like string in a request (type, tag, component, area name, sprite). bad_request.
  nameMaxChars: 64,
  // Most lines in the ui.overlay panel. bad_request.
  overlayMaxLines: 6,
  // Most particles one fx.particles request asks for. bad_request.
  particlesPerRequest: 32,
  // Recent events kept for reports and the dev panel.
  eventLogMax: 100,
  // Widest HUD slot in characters. bad_request.
  hudMaxWidth: 30,
  // Entries kept in each dev log (denials, near-limit). Oldest dropped.
  logMax: 500,
  // Per-call fuel stats kept for each module (the dev panel's near-limit view). Oldest dropped.
  callStatsKept: 1000,
  // Longest abort or trace message read out of a module, in characters. The rest is cut.
  moduleMessageChars: 4096,
  // Most steps one sim.walk request may ask for. bad_request.
  simWalkMaxSteps: 100,
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

// The models the AI tab's API mode uses (Meta Muse API, spec 13.5). Planner and designer have
// separate providers so they can use different models. Reasoning tokens count toward maxTokens,
// so keep the caps generous: a reply cut off at the cap is an error, not a repair round.
export const AI_MODELS = {
  planner: { model: "muse-spark-1.3", maxTokens: 8000, reasoningEffort: "low" },
  designer: { model: "muse-wonder-1.0", maxTokens: 32000, reasoningEffort: "medium" },
} as const;
