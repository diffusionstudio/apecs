# apecs — Specification

> A high-performance archetype ECS for TypeScript.
> Status: **draft v0.1** — design frozen enough to implement against.

---

## 1. Goals

1. **Iteration speed first.** The common case — "walk every entity matching a set of traits and do arithmetic on their fields" — must compile down to a linear scan over typed arrays.
2. **Zero allocation in the hot path.** No object churn per entity per frame. No proxies on the fast path. No garbage.
3. **Ergonomics that do not cost speed.** Three access tiers, each with an honest, documented cost.
4. **Traits are global, worlds are isolated.** A trait declared once at module scope works in any number of worlds with no data collision.
5. **SAB-ready.** The storage layout must permit `SharedArrayBuffer` backing and worker-parallel chunk dispatch later without an API break.

### Non-goals for v1

- No scheduler. Systems are plain functions; the user owns the loop.
- No worker parallelism (the layout permits it; the API does not expose it).
- No serialization module (the layout makes it cheap; it ships later).
- No rendering, physics, input, or asset integration.

---

## 2. Concepts

| Concept | What it is |
|---|---|
| **Trait** | A named, typed piece of data (or a tag). Declared once globally. |
| **Field** | One column of a trait. First-class and addressable: `Position.x`. |
| **Entity** | A 52-bit packed number identifying a row. Not an object. |
| **World** | An isolated container of entities, archetypes, and trait storage. |
| **Archetype** | The set of entities sharing exactly one trait set. Owns the columns. |
| **Query** | A cached, incrementally-maintained list of matching archetypes. |
| **Relation** | A trait parameterised by a target entity. |

---

## 3. Traits

### 3.1 Declaration

```ts
import { Trait, f32, u16 } from 'apecs'

// SoA struct trait — one column per field
const Position = new Trait({ x: f32(0), y: f32(0) })

// SoA scalar trait — one column
const Rotation = new Trait(0)

// Tag — no data, no column
const IsActive = new Trait()

// AoS trait — factory returning a reference; one boxed column
const Mesh = new Trait(() => new THREE.Mesh())
```

The argument carries **both the shape and the defaults**. Every entity that gains the trait without an explicit value gets a copy of the defaults (AoS traits call the factory once per entity).

### 3.2 Field types

Bare JavaScript values infer a storage type. Branded markers override it. All markers type as their underlying primitive, so `Position.x` is `number` to TypeScript.

| Declaration | Column | Notes |
|---|---|---|
| `0` | `Float64Array` | default for numbers |
| `f32(0)`, `f64(0)` | `Float32Array`, `Float64Array` | |
| `i8/i16/i32(0)` | `Int8Array`, `Int16Array`, `Int32Array` | |
| `u8/u16/u32(0)` | `Uint8Array`, `Uint16Array`, `Uint32Array` | |
| `false` | `Uint8Array` | `0`/`1`, exposed as `boolean` |
| `''` | `Array<string>` | boxed |
| `eid(0)` | `Float64Array` | entity handle; auto-patched on despawn (§8.5) |
| plain object | flattened | `{ pos: { x: 0 } }` → column `pos.x` |
| anything else | `Array<T>` | boxed; dev-mode warning suggesting an AoS trait |

Field order in the schema is the column order and is stable — it is part of the serialization contract.

### 3.3 Fields are values

A `Trait` instance exposes **its fields and nothing else** as string-keyed properties. All operations live on `World`, so no method name can ever collide with a schema key. Internals are symbol-keyed.

```ts
Position.x            // Field<number>
Rotation              // scalar traits are their own Field
Mesh                  // AoS traits are their own Field
```

Fields address a single column and are accepted everywhere a trait is, when a single value is wanted:

```ts
world.get(e, Position.x)              // number — zero allocation
world.set(e, Position.x, 20)
world.query(Position).sortBy(Position.x, 'asc')
```

### 3.4 Trait instances

A trait is **callable**. Calling it produces a *trait instance* — a trait paired with an initial value — for use in `spawn` and `add`.

```ts
Position({ x: 20, y: 10 })    // partial; unspecified fields take the default
Rotation(Math.PI)             // scalar
Mesh(existingMesh)            // AoS: adopt an existing reference instead of calling the factory
IsActive                      // tags are passed bare
```

Implementation note: `new Trait(...)` returns a function with the `Trait` prototype installed, so `instanceof Trait` holds and the object is callable.

### 3.5 Options

```ts
new Trait(schema, {
  storage: 'table' | 'sparse',   // default 'table'
  track: boolean,                // force change-tick allocation, default false (auto)
})
```

