// The wish box's text field scrolling (src/engine/wishbox.ts).
import { expect, test } from "vitest";
import { scrollStart } from "../src/engine/wishbox";
test("the wish box scrolls so the caret stays in view", () => {
  expect(scrollStart(0, 5, 5, 10)).toBe(0); // short text: no scroll
  expect(scrollStart(0, 20, 20, 10)).toBe(11); // typing past the end: the caret sits in the last cell
  expect(scrollStart(11, 3, 20, 10)).toBe(3); // Home or left arrow past the start: scroll back
  expect(scrollStart(11, 15, 20, 10)).toBe(11); // the caret moving inside the window: no scroll
  expect(scrollStart(11, 4, 4, 10)).toBe(0); // text deleted: back to the start
});
