import type { Column, ColumnPage } from './column'
import { CAN_CODEGEN } from './codegen'
import { ApecsError } from './debug'
import type { Field, Plan } from './schema'
import { $bind, $fields, $index, $kind, $plan, $poison, $row } from './symbols'
import type { Trait } from './trait'

/**
 * A borrowed view of one row. Bound to a page once, then walked by writing
 * `[$row]`; the accessors compile down to a direct typed-array index (SPEC §6.5).
 */
export interface Cursor {
  [$row]: number
  /** Points the cursor at a page, and un-poisons it for the walk about to start. */
  [$bind](columns: Column[], page: number): void
  [$poison](): void
}

export type CursorClass = new () => Cursor

/** One member of a cursor's shape: a leaf field, or a nested sub-cursor. */
interface Member {
  readonly key: string
  /** Column index for a leaf, -1 for a nested node. */
  readonly slot: number
  readonly bool: boolean
  /** Shape index of the nested node, -1 for a leaf. */
  readonly sub: number
}

/** Shape 0 is the cursor itself; the rest are the nested objects it owns. */
type Shapes = Member[][]

const untracked = new WeakMap<Trait, CursorClass | null>()
const tracked = new WeakMap<Trait, CursorClass | null>()

/**
 * The accessor class for a trait, or `null` when there is nothing to read
 * through one — a tag has no columns, and an AoS trait yields its reference.
 *
 * Tracked and untracked are separate classes so an untracked write is a bare
 * store with no tick bookkeeping in it at all (SPEC §6.5, §8.3).
 */
export function cursorClassFor(trait: Trait, track: boolean): CursorClass | null {
  const cache = track ? tracked : untracked
  let cls = cache.get(trait)
  if (cls === undefined) {
    cls = build(trait, track)
    cache.set(trait, cls)
  }
  return cls
}

function build(trait: Trait, track: boolean): CursorClass | null {
  if (trait[$kind] !== 'struct') return null
  const shapes: Shapes = []
  collect(trait[$plan], shapes)
  const width = trait[$fields].length
  return CAN_CODEGEN ? generate(shapes, width, track) : reflect(shapes, width, track)
}

/** Flattens the plan into pre-order shapes; member order is declaration order. */
function collect(plan: Plan, shapes: Shapes): number {
  const members: Member[] = []
  const self = shapes.length
  shapes.push(members)
  for (const key in plan) {
    const node = plan[key]
    if ($index in node) {
      const field = node as Field
      members.push({ key, slot: field[$index], bool: field.kind === 'bool', sub: -1 })
    } else {
      members.push({ key, slot: -1, bool: false, sub: collect(node as Plan, shapes) })
    }
  }
  return self
}

function poisoned(): never {
  throw new ApecsError('this cursor was borrowed from each() and is no longer valid')
}

// ------------------------------------------------------------------- codegen

/**
 * A prefix for the internal slots that no schema key can shadow. Slots are own
 * properties and accessors live on the prototype, so a collision would silently
 * hide a field.
 */
function slotPrefix(shapes: Shapes): string {
  let prefix = '$'
  while (shapes.some((members) => members.some((member) => member.key.startsWith(prefix)))) {
    prefix += '$'
  }
  return prefix
}

function accessors(members: readonly Member[], owner: string, p: string): string {
  let source = ''
  for (const member of members) {
    const name = JSON.stringify(member.key)
    if (member.sub >= 0) {
      source += `get ${name}(){return ${owner}.${p}s${member.sub}}\n`
      continue
    }
    const guard = __DEV__ ? `if(${owner}.${p}d)T();` : ''
    const cell = `${owner}.${p}${member.slot}[${owner}[R]]`
    source += `get ${name}(){${guard}return ${cell}${member.bool ? '!==0' : ''}}\n`
    source += `set ${name}(v){${guard}${cell}=${member.bool ? 'v?1:0' : 'v'}}\n`
  }
  return source
}

