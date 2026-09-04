/** Runs shorter than this are extended by binary insertion, as in TimSort. */
const MIN_RUN = 32;

let scratch = new Uint32Array(0);
/** Run boundaries: `runs[i]` starts run `i`, and the last entry is `n`. */
const runs: number[] = [];

/**
 * Stable, adaptive sort of `order` by `keys[order[i]]`, ascending. Natural
 * runs are detected first and merged pairwise, so an input already in order —
 * the usual frame — costs one linear scan, and a few drifted keys cost a few
 * linear merges rather than a full sort. Engine sorts do not promise either,
 * and a comparator call per compare is what this avoids (SPEC §6.7).
 */
export function sortByKey(order: number[], keys: Float64Array): void {
  const n = order.length;
  if (n < 2) {
    return;
  }
  if (scratch.length < n >>> 1) {
    scratch = new Uint32Array(n);
  }

  runs.length = 0;
  runs.push(0);
  for (let lo = 0; lo < n;) {
    let hi = lo + 1;
    if (hi < n) {
      let previous = keys[order[lo]];
      let key = keys[order[hi]];
      if (key < previous) {
        // Strictly descending, so reversing it keeps the sort stable.
        previous = key;
        while (++hi < n && (key = keys[order[hi]]) < previous) {
          previous = key;
        }
        reverse(order, lo, hi - 1);
      } else {
        previous = key;
        while (++hi < n && (key = keys[order[hi]]) >= previous) {
          previous = key;
        }
      }
    }
    if (hi - lo < MIN_RUN) {
      hi = extend(order, keys, lo, hi, Math.min(lo + MIN_RUN, n));
    }
    runs.push(hi);
    lo = hi;
  }

  while (runs.length > 2) {
    let w = 1;
    let r = 0;
    for (; r + 2 < runs.length; r += 2) {
      merge(order, keys, runs[r], runs[r + 1], runs[r + 2]);
      runs[w++] = runs[r + 2];
    }
    if (r + 1 < runs.length) {
      runs[w++] = runs[r + 1];
    }
    runs.length = w;
  }
}

function reverse(order: number[], lo: number, hi: number): void {
  while (lo < hi) {
    const swap = order[lo];
    order[lo++] = order[hi];
    order[hi--] = swap;
  }
}

/** Grows the sorted run `[lo, hi)` to `end` by binary insertion; equal keys go after. */
function extend(order: number[], keys: Float64Array, lo: number, hi: number, end: number): number {
  for (; hi < end; hi++) {
    const item = order[hi];
    const key = keys[item];
    let left = lo;
    let right = hi;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (key < keys[order[mid]]) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }
    for (let i = hi; i > left; i--) {
      order[i] = order[i - 1];
    }
    order[left] = item;
  }
  return end;
}

/** Merges the adjacent sorted runs `[lo, mid)` and `[mid, hi)`, buffering only the shorter. */
function merge(order: number[], keys: Float64Array, lo: number, mid: number, hi: number): void {
  if (keys[order[mid - 1]] <= keys[order[mid]]) {
    return;
  }
  const left = mid - lo;
  const right = hi - mid;

  if (left <= right) {
    for (let i = 0; i < left; i++) {
      scratch[i] = order[lo + i];
    }
    let i = 0;
    let j = mid;
    let k = lo;
    while (i < left && j < hi) {
      if (keys[order[j]] < keys[scratch[i]]) {
        order[k++] = order[j++];
      } else {
        order[k++] = scratch[i++];
      }
    }
    while (i < left) {
      order[k++] = scratch[i++];
    }
  } else {
    for (let j = 0; j < right; j++) {
      scratch[j] = order[mid + j];
    }
    let i = mid - 1;
    let j = right - 1;
    let k = hi - 1;
    while (i >= lo && j >= 0) {
      if (keys[scratch[j]] >= keys[order[i]]) {
        order[k--] = scratch[j--];
      } else {
        order[k--] = order[i--];
      }
    }
    while (j >= 0) {
      order[k--] = scratch[j--];
    }
  }
}
