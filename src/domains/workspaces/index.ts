/**
 * The workspace registry (spec §6.1).
 *
 * A workspace is a resource of the backend: it belongs to exactly one
 * tenant of Hub and it is either active or disabled. The registry stores
 * the reference to the tenant of Hub, never a copy of its directory: the
 * backend does not own the identity of a tenant and it does not own the
 * grants of a principal.
 *
 * The registry is read before the context of a request exists. That read
 * is a narrow bootstrap exception: the adapter may only read the identity
 * of a workspace, and it may only look one workspace up by its exact id.
 */

/** The state of a workspace. */
export type WorkspaceStatus = 'active' | 'disabled'

/** The identity of a workspace, as the registry holds it. */
export interface WorkspaceIdentity {
  /** The identifier of the workspace. */
  readonly id: string
  /** The tenant of Hub the workspace belongs to. */
  readonly tenantId: string
  /** The state of the workspace. */
  readonly status: WorkspaceStatus
}

/**
 * The reader of the registry.
 *
 * The port has exactly one method, and that method takes the exact
 * identifier of a workspace: the reader cannot enumerate the workspaces
 * of a tenant and it cannot run a query of its own.
 */
export interface WorkspaceRegistry {
  /** Reads the identity of a workspace, or null when there is none. */
  findById: (id: string) => Promise<WorkspaceIdentity | null>
}

/** The slug of a workspace: 1 to 63 characters, in a tenant unique. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/

/** The maximum length of the display name of a workspace. */
export const WORKSPACE_DISPLAY_NAME_MAX = 200

/** Reports whether a slug is a valid slug of a workspace. */
export function isValidWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug)
}

/** Reports whether a display name is a valid display name. */
export function isValidWorkspaceDisplayName(name: string): boolean {
  const length = [...name].length
  return length >= 1 && length <= WORKSPACE_DISPLAY_NAME_MAX
}
