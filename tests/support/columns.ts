import type { Entity, Field, World } from '../../src/index';
import { $archetypes, $entities, entityId, type Archetype, type Column } from '../../src/internal';

/** The live table column backing `field` on the archetype `entity` occupies. */
export function columnOf(world: World, entity: Entity, field: Field): Column {
  const archetype = world[$archetypes].list[world[$entities].archetypes[entityId(entity)]];
  return archetype.column(field)!;
}

/** The archetype row `entity` currently occupies. */
export function rowOf(world: World, entity: Entity): number {
  return world[$entities].rows[entityId(entity)];
}

/** The archetype `entity` currently occupies. */
export function archetypeOf(world: World, entity: Entity): Archetype {
  return world[$archetypes].list[world[$entities].archetypes[entityId(entity)]];
}
