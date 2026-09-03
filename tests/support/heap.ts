/**
 * Heap-delta measurement for the "no allocation after warmup" rule (SPEC §12.2,
 * rule 1). `--expose-gc` is passed to the dev project's workers; where it is
 * missing the callers skip.
 */
const gc = globalThis.gc

export const CAN_MEASURE_HEAP = typeof gc === 'function'

function collect(): void {
  gc!()
  gc!()
}

/**
 * Bytes retained per pass of `run`, after `warmup` passes have settled the
 * caches, free lists and inline caches that legitimately allocate once.
 */
export function bytesPerPass(passes: number, run: () => void, warmup = passes): number {
  for (let i = 0; i < warmup; i++) run()
  collect()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < passes; i++) run()
  collect()
  return (process.memoryUsage().heapUsed - before) / passes
}
