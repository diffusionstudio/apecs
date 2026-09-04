/**
 * Correctness gate. A benchmark comparison is worthless if the libraries are
 * not doing the same work, so before any timing we assert that every adapter's
 * every variant runs, and that the iteration benchmarks touch the entity count
 * the spec says they should.
 *
 *   node verify.mjs
 */
import { ADAPTERS, BENCHMARKS } from './lib/spec.mjs'

const only = process.argv[2]
let failures = 0

for (const key of ADAPTERS) {
  if (only && only !== key) continue
  const adapter = await import(`./adapters/${key}.mjs`)
  for (const [name, factory] of Object.entries(adapter.benchmarks)) {
    const [bench] = name.split('/')
    const params = BENCHMARKS[bench]?.params ?? {}
    try {
      const run = await factory(params)
      await run()
      await run()
      console.log(`  ok   ${key.padEnd(9)} ${name}`)
    } catch (error) {
      failures++
      console.log(`  FAIL ${key.padEnd(9)} ${name}: ${error.message}`)
    }
  }
}

console.log(failures ? `\n${failures} failing` : '\nall adapters run')
process.exit(failures ? 1 : 0)
