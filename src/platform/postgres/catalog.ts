/**
 * The store of the catalog (spec §7.6 and §8.5).
 *
 * The adapter is the only code that speaks SQL about the tables of the
 * catalog. It reads them with the **narrow registry reader**, the same
 * credential that looks a workspace up by its exact identifier: the
 * catalog of a workspace is the configuration of the workspace and not
 * business data.
 *
 * The read returns the identity of the workspace **and** its catalog in
 * one statement. The registry of the workspaces is on the path of every
 * request, and the catalog is read with it: a second round trip for the
 * catalog would double the work of the registry pool, which is the
 * smallest pool of the deployment.
 *
 * The catalog of a workspace is read with the workspace that it names,
 * and the identifier of the workspace comes from the verified identity
 * of the gateway. The tables keep their row level security, and the
 * reader of the registry is the narrow exception of the specification.
 */

import type { CatalogRegistry, PublishedBundle, RegisteredCollection } from '../../domains/catalog'
import type { WorkspaceIdentity } from '../../domains/workspaces'
import type { ConnectionPool } from './database'

/** The row of the statement of the workspace and of its catalog. */
export interface WorkspaceCatalogRow {
  readonly id: string
  readonly tenant_id: string
  readonly status: string
  readonly collections: unknown
  readonly bundle: unknown
}

/**
 * The statement that reads a workspace and its catalog.
 *
 * It is the statement of the registry of the workspaces with the two
 * subqueries of the catalog. The identifier of the workspace is the one
 * of the request, and the tenant of the catalog is the tenant of the
 * workspace.
 */
export const WORKSPACE_WITH_CATALOG = `
  select
    w.id,
    w.tenant_id,
    w.status,
    (select jsonb_agg(jsonb_build_object(
              'key', c.collection_key,
              'table', c.table_name,
              'enabled', c.enabled,
              'schemaVersion', c.schema_version))
       from platform.collection_registry c
      where c.workspace_id = w.id and c.tenant_id = w.tenant_id) as collections,
    (select jsonb_build_object(
              'version', b.version,
              'bundleVersion', b.bundle_version,
              'body', b.body)
       from platform.policy_bundles b
      where b.workspace_id = w.id and b.tenant_id = w.tenant_id
      order by b.version desc
      limit 1) as bundle
    from platform.workspaces w
   where w.id = $1::uuid`

/** The store of the catalog of the workspaces. */
export class PostgresCatalogStore {
  readonly #pool: ConnectionPool

  constructor(pool: ConnectionPool) {
    this.#pool = pool
  }

  /**
   * Reads a workspace and its catalog.
   *
   * The read is one statement: the identity of the workspace and the
   * registry of its catalog come from the same row.
   */
  async findById(
    id: string
  ): Promise<{ workspace: WorkspaceIdentity; registry: CatalogRegistry } | null> {
    const rows = await this.#pool.query<WorkspaceCatalogRow>(WORKSPACE_WITH_CATALOG, [id])
    const row = rows[0]
    if (!row) return null
    return {
      workspace: {
        id: row.id,
        tenantId: row.tenant_id,
        status: row.status === 'disabled' ? 'disabled' : 'active',
      },
      registry: catalogOf(row),
    }
  }
}

/** Builds the registry of a catalog from the row of the statement. */
export function catalogOf(row: WorkspaceCatalogRow | undefined): CatalogRegistry {
  const collections = (row?.collections ?? []) as RegisteredCollection[]
  const raw = (row?.bundle ?? null) as {
    version: number
    bundleVersion: string
    body: unknown
  } | null
  const bundle: PublishedBundle | null = raw
    ? {
        version: raw.version,
        bundleVersion: raw.bundleVersion,
        // The bundle is published as a document, and it is parsed again
        // as a document when it is resolved.
        body: JSON.stringify(raw.body),
      }
    : null
  return { collections, bundle }
}
