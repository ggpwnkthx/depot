/**
 * The policy bundles (spec §8).
 *
 * A policy is an allow rule: it names the permission it needs, the
 * collection it applies to, the action it allows, the rows it covers and
 * the fields it exposes. There is no wildcard and no administrator: a
 * request that no policy covers is refused.
 *
 * The bundle is a deployment artifact. Version 0.1 has no endpoint that
 * writes one.
 */

import { createHash } from 'node:crypto'
import { type FieldDefinition, type ManifestBundle, canonicalJson } from '../schema'
import { type FilterNode, FilterError, parseFilter } from './filter'

/** The version of the format of a policy bundle. */
export const POLICY_BUNDLE_VERSION = 1

/** The maximum number of policies of a bundle. */
export const MAX_POLICIES = 1000

/** The maximum size of a policy bundle, in bytes. */
export const MAX_POLICY_BUNDLE_BYTES = 1024 * 1024

/** The actions of version 0.1. */
export const ACTIONS = ['read', 'create', 'update', 'delete'] as const

/** The action of a policy. */
export type Action = (typeof ACTIONS)[number]

/** One policy of a bundle. */
export interface Policy {
  /** The stable identifier of the policy. */
  readonly id: string
  /** The permission the policy needs. */
  readonly permission: string
  /** The collection the policy applies to. */
  readonly collection: string
  /** The action the policy allows. */
  readonly action: Action
  /** The predicate of the rows the policy covers. */
  readonly where: FilterNode
  /** The predicate the resulting row has to satisfy. */
  readonly check: FilterNode
  /** The fields the policy exposes or allows to write. */
  readonly fields: readonly string[]
}

/** A whole policy bundle. */
export interface PolicyBundle {
  readonly version: number
  readonly policies: readonly Policy[]
  /** The content derived version of the bundle. */
  readonly bundleVersion: string
}

/** The problem of a bundle that cannot be used. */
export class PolicyError extends Error {
  override readonly name = 'PolicyError'
}

/** The pattern of a permission key. */
export const PERMISSION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Reports whether a value is an object and not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The fields a policy may use in a predicate, with the types of the collection. */
function catalogueOf(
  manifest: ManifestBundle,
  collection: string
): Record<string, FieldDefinition> {
  const definition = manifest.collections.find((entry) => entry.key === collection)
  if (!definition) throw new PolicyError(`the collection "${collection}" is not registered`)
  const catalogue: Record<string, FieldDefinition> = {}
  for (const [name, field] of Object.entries(definition.fields)) catalogue[name] = field
  for (const name of ['id', 'created_by', 'created_at', 'updated_by', 'updated_at', 'version']) {
    catalogue[name] = serverField(name)
  }
  return catalogue
}

/**
 * The names a policy may grant.
 *
 * A policy grants the fields of a collection and the relations it may
 * expand: a relation that no policy grants is never expanded.
 */
function grantableNames(manifest: ManifestBundle, collection: string): Set<string> {
  const definition = manifest.collections.find((entry) => entry.key === collection)
  if (!definition) throw new PolicyError(`the collection "${collection}" is not registered`)
  const names = new Set(Object.keys(catalogueOf(manifest, collection)))
  for (const name of Object.keys(definition.relations)) names.add(name)
  return names
}

/** The definition of a server maintained field. */
function serverField(name: string): FieldDefinition {
  switch (name) {
    case 'created_at':
    case 'updated_at':
      return { type: 'timestamp', required: true, nullable: false }
    case 'version':
      return { type: 'integer', required: true, nullable: false, minimum: 1 }
    default:
      return { type: 'uuid', required: true, nullable: false }
  }
}

/**
 * Parses and validates a policy bundle against a manifest.
 *
 * The bundle is refused as a whole: a policy that names an unknown field
 * or an unknown collection is a mistake of the deployment, and a
 * deployment that serves half of its policies is a deployment nobody can
 * reason about.
 */
