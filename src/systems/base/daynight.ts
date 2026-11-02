// Base daynight (spec 9.4). While it is loaded the engine's clock advances; daynight
// watches it and emits every time.* event: time.phase plus its shortcut (time.dawn,
// time.daytime, time.dusk, time.night), time.newDay at dawn when the day goes up, and
// time.hour at each whole hour. Its migrate gives the player a faint light.
// (time.jumped belongs to the engine: it fires when the clock is jumped.)
import type { SystemDef } from "../../engine/systems";
import { TUNING } from "../../tuning";
import { Api } from "./api";

const SHORTCUT: Record<string, string> = { dawn: "time.dawn", day: "time.daytime", dusk: "time.dusk", night: "time.night" };
const PHASE = { phase: "string", previous: "string", day: "number" } as const;
interface Seen { phase: string; hour: number; day: number }

export const daynight: SystemDef = {
  base: true,
  manifest: {
    id: "daynight",
    why: "The world lives through dawn, day, dusk and a short night.",
    buildsOn: [],
    components: { light: "{ radius, color, strength, flicker? }: cuts a soft glow out of the darkness" },
    emits: {
      "time.phase": PHASE, "time.dawn": PHASE, "time.daytime": PHASE, "time.dusk": PHASE, "time.night": PHASE,
      "time.newDay": { day: "number" },
      "time.hour": { hour: "number", day: "number" },
    },
  },
  create(call) {
    const w = new Api(call);
    const now = (): Seen => { const t = w.r<{ day: number; hour: number; phase: string }>("time")!; return { phase: t.phase, hour: Math.floor(t.hour), day: t.day }; };
    return {
      migrate() {
        const p = w.player();
        if (p && w.get(p, "light") === null) w.do("set", { id: p, comp: "light", value: { ...TUNING.playerLight } });
        if (w.r("state.get") === null) w.do("state.set", { value: now() });
      },
      onTick() {
        const seen = (w.r<Seen>("state.get") ?? now()); const t = now();
        if (t.phase === seen.phase && t.hour === seen.hour && t.day === seen.day) return;
        w.do("state.set", { value: t });
        if (t.hour !== seen.hour) w.emit("time.hour", { hour: t.hour, day: t.day });
        if (t.phase !== seen.phase) {
          if (t.phase === "dawn" && t.day !== seen.day) w.emit("time.newDay", { day: t.day });
          const payload = { phase: t.phase, previous: seen.phase, day: t.day };
          w.emit("time.phase", payload);
          w.emit(SHORTCUT[t.phase], payload);
        }
      },

      // ---- tests (run in the 12x12 arena) ----
      test_phase_change_emits_phase_and_shortcut() {
        w.must("sim.time", { phaseOrHour: "dusk" });
        w.must("sim.wait", { ticks: 2 });
        const phases = w.events("time.phase");
        w.check(phases.some((e) => e.payload.phase === "dusk" && e.payload.previous === "day"), "time.phase fired for dusk, after day");
        w.check(w.events("time.dusk").length === 1, "the time.dusk shortcut fired");
      },
      test_sim_time_emits_jumped() {
        w.must("sim.time", { phaseOrHour: 12 });
        const j = w.events("time.jumped");
        w.check(j.length === 1 && j[0].payload.to === 12, "time.jumped fired once, to 12");
        const t = w.r<{ hour: number }>("time")!;
        w.check(t.hour >= 12 && t.hour < 13, "the clock is at noon");
      },
      test_whole_hours_emit_hour() {
        w.must("sim.time", { phaseOrHour: 9.95 });
        w.must("sim.wait", { ticks: 2 });
        w.must("sim.wait", { ticks: Math.ceil(TUNING.ticksPerGameHour * 0.06) });
        const hours = w.events("time.hour");
        w.check(hours.some((e) => e.payload.hour === 10), "time.hour fired when the clock crossed 10:00");
      },
      test_player_has_light() {
        const l = w.get<{ radius: number }>(w.player(), "light");
        w.check(!!l && l.radius > 0, "the player has a faint light");
      },
      test_day_one_starts_in_the_morning() {
        const t = w.r<{ day: number; hour: number; phase: string }>("time")!;
        w.check(t.day === 1, "day is 1");
        w.check(t.phase === "day" && t.hour < 12, "the clock starts in the morning");
      },
    };
  },
};
