import { describe, expect, test } from 'bun:test'
import {
  CatalogError,
  type CatalogRegistry,
  type CatalogStore,
  WorkspaceCatalogProvider,
  resolveCatalog,
  restrictManifest,
} from '../../src/domains/catalog'
import { parseManifestBundle } from '../../src/domains/schema'
import { parsePolicyBundle } from '../../src/domains/authorization/policies'

const manifest = parseManifestBundle(await Bun.file('manifests/schema.json').text())
const bundle = parsePolicyBundle(await Bun.file('manifests/policies.json').text(), manifest)

/** The scope of the tests. */
const scope = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 'w1' }

/** A registry that holds nothing. */
const empty: CatalogRegistry = { collections: [], bundle: null }

describe('the catalog of a workspace', () => {
  test('a workspace that registered nothing serves every collection of the deployment', () => {
    const catalog = resolveCatalog({ manifest, bundle }, empty, scope)
    expect([...catalog.collectionKeys].sort()).toEqual(['article_stats', 'articles', 'categories'])
    expect(catalog.manifest.collections).toHaveLength(3)
  })

  test('a workspace that registered something serves only what it registered', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'articles', table: 'data.articles', enabled: true, schemaVersion: 'articles-v1' },
      ],
      bundle: null,
    }
    const catalog = resolveCatalog({ manifest, bundle }, registry, scope)
    expect(catalog.collectionKeys).toEqual(['articles'])
    expect(catalog.manifest.collections.map((entry) => entry.key)).toEqual(['articles'])
  })

  test('a relation to a collection the workspace does not serve is removed', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'articles', table: 'data.articles', enabled: true, schemaVersion: 'articles-v1' },
      ],
      bundle: null,
    }
    const catalog = resolveCatalog({ manifest, bundle }, registry, scope)
    const articles = catalog.manifest.collections[0]!
    expect(Object.keys(articles.relations).sort()).toEqual(['children', 'parent'])
    // The relation to the categories is gone: the target is not served.
    expect(articles.relations.category).toBeUndefined()
  })

  test('a collection that is registered and disabled is not served', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'articles', table: 'data.articles', enabled: true, schemaVersion: 'articles-v1' },
        {
          key: 'categories',
          table: 'data.categories',
          enabled: false,
          schemaVersion: 'articles-v1',
        },
      ],
      bundle: null,
    }
    const catalog = resolveCatalog({ manifest, bundle }, registry, scope)
    expect(catalog.collectionKeys).toEqual(['articles'])
  })

  test('a registration of a collection the deployment does not declare is refused', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'invoices', table: 'data.invoices', enabled: true, schemaVersion: 'articles-v1' },
      ],
      bundle: null,
    }
    expect(() => resolveCatalog({ manifest, bundle }, registry, scope)).toThrow(CatalogError)
  })

  test('a registration that names another table is refused', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'articles', table: 'data.others', enabled: true, schemaVersion: 'articles-v1' },
      ],
      bundle: null,
    }
    expect(() => resolveCatalog({ manifest, bundle }, registry, scope)).toThrow(CatalogError)
  })

  test('the bundle of the deployment applies when the workspace published none', () => {
    const catalog = resolveCatalog({ manifest, bundle }, empty, scope)
    expect(catalog.policyBundleVersion).toBe(bundle.bundleVersion)
  })

  test('the bundle a workspace published applies instead of the bundle of the deployment', () => {
    // The published body is the bundle as it is written, exactly like
    // the file of the deployment.
    const published = {
      id: 'read-articles',
      permission: 'content.reader',
      collection: 'articles',
      action: 'read',
      where: {},
      check: {},
      fields: ['title'],
    }
    const registry: CatalogRegistry = {
      collections: [],
      bundle: {
        version: 1,
        bundleVersion: 'published',
        body: JSON.stringify({ version: 1, policies: [published] }),
      },
    }
    const catalog = resolveCatalog({ manifest, bundle }, registry, scope)
    expect(catalog.bundle.policies).toHaveLength(1)
    expect(catalog.bundle.policies[0]!.id).toBe('read-articles')
    expect(catalog.policyBundleVersion).not.toBe(bundle.bundleVersion)
  })

  test('a bundle that cannot be used is refused and never serves a partial answer', () => {
    const registry: CatalogRegistry = {
      collections: [],
      bundle: {
        version: 1,
        bundleVersion: 'broken',
        body: JSON.stringify({ version: 1, policies: [{ id: 'x' }] }),
      },
    }
    expect(() => resolveCatalog({ manifest, bundle }, registry, scope)).toThrow(CatalogError)
  })

  test('the policies of a collection the workspace does not serve are not part of the bundle', () => {
    const registry: CatalogRegistry = {
      collections: [
        { key: 'articles', table: 'data.articles', enabled: true, schemaVersion: 'articles-v1' },
      ],
      bundle: null,
    }
    const catalog = resolveCatalog({ manifest, bundle }, registry, scope)
    expect(catalog.bundle.policies.every((policy) => policy.collection === 'articles')).toBe(true)
    expect(catalog.policyBundleVersion).not.toBe(bundle.bundleVersion)
  })

  test('the version of the catalog is a digest of its content', () => {
    const first = resolveCatalog({ manifest, bundle }, empty, scope)
    const second = resolveCatalog({ manifest, bundle }, empty, scope)
    expect(first.catalogVersion).toBe(second.catalogVersion)
    const other = resolveCatalog({ manifest, bundle }, empty, { ...scope, workspaceId: 'w2' })
    expect(other.catalogVersion).toBe(first.catalogVersion)
  })

  test('the restriction of a manifest keeps the fields and the labels', () => {
    const restricted = restrictManifest(manifest, ['articles'])
    expect(restricted.collections).toHaveLength(1)
    expect(restricted.collections[0]?.fields.title?.type).toBe('string')
    expect(restricted.schemaVersion).toBe(manifest.schemaVersion)
  })
})

