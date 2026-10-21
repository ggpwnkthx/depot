/**
 * The collection manifests (spec §7).
 *
 * A manifest is a deployment artifact: it names the collections a
 * deployment serves, the fields they hold and the relations between them.
 * It is validated as a whole and it is rejected as a whole when anything
 * is wrong.
 *
 * The manifest never carries an executable script and never carries a
 * presentation instruction: the backend validates and authorizes, and
 * nothing else.
 */

import { createHash } from 'node:crypto'

/** The version of the format of a manifest. */
export const MANIFEST_VERSION = 1

/** The maximum size of a manifest file, in bytes. */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/** The types a field may have. */
export const FIELD_TYPES = [
  'string',
  'text',
  'boolean',
  'integer',
  'decimal',
  'uuid',
  'timestamp',
  'json',
  'enum',
] as const

/** The type of a field. */
export type FieldType = (typeof FIELD_TYPES)[number]

/** The definition of a field of a collection. */
export interface FieldDefinition {
  readonly type: FieldType
  /** True when a value must be present on a creation. */
  readonly required: boolean
  /** True when the explicit value `null` is accepted. */
  readonly nullable: boolean
  /** The maximum length of a string, in code points. */
  readonly maxLength?: number
  /** The minimum length of a string, in code points. */
  readonly minLength?: number
  /** The values of an enumeration. */
  readonly enum?: readonly string[]
  /** The default of the field, applied by the server. */
  readonly default?: unknown
  /** The smallest value of a number. */
  readonly minimum?: number
  /** The largest value of a number. */
  readonly maximum?: number
  /** The label of the field. */
  readonly label?: string
  /** The description of the field. */
  readonly description?: string
}

/** The kinds of a relation. */
export const RELATION_TYPES = ['many-to-one', 'one-to-many'] as const

/** The kind of a relation. */
export type RelationType = (typeof RELATION_TYPES)[number]

/** The definition of a relation of a collection. */
export interface RelationDefinition {
  /** The collection the relation points at. */
  readonly target: string
  /** The kind of the relation. */
  readonly type: RelationType
  /**
   * The field that carries the relation.
   *
   * For a `many-to-one` relation it is the field of this collection that
   * holds the identifier of the target. For a `one-to-many` relation it
   * is the field of the target collection that points back.
   */
  readonly field: string
  /** The label of the relation. */
  readonly label?: string
  /** The description of the relation. */
  readonly description?: string
}

/** The definition of a collection. */
export interface CollectionDefinition {
  /** The stable key of the collection. */
  readonly key: string
  /** The physical table of the collection. */
  readonly table: string
  /** The label of the collection. */
  readonly label: string
  /** The description of the collection. */
  readonly description?: string
  /** The fields of the collection, without the server maintained ones. */
  readonly fields: Readonly<Record<string, FieldDefinition>>
  /** The relations of the collection. */
  readonly relations: Readonly<Record<string, RelationDefinition>>
}

/** A whole manifest bundle. */
export interface ManifestBundle {
  /** The version of the format. */
  readonly version: number
  /** The version of the schema the bundle describes. */
  readonly schemaVersion: string
  /** The collections of the bundle. */
  readonly collections: readonly CollectionDefinition[]
  /** The content derived version of the bundle. */
  readonly bundleVersion: string
}

/** The fields every business record holds. */
export const SERVER_FIELDS = [
  'id',
  'tenant_id',
  'workspace_id',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'version',
] as const

/** The type of a server maintained field. */
export type ServerField = (typeof SERVER_FIELDS)[number]

/** The fields a client may never write. */
export const SERVER_FIELD_SET: ReadonlySet<string> = new Set(SERVER_FIELDS)

/** The problem of a manifest that cannot be used. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError'
}

/** The pattern of a collection key and of a physical table. */
export const COLLECTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** Reports whether a value is an object and not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Refuses a property that the format does not know. */
function assertKnownKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new ManifestError(`${where}: unknown properties: ${unknown.sort().join(', ')}`)
  }
}

