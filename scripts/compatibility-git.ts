/**
 * The acquisition of the upstream checkouts (spec §16).
 *
 * The harness needs the gateway and the hub at the revisions of the
 * baseline of `compatibility.json`. It gets them from the network when
 * it can, from a local checkout when the deployment has one, and from
 * the mirrors of the deployment when the network is not there.
 *
 * The module never modifies the source it is given: it clones it, and
 * the clone is a directory of its own that the harness removes at the
 * end of the run.
 */

import { spawnSync } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mirrorName } from './compatibility-manifest'

/** The result of a git command. */
export interface GitResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a git command and captures its output. */
export function git(args: string[], cwd?: string): GitResult {
  const result = spawnSync(['git', ...args], { cwd })
  return {
    status: result.exitCode ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  }
}

/**
 * The source of a clone.
 *
 * A repository that is a path on the disk is used as it is: the clone of
 * a local path does not use the network. When the path is not there, the
 * mirror of the harness is used, if it holds the repository. The url is
 * the last resort.
 *
 * The name of the mirror is the name of the repository with or without
 * the suffix `.git`: a deployment that mirrors
 * `https://github.com/ggpwnkthx/shuttle.git` holds `shuttle.git`, and one
 * that mirrors the url without the suffix holds `shuttle`.
 */
export function sourceOf(repository: string, mirrorDirectory: string): string {
  if (existsSync(repository)) return repository
  if (mirrorDirectory) {
    const mirror = join(mirrorDirectory, `${mirrorName(repository)}.git`)
    if (existsSync(mirror)) return mirror
  }
  return repository
}

/**
 * Clones a repository at a revision and proves that the clone is the
 * revision.
 *
 * The clone is checked: the head of the clone has to be the revision of
 * the baseline, and the tracked files of the clone have to be clean. A
 * clone that is not the revision is not the evidence of the contract.
 */
export function cloneAtRevision(source: string, commit: string, directory: string): void {
  const clone = git(['clone', '--quiet', source, directory])
  if (clone.status !== 0) {
    throw new Error(
      `the clone of ${source} failed: ${clone.stderr.trim()}. ` +
        `Set SHUTTLE_REPOSITORY or HUB_REPOSITORY to a local checkout that holds ${commit}, ` +
        'or set COMPAT_MIRROR to a directory that holds the bare mirrors.'
    )
  }
  const checkout = git(['checkout', '--quiet', commit], directory)
  if (checkout.status !== 0) {
    throw new Error(
      `the checkout of ${commit} failed: ${checkout.stderr.trim()}. ` +
        `The source ${source} does not hold the pinned revision.`
    )
  }
  const head = git(['rev-parse', 'HEAD'], directory)
  if (head.status !== 0 || head.stdout.trim() !== commit) {
    throw new Error(
      `the clone of ${source} is at ${head.stdout.trim() || 'an unknown revision'} and the baseline is ${commit}`
    )
  }
  assertCleanCheckout(directory)
}

/**
 * Proves that the tracked files of a checkout are clean.
 *
 * The harness never changes a checkout of the gateway or of the hub: a
 * dirty checkout is not the revision of the baseline, and the harness
 * says so instead of testing something else.
 */
export function assertCleanCheckout(directory: string): void {
  const status = git(['status', '--porcelain', '--untracked-files=no'], directory)
  if (status.status !== 0) {
    throw new Error(
      `the state of the checkout ${directory} could not be read: ${status.stderr.trim()}`
    )
  }
  const dirty = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (dirty.length > 0) {
    throw new Error(
      `the checkout ${directory} is not clean: ${dirty.slice(0, 5).join('; ')}. ` +
        'The harness tests the revision of the baseline and it never changes a checkout.'
    )
  }
}