- **`table`** (default) — the trait's columns live inside each archetype. Dense, linear iteration. Adding or removing the trait moves the entity's row between archetypes.
- **`sparse`** — the trait lives in one world-global sparse set outside the archetype graph. Adding or removing it does **not** move the row and does **not** create an archetype. Iteration costs one indirection per access.

Choose `sparse` for traits with very high add/remove churn, very large payloads, or a huge fan-out of distinct combinations. Everything else stays `table`.

---

## 4. Entities

### 4.1 Representation

`Entity` is a **branded `number`**, not an object. Handles are globally unique across worlds.

```
bit  51 ......... 44 43 .......... 32 31 ................ 0
     [ world :  8 ][ generation: 12 ][      id : 32      ]
```

- `id = e >>> 0` — a single machine op, and it is the hot path.
- `hi = (e / 2**32) | 0`, then `generation = hi & 0xFFF`, `world = hi >>> 12`.
- Total 52 bits — comfortably inside `Number.MAX_SAFE_INTEGER`.
- `0` is `NULL_ENTITY`. Ids start at `1`; id `1` is reserved for the world entity (§5.4), so user entities start at `2`.

Consequences worth having:

- Passing a world-A handle to world-B is **detectable**, not silently corrupting.
- A stale handle from a despawned entity fails the generation check instead of aliasing a recycled row.
- Query results are dense `Float64Array`s of packed handles — no pointer chasing, no repacking.

Generation wraps at 4096 recycles; on wrap the id is **retired** rather than reused, so a stale handle can never alias.

### 4.2 Lifecycle

```ts
const e = world.spawn(Position({ x: 20 }), Rotation, IsActive)
world.isAlive(e)          // boolean — generation-checked
world.despawn(e)          // immediate; generation bumped, id queued for recycling
```

`world.despawn` is deliberately not `world.destroy`, which nukes the world itself (§5.5).

Ids recycle **FIFO** so a freed id is not immediately reissued — stale-handle bugs surface as failed liveness checks rather than as silent aliasing.

### 4.3 Bulk operations

Every structural operation has a batch form that performs **one** archetype transition for the whole set instead of N.

```ts
const swarm = world.spawnMany(10_000, Position, Velocity)   // Float64Array of handles
world.addMany(swarm, IsActive)
world.removeMany(swarm, Velocity)
world.despawnMany(swarm)
world.despawnMany(world.query(Dead))                        // a query is a valid batch
```

This is a 10–50× win over the naive loop on spawn-heavy workloads and is a first-class part of the API, not an optimisation afterthought.

### 4.4 Per-entity operations

```ts
world.add(e, Position({ x: 1 }), IsActive)
world.remove(e, Velocity)
world.has(e, Position)                 // boolean
world.get(e, Position)                 // { x, y } — allocates a copy
world.get(e, Position.x)               // number — no allocation
world.get(e, Position, out)            // writes into `out`, returns `out` — no allocation
world.set(e, Position, { x: 5 })       // partial write, fires onChange
world.set(e, Position.x, 5)
```

`world.get` on a struct trait returns a **copy**, not a live view. It is a cold-path convenience: use it in UI, editors, and React bindings, not in systems.

---

## 5. Worlds

### 5.1 Creation

```ts
const world = new World()

const world = new World({
  pageSize: 4096,        // rows per column page; power of two
  maxEntities: 1 << 20,  // pre-sizes the entity index; grows if exceeded
})
```

### 5.2 Inheritance

`World` is a plain class with prototype methods. Subclassing is supported and is the intended extension mechanism.

```ts
class GameWorld extends World {
  readonly rng = new Rng(1234)

  constructor() {
    super({ pageSize: 8192 })
    this.add(Time)
  }

  spawnPlayer(x: number, y: number) {
    return this.spawn(Position({ x, y }), Velocity, IsPlayer)
  }
}
```

Rules: `super()` must be called before any world method; no world method is a bound closure, so every one of them is overridable; internal state is symbol- or `#private`-keyed and will not collide with subclass fields.

### 5.3 Trait isolation across worlds

A trait declared at module scope carries a **global id** used only for identity. Each world independently assigns the trait a **dense local id** on first use, and allocates storage lazily.

This matters: a project may declare thousands of traits globally, but a world that uses twelve of them keeps twelve-bit archetype masks, not thousand-bit ones.

```ts
const Position = new Trait({ x: 0, y: 0 })   // one declaration

const a = new World()
const b = new World()
a.spawn(Position({ x: 1 }))
b.spawn(Position({ x: 2 }))                  // fully independent storage
```

