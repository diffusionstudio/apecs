import { describe, expect, test } from 'vitest'

import { Not, Optional, Trait, With, World, f32 } from '../src/index'
import * as apecs from '../src/internal'
import { defineEachCases } from './support/each-cases'

const Position = new Trait({ x: f32(0), y: f32(0) })
const Velocity = new Trait({ x: f32(0), y: f32(0) })
const IsActive = new Trait()

describe('each with generated cursors (§6.1, §6.5)', () => {
  test('this environment can compile accessors, so these cases run the codegen path', () => {
    expect(apecs.CAN_CODEGEN).toBe(true)
  })

  defineEachCases(async () => apecs)
})

describe('argument positions (§6.1)', () => {
  test('a term contributes at most one argument, whatever it wraps', () => {
    const world = new World()
    world.spawn(Position({ x: 1 }), IsActive)

    let arity = -1
    world.query(Position, With(IsActive), Not(Velocity), Optional(Velocity)).each((...args) => {
      arity = args.length
    })

    // Position, the Optional slot, then the entity.
    expect(arity).toBe(3)

    world.destroy()
  })

  test('each returns nothing and runs on a hoisted query every frame', () => {
    const world = new World()
    world.spawn(Position)
    const query = world.createQuery(Position)

    let calls = 0
    for (let frame = 0; frame < 3; frame++) expect(query.each(() => calls++)).toBeUndefined()

    expect(calls).toBe(3)

    world.destroy()
  })
})
