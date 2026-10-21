/**
 * The metadata of the collections (spec §9.2).
 *
 * The metadata is the contract of an independent client: it names the
 * collections the caller may use, the actions it may perform, the fields
 * it may read and write and the relations it may expand.
 *
 * The metadata never carries a SQL identifier, a predicate of a policy,
 * a secret, the configuration of a subscriber or an instruction of a
 * presentation.
 */

import {
  type AuthorizationInput,
  type RequestContext,
  applicablePolicies,
  filterSortIntersection,
  readableUnion,
} from '../domains/authorization'
import type { PolicyBundle } from '../domains/authorization'
import type { CollectionDefinition, ManifestBundle } from '../domains/schema/manifest'

/** The limits the metadata announces. */
export const API_LIMITS = {
  maxLimit: 200,
  defaultLimit: 50,
  maxSelectedFields: 50,
  maxSortFields: 3,
  maxIncludes: 5,
  maxRelatedRowsPerRoot: 100,
  maxRelatedRowsPerResponse: 1000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxRecordBodyBytes: 256 * 1024,
  maxFilterDepth: 5,
  maxFilterLeaves: 50,
  maxFilterValues: 100,
} as const

/** The metadata of one collection. */
export interface CollectionMetadata {
  key: string
  label: string
  description?: string
  schemaVersion: string
  actions: readonly string[]
  readableFields: readonly string[]
  writableFields: readonly string[]
  filterableFields: readonly string[]
  fields: readonly FieldMetadata[]
  relations: readonly RelationMetadata[]
}

/** The metadata of one field. */
export interface FieldMetadata {
  name: string
  type: string
  required: boolean
  nullable: boolean
  maxLength?: number
  minLength?: number
  enum?: readonly string[]
  minimum?: number
  maximum?: number
  label?: string
  description?: string
}

/** The metadata of one relation. */
export interface RelationMetadata {
  name: string
  target: string
  type: string
  label?: string
  description?: string
}

/** The metadata of the deployment, for one caller. */
export interface SchemaMetadata {
  apiVersion: string
  schemaVersion: string
  policyBundleVersion: string
  limits: typeof API_LIMITS
  collections: readonly CollectionMetadata[]
}

/** The options of the metadata. */
export interface SchemaMetadataOptions {
  context: RequestContext
  manifest: ManifestBundle
  bundle: PolicyBundle
  schemaVersion: string
}

/** Builds the metadata of the deployment for a caller. */
export function buildSchemaMetadata(options: SchemaMetadataOptions): SchemaMetadata {
  const authorization: AuthorizationInput = {
    permissionKeys: options.context.permissionKeys,
    bundle: options.bundle,
    manifest: options.manifest,
  }
  const collections: CollectionMetadata[] = []
  for (const collection of options.manifest.collections) {
    const metadata = metadataOf(collection, authorization)
    if (!metadata) continue
    collections.push(metadata)
  }
  return {
    apiVersion: 'v1',
    schemaVersion: options.manifest.schemaVersion,
    policyBundleVersion: options.bundle.bundleVersion,
    limits: API_LIMITS,
    collections,
  }
}

/** The metadata of one collection, when the caller may use it. */
function metadataOf(
  collection: CollectionDefinition,
  authorization: AuthorizationInput
): CollectionMetadata | null {
  const actions = (['read', 'create', 'update', 'delete'] as const).filter(
    (action) => applicablePolicies(authorization, collection.key, action).length > 0
  )
  if (actions.length === 0) return null

  const readPolicies = applicablePolicies(authorization, collection.key, 'read')
  const writePolicies = (['create', 'update', 'delete'] as const).flatMap((action) =>
    applicablePolicies(authorization, collection.key, action)
  )

  const readable = new Set(readableUnion(readPolicies))
  const writable = new Set(writableUnion(writePolicies))
  const granted = new Set([...readable, ...writable])

  const filterable = new Set(
    filterSortIntersection(readPolicies).filter((name) => name in collection.fields)
  )

  const fields: FieldMetadata[] = []
  for (const [name, definition] of Object.entries(collection.fields)) {
    if (!granted.has(name)) continue
    fields.push({
      name,
      type: definition.type,
      required: definition.required,
      nullable: definition.nullable,
      ...(definition.maxLength === undefined ? {} : { maxLength: definition.maxLength }),
      ...(definition.minLength === undefined ? {} : { minLength: definition.minLength }),
      ...(definition.enum === undefined ? {} : { enum: definition.enum }),
      ...(definition.minimum === undefined ? {} : { minimum: definition.minimum }),
      ...(definition.maximum === undefined ? {} : { maximum: definition.maximum }),
      ...(definition.label === undefined ? {} : { label: definition.label }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })
  }

  const relations: RelationMetadata[] = []
  for (const [name, relation] of Object.entries(collection.relations)) {
    if (!granted.has(name)) continue
    relations.push({
      name,
      target: relation.target,
      type: relation.type,
      ...(relation.label === undefined ? {} : { label: relation.label }),
      ...(relation.description === undefined ? {} : { description: relation.description }),
    })
  }

  return {
    key: collection.key,
    label: collection.label,
    ...(collection.description === undefined ? {} : { description: collection.description }),
    schemaVersion: authorization.manifest.schemaVersion,
    actions,
    readableFields: [...readable].sort(),
    writableFields: [...writable].sort(),
    filterableFields: [...filterable].sort(),
    fields,
    relations,
  }
}

/** The union of the fields the write policies grant. */
function writableUnion(
  policies: readonly import('../domains/authorization/policies').Policy[]
): string[] {
  const fields = new Set<string>()
  for (const policy of policies) {
    for (const field of policy.fields) fields.add(field)
  }
  return [...fields]
}
