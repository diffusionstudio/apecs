// SPEC §12.1: a sorted query whose keys never moved should cost "zero work --
// one lastWriteTick compare per matching archetype". That is O(archetypes),
// not O(entities). Does the cost scale with entity count?
import { measure } from 'mitata';
import { Trait, World, f32 } from '../../dist/index.js';

const Position = new Trait({ x: f32(0) });
const SortKey = new Trait({ value: f32(0) });

console.log('entities'.padStart(9), 'entities() ns'.padStart(15), 'ns/entity'.padStart(11));
for (const n of [1_000, 10_000, 100_000]) {
  const world = new World({ maxEntities: n + 16 });
  for (let i = 0; i < n; i++) {
    world.spawn(Position({ x: i }), SortKey({ value: (i * 2654435761) % n }));
  }
  const sorted = world.query(Position, SortKey).sortBy(SortKey.value);
  const fn = () => sorted.entities();
  for (let i = 0; i < 5; i++) {
    fn();
  }
  const s = await measure(fn, { min_cpu_time: 900e6 });
  console.log(
    String(n).padStart(9),
    s.avg.toFixed(0).padStart(15),
    (s.avg / n).toFixed(2).padStart(11),
  );
}
