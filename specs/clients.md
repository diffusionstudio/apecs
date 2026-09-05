# apecs clients — Specification

The framework bindings: `apecs/react` and `apecs/solid`. Section references of the
form §n point at [SPEC.md](SPEC.md); references within this document are written
§C.n.

Core is the source of truth for semantics. This document specifies only what the
bindings add: how a mutable, frame-rate-decoupled world is projected into a
framework's reactive model without dragging the DOM along at simulation rate.

---

## C.1 Goals

1. **Value-gated updates.** A binding notifies a framework when a _value_ changes,
   never merely when a write happened. A simulation that writes `Position.x = 4`
   sixty times between paints produces zero re-renders.
2. **Frame-decoupled.** The canvas may run far above the display's refresh rate,
   or on a fixed timestep unrelated to it. The DOM must not follow. Updates
   coalesce to at most one per animation frame.
3. **No cost to systems that do not use them.** A world with no mounted hooks pays
   nothing. A world with hooks pays one map lookup per write to an observed trait
   (§C.3.4) and the tracking cost core already charges for `'change'` (§C.3.5).
4. **One version, one build.** The bindings are subpath entries of `apecs`, not
   sibling packages, so there is no core/binding version matrix (§C.2).

### Non-goals for v1

- Rendering. The bindings expose state; they draw nothing.
- Iteration APIs in components. `each` and `chunks` are for systems (§6.5, §6.6).
  UI that needs them belongs in an imperative hook (§C.7), not in render.
- Writing through reactivity. There is no two-way binding. Writes go through
  `world.set` or an accessor (§C.5.3, §C.6.1).

---

## C.2 Packaging

One package, four entry points.

| specifier        | entry                | peer             |
| ---------------- | -------------------- | ---------------- |
| `apecs`          | `src/index.ts`       | —                |
| `apecs/react`    | `src/react/index.ts` | `react >=18`     |
| `apecs/solid`    | `src/solid/index.ts` | `solid-js >=1.8` |
| `apecs/internal` | `src/internal.ts`    | —                |

Both peers are `optional`, so `npm i apecs` installs neither and warns about
neither. `sideEffects: false` plus per-entry chunking means an app importing only
`apecs/react` never has Solid code in its graph.

```
src/
  index.ts        internal.ts      globals.d.ts
  core/           the ECS
  reactive/       §C.3 — shared, not an entry point
  react/          apecs/react
  solid/          apecs/solid
```

`react >=18` is the floor for `useSyncExternalStore`. Nothing in either binding
uses JSX, so neither needs a JSX transform to build.

---

## C.3 The reactive core

`src/reactive/` is framework-agnostic and is where the goals in §C.1 are actually
met. Both bindings are thin adapters over it.

### C.3.1 Cells

The unit is a **cell**: a value derived from a world, recomputed on a schedule,
and committed only when it differs from what was committed last.

```ts
interface Cell<V> {
  /** The last committed value. Identity is stable until the value changes. */
  value(): V;
  /** Returns its own unsubscribe. The last unsubscribe releases the world observers. */
  subscribe(listener: () => void): () => void;
}
```

Lifecycle:

1. First `subscribe` registers the cell with the world's dispatch table (§C.3.4)
   and computes an initial value.
2. A relevant write marks the cell **dirty** and enqueues it. Nothing is
   recomputed and no listener runs.
3. At the next flush (§C.3.3) each dirty cell recomputes, compares against the
   committed value (§C.3.2), and — only on a difference — commits the new value
   and then notifies.
4. Last `unsubscribe` deregisters it and drops the world observers.

Commit happens strictly before notify, so a listener that reads `value()` always
sees the value it was woken for. There is no tearing.

Cells never mutate the world. A flush is therefore safe at any point, including
mid-iteration, and needs no interaction with `world.defer` / `world.flush` (§9).

### C.3.2 Value equality — the gate

This is the mechanism behind goal 1. Each cell carries an equality function; the
default is `Object.is`.

