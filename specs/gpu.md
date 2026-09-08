# apecs gpu — Specification

The GPU tier. Exported from `apecs/gpu`, specified in its own document rather
than as a section of [core.md](core.md) so that document's section numbers stay
put. Section references of the form §n point at core.md; references within this
document are written §G.n.

core.md lists "no rendering, physics, input, or asset integration" among its
non-goals. This document does not change that: `apecs/gpu` is a leaf, in the
same sense the scheduler is (§S.2). No core module imports it, no world knows it
exists, and an app that never imports it pays nothing.

It gives a query two things core cannot: storage that lives in GPU memory, and a
way to say what runs over it — as a compute dispatch, or as the vertex stage of a
draw. It is not a renderer. It has no material system, no asset pipeline, no
scene graph, and no opinion about what you draw.

---

## Quick start

> The surface below is what this document specifies, not what ships today.
> §G.2 names the one core hook it waits on.

```bash
npm i apecs typegpu
npm i -D unplugin-typegpu   # optional: 'use gpu' bodies instead of WGSL strings (§G.11.3)
```

**1. Say where the data lives.** This is the only new declaration; everything
else follows from it (§G.3).

```ts
import { Trait, f32 } from 'apecs';

const Transform = new Trait({ x: f32(0), y: f32(0), z: f32(0) }, { storage: 'gpu' });
const Velocity = new Trait({ x: f32(0), y: f32(0), z: f32(0) }, { storage: 'gpu' });
const Tint = new Trait({ r: f32(1), g: f32(1), b: f32(1), a: f32(1) }, { storage: 'gpu' });
const Sprite = new Trait();
const Sim = new Trait({ dt: f32(1 / 60) }); // world-level; becomes a uniform
```

**2. Give the world an arena.** The allocator is a constructor option, so it is
in place before the first spawn (§G.2.1).

```ts
import { Schedule, With, World } from 'apecs';
import { gpuAllocator } from 'apecs/gpu';

const adapter = await navigator.gpu.requestAdapter();
const world = new World({ allocator: gpuAllocator(await adapter.requestDevice()) });
```

**3. Spawn exactly as you would without the GPU.** Residency is invisible here.

```ts
world.set(Sim, { dt: 1 / 60 });
for (let i = 0; i < 100_000; i++) {
  world.spawn(Transform({ x: i % 500, y: (i / 500) | 0 }), Velocity({ x: 1, y: 0 }), Tint, Sprite);
}
```

**4. A compute system.** Same argument shape as `each` — traits positionally, in
term order (§G.4).

```ts
const integrate = world.query(Transform, Velocity).compute((t, v) => {
  'use gpu';
  t.x += v.x * Sim.$.dt;
  t.y += v.y * Sim.$.dt;
});
```

**5. A render system.** The vertex function takes the query's traits; the
fragment function takes what the vertex function returned, and knows nothing
about entities (§G.5). `orderBy` gives back-to-front transparency without an
index buffer (§G.6).

```ts
const draw = world
  .query(Transform, Tint, With(Sprite))
  .orderBy(Transform.z, 'desc')
  .render({
    vertex: (t, tint, { vertexIndex }) => {
      'use gpu';
      const corner = QUAD[vertexIndex];
      return {
        position: Camera.$.viewProj.mul(vec4f(t.x + corner.x, t.y + corner.y, t.z, 1)),
        color: tint.rgba,
      };
    },
    fragment: ({ color }) => {
      'use gpu';
      return color;
    },
    target: { blend: ALPHA },
  });
```

**6. Run the frame.** Both are ordinary systems (§S.4); nothing is called by
hand.

```ts
const schedule = new Schedule(world)
  .add('integrate', integrate)
  .add('draw', draw, { after: 'integrate' });

const frame = () => {
  schedule.run();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
```

### Three things to check before reaching for it

- **Is the per-entity math heavy?** An elementwise system is _slower_ dispatched
  than it is under `each()` — 0.68× measured. The deciding variable is
  arithmetic intensity, not entity count (§G.4.1).
