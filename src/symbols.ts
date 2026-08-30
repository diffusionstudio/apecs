/**
 * Every internal slot is symbol-keyed so a schema key can never shadow one
 * (SPEC §3.3).
 */

export const $id = Symbol('apecs.id')
export const $kind = Symbol('apecs.kind')
export const $fields = Symbol('apecs.fields')
export const $schema = Symbol('apecs.schema')
export const $options = Symbol('apecs.options')
export const $make = Symbol('apecs.make')

export const $trait = Symbol('apecs.trait')
export const $index = Symbol('apecs.index')
export const $value = Symbol('apecs.value')
export const $target = Symbol('apecs.target')

export const $term = Symbol('apecs.term')
export const $terms = Symbol('apecs.terms')

export const $mark = Symbol('apecs.mark')
export const $plan = Symbol('apecs.plan')

export const $entities = Symbol('apecs.entities')
export const $archetypes = Symbol('apecs.archetypes')
export const $traits = Symbol('apecs.traits')

export const $bind = Symbol('apecs.bind')
export const $row = Symbol('apecs.row')
export const $poison = Symbol('apecs.poison')
export const $queries = Symbol('apecs.queries')
