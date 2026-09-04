# `apecs/react`

Section markers of the form §C.n point at
[SPEC-CLIENTS.md](../../../SPEC-CLIENTS.md); bare §n at [SPEC.md](../../../SPEC.md).
The Solid binding is the same model under different names —
[solid.md](solid.md).

The binding projects a mutable, frame-rate-decoupled world into React **without
dragging the DOM along at simulation rate**. It renders nothing and it never
calls `world.step()`.

## How updates reach a component

Every read hook is
`useSyncExternalStore(cell.subscribe, cell.value, cell.value)` over a shared
_cell_ (§C.3.1). Two mechanisms sit behind that.

**1. Value gating.** A cell notifies when a _value_ changes, never merely when a
write happened. A simulation writing `Position.x = 4` sixty times between paints
produces zero re-renders. Struct traits are read into a reusable scratch object
via `world.get(e, T, out)` and compared field-wise, so the gate is
allocation-free in the steady state — and the committed object is **replaced only
when a field actually differs**. That stable identity is exactly what satisfies
React's `Object.is` contract for `getSnapshot` with no per-render allocation, and
what makes a `useTrait` result safe as a `useMemo` dependency or a child prop.

| hook                                    | value                 | equality                                  |
| --------------------------------------- | --------------------- | ----------------------------------------- |
| `useField`                              | `V`                   | `Object.is`                               |
| `useTrait`                              | `Value<S>`            | field-wise; identity preserved when equal |
| `useHas` / `useTag`                     | `boolean`             | `Object.is`                               |
| `useTarget` / `useParent`               | `Entity \| undefined` | `Object.is`                               |
| `useQuery` / `useChildren`              | `readonly Entity[]`   | length, then element-wise                 |
| `useSortedQuery`                        | `readonly Entity[]`   | length, then element-wise — order counts  |
| `useQueryFirst` / `useSortedQueryFirst` | `Entity \| undefined` | `Object.is`                               |

**2. Frame coalescing.** Dirty cells recompute on a schedule set once, on the
provider:

| `flush`       | when                                           |
| ------------- | ---------------------------------------------- |
| `'frame'`     | **default** — once per `requestAnimationFrame` |
| `'microtask'` | end of the current turn                        |
| `'sync'`      | inside the write — **for tests**               |

The scheduler is **demand-driven**: a frame is requested only when a write dirties
a cell. A world nothing writes to schedules nothing; the binding never polls.
Without `requestAnimationFrame` (Node, SSR) `'frame'` degrades to `'microtask'`.

Consequence: **hooks are frame-consistent, not write-consistent.** Between a write
and the next flush a hook returns the previous value — consistent, never torn,
stale by at most one frame. A component that re-renders for an unrelated reason in
that window sees the stale value. Code that needs the live value reads
`world.get` directly, from an event handler or an imperative hook.

`requestAnimationFrame` does not fire in a hidden tab, so cells dirtied there stay
dirty until it is visible again. Correct for rendering; use an imperative hook for
anything that must observe every change regardless of visibility.

## Sharing (§C.3.4)

```
world registry
 └─ per trait — exactly ONE core onAdd/onRemove/onChange subscription
     └─ Map<entityId, Cell[]> — cells interned by subject
         └─ Cell — one committed value, one gate, N listeners
```

Ten components calling `useField(player, Position.x)` share one cell: a write
recomputes once, gates once, notifies ten — not ten recomputes of the same value.
Query cells intern on the `QueryResult` identity, which core already hashes from
the term list (§6.2), so two hooks with equal terms share a cell without the
binding hashing anything. Everything is reference-counted and released on unmount,
top to bottom, so an unmounted subtree stops costing anything at every level.

This is what makes world traits affordable: `useTrait(GameState)` in fifty
components resolves to one entity — `world.entity` — and so to one cell holding
one scratch object, not fifty.

## Provider

```tsx
import { WorldProvider, useWorld } from 'apecs/react';

<WorldProvider world={world} flush="frame">
  {children}
</WorldProvider>;

const world = useWorld(); // throws outside a provider
```

The provider is **required** and `useWorld` throws without one — unconditionally,
not via an assert, because assertion bodies are stripped from the published build
and a missing provider must fail legibly in production too. `flush` is the only
configuration the binding takes.

## Reads

```ts
useField<V>(entity, field): V | undefined
useField<V>(field): V | undefined                 // world trait
useTrait<S>(entity, trait): Value<S> | undefined
useTrait<S>(trait): Value<S> | undefined          // world trait
useHas(entity?, trait): boolean
useTag(entity?, tag): boolean
useQuery(...terms): readonly Entity[]
useQueryFirst(...terms): Entity | undefined
useSortedQuery(terms: Term[], field, direction?): readonly Entity[]
useSortedQueryFirst(terms: Term[], field, direction?): Entity | undefined
useTarget(entity, relation): Entity | undefined   // maps NULL_ENTITY → undefined
useParent(entity, relation): Entity | undefined
useChildren(entity, relation): readonly Entity[]
```