- **Are you about to make visibility a trait?** Don't. Adding and removing one
  across 100 000 entities costs 20.6 ms per frame; cull on the GPU (§G.7).
- **Does the data need to come back?** Rendering is the good case because
  nothing reads back. A per-frame round trip costs 19× the compute it feeds
  (§G.12.3).

---

## G.1 Goals

1. **Residency is explicit and declared once.** Where a trait's columns live is a
   property of the trait, not of the query that reads it. A query cannot make
   CPU-resident data fast by asking nicely (§G.3).
2. **The archetype is the dispatch unit.** An archetype is query-homogeneous and
   contiguous, so a shader indexes rows directly and needs no entity index
   buffer. This is the tier's central performance claim (§G.12).
3. **The GPU idiom mirrors the CPU idiom.** `.compute(fn)` takes the same
   argument shape, in the same order, as `each(fn)` (§4.2). One mental model.
4. **The ECS owns the vertex stage and stops there.** Fragments are not
   entities. The fragment shader is passed through to TypeGPU untouched (§G.5).
5. **Borrow, do not rebuild.** WGSL generation, typed data schemas, and the
   JS→WGSL transpiler are TypeGPU's. apecs supplies bindings and dispatch, which
   is the half TypeGPU cannot know (§G.11).
6. **Free when unused,** and degrading in tiers when partly available: no
   TypeGPU at all, TypeGPU without its build plugin, or both (§G.11.3).

### Non-goals for v1

- No material system, no asset loading, no scene graph, no built-in shaders.
- No worker parallelism, no multi-queue submission.
- No automatic CPU↔GPU coherence. `'mirror'` syncs on an explicit boundary
  (§G.3.2); `'gpu'` does not sync at all.
- No compatibility-mode fallback path beyond the vertex-buffer default (§G.5.3).
- No WebGL backend, now or later.

---

## G.2 Placement

`apecs/gpu` is a subpath export alongside `apecs/react` and `apecs/solid`, with
`typegpu` as an optional peer dependency declared the same way `react` and
`solid-js` already are. Core stays zero-dependency. `sideEffects: false` already
holds, and `scripts/check-bundle.mjs` is where the leaf property is proved.

The one hook this tier needs inside core is in `Column.ensure` (§10.2): the page
allocator becomes pluggable so pages can come from a GPU-backed arena instead of
`new ctor(pageSize)`. That is the whole of the core change.

### G.2.1 The allocator is a constructor option

The arena is selected when the world is built, as `WorldOptions.allocator`
alongside `pageSize` and `maxEntities`:

```ts
import { World } from 'apecs';
import { gpuAllocator } from 'apecs/gpu';

const world = new World({ allocator: gpuAllocator(device) });
```

**Not a device.** Core takes an allocator, not a `GPUDevice`, and so needs no
WebGPU types in its public surface — the WebGPU dependency stays inside
`apecs/gpu` where the leaf property (§G.2) requires it. It is also the same hook
§10.5 already reserves for `SharedArrayBuffer` backing, which that section
states is "a constructor change". One hook serves both; a `device` option would
serve neither.

**Not a post-construction call.** An `attach(world, device)` after the fact
leaves a window in which a `'gpu'` trait can be spawned before an arena exists,
and both ways out of that window are bad: refuse the spawn, or allocate on the
JS heap and migrate the pages later. Since residency is decided when a page is
allocated, and the first `spawn` of a `'gpu'` trait allocates one, the arena has
to exist before any spawn — which means it belongs to construction.

---

## G.3 Residency

### G.3.1 Declaration

Residency is a trait option, next to `track` (§8.3):

```ts
const Transform = new Trait({ x: f32(0), y: f32(0), z: f32(0) }, { storage: 'gpu' });
const Tint = new Trait({ r: f32(1), g: f32(1), b: f32(1), a: f32(1) }, { storage: 'mirror' });
const Health = new Trait({ current: f32(100) }); // 'cpu', the default
```

