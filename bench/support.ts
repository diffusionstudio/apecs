/**
 * Shared fixtures for the SPEC §12.1 benchmark set. Every apecs figure has a
 * hand-written typed-array loop next to it — that is the baseline the budget
 * is stated against, and the only one that cannot be gamed.
 */
import { Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

export const Position = new Trait({ x: f32(0), y: f32(0) })
export const Velocity = new Trait({ x: f32(0), y: f32(0) })
export const Health = new Trait({ current: f32(100), max: f32(100) })
export const Damage = new Trait({ amount: f32(1) })
export const Sprite = new Trait({ frame: f32(0) })
export const SortKey = new Trait({ value: f32(0) })

/** The 26 fragmentation traits of `frag-iter`, plus `Data` on every entity. */
export const Data = new Trait({ value: f32(0) })
export const FRAGMENTS = Array.from({ length: 26 }, (_, i) => new Trait({ value: f32(i) }))

/** A hand-written SoA store: what apecs has to stay close to. */
export class Baseline {
  public readonly x: Float32Array
  public readonly y: Float32Array
  public readonly vx: Float32Array
  public readonly vy: Float32Array

  public constructor(n: number) {
    this.x = new Float32Array(n)
    this.y = new Float32Array(n)
    this.vx = new Float32Array(n)
    this.vy = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      this.x[i] = i
      this.y[i] = i
      this.vx[i] = 1
      this.vy[i] = 2
    }
  }

  public integrate(dt: number): void {
    const { x, y, vx, vy } = this
    for (let i = 0, n = x.length; i < n; i++) {
      x[i] += vx[i] * dt
      y[i] += vy[i] * dt
    }
  }
}

export function movers(n: number, pageSize?: number): World {
  const world = new World(pageSize === undefined ? undefined : { pageSize })
  for (let i = 0; i < n; i++) {
    world.spawn(Position({ x: i, y: i }), Velocity({ x: 1, y: 2 }))
  }
  return world
}

/** `packed-5`: one archetype, five traits, everything matches. */
export function packed(n: number): World {
  const world = new World()
  for (let i = 0; i < n; i++) {
    world.spawn(Position({ x: i }), Velocity({ x: 1 }), Health, Damage, Sprite({ frame: i }))
  }
  return world
}

/** `frag-iter`: `count` archetypes, one shared trait, entities spread evenly. */
export function fragmented(entities: number, count: number): World {
  const world = new World()
  const per = Math.ceil(entities / count)
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < per; i++) world.spawn(Data({ value: 1 }), FRAGMENTS[f])
  }
  return world
}

export function sortable(n: number): { world: World; entities: Entity[] } {
  const world = new World()
  const entities: Entity[] = new Array(n)
  for (let i = 0; i < n; i++) {
    entities[i] = world.spawn(Position({ x: i }), SortKey({ value: (i * 2654435761) % n }))
  }
  return { world, entities }
}

/** A deterministic shuffle, so every run walks the same "random" order. */
export function permutation(n: number): Uint32Array {
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  let state = 0x9e3779b9
  for (let i = n - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  return order
}