/** Parses a field definition. */
function parseField(name: string, raw: unknown, where: string): FieldDefinition {
  if (!isObject(raw)) throw new ManifestError(`${where}: the field "${name}" is not an object`)
  assertKnownKeys(
    raw,
    [
      'type',
      'required',
      'nullable',
      'maxLength',
      'minLength',
      'enum',
      'default',
      'minimum',
      'maximum',
      'label',
      'description',
    ],
    `${where}: the field "${name}"`
  )
  const type = raw.type
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    throw new ManifestError(`${where}: the field "${name}" has an unknown type`)
  }
  const fieldType = type as FieldType
  const required = raw.required ?? false
  const nullable = raw.nullable ?? true
  if (typeof required !== 'boolean' || typeof nullable !== 'boolean') {
    throw new ManifestError(`${where}: the field "${name}" has a malformed flag`)
  }
  const definition: {
    -readonly [Key in keyof FieldDefinition]: FieldDefinition[Key]
  } = { type: fieldType, required, nullable }

  if (raw.maxLength !== undefined) {
    if (
      typeof raw.maxLength !== 'number' ||
      !Number.isInteger(raw.maxLength) ||
      raw.maxLength < 1
    ) {
      throw new ManifestError(`${where}: the field "${name}" has a malformed maxLength`)
    }
    definition.maxLength = raw.maxLength
  }
  if (raw.minLength !== undefined) {
    if (
      typeof raw.minLength !== 'number' ||
      !Number.isInteger(raw.minLength) ||
      raw.minLength < 0
    ) {
      throw new ManifestError(`${where}: the field "${name}" has a malformed minLength`)
    }
    definition.minLength = raw.minLength
  }
  if (raw.enum !== undefined) {
    if (
      !Array.isArray(raw.enum) ||
      raw.enum.length === 0 ||
      raw.enum.some((value) => typeof value !== 'string')
    ) {
      throw new ManifestError(`${where}: the field "${name}" has a malformed enum`)
    }
    definition.enum = raw.enum as string[]
  }
  if (raw.default !== undefined) definition.default = raw.default
  if (raw.minimum !== undefined) {
    if (typeof raw.minimum !== 'number' || !Number.isFinite(raw.minimum)) {
      throw new ManifestError(`${where}: the field "${name}" has a malformed minimum`)
    }
    definition.minimum = raw.minimum
  }
  if (raw.maximum !== undefined) {
    if (typeof raw.maximum !== 'number' || !Number.isFinite(raw.maximum)) {
      throw new ManifestError(`${where}: the field "${name}" has a malformed maximum`)
    }
    definition.maximum = raw.maximum
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string')
      throw new ManifestError(`${where}: the field "${name}" has a malformed label`)
    definition.label = raw.label
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new ManifestError(`${where}: the field "${name}" has a malformed description`)
    }
    definition.description = raw.description
  }
  if (fieldType === 'enum' && !definition.enum) {
    throw new ManifestError(`${where}: the field "${name}" is an enumeration without its values`)
  }
  if (fieldType !== 'enum' && definition.enum) {
    throw new ManifestError(`${where}: the field "${name}" is not an enumeration and holds values`)
  }
  if (
    definition.minimum !== undefined &&
    definition.maximum !== undefined &&
    definition.minimum > definition.maximum
  ) {
    throw new ManifestError(`${where}: the field "${name}" has a minimum above its maximum`)
  }
  return definition
}

/** Parses a relation definition. */
function parseRelation(
  name: string,
  raw: unknown,
  where: string,
  keys: ReadonlySet<string>
): RelationDefinition {
  if (!isObject(raw)) throw new ManifestError(`${where}: the relation "${name}" is not an object`)
  assertKnownKeys(
    raw,
    ['target', 'type', 'field', 'label', 'description'],
    `${where}: the relation "${name}"`
  )
  const target = raw.target
  const type = raw.type
  const field = raw.field
  if (typeof target !== 'string' || !COLLECTION_KEY_PATTERN.test(target)) {
    throw new ManifestError(`${where}: the relation "${name}" has an invalid target`)
  }
  if (!keys.has(target)) {
    throw new ManifestError(`${where}: the relation "${name}" points at an unknown collection`)
  }
  if (typeof type !== 'string' || !(RELATION_TYPES as readonly string[]).includes(type)) {
    throw new ManifestError(`${where}: the relation "${name}" has an unknown type`)
  }
  if (typeof field !== 'string' || !COLLECTION_KEY_PATTERN.test(field)) {
    throw new ManifestError(`${where}: the relation "${name}" has an invalid field`)
  }
  const relation: {
    -readonly [Key in keyof RelationDefinition]: RelationDefinition[Key]
  } = { target, type: type as RelationType, field }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') {
      throw new ManifestError(`${where}: the relation "${name}" has a malformed label`)
    }
    relation.label = raw.label
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new ManifestError(`${where}: the relation "${name}" has a malformed description`)
    }
    relation.description = raw.description
  }
  return relation
}

/**
 * Parses and validates a manifest bundle.
 *
 * The bundle is refused as a whole: a deployment that serves half of its
 * collections is a deployment nobody can reason about.
 */