| `storage`  | Columns live in         | CPU access                         | Cost                        |
| ---------- | ----------------------- | ---------------------------------- | --------------------------- |
| `'cpu'`    | JS heap (default)       | `each`, `get`, `chunks`            | none; unchanged from core   |
| `'gpu'`    | GPU buffer arena        | throws in dev, `undefined` in prod | no transfer, no CPU read    |
| `'mirror'` | both, CPU authoritative | all of the above                   | one upload per changed page |

Only numeric field kinds (`f32`, `i32`, `u32`, and the smaller integer widths
widened to 32 bits) may be `'gpu'` or `'mirror'`. A boxed or AoS trait (§3.1) is
`'cpu'` and it is an error to declare otherwise.

### G.3.2 Why it belongs on the trait

A query cannot own this. If `Transform`'s columns are on the JS heap, then
`query(Transform).compute(fn)` has exactly two honest implementations: upload
them, or refuse. Uploading costs **19× the compute it feeds** (§G.12), so an API
that reads as a peer of `each()` would be a performance trap by construction —
"add `.compute()` to make it faster" is precisely backwards.

Declaring it on the trait makes residency a decision made once, where the data
is defined, and lets `.compute()` and `.render()` verify it when the query is
built and fail loudly at construction rather than silently at 19×.

### G.3.3 GPU traits are AoS

A `'cpu'` trait is SoA: one column per field (§10.2). A `'gpu'` trait
**interleaves its fields into a single column**.

This inverts core's layout rule, and it is correct because the two rules serve
disjoint purposes. SoA exists to make `each()` scan linearly, and `each()` never
touches a `'gpu'` column. Meanwhile the default device limits are 8 vertex
buffers and 8 storage buffers per stage (§G.12.3) — one binding per _field_
exhausts them at three `vec3` traits, while one binding per _trait_ leaves room
for eight, with 16 attributes across them.

A `'mirror'` trait keeps the CPU side SoA and the GPU side interleaved; the
upload is a strided scatter rather than a `set()`, which is why `'mirror'` is
the more expensive mode and not the default.

### G.3.4 Pages, arenas, and stability

Column pages never reallocate (§10.2) — that guarantee is what this tier is
built on. A page's identity is therefore stable for its lifetime, so the mapping
from page to GPU buffer range is established once and survives every spawn,
despawn and structural change. Only archetype destruction invalidates it.

`PAGE_SIZE` is 4096 (§12.3). At 4 bytes per element that is 16 384 bytes, a
multiple of the 256-byte `minStorageBufferOffsetAlignment`, so **every page
boundary is a legal binding offset**. The paged layout core adopted for CPU view
stability happens to be exactly what the WebGPU binding model wants.

Pages are bound as _sized slices_, never as a whole buffer plus a length
uniform. See §G.12.2 — this is worth 2.8×.

---

## G.4 Compute

```ts
const integrate = world.query(Transform, Velocity).compute((t, v) => {
  'use gpu';
  t.x += v.x * Sim.$.dt;
  t.y += v.y * Sim.$.dt;
});

schedule.add('integrate', integrate); // a system, like any other (§G.13)
```

The callback takes the query's traits positionally, in term order, exactly as
`each` does (§4.2). The differences from `each` are the `'use gpu'` directive,
and that it dispatches once over every matching archetype instead of looping.

**Row index.** The shader never sees a row or an instance index. `t.x` resolves
to `binding[e]` where `e` is derived from `global_invocation_id`, because the
archetype is homogeneous — every row in it matches the query (§G.12.1).

**Uniforms.** World-level traits (`world.get(Sim)`, §4.5) map onto uniform
buffers. `Sim.$.dt` is TypeGPU's accessor syntax and needs no apecs concept.

**Workgroup size** defaults to 64 and is overridable per system. A dispatch is
one `dispatchWorkgroups` per page; the extent comes from `arrayLength()` on the
bound slice (§G.12.2).

**Limits.** `maxComputeWorkgroupsPerDimension` is 65 535, so a single 1-D
dispatch covers 4 194 240 rows. An archetype larger than that splits across
dispatches, which it already does at page granularity anyway.

### G.4.1 When to use it

