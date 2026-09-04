/**
 * The mappings that make the three access tiers typed (SPEC §11). A schema is
 * written once as plain values and marker calls; everything a user touches —
 * the value copy, the cursor, the store, the init object, the `each`
 * parameters — is derived from it here.
 */
import type { Entity } from './entity';
import type { Field, FieldKind } from './schema';
import { $mark, $schema, $term, $terms, $trait } from './symbols';

/** A schema slot written as `f32(0)`: its primitive, tagged with the column kind. */
export type Marked<T, K extends FieldKind> = T & { readonly [$mark]: K };

/** Object types written inline in a schema — a class instance has no index signature. */
type Plain = Record<string, unknown>;

/** `0 extends 1 & S` only when `S` is `any`, which the loose internal types use. */
type IsAny<S> = 0 extends 1 & S ? true : false;

type Fn = (...args: never[]) => unknown;

export type MarkValue<K extends FieldKind> = K extends 'bool'
  ? boolean
  : K extends 'str'
    ? string
    : K extends 'eid'
      ? Entity
      : number;

/** The page type a column of kind `K` hands out (SPEC §6.6). */
export type ArrayFor<K extends FieldKind> = K extends 'i8'
  ? Int8Array
  : K extends 'i16'
    ? Int16Array
    : K extends 'i32'
      ? Int32Array
      : K extends 'u8' | 'bool'
        ? Uint8Array
        : K extends 'u16'
          ? Uint16Array
          : K extends 'u32'
            ? Uint32Array
            : K extends 'f32'
              ? Float32Array
              : K extends 'f64' | 'eid'
                ? Float64Array
                : K extends 'str'
                  ? string[]
                  : unknown[];

/** The column kind a bare schema value infers to (SPEC §3.2). */
export type BareKind<T> = T extends boolean
  ? 'bool'
  : T extends number
    ? 'f64'
    : T extends string
      ? 'str'
      : 'boxed';

export type KindOf<T> = T extends Marked<unknown, infer K extends FieldKind> ? K : BareKind<T>;

/** A schema slot as the value it reads and writes as. */
export type Unmark<T> =
  T extends Marked<unknown, infer K extends FieldKind>
    ? MarkValue<K>
    : T extends number | string | boolean | bigint | null | undefined
      ? T
      : T extends Plain
        ? { -readonly [P in keyof T]: Unmark<T[P]> }
        : T;

/** What `world.get` copies out: the declared shape, markers resolved (SPEC §4.4). */
export type Value<S> =
  IsAny<S> extends true
    ? any
    : S extends Fn
      ? ReturnType<S>
      : S extends Plain
        ? { [K in keyof S]: Unmark<S[K]> }
        : Record<string, never>;

/** What `each` hands out: the same shape, writable — or the AoS reference (SPEC §6.5). */
export type Cursor<S> =
  IsAny<S> extends true
    ? any
    : S extends Fn
      ? ReturnType<S>
      : S extends Plain
        ? { -readonly [K in keyof S]: Unmark<S[K]> }
        : Record<string, never>;

/** What `chunk.get` hands out: the pages themselves (SPEC §6.6). */
export type Store<S> =
  IsAny<S> extends true
    ? any
    : S extends Fn
      ? ReturnType<S>[]
      : S extends Plain
        ? { readonly [K in keyof S]: StoreField<S[K]> }
        : Record<string, never>;

type StoreField<T> = T extends Plain
  ? { readonly [P in keyof T]: StoreField<T[P]> }
  : ArrayFor<KindOf<T>>;

/** What a trait instance takes: a partial of the value, or the AoS reference (SPEC §3.4). */
export type Init<S> =
  IsAny<S> extends true
    ? any
    : S extends Fn
      ? ReturnType<S>
      : S extends Plain
        ? DeepPartial<Value<S>>
        : never;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Plain ? DeepPartial<T[K]> : T[K] };

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

/**
 * The fields a trait exposes as properties, keyed by their flattened column
 * name — `Position.x`, `Body['pos.x']` (SPEC §3.3).
 */
export type TraitFields<S, P extends string = ''> =
  IsAny<S> extends true
    ? unknown
    : [S] extends [Plain]
      ? UnionToIntersection<
          {
            [K in keyof S & string]: S[K] extends Plain
              ? TraitFields<S[K], `${P}${K}.`>
              : { readonly [Q in `${P}${K}`]: Field<Unmark<S[K]>, KindOf<S[K]>> };
          }[keyof S & string]
        >
      : unknown;

// --------------------------------------------------------------- query terms

type SchemaOf<H> = H extends { readonly [$schema]: infer S }
  ? S
  : H extends { readonly [$trait]: { readonly [$schema]: infer S } }
    ? S
    : never;

type IsTag<S> = [S] extends [undefined] ? true : [S] extends [never] ? true : false;

/** A term's contribution to the `each` parameter list: one value, or none. */
type TermValue<H> = H extends {
  readonly [$term]: 'optional';
  readonly [$terms]: readonly [infer O];
}
  ? IsTag<SchemaOf<O>> extends true
    ? []
    : [Cursor<SchemaOf<O>> | null]
  : H extends { readonly [$term]: string }
    ? []
    : IsTag<SchemaOf<H>> extends true
      ? []
      : [Cursor<SchemaOf<H>>];

/**
 * The data terms of a query, in order. Tags, `Not`, `With` and the tick
 * filters contribute nothing; `Optional` follows its operand (SPEC §6.1).
 */
export type Values<T extends readonly unknown[]> = T extends readonly [
  infer H,
  ...infer R extends readonly unknown[],
]
  ? [...TermValue<H>, ...Values<R>]
  : [];

/** The `each` callback: the data terms positionally, then the entity (SPEC §6.5). */
export type EachFn<T extends readonly unknown[]> = (...args: [...Values<T>, Entity]) => void;