A trait never used in a world costs that world nothing.

### 5.4 World traits

**The world is an entity.** Id `1` in every world is the world entity. World traits are ordinary traits on that entity, which means they get observers, change ticks, typing, and queryability for free.

```ts
const Time = new Trait({ delta: 0, current: 0 })

world.add(Time)
world.set(Time, { delta: 0.016 })
world.get(Time)          // { delta, current }
world.get(Time.delta)    // number — no allocation
world.has(Time)          // boolean
world.remove(Time)
world.entity              // the world entity handle, if you want it explicitly
```

Overload resolution is unambiguous because `Entity` is a `number` and traits are objects: `world.add(T)` targets the world, `world.add(e, T)` targets an entity.

### 5.5 Destruction

```ts
world.destroy()
```

Despawns every entity (firing `onRemove` for each), drops all archetypes and columns, unsubscribes all observers, and **releases the world id** for reuse. Any subsequent call on the world throws in dev builds and is undefined behaviour in production builds.

Because the world id is packed into every handle, handles minted by a destroyed world will fail liveness checks against the world that later reuses that id — with the caveat that the check is id-based, not instance-based, so an 8-bit world id wrapping around after 256 world creations is the practical limit of that guarantee.

```ts
world.clear()   // despawn everything, keep the world, keep archetypes warm
```

---

## 6. Queries

### 6.1 Terms

```ts
world.query(Position, Velocity)               // all of
world.query(Position, Not(Velocity))          // exclusion
world.query(Or(Velocity, Renderable))         // disjunction
world.query(Position, With(IsActive))         // require, but do not read
world.query(Position, Optional(Velocity))     // match either way; value may be null
world.query(Position, Changed(Position))      // pull-based change detection
world.query(Position, Added(Velocity))
world.query(Position, Removed(Velocity))
world.query(Position, Cascade(ChildOf))       // hierarchy-depth ordered (§7.6)
```

Modifiers nest: `Or(Not(A), B)`. The term list is evaluated as a boolean expression against each archetype's mask at archetype-creation time, so per-frame matching cost is zero.

**Only data-bearing terms contribute arguments** to `each` and `chunks`. Tags, `Not`, and `With` contribute none. `Optional` contributes a possibly-null one. This is enforced at the type level (§11).

### 6.2 Caching

`world.query(...)` is **O(1) after the first call.** The term list is hashed; the same `QueryResult` object is returned for the same signature. Queries subscribe to archetype creation and maintain their matching-archetype list incrementally. Calling `world.query(Position, Velocity)` every frame inside a system is the intended usage.

```ts
const movers = world.createQuery(Position, Velocity)   // explicit hoist, identical object
movers.dispose()                                        // drop from the cache
```

### 6.3 Result surface

```ts
interface QueryResult<T extends Term[]> {
  readonly count: number
  readonly isEmpty: boolean
  readonly first: Entity | undefined

  [Symbol.iterator](): Iterator<Entity>
  each(fn: (...args: [...Values<T>, Entity]) => void): void
  chunks(): Iterable<Chunk<T>>
  entities(): Float64Array         // snapshot copy — safe under mutation
  sortBy(field: Field, dir?: 'asc' | 'desc'): QueryResult<T>
  sortBy(cmp: (a: Entity, b: Entity) => number): QueryResult<T>
}
```

`world.queryFirst(...)` is sugar for `world.query(...).first`.

### 6.4 Tier 1 — entities

The simplest form. Yields packed handles; read values through the world.

```ts
for (const entity of world.query(Position)) {
  const p = world.get(entity, Position)        // allocates a copy
  const x = world.get(entity, Position.x)      // no allocation
}
```

Cost: one entity-index lookup per `get`. Fine for hundreds of entities, wrong for tens of thousands.

### 6.5 Tier 2 — `each` with cursors

The ergonomic default. Values arrive as **reused cursor objects** with accessors generated per trait at declaration time:

```js
class PositionCursor {
  get x()  { return this.__x[this.__i] }
  set x(v) { this.__x[this.__i] = v }
}
```

Bound once per page, incremented per row. V8 inlines these to direct typed-array access after warmup: roughly **1.1–1.5× the cost of a raw loop**, with zero allocation — versus 5–20× for a `Proxy`-based approach and unbounded GC pressure for a copy-based one.

```ts
world.query(Position, Velocity).each((p, v) => {
  p.x += v.x * dt
  p.y += v.y * dt
})

world.query(Position, Velocity).each((p, v, entity) => { /* handle last */ })
```

