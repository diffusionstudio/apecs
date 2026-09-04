# apecs × WebGPU — a fluid in a box

Twenty-four thousand rods, each one an entity. A particle fluid solver runs on the CPU in
TypeScript as a chunk walk over apecs columns, and those same columns are handed to WebGPU as
vertex buffers. No compute shaders, no WASM, no repacking step between the two.

```bash
npm install
npm run dev
```

Needs a browser with WebGPU: Chrome, Edge, Safari 26, or Firefox 141+.

## What it shows

| On screen                      | In apecs                                                           |
| ------------------------------ | ------------------------------------------------------------------ |
| the mass sloshing in the box   | `query(Position, Velocity, Rod, Tint, Surface).chunks()` — Tier 3  |
| moving the mouse through it    | a `Pointer` world trait the solver reads each substep              |
| holding to gather it up        | the same trait, with `hold` set                                    |
| the population buttons         | `spawnMany` / `despawnMany`, one archetype transition each         |
| the fluid sliders              | world traits on the world entity, written with `world.set`         |
| the stats panel                | a `Stats` world trait read through `useField` from `apecs/react`   |
| every rod's colour and heading | `Tint` and `Rod` columns, written in the same walk that reads them |

## Layout

- `src/sim.ts` — traits, the world, and the solver. Nothing here knows about the GPU.
- `src/main.tsx` — the frame: step the world, walk the chunks into the vertex buffers, draw.
- `src/renderer.ts` — WebGPU: the column buffers, the shadow map, one pass with MSAA.
- `src/shaders.ts` — WGSL for the room and the rods.
- `src/ui.tsx` — the overlay, entirely driven by `apecs/react` hooks.

## The solver

Clavet's double density relaxation, the scheme behind _Particle-based Viscoelastic Fluid
Simulation_ (2005). Each step predicts positions from velocity, measures a density and a near
density per particle, then displaces neighbouring pairs apart under a pressure that goes negative
below the rest density — which is what holds the mass together as a blob with a free surface
instead of letting it spread over the floor. Velocity is read back from the positions the
relaxation settled on.

Both neighbour passes run over a counting-sorted uniform grid. Three details carry most of the
speed, all of them measured rather than assumed:

- **Gather, don't scatter.** Visiting the whole 3×3 stencil and accumulating into registers costs
  twice as many distance tests as visiting half of it and writing into both rows, and runs a
  little over twice as fast. Scattered read-modify-writes are the expensive part, not arithmetic.
- **`+(condition)`, not `condition ? 1 : 0`.** The density pass appends its in-range neighbours to
  a list so the relaxation visits ten of them instead of thirty candidates. Written as a ternary,
  TurboFan emits a jump that mispredicts two thirds of the time and the pass costs 15 ns a row;
  written as a boolean coercion it is branchless and costs 3.5 ns.
- **Clamp with `Math.max`, not a branch.** Same reason: two thirds of the candidates in the
  stencil fall outside the radius, so a branch there is a coin flip.

The scheme is only conditionally stable — a particle must not travel far compared with the kernel
radius in one step — so the frame is split into substeps. Two is enough at these settings; the
`pressure` slider will find the edge if you push it.

## URL parameters

- `?n=48000` — initial population (default 24,000).
- `?dpr=1` — cap the device pixel ratio (default 2).

## Notes on cost

About 15 ms of CPU for 24,000 particles on an Apple M1, and well under a millisecond to hand the
columns to the GPU. The box is a single raycast in a fragment shader and the rods are one
instanced draw of two triangles each, so the GPU is not what bounds the frame.
