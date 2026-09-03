import { defineConfig } from 'vitest/config'

const include = ['tests/**/*.test.ts']

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
})
