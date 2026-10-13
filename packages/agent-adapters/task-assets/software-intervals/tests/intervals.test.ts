import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeIntervals } from "../src/intervals.ts";

test("empty input", () => {
  assert.deepEqual(mergeIntervals([]), []);
});
test("disjoint intervals stay separate", () => {
  assert.deepEqual(mergeIntervals([[1, 2], [3, 4], [6, 6]]), [[1, 2], [3, 4], [6, 6]]);
});
test("overlapping intervals merge", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 9]]), [[1, 6], [8, 9]]);
});
test("touching intervals merge", () => {
  assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);
  assert.deepEqual(mergeIntervals([[0, 0], [0, 0]]), [[0, 0]]);
});
test("a contained interval does not shrink the result", () => {
  assert.deepEqual(mergeIntervals([[1, 9], [2, 3]]), [[1, 9]]);
  assert.deepEqual(mergeIntervals([[1, 8], [2, 3], [4, 5]]), [[1, 8]]);
});
test("unsorted input is sorted by start", () => {
  assert.deepEqual(mergeIntervals([[8, 9], [1, 3], [2, 6]]), [[1, 6], [8, 9]]);
});
test("the input is not modified and the result is a new array", () => {
  const input: Array<[number, number]> = [[5, 6], [1, 2], [2, 3]];
  const result = mergeIntervals(input);
  assert.deepEqual(input, [[5, 6], [1, 2], [2, 3]]);
  assert.deepEqual(result, [[1, 3], [5, 6]]);
  assert.notEqual(result, input);
});