**What arrives depends on the trait kind** — the rule is *you always receive something you can write through*:

| Trait kind | `each` yields | Write |
|---|---|---|
| struct (`{ x, y }`) | reusable cursor | `p.x = 1` |
| scalar primitive (`0`) | reusable `Ref` | `r.value += dt` (`r.$` is an alias) |
| AoS (factory) | the reference itself | `mesh.position.set(...)`; replace via `world.set` |
| tag / `Not` / `With` | *nothing* | — |
| `Optional(T)` | cursor or `null` | — |

Cursors are **borrowed**. Retaining one past the callback is a dev-mode error (the cursor is poisoned on exit); in production it silently reads whatever row the cursor was last bound to.

Cursor setters also write the change tick when the trait is tracked (§8.3). Two cursor classes are generated per trait — tracked and untracked — and the query picks one at build time, so untracked traits pay nothing.

**Codegen fallback.** Accessor classes are built with `new Function`. Under a strict CSP without `unsafe-eval`, apecs falls back to a generic cursor with a field-index dispatch — same semantics, roughly 2–3× slower. The fallback is detected once at module load.

### 6.6 Tier 3 — `chunks`

Maximum speed. A chunk is one page of one matching archetype; columns arrive as typed arrays you index directly.

```ts
for (const chunk of world.query(Position, Velocity).chunks()) {
  const p = chunk.get(Position)      // { x: Float32Array, y: Float32Array } — cached view, no alloc
  const v = chunk.get(Velocity)
  const { x, y } = p
  const { x: vx, y: vy } = v

  for (let i = 0, n = chunk.length; i < n; i++) {
    x[i] += vx[i] * dt
    y[i] += vy[i] * dt
  }

  chunk.markChanged(Position)        // setters were bypassed — mark explicitly
}
```

```ts
interface Chunk<T extends Term[]> {
  readonly length: number
  readonly entities: Float64Array           // packed handles, chunk-local, index-aligned
  get<S>(trait: Trait<S>): Store<S>         // per-field typed array views for this page
  column<V>(field: Field<V>): TypedArrayFor<V>
  entity(i: number): Entity
  markChanged(trait: Trait, row?: number): void   // whole chunk, or one row
}
```

Guarantees the chunk API relies on:

- All columns of a chunk are **index-aligned**: row `i` is the same entity in every column and in `entities`.
- A chunk never spans a page boundary, so views are always contiguous.
- `chunk.length` may be less than `pageSize` for the tail page of an archetype.
- Views returned by `get`/`column` are valid **only for the current iteration step**. Do not retain them across chunks.

This tier does no change tracking and performs no liveness checks. That is the trade.

### 6.7 Sorted queries

```ts
const SortIndex = new Trait(0)
for (const e of world.query(Position).sortBy(SortIndex, 'asc')) { }
```

Sorting necessarily materialises the result into a flat array, which breaks chunk iteration — a sorted query supports Tier 1 and `each`, not `chunks`.

The sorted array is **cached and invalidated** on (a) any structural change to a matching archetype, or (b) a change tick bump on the sort key's column. A static sort therefore costs nothing on frames where nothing moved; sorting the key trait automatically marks it tracked.

`sortBy` returns a distinct cached `QueryResult`, so the unsorted query is unaffected.

---

## 7. Relations

A relation is a trait parameterised by a target entity.

### 7.1 Declaration

```ts
const ChildOf = new Relation()                                    // tag relation
const Likes   = new Relation({ amount: 0 })                       // relation with data

const ChildOf = new Relation(undefined, {
  exclusive: true,              // an entity has at most one target
  onTargetDespawn: 'despawn',   // 'remove' (default) | 'despawn' | 'orphan'
})
```

### 7.2 Usage

```ts
const parent = world.spawn()
const child  = world.spawn(ChildOf(parent))

world.add(child, Likes(other, { amount: 5 }))
world.remove(child, ChildOf(parent))
world.has(child, ChildOf(parent))
world.has(child, ChildOf('*'))          // any target
```

### 7.3 Querying

```ts
world.queryFirst(ChildOf(parent))       // the first child of `parent`
world.query(ChildOf(parent))            // all children of `parent`
world.query(ChildOf('*'))               // every entity that has a parent
world.query(Position, Not(ChildOf('*'))) // roots

world.target(e, ChildOf)                // Entity | NULL_ENTITY  (exclusive)
world.targets(e, Likes)                 // Iterable<Entity>      (non-exclusive)
world.get(e, Likes(other))              // { amount } — relation data
```

