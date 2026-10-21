/**
 * The catalog of a workspace (spec §7.6 and §8.5).
 *
 * The catalog is what a workspace serves: the collections it registered
 * and the bundle of policies that applies to it. The deployment holds a
 * default catalog — the manifest of the collections and the bundle of
 * the policies of the deployment — and a workspace may hold its own.
 *
 * **The catalog is a logical registry.** The physical tables of the
 * collections are created by the reviewed migrations of the deployment,
 * their isolation is written in those migrations, and the role of the
 * api never alters them. A registration names a collection of the
 * manifest of the deployment and the table that the deployment declares
 * for it: a registration never creates a table and never names one that
 * the deployment does not declare. This is what keeps the drift of the
 * schema detectable and the isolation of the rows provable.
 *
 * The domain owns the rules of the resolution and it imports no adapter:
 * the store is a port.
 */

import { createHash } from 'node:crypto'
import {
  type Policy,
  type PolicyBundle,
  bundleVersionOf,
  parsePolicyBundle,
} from '../authorization'
import { type CollectionDefinition, type ManifestBundle, contentVersion } from '../schema'
import type { WorkspaceIdentity } from '../workspaces'

/** The scope of a catalog. */
export interface CatalogScope {
  readonly tenantId: string
  readonly workspaceId: string
}

/** A collection a workspace registered. */
export interface RegisteredCollection {
  /** The key of the collection. */
  readonly key: string
  /** The physical table of the collection. */
  readonly table: string
  /** True when the workspace serves the collection. */
  readonly enabled: boolean
  /** The version of the schema the registration was made against. */
  readonly schemaVersion: string
}

/** A bundle a workspace published. */
export interface PublishedBundle {
  /** The version of the bundle, in the order of the publications. */
  readonly version: number
  /** The digest of the content of the bundle. */
  readonly bundleVersion: string
  /** The bundle itself, as it was published. */
  readonly body: string
}

/** What the store holds for a workspace. */
export interface CatalogRegistry {
  /** The collections the workspace registered. */
  readonly collections: readonly RegisteredCollection[]
  /** The bundle the workspace published, when it published one. */
  readonly bundle: PublishedBundle | null
}

/** The workspace and the registry of its catalog, as the store reads them. */
export interface WorkspaceRegistryEntry {
  /** The identity of the workspace. */
  readonly workspace: WorkspaceIdentity
  /** The registry of the catalog of the workspace. */
  readonly registry: CatalogRegistry
}

/** The store of the catalog: a port of the platform. */
export interface CatalogStore {
  /** Reads a workspace and its catalog, in one read. */
  findById: (id: string) => Promise<WorkspaceRegistryEntry | null>
}

/** The catalog of the deployment: the default of every workspace. */
export interface DeploymentCatalog {
  /** The manifest of the deployment. */
  readonly manifest: ManifestBundle
  /** The default bundle of the deployment. */
  readonly bundle: PolicyBundle
}

/**
 * The catalog of a workspace.
 *
 * The manifest is the manifest of the deployment restricted to the
 * collections the workspace serves, and the bundle is the bundle that
 * applies to it. The versions of the two are the versions the cursors
 * bind and the audit log records.
 */
export interface WorkspaceCatalog {
  readonly tenantId: string
  readonly workspaceId: string
  /** The manifest of the workspace. */
  readonly manifest: ManifestBundle
  /** The bundle that applies to the workspace. */
  readonly bundle: PolicyBundle
  /** The version of the schema of the workspace. */
  readonly schemaVersion: string
  /** The version of the bundle of the workspace. */
  readonly policyBundleVersion: string
  /** The version of the catalog: the digest of the two versions and of the keys. */
  readonly catalogVersion: string
  /** The keys of the collections the workspace serves. */
  readonly collectionKeys: readonly string[]
}

/** The workspace and the catalog that applies to it. */
export interface WorkspaceWithCatalog {
  /** The identity of the workspace. */
  readonly workspace: WorkspaceIdentity
  /** The catalog of the workspace. */
  readonly catalog: WorkspaceCatalog
}

/** The provider of the catalog: a port of the application. */
export interface CatalogProvider {
  /** Reads a workspace and its catalog, in one read. */
  find: (id: string) => Promise<WorkspaceWithCatalog | null>
}

/** The problem of a catalog that cannot be used. */
export class CatalogError extends Error {
  override readonly name = 'CatalogError'
}

/**
 * Restricts a manifest to a set of collections.
 *
 * A relation to a collection the workspace does not serve is removed:
 * the expansion of a relation reads the target collection, and a
 * collection that is not served cannot be read.
 */
export function restrictManifest(
  manifest: ManifestBundle,
  keys: readonly string[]
): ManifestBundle {
  const kept = new Set(keys)
  const collections: CollectionDefinition[] = manifest.collections
    .filter((collection) => kept.has(collection.key))
    .map((collection) => ({
      ...collection,
      relations: Object.fromEntries(
        Object.entries(collection.relations).filter(([, relation]) => kept.has(relation.target))
      ),
    }))
  return {
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    collections,
    bundleVersion: contentVersion({
      version: manifest.version,
      schemaVersion: manifest.schemaVersion,
      collections,
    }),
  }
}