The tier does not make a system faster by virtue of running on the GPU. Measured
at 200 000 entities over 120 steps (§G.12.4):

| system                     | `each()` | `.compute()` | speedup |
| -------------------------- | -------- | ------------ | ------- |
| integrate (2 flops/entity) | 40 ms    | 58 ms        | 0.68×   |
| orbit (~200 flops/entity)  | 6527 ms  | 92 ms        | 70.9×   |

The deciding variable is arithmetic intensity, not entity count. An elementwise
system loses even before transfer is counted — 42 ms of pure dispatch against
40 ms of `each()`. Dev builds should warn when a `.compute()` body is trivial
enough that the CPU tier would win.

---

## G.5 Rendering

```ts
world.query(Transform, Tint, With(Sprite)).render({
  vertex: (t, tint, { vertexIndex }) => {
    'use gpu';
    const corner = QUAD[vertexIndex];
    return {
      position: Camera.$.viewProj.mul(vec4f(t.x + corner.x, t.y + corner.y, t.z, 1)),
      color: tint.rgba,
    };
  },
  fragment: ({ color }) => {
    'use gpu';
    return color;
  },
  target: { blend: ALPHA },
});
```

### G.5.1 The asymmetry is the design

The vertex function takes the query's traits positionally — the same shape as
`each` and `.compute()` — plus a builtins bag. apecs binds each trait as
instance-rate data, so the user never writes `instance_index`. Its return value
is the varyings struct, with `position` as the builtin.

The fragment function takes those varyings and **has no ECS involvement at all**,
because fragments are not entities. It is handed to TypeGPU unchanged.

This asymmetry is deliberate and should not be smoothed over. TypeGPU already
models exactly this relationship (`TgpuVertexFn.Out`, `VertexOutToVarying`), so
the fragment half is passthrough rather than surface apecs has to design.

### G.5.2 One draw per archetype

A draw is `draw(vertexCount, archetype.rows)` per archetype, per page. Archetype
fragmentation is cheap: 26 archetypes cost 5% over a single monolithic dispatch,
244 pages cost 8% (§G.12.3).

### G.5.3 Instance data binds as vertex buffers

Instance data is bound as instance-rate vertex buffers (`arrayStride`,
`stepMode: 'instance'`), not as storage buffers indexed by `instance_index`.

The two measured identically — 932 µs against 915 µs for 100 000 sprites — so
this costs nothing, and storage buffers in the vertex stage are restricted or
unavailable under WebGPU compatibility mode. The portable option is free, so it
is the only option. `root.unwrap(vertexLayout)` yields the
`GPUVertexBufferLayout`.

This is the second reason `'gpu'` traits interleave (§G.3.3): a vertex buffer
per trait with attributes per field fits the 8-buffer, 16-attribute budget.

---

## G.6 Ordering and transparency

```ts
world
  .query(Transform, Tint, With(Transparent))
  .orderBy(Depth, 'desc')
  .render({ vertex, fragment, target: { blend: ALPHA } });
```

`orderBy` (§6.8) permutes **the archetype rows themselves** into key order
rather than materialising a side array. That is what makes back-to-front
transparency tractable here: the rows stay contiguous, so the draw keeps direct
instance addressing at 295 µs instead of the 825 µs an index buffer costs
(§G.12.1). Every ECS that sorts into an index list pays the gather; this one
does not.

It is also adaptive. The permutation is not retained — the data is left in
order, so the next sort starts from the identity over rows that are already
sorted. Frame-coherent camera motion costs close to nothing.

Two constraints carry over from §6.8 unchanged: one ordered view per archetype
(a second thrashes, and dev warns), and no reorder inside a walk.

### G.6.1 Ordering couples to residency

A permute moves rows, which invalidates any page-to-buffer mapping keyed by row
(§G.3.4). For a `'gpu'` column the permute must therefore execute **on the
GPU**. `Column.permute` already receives its permutation as packed cycles
(§6.8), so this is a small compute kernel over that cycle array, not a redesign.

For a `'mirror'` column the permute happens on the CPU as it does today and
marks the affected pages for re-upload.