| cell                | value                    | equality                                              |
| ------------------- | ------------------------ | ----------------------------------------------------- |
| field               | `V` (number/string/bool) | `Object.is`                                           |
| trait / world trait | `Value<S>`               | field-wise `Object.is`; identity preserved when equal |
| has / tag           | `boolean`                | `Object.is`                                           |
| target / parent     | `Entity \| undefined`    | `Object.is` — entities are packed numbers (§4.1)      |
| query / children    | `readonly Entity[]`      | length, then element-wise `Object.is`                 |
| query first         | `Entity \| undefined`    | `Object.is`                                           |
| sorted query        | `readonly Entity[]`      | length, then element-wise `Object.is` — order counts  |
| sorted query first  | `Entity \| undefined`    | `Object.is`                                           |

Struct traits are the only case that needs care, because `world.get` returns a
fresh copy per call (§4.4) and a fresh object is never `Object.is`-equal to the
last one. The trait cell therefore reads into a **reusable scratch object** via
the `out` parameter, compares field-wise against the committed value, and
allocates a replacement only when a field actually differs. In the steady state
the gate is allocation-free, which is what makes it affordable to run on a trait
being written every frame.

The consequence for consumers is worth stating plainly: **a trait cell's object
identity is stable across frames in which no field changed.** That is what makes
it safe as a `useMemo` / `createMemo` dependency and as a React child prop.

### C.3.3 Flush — frame coalescing

This is the mechanism behind goal 2.

| mode          | when dirty cells are recomputed                |
| ------------- | ---------------------------------------------- |
| `'frame'`     | **default** — once per `requestAnimationFrame` |
| `'microtask'` | end of the current turn                        |
| `'sync'`      | immediately, inside the write                  |

`'frame'` is the default because it is the only mode that satisfies goal 2: a
simulation stepping at 240Hz, or on a fixed-timestep accumulator, dirties cells
at its own rate and the DOM still sees at most 60 updates per second. A microtask
default would track the simulation rate, not the display's.

Where `requestAnimationFrame` is unavailable — Node, SSR, a worker — `'frame'`
degrades to `'microtask'`. `'sync'` exists for tests (§C.9); it is not intended
for application use, and defeats §C.1's goal 2 by construction.

The mode is set once, on the provider (§C.5.1), and applies to that world alone.
One flush is scheduled per world per frame, however many cells are dirty.

**The scheduler is demand-driven; `'frame'` is not a loop.** A frame is requested
only when a write dirties a cell, and only if one is not already pending. A world
nothing writes to schedules nothing: no callback fires, no cell recomputes, and the
bindings never poll. `requestAnimationFrame` is used here as a rate limiter — it
bounds how often the DOM can be asked to update — not as a trigger, and dropping it
for `'microtask'` would not make the system more event-driven, only less bounded.

**The bindings never call `world.step()` and never read `world.tick`.** Core's
observers are push-based: `'add'` / `'remove'` / `'change'` fire inside the write,
and enter/exit fire during the archetype move that crosses a query boundary (§8.1,
§8.2). `step` advances the change clock for `Added()` / `Removed()` queries and
expires the removal log, both of which core bounds independently of it. An
application with no systems and no game loop — one that mutates the world from event
handlers alone — is therefore fully supported, and does exactly as much work as it
has changes.

The one place `'frame'` behaves unlike a pure event stream: `requestAnimationFrame`
does not fire in a hidden tab, so cells dirtied there stay dirty until it is visible
again. For rendering that is correct. Code that must observe every change regardless
of visibility belongs in an imperative hook (§C.7), which is never scheduled.

**Hooks are frame-consistent, not write-consistent.** Between a write and the next
flush, a cell reports the previous value. A component that re-renders for an
unrelated reason in that window sees the stale-by-at-most-one-frame value — which
is consistent, never torn, and is the entire point. Code that needs the live value
must read `world.get` directly, from an imperative hook (§C.7) or an event handler.

### C.3.4 Dispatch and sharing

Core observers are trait-granular and world-wide: `world.on('change', Position)` fires
for every entity's write to `Position`, not for one entity's (§8.1). A binding
that subscribed per hook would therefore cost
`writes × mounted hooks on that trait` callbacks per frame — 10k moving entities
against 200 mounted components is 2M calls per frame.

