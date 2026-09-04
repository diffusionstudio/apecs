/**
 * becsy applies structural changes at frame boundaries, so an in-frame witness
 * sees nothing. Observe across frames instead: add on frame 0, look on frame 1,
 * remove on frame 2, look on frame 3.
 *
 * This is what decides whether becsy's add_remove figure is real work or a
 * silent no-op — the perf build has no assertions to tell us.
 */
const N = 10_000
const { System, Type, World } = await import('@lastolivegames/becsy/perf.js')
const mk = (s) => {
  const C = class {}
  C.schema = s
  return C
}
const Position = mk({ x: Type.float32 })
const Velocity = mk({ x: Type.float32 })

let frame = 0
const seen = []

class Toggle extends System {
  q = this.query((x) => x.current.with(Position).and.using(Velocity).write)
  withV = this.query((x) => x.current.with(Position).and.with(Velocity).read)
  execute() {
    seen.push({ frame, holdingVelocity: this.withV.current.length })
    if (frame === 0) for (const e of this.q.current) e.add(Velocity)
    if (frame === 2) for (const e of this.q.current) e.remove(Velocity)
    frame++
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
for (let i = 0; i < 4; i++) await world.execute()

console.log(JSON.stringify(seen))
console.log(
  `expected: frame0=0 (before add), frame1=${N} (add applied), frame2=${N}, frame3=0 (remove applied)`,
)