function generate(shapes: Shapes, width: number, _track: boolean): CursorClass {
  const p = slotPrefix(shapes)
  let source = ''

  for (let s = 1; s < shapes.length; s++) {
    source += `class S${s}{constructor(o){this.${p}o=o}\n`
    source += accessors(shapes[s], `this.${p}o`, p)
    source += '}\n'
  }

  source += 'return class Cursor{constructor(){this[R]=0;'
  if (__DEV__) source += `this.${p}d=false;`
  for (let i = 0; i < width; i++) source += `this.${p}${i}=null;`
  for (let s = 1; s < shapes.length; s++) source += `this.${p}s${s}=new S${s}(this);`
  source += '}\n'

  source += `[B](c,g){`
  if (__DEV__) source += `this.${p}d=false;`
  for (let i = 0; i < width; i++) source += `this.${p}${i}=c[${i}].pages[g];`
  source += '}\n'
  source += `[P](){${__DEV__ ? `this.${p}d=true` : ''}}\n`
  source += accessors(shapes[0], 'this', p)
  source += '}'

  return new Function('B', 'R', 'P', 'T', source)($bind, $row, $poison, poisoned)
}

// ------------------------------------------------------------------ fallback

const $pages = Symbol('apecs.cursor.pages')
const $subs = Symbol('apecs.cursor.subs')
const $dead = Symbol('apecs.cursor.dead')
const $owner = Symbol('apecs.cursor.owner')

interface Slots {
  [$row]: number
  [$pages]: ColumnPage[]
  [$subs]: readonly object[]
  [$dead]: boolean
}

interface Sub {
  [$owner]: Slots
}

/**
 * The CSP path: same semantics through a field-index dispatch instead of a
 * generated one, at the cost of an extra load per access (SPEC §6.5).
 */
function define(prototype: object, members: readonly Member[], root: (self: any) => Slots): void {
  for (const member of members) {
    if (member.sub >= 0) {
      const index = member.sub - 1
      Object.defineProperty(prototype, member.key, {
        get(this: object) {
          return root(this)[$subs][index]
        },
        configurable: true,
      })
      continue
    }
    const { slot, bool } = member
    Object.defineProperty(prototype, member.key, {
      get(this: object) {
        const self = root(this)
        if (__DEV__ && self[$dead]) poisoned()
        const value = (self[$pages][slot] as unknown[])[self[$row]]
        return bool ? value !== 0 : value
      },
      set(this: object, value: unknown) {
        const self = root(this)
        if (__DEV__ && self[$dead]) poisoned()
        ;(self[$pages][slot] as unknown[])[self[$row]] = bool ? (value ? 1 : 0) : value
      },
      configurable: true,
    })
  }
}

const ownerOf = (self: Sub): Slots => self[$owner]
const identity = (self: Slots): Slots => self

function reflect(shapes: Shapes, width: number, _track: boolean): CursorClass {
  const subClasses: Array<new (owner: Slots) => Sub> = []
  for (let s = 1; s < shapes.length; s++) {
    const cls = class {
      declare [$owner]: Slots
      public constructor(owner: Slots) {
        this[$owner] = owner
      }
    }
    define(cls.prototype, shapes[s], ownerOf as (self: any) => Slots)
    subClasses.push(cls)
  }

  const Cursor = class {
    [$row] = 0;
    [$dead] = false;
    [$pages]: ColumnPage[] = new Array(width).fill(null);
    [$subs] = subClasses.map((Sub) => new Sub(this as unknown as Slots))

    public [$bind](columns: Column[], page: number): void {
      if (__DEV__) this[$dead] = false
      const pages = this[$pages]
      for (let i = 0; i < width; i++) pages[i] = columns[i].pages[page]
    }

    public [$poison](): void {
      if (__DEV__) this[$dead] = true
    }
  }
  define(Cursor.prototype, shapes[0], identity as (self: any) => Slots)
  return Cursor as unknown as CursorClass
}
