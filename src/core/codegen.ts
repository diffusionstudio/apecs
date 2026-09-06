/**
 * Cursor accessors are built with `new Function`. Under a CSP without
 * `unsafe-eval` that throws, and apecs falls back to the generic cursor
 * (SPEC §6.5). Probed once, at module load.
 */
export function probeCodegen(factory: FunctionConstructor = Function): boolean {
  try {
    return factory('return 1')() === 1;
  } catch {
    return false;
  }
}

export const CAN_CODEGEN = /* @__PURE__ */ probeCodegen();

let serial = 0;

/**
 * A line that makes one generated function's source unlike any other's.
 *
 * V8 keys its compilation cache on source text: two `new Function` calls with
 * identical source hand back the same `SharedFunctionInfo`, and every closure
 * made from it shares one feedback vector. Generating a driver per query buys
 * nothing if all those drivers are the same string — the call site inside them
 * is still one site for the whole program, and goes megamorphic once five
 * queries have passed through it. Prefix every generated source with this
 * (SPEC §12.2, rule 2).
 */
export function distinct(): string {
  return `//${serial++}\n`;
}
