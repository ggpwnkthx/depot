/**
 * The composition of the rules of the data (spec §8).
 *
 * The rules are pure: they take the permission keys of a principal, the
 * policy bundle and the rows that are at hand, and they answer what may
 * be read, what may be written and which policy authorizes the write.
 *
 * A write is authorized by **one** policy. The predicates and the fields
 * of two policies are never mixed: a write that no single policy allows
 * stays refused.
 */

import type { ManifestBundle } from '../schema'
import { type FilterNode, evaluateFilter, type SubstitutionContext } from './filter'
import type { Action, Policy, PolicyBundle } from './policies'

/** The input of the composition. */
export interface AuthorizationInput {
  /** The permission keys the principal holds right now. */
  readonly permissionKeys: readonly string[]
  /** The policy bundle of the deployment. */
  readonly bundle: PolicyBundle
  /** The manifest of the deployment. */
  readonly manifest: ManifestBundle
}

/** The policies that apply to a collection and an action. */
export function applicablePolicies(
  input: AuthorizationInput,
  collection: string,
  action: Action
): Policy[] {
  const keys = new Set(input.permissionKeys)
  return input.bundle.policies.filter(
    (policy) =>
      policy.collection === collection && policy.action === action && keys.has(policy.permission)
  )
}

/**
 * The fields a caller may read of a collection.
 *
 * The union is the answer to "which fields exist for this caller": a
 * field that no read policy grants is not part of the answer.
 */
export function readableUnion(policies: readonly Policy[]): string[] {
  const fields = new Set<string>()
  for (const policy of policies) {
    for (const field of policy.fields) fields.add(field)
  }
  return [...fields].sort()
}

/**
 * The fields a caller may filter and sort by.
 *
 * The intersection is the conservative answer: a field that one policy
 * hides would let a caller learn something about a row that another
 * policy protects.
 */
export function filterSortIntersection(policies: readonly Policy[]): string[] {
  if (policies.length === 0) return []
  let intersection: Set<string> | null = null
  for (const policy of policies) {
    const fields = new Set(policy.fields)
    if (!intersection) {
      intersection = fields
      continue
    }
    intersection = new Set([...intersection].filter((field) => fields.has(field)))
  }
  return [...(intersection ?? [])].sort()
}

/** The request of a write. */
export interface WriteRequest {
  /** The action of the write. */
  readonly action: Extract<Action, 'create' | 'update' | 'delete'>
  /** The fields the client writes. */
  readonly writtenFields: readonly string[]
  /** The row as it is now, for an update and for a delete. */
  readonly currentRow?: Readonly<Record<string, unknown>>
  /** The row as it will be, for a creation and for an update. */
  readonly resultingRow?: Readonly<Record<string, unknown>>
  /** The values the substitutions take. */
  readonly context: SubstitutionContext
}

/** The result of the composition of a write. */
export interface WriteDecision {
  /** True when one policy authorizes the write. */
  readonly allowed: boolean
  /** The policy that authorizes the write. */
  readonly policy?: Policy
  /** The reason the write is refused, when it is refused. */
  readonly reason?:
    | 'no_permission'
    | 'no_policy'
    | 'field_not_granted'
    | 'where_not_matched'
    | 'check_not_matched'
}

/**
 * Chooses the policy that authorizes a write.
 *
 * The candidates are the policies of the action whose field set covers
 * every field the client writes. The first candidate whose predicates
 * hold is the policy of the write; the others are not mixed into it.
 */
export function selectWritePolicy(
  policies: readonly Policy[],
  request: WriteRequest
): WriteDecision {
  if (policies.length === 0) return { allowed: false, reason: 'no_permission' }
  let sawCandidate = false
  for (const policy of policies) {
    const coversFields = request.writtenFields.every((field) => policy.fields.includes(field))
    if (!coversFields) continue
    sawCandidate = true
    if (request.action !== 'create' && request.currentRow) {
      if (!evaluateFilter(policy.where, request.currentRow, request.context)) continue
    }
    if (request.action !== 'delete' && request.resultingRow) {
      if (!evaluateFilter(policy.check, request.resultingRow, request.context)) continue
    }
    return { allowed: true, policy }
  }
  return { allowed: false, reason: sawCandidate ? 'where_not_matched' : 'field_not_granted' }
}

/** The predicate of a policy, for the diagnostics of the deployment. */
export function predicateOf(policy: Policy): FilterNode {
  return policy.where
}
