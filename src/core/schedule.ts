/**
 * The scheduler (SPEC-SCHEDULE §S.1).
 *
 * What gives a frame one call site: a list of named systems, a deterministic
 * order, and the clock advance that otherwise sits at the top of the frame by
 * hand. Resolution happens on mutation, so a run is one loop over a flat array,
 * and a world that never constructs a `Schedule` pays nothing for it.
 */
import { CAN_CODEGEN } from './codegen';
import { assert } from './debug';
import type { World } from './world';

/** A system is a plain function of the world; per-frame values ride a trait (§S.3). */
export type System<W extends World = World> = (world: W) => void;

export interface ScheduleOptions {
  /** Advance the clock before running. Default true; exactly one schedule per frame may (§S.6). */
  step?: boolean;
}

export interface SystemOptions {
  /** Names this system must run before. */
  before?: string | readonly string[];
  /** Names this system must run after. */
  after?: string | readonly string[];
}

const NO_NAMES: readonly string[] = [];

/**
 * Past a few hundred systems the flattened call sequence stops paying — V8 gives
 * up on a function that size — and the parameter list starts approaching the
 * engine's limit. Measured: sub-nanosecond per system to 256, worse than four by
 * 1024. Beyond this the loop is the better shape.
 */
const MAX_FLAT_SYSTEMS = 512;

function noop(): void {}

interface Entry<W extends World> {
  readonly name: string;
  readonly system: System<W>;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

function nameList(spec: string | readonly string[] | undefined): readonly string[] {
  if (spec === undefined) {
    return NO_NAMES;
  }
  return typeof spec === 'string' ? [spec] : spec;
}

export class Schedule<W extends World = World> {
  readonly #step: boolean;
  /** Registration order — the tiebreak the sort falls back on (§S.5). */
  readonly #entries: Entry<W>[] = [];
  /** The resolved order, as names. Replaced wholesale, never mutated in place. */
  #order: readonly string[] = NO_NAMES;
  /** The resolved order, compiled into one call per system (§S.6). */
  #dispatch: (world: W) => void = noop;
  #dirty = false;
  #running = false;

  public constructor(options?: ScheduleOptions) {
    this.#step = options?.step ?? true;
  }

  public get size(): number {
    return this.#entries.length;
  }

  /** The run order, as names. Resolves first if the schedule has changed (§S.5). */
  public get order(): readonly string[] {
    if (this.#dirty) {
      this.#resolve();
    }
    return this.#order;
  }

