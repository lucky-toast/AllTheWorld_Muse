// Base systems in load order: movement, carry, push, daynight (spec 9).
import type { Engine } from "../../engine/engine";
import { Game } from "../../engine/runtime";
import { createMovement } from "./movement";
import { createCarry } from "./carry";
import { createPush } from "./push";
import { createDaynight } from "./daynight";

export { createMovement, createCarry, createPush, createDaynight };

export function createGame(eng: Engine): Game {
  const game = new Game(eng);
  game.loadFactory(() => createMovement(game));
  game.loadFactory(() => createCarry(game));
  game.loadFactory(() => createPush(game));
  game.loadFactory(() => createDaynight(game));
  game.interactions.refresh();
  return game;
}
/** Re-instantiate factories for an existing game (used by Shift+R reload). */
export function baseFactories(game: Game) {
  return [() => createMovement(game), () => createCarry(game), () => createPush(game), () => createDaynight(game)];
}
