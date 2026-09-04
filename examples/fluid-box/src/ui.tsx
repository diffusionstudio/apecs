import { useField, useWorld, WorldProvider } from 'apecs/react';
import type { ReactElement } from 'react';

import type { Renderer } from './renderer';
import { Fluid, Sim, Stats, fmt } from './sim';

const POPULATIONS = [12_000, 24_000, 48_000];

export function App(props: { sim: Sim; renderer: Renderer }): ReactElement {
  return (
    <WorldProvider world={props.sim.world}>
      <Brand />
      <Controls sim={props.sim} renderer={props.renderer} />
      <p className="panel hint">
        move to stir · <kbd>hold</kbd> to pull · <kbd>space</kbd> to shake the box
      </p>
    </WorldProvider>
  );
}

function Brand(): ReactElement {
  const count = useField(Stats.count) ?? 0;
  const solve = useField(Stats.solve) ?? 0;
  const upload = useField(Stats.upload) ?? 0;
  const frame = useField(Stats.frame) ?? 0;
  const fps = useField(Stats.fps) ?? 0;
  const pairs = useField(Stats.pairs) ?? 0;
  const chunks = useField(Stats.chunks) ?? 0;
  const hue = useField(Stats.hue) ?? 0;
  return (
    <section className="panel brand">
      <h1>
        apecs <span>× WebGPU</span>
      </h1>
      <p className="claim">
        A particle fluid in a box. Every rod is an entity; the solver is a chunk walk over apecs
        columns, and those columns are the vertex buffers.
      </p>
      <div className="big">
        {fmt(count)}
        <small>entities</small>
      </div>
      <dl className="stats">
        <dt>solve</dt>
        <dd>{solve.toFixed(2)} ms</dd>
        <dt>upload</dt>
        <dd>{upload.toFixed(2)} ms</dd>
        <dt>frame</dt>
        <dd>
          {frame.toFixed(1)} ms · {fps.toFixed(0)} fps
        </dd>
        <dt>pairs / step</dt>
        <dd>{fmt(pairs)}</dd>
        <dt>chunks</dt>
        <dd>{chunks}</dd>
        <dt>hue</dt>
        <dd>
          <i className="swatch" style={{ background: `hsl(${hue.toFixed(0)} 90% 55%)` }} />
          {hue.toFixed(0)}°
        </dd>
      </dl>
    </section>
  );
}

function Controls(props: { sim: Sim; renderer: Renderer }): ReactElement {
  const { sim, renderer } = props;
  const world = useWorld();
  const count = useField(Stats.count) ?? 0;
  const gravity = useField(Fluid.gravity) ?? 0;
  const viscosity = useField(Fluid.viscosity) ?? 0;
  const cohesion = useField(Fluid.cohesion) ?? 0;
  const pressure = useField(Fluid.pressure) ?? 0;
  const drift = useField(Fluid.drift) ?? 0;
  const slosh = useField(Fluid.slosh) ?? 0;
  return (
    <section className="panel controls">
      <div className="section">population · spawnMany / despawnMany</div>
      <div className="row">
        {POPULATIONS.map((n) => (
          <button key={n} className={n === count ? 'on' : undefined} onClick={() => sim.resize(n)}>
            {`${n / 1000}k`}
          </button>
        ))}
      </div>
      <div className="section">fluid · world traits</div>
      <Slider
        label="gravity"
        value={gravity}
        min={0}
        max={8}
        step={0.1}
        onChange={(v) => world.set(Fluid.gravity, v)}
      />
      <Slider
        label="viscosity"
        value={viscosity}
        min={0}
        max={6}
        step={0.1}
        onChange={(v) => world.set(Fluid.viscosity, v)}
      />
      <Slider
        label="pressure"
        value={pressure}
        min={0.5}
        max={6}
        step={0.1}
        onChange={(v) => world.set(Fluid.pressure, v)}
      />
      <Slider
        label="cohesion"
        value={cohesion}
        min={0}
        max={5}
        step={0.1}
        onChange={(v) => world.set(Fluid.cohesion, v)}
      />
      <Slider
        label="slosh"
        value={slosh}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => world.set(Fluid.slosh, v)}
      />
      <Slider
        label="hue drift"
        value={drift}
        min={0}
        max={0.3}
        step={0.005}
        onChange={(v) => world.set(Fluid.drift, v)}
      />
      <div className="section">look</div>
      <Slider
        label="rod length"
        value={renderer.look.length}
        min={0.5}
        max={5}
        step={0.05}
        onChange={(v) => {
          renderer.look.length = v;
        }}
      />
      <Slider
        label="exposure"
        value={renderer.look.exposure}
        min={0.3}
        max={2.5}
        step={0.05}
        onChange={(v) => {
          renderer.look.exposure = v;
        }}
      />
    </section>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}): ReactElement {
  return (
    <label className="slider">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.value}
        onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
      />
      <output>{props.value.toFixed(2)}</output>
    </label>
  );
}
