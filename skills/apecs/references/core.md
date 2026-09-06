# apecs core reference

## Traits

```ts
new Trait(); // tag — no column
new Trait({ x: f32(0), y: f32(0) }); // struct — one column per field
new Trait(() => new THREE.Mesh()); // AoS — one boxed column, factory per entity
new Trait({ x: 0 }, { track: true }); // force change-tick allocation
```

The argument carries **both shape and defaults**. A trait is callable: calling it
produces a trait instance for `spawn` / `add`.

```ts
Position({ x: 20 }); // partial; unspecified fields take the default
Mesh(existingMesh); // AoS: adopt a reference instead of calling the factory
IsActive; // tags are passed bare
```

### Field types

| Declaration        | Column                                       | Notes                                                     |
| ------------------ | -------------------------------------------- | --------------------------------------------------------- |
| `0`                | `Float64Array`                               | default for numbers                                       |
| `f32/f64(0)`       | `Float32Array` / `Float64Array`              |                                                           |
| `i8/i16/i32(0)`    | `Int8Array` / `Int16Array` / `Int32Array`    |                                                           |
| `u8/u16/u32(0)`    | `Uint8Array` / `Uint16Array` / `Uint32Array` |                                                           |
| `false` / `bool()` | `Uint8Array`                                 | exposed as `boolean`                                      |
| `''` / `str()`     | `Array<string>`                              | boxed                                                     |
| `eid(0)`           | `Float64Array`                               | entity handle; patched to `NULL_ENTITY` on target despawn |
| plain object       | flattened                                    | `{ pos: { x: 0 } }` → column `pos.x`                      |
| anything else      | `Array<T>`                                   | boxed; dev warns and suggests an AoS trait                |

Field order is column order and is stable — part of the serialization contract.

### Fields are first-class

`Position.x` is a `Field<number>` and is accepted wherever a trait is when a
single value is wanted: `world.get`, `world.set`, `world.accessor`, `sortBy`,
`chunk.column`. An AoS trait is its own field (it has exactly one column). A trait
exposes **only** its schema keys as string properties — internals are
symbol-keyed — so no schema name can collide with a method.

## Entities

```
bit  51 ......... 44 43 .......... 32 31 ................ 0
     [ world :  8 ][ generation: 12 ][      id : 32      ]
```

`Entity` is a branded `number`. Id `0` is `NULL_ENTITY`; id `1` is the world
entity; user ids start at `2`. Passing a world-A handle to world-B is detectable.
Ids recycle FIFO; generation wraps at 4096, after which the id is retired rather
than reused, so a stale handle can never alias.

```ts
world.spawn(...items): Entity
world.spawnMany(n, ...items): Float64Array     // one archetype transition, 10–50× the loop
world.despawn(e)      world.despawnMany(batch) // a QueryResult is a valid batch
world.isAlive(e)
world.add(e, Position({ x: 1 }), IsActive)     world.addMany(batch, IsActive)
world.remove(e, Velocity)                      world.removeMany(batch, Velocity)
world.has(e, Position)
```

Prefer the `*Many` forms for anything above a handful of entities — they are a
first-class part of the API, not an optimisation afterthought.

## World

```ts
const world = new World({ pageSize: 4096, maxEntities: 1 << 20 });
world.entity; // the world entity handle
world.tick; // monotonic change clock
world.step(); // ++tick
world.clear(); // despawn everything, keep archetypes warm
world.compact(); // release empty tail pages
world.destroy(); // tear down and release the world id
```

`World` is a plain class with prototype methods — **subclassing is the intended
extension mechanism**. Call `super()` before any world method; internal state is
symbol- or `#private`-keyed and won't collide with subclass fields.

**World traits** are ordinary traits on the world entity, so they get observers,
ticks, typing and queryability for free:

```ts
world.add(Time);
world.set(Time, { delta: 0.016 });
world.get(Time); // { delta, current } — allocates
world.get(Time.delta); // number — no allocation
world.has(Time);
world.remove(Time);
```

### Schedule — the frame

```ts
const sim = new Schedule() // { step: false } to skip the clock advance
  .add('movement', movement) // (world) => void
  .add('collide', collide, { after: 'movement' }) // before / after take a name or an array
  .add('reap', reap, { after: ['collide', 'movement'] });

sim.run(world); // world.step(), then every system in order
sim.order; // readonly string[] — the resolved order
sim.remove('reap'); // also has(name), clear(), size
```

`run` advances the clock once and calls each system with the world; per-frame
values like `dt` ride a trait, not a parameter. **Exactly one schedule per frame
may advance the clock** — a removal is visible for exactly one tick, so a second
`step()` can expire a `Removed()` record before a once-per-frame system sees it.
Give the others `{ step: false }`.

Order is resolved once per mutation and compiled into one direct call per system,
so `run` costs what writing the calls out by hand costs; a CSP without
`unsafe-eval` falls back to an array loop. Resolution disturbs registration
order as little as the constraints allow: two systems with no constraint between
them run in the order they were added. Dev throws on a duplicate name, a
constraint naming an unregistered system, a self-constraint, and a cycle;
production drops the offending edge and still runs every system exactly once.