This is the only place in this document where two tiers genuinely couple, and it
is worth implementing `orderBy` + `'gpu'` together rather than discovering the
interaction later.

---

## G.7 Visibility and culling

**Visibility must never be a trait.** The obvious ECS instinct — add `Visible`
after a frustum test, remove it when it fails — is ruled out by core's own
benchmark: adding and removing a trait across 100 000 entities costs **20.6 ms**
(`add_remove`, §12.1). That is an entire frame budget, every frame, before
anything is drawn.

Culling is therefore either an in-place flag written by a compute pass, or
GPU-driven:

```ts
const visible = query.cull((t) => {
  'use gpu';
  return Camera.$.frustum.contains(t.xyz);
});
visible.render({ vertex, fragment }); // drawIndirect; the count never reaches the CPU
```

`cull` compiles to a compute pass that writes an indirect draw argument buffer,
and `render` then issues `drawIndirect`. The instance count is produced and
consumed on the GPU and never round-trips.

WebGPU has `drawIndirect` but no portable multi-draw-indirect, so this is one
indirect draw per archetype — which §G.5.2 already establishes is cheap.

---

## G.8 Archetype as shader permutation

With `Optional()` terms, every matching archetype holds a _different trait
subset_. That subset is exactly a shader permutation key:

```ts
world.query(Transform, Optional(Tint), Optional(Texture)).render({ ... });
```

Rather than one shader branching on "does this entity have a tint?", the tier
generates a specialised pipeline per archetype: no branches, no dead bindings,
and a permutation count bounded by the number of matching archetypes rather than
combinatorially by the optional terms.

This is the same discipline `codegen.ts` already applies in the JS tier, and it
inherits the same hazard: shader modules must be cached per archetype signature,
and two archetypes with identical signatures must share one module. The
`distinct()` rule (§12.2) is the JS-tier analogue of the same problem and its
reasoning transfers.

---

## G.9 Hierarchy propagation

Parent-to-child transform propagation needs a barrier per depth level: level _n_
cannot start until _n−1_ has finished. The depth table already exists —
`SortKey` admits a relation's `TargetIndex` for `Cascade` (§7.6).

```ts
world.query(LocalTransform, WorldTransform, Cascade(ChildOf)).compute((local, world_, parent) => {
  'use gpu';
  world_.m = parent.m.mul(local.m);
});
```

The tier issues one dispatch per depth level, in `Cascade` order, with the
implicit barrier between passes. The dependency structure the ECS already
maintains _is_ the barrier schedule; nothing new needs computing.

---

## G.10 Passes

A pass is an entity. Resources are entities. Ordering is a relation, traversed
with `Cascade` (§7.6):

```ts
const shadow = world.spawn(Pass, Named('shadow'), Writes(shadowMap));
const main = world.spawn(Pass, Named('main'), RunsAfter(shadow), Writes(surface));
```

This is not a new design: it is `examples/gpu-water/src/traits.ts` promoted from
an example to a module. `Buf`, `Bind`, `Computes`, `Draws`, `Dispatch`,
`RunsAfter`, `Reads`, `Writes` and the `Cascade` depth sort over `RunsAfter` are
already written and already work. Resource lifetime is a `'remove'` observer
calling `destroy()`, which is the whole of that demo's resource management.

Systems produced by `.compute()` and `.render()` register with the scheduler
(§S.4) rather than being called by hand, so pass ordering comes from `RunsAfter`
rather than from call order.

### G.10.1 Views

Multiple cameras, shadow maps and reflection probes are the same query rendered
more than once with different uniforms. A view is an entity carrying `Camera`
and `Viewport`; `pass.view(entity)` selects it.

### G.10.2 Picking

Rendering is the good case precisely because nothing reads back (§G.12.4).
Entity-ID picking is the one legitimate exception, and it is asynchronous:

```ts
const hit: Entity | undefined = await pass.pick(x, y);
```

The double-buffered `mapAsync` staging in `examples/gpu-water/src/readback.ts`
already handles the 1–2 frame latency correctly and is the implementation.

---

## G.11 The TypeGPU seam

