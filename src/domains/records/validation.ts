/**
 * The validation of the bodies of the records (spec §7.4).
 *
 * The validation is the rule of the server: the client may check what it
 * sends, but the value that is stored is the value the server accepted.
 *
 * The module knows nothing about the storage: it reads a manifest and a
 * body and it answers with the values that may be written and the names
 * of the fields that were written.
 */

import type { ErrorDetail } from '../../protocol/errors'
import type { CollectionDefinition, FieldDefinition } from '../schema'

/** The problem of a body that cannot be used. */
export class BodyError extends Error {
  override readonly name = 'BodyError'
  readonly details: readonly ErrorDetail[]

  constructor(message: string, details: readonly ErrorDetail[] = []) {
    super(message)
    this.details = details
  }
}

/** The server maintained fields a client may never write. */
const SERVER_FIELDS = new Set([
  'id',
  'tenant_id',
  'workspace_id',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'version',
])

/** The maximum depth of a json value. */
export const MAX_JSON_DEPTH = 10

/** The maximum size of a body of a record, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024

/** Reports whether a value is an object and not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The depth of a json value. */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    if (value.length === 0) return 1
    return 1 + Math.max(...value.map((entry) => jsonDepth(entry)))
  }
  if (isObject(value)) {
    const values = Object.values(value)
    if (values.length === 0) return 1
    return 1 + Math.max(...values.map((entry) => jsonDepth(entry)))
  }
  return 0
}

/** Reports whether a value is a timestamp with an explicit offset. */
export function isTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

/** The result of the validation of a body. */
export interface ValidatedBody {
  /** The values that may be written, by field name. */
  readonly values: Record<string, unknown>
  /** The names of the fields that were written. */
  readonly fields: readonly string[]
}

/**
 * Validates the body of a creation or of an update.
 *
 * `mode` decides whether a field that is missing is an error: a creation
 * has to hold every required field, an update leaves the fields it does
 * not name unchanged.
 */
export function validateBody(
  body: unknown,
  collection: CollectionDefinition,
  mode: 'create' | 'update'
): ValidatedBody {
  if (!isObject(body)) {
    throw new BodyError('the body is not an object', [{ field: '', code: 'INVALID_BODY' }])
  }
  const encoded = Buffer.byteLength(JSON.stringify(body), 'utf8')
  if (encoded > MAX_BODY_BYTES) {
    throw new BodyError('the body is too large', [{ field: '', code: 'BODY_TOO_LARGE' }])
  }

  const details: ErrorDetail[] = []
  const values: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(body)) {
    if (SERVER_FIELDS.has(name)) {
      details.push({ field: name, code: 'SERVER_FIELD' })
      continue
    }
    const definition = collection.fields[name]
    if (!definition) {
      details.push({ field: name, code: 'UNKNOWN_FIELD' })
      continue
    }
    if (value === null) {
      if (!definition.nullable) {
        details.push({ field: name, code: 'NOT_NULLABLE' })
        continue
      }
      values[name] = null
      continue
    }
    const normalized = normalizeValue(name, definition, value)
    if (normalized.ok) {
      values[name] = normalized.value
      continue
    }
    details.push({ field: name, code: normalized.code })
  }

  if (mode === 'create') {
    for (const [name, definition] of Object.entries(collection.fields)) {
      if (!definition.required) continue
      if (name in values) continue
      if (definition.default !== undefined) continue
      details.push({ field: name, code: 'MISSING_FIELD' })
    }
  }

  if (details.length > 0) {
    throw new BodyError('the body holds invalid values', details)
  }
  return { values, fields: Object.keys(values) }
}

/**
 * Validates one value against the definition of its field.
 *
 * The value is normalized: a timestamp becomes an UTC timestamp and a
 * decimal stays a string, so the value that is stored and the value that
 * is read are the same.
 */
function normalizeValue(
  _name: string,
  definition: FieldDefinition,
  value: unknown
): { ok: true; value: unknown } | { ok: false; code: string } {
  switch (definition.type) {
    case 'string':
    case 'text': {
      if (typeof value !== 'string') return { ok: false, code: 'TYPE_MISMATCH' }
      const length = [...value].length
      if (definition.maxLength !== undefined && length > definition.maxLength) {
        return { ok: false, code: 'MAX_LENGTH' }
      }
      if (definition.minLength !== undefined && length < definition.minLength) {
        return { ok: false, code: 'MIN_LENGTH' }
      }
      return { ok: true, value }
    }
    case 'enum': {
      if (typeof value !== 'string') return { ok: false, code: 'TYPE_MISMATCH' }
      if (definition.enum && !definition.enum.includes(value)) {
        return { ok: false, code: 'INVALID_ENUM' }
      }
      return { ok: true, value }
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, code: 'TYPE_MISMATCH' }
      return { ok: true, value }
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return { ok: false, code: 'TYPE_MISMATCH' }
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        return { ok: false, code: 'MIN_VALUE' }
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return { ok: false, code: 'MAX_VALUE' }
      }
      return { ok: true, value }
    }
    case 'decimal': {
      if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
        return { ok: false, code: 'TYPE_MISMATCH' }
      }
      return { ok: true, value }
    }
    case 'uuid': {
      if (
        typeof value !== 'string' ||
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
      ) {
        return { ok: false, code: 'TYPE_MISMATCH' }
      }
      return { ok: true, value: value.toLowerCase() }
    }
    case 'timestamp': {
      if (typeof value !== 'string' || !isTimestamp(value)) {
        return { ok: false, code: 'TYPE_MISMATCH' }
      }
      return { ok: true, value: new Date(value).toISOString() }
    }
    case 'json': {
      if (typeof value !== 'object') return { ok: false, code: 'TYPE_MISMATCH' }
      if (jsonDepth(value) > MAX_JSON_DEPTH) return { ok: false, code: 'TOO_DEEP' }
      return { ok: true, value }
    }
    default:
      return { ok: false, code: 'TYPE_MISMATCH' }
  }
}

/** The default of a field, when the field has one. */
export function defaultOf(definition: FieldDefinition): unknown {
  return definition.default
}
