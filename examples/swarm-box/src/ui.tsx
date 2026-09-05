import { useField, useWorld, WorldProvider } from 'apecs/react';
import type { ReactElement } from 'react';

import type { Renderer } from './renderer';
import { Sim, Stats, Swarm, fmt } from './sim';

const POPULATIONS = [16_000, 32_000, 64_000];

export function App(props: { sim: Sim; renderer: Renderer }): ReactElement {
  return (
    <WorldProvider world={props.sim.world}>
      <Brand />
      <Controls sim={props.sim} renderer={props.renderer} />
      <p className="panel hint">
        move to stir · <kbd>hold</kbd> to gather · <kbd>space</kbd> to scatter the flock
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
        A swarm in a box. Every rod is an entity; steering is a chunk walk over apecs columns, and
        those columns are the vertex buffers.
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
  const align = useField(Swarm.align) ?? 0;
  const cohere = useField(Swarm.cohere) ?? 0;
  const separate = useField(Swarm.separate) ?? 0;
  const flow = useField(Swarm.flow) ?? 0;
  const churn = useField(Swarm.churn) ?? 0;
  const speed = useField(Swarm.speed) ?? 0;
  const drift = useField(Swarm.drift) ?? 0;
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
      <div className="section">swarm · world traits</div>
      <Slider
        label="align"
        value={align}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Swarm.align, v)}
      />
      <Slider
        label="cohere"
        value={cohere}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Swarm.cohere, v)}
      />
      <Slider
        label="separate"
        value={separate}
        min={0.2}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Swarm.separate, v)}
      />
      <Slider
        label="flow"
        value={flow}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Swarm.flow, v)}
      />
      <Slider
        label="churn"
        value={churn}
        min={0}
        max={4}
        step={0.05}
        onChange={(v) => world.set(Swarm.churn, v)}
      />
      <Slider
        label="speed"
        value={speed}
        min={0.2}
        max={2.5}
        step={0.05}
        onChange={(v) => world.set(Swarm.speed, v)}
      />
      <Slider
        label="hue drift"
        value={drift}
        min={0}
        max={0.3}
        step={0.005}
        onChange={(v) => world.set(Swarm.drift, v)}
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
