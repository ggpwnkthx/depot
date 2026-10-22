#!/usr/bin/env bun
/**
 * The tag of a release (spec §16).
 *
 * The versions of the project live in three files: the manifest of the
 * service, the manifest of the client and the argument of the image.
 * The release is the tag that names the version, and the workflows of
 * the release run on the tag.
 *
 * The command reads the three versions, it refuses a project whose
 * versions do not agree, it compares the version of the service with
 * the tags that exist, and it creates and pushes the tag of the
 * release when the version increased.
 *
 *   bun run scripts/tag-release.ts
 *   bun run scripts/tag-release.ts --dry-run
 *
 * The environment:
 *
 *   RELEASE_TAG_TOKEN  the token that pushes the tag. A push made with
 *                      the token of the repository does not start the
 *                      workflows of the release: a personal access
 *                      token with the permission `contents: write` is
 *                      needed for the release to start by itself.
 */

import { spawnSync } from 'bun'
import { readFileSync, writeFileSync } from 'node:fs'

/** The version of a release. */
export interface ReleaseVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** The suffix of a pre-release, empty for a release. */
  readonly prerelease: string
}

/** The versions of the project. */
export interface ProjectVersions {
  /** The version of the service. */
  readonly service: string
  /** The version of the client. */
  readonly client: string
  /** The version of the image. */
  readonly image: string
}

/** The decision of the command. */
export interface TagDecision {
  /** The tag of the release. */
  readonly tag: string
  /** The tag that the version increased, when there is one. */
  readonly previous: string | null
  /** The versions of the project. */
  readonly versions: ProjectVersions
}

/** The pattern of a version of the project. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Parses a version of the project.
 *
 * The version is the form `major.minor.patch`, with an optional suffix
 * of a pre-release. A version that is not of that form is refused: a
 * tag that names a version nobody can compare is a tag nobody can
 * trust.
 */
export function parseVersion(text: string): ReleaseVersion {
  const match = VERSION_PATTERN.exec(text.trim())
  if (!match) {
    throw new Error(`the version "${text}" is not of the form major.minor.patch`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/**
 * Compares two versions of the project.
 *
 * The comparison is the one of the semantic versioning: the numbers
 * first, and a pre-release is smaller than the release it precedes.
 * The versions are compared as numbers and never as texts: `0.10.0` is
 * greater than `0.9.0`, and the texts say the opposite.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * The decision of the tag of a release.
 *
 * The decision is the tag when the version of the service is greater
 * than the highest tag that exists, and nothing when it is not: a
 * release that does not increase the version is not a release, and a
 * workflow that runs twice does not create a tag twice.
 */
export function decideTag(versions: ProjectVersions, tags: readonly string[]): TagDecision | null {
  const known = tags
    .filter((tag) => VERSION_PATTERN.test(tag.replace(/^v/, '')))
    .map((tag) => tag.replace(/^v/, ''))
  if (known.length === 0) {
    return { tag: `v${versions.service}`, previous: null, versions }
  }
  const highest = known.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a))
  if (compareVersions(versions.service, highest) <= 0) return null
  return { tag: `v${versions.service}`, previous: `v${highest}`, versions }
}

/**
 * Reads the versions of the project.
 *
 * The three versions have to be the same one: a release whose client
 * carries another version than its service is a release that two
 * clients install.
 */
export function readProjectVersions(root = '.'): ProjectVersions {
  const service = readVersion(join(root, 'package.json'))
  const client = readVersion(join(root, 'packages/client/package.json'))
  const image = readImageVersion(join(root, 'Dockerfile'))
  return { service, client, image }
}

/**
 * Writes a version in the three files of the project.
 *
 * The manifest of the service, the manifest of the client and the
 * `ARG VERSION` of the image carry the version of the release, and the
 * three files are written with the same version. The files are written
 * as they are: the manifests are json with two spaces of indentation,
 * and the image is a text.
 */
export function writeProjectVersion(version: string, root = '.'): ProjectVersions {
  parseVersion(version)
  const manifest = join(root, 'package.json')
  const client = join(root, 'packages/client/package.json')
  const dockerfile = join(root, 'Dockerfile')
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
  )
  writeFileSync(
    client,
    readFileSync(client, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
  )
  writeFileSync(
    dockerfile,
    readFileSync(dockerfile, 'utf8').replace(/^(ARG VERSION=).+$/m, `$1${version}`)
  )
  return readProjectVersions(root)
}

/** Joins the parts of a path. */
function join(root: string, path: string): string {
  return root === '.' ? path : `${root}/${path}`
}

/** Reads the version of a manifest of the project. */
function readVersion(path: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`the manifest "${path}" does not hold a version`)
  }
  return manifest.version
}