describe('the provider of the catalog', () => {
  /** A store that answers with the registry it holds. */
  function storeOf(registry: CatalogRegistry): CatalogStore {
    return {
      findById: async (id: string) => ({
        workspace: { id, tenantId: scope.tenantId, status: 'active' as const },
        registry,
      }),
    }
  }

  test('a workspace that does not exist is not a workspace', async () => {
    const provider = new WorkspaceCatalogProvider({
      store: { findById: async () => null },
      deployment: { manifest, bundle },
    })
    expect(await provider.find('unknown')).toBeNull()
  })

  test('the resolved catalog is reused while the registry does not change', async () => {
    const provider = new WorkspaceCatalogProvider({
      store: storeOf({ collections: [], bundle: null }),
      deployment: { manifest, bundle },
    })
    const first = await provider.find('w1')
    const second = await provider.find('w1')
    expect(second?.catalog).toBe(first?.catalog)
  })

  test('a bundle that was edited in the database is parsed again', async () => {
    let body = JSON.stringify({ version: 1, policies: [] })
    const provider = new WorkspaceCatalogProvider({
      store: {
        findById: async (id: string) => ({
          workspace: { id, tenantId: scope.tenantId, status: 'active' as const },
          registry: {
            collections: [],
            bundle: { version: 1, bundleVersion: 'v1', body },
          },
        }),
      },
      deployment: { manifest, bundle },
    })
    const first = await provider.find('w1')
    expect(first?.catalog.bundle.policies).toHaveLength(0)

    // The bundle of the database is edited, and its content digest
    // changes: the catalog is built again and the broken bundle is
    // refused.
    body = JSON.stringify({ version: 1, policies: [{ id: 'x' }] })
    await expect(provider.find('w1')).rejects.toThrow(CatalogError)
  })
})