### 7.4 Storage — avoiding archetype explosion

This is the part that makes or breaks a relation implementation. If every `(relation, target)` pair becomes a distinct component id, a scene with 10 000 parents produces 10 000 archetypes holding one entity each, and every query degenerates.

apecs uses **two storage strategies, chosen by cardinality**:

**Exclusive relations store the target in a column.** The archetype records only "has `ChildOf`"; the target lives in a `Float64Array` column alongside the relation's data columns.

- One archetype, regardless of how many distinct parents exist.
- `ChildOf('*')` is a plain archetype match.
- `ChildOf(parent)` is served by a **target index** — a `Map<target, EntityList>` maintained incrementally on add/remove/despawn — making `queryFirst(ChildOf(parent))` O(1) and `query(ChildOf(parent))` O(matches).
- Re-targeting (`add(child, ChildOf(newParent))`) is a column write plus two index edits. **No archetype transition at all.**

**Non-exclusive relations use pair ids in the archetype mask.** Each distinct `(relation, target)` interns to a trait-like local id and participates in matching normally. This is correct when target cardinality is low (`Likes`, `Owes`, `TargetedBy`) and is the only way to express "matches entities related to *these two specific* targets" as a single archetype match.

Dev builds warn when a non-exclusive relation exceeds a configurable distinct-pair threshold, suggesting `exclusive: true` or `storage: 'sparse'`.

### 7.5 Target lifecycle

When a target entity is despawned, every entity holding a relation to it is resolved according to `onTargetDespawn`:

| Policy | Effect |
|---|---|
| `'remove'` (default) | the relation is removed from the source entity |
| `'despawn'` | the source entity is despawned too, recursively |
| `'orphan'` | the relation is kept with a dead target; `world.target` returns it, `isAlive` is false |

Cascading despawn is **iterative, not recursive** — it uses an explicit work queue, so a 100 000-node hierarchy will not blow the JS stack. Cycles are detected via a visited set and terminate cleanly.

### 7.6 Traversal — `Cascade`

```ts
world.query(Position, LocalTransform, Cascade(ChildOf)).each((pos, local) => {
  // parents are guaranteed to have been visited before their children
})
```

`Cascade(R)` orders results by hierarchy depth. This turns transform propagation into a single linear pass instead of a recursive walk with repeated work, and it is the reason to have relations in the engine rather than in userland.

Depth is maintained incrementally: an entity's depth is `depth(target) + 1`, recomputed for a subtree when its relation changes. Only valid on exclusive, acyclic relations; dev builds throw on a detected cycle.

`Cascade` forces materialisation, so like `sortBy` it supports Tier 1 and `each` but not `chunks`.

---

## 8. Events and change detection

Two mechanisms, deliberately separate, because they answer different questions.

### 8.1 Observers — push

```ts
const unsubAdd    = world.onAdd(Position, (entity) => {})
const unsubRemove = world.onRemove(Mesh, (entity) => { world.get(entity, Mesh).dispose() })
const unsubChange = world.onChange(Position, (entity) => {})

const unsub = world.onAdd(ChildOf, (entity, target) => {})   // relations pass the target
```

- `entity` is always defined. `target` is defined for relations and `undefined` otherwise.
- Handlers are dispatched **immediately**, at the point of the operation, before it returns. No hidden latency, no frame boundary to reason about.
- Handlers fire for observers registered on a *relation* regardless of target; register on `R(target)` to observe one pair.
- `onRemove` fires **before** the data is destroyed, so the handler can still read it — this is what makes it usable for resource disposal.
- Registration is free when nobody is listening: a trait with no observers has no dispatch site cost, and observation is what allocates the change-tick column.

### 8.2 Query enter / exit

Often what you actually want is "an entity started/stopped matching this whole query", not "one trait changed":

```ts
const unsub = world.onEnter(world.query(Position, IsActive), (entity) => {})
const unsub = world.onExit(world.query(Position, IsActive), (entity) => {})
```

Cheap, because archetype transitions already compute exactly this.

### 8.3 Change ticks — pull

The world holds a monotonic `world.tick`, incremented by `world.step()` (or manually). Every tracked column carries a parallel `Uint32Array` of last-written ticks.

```ts
world.step()                     // ++tick

world.query(Position, Changed(Position)).each((p) => { /* only entities written since last run */ })
world.query(Added(Velocity))
world.query(Removed(Velocity))   // valid for one tick after removal
```

