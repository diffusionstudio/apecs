# apecs × WebGPU — water in a box

Two hundred thousand MLS-MPM particles on the GPU, released as a dam break down a long tank, and a
ball you can pick up and drop back in. Everything with an identity is an entity: the buffers, the
textures, the compute and render passes, the order they run in, and the ball.

```bash
npm install
npm run dev
```

Needs a browser with WebGPU: Chrome, Edge, Safari 26, or Firefox 141+.

Drag the ball. Drag anywhere else to orbit, wheel to zoom. The water starts stacked against one end
— the first few seconds are the front running the length of the tank and picking the ball up.

## Where the seam is

A hundred thousand particles cannot be entities. Keeping apecs authoritative over them would need a
GPU→CPU readback of every particle every frame, which is a pipeline stall, and there is no version
of "GPU fluid" where `query(Position, Velocity)` owns the water.

So the ECS moved up a level, to where it is the right tool anyway:

| On screen                        | In apecs                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------- |
| every GPU buffer and texture     | an entity holding an AoS trait; `on('remove', …)` calls `destroy()`          |
| the order the frame runs in      | `query(…, Cascade(RunsAfter))` — a depth sort the ECS already maintains      |
| what each pass draws into        | `Writes` / `DepthOf`, exclusive relations read at encode time                |
| resizing the window              | textures replaced, `on('change', Tex, …)` marks every reader `Stale`         |
| rebuilding the stale bind groups | `query(Binder, With(Stale))`                                                 |
| the particle-count slider        | `query(Sim, Changed(Sim))` — reseeding 192k particles is not a per-frame job |
| the ball                         | `Transform`, `Velocity`, `Spin`, `Body`, and `Not(Held)` while it floats     |
| dragging it                      | `With(Held)` — the same entity, kinematic instead of dynamic                 |
| the panel and the graph listing  | `apecs/react` hooks over the same world, no store of their own               |

`world.query(Reads(texture))` is the load-bearing one: resources do not keep back-pointers to the
passes that use them, so "who has to rebuild?" is a relation index lookup rather than bookkeeping.

## Layout

- `src/traits.ts` — every trait and relation in the demo. Read this first.
- `src/build.ts` — spawns the resources, the pipelines, and the two `RunsAfter` chains.
- `src/frame.ts` — the systems: uniforms, the graph walk, the ball, the camera.
- `src/shaders/mpm.ts` — the solver.
- `src/shaders/render.ts` — the tiled floor, the sphere impostors, the blur, the composite.
- `src/main.tsx` — the world subclass, input, and the loop.
- `src/ui.tsx` — the overlay: a title, a line of prose, and three buttons.

## The solver

MLS-MPM (Hu et al. 2018) for a weakly compressible fluid, in grid units so every `inv_dx` in the
paper disappears. Five dispatches a substep, three substeps a frame. Grid momentum is fixed-point
because WebGPU has no float atomics.

Notes, all of them things that were wrong first:

- **The two P2G halves cannot be one pass.** The pressure a particle scatters depends on the density
  every _other_ particle deposited, and a workgroup barrier does not span a dispatch.
- **Seed on a lattice, not at random.** Poisson clumping in a uniform fill varies the local density
  by tens of percent, and a stiff equation of state answers that with an impulse on the first
  substep that the pool never finishes ringing from.
- **Aim the dam at a height, not at the ceiling.** The column is sized to about twice the level the
  water will settle to. Taller makes a faster front, and past that it stops looking like a wave and
  starts firing anything floating at the far wall — the ball ended every run wedged in a corner.
- **A one-sided separating boundary cannot produce buoyancy.** Gravity kicks every grid node down by
  `g·dt` each substep, which reads as _approaching_ on the ball's upper hemisphere and _receding_ on
  its lower one, so the constraint fires above and stays quiet below: the net vertical impulse points
  down however buoyant the body is. The horizontal components carry no such bias. The shader
  therefore also reports the water line in the ball's footprint, and the vertical force is Archimedes
  against a spherical cap. The ball still pushes the water — that half is the grid boundary itself.
- **Added mass divides the whole acceleration, gravity included.** Applied to the fluid terms alone
  it leaves the weight undivided and the ball sinks however buoyant it is. A sphere lighter than the
  fluid it displaces is a nearly undamped oscillator without it.
- **Clamp the grid velocity to a fraction of a cell per substep.** It is the difference between a
  splash and a NaN.

## The water

Screen-space: the particles are never a surface, they are a depth buffer smoothed until it behaves
like one. Depth → bilateral blur → normals from finite differences → refract the tiles behind it,
absorb per channel, reflect the sky.

- **The blur kernel is a multiple of the particle's _projected_ size**, so the surface smooths by the
  same amount near and far, and the bilateral's depth sigma is in world units — below a rest spacing
  it rejects the whole neighbourhood and leaves the sphere facets it exists to remove.
- **Reconstruct normals from a two-pixel stencil.** At one pixel the noise the blur leaves behind is
  the same size as the slope being measured, and the surface breaks into facets.
- **A ray crosses every particle whose centre is within the impostor radius**, not just the ones on
  the line, so the raw sum of chords overcounts by an order of magnitude. Scaling it by
  `1 / (ρ · sphere volume)` turns it back into a path length in cells, which is what makes shallow
  water clear and deep water blue with one absorption coefficient.
- **Absorption is per channel and the ratio is the whole look.** Red dies within a couple of cells,
  blue survives fifteen, so the shallows read clear and the middle reads ocean — one coefficient,
  no depth-tinting hack. Pushed too far the ball goes black the moment a wave covers it.
- Everything is linear light until the last line of the composite. Colours picked by eye have to be
  squared going in, or the whole scene washes out — and the S-curve goes _after_ the transfer
  function, or a bright environment compresses into the Reinhard shoulder and comes out flat.
- The ground is a viewport grid rather than a texture: two line sets an octave apart, each
  antialiased against the plane's screen-space derivative and faded out as its spacing drops below a
  couple of pixels. Without that fade the horizon is moire.

## Two bugs this turned up in apecs

Both are fixed, with regression tests, in the same commit:

- `maskSuperset` compared a signed `&` result against an unsigned `Uint32Array` read, so a query on
  local trait id **31** (or 63, or 95) matched nothing. This demo declares enough traits to reach it.
- A reactive cell was removed from its dispatch table when its last listener left and never put back
  when it was subscribed again — so under React StrictMode, which mounts every effect twice, every
  `apecs/react` hook returned its mount-time value forever.
