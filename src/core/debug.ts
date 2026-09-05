/** Diagnostics. Everything here compiles to nothing when `__DEV__` is false (SPEC §12.2). */

export class ApecsError extends Error {
  public constructor(message: string) {
    super(`apecs: ${message}`);
    this.name = 'ApecsError';
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (__DEV__ && !condition) {
    throw new ApecsError(message);
  }
}

export function warn(message: string): void {
  if (__DEV__) {
    console.warn(`apecs: ${message}`);
  }
}

/**
 * Dev: the stack frame `depth` calls above the function calling this — 0 is
 * that function itself, 1 its caller — as a `warnOnce` key per call site.
 */
export function callSite(depth: number): string {
  return new Error().stack?.split('\n')[depth + 2] ?? 'unknown call site';
}

let warned: Set<string> | undefined;

export function warnOnce(key: string, message: string): void {
  if (__DEV__) {
    warned ??= new Set();
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    console.warn(`apecs: ${message}`);
  }
}

export function resetWarnOnce(): void {
  warned = undefined;
}