Sharing therefore happens at **three** levels, and subscribing to the same thing
twice shares at every one of them:

```
world registry
 └─ per trait — exactly one core 'add' / 'remove' / 'change' subscription
     └─ Map<entityId, Cell[]> — the cells for that trait, interned by subject
         └─ Cell — one committed value, one gate, N listeners
```

1. **One core subscription per `(world, trait)`.** Cost per write to an observed
   trait is one map lookup, and a miss returns immediately. A write to an
   unobserved trait is unchanged from core.
2. **One cell per `(world, entity, subject)`**, where the subject is a field, a
   trait, a relation, a `QueryResult`, or a `SortedQueryResult` (§C.3.6). Cells
   are interned and reference counted: ten components calling `useField(player, Position.x)` share one cell,
   so a write recomputes once, gates once, and then notifies ten listeners — not
   ten recomputes of the same value. Query cells intern on the `QueryResult`
   identity, which core already hashes from the term list (§6.2), so two hooks
   with equal terms share a cell without the binding hashing anything itself.
3. **One listener per hook.** This is the only level that scales with mounted
   components, and it costs one array entry.

A cell is dropped when its last listener unsubscribes; the trait's core
subscription is dropped when its last cell goes; the registry entry is dropped
when its last trait goes. A destroyed world therefore leaks nothing, and an
unmounted subtree stops costing anything at every level.

The interning is what makes world traits affordable. `useTrait(GameState)` in fifty
components resolves to one entity — `world.entity` (§5.4) — and therefore to one
cell holding one scratch object, not fifty.

### C.3.5 The cost of subscribing

`world.on('change', …)` calls `queries.track(trait)`, which promotes the trait to tracked
for the whole world — every subsequent write to it stamps a change tick (§8.3).

**Mounting a UI hook therefore imposes a cost on the systems that write that
trait.** This is inherent to core's design, not something the binding can avoid,
and it must be documented at the top of both bindings' READMEs. It is the second
reason the imperative hooks (§C.7) exist: one `useOn('change', Position, …)`
that fans out manually costs one tracked trait, where twenty `useField` hooks on
twenty entities also cost one — but a hook on twenty _different_ traits costs
twenty.

### C.3.6 Sorted cells

A UI list wants deterministic order, which §C.4.4 says a plain query cell does not
have. Core already computes one: `sortBy` returns a memoised `SortedQueryResult`
keyed on `(query signature, field, direction)` (§6.7). A sorted cell is a query
cell over that view, and differs from the unsorted pair in exactly one respect —
what wakes it.

**The wake set.** An unsorted query cell's committed value can only change when
the match set does, so `'enter'` / `'exit'` are sufficient. A sorted cell's value
also changes when a sort key moves an entity past a neighbour, which crosses no
query boundary and fires neither. Its `QueryWatch` (§C.3.4) therefore carries a
third subscription:

| write                                  | fires                | level it can cause |
| -------------------------------------- | -------------------- | ------------------ |
| spawn, despawn, add / remove a trait   | `'enter'` / `'exit'` | `rebuild`          |
| `world.set` / accessor on the sort key | `'change'`           | `resort`           |
| `chunk.markChanged` on the sort key    | nothing (§8.1)       | `resort` — missed  |

The third row is core's chunk hazard (§6.7) one level up, and is the only write
the binding cannot see; §C.11.1 carries it.

The `'change'` subscription costs no tracking that was not already being paid: `sortBy` marks
its key trait tracked for the whole world (§6.7), so unlike every other hook in
§C.3.5 a sorted hook imposes nothing on systems that the sort itself did not
already impose.

**The cell does not consult `isDirty`.** That was the concern that kept sorted
queries out of v1, and consulting the dirty levels per flush turns out to be both
unnecessary and wrong. Wrong, because the levels describe work owed to the _next
reader_, not change owed to _this cell_: a system iterating the same sorted query
between the write and the flush sorts the view and clears the level, and a cell
that early-outs on `'clean'` would miss the reorder it was woken for.
Unnecessary, because the view is memoised — a cell that simply reads the ordered
result pays core's sort when it is owed and nothing when a system already paid it.

