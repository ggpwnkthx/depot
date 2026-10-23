/**
 * The workspace registry (spec §6.1).
 *
 * A workspace is a resource of the backend: it belongs to exactly one
 * tenant of Hub and it is either active or disabled. The registry stores
 * the reference to the tenant of Hub, never a copy of its directory: the
 * backend does not own the identity of a tenant and it does not own the
 * grants of a principal.
 *
 * The identity of a workspace is read before the context of a request
 * exists. That read is a narrow bootstrap exception: the adapter may
 * only read the identity of a workspace and the catalog of the
 * workspace, and it may only look one workspace up by its exact id.
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
