// mergeIntervals merges closed integer intervals [start, end] (start <= end)
// that overlap or touch, and returns them as a new array sorted by start.
// The input may be in any order and must not be modified.
export function mergeIntervals(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = intervals as Array<[number, number]>;
  sorted.sort();
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start < last[1]) last[1] = end;
    else merged.push([start, end]);
  }
  return merged;
}