/**
 * Resolves the catalog of a workspace.
 *
 * The rules are four:
 *
 * 1. A workspace that registered nothing serves every collection of the
 *    deployment: the default of a deployment that did not use the
 *    registry yet.
 * 2. A workspace that registered something serves the collections it
 *    registered and enabled, and nothing else.
 * 3. A registration that names a collection the deployment does not
 *    declare, or a table the deployment does not declare for it, is a
 *    mistake of the operator and it is refused: a catalog that cannot be
 *    built never serves a partial answer.
 * 4. The bundle of the workspace is the bundle it published, and the
 *    bundle of the deployment when it published none. The policies of a
 *    collection the workspace does not serve are not part of it.
 */
export function resolveCatalog(
  deployment: DeploymentCatalog,
  registry: CatalogRegistry,
  scope: CatalogScope
): WorkspaceCatalog {
  const keys: string[] = []
  for (const entry of registry.collections) {
    const collection = deployment.manifest.collections.find(
      (candidate) => candidate.key === entry.key
    )
    if (!collection) {
      throw new CatalogError(
        `the collection "${entry.key}" is registered and the deployment does not declare it`
      )
    }
    if (collection.table !== entry.table) {
      throw new CatalogError(
        `the collection "${entry.key}" names the table "${entry.table}" and the deployment declares "${collection.table}"`
      )
    }
    if (entry.enabled) keys.push(entry.key)
  }

  const effectiveKeys =
    registry.collections.length === 0
      ? deployment.manifest.collections.map((collection) => collection.key)
      : keys
  const manifest = restrictManifest(deployment.manifest, effectiveKeys)
  const bundle = effectiveBundle(deployment, registry, manifest)

  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    manifest,
    bundle,
    schemaVersion: manifest.schemaVersion,
    policyBundleVersion: bundle.bundleVersion,
    catalogVersion: contentVersion({
      schemaVersion: manifest.schemaVersion,
      policyBundleVersion: bundle.bundleVersion,
      collections: [...effectiveKeys].sort(),
    }),
    collectionKeys: effectiveKeys,
  }
}

/** The bundle that applies to a workspace. */
function effectiveBundle(
  deployment: DeploymentCatalog,
  registry: CatalogRegistry,
  manifest: ManifestBundle
): PolicyBundle {
  let policies: readonly Policy[]
  if (registry.bundle) {
    let published: PolicyBundle
    try {
      // The bundle is parsed again at every resolution: a bundle that was
      // published against another manifest, or that was edited in the
      // database, never applies.
      published = parsePolicyBundle(registry.bundle.body, deployment.manifest)
    } catch (error) {
      throw new CatalogError(
        `the published bundle of the workspace cannot be used: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      )
    }
    policies = published.policies
  } else {
    policies = deployment.bundle.policies
  }
  const served = new Set(manifest.collections.map((collection) => collection.key))
  const kept = policies.filter((policy) => served.has(policy.collection))
  return {
    version: deployment.bundle.version,
    policies: kept,
    bundleVersion: bundleVersionOf(kept),
  }
}

/** A resolved catalog and the fingerprint of its inputs. */
interface CacheEntry {
  /** The fingerprint of the registry the catalog was built from. */
  readonly fingerprint: string
  readonly catalog: WorkspaceCatalog
}

/** The options of the provider. */
export interface CatalogProviderOptions {
  readonly store: CatalogStore
  readonly deployment: DeploymentCatalog
}

/**
 * The provider of the catalog of a workspace.
 *
 * The provider reads the registry of the workspace and builds its
 * catalog. The read is the read of the registry of the workspaces: the
 * identity of the workspace and the registry of its catalog come from
 * the same statement, and nothing is cached **from the database**.
 *
 * The resolved catalog is memoized in the process, and the fingerprint
 * of the registry is the key: the collections that the workspace
 * registered and the digest of the bundle it published. A bundle that
 * was edited in the database has another digest, and it is parsed again
 * and refused when it cannot be used.
 */
export class WorkspaceCatalogProvider implements CatalogProvider {
  readonly #options: CatalogProviderOptions
  readonly #cache = new Map<string, CacheEntry>()

  constructor(options: CatalogProviderOptions) {
    this.#options = options
  }

  /** Reads a workspace and its catalog. */
  async find(id: string): Promise<WorkspaceWithCatalog | null> {
    const entry = await this.#options.store.findById(id)
    if (!entry) return null
    const fingerprint = fingerprintOf(entry.registry)
    const cached = this.#cache.get(id)
    if (cached && cached.fingerprint === fingerprint) {
      return { workspace: entry.workspace, catalog: cached.catalog }
    }
    const catalog = resolveCatalog(this.#options.deployment, entry.registry, {
      tenantId: entry.workspace.tenantId,
      workspaceId: entry.workspace.id,
    })
    this.#cache.set(id, { fingerprint, catalog })
    return { workspace: entry.workspace, catalog }
  }
}

/**
 * The fingerprint of a registry.
 *
 * It carries the collections that the workspace registered and the
 * digest of the bundle it published. A change of the registry or of the
 * content of the bundle changes the fingerprint, and the catalog is
 * built again.
 */
export function fingerprintOf(registry: CatalogRegistry): string {
  const collections = registry.collections
    .map((entry) => `${entry.key}:${entry.table}:${entry.enabled ? '1' : '0'}`)
    .sort()
    .join(',')
  const bundle = registry.bundle
    ? `${registry.bundle.version}:${createHash('sha256').update(registry.bundle.body).digest('hex')}`
    : ''
  return `${collections}|${bundle}`
}