Each `Changed`/`Added`/`Removed` query stores its own last-seen tick, so two systems observing the same trait do not steal each other's events.

Ticks are written by `world.set` and by cursor setters. **Direct chunk writes bypass them** — call `chunk.markChanged(trait)` or `world.changed(e, trait)`.

Tick columns are allocated only for **tracked** traits: a trait becomes tracked on the first `onChange` subscription, the first `Changed()`/`sortBy` usage, or `{ track: true }`. Untracked traits pay nothing per write.

At scale, prefer pull over push: `Changed()` is a linear scan of a `Uint32Array` with no call overhead, whereas `onChange` is a call per write.

### 8.4 Ordering and reentrancy

- Observers for one trait fire in registration order.
- For a batch operation, all `onAdd` handlers for entity *n* fire before those for entity *n+1*.
- Structural changes performed **inside** an observer are applied immediately, but the currently-iterating query is protected by the rules in §9.
- Reentrancy is bounded: dev builds throw on an observer cascade deeper than 32 levels, which is otherwise an infinite-loop-shaped bug.

### 8.5 Dangling entity references

Fields declared with `eid(0)` store an entity handle, and apecs knows they do:

```ts
const Following = new Trait({ target: eid(0) })
```

On despawn, the entity's id is looked up in a reverse index of `eid` columns and every stored reference is patched to `NULL_ENTITY`. This is opt-in per field via the marker — a bare `0` holding a handle is not patched, and will simply fail its liveness check when read.

---

## 9. Structural change during iteration

The classic ECS footgun, specified explicitly.

**Archetypes iterate back-to-front with swap-remove semantics.** The consequence:

| Operation during iteration | Safe? |
|---|---|
| Reading/writing trait values on any entity | ✅ |
| Adding/removing traits on **the current entity** | ✅ |
| Despawning **the current entity** | ✅ |
| Adding/removing/despawning **any other** entity | ⚠️ requires deferral |
| Spawning entities | ⚠️ requires deferral |

For the unsafe cases:

```ts
world.query(Position).each((p, e) => {
  if (p.y < 0) world.defer(() => world.spawn(Splash({ at: e })))
})
// implicit world.flush() at the end of each() / chunks()
```

- `world.defer(fn)` queues a closure; `world.flush()` drains the queue in FIFO order.
- `each` and `chunks` flush automatically when the outermost iteration completes. Nested iteration flushes once, at the outermost exit.
- `query.entities()` returns a snapshot copy and is always safe — the escape hatch when the deferral model is inconvenient.

Dev builds detect unsafe mutation by stamping a structural-version counter on each archetype and asserting it is unchanged across an iteration step. Production builds omit the check.

---

## 10. Internal architecture

### 10.1 Archetype graph

Each archetype owns a trait mask and edge maps `add: Map<localTraitId, Archetype>` and `remove: Map<localTraitId, Archetype>`. A structural change is an edge lookup, then a row move. Edges are created lazily on first traversal and cached forever, so a repeated add/remove pattern costs two `Map` gets.

Masks are `Uint32Array` blocks over **dense local trait ids** (§5.3), growing a block at a time.

### 10.2 Paged columns

Each archetype stores its columns as an array of pages of `pageSize` rows:

```
Archetype(Position, Velocity)
  entities: [ Float64Array(4096), Float64Array(4096), ... ]
  columns:
    Position.x: [ Float32Array(4096), Float32Array(4096), ... ]
    Position.y: [ ... ]
    Velocity.x: [ ... ]
```

- Growth appends a page. **Existing pages are never reallocated**, so views handed to user code cannot be invalidated by growth mid-frame.
- Removal is swap-remove with the last row of the last page; the entity index of the moved row is patched.
- Empty tail pages are retained by default and released by `world.compact()`.
- Pages are the unit of chunk iteration and are the natural unit of a future worker dispatch — one page per task, no false sharing at page boundaries.

### 10.3 Entity index

A single world-level structure maps id → `{ archetype, row, generation }`, stored as parallel typed arrays (`Uint32Array` archetype id, `Uint32Array` row, `Uint16Array` generation) rather than objects. Liveness is a generation compare; lookup is two array reads.

### 10.4 Query matching

A query compiles its term list into a boolean predicate over archetype masks once. It holds a list of matching archetypes and a subscription to archetype creation; each new archetype is tested once, at creation, against every live query. Per-frame matching cost is therefore **zero** — iteration walks a pre-computed archetype list.

### 10.5 SAB readiness

