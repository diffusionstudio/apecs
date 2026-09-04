import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const include = ['tests/**/*.test.ts'];

/**
 * The bench project resolves `src/index` to the built bundle. Vite's SSR
 * transform leaves `__DEV__` as a global read and turns every import into a
 * getter on the module object — invisible in a test, a multiple in a
 * per-entity loop. `npm run bench` builds first.
 */
const bundle = [
  {
    find: /^(\.\.\/)+src\/index$/,
    replacement: fileURLToPath(new URL('./dist/index.js', import.meta.url)),
  },
];

export default defineConfig({
  test: {
    projects: [
      {
        // Source with dev assertions enabled; also the project that runs the
        // heap-delta allocation checks (SPEC §12.2).
        define: { __DEV__: 'true' },
        test: {
          name: 'dev',
          include,
          benchmark: { include: [] },
          // `globalThis.gc` for the heap-delta assertions — workers do not
          // inherit the parent process's V8 flags, so pass it through here.
          pool: 'forks',
          execArgv: ['--expose-gc'],
        },
      },
      {
        // Same tests with assertions compiled out, mirroring the published build.
        define: { __DEV__: 'false' },
        test: {
          name: 'prod',
          include,
          benchmark: { include: [] },
        },
      },
      {
        // The benchmarks measure what ships, so they run with the assertions
        // compiled out, like the published bundle (SPEC §12.1).
        define: { __DEV__: 'false' },
        resolve: { alias: bundle },
        test: {
          name: 'bench',
          include: [],
          benchmark: { include: ['bench/**/*.bench.ts'] },
        },
      },
      {
        // Type-level tests only (`expectTypeOf` / `assertType`) — SPEC §11.
        define: { __DEV__: 'true' },
        test: {
          name: 'types',
          include: [],
          benchmark: { include: [] },
          typecheck: {
            enabled: true,
            only: true,
            include: ['tests/**/*.test-d.ts'],
            tsconfig: './tsconfig.json',
          },
        },
      },
    ],
  },
});
