import { defineConfig } from 'vitest/config'

const include = ['tests/**/*.test.ts']

export default defineConfig({
  test: {
    projects: [
      {
        // Source with dev assertions enabled; also the project that runs the
        // benchmarks and the heap-delta allocation checks (SPEC §12.2).
        define: { __DEV__: 'true' },
        test: {
          name: 'dev',
          include,
          benchmark: { include: ['bench/**/*.bench.ts'] },
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