  /** Registers `system` under `name`. Dev throws on a duplicate; prod keeps the first (§S.4). */
  public add(name: string, system: System<W>, options?: SystemOptions): this {
    if (this.#indexOf(name) >= 0) {
      if (__DEV__) {
        assert(false, `the schedule already has a system named '${name}'`);
      }
      return this;
    }
    this.#entries.push({
      name,
      system,
      before: nameList(options?.before),
      after: nameList(options?.after),
    });
    this.#dirty = true;
    return this;
  }

  public remove(name: string): boolean {
    const at = this.#indexOf(name);
    if (at < 0) {
      return false;
    }
    this.#entries.splice(at, 1);
    this.#dirty = true;
    return true;
  }

  public has(name: string): boolean {
    return this.#indexOf(name) >= 0;
  }

  public clear(): void {
    this.#entries.length = 0;
    this.#dirty = true;
  }

  /** Advances the clock, then runs every system in order (§S.6). */
  public run(world: W): void {
    if (__DEV__) {
      assert(!this.#running, 'schedule.run() is already running on this schedule');
      this.#running = true;
      try {
        this.#drive(world);
      } finally {
        this.#running = false;
      }
      return;
    }
    this.#drive(world);
  }

  #drive(world: W): void {
    if (this.#dirty) {
      this.#resolve();
    }
    if (this.#step) {
      world.step();
    }
    // The dispatcher is read before the first system runs, so `add` and `remove`
    // from inside one cannot disturb the run in progress (§S.6).
    this.#dispatch(world);
  }

  #indexOf(name: string): number {
    const entries = this.#entries;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].name === name) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Topological sort with minimal disturbance: the systems are walked in
   * registration order and each is emitted only after the ones it must follow,
   * so a constraint moves exactly the systems it names and leaves the rest
   * where they were registered (§S.5). Run once per mutation, never per frame.
   */
  #resolve(): void {
    const entries = this.#entries;
    const n = entries.length;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      index.set(entries[i].name, i);
    }

    // Predecessors: for each system, the ones that must run before it. Sorted,
    // so the order does not depend on whether a constraint was written as the
    // `before` on one system or the `after` on the other.
    const preds: number[][] = new Array(n);
    for (let i = 0; i < n; i++) {
      preds[i] = [];
    }
    for (let i = 0; i < n; i++) {
      const entry = entries[i];
      const before = entry.before;
      for (let b = 0; b < before.length; b++) {
        const to = target(index, before[b], entry.name);
        if (to >= 0) {
          preds[to].push(i);
        }
      }
      const after = entry.after;
      for (let a = 0; a < after.length; a++) {
        const from = target(index, after[a], entry.name);
        if (from >= 0) {
          preds[i].push(from);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (preds[i].length > 1) {
        preds[i].sort(ascending);
      }
    }

    const order: string[] = [];
    const systems: System<W>[] = [];
    // 0 unvisited, 1 open (on the walk), 2 emitted.
    const state = new Uint8Array(n);
    const open: number[] = [];

    const visit = (i: number): void => {
      if (state[i] === 2) {
        return;
      }
      if (state[i] === 1) {
        // The edge closes a cycle: dev throws with the chain, prod drops the
        // edge, so every system is still emitted exactly once (§S.5).
        if (__DEV__) {
          const from = open.indexOf(i);
          const chain = open.slice(from).map((at) => `'${entries[at].name}'`);
          chain.push(`'${entries[i].name}'`);
          assert(false, `cycle in schedule constraints: ${chain.join(' -> ')}`);
        }
        return;
      }
      state[i] = 1;
      if (__DEV__) {
        open.push(i);
      }
      const list = preds[i];
      for (let p = 0; p < list.length; p++) {
        visit(list[p]);
      }
      if (__DEV__) {
        open.pop();
      }
      state[i] = 2;
      order.push(entries[i].name);
      systems.push(entries[i].system);
    };

    for (let i = 0; i < n; i++) {
      visit(i);
    }

    // Last: a dev throw above leaves the schedule dirty and the previous order
    // intact, so the next access resolves again and reports the same fault.
    this.#order = order;
    this.#dispatch = compile(systems);
    this.#dirty = false;
  }
}

/**
 * The run order as a single function with one call site per system, so each is
 * a direct monomorphic call V8 can inline rather than a load-and-call through
 * an array — the shape a hand-written frame has (§S.6). Systems are passed
 * positionally: a name never reaches the generated source. Falls back to the
 * loop where `new Function` is unavailable or the schedule is huge.
 */
function compile<W extends World>(systems: readonly System<W>[]): (world: W) => void {
  const n = systems.length;
  if (n === 0) {
    return noop;
  }
  if (!CAN_CODEGEN || n > MAX_FLAT_SYSTEMS) {
    const ordered = systems.slice();
    return (world: W): void => {
      for (let i = 0; i < ordered.length; i++) {
        ordered[i](world);
      }
    };
  }
  let params = 'f0';
  let body = 'f0(w);';
  for (let i = 1; i < n; i++) {
    params += `,f${i}`;
    body += `f${i}(w);`;
  }
  return new Function(params, `return function(w){${body}}`)(...systems) as (world: W) => void;
}

function ascending(a: number, b: number): number {
  return a - b;
}

/** The index a constraint names, or -1 when prod must drop the edge (§S.5). */
function target(index: Map<string, number>, name: string, self: string): number {
  if (name === self) {
    if (__DEV__) {
      assert(false, `system '${self}' cannot be ordered against itself`);
    }
    return -1;
  }
  const at = index.get(name);
  if (at === undefined) {
    if (__DEV__) {
      assert(false, `system '${self}' is ordered against '${name}', which is not in the schedule`);
    }
    return -1;
  }
  return at;
}
