/**
 * The overlay reads the world through `apecs/react`: the buttons write the
 * `Sim` trait, and the `Changed(Sim)` system in `frame.ts` picks the write up
 * on the next frame. There is no state here that the world does not hold.
 */
import { useTrait, useWorld } from 'apecs/react';

import { Sim } from './traits';

const COUNTS = [65536, 196608, 262144] as const;

export function Overlay() {
  const world = useWorld();
  const sim = useTrait(Sim);
  if (!sim) {
    return null;
  }

  return (
    <aside>
      <h1>WebGPU water with apecs</h1>
      <p>
        An MLS-MPM fluid solved on the GPU, released as a dam break down a long tank. Every buffer,
        texture and pass is an entity; ordering the frame is a <code>Cascade</code> over a{' '}
        <code>RunsAfter</code> relation, and the ball is a rigid body the water pushes back on.
      </p>
      <p className="hint">Drag the ball. Drag the background to orbit, wheel to zoom.</p>
      <nav>
        {COUNTS.map((count) => (
          <button
            key={count}
            type="button"
            aria-pressed={count === sim.count}
            onClick={() => world.set(Sim, { count })}
          >
            {Math.round(count / 1024)}k
          </button>
        ))}
      </nav>
      <footer>
        Solver after{' '}
        <a href="https://github.com/holtsetio/flow" target="_blank" rel="noreferrer">
          holtsetio/flow
        </a>
        . Built with{' '}
        <a href="https://github.com/diffusionstudio/apecs" target="_blank" rel="noreferrer">
          apecs
        </a>
        .
      </footer>
    </aside>
  );
}
