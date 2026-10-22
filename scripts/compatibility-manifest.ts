/**
 * The manifest of the compatibility baseline (spec §16).
 *
 * The manifest is the one place that owns the repositories of the
 * gateway and of the hub and the revisions that are tested against
 * them. The harness, the documentation and the check of the drift read
 * it: a pin that is written twice is a pin that will drift.
 *
 * The file is `compatibility.json`, at the root of the repository:
 *
 *   {
 *     "version": 1,
 *     "repositories": {
 *       "shuttle": { "url": "https://github.com/ggpwnkthx/shuttle.git", "commit": "<sha>" },
 *       "hub": { "url": "https://github.com/ggpwnkthx/hub.git", "commit": "<sha>" }
 *     }
 *   }
 *
 * The overrides of the environment are for the runs that test another
 * revision: they never change the manifest, and a run with an override
 * is not the proof of the baseline.
 */

/** A repository of the baseline and the revision that is tested. */
export interface PinnedRepository {
  /** The url of the repository, or a path on the disk. */
  readonly url: string
  /** The full revision of the commit that is tested. */
  readonly commit: string
}

/** The manifest of the baseline. */
export interface CompatibilityManifest {
  readonly version: 1
  readonly repositories: {
    readonly shuttle: PinnedRepository
    readonly hub: PinnedRepository
  }
}

/** The problem of a manifest that cannot be used. */
export class CompatibilityManifestError extends Error {
  override readonly name = 'CompatibilityManifestError'
}

/** The name of the file of the manifest. */
export const COMPATIBILITY_MANIFEST_FILE = 'compatibility.json'

/** The revision of a commit is forty hexadecimal characters. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

/** Reports whether a value is a usable url or path of a repository. */
function isUsableUrl(value: string): boolean {
  return value.length > 0 && !/\s/.test(value)
}

/**
 * Parses and validates the manifest.
 *
 * The manifest is refused as a whole: a baseline that names a revision
 * that does not exist, or a branch instead of a revision, is not a
 * baseline.
 */
export function parseCompatibilityManifest(raw: string): CompatibilityManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CompatibilityManifestError('the manifest of the baseline is not json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CompatibilityManifestError('the manifest of the baseline is not an object')
  }
  const file = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(file).filter((key) => key !== 'version' && key !== 'repositories')
  if (unknownKeys.length > 0) {
    throw new CompatibilityManifestError(
      `the manifest of the baseline has unknown properties: ${unknownKeys.sort().join(', ')}`
    )
  }
  if (file.version !== 1) {
    throw new CompatibilityManifestError('the manifest of the baseline must have the version 1')
  }
  const repositories = file.repositories
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
    throw new CompatibilityManifestError(
      'the manifest of the baseline must hold the repositories of the gateway and of the hub'
    )
  }
  const record = repositories as Record<string, unknown>
  const unknownRepositories = Object.keys(record).filter(
    (key) => key !== 'shuttle' && key !== 'hub'
  )
  if (unknownRepositories.length > 0) {
    throw new CompatibilityManifestError(
      `the manifest of the baseline has unknown repositories: ${unknownRepositories.sort().join(', ')}`
    )
  }
  const parsedRepository = (name: string, raw: unknown): PinnedRepository => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CompatibilityManifestError(
        `the repository "${name}" of the baseline is not an object`
      )
    }
    const entry = raw as Record<string, unknown>
    const unknown = Object.keys(entry).filter((key) => key !== 'url' && key !== 'commit')
    if (unknown.length > 0) {
      throw new CompatibilityManifestError(
        `the repository "${name}" of the baseline has unknown properties: ${unknown.sort().join(', ')}`
      )
    }
    const url = entry.url
    const commit = entry.commit
    if (typeof url !== 'string' || !isUsableUrl(url)) {
      throw new CompatibilityManifestError(
        `the repository "${name}" of the baseline must name a url or a path`
      )
    }
    if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
      throw new CompatibilityManifestError(
        `the repository "${name}" of the baseline must name a full revision of forty hexadecimal characters`
      )
    }
    return { url, commit }
  }
  return {
    version: 1,
    repositories: {
      shuttle: parsedRepository('shuttle', record.shuttle),
      hub: parsedRepository('hub', record.hub),
    },
  }
}

/** Reads the manifest of the baseline from the disk. */
export async function readCompatibilityManifest(
  path: string = COMPATIBILITY_MANIFEST_FILE
): Promise<CompatibilityManifest> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new CompatibilityManifestError(`the manifest of the baseline is not there: ${path}`)
  }
  return parseCompatibilityManifest(await file.text())
}

/** The environment as a record of strings. */
export type Env = Record<string, string | undefined>

/** The baseline of a run, and the overrides that were applied to it. */
export interface BaselineSelection {
  readonly shuttle: PinnedRepository
  readonly hub: PinnedRepository
  /** The names of the variables that overrode the manifest. */
  readonly overrides: readonly string[]
  /** True when the run tests the revision of the checked in manifest. */
  readonly isBaseline: boolean
}

/**
 * Applies the overrides of the environment to the manifest.
 *
 * The precedence is the one of the manifest: the environment wins, and
 * an override that cannot be used stops the run. The manifest itself is
 * never changed: an override is a candidate, and a candidate is not the
 * baseline.
 */
export function selectBaseline(
  manifest: CompatibilityManifest,
  env: Env = process.env
): BaselineSelection {
  const overrides: string[] = []
  const select = (
    pinned: PinnedRepository,
    urlVariable: string,
    commitVariable: string
  ): PinnedRepository => {
    // An empty variable is a variable that is not set: a deployment
    // that exports an empty one is not an override.
    const url = env[urlVariable]
    const commit = env[commitVariable]
    if (url !== undefined && url !== '') {
      if (!isUsableUrl(url)) {
        throw new CompatibilityManifestError(`${urlVariable} does not name a repository`)
      }
      overrides.push(urlVariable)
    }
    if (commit !== undefined && commit !== '') {
      if (!COMMIT_PATTERN.test(commit)) {
        throw new CompatibilityManifestError(
          `${commitVariable} must name a full revision of forty hexadecimal characters`
        )
      }
      overrides.push(commitVariable)
    }
    return {
      url: url || pinned.url,
      commit: commit || pinned.commit,
    }
  }
  const shuttle = select(manifest.repositories.shuttle, 'SHUTTLE_REPOSITORY', 'SHUTTLE_COMMIT')
  const hub = select(manifest.repositories.hub, 'HUB_REPOSITORY', 'HUB_COMMIT')
  return {
    shuttle,
    hub,
    overrides,
    isBaseline: overrides.length === 0,
  }
}

/**
 * The name of the mirror of a repository.
 *
 * The url of a repository and the name of its mirror are the same thing
 * with or without the suffix `.git`: a deployment that mirrors
 * `https://github.com/ggpwnkthx/shuttle.git` names the mirror
 * `shuttle.git`, and one that mirrors the url without the suffix names
 * it `shuttle`.
 */
export function mirrorName(url: string): string {
  const withoutSuffix = url.endsWith('.git') ? url.slice(0, -'.git'.length) : url
  const segments = withoutSuffix.replace(/\/+$/, '').split(/[/\\]/)
  return segments[segments.length - 1] ?? ''
}
