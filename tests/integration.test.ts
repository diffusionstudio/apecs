/**
 * T7.7 — the SPEC §13 worked example, run as written: a world subclass, the
 * three access tiers, a relation, deferred despawns and `Changed` sync.
 */
import { describe, expect, test } from 'vitest'

import { Changed, Relation, Trait, World, f32 } from '../src/index'
import type { Entity } from '../src/index'

/** Stands in for `THREE.Mesh` — a reference payload with a disposable resource. */
class Mesh {
  public readonly position = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      this.x = x
      this.y = y
      this.z = z
    },
  }
  public readonly geometry = {
    disposed: false,
    dispose(): void {
      this.disposed = true
    },
  }
}

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const Health = new Trait({ current: 100, max: 100 })
const MeshOf = new Trait(() => new Mesh())
const IsEnemy = new Trait()
const Time = new Trait({ delta: 0, current: 0 })
const ChildOf = new Relation(undefined, { exclusive: true, onTargetDespawn: 'despawn' })

class Game extends World {
  public readonly disposed: Mesh[] = []

  public constructor() {
    super()
    this.add(Time)
    this.onRemove(MeshOf, (e) => {
      const mesh = this.get(e, MeshOf)
      mesh.geometry.dispose()
      this.disposed.push(mesh)
    })
  }
}

function movement(world: Game): void {
  const dt = world.get(Time.delta)
  for (const chunk of world.query(Position, Velocity).chunks()) {
    const { x, y } = chunk.get(Position)
    const { x: vx, y: vy } = chunk.get(Velocity)
    for (let i = 0, n = chunk.length; i < n; i++) {
      x[i] += vx[i] * dt
      y[i] += vy[i] * dt
    }
    chunk.markChanged(Position)
  }
}

function reap(world: Game): void {
  world.query(Health, IsEnemy).each((hp, e) => {
    if (hp.current <= 0) world.defer(() => world.despawn(e))
  })
}

function sync(world: Game): number {
  let synced = 0
  world.query(Position, MeshOf, Changed(Position)).each((p, mesh) => {
    mesh.position.set(p.x, p.y, 0)
    synced++
  })
  return synced
}

describe('worked example (§13)', () => {
  test('the frame loop moves, reaps and syncs', () => {
    const world = new Game()
    const player = world.spawn(Position({ x: 20, y: 10 }), Velocity({ x: 1, y: 2 }), MeshOf)
    const weapon = world.spawn(Position, MeshOf, ChildOf(player))
    const enemies = world.spawnMany(5_000, Position, Velocity, Health, IsEnemy)

    const frame = (dt: number): number => {
      world.step()
      world.set(Time, { delta: dt, current: world.get(Time.current) + dt })
      movement(world)
      reap(world)
      return sync(world)
    }

    // Spawning writes Position, so the first frame syncs both meshes.
    expect(frame(0.5)).toBe(2)
    // The weapon has no Velocity: movement never touches it, so the next frame skips it.
    expect(frame(0.5)).toBe(1)

    expect(world.get(player, Position)).toEqual({ x: 21, y: 12 })
    expect(world.get(Time.current)).toBe(1)
    expect(world.target(weapon, ChildOf)).toBe(player)
    expect(world.get(weapon, Position)).toEqual({ x: 0, y: 0 })
    expect(world.get(player, MeshOf).position).toMatchObject({ x: 21, y: 12, z: 0 })

    // Killing half the enemies reaps them at the end of the each() that found them.
    for (let i = 0; i < enemies.length; i += 2) {
      world.set(enemies[i] as Entity, Health.current, 0)
    }
    frame(0.5)

    expect(world.query(IsEnemy).count).toBe(2_500)
    expect(enemies.every((e, i) => world.isAlive(e as Entity) === (i % 2 === 1))).toBe(true)

    world.destroy()
  })

  test('despawning the parent cascades to the child and disposes both meshes', () => {
    const world = new Game()
    const player = world.spawn(Position, MeshOf)
    const weapon = world.spawn(Position, MeshOf, ChildOf(player))

    world.despawn(player)

    expect(world.isAlive(player)).toBe(false)
    expect(world.isAlive(weapon)).toBe(false)
    expect(world.disposed).toHaveLength(2)
    expect(world.disposed.every((mesh) => mesh.geometry.disposed)).toBe(true)

    world.destroy()
  })

  test('the world trait carries frame state on the world entity', () => {
    const world = new Game()

    expect(world.has(Time)).toBe(true)
    expect(world.get(Time)).toEqual({ delta: 0, current: 0 })

    world.set(Time, { delta: 1 / 60 })

    expect(world.get(Time.delta)).toBeCloseTo(1 / 60)
    expect(world.get(world.entity, Time)).toEqual(world.get(Time))

    world.destroy()
  })
})
