/**
 * apecs — internal entry point.
 *
 * Unstable surface for tooling and tests; not covered by semver.
 */

/** Default column page size — a power of two (SPEC §12.3). */
export const PAGE_SIZE = 4096

export * from './symbols'
export * from './debug'
export * from './entity'
export * from './codegen'
export * from './mask'
export * from './schema'
export * from './column'
export * from './entity-index'
export * from './trait'
export * from './relation'
export * from './terms'
