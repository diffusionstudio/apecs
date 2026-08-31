import { afterEach, describe, expect, test, vi } from 'vitest'

import { Trait, World } from '../src/index'
import { resetWarnOnce } from '../src/internal'

const Tracked = new Trait({ value: 0 }, { track: true })
const Plain = new Trait({ value: 0 })

afterEach(() => {
  vi.restoreAllMocks()
  resetWarnOnce()
})

describe('missing markChanged detection (§6.6)', () => {
  function sweep(world: World, mark: boolean): void {
    for (const chunk of world.query(Tracked).chunks()) {
      chunk.get(Tracked).value[0] += 1
      if (mark) chunk.markChanged(Tracked)
    }
  }

  test.runIf(__DEV__)('a tracked store with no markChanged warns when iteration ends', () => {
    const world = new World()
    world.spawn(Tracked)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (const chunk of world.query(Tracked).chunks()) {
      chunk.get(Tracked)
      // The loop body may still mark; only the iteration exit knows it never did.
      expect(warn).not.toHaveBeenCalled()
    }

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/apecs/)
    expect(warn.mock.calls[0][0]).toMatch(/markChanged/)

    world.destroy()
  })

  test.runIf(__DEV__)('the warning fires once per call site', () => {
    const world = new World()
    world.spawn(Tracked)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    sweep(world, false)
    sweep(world, false)

    expect(warn).toHaveBeenCalledTimes(1)

    world.destroy()
  })

  test.runIf(__DEV__)('a matching markChanged suppresses the warning', () => {
    const world = new World()
    world.spawn(Tracked)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    sweep(world, true)
    for (const chunk of world.query(Tracked).chunks()) {
      chunk.get(Tracked).value[0] += 1
      chunk.markChanged(Tracked, 0) // a single-row mark is a signal too
    }

    expect(warn).not.toHaveBeenCalled()

    world.destroy()
  })

  test.runIf(__DEV__)('an untracked store never warns', () => {
    const world = new World()
    world.spawn(Plain)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (const chunk of world.query(Plain).chunks()) chunk.get(Plain).value[0] += 1

    expect(warn).not.toHaveBeenCalled()

    world.destroy()
  })

  test.runIf(!__DEV__)('prod compiles the detection out', () => {
    const world = new World()
    world.spawn(Tracked)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    sweep(world, false)

    expect(warn).not.toHaveBeenCalled()

    world.destroy()
  })
})