export function parseManifestBundle(raw: string): ManifestBundle {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestError(`the manifest is larger than ${MAX_MANIFEST_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ManifestError('the manifest is not json')
  }
  if (!isObject(parsed)) throw new ManifestError('the manifest is not an object')
  assertKnownKeys(parsed, ['version', 'schemaVersion', 'collections'], 'the manifest')
  if (parsed.version !== MANIFEST_VERSION) {
    throw new ManifestError(`the manifest must have the version ${MANIFEST_VERSION}`)
  }
  if (typeof parsed.schemaVersion !== 'string' || parsed.schemaVersion.length === 0) {
    throw new ManifestError('the manifest must name its schema version')
  }
  if (!Array.isArray(parsed.collections) || parsed.collections.length === 0) {
    throw new ManifestError('the manifest must hold at least one collection')
  }

  const collections: CollectionDefinition[] = []
  const keys = new Set<string>()
  const rawRelations: {
    collection: string
    name: string
    definition: unknown
  }[] = []
  const relationMaps = new Map<string, Record<string, RelationDefinition>>()
  for (const entry of parsed.collections) {
    if (!isObject(entry)) throw new ManifestError('a collection of the manifest is not an object')
    assertKnownKeys(
      entry,
      ['key', 'table', 'label', 'description', 'fields', 'relations'],
      'a collection of the manifest'
    )
    const key = entry.key
    if (typeof key !== 'string' || !COLLECTION_KEY_PATTERN.test(key)) {
      throw new ManifestError('a collection of the manifest has an invalid key')
    }
    if (keys.has(key)) throw new ManifestError(`the collection "${key}" is declared twice`)
    keys.add(key)
    const table = entry.table
    if (typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$/.test(table)) {
      throw new ManifestError(`the collection "${key}" has an invalid table`)
    }
    if (typeof entry.label !== 'string' || entry.label.length === 0) {
      throw new ManifestError(`the collection "${key}" has no label`)
    }
    if (!isObject(entry.fields)) {
      throw new ManifestError(`the collection "${key}" has no fields`)
    }
    const fields: Record<string, FieldDefinition> = {}
    for (const [name, definition] of Object.entries(entry.fields)) {
      if (!COLLECTION_KEY_PATTERN.test(name)) {
        throw new ManifestError(`the collection "${key}" has an invalid field name`)
      }
      if (SERVER_FIELD_SET.has(name)) {
        throw new ManifestError(
          `the collection "${key}" declares "${name}", which is a server maintained field`
        )
      }
      fields[name] = parseField(name, definition, `the collection "${key}"`)
    }
    const relations: Record<string, RelationDefinition> = {}
    if (entry.relations !== undefined) {
      if (!isObject(entry.relations)) {
        throw new ManifestError(`the collection "${key}" has malformed relations`)
      }
      for (const [name, definition] of Object.entries(entry.relations)) {
        if (!COLLECTION_KEY_PATTERN.test(name)) {
          throw new ManifestError(`the collection "${key}" has an invalid relation name`)
        }
        rawRelations.push({ collection: key, name, definition })
      }
    }
    const collection: {
      -readonly [Key in keyof CollectionDefinition]: CollectionDefinition[Key]
    } = {
      key,
      table,
      label: entry.label,
      fields,
      relations: {},
    }
    if (entry.description !== undefined) {
      if (typeof entry.description !== 'string') {
        throw new ManifestError(`the collection "${key}" has a malformed description`)
      }
      collection.description = entry.description
    }
    collections.push(collection)
    relationMaps.set(key, relations)
  }

  // The relations are checked once every collection is known.
  for (const entry of rawRelations) {
    const relations = relationMaps.get(entry.collection)!
    relations[entry.name] = parseRelation(
      entry.name,
      entry.definition,
      `the collection "${entry.collection}"`,
      keys
    )
  }
  for (const collection of collections) {
    Object.assign(collection, { relations: relationMaps.get(collection.key) ?? {} })
  }
  for (const collection of collections) {
    for (const [name, relation] of Object.entries(collection.relations)) {
      const target = collections.find((entry) => entry.key === relation.target)
      if (!target) {
        throw new ManifestError(
          `the relation "${name}" of "${collection.key}" points at an unknown collection`
        )
      }
      const holder = relation.type === 'many-to-one' ? collection : target
      if (!holder.fields[relation.field]) {
        throw new ManifestError(
          `the relation "${name}" of "${collection.key}" names the unknown field "${relation.field}"`
        )
      }
      if (holder.fields[relation.field]?.type !== 'uuid') {
        throw new ManifestError(
          `the relation "${name}" of "${collection.key}" must point at a uuid field`
        )
      }
    }
  }

  return {
    version: MANIFEST_VERSION,
    schemaVersion: parsed.schemaVersion,
    collections,
    bundleVersion: contentVersion({ ...parsed, collections } as unknown),
  }
}

/**
 * The content derived version of a bundle.
 *
 * The version is a digest of the content: two bundles with the same
 * content have the same version, and a change of the content changes the
 * version.
 */
export function contentVersion(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/**
 * The canonical form of a value.
 *
 * The keys are sorted recursively and the arrays keep their order, so two
 * equal values always have the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${parts.join(',')}}`
}