### G.11.1 What TypeGPU provides

Verified against `typegpu@0.12.5`:

- `tgpu.initFromDevice({ device })` — wraps a device apecs already owns.
- `root.createBuffer(schema, gpuBuffer)` — wraps an **existing** `GPUBuffer`, so
  apecs keeps ownership of every page allocation.
- `root.unwrap(x)` — returns raw WebGPU for pipelines, bind groups, bind group
  layouts, buffers, texture views, vertex layouts, encoders and passes.
- `d.*` data schemas; apecs field kinds map onto them 1:1.
- `tgpu.vertexFn` / `fragmentFn` / `computeFn` shells, the `'use gpu'`
  transpiler, `bindGroupLayout`, `createRenderPipeline`.

A compute pipeline also accepts a raw `GPUBindGroup`, and will dispatch into a
pass it does not own. The ownership split this document assumes is explicitly
supported rather than worked around.

### G.11.2 What apecs must build

The page allocator and `storage` (§G.3); `Trait → d.struct` schema derivation;
query → bind group layouts, vertex layouts and per-archetype bind groups with
sized slices; the dispatch and draw loops; the pass graph extraction (§G.10).

The WGSL generation, the typed schema system and the transpiler are all
TypeGPU's and must not be reimplemented.

### G.11.3 Tiers

| tier | requires             | provides                                                    |
| ---- | -------------------- | ----------------------------------------------------------- |
| 0    | nothing              | apecs generates WGSL; the user writes WGSL bodies           |
| 1    | `typegpu`            | typed buffers, schemas from traits, layouts, typed readback |
| 2    | `+ unplugin-typegpu` | `'use gpu'` TypeScript bodies                               |

A JS function body **requires** the build plugin — without it TypeGPU raises
"Missing metadata for tgpu.fn function body". Raw WGSL strings and template
literals need no plugin. Tier 0 must therefore remain a supported, documented
path, in the same spirit as the `CAN_CODEGEN` probe and its generic-cursor
fallback (§6.5).

### G.11.4 Version risk

`typegpu` is pre-1.0, and two API moves were observed while drafting this
document (`withCompute` left `~unstable`; `layout.$` is shader-context-only).
Pin a narrow supported range rather than a caret, and keep an integration test
in CI that constructs a pipeline end to end.

---

## G.12 Performance

All figures measured 2026-09-08 on Apple M1 via Deno's WebGPU, 1 000 000 rows
and four `f32` columns (16 MB of state) unless stated otherwise. These are the
numbers the design above is derived from; a change that regresses one of them is
a change to this document.

### G.12.1 Direct indexing is the central claim

| binding and indexing strategy             | µs   |
| ----------------------------------------- | ---- |
| archetype slice, `arrayLength()` guard    | 295  |
| no guard, dispatch sized to the binding   | 319  |
| 244 page-sized dispatches, 4096 rows each | 345  |
| extent read from a uniform                | 825  |
| entity index buffer, ids ascending        | 825  |
| entity index buffer, ids shuffled         | 6359 |

A sparse-set ECS hands a shader a list of entity ids, making every access an
unprovable gather. An archetype is homogeneous and contiguous, so the shader
indexes directly. That is **2.8×**, and it is structural rather than an
optimisation — no amount of tuning recovers it on the other layout.

The 825 → 6359 µs row is the hazard that comes with index buffers and is worth
recording even though this design avoids them: an id list that degrades from
ascending to shuffled costs a further **7.7×**.

### G.12.2 Never take an extent from a uniform

`if (g.x >= p.count)` costs 825 µs where `if (g.x >= arrayLength(&px))` costs
295 µs. With the count in a uniform the driver cannot prove the accesses are in
bounds and clamps every load. Bind each page as a sized slice and let
`arrayLength` come from the binding: identical information, one third of the
cost.

### G.12.3 Transfer, fragmentation, limits

