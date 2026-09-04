/**
 * The overlay: every number comes from the world through `apecs/react`. Stats
 * and physics are world traits; the inspector follows the selected entity.
 */
import { useField, useHas, useWorld, WorldProvider } from 'apecs/react';
import type { Entity } from 'apecs';
import type { ReactElement } from 'react';

import type { Renderer } from './renderer';
import { Ember, Physics, Position, Selection, Sim, Stats, Velocity, fmt } from './sim';

const POPULATIONS = [250_000, 500_000, 1_000_000, 2_000_000];

export function App(props: { sim: Sim; renderer: Renderer }): ReactElement {
  return (
    <WorldProvider world={props.sim.world}>
      <Brand />
      <Controls sim={props.sim} renderer={props.renderer} />
      <Inspector />
      <p className="panel hint">
        move to attract · <kbd>hold</kbd> to repel · <kbd>click</kbd> a particle to inspect it
      </p>
    </WorldProvider>
  );
}

function Brand(): ReactElement {
  const count = useField(Stats.count) ?? 0;
  const embers = useField(Stats.embers) ?? 0;
  const sim = useField(Stats.sim) ?? 0;
  const upload = useField(Stats.upload) ?? 0;
  const frame = useField(Stats.frame) ?? 0;
  const fps = useField(Stats.fps) ?? 0;
  const draws = useField(Stats.draws) ?? 0;
  const chunks = useField(Stats.chunks) ?? 0;
  const lastOp = useField(Stats.lastOp) ?? '';
  const lastOpMs = useField(Stats.lastOpMs) ?? 0;
  return (
    <section className="panel brand">
      <h1>
        apecs <span>× WebGPU</span>
      </h1>
      <p className="claim">
        Every particle is an entity. Physics runs on the CPU in TypeScript; the GPU only draws. The
        ECS columns are the vertex buffers.
      </p>
      <div className="big">
        {fmt(count)}
        <small>entities</small>
      </div>
      <dl className="stats">
        <dt>simulate</dt>
        <dd>{sim.toFixed(2)} ms</dd>
        <dt>upload</dt>
        <dd>{upload.toFixed(2)} ms</dd>
        <dt>frame</dt>
        <dd>
          {frame.toFixed(1)} ms · {fps.toFixed(0)} fps
        </dd>
        <dt>chunks / draws</dt>
        <dd>
          {chunks} / {draws}
        </dd>
        <dt>burning</dt>
        <dd className={embers > 0 ? 'ember' : undefined}>{fmt(embers)}</dd>
      </dl>
      <div className="op">
        <span>{lastOp}</span>
        {lastOp !== '' && <b>{lastOpMs.toFixed(1)} ms</b>}
      </div>
    </section>
  );
}

function Controls(props: { sim: Sim; renderer: Renderer }): ReactElement {
  const { sim, renderer } = props;
  const world = useWorld();
  const count = useField(Stats.count) ?? 0;
  const gravity = useField(Physics.gravity) ?? 0;
  const swirl = useField(Physics.swirl) ?? 0;
  const drag = useField(Physics.drag) ?? 0;
  return (
    <section className="panel controls">
      <div className="section">population · spawnMany / despawnMany</div>
      <div className="row">
        {POPULATIONS.map((n) => (
          <button key={n} className={n === count ? 'on' : undefined} onClick={() => sim.resize(n)}>
            {n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`}
          </button>
        ))}
      </div>
      <div className="section">archetypes · addMany / removeMany</div>
      <div className="row">
        <button className="fire" onClick={() => sim.ignite(0.35)}>
          ignite around cursor
        </button>
        <button onClick={() => sim.extinguish()}>extinguish</button>
      </div>
      <div className="section">physics · world traits</div>
      <Slider
        label="gravity"
        value={gravity}
        min={0}
        max={4}
        step={0.05}
        onChange={(v) => world.set(Physics.gravity, v)}
      />
      <Slider
        label="swirl"
        value={swirl}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Physics.swirl, v)}
      />
      <Slider
        label="drag"
        value={drag}
        min={0}
        max={3}
        step={0.05}
        onChange={(v) => world.set(Physics.drag, v)}
      />
      <div className="section">look</div>
      <Slider
        label="trail"
        value={renderer.look.trail}
        min={0.5}
        max={0.97}
        step={0.01}
        onChange={(v) => {
          renderer.look.trail = v;
        }}
      />
      <Slider
        label="exposure"
        value={renderer.look.exposure}
        min={0.2}
        max={4}
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

function Inspector(): ReactElement | null {
  const selected = useField(Selection.entity);
  if (selected === undefined || selected === 0) {
    return null;
  }
  return <EntityPanel entity={selected} />;
}

function EntityPanel(props: { entity: Entity }): ReactElement {
  const { entity } = props;
  const world = useWorld();
  const x = useField(entity, Position.x) ?? 0;
  const y = useField(entity, Position.y) ?? 0;
  const vx = useField(entity, Velocity.x) ?? 0;
  const vy = useField(entity, Velocity.y) ?? 0;
  const burning = useHas(entity, Ember);
  const life = useField(entity, Ember.life);

  const id = entity >>> 0;
  const hi = (entity / 2 ** 32) | 0;
  const generation = hi & 0xfff;
  const worldId = hi >>> 12;

  return (
    <section className="panel inspector">
      <h2>
        entity
        <button style={{ flex: 'none' }} onClick={() => world.set(Selection.entity, 0 as Entity)}>
          ×
        </button>
      </h2>
      <div className="handle">
        id <b>{id}</b> · gen <b>{generation}</b> · world <b>{worldId}</b>
      </div>
      <div className="trait">
        <header>Position</header>
        <div className="fields">
          <span>x</span>
          <span>{x.toFixed(4)}</span>
          <span>y</span>
          <span>{y.toFixed(4)}</span>
        </div>
      </div>
      <div className="trait">
        <header>Velocity</header>
        <div className="fields">
          <span>x</span>
          <span>{vx.toFixed(4)}</span>
          <span>y</span>
          <span>{vy.toFixed(4)}</span>
          <span>speed</span>
          <span>{Math.hypot(vx, vy).toFixed(4)}</span>
        </div>
      </div>
      <div className="trait">
        <header className={burning ? 'ember' : 'absent'}>
          {burning ? 'Ember' : 'Ember — not present'}
        </header>
        {burning && (
          <div className="fields">
            <span>life</span>
            <span>{(life ?? 0).toFixed(3)}</span>
          </div>
        )}
      </div>
      <div className="row">
        {burning ? (
          <button onClick={() => world.remove(entity, Ember)}>remove Ember</button>
        ) : (
          <button className="fire" onClick={() => world.add(entity, Ember)}>
            add Ember
          </button>
        )}
        <button onClick={() => world.set(entity, Velocity, { x: (Math.random() - 0.5) * 4, y: 3 })}>
          kick
        </button>
        <button className="danger" onClick={() => world.despawn(entity)}>
          despawn
        </button>
      </div>
    </section>
  );
}