Nothing in the table storage path holds a JS object: columns are typed arrays, the entity index is typed arrays, archetype identity is an integer. Swapping a page's backing store from `ArrayBuffer` to `SharedArrayBuffer` is a constructor change. What v2 adds is a dispatcher and a trait-level read/write declaration for conflict detection — not a storage rewrite.

Boxed columns (`string`, `Array<T>`, AoS traits) are inherently non-shareable and will be excluded from parallel systems. That constraint is worth knowing while designing traits today.

---

## 11. TypeScript

The typing is load-bearing — it is what makes three access tiers usable rather than error-prone.

```ts
type Schema = Record<string, unknown> | number | boolean | string | (() => unknown)

class Trait<S extends Schema> {
  (value?: Init<S>): TraitInstance<S>
}

type Value<S>  = S extends () => infer R ? R
               : S extends object ? { [K in keyof S]: Unmark<S[K]> }
               : Unmark<S>

type Cursor<S> = S extends () => infer R ? R
               : S extends object ? { -readonly [K in keyof S]: Unmark<S[K]> }
               : Ref<Unmark<S>>

type Store<S>  = { readonly [K in keyof S]: TypedArrayFor<S[K]> }
```

Query argument extraction filters non-data terms and maps the rest:

```ts
type Values<T extends Term[]> =
  T extends [infer H, ...infer R extends Term[]]
    ? H extends Trait<infer S> ? (IsTag<S> extends true ? Values<R> : [Cursor<S>, ...Values<R>])
    : H extends Optional<Trait<infer S>> ? [Cursor<S> | null, ...Values<R>]
    : Values<R>                                  // Not / With / Changed / Added / Removed
    : []
```

Requirements the implementation must satisfy:

- Field markers (`f32(0)`) type as `number`, so schemas read naturally and cursors are plain typed objects.
- `world.get(e, Position)` is `{ x: number, y: number }`; `world.get(e, Position.x)` is `number`.
- `Position({ z: 1 })` is a compile error; `Position({ x: 1 })` is a valid partial.
- `Mesh` typed as `Trait<() => THREE.Mesh>` yields `THREE.Mesh` from `get`, `each`, and `chunk.get`.
- `each` callback parameters are positionally typed with no casts, including the trailing `entity`.
- `Entity` is `number & { readonly __entity: unique symbol }` — arithmetic on a handle is a type error.

---

## 12. Performance

### 12.1 Budget

Targets, not measurements — the spec commits to publishing the numbers, and to failing CI on regression beyond a threshold.

| Benchmark | Target |
|---|---|
| `packed-5` (5 traits, 1 000 entities, iterate all) | ≥ parity with the fastest JS ECS measured |
| `simple-iter` (100 000 entities, 2 traits, arithmetic) | within 1.5× of a hand-written typed-array loop via `each`; within 1.1× via `chunks` |
| `frag-iter` (26 archetypes, 100 000 entities) | linear in matching archetypes, no per-archetype fixed cost above ~200ns |
| `entity-cycle` (spawn/despawn 100 000) | no allocation after warmup; steady-state GC pressure ≈ 0 |
| `add-remove` (100 000 trait add + remove) | two `Map` lookups plus one row move per operation |

Comparison set: bitECS, koota, becsy, and a hand-written baseline. The hand-written baseline is the one that matters.

### 12.2 Rules the implementation must not break

1. No allocation in `each` or `chunks` after warmup — asserted by a heap-delta test in CI.
2. No megamorphic call sites in the iteration path: cursor classes are per-trait, not shared.
3. No `Proxy` anywhere in the hot path.
4. No generator functions in the hot path — `chunks()` returns a reusable iterator object with a monomorphic `next`.
5. Dev-only assertions are behind `__DEV__` and dropped entirely by the production build.

### 12.3 Limits

| Limit | Value | Reason |
|---|---|---|
| Entities per world | 2³² − 2 | 32-bit id field |
| Generations before id retirement | 4096 | 12-bit generation field |
| Worlds alive simultaneously | 256 | 8-bit world field |
| Traits per world | unbounded | masks grow a 32-bit block at a time |
| Fields per trait | unbounded | one column each |
| Page size | power of two, default 4096 | |

---

## 13. Worked example