So a sorted cell recomputes like any other: woken by an observer, it reads the
view's ordered buffer and gates element-wise against the committed array
(§C.3.2). It reads the buffer directly rather than through `entities()`, which
slices a defensive copy per call (§6.7), and allocates a replacement array only
when the order actually differs.

That gate is goal 1 (§C.1.1) applied to order rather than to value, and it is
worth stating for what it suppresses: **a key change that does not change the
order commits nothing.** A sprite whose `SortIndex` moves from 3 to 4 without
crossing a neighbour dirties the cell, re-sorts the view, finds the same
permutation, and re-renders nothing.

**Cost.** One O(n) comparison pass per flush per sorted cell that was woken,
bounded by the display rate (§C.3.3) and paid only while something is writing the
key — on top of core's resort, which §6.7 keeps at O(n) for a nearly-sorted array.
That is affordable for a list a person can look at. It is not a reason to render
ten thousand rows; a query that large belongs in a system, and a sorted one in
`each` (§6.7).

**The comparator overload is not offered.** `sortBy(compare)` has no key column,
so it is unconditionally `resort`-dirty (§6.7) _and_ gives the binding no trait to
observe — no wake source, and no way to build one. A comparator that closes over a
camera or a clock is exactly the case §C.7 exists for: subscribe imperatively,
call `sortBy(compare)` and `invalidate()` yourself, and drive the DOM from a ref.

---

## C.4 Semantics common to both bindings

1. **The world comes from the provider, which is required.** No hook takes a world
   argument; each reads the one `WorldProvider` put on context. A hook used outside
   a provider throws (§C.5.1) rather than returning `undefined`, because there is no
   sensible degraded behaviour and a silent `undefined` would surface later as a
   confusing read of nothing.

   The trade-off is that **one component cannot read two worlds.** Worlds are
   isolated by design (§5.3) and a second one is usually a preview or a level being
   loaded, so nesting a second `WorldProvider` around that subtree covers it. For
   the rare cross-world read, `useWorld()` plus a direct `world.get` is the escape
   hatch — uncached and ungated, but explicit.

2. **Dead entities yield `undefined`.** A component can hold an `Entity` past its
   despawn; core's `world.get` asserts on a dead handle in dev (§4.2). Every
   per-entity hook returns `undefined` when the entity is not alive, and likewise
   when it is alive but does not hold the trait. It never throws during render.
3. **Queries are never disposed by a hook.** `world.query` and `world.createQuery`
   both return the _cached, shared_ result for a term list (§6.2). A hook calls
   `world.query(...terms)` on each render — an O(1) hash lookup — and must never
   call `.dispose()` on what it gets back.
4. **Query order is not stable and carries no meaning.** Key React lists by entity,
   not by index. A query cell recomputes only when `'enter'` / `'exit'` fires
   (§8.2), so an entity changing archetype without leaving the match set does not
   reorder the committed array — but nothing guarantees that. A list whose order
   is part of what it shows wants `useSortedQuery` (§C.3.6), which guarantees it.
5. **Terms need no memoisation, and neither does a sort.** `useQuery(...)` builds
   a fresh term array every render; core hashes the term list and returns the
   cached result, so this is not a re-subscription. `sortBy` is the
   same kind of lookup on top of it (§6.7), so the sorted hooks resolve to a
   stable `SortedQueryResult` — and therefore to a shared cell — without the
   binding hashing anything either.
6. **Reads are shared and must be treated as read-only.** Cells are interned
   (§C.3.4), so two components reading the same trait of the same entity receive
   the _same object_, not two copies. Mutating what a hook returns corrupts every
   other reader of it and is overwritten on the next change anyway; writes go
   through `world.set` or an accessor. Dev builds freeze the committed value.
7. **Omitting the entity reads the world trait.** Every per-entity read hook takes
   an overload without one, resolving against `world.entity` (§5.4). This mirrors
   the overload set on `world.get` exactly, and is discriminated the same way core
   discriminates it — entities are packed numbers, so a first argument that is not a
   number selects the world-trait path (§4.1). A dedicated singleton hook would
   have added a name for what core treats as an overload, and could not have
   reached a world trait's fields.