| quantity                           | measured      |
| ---------------------------------- | ------------- |
| `writeBuffer` of 16 MB             | 4060 µs       |
| the compute kernel it feeds        | 214 µs        |
| **transfer against compute**       | **19×**       |
| 26 archetypes against one dispatch | +5%           |
| 244 page dispatches against one    | +8%           |
| 1000 archetypes (pathological)     | +226%         |
| instance data via vertex buffers   | 932 µs / 100k |
| instance data via storage buffers  | 915 µs / 100k |

Default device limits, which portable code must assume (an M1 adapter supports
more, but a device created without `requiredLimits` does not get it):

| limit                              | default |
| ---------------------------------- | ------- |
| `maxStorageBuffersPerShaderStage`  | 8       |
| `maxVertexBuffers`                 | 8       |
| `maxVertexAttributes`              | 16      |
| `maxBindGroups`                    | 4       |
| `maxComputeWorkgroupsPerDimension` | 65535   |
| `minStorageBufferOffsetAlignment`  | 256     |

### G.12.4 Budget

- A `.compute()` system over resident data must stay within **1.1×** of a
  hand-written dispatch of the same kernel. The tier adds bind group selection
  and a loop over archetypes; it must add nothing else.
- `.render()` must issue **one draw per archetype page** and allocate nothing
  per frame once bind groups are warm.
- Dev builds must warn when `.compute()` is used on a body whose arithmetic
  intensity is low enough that `each()` would win (§G.4.1).
- Uploading a `'mirror'` trait must be gated on `Column.lastWriteTick` (§8.3),
  so an unchanged page costs one comparison.

---

## G.13 API surface

```ts
// apecs
interface TraitOptions {
  track?: boolean;
  storage?: 'cpu' | 'gpu' | 'mirror'; // new; default 'cpu'
}

// apecs
interface WorldOptions {
  pageSize?: number;
  maxEntities?: number;
  allocator?: PageAllocator; // new; default allocates on the JS heap
}

// apecs/gpu
function gpuAllocator(device: GPUDevice): PageAllocator;

interface QueryResult<T> {
  compute(fn: ComputeFn<T>, options?: { workgroupSize?: number }): GpuSystem;
  render(spec: RenderSpec<T>): RenderSystem;
  cull(fn: CullFn<T>): QueryResult<T>;
}

/** Both tiers produce a system. A schedule runs it; `run` is the hand-driven escape hatch. */
interface GpuSystem {
  (world: World): void; // the SystemFn shape §S.3 already takes
  run(): void;
}
interface RenderSystem extends GpuSystem {
  view(camera: Entity): this;
  pick(x: number, y: number): Promise<Entity | undefined>;
}
```

Frozen for v1: `storage`, the callback shapes of `compute` and `render`, and the
rule that both take query terms positionally in term order.

Neither tier is invoked by the call that builds it. `compute` and `render` both
return a system and neither runs until a schedule runs it (§G.10), so the two
read the same way at the call site and pass ordering stays in `RunsAfter`
rather than in the order the file happens to execute. A frame driven by hand
calls `.run()` on either — the same escape hatch, spelled the same way.

---

## G.14 Open questions

1. **Arena growth.** A non-shared `WebAssembly`-style growable buffer detaches
   its views; WebGPU buffers do not grow at all. Either preallocate a fixed
   arena per archetype and copy on overflow, or accept one buffer per page and
   more bind groups. §G.12.3 says 244 page bind groups cost 8%, which suggests
   the second is acceptable, but it has not been measured against growth churn.
2. **`'mirror'` sync point.** Syncing at `world.step()` is the obvious choice
   and matches the tick model (§8.3), but a system that writes on the GPU and
   reads on the CPU in the same frame needs a finer boundary.
3. **Does `cull` belong on the query?** It reads as a filter but is a compute
   pass with a side effect. An alternative is an explicit `IndirectDraw`
   resource that `render` consumes, which is less pretty and more honest.
4. **Structural change during a dispatch.** §9 governs CPU walks. A dispatch is
   asynchronous, so the equivalent rule — and whether dev builds can detect a
   violation at all — is unspecified.
5. **Timestamp queries** for per-pass timing, which devtools (§15) would want
   and which TypeGPU already exposes via `withTimestampWrites`.
