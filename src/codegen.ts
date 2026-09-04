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
