import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CompatibilityManifestError,
  mirrorName,
  parseCompatibilityManifest,
  readCompatibilityManifest,
  selectBaseline,
} from '../../scripts/compatibility-manifest'
import {
  assertCleanCheckout,
  cloneAtRevision,
  git,
  sourceOf,
} from '../../scripts/compatibility-git'
import { baselineBlock, checkBaselineDrift, manifestBlock } from '../../scripts/check-compatibility'

/** The manifest of the repository. */
const manifest = await readCompatibilityManifest()

describe('the manifest of the baseline', () => {
  test('it names a full revision of the gateway and of the hub', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.repositories.shuttle.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.repositories.hub.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.repositories.shuttle.url).toContain('shuttle')
    expect(manifest.repositories.hub.url).toContain('hub')
  })

  test('it refuses a manifest that is not json', () => {
    expect(() => parseCompatibilityManifest('nope')).toThrow(CompatibilityManifestError)
  })

  test('it refuses a version of the format that it does not know', () => {
    expect(() =>
      parseCompatibilityManifest(JSON.stringify({ version: 2, repositories: {} }))
    ).toThrow()
  })

  test('it refuses a branch instead of a revision', () => {
    expect(() =>
      parseCompatibilityManifest(
        JSON.stringify({
          version: 1,
          repositories: {
            shuttle: { url: 'https://example.test/shuttle.git', commit: 'main' },
            hub: { url: 'https://example.test/hub.git', commit: 'main' },
          },
        })
      )
    ).toThrow()
  })

  test('it refuses a repository that is not there', () => {
    expect(() =>
      parseCompatibilityManifest(
        JSON.stringify({
          version: 1,
          repositories: {
            shuttle: { url: 'https://example.test/shuttle.git', commit: 'a'.repeat(40) },
          },
        })
      )
    ).toThrow()
  })

  test('it refuses a property it does not know', () => {
    expect(() =>
      parseCompatibilityManifest(
        JSON.stringify({
          version: 1,
          repositories: {
            shuttle: {
              url: 'https://example.test/shuttle.git',
              commit: 'a'.repeat(40),
              branch: 'main',
            },
            hub: { url: 'https://example.test/hub.git', commit: 'b'.repeat(40) },
          },
        })
      )
    ).toThrow()
  })
})

describe('the selection of the baseline', () => {
  test('the manifest is the baseline when the environment is empty', () => {
    const selection = selectBaseline(manifest, {})
    expect(selection.isBaseline).toBe(true)
    expect(selection.overrides).toHaveLength(0)
    expect(selection.shuttle).toEqual(manifest.repositories.shuttle)
    expect(selection.hub).toEqual(manifest.repositories.hub)
  })

  test('an explicit repository wins over the manifest', () => {
    const selection = selectBaseline(manifest, {
      SHUTTLE_REPOSITORY: '/srv/mirrors/shuttle',
    })
    expect(selection.shuttle.url).toBe('/srv/mirrors/shuttle')
    expect(selection.shuttle.commit).toBe(manifest.repositories.shuttle.commit)
    expect(selection.isBaseline).toBe(false)
    expect(selection.overrides).toContain('SHUTTLE_REPOSITORY')
  })

  test('an explicit revision wins over the manifest', () => {
    const selection = selectBaseline(manifest, { HUB_COMMIT: 'c'.repeat(40) })
    expect(selection.hub.commit).toBe('c'.repeat(40))
    expect(selection.isBaseline).toBe(false)
  })

  test('a revision that is not a full revision is refused', () => {
    expect(() => selectBaseline(manifest, { SHUTTLE_COMMIT: 'main' })).toThrow(
      CompatibilityManifestError
    )
    expect(() => selectBaseline(manifest, { HUB_COMMIT: 'abc' })).toThrow()
  })

  test('a repository that is not a repository is refused', () => {
    expect(() => selectBaseline(manifest, { SHUTTLE_REPOSITORY: '  ' })).toThrow(
      CompatibilityManifestError
    )
  })

  test('an empty variable is a variable that is not set', () => {
    const selection = selectBaseline(manifest, { SHUTTLE_REPOSITORY: '', HUB_COMMIT: '' })
    expect(selection.isBaseline).toBe(true)
    expect(selection.shuttle).toEqual(manifest.repositories.shuttle)
  })
})

describe('the name of a mirror', () => {
  test('the url and the url with the suffix name the same mirror', () => {
    expect(mirrorName('https://github.com/ggpwnkthx/shuttle.git')).toBe('shuttle')
    expect(mirrorName('https://github.com/ggpwnkthx/shuttle')).toBe('shuttle')
    expect(mirrorName('/srv/mirrors/shuttle.git')).toBe('shuttle')
    expect(mirrorName('/srv/mirrors/shuttle')).toBe('shuttle')
  })
})

