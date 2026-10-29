import { defineSystem } from "../../engine/define";
import { TUNING } from "../../tuning";
import { player } from "./shared";

const SHORTCUT: Record<string, string> = { dawn: "time.dawn", day: "time.daytime", dusk: "time.dusk", night: "time.night" };

export default defineSystem({
  id: "daynight", why: "The clearing lives through dawn, day, dusk and a short night.", buildsOn: [],
  contract: {
    claims: [],
    emits: {
      "time.phase": { payload: "{ phase, previous, day }", when: "whenever the phase changes" },
      "time.dawn": { payload: "{ phase, previous, day }", when: "shortcut when the phase becomes dawn" },
      "time.daytime": { payload: "{ phase, previous, day }", when: "shortcut when the phase becomes day" },
      "time.dusk": { payload: "{ phase, previous, day }", when: "shortcut when the phase becomes dusk" },
      "time.night": { payload: "{ phase, previous, day }", when: "shortcut when the phase becomes night" },
      "time.newDay": { payload: "{ day }", when: "at dawn, when the day number goes up" },
      "time.hour": { payload: "{ hour, day }", when: "at every whole in-game hour" },
      "time.jumped": { payload: "{ from, to }", when: "when time.set moves the clock, followed by time.phase if the phase changed" },
    },
    hooks: ["To react to dawn, listen for time.dawn (or time.newDay for the day count).", "To add light, add a light component { radius, color, strength, flicker? }; the renderer does the rest."],
  },
  components: { light: "{ radius, color, strength, flicker? } cuts a glow out of the darkness." },
  migrate(w) { const p = player(w); if (p && !p.has("light")) p.set("light", { ...TUNING.playerLight }); const s = w.state as { lastPhase?: string; lastHour?: number; lastDay?: number }; if (s.lastPhase === undefined) { s.lastPhase = w.time.phase; s.lastHour = Math.floor(w.time.hour); s.lastDay = w.time.day; } },
  onTick(w) {
    const s = w.state as { lastPhase?: string; lastHour?: number; lastDay?: number };
    const phase = w.time.phase;
    if (s.lastPhase === undefined) { s.lastPhase = phase; s.lastHour = Math.floor(w.time.hour); s.lastDay = w.time.day; return; }
    const whole = Math.floor(w.time.hour);
    if (whole !== s.lastHour) { s.lastHour = whole; w.emit("time.hour", { hour: whole, day: w.time.day }); }
    if (phase !== s.lastPhase) {
      const previous = s.lastPhase; const isDawn = phase === "dawn";
      if (isDawn && w.time.day !== s.lastDay) w.emit("time.newDay", { day: w.time.day });
      s.lastPhase = phase; s.lastDay = w.time.day;
      const payload = { phase, previous, day: w.time.day };
      w.emit("time.phase", payload); w.emit(SHORTCUT[phase], payload);
    }
  },
  tests: [
    { name: "phase changes emit time.phase and shortcut", ticks: 3, setup(w, sim) { (w.state as Record<string, unknown>).__phases = []; w.on("time.phase", (ev) => { ((w.state as Record<string, unknown>).__phases as unknown[]).push(ev.phase); }); w.on("time.dusk", () => { (w.state as Record<string, unknown>).__dusk = true; }); w.time.set("dusk"); sim.wait(2); }, expect(w, check) { check(((w.state as Record<string, unknown>).__phases as string[]).includes("dusk"), "time.phase fired for dusk"); check((w.state as Record<string, unknown>).__dusk === true, "time.dusk shortcut fired"); } },
    { name: "time.set emits time.jumped", ticks: 2, setup(w, sim) { (w.state as Record<string, unknown>).__jumped = 0; w.on("time.jumped", () => { (w.state as Record<string, number>).__jumped++; }); w.time.set(12); sim.wait(1); }, expect(w, check) { check((w.state as Record<string, number>).__jumped === 1, "time.jumped fired once"); check(w.time.hour >= 12 && w.time.hour < 13, "clock is at noon"); } },
    { name: "whole hours emit time.hour", ticks: 400, setup(w, sim) { (w.state as Record<string, unknown>).__hours = 0; w.on("time.hour", () => { (w.state as Record<string, number>).__hours++; }); w.time.set(9); sim.wait(370); }, expect(w, check) { check((w.state as Record<string, number>).__hours >= 1, "time.hour fired after crossing an hour"); } },
    { name: "player gets a faint light", ticks: 1, setup() {}, expect(w, check) { check(player(w).has("light"), "player has light component"); const l = player(w).get<{ radius: number }>("light"); check(!!l && l.radius > 0, "light has a radius"); } },
    { name: "day starts at 1 in the morning", ticks: 1, setup() {}, expect(w, check) { check(w.time.day === 1, "day is 1"); check(w.time.phase === "day", "starts in morning day phase"); } },
  ],
});
