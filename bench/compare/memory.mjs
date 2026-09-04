/**
 * Memory footprint: absolute resident bytes after building a world of `n`
 * entities carrying Position + Velocity — two f32 fields each, so 16 bytes of
 * real payload per entity. Everything above 16 is what the library charges for
 * ids, masks, sparse sets, archetype bookkeeping and query caches.
 *
 * Deliberately NOT a before/after delta. A delta subtracts two heap readings
 * taken at different points in the GC's life and the difference is dominated
 * by when the collector happened to compact — measured that way, 100 000
 * entities can come out *smaller* than 10 000. Instead each process reports
 * one absolute number for one size, and the orchestrator fits a line across
 * five sizes: the slope is bytes per entity and the noisy intercept (module
 * load, baseline heap) falls out of the fit.
 *
 * The check that this works: the hand-written baseline must come out at 16.
 *
 *   node --expose-gc memory.mjs <adapter> <n>
 */
const [key, size] = process.argv.slice(2);
const n = Number(size);
const adapter = await import(`./adapters/${key}.mjs`);

const world = await adapter.footprint(n);

for (let i = 0; i < 8; i++) {
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 30));
}

const m = process.memoryUsage();
if (world === undefined) {
  throw new Error('footprint returned nothing');
}

process.stdout.write(
  JSON.stringify({ adapter: key, name: adapter.name, n, bytes: m.heapUsed + m.external }) + '\n',
);
