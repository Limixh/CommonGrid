// lowerBound returns the first index i with values[i] >= target, or
// values.length when no such index exists. values is sorted ascending and may
// contain duplicates; it must not be modified.
export function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}