The schedule does not call `world.flush()` — `each` and `chunks` already flush at
the outermost exit.

## Reads and writes

```ts
world.get(e, Position); // { x, y } — a COPY, allocates
world.get(e, Position, out); // writes into `out`, returns it — no allocation
world.get(e, Position.x); // number — no allocation
world.set(e, Position, { x: 5 }); // partial write, stamps the tick, fires 'change'
world.set(e, Position.x, 5);
world.markChanged(e, Position); // stamp the tick manually
```

### Accessors — per-entity access in the hot path

`get`/`set` resolve field → trait → archetype → column → page on every call. An
accessor does that once:

```ts
const px = world.accessor(Position.x); // memoised per (world, field)
px.get(e);
px.set(e, 5); // set stamps the tick, exactly like world.set
```

Use it for pathfinding, physics callbacks, networking — anything addressing
entities by handle in an order no query provides. The subject must be a **field**
or an AoS trait; struct traits, tags, and non-exclusive relations are rejected at
creation in dev. The accessor follows the entity through archetype moves, id
recycling, `compact()` and `clear()`.

## Queries

### Terms

```ts
world.query(Position, Velocity); // all of
world.query(Position, Not(Velocity)); // exclusion
world.query(Or(Velocity, Renderable)); // disjunction — modifiers nest
world.query(Position, With(IsActive)); // require, don't read
world.query(Position, Optional(Velocity)); // match either way; value may be null
world.query(Position, Changed(Position)); // pull-based change detection
world.query(Position, Added(Velocity));
world.query(Position, Removed(Velocity)); // valid for one tick after removal
world.query(Position, Cascade(ChildOf)); // hierarchy-depth ordered
```

**Only data-bearing terms contribute arguments** to `each` / `chunks`, enforced at
the type level:

| Term                                                         | `each` yields        |
| ------------------------------------------------------------ | -------------------- |
| struct trait                                                 | a reusable cursor    |
| AoS trait                                                    | the reference itself |
| tag, `Not`, `With`, `Changed`, `Added`, `Removed`, `Cascade` | _nothing_            |
| `Optional(T)`                                                | cursor or `null`     |

### Result surface

```ts
query.count   query.isEmpty   query.first
for (const e of query) …
query.each((…values, entity) => {})      // entity is always last; return false to stop
query.chunks()
query.entities()                          // snapshot copy — safe under mutation
query.sortBy(field, 'asc' | 'desc')       // → SortedQueryResult
query.sortBy((a, b) => number)            // comparator overload
world.queryFirst(...terms)                // sugar for query(...).first
world.createQuery(...terms)               // explicit hoist, identical cached object
```

`world.query` and `world.createQuery` return the **same cached object** for the
same term list. Only call `.dispose()` on a query you deliberately own — never on
one a hook or another system also holds.

**Query order carries no meaning.** If order is part of what you show, use
`sortBy`.

### Tier 2 — `each`

```ts
world.query(Position, Velocity).each((p, v) => {
  p.x += v.x * dt;
});
```

**Return `false` to stop the walk** — it is `break`, and the walk still closes
cleanly, so deferred work drains. The test is `=== false`, so neither a bare
`return` nor the number `(p, v) => (p.x += v.x * dt)` evaluates to stops one by
accident. There is no iterator form of this tier: `each` is it.

Cursors are **borrowed**: retaining one past the callback is a dev-mode error (the
cursor is poisoned on exit) and in production silently reads whatever row it was
last bound to. Cursor setters stamp the change tick when the trait is tracked;
untracked traits get a separate generated class and pay nothing.

Under a strict CSP without `unsafe-eval`, codegen falls back to a generic cursor
with index dispatch — same semantics, ~2–3× slower, detected once at module load.

### Tier 3 — `chunks`

```ts
for (const chunk of world.query(Position, Velocity).chunks()) {
  const { x, y } = chunk.get(Position); // cached typed-array views, no alloc
  const { x: vx, y: vy } = chunk.get(Velocity);
  for (let i = 0, n = chunk.length; i < n; i++) {
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
  chunk.markChanged(Position); // REQUIRED — setters were bypassed
}
```

```ts
interface Chunk<T> {
  length: number;
  entities: Float64Array; // packed handles, index-aligned with the columns
  get<S>(trait: Trait<S>): Store<S>;
  column<V>(field: Field<V>): TypedArrayFor<V>;
  entity(i: number): Entity;
  markChanged(trait: Trait, row?: number): void;
}
```

- Row `i` is the same entity in every column and in `entities`.
- A chunk never spans a page boundary; `length` may be short for the tail page.
- Views are valid **only for the current iteration step** — never retain them.
- No change tracking, no liveness checks. That is the trade.

### Sorted queries

