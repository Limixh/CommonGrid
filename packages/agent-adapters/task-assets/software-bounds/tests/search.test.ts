import assert from "node:assert/strict";
import { test } from "node:test";
import { lowerBound } from "../src/search.ts";

test("empty array", () => {
  assert.equal(lowerBound([], 3), 0);
});
test("target inside the range", () => {
  assert.equal(lowerBound([1, 3, 5, 7], 5), 2);
  assert.equal(lowerBound([1, 3, 5, 7], 4), 2);
});
test("target below every value", () => {
  assert.equal(lowerBound([2, 4, 6], 1), 0);
});
test("target above every value", () => {
  assert.equal(lowerBound([2, 4, 6], 7), 3);
  assert.equal(lowerBound([5], 6), 1);
});
test("duplicates return the first index", () => {
  assert.equal(lowerBound([1, 2, 2, 2, 3], 2), 1);
  assert.equal(lowerBound([4, 4, 4], 4), 0);
});
test("negative values", () => {
  assert.equal(lowerBound([-5, -2, -2, 0], -2), 1);
});