---

## C.5 `apecs/react`

Every read hook is `useSyncExternalStore(cell.subscribe, cell.value, cell.value)`.
Because a cell's committed value has stable identity between real changes
(§C.3.2), `getSnapshot` satisfies React's `Object.is` contract without any
per-render allocation. The third argument doubles as `getServerSnapshot`.

### C.5.1 Context

```ts
WorldProvider(props: {
  world: World;
  flush?: 'frame' | 'microtask' | 'sync'; // default 'frame' (§C.3.3)
  children: ReactNode;
}): ReactElement

useWorld(): World; // throws outside a provider
```

`useWorld` is where the requirement in §C.4.1 is enforced, so every other hook
reaches it. The throw is unconditional rather than an `assert`: assertion bodies
are stripped from the published build (§12.2), and a missing provider must fail
legibly in production too, not as a `TypeError` on a null read three frames later.

`flush` replaces a standalone `setFlush(world, …)`. It is the only configuration
either binding takes, it is per-world by construction, and it makes the sync mode
tests need a prop rather than a side-effecting call (§C.9).

### C.5.2 Reads

```ts
useField<V>(entity, field: Field<V>): V | undefined
useField<V>(field: Field<V>): V | undefined                    // world trait
useTrait<S>(entity, trait: TraitLike<S>): Value<S> | undefined
useTrait<S>(trait: TraitLike<S>): Value<S> | undefined         // world trait
useHas(entity, trait: TraitLike): boolean
useHas(trait: TraitLike): boolean                              // world trait
useTag(entity, tag: TraitLike): boolean
useTag(tag: TraitLike): boolean                                // world trait
useQuery(...terms: Term[]): readonly Entity[]
useQueryFirst(...terms: Term[]): Entity | undefined
useSortedQuery(terms: Term[], field: Field, direction?: 'asc' | 'desc'): readonly Entity[]
useSortedQueryFirst(terms: Term[], field: Field, direction?: 'asc' | 'desc'): Entity | undefined
useTarget(entity, relation: Relation): Entity | undefined
useParent(entity, relation: Relation): Entity | undefined
useChildren(entity, relation: Relation): readonly Entity[]
```

- `useField` is the fast path: the read goes through a memoised `Accessor` (§4.5),
  so the snapshot is a primitive and the gate is a single `Object.is`.
- `useTrait` returns the gated copy from §C.3.2. On a tag or a struct trait with
  no single value, prefer `useTag` / `useField`.
- `useHas` is general; `useTag` is `useHas` restricted to traits that carry no
  data. Dev builds assert `kind === 'tag'` (§3.1), and the type parameter should
  narrow to tag traits once a `TagTrait` helper exists in core (§C.8).
- The **entity-less overloads read a world trait** (§5.4) — the singleton on
  `world.entity`, which is where score, paused and current selection live. They
  mirror core's own `world.get(trait)` / `world.get(field)` overloads rather than
  adding a separate hook name, and unlike a dedicated `useResource` they also
  reach a world trait's individual fields (§C.4.6).
- `useQueryFirst` is `query.first`, gated on `'enter'` / `'exit'`. It is a distinct
  hook rather than `useQuery(...)[0]` because it commits an `Entity`, not an array,
  so it never re-renders on a membership change that leaves the first entity alone.
- `useSortedQuery` is `world.query(...terms).sortBy(field, direction)` behind the
  cell in §C.3.6, and is the only hook whose order means anything (§C.4.4). It
  takes its terms as an **array** rather than a rest parameter, because the sort
  key follows them; this is the shape §C.7 already uses for the same reason.
  `direction` defaults to `'asc'`, matching core. The comparator overload of
  `sortBy` has no hook (§C.3.6).
- `useSortedQueryFirst` earns its place more clearly than `useQueryFirst` does: on
  a sorted query the first entity is the extremum — the leader, the nearest, the
  topmost layer — and it commits one `Entity`, so every reshuffle behind the
  winner is free.