export function parsePolicyBundle(raw: string, manifest: ManifestBundle): PolicyBundle {
  if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BUNDLE_BYTES) {
    throw new PolicyError(`the policy bundle is larger than ${MAX_POLICY_BUNDLE_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PolicyError('the policy bundle is not json')
  }
  if (!isObject(parsed)) throw new PolicyError('the policy bundle is not an object')
  const unknownKeys = Object.keys(parsed).filter((key) => key !== 'version' && key !== 'policies')
  if (unknownKeys.length > 0) {
    throw new PolicyError(
      `the policy bundle has unknown properties: ${unknownKeys.sort().join(', ')}`
    )
  }
  if (parsed.version !== POLICY_BUNDLE_VERSION) {
    throw new PolicyError(`the policy bundle must have the version ${POLICY_BUNDLE_VERSION}`)
  }
  if (!Array.isArray(parsed.policies)) {
    throw new PolicyError('the policy bundle must hold a list of policies')
  }
  if (parsed.policies.length > 0 && parsed.policies.length > MAX_POLICIES) {
    throw new PolicyError(`the policy bundle must hold at most ${MAX_POLICIES} policies`)
  }

  const identifiers = new Set<string>()
  const policies: Policy[] = []
  for (const entry of parsed.policies) {
    if (!isObject(entry)) throw new PolicyError('a policy of the bundle is not an object')
    const unknown = Object.keys(entry).filter(
      (key) =>
        !['id', 'permission', 'collection', 'action', 'where', 'check', 'fields'].includes(key)
    )
    if (unknown.length > 0) {
      throw new PolicyError(
        `a policy of the bundle has unknown properties: ${unknown.sort().join(', ')}`
      )
    }
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new PolicyError('a policy of the bundle has an invalid id')
    }
    if (identifiers.has(id)) throw new PolicyError(`the policy "${id}" is declared twice`)
    identifiers.add(id)
    const permission = entry.permission
    if (typeof permission !== 'string' || !PERMISSION_KEY_PATTERN.test(permission)) {
      throw new PolicyError(`the policy "${id}" has an invalid permission`)
    }
    const collection = entry.collection
    if (typeof collection !== 'string') {
      throw new PolicyError(`the policy "${id}" has an invalid collection`)
    }
    const catalogue = catalogueOf(manifest, collection)
    const grantable = grantableNames(manifest, collection)
    const action = entry.action
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      throw new PolicyError(`the policy "${id}" has an unknown action`)
    }
    const where = parsePredicate(entry.where, catalogue, id, 'where')
    const check = parsePredicate(entry.check, catalogue, id, 'check')
    if (!Array.isArray(entry.fields)) {
      throw new PolicyError(`the policy "${id}" must hold its fields`)
    }
    const fields: string[] = []
    for (const field of entry.fields) {
      if (typeof field !== 'string') {
        throw new PolicyError(`the policy "${id}" holds a field that is not a string`)
      }
      if (!grantable.has(field)) {
        throw new PolicyError(`the policy "${id}" names the unknown field "${field}"`)
      }
      fields.push(field)
    }
    if (fields.length !== new Set(fields).size) {
      throw new PolicyError(`the policy "${id}" names a field twice`)
    }
    policies.push({
      id,
      permission,
      collection,
      action: action as Action,
      where,
      check,
      fields,
    })
  }

  return {
    version: POLICY_BUNDLE_VERSION,
    policies,
    bundleVersion: bundleVersionOf(policies),
  }
}

/** Parses one predicate of a policy. */
function parsePredicate(
  value: unknown,
  catalogue: Record<string, FieldDefinition>,
  policyId: string,
  where: string
): FilterNode {
  if (value === undefined || value === null) {
    return { kind: 'all' }
  }
  try {
    return parseFilter(value, { fields: catalogue, substitutions: true })
  } catch (error) {
    if (error instanceof FilterError) {
      throw new PolicyError(`the policy "${policyId}" has an invalid ${where}: ${error.message}`)
    }
    throw error
  }
}

/**
 * The content derived version of a bundle.
 *
 * The version is the digest of the policies it holds: two bundles with
 * the same policies have the same version, and a change of a policy
 * changes the version. The version is what a cursor binds and what the
 * audit log records.
 */
export function bundleVersionOf(policies: readonly Policy[]): string {
  const canonical = canonicalJson(
    policies.map((policy) => ({
      id: policy.id,
      permission: policy.permission,
      collection: policy.collection,
      action: policy.action,
      where: policy.where,
      check: policy.check,
      fields: [...policy.fields].sort(),
    }))
  )
  return createHash('sha256').update(canonical).digest('hex')
}
