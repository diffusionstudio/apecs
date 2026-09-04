# `apecs/solid`

The React binding is the same model under different names — [react.md](react.md).

The binding projects a mutable, frame-rate-decoupled world into Solid **without
dragging the DOM along at simulation rate**. It renders nothing and it never
calls `world.step()`.

## How updates reach a component

Solid is push-based, so there is no snapshot contract to satisfy and nothing to
cache for identity's sake. Each factory is a signal seeded from a shared _cell_
and written by its subscription:

```ts
const unsubscribe = cell.subscribe(() => set(() => cell.value()));
const [get, set] = createSignal(cell.value(), { equals: false });
onCleanup(unsubscribe);
```

`equals: false` is correct **precisely because the cell has already gated on
value** — the signal is only ever written when something really changed, so a
second equality check would run the comparison twice. Two mechanisms sit behind
that gate.

**1. Value gating.** A cell notifies when a _value_ changes, never merely when a
write happened. A simulation writing `Position.x = 4` sixty times between paints
produces zero updates. Struct traits are read into a reusable scratch object via
`world.get(e, T, out)` and compared field-wise, so the gate is allocation-free in
the steady state and the committed object is replaced only when a field actually
differs.

| factory                                       | value                 | equality                                  |
| --------------------------------------------- | --------------------- | ----------------------------------------- |
| `createField`                                 | `V`                   | `Object.is`                               |
| `createTrait`                                 | `Value<S>`            | field-wise; identity preserved when equal |
| `createHas` / `createTag`                     | `boolean`             | `Object.is`                               |
| `createTarget` / `createParent`               | `Entity \| undefined` | `Object.is`                               |
| `createQuery` / `createChildren`              | `readonly Entity[]`   | length, then element-wise                 |
| `createSortedQuery`                           | `readonly Entity[]`   | length, then element-wise — order counts  |
| `createQueryFirst` / `createSortedQueryFirst` | `Entity \| undefined` | `Object.is`                               |

**2. Frame coalescing.** Dirty cells recompute on a schedule set once, on the
provider:

| `flush`       | when                                           |
| ------------- | ---------------------------------------------- |
| `'frame'`     | **default** — once per `requestAnimationFrame` |
| `'microtask'` | end of the current turn                        |
| `'sync'`      | inside the write — **for tests**               |

The scheduler is **demand-driven**: a frame is requested only when a write dirties
a cell. A world nothing writes to schedules nothing; the binding never polls.
Without `requestAnimationFrame` (Node, SSR, a worker) `'frame'` degrades to
`'microtask'`.

Consequence: **getters are frame-consistent, not write-consistent.** Between a
write and the next flush a getter returns the previous value — consistent, never
torn, stale by at most one frame. Code that needs the live value reads
`world.get` directly, from an event handler or an owner-bound subscription.

`requestAnimationFrame` does not fire in a hidden tab, so cells dirtied there stay
dirty until it is visible again. Correct for rendering; use an `on*` subscription
for anything that must observe every change regardless of visibility.

## Sharing

```
world registry
 └─ per trait — exactly ONE core 'add'/'remove'/'change' subscription
     └─ Map<entityId, Cell[]> — cells interned by subject
         └─ Cell — one committed value, one gate, N listeners
```

Ten components calling `createField(player, Position.x)` share one cell: a write
recomputes once, gates once, notifies ten — not ten recomputes of the same value.
Query cells intern on the `QueryResult` identity, which core already hashes from
the term list, so two components with equal terms share a cell without the
binding hashing anything. Everything is reference-counted and released with the
owner, top to bottom.

This is what makes world traits affordable: `createTrait(GameState)` in fifty
components resolves to one entity — `world.entity` — and so to one cell holding
one scratch object, not fifty.

## Naming

`create*` for anything that builds reactive state, `use*` only for context, bare
`on*` for owner-bound subscriptions — Solid's own convention, so nothing collides
with Solid's exports.

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

Getters are typed `() => V` rather than Solid's `Accessor<V>` — structurally
identical, and it avoids colliding with apecs's own `Accessor`.

## Provider

```tsx
import { WorldProvider, useWorld } from 'apecs/solid';

<WorldProvider world={world} flush="frame">
  {children}
</WorldProvider>;

const world = useWorld(); // throws outside a provider
```

The provider is **required** and `useWorld` throws without one — unconditionally,
not via an assert, because assertion bodies are stripped from the published build
and a missing provider must fail legibly in production too. `flush` is the only
configuration the binding takes.

`WorldProvider` is built with `createComponent` and lazy `value` / `children`
getters — what the Solid JSX transform emits, written out — so **the binding
itself needs no JSX build step**, and the provider forces neither the world nor
its children at creation.

## Reads

```ts
createField<V>(entity, field): () => V | undefined
createField<V>(field): () => V | undefined              // world trait
createTrait<S>(entity, trait): () => Value<S> | undefined
createTrait<S>(trait): () => Value<S> | undefined       // world trait
createHas(entity?, trait): () => boolean
createTag(entity?, tag): () => boolean
createQuery(...terms): () => readonly Entity[]
createQueryFirst(...terms): () => Entity | undefined
createSortedQuery(terms: Term[], field, direction?): () => readonly Entity[]
createSortedQueryFirst(terms: Term[], field, direction?): () => Entity | undefined
createTarget(entity, relation): () => Entity | undefined  // NULL_ENTITY → undefined
createParent(entity, relation): () => Entity | undefined
createChildren(entity, relation): () => readonly Entity[]
```