describe('the acquisition of the references', () => {
  /** A small git repository with one commit. */
  const repository = async (): Promise<{ path: string; commit: string }> => {
    const directory = await mkdtemp(join(tmpdir(), 'depot-git-'))
    git(['init', '--quiet', '--initial-branch=main', directory])
    git(['config', 'user.email', 'test@example.test'], directory)
    git(['config', 'user.name', 'the test'], directory)
    await writeFile(join(directory, 'README.md'), 'the fixture\n')
    git(['add', 'README.md'], directory)
    git(['commit', '--quiet', '-m', 'the fixture'], directory)
    const commit = git(['rev-parse', 'HEAD'], directory).stdout.trim()
    return { path: directory, commit }
  }

  test('a local repository is used as it is', async () => {
    const source = await repository()
    try {
      expect(sourceOf(source.path, '')).toBe(source.path)
    } finally {
      await rm(source.path, { recursive: true, force: true })
    }
  })

  test('the mirror is used when the repository is not there', async () => {
    const mirrors = await mkdtemp(join(tmpdir(), 'depot-mirrors-'))
    try {
      await mkdir(join(mirrors, 'shuttle.git'))
      expect(sourceOf('https://github.com/ggpwnkthx/shuttle.git', mirrors)).toBe(
        join(mirrors, 'shuttle.git')
      )
      expect(sourceOf('https://github.com/ggpwnkthx/shuttle', mirrors)).toBe(
        join(mirrors, 'shuttle.git')
      )
    } finally {
      await rm(mirrors, { recursive: true, force: true })
    }
  })

  test('the url is the last resort', async () => {
    const mirrors = await mkdtemp(join(tmpdir(), 'depot-mirrors-'))
    try {
      expect(sourceOf('https://github.com/ggpwnkthx/shuttle.git', mirrors)).toBe(
        'https://github.com/ggpwnkthx/shuttle.git'
      )
    } finally {
      await rm(mirrors, { recursive: true, force: true })
    }
  })

  test('the clone is at the revision and it is clean', async () => {
    const source = await repository()
    const workspace = await mkdtemp(join(tmpdir(), 'depot-clone-'))
    try {
      const clone = join(workspace, 'reference')
      cloneAtRevision(source.path, source.commit, clone)
      expect(git(['rev-parse', 'HEAD'], clone).stdout.trim()).toBe(source.commit)
      expect(() => assertCleanCheckout(clone)).not.toThrow()
    } finally {
      await rm(source.path, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('a source that does not hold the revision is refused', async () => {
    const source = await repository()
    const workspace = await mkdtemp(join(tmpdir(), 'depot-clone-'))
    try {
      const clone = join(workspace, 'reference')
      expect(() => cloneAtRevision(source.path, 'd'.repeat(40), clone)).toThrow(
        /does not hold the pinned revision|the checkout of/
      )
    } finally {
      await rm(source.path, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('a checkout that carries changes is refused', async () => {
    const source = await repository()
    const workspace = await mkdtemp(join(tmpdir(), 'depot-clone-'))
    try {
      const clone = join(workspace, 'reference')
      cloneAtRevision(source.path, source.commit, clone)
      await writeFile(join(clone, 'README.md'), 'changed\n')
      expect(() => assertCleanCheckout(clone)).toThrow(/not clean/)
    } finally {
      await rm(source.path, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('the drift of the baseline', () => {
  test('the block of the baseline agrees with the manifest', () => {
    const specs = `${baselineBlock(manifest)}\n`
    expect(checkBaselineDrift({ manifest, specs, workflows: [] })).toHaveLength(0)
  })

  test('a revision that is not the one of the manifest is a drift', () => {
    const specs = baselineBlock({
      ...manifest,
      repositories: {
        ...manifest.repositories,
        shuttle: { url: manifest.repositories.shuttle.url, commit: 'a'.repeat(40) },
      },
    })
    const problems = checkBaselineDrift({ manifest, specs, workflows: [] })
    expect(problems.length).toBeGreaterThan(0)
  })

  test('a workflow that holds the revision is a drift', () => {
    const problems = checkBaselineDrift({
      manifest,
      specs: baselineBlock(manifest),
      workflows: [
        {
          name: 'ci.yml',
          text: `SHUTTLE_COMMIT: ${manifest.repositories.shuttle.commit}`,
        },
      ],
    })
    expect(problems.length).toBeGreaterThan(0)
  })

  test('the block of the manifest of the guide agrees with the manifest', () => {
    const problems = checkBaselineDrift({
      manifest,
      specs: baselineBlock(manifest),
      guide: manifestBlock(manifest),
      workflows: [],
    })
    expect(problems).toHaveLength(0)
  })

  test('a guide that holds another revision is a drift', () => {
    const guide = manifestBlock({
      ...manifest,
      repositories: {
        ...manifest.repositories,
        hub: { url: manifest.repositories.hub.url, commit: 'b'.repeat(40) },
      },
    })
    const problems = checkBaselineDrift({
      manifest,
      specs: baselineBlock(manifest),
      guide,
      workflows: [],
    })
    expect(problems.length).toBeGreaterThan(0)
  })

  test('a guide without the block of the manifest is a drift', () => {
    const problems = checkBaselineDrift({
      manifest,
      specs: baselineBlock(manifest),
      guide: 'the guide without the block',
      workflows: [],
    })
    expect(problems.length).toBeGreaterThan(0)
  })
})

describe('the fixture of the identity', () => {
  test('it is the fixture of the revision of the baseline', async () => {
    const fixture = (await Bun.file('test/fixtures/shuttle-identity.json').json()) as {
      shuttleCommit: string
      current: { version: string; algorithm: string; publicKeyPem: string }
      legacy: { version: string; algorithm: string }
    }
    // The fixture is the evidence of the contract of the revision of
    // the baseline: a fixture of another revision is the evidence of
    // another contract, and a change of the baseline that does not
    // regenerate it is a change that is not proved.
    expect(fixture.shuttleCommit).toBe(manifest.repositories.shuttle.commit)
    expect(fixture.current.version).toBe('v5')
    expect(fixture.current.algorithm).toBe('ES256')
    expect(fixture.current.publicKeyPem).toContain('BEGIN PUBLIC KEY')
  })
})