- `useTarget` reads an exclusive relation and maps core's `NULL_ENTITY` to
  `undefined`; dev builds assert exclusivity, as `world.target` does (§7.3).
- `useParent` is `useTarget` under the name the hierarchy case reads better in.
  `useChildren` is its complement, `world.query(relation(entity))`, and is the
  reason the pair earns its place over `useTarget` alone.

### C.5.3 Writes and lifecycle

```ts
useAccessor<V>(field: Field<V>): Accessor<V>
useEntity(...items: TraitLike[]): Entity | undefined
```

`useAccessor` memoises `world.accessor(field)` across renders, so a pointermove
handler writing every event resolves the field once rather than per event (§4.5).
It creates no subscription and never re-renders.

`useEntity` spawns on mount and despawns on unmount. Under StrictMode React
double-invokes effects, so it spawns, despawns, and spawns again on mount, burning
one entity id per mounted component. That is correct but wasteful, and must be
documented rather than discovered.

---

## C.6 `apecs/solid`

Solid is push-based, so there is no snapshot contract to satisfy and nothing to
cache for identity's sake. Each factory is a signal seeded from the cell and
written by its subscription:

```ts
const [get, set] = createSignal(cell.value(), { equals: false });
onCleanup(cell.subscribe(() => set(() => cell.value())));
```

`equals: false` is correct here precisely because the cell has already gated on
value (§C.3.2) — the signal is only ever written when something really changed,
and a redundant equality check would run twice.

The getters are typed `() => V` rather than Solid's `Accessor<V>`: structurally
identical, and it avoids colliding with apecs's own `Accessor` (§4.5).

### C.6.1 Surface

Names follow Solid's convention — `create*` for anything that builds reactive
state, `use*` only for context, and bare `on*` for owner-bound subscriptions. The
mapping is one-to-one: mirroring core's `world.get` overloads instead of naming a
singleton hook leaves nothing that collides with Solid's own exports.

| React                 | Solid                    |
| --------------------- | ------------------------ |
| `WorldProvider`       | `WorldProvider`          |
| `useWorld`            | `useWorld`               |
| `useField`            | `createField`            |
| `useTrait`            | `createTrait`            |
| `useHas`              | `createHas`              |
| `useTag`              | `createTag`              |
| `useQuery`            | `createQuery`            |
| `useQueryFirst`       | `createQueryFirst`       |
| `useSortedQuery`      | `createSortedQuery`      |
| `useSortedQueryFirst` | `createSortedQueryFirst` |
| `useTarget`           | `createTarget`           |
| `useParent`           | `createParent`           |
| `useChildren`         | `createChildren`         |
| `useAccessor`         | `createAccessor`         |
| `useEntity`           | `createEntity`           |
| `useOn`               | `on`                     |

`WorldProvider` is built with `createComponent` and a lazy `children` getter —
what the Solid JSX transform emits — so the binding needs no JSX build step.

---

## C.7 Imperative hooks — the escape hatch

```ts
useOn / on ('add' | 'remove' | 'change', trait: TraitLike, fn: ObserverFn): void
useOn / on ('enter' | 'exit', terms: Term[], fn: ObserverFn): void
```

A one-to-one mirror of `world.on` (§8.1, §8.2) with lifetime-bound unsubscribe
and no new vocabulary. Query events take the terms rather than a `QueryResult`,
which the hook interns for free (§6.2).

These are **not gated and not coalesced**. They fire synchronously, inside the
write, exactly as core does. That is deliberate: they exist for the case where a
frame-rate-decoupled, value-gated re-render is the wrong tool — writing into a ref,
driving a canvas, feeding an animation — and where imposing §C.3.2 and §C.3.3
would be interference rather than help.

Without them the bindings are unusable for anything real-time, because the correct
answer to "this changes every frame" is not to re-render sixty times a second but
to leave React out of the loop entirely.

---

## C.8 TypeScript

- Both bindings need `TraitLike` from core; it is exported from `apecs` as a type
  (§14) for exactly this reason. The sorted hooks need `Field` too, which core
  already exports as a type.
