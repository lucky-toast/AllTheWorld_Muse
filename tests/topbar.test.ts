// The top bar's text wrapping (src/engine/topbar.ts).
import { expect, test } from "vitest";
import { wrapText } from "../src/engine/topbar";
test("the top bar wraps a change title onto two lines and ends it with … when it is longer", () => {
  expect(wrapText("Last: Campfire", 30, 2)).toEqual(["Last: Campfire"]);
  expect(wrapText("Last: A crackling campfire that warms travellers", 30, 2)).toEqual(["Last: A crackling campfire", "that warms travellers"]);
  expect(wrapText("Last: A very long title that goes on and on well past two lines of text", 20, 2)).toEqual(["Last: A very long", "title that goes on…"]);
  expect(wrapText("Last: Supercalifragilisticexpialidocious", 20, 2)).toEqual(["Last:", "Supercalifragilisti…"]);
});