```ts
import { World, Trait, Relation, Changed, f32 } from 'apecs'

const Position  = new Trait({ x: f32(0), y: f32(0) })
const Velocity  = new Trait({ x: f32(0), y: f32(0) })
const Health    = new Trait(100)
const Mesh      = new Trait(() => new THREE.Mesh())
const IsEnemy   = new Trait()
const Time      = new Trait({ delta: 0, current: 0 })
const ChildOf   = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })

class Game extends World {
  constructor() {
    super()
    this.add(Time)
    this.onRemove(Mesh, (e) => this.get(e, Mesh).geometry.dispose())
  }
}

const world = new Game()

const player = world.spawn(Position({ x: 20, y: 10 }), Velocity, Mesh)
const weapon = world.spawn(Position, Mesh, ChildOf(player))
world.spawnMany(5_000, Position, Velocity, Health, IsEnemy)

function movement(world: Game) {
  const dt = world.get(Time.delta)
  for (const chunk of world.query(Position, Velocity).chunks()) {
    const { x, y } = chunk.get(Position)
    const { x: vx, y: vy } = chunk.get(Velocity)
    for (let i = 0, n = chunk.length; i < n; i++) {
      x[i] += vx[i] * dt
      y[i] += vy[i] * dt
    }
    chunk.markChanged(Position)
  }
}

function reap(world: Game) {
  world.query(Health, IsEnemy).each((hp, e) => {   // IsEnemy is a tag — no argument
    if (hp.value <= 0) world.defer(() => world.despawn(e))
  })
}

function sync(world: Game) {
  world.query(Position, Mesh, Changed(Position)).each((p, mesh) => {
    mesh.position.set(p.x, p.y, 0)
  })
}

function frame(dt: number) {
  world.step()
  world.set(Time, { delta: dt, current: world.get(Time.current) + dt })
  movement(world)
  reap(world)
  sync(world)
}
```

---

## 14. API surface

```ts
// traits
new Trait(schema?, options?)
new Relation(schema?, options?)
f32 f64 i8 i16 i32 u8 u16 u32 bool str eid

// modifiers
Not(term) Or(...terms) With(trait) Optional(trait)
Added(trait) Removed(trait) Changed(trait) Cascade(relation)

// world
new World(options?)
world.entity  world.tick  world.step()
world.destroy()  world.clear()  world.compact()

// entities
world.spawn(...instances): Entity
world.spawnMany(n, ...instances): Float64Array
world.despawn(e)  world.despawnMany(batch)
world.isAlive(e)

// data
world.add(e?, ...instances)      world.addMany(batch, ...instances)
world.remove(e?, ...traits)      world.removeMany(batch, ...traits)
world.has(e?, trait): boolean
world.get(e?, traitOrField, out?)
world.set(e?, traitOrField, value)
world.changed(e, trait)
world.target(e, relation)        world.targets(e, relation)

// queries
world.query(...terms): QueryResult
world.createQuery(...terms): QueryResult
world.queryFirst(...terms): Entity | undefined

// events
world.onAdd(trait, fn): () => void
world.onRemove(trait, fn): () => void
world.onChange(trait, fn): () => void
world.onEnter(query, fn): () => void
world.onExit(query, fn): () => void

// deferral
world.defer(fn)  world.flush()
```

---

## 15. Deferred to v2

Listed here because the v1 design must not foreclose them.

- **Worker parallelism.** SAB-backed pages, trait-level read/write declarations, page-granular dispatch. §10.5 is the enabling work.
- **Scheduler.** `apecs/schedule` — systems as functions with `before`/`after` constraints and stages. Kept out of core on purpose.
- **Serialization.** `world.snapshot()` / `world.restore()` as column copies; tick-based network deltas fall out of §8.3 for free. Boxed and AoS columns need user-supplied codecs.
- **Devtools.** An archetype/query inspector fed by the same archetype-creation subscription queries use.
- **Prefabs.** A named archetype template with default values, spawned via a single row memcpy.

---

## 16. Open questions

1. **Scalar cursor ergonomics.** `r.value += dt` for primitive scalar traits is the one place where the API grates. `r.$` is offered as an alias. The alternative — making scalar traits read-only in `each` — is more consistent but more limiting.
2. **`world.get` copy semantics.** Returning a copy is safe and predictable but allocates. The `out` parameter covers the hot case; whether a pooled default `out` is worth the aliasing hazard is unresolved.
3. **World-id exhaustion.** 8 bits gives 256 concurrently-alive worlds and, after id reuse, a stale-handle guarantee that degrades. If short-lived worlds are a real usage pattern (tests, level loading), the field may need widening at the cost of the id or generation field.
4. **Non-exclusive relation cardinality.** The pair-id strategy is correct at low fan-out and pathological at high fan-out. The dev-mode warning is a stopgap; an automatic promotion to indexed storage may be warranted.
