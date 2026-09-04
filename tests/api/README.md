# Public API test suite

These tests are the **contract**. They exercise only what a consumer of the
package can reach — the values exported from `src/index`, which is what
`package.json#exports["."]` publishes — and nothing else.

## Rules

1. **Import from `../../src/index` only.** Never `../../src/internal`, never a
   module path, never a symbol. If a test needs an internal to make its point,
   the point belongs in `tests/*.test.ts`, not here.
2. **Assert observable behaviour, not mechanism.** Row order, archetype
   identity, page boundaries, and allocation counts are implementation detail.
   Values, counts, membership, ordering guarantees the spec makes, and the
   errors dev builds throw are contract.
3. **These files change only when the API changes.** A refactor that keeps the
   API intact must leave this directory untouched; that is the whole point. A
   failure here is either a regression or a deliberate, breaking API change.
4. **Every assertion cites its spec section.** `SPEC.md` is the source of
   truth; a test with no section behind it is a test of an accident.

## Layout

| File                 | Covers                                                       |
| -------------------- | ------------------------------------------------------------ |
| `surface.test.ts`    | §14 — the exported names and their shapes                    |
| `traits.test.ts`     | §3 — declaration, field types, fields as values, instances   |
| `entities.test.ts`   | §4.1–4.4 — handles, lifecycle, bulk and per-entity ops       |
| `accessors.test.ts`  | §4.5 — resolved per-entity access                            |
| `world.test.ts`      | §5 — options, subclassing, isolation, world traits, teardown |
| `queries.test.ts`    | §6.1–6.4 — terms, caching, result surface, tier 1            |
| `each.test.ts`       | §6.5 — tier 2 cursors                                        |
| `chunks.test.ts`     | §6.6 — tier 3 pages                                          |
| `sorted.test.ts`     | §6.7 — sorted views and their invalidation contract          |
| `relations.test.ts`  | §7 — declaration, usage, querying, lifecycle, `Cascade`      |
| `events.test.ts`     | §8 — observers, enter/exit, change ticks, `eid` patching     |
| `structural.test.ts` | §9 — what is safe during iteration, `defer` / `flush`        |

Dev-only behaviour (assertions that compile out of the published bundle) is
guarded with `test.runIf(__DEV__)`, so the suite passes under both the `dev`
and `prod` vitest projects.
