// Base system: daynight. Advances the clock via the engine flag and emits every time.* event (spec 9).
import { TUNING } from "../../tuning";
import type { Game } from "../../engine/runtime";
import type { LoadedSystem } from "../../engine/registry";

const SHORTCUT: Record<string, string> = { dawn: "time.dawn", day: "time.daytime", dusk: "time.dusk", night: "time.night" };

export function createDaynight(game: Game): LoadedSystem {
  let lastPhase: string | undefined, lastHour: number | undefined, lastDay: number | undefined;
  return {
    isBase: true,
    manifest: {
      id: "daynight", why: "The world lives through dawn, day, dusk and night.", buildsOn: [], replaces: [],
      entities: {}, components: { light: "{ radius, color, strength, flicker? } cuts a glow out of the darkness" },
      interactions: [], reactions: [], emits: {}, shots: [],
    },
    migrate: () => {
      const p = game.eng.playerRec();
      if (p && !p.comps.has("light")) game.call("daynight", { op: "set", id: p.id, comp: "light", value: { ...TUNING.playerLight } });
      lastPhase = game.eng.phase(); lastHour = Math.floor(game.eng.hour); lastDay = game.eng.day;
    },
    onTick: () => {
      const phase = game.eng.phase(), whole = Math.floor(game.eng.hour), day = game.eng.day;
      if (lastPhase === undefined) { lastPhase = phase; lastHour = whole; lastDay = day; return; }
      if (whole !== lastHour) { lastHour = whole; game.emit("(engine)", "time.hour", { hour: whole, day }); }
      if (phase !== lastPhase) {
        const previous = lastPhase;
        if (phase === "dawn" && day !== lastDay) game.emit("(engine)", "time.newDay", { day });
        lastPhase = phase; lastDay = day;
        game.emit("(engine)", "time.phase", { phase, previous, day });
        const shortcut = SHORTCUT[phase];
        if (shortcut) game.emit("(engine)", shortcut, { phase, previous, day });
      }
    },
  };
}