- `useTag` / `createTag` want a `TagTrait` constraint — a trait whose schema kind
  is `'tag'` (§3.1). Core exposes the kind at runtime, and dev builds assert on it;
  expressing it in the type system requires a helper alias in core. Until that
  exists the parameter is `TraitLike` and the guarantee is dev-only.
- Consumers need `moduleResolution: 'bundler'` or `'node16'` to see the subpath
  types. No `typesVersions` fallback is provided.

---

## C.9 Testing

Two vitest projects beside the existing `dev`, `prod`, `types` and `bench`
(§12.2), both `environment: 'jsdom'`.

- Tests are hook-first and JSX-free — `renderHook` for React, `createRoot` /
  `dispose` for Solid — which keeps the suite off `vite-plugin-solid` and the
  Solid JSX transform.
- `solid-js` ships conditional exports; the Solid project needs
  `resolve.conditions: ['browser', 'development']` or it resolves the server build.
- Because the provider is required (§C.4.1), every test renders inside one. The
  wrapper passes `flush="sync"` so assertions read committed values without
  pumping frames; coalescing itself is tested separately, with a faked
  `requestAnimationFrame`.
- The value gate needs dedicated coverage: **writing the same value must produce
  zero notifications**, on each cell kind in §C.3.2. That assertion is the
  specification of goal 1 and should fail loudly if the gate regresses.
- Sorted cells need the order-preserving case as well as the value one: a key
  write that re-sorts to the same permutation must notify zero times, one that
  moves an entity past a neighbour must notify once, and a spawn into the match
  set must land the new entity in its sorted position (§C.3.6). One test must
  sort the view from a system between the write and the flush, which is the case
  that rules out gating on `isDirty`.

`check:bundle` asserts each entry's export list and that `react` / `solid-js` are
imported rather than inlined (§12.2).

---

## C.10 API surface

```ts
// apecs/react
WorldProvider  useWorld
useField  useTrait  useHas  useTag        // each with an entity-less world-trait overload
useQuery  useQueryFirst  useSortedQuery  useSortedQueryFirst
useTarget  useParent  useChildren
useAccessor  useEntity
useOn

// apecs/solid
WorldProvider  useWorld
createField  createTrait  createHas  createTag  // ditto
createQuery  createQueryFirst  createSortedQuery  createSortedQueryFirst
createTarget  createParent  createChildren
createAccessor  createEntity
on

// configuration is a WorldProvider prop, not a call:
//   <WorldProvider world={world} flush="frame" />
```

---

## C.11 Open questions

1. **Sort keys written through chunks do not wake a sorted cell.**
   `chunk.markChanged` bumps the column's `lastWriteTick` — enough for core's view
   to know it owes a resort (§6.7) — but fires no observer (§8.1), so the cell in
   §C.3.6 is never dirtied and the list stays in its old order until something else
   moves it. Dev's §6.6 warning catches a _missing_ `markChanged`, not this. Until
   it is closed, sort keys behind a mounted list should be written through
   `world.set` or an accessor; a chunk system that must write them is the §C.7
   case. The real fix is the same `world.onStep(fn)` floated in open question 2:
   given it, a sorted cell would consult its view once per step and every write
   path would converge, chunk writes and comparators alike.
2. **Writes that change nothing still cost a frame.** The gate suppresses the
   notification but not the flush that discovers there is nothing to notify: a
   trait written every step with an unchanging value schedules one rAF and one
   recompute per frame. That is the gate working as designed and is bounded by the
   display rate, but a world whose simulation is far slower than the display could
   in principle flush on its own schedule instead, via a core `world.onStep(fn)` in
   the style of the existing observers. Not required for v1.
3. **Solid stores for struct traits.** `createStore` plus `reconcile` would give
   per-field reactivity on a struct trait, strictly better than handing back a
   gated copy. It is a materially larger build and is deferred.
4. **`useEntity` under StrictMode.** Burning an entity id per mounted component is
   correct but wasteful. A pooled or deferred despawn would avoid it at the cost of
   making unmount asynchronous.