```tsx
const hp = useField(player, Health.current); // primitive, one Object.is
const score = useField(Score.value); // no entity → world trait
const enemies = useQuery(Position, IsEnemy); // key the list by entity
const leader = useSortedQueryFirst([Racer], Progress.distance, 'desc');
```

- **`useField` is the fast path.** It reads through a memoised `Accessor` (§4.5),
  so the snapshot is a primitive and the gate is a single `Object.is`.
- **Omitting the entity reads a world trait** (§5.4). This mirrors core's own
  `world.get` overloads rather than adding a `useResource` name, and unlike one it
  reaches a world trait's individual _fields_.
- **`useTrait` returns the gated copy.** On a tag, or when you want one number,
  prefer `useTag` / `useField`.
- **`useHas` is general; `useTag` is `useHas` restricted to data-free traits.**
  Dev builds assert the kind.
- **`useQueryFirst` is not `useQuery(...)[0]`.** It commits an `Entity`, so a
  membership change that leaves the first entity alone re-renders nothing. The
  argument is stronger for `useSortedQueryFirst`, where the first entity is the
  extremum — the leader, the nearest, the topmost layer — and every reshuffle
  behind the winner is free.
- **`useSortedQuery` takes terms as an array**, because the sort key follows them.
  `direction` defaults to `'asc'`. It is the only hook whose order means anything.
  The comparator overload of `sortBy` has no hook (§C.3.6) — it has no key column
  to observe, so there is no wake source to build one on.
- **`useParent` is `useTarget` under the name the hierarchy case reads better in**;
  `useChildren` is its complement.

## Writes and lifecycle

```ts
useAccessor<V>(field): Accessor<V>      // memoised; no subscription, never re-renders
useEntity(...items): Entity | undefined // spawn on mount, despawn on unmount
```

There is no two-way binding. Writes go through `world.set` or an accessor:

```tsx
const setX = useAccessor(Position.x);
<div onPointerMove={(e) => setX.set(entity, e.clientX)} />; // resolves the field once
```

`useEntity` returns `undefined` until the mount effect has run, and reads its
items once, at spawn.

## Imperative hooks — the escape hatch (§C.7)

```ts
useOnAdd(trait, fn)
useOnRemove(trait, fn)
useOnChange(trait, fn)
useOnEnter(terms: Term[], fn)
useOnExit(terms: Term[], fn)
```

**Not gated, not coalesced.** They fire synchronously inside the write, exactly as
core does, with unsubscribe bound to the component's lifetime. They exist for the
case where a value-gated, frame-decoupled re-render is the wrong tool — writing
into a ref, driving a canvas, feeding an animation — because the correct answer to
"this changes every frame" is to leave React out of the loop entirely.

The observer forwards to the latest `fn` through a ref, so an **inline closure
costs no re-subscription and never fires stale** — no `useCallback` needed.

## Gotcha checklist

1. **The provider is required**, and no hook takes a world argument. One component
   therefore cannot read two worlds; nest a second provider around that subtree, or
   use `useWorld()` plus a direct `world.get` as the uncached, ungated escape hatch.
2. **Mounting a hook makes its trait tracked world-wide** (§C.3.5), so every system
   write to it then stamps a change tick. Twenty `useField` hooks on twenty
   entities of one trait cost one tracked trait; hooks on twenty _different_ traits
   cost twenty. This is the second reason the imperative hooks exist.
3. **Never call `each` or `chunks` in render.** Those are for systems.
4. **Hook results are shared and read-only.** Two components reading the same
   subject get the _same object_; mutating it corrupts every other reader and is
   overwritten on the next change anyway. Dev freezes committed values.
5. **Dead entities yield `undefined`**, never a throw during render — likewise a
   live entity that does not hold the trait.
6. **Key lists by entity, not index.** Query order is not stable and carries no
   meaning (§C.4.4). If order is part of what you show, use `useSortedQuery`.
7. **Terms need no memoisation.** A fresh term array per render is an O(1) cache
   lookup, not a re-subscription; same for the `sortBy` on top of it. Never
   `.dispose()` what a hook handed you (§C.4.3).
8. **Sort keys written through `chunks` do not wake a sorted cell** (§C.11.1).
   `chunk.markChanged` bumps `lastWriteTick` — enough for core's view to know it
   owes a resort — but fires no observer, so the list stays in its old order. Write
   sort keys behind a mounted list through `world.set` or an accessor; a chunk
   system that must write them is the imperative-hook case.
9. **`useEntity` under StrictMode** spawns, despawns and spawns again, burning one
   entity id per mounted component. Correct, wasteful, and known (§C.11.4).

## Testing (§C.9)

A jsdom vitest project, hook-first and JSX-free — `renderHook` from
`@testing-library/react`, so the suite needs no JSX transform.

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