```tsx
const hp = createField(player, Health.current); // primitive, one Object.is
const score = createField(Score.value); // no entity → world trait
const enemies = createQuery(Position, IsEnemy);
const leader = createSortedQueryFirst([Racer], Progress.distance, 'desc');

<For each={enemies()}>{(e) => <Row entity={e} />}</For>;
```

- **`createField` is the fast path.** It reads through a memoised `Accessor`, so
  the value is a primitive and the gate is a single `Object.is`.
- **Omitting the entity reads a world trait**. This mirrors core's own
  `world.get` overloads rather than adding a `createResource`-shaped name — which
  would also have collided with Solid's `createResource` — and unlike one it
  reaches a world trait's individual _fields_.
- **`createTrait` returns the gated copy.** On a tag, or when you want one number,
  prefer `createTag` / `createField`.
- **`createQueryFirst` is not `createQuery(...)()[0]`.** It commits an `Entity`,
  so a membership change that leaves the first entity alone updates nothing. The
  argument is stronger for `createSortedQueryFirst`, where the first entity is the
  extremum — the leader, the nearest, the topmost layer.
- **`createSortedQuery` takes terms as an array**, because the sort key follows
  them. `direction` defaults to `'asc'`. It is the only factory whose order means
  anything. The comparator overload of `sortBy` has none — no key column
  to observe means no wake source to build one on.

## Writes and lifecycle

```ts
createAccessor<V>(field): Accessor<V>   // memoised; no subscription, no reactivity
createEntity(...items): Entity          // spawns now, despawns with the owner
```

There is no two-way binding. Writes go through `world.set` or an accessor:

```tsx
const x = createAccessor(Position.x);
<div onPointerMove={(e) => x.set(entity, e.clientX)} />; // resolves the field once
```

**`createEntity` returns an `Entity`, not `Entity | undefined`** — it spawns
during setup rather than in an effect, so unlike React's `useEntity` there is
nothing to wait for and no StrictMode double-spawn. It despawns on cleanup, unless
something else already did.

## Owner-bound subscriptions — the escape hatch

```ts
on('add' | 'remove' | 'change', trait, fn)
on('enter' | 'exit', terms: Term[], fn)
```

A one-to-one mirror of the core observers, released with the owner.
**Not gated, not coalesced** — they fire synchronously inside the write, exactly
as core does. They exist for the case where a value-gated, frame-decoupled update
is the wrong tool: writing into a ref, driving a canvas, feeding an animation.

Note this shadows core's `world.on` name at the import level, and Solid's own
`on` helper; if a module needs both, alias one.

## Gotcha checklist

1. **The provider is required**, and no factory takes a world argument. One
   component therefore cannot read two worlds; nest a second provider around that
   subtree, or use `useWorld()` plus a direct `world.get` as the uncached,
   ungated escape hatch.
2. **Everything returns a getter.** `createField(...)` is a function — call it.
   Destructuring or reading it outside a tracking scope freezes the value.
3. **Creating a cell makes its trait tracked world-wide**, so every
   system write to it then stamps a change tick. Twenty `createField` calls on
   twenty entities of one trait cost one tracked trait; twenty _different_ traits
   cost twenty. This is the second reason the `on*` subscriptions exist.
4. **Never call `each` or `chunks` in a component.** Those are for systems.
5. **Results are shared and read-only.** Two components reading the same subject
   get the _same object_; mutating it corrupts every other reader and is
   overwritten on the next change anyway. Dev freezes committed values.
6. **Dead entities yield `undefined`**, never a throw.
7. **Key `<For>` by entity.** Query order is not stable and carries no meaning.
   If order is part of what you show, use `createSortedQuery`.
8. **Terms need no memoisation.** A fresh term array is an O(1) cache lookup, not
   a re-subscription; same for the `sortBy` on top of it. Never `.dispose()` what
   a factory handed you.
9. **Sort keys written through `chunks` do not wake a sorted cell**.
   `chunk.markChanged` bumps `lastWriteTick` — enough for core's view to know it
   owes a resort — but fires no observer, so the list stays in its old order.
   Write sort keys behind a mounted list through `world.set` or an accessor; a
   chunk system that must write them is the `on*` case.
10. **Struct traits get a gated copy, not per-field reactivity.** `createStore`
    plus `reconcile` would be strictly better and is deferred. Until
    then, reach for `createField` when you want one number to move on its own.

## Testing

A jsdom vitest project, factory-first and JSX-free — `createRoot` / `dispose`,
which keeps the suite off `vite-plugin-solid` and the Solid JSX transform.

`solid-js` ships conditional exports, so the project needs
`resolve.conditions: ['browser', 'development']` or it resolves the server build.

Because the provider is required, every test renders inside one; the wrapper
passes `flush="sync"` so assertions read committed values without pumping frames.
Coalescing is tested separately, with a faked `requestAnimationFrame`.

Two assertions are the specification, not incidental coverage:

- **Writing the same value must produce zero notifications**, on every cell kind
  in the table above.
- On a sorted cell: a key write that re-sorts to the **same permutation must
  notify zero times**, one that moves an entity past a neighbour exactly once, and
  a spawn must land in its sorted position. One test must sort the view from a
  system between the write and the flush — the case that rules out gating on
  `isDirty`.