/** Reads the version of the image, from the argument of the build. */
function readImageVersion(path: string): string {
  const source = readFileSync(path, 'utf8')
  const match = /^ARG VERSION=(.+)$/m.exec(source)
  if (!match) {
    throw new Error(`the image of "${path}" does not name its version`)
  }
  return match[1]!.trim()
}

/** Runs a command of git and fails when it does not answer. */
function git(args: readonly string[]): string {
  const result = spawnSync(['git', ...args])
  if (result.exitCode !== 0) {
    throw new Error(
      `the command "git ${args.join(' ')}" failed: ${result.stderr?.toString() ?? ''}`
    )
  }
  return result.stdout?.toString() ?? ''
}

/**
 * Pushes the tag of the release.
 *
 * The token of the environment replaces the credentials of the
 * checkout: a push made with the token of the repository does not
 * start the workflows of the release, and a personal access token with
 * the permission `contents: write` does.
 *
 * The credentials are written for the host of the remote, and not for
 * every host: the header of the authorization is a secret, and it is
 * sent to the host of the remote and to no other one.
 */
function pushTag(tag: string): void {
  const token = process.env.RELEASE_TAG_TOKEN
  if (token) {
    const host = hostOf(git(['remote', 'get-url', 'origin']).trim())
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    git(['config', '--local', `http.https://${host}/.extraheader`, header])
  }
  git(['push', 'origin', `refs/tags/${tag}`])
}

/**
 * The host of a remote of git.
 *
 * The url of a remote is either an url or a path of the disk: the
 * path has no host, and the credentials of the checkout are used for
 * it.
 */
function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@?([^/:]+)/i.exec(url)
  return match?.[1] ?? 'github.com'
}

/** The command of the release. */
export function main(argv: readonly string[]): number {
  const dryRun = argv.includes('--dry-run')
  const set = argv.indexOf('--set')
  if (set >= 0) {
    const version = argv[set + 1]
    if (!version) {
      throw new Error('the option --set needs the version of the release')
    }
    const known = git(['tag', '--list', 'v*'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((tag) => tag.replace(/^v/, ''))
      .filter((tag) => VERSION_PATTERN.test(tag))
    const highest =
      known.length > 0 ? known.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a)) : null
    if (highest && compareVersions(version, highest) <= 0) {
      throw new Error(
        `the version ${version} is not greater than the version ${highest} of the latest tag: ` +
          'a version that was released is not released again'
      )
    }
    const written = dryRun
      ? { service: version, client: version, image: version }
      : writeProjectVersion(version)
    console.log(
      JSON.stringify({
        level: 'info',
        msg: dryRun
          ? 'the version of the project would be written'
          : 'the version of the project is written',
        version: written.service,
        previous: highest,
      })
    )
    return 0
  }

  const versions = readProjectVersions()
  if (versions.service !== versions.client || versions.service !== versions.image) {
    throw new Error(
      `the service is ${versions.service}, the client is ${versions.client} and the image is ${versions.image}: ` +
        'the three versions of the project have to be the same one before a tag is created'
    )
  }
  // The version is parsed before anything else: a version that is not
  // of the form major.minor.patch is a mistake of the operator, and it
  // is refused before a tag is written.
  parseVersion(versions.service)

  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const decision = decideTag(versions, tags)
  if (!decision) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the version did not increase: no tag is created',
        version: versions.service,
        tags: tags.length,
      })
    )
    return 0
  }

  if (dryRun) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the tag of the release, and it is not created',
        tag: decision.tag,
        previous: decision.previous,
      })
    )
    return 0
  }

  if (tags.includes(decision.tag)) {
    console.log(JSON.stringify({ level: 'info', msg: 'the tag exists already', tag: decision.tag }))
    return 0
  }

  git(['tag', '-a', decision.tag, '-m', `the release ${decision.tag}`])
  pushTag(decision.tag)
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the tag of the release is pushed',
      tag: decision.tag,
      previous: decision.previous,
      inert: !process.env.RELEASE_TAG_TOKEN,
    })
  )
  if (!process.env.RELEASE_TAG_TOKEN) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg:
          'the tag was pushed with the token of the repository: the workflows of the release ' +
          'do not start with it. Set the secret RELEASE_TOKEN of the repository, or start them ' +
          'by hand with the tag.',
        tag: decision.tag,
      })
    )
  }
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'the tag of the release could not be created',
        error: error instanceof Error ? error.message : String(error),
      })
    )
    process.exit(1)
  }
}