`sortBy` is itself a cache lookup keyed on `(query signature, field, direction)`,
so calling it per frame is O(1). Sorting materialises the result, so a sorted
query supports iteration and `each` but **not `chunks`**.

| Dirty level | Trigger                  | Work on next access                      |
| ----------- | ------------------------ | ---------------------------------------- |
| `clean`     | nothing changed          | none                                     |
| `resort`    | a sort-key value changed | refresh keys, re-sort in place — O(n)    |
| `rebuild`   | the matching set changed | rebuild, refresh keys, sort — O(n log n) |

Resort is O(n) because the view keeps the previous permutation and TimSort is
adaptive on nearly-sorted input; keys are extracted once into a `Float64Array` so
the comparator never touches the entity index. Sorting is **stable** — which is
what stops equal-key sprites flickering between frames.

Escape hatches: `sorted.isDirty`, `sorted.invalidate()`, `sorted.rebuild()`.
Needed when the key is derived from something apecs can't see. The comparator
overload has no key column, so it is always treated as `resort`-dirty unless you
memoise it yourself.

## Relations

```ts
new Relation(); // tag relation
new Relation({ amount: 0 }); // relation with data
new Relation(undefined, { exclusive: true, onTargetDespawn: 'remove' | 'despawn' | 'orphan' });

world.add(child, Likes(other, { amount: 5 }));
world.has(child, ChildOf(parent));
world.has(child, ChildOf('*'));
world.target(e, ChildOf); // Entity (exclusive) — NULL_ENTITY when absent
world.targets(e, Likes); // Entity[] (non-exclusive)
world.get(e, Likes(other)); // relation data
```

**Storage strategy follows cardinality** and this is the make-or-break decision:

- **Exclusive** → target lives in a `Float64Array` column; one archetype
  regardless of parent count; `R(target)` served by an incremental target index
  (O(1) first, O(matches) all); re-targeting is a column write plus two index
  edits, **no archetype transition**.
- **Non-exclusive** → each `(relation, target)` interns a pair id into the
  archetype mask. Correct at low fan-out, pathological at high fan-out.

Cascading despawn is iterative with an explicit work queue and a visited set, so
deep hierarchies and cycles terminate cleanly.

`Cascade(R)` orders by hierarchy depth so parents are visited before children —
one linear pass instead of a recursive walk. Exclusive, acyclic relations only;
forces materialisation, so no `chunks`.

## Events and ticks

```ts
const off = world.on('add', Position, (entity) => {});
world.on('remove', Mesh, (e) => world.get(e, Mesh).dispose()); // fires BEFORE data is destroyed
world.on('change', Position, (entity) => {});
world.on('add', ChildOf, (entity, target) => {}); // relations pass the target
world.on('enter', world.query(Position, IsActive), (entity) => {});
world.on('exit', world.query(Position, IsActive), (entity) => {});
```

- Dispatched immediately, at the point of the operation, in registration order.
- For a batch, all handlers for entity _n_ fire before those for _n+1_.
- Dev throws on an observer cascade deeper than 32 levels.
- Registration is what allocates the change-tick column; a trait with no observers
  has no dispatch-site cost.

A trait becomes **tracked** on the first `'change'` subscription, the first `Changed()` /
`sortBy` usage, or `{ track: true }`. Tracked columns carry a per-row
`Uint32Array` of last-write ticks _and_ a scalar `lastWriteTick` (which is what
makes sorted memoisation O(matching archetypes)).

## Gotcha checklist

1. `world.get(e, Trait)` returns a **copy** and allocates. Use `out` or a field.
2. Cursors from `each` are borrowed — never retain past the callback.
3. Chunk writes bypass ticks. Call `chunk.markChanged(Trait)` — or
   `world.markChanged(e, Trait)` for one entity from outside a chunk — or
   `Changed()`, sorted views, and `'change'`-driven UI all silently miss the write.
4. Mutating any entity other than the current one during iteration, or spawning,
   requires `world.defer`.
5. Tags and `Not`/`With`/`Changed`/`Added`/`Removed` contribute **no** `each`
   argument. Count your callback parameters against the data-bearing terms only.
6. `world.add(T)` (no entity) targets the world entity — intentional, not a bug.
7. Never `.dispose()` a query that came from `world.query`.
8. Query iteration order is unspecified; use `sortBy` when order matters.
9. `world.target` returns `NULL_ENTITY` (`0`), not `undefined`.
10. Only `eid(0)` fields are patched on despawn. A bare `0` holding a handle
    dangles and will fail its liveness check.
11. Boxed columns (`string`, arrays, AoS) are not `SharedArrayBuffer`-shareable —
    relevant to how you shape traits today, for v2 worker parallelism.

## Limits

| Limit                               | Value                      |
| ----------------------------------- | -------------------------- |
| Entities per world                  | 2³² − 2                    |
| Generations before id retirement    | 4096                       |
| Worlds alive simultaneously         | 256                        |
| Traits per world / fields per trait | unbounded                  |
| Page size                           | power of two, default 4096 |
