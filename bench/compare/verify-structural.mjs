/**
 * The census proves the query benchmarks match the same entities. This proves
 * the STRUCTURAL benchmarks actually change state — a library that silently
 * no-ops an add or a remove would post a spectacular add_remove time.
 *
 * Counts, per frame/pass: entities holding Velocity after the add half, and
 * after the remove half. Must be N then 0 for every library.
 */
const N = 10_000

async function apecs() {
  const { Trait, World, f32 } = await import('../../dist/index.js')
  const Position = new Trait({ x: f32(0) })
  const Velocity = new Trait({ x: f32(0) })
  const w = new World({ maxEntities: N + 16 })
  const live = []
  for (let i = 0; i < N; i++) live.push(w.spawn(Position))
  const q = w.query(Position, Velocity)
  for (const e of live) w.add(e, Velocity)
  const after = q.entities().length
  for (const e of live) w.remove(e, Velocity)
  return { afterAdd: after, afterRemove: q.entities().length }
}

async function bitecs() {
  const b = await import('bitecs')
  const w = b.createWorld()
  const P = { x: new Float32Array(N + 1024) }
  const V = { x: new Float32Array(N + 1024) }
  const live = []
  for (let i = 0; i < N; i++) {
    const e = b.addEntity(w)
    b.addComponent(w, e, P)
    live.push(e)
  }
  for (const e of live) b.addComponent(w, e, V)
  const after = b.query(w, [P, V]).length
  for (const e of live) b.removeComponent(w, e, V)
  return { afterAdd: after, afterRemove: b.query(w, [P, V]).length }
}

async function koota() {
  const k = await import('koota')
  const P = k.trait({ x: 0 })
  const V = k.trait({ x: 0 })
  const w = k.createWorld()
  const live = []
  for (let i = 0; i < N; i++) live.push(w.spawn(P))
  for (const e of live) e.add(V)
  const after = w.query(P, V).length
  for (const e of live) e.remove(V)
  return { afterAdd: after, afterRemove: w.query(P, V).length }
}

async function becsy() {
  const { System, Type, World } = await import('@lastolivegames/becsy/perf.js')
  const mk = (s) => {
    const C = class {}
    C.schema = s
    return C
  }
  const Position = mk({ x: Type.float32 })
  const Velocity = mk({ x: Type.float32 })
  let afterAdd = -1
  let afterRemove = -1
  // Exactly the adapter's shape, with a witness query watching Velocity.
  class Toggle extends System {
    q = this.query((x) => x.current.with(Position).and.using(Velocity).write)
    withV = this.query((x) => x.current.with(Position).and.with(Velocity).read)
    execute() {
      for (const e of this.q.current) e.add(Velocity)
      afterAdd = this.withV.current.length
      for (const e of this.q.current) e.remove(Velocity)
      afterRemove = this.withV.current.length
    }
  }
  const world = await World.create({
    defs: [Position, Velocity, Toggle],
    maxEntities: N + 16,
    maxShapeChangesPerFrame: N * 8 + 1024,
    maxWritesPerFrame: N * 8 + 1024,
    maxLimboComponents: N * 8 + 1024,
  })
  await world.build((sys) => {
    for (let i = 0; i < N; i++) sys.createEntity(Position)
  })
  await world.execute()
  await world.execute()
  return { afterAdd, afterRemove }
}

const which = process.argv[2]
const fns = { apecs, bitecs, koota, becsy }
console.log(which, JSON.stringify(await fns[which]()), `(expected afterAdd=${N}, afterRemove=0)`)
