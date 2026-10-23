#!/usr/bin/env bun
/**
 * The check of the drift of the baseline (spec §16).
 *
 * The manifest `compatibility.json` owns the repositories of the gateway
 * and of the hub and the revisions that are tested against them. The
 * documentation of the baseline and the workflows of the integration
 * read it, and this check proves that they still agree with it.
 *
 * The command:
 *
 *   bun run scripts/check-compatibility.ts          # the check
 *   bun run scripts/check-compatibility.ts --write  # the regeneration of the block
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type CompatibilityManifest, readCompatibilityManifest } from './compatibility-manifest'

/** The markers of the block of the baseline in the specification. */
export const BASELINE_START = '<!-- compatibility-baseline:start -->'
export const BASELINE_END = '<!-- compatibility-baseline:end -->'

/** The markers of the block of the manifest in the guide. */
export const MANIFEST_START = '<!-- compatibility-manifest:start -->'
export const MANIFEST_END = '<!-- compatibility-manifest:end -->'

/** The specification of the service. */
const SPECS_FILE = 'docs/specification.md'

/** The guide of the compatibility with the platform. */
const GUIDE_FILE = 'docs/compatibility.md'

/** The directory of the workflows. */
const WORKFLOWS_DIRECTORY = '.github/workflows'

/** A problem of the baseline. */
export interface BaselineProblem {
  readonly file: string
  readonly message: string
}

/** The block of the baseline, as it is written in the specification. */
export function baselineBlock(manifest: CompatibilityManifest): string {
  const { shuttle, hub } = manifest.repositories
  return [
    BASELINE_START,
    '',
    'The baseline of the integration is the one of `compatibility.json`: the',
    'one file of this repository that owns the repositories of the gateway and',
    'of the hub and the revisions that are tested against them.',
    '',
    '| Project | Repository | Revision |',
    '| --- | --- | --- |',
    `| Shuttle | ${shuttle.url} | \`${shuttle.commit}\` |`,
    `| Hub | ${hub.url} | \`${hub.commit}\` |`,
    '',
    BASELINE_END,
  ].join('\n')
}

/**
 * The block of the manifest, as it is written in the guide.
 *
 * The guide shows the manifest of the baseline: a revision that is
 * written twice is a revision that drifts, so the block is generated
 * from the manifest and the check of the drift proves that the two
 * still agree.
 */
export function manifestBlock(manifest: CompatibilityManifest): string {
  return [
    MANIFEST_START,
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
    MANIFEST_END,
  ].join('\n')
}

/**
 * Checks the baseline of the specification, of the guide and of the
 * workflows.
 *
 * The check is small on purpose: it proves that the active documentation
 * and the workflows agree with the manifest, and it says nothing about
 * the historical evidence of the releases.
 */
export function checkBaselineDrift(options: {
  readonly manifest: CompatibilityManifest
  readonly specs: string
  readonly guide?: string
  readonly workflows: readonly { readonly name: string; readonly text: string }[]
}): BaselineProblem[] {
  const problems: BaselineProblem[] = []
  const { shuttle, hub } = options.manifest.repositories

  const start = options.specs.indexOf(BASELINE_START)
  const end = options.specs.indexOf(BASELINE_END)
  if (start < 0 || end < 0 || end < start) {
    problems.push({
      file: SPECS_FILE,
      message: `the block of the baseline is not there (${BASELINE_START})`,
    })
  } else {
    const block = options.specs.slice(start, end + BASELINE_END.length)
    const expected = baselineBlock(options.manifest)
    if (block !== expected) {
      problems.push({
        file: SPECS_FILE,
        message:
          'the block of the baseline does not agree with compatibility.json: ' +
          'run `bun run scripts/check-compatibility.ts --write`',
      })
    }
  }

  // The guide shows the manifest itself: the revision of the baseline
  // is not written twice, and the copy that is written cannot drift.
  if (options.guide !== undefined) {
    const start = options.guide.indexOf(MANIFEST_START)
    const end = options.guide.indexOf(MANIFEST_END)
    if (start < 0 || end < 0 || end < start) {
      problems.push({
        file: GUIDE_FILE,
        message: `the block of the manifest is not there (${MANIFEST_START})`,
      })
    } else {
      const block = options.guide.slice(start, end + MANIFEST_END.length)
      const expected = manifestBlock(options.manifest)
      if (block !== expected) {
        problems.push({
          file: GUIDE_FILE,
          message:
            'the block of the manifest does not agree with compatibility.json: ' +
            'run `bun run scripts/check-compatibility.ts --write`',
        })
      }
    }
  }

  for (const workflow of options.workflows) {
    for (const [name, pinned] of [
      ['shuttle', shuttle],
      ['hub', hub],
    ] as const) {
      if (workflow.text.includes(pinned.commit)) {
        problems.push({
          file: `${WORKFLOWS_DIRECTORY}/${workflow.name}`,
          message: `the workflow holds the revision of the ${name}: the manifest owns it`,
        })
      }
    }
  }

  return problems
}

/** Reads the workflows of the repository. */
async function readWorkflows(): Promise<{ name: string; text: string }[]> {
  const entries = await readdir(WORKFLOWS_DIRECTORY)
  const workflows: { name: string; text: string }[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue
    workflows.push({ name: entry, text: await readFile(join(WORKFLOWS_DIRECTORY, entry), 'utf8') })
  }
  return workflows
}

/** The main of the check. */
async function main(): Promise<void> {
  const manifest = await readCompatibilityManifest()
  const specs = await readFile(SPECS_FILE, 'utf8')
  const guide = await readFile(GUIDE_FILE, 'utf8')
  const workflows = await readWorkflows()
  const write = process.argv.includes('--write')
  if (write) {
    const block = baselineBlock(manifest)
    const start = specs.indexOf(BASELINE_START)
    const end = specs.indexOf(BASELINE_END)
    if (start < 0 || end < 0) {
      throw new Error(`the block of the baseline is not there in ${SPECS_FILE}`)
    }
    await writeFile(
      SPECS_FILE,
      specs.slice(0, start) + block + specs.slice(end + BASELINE_END.length)
    )
    const manifestText = manifestBlock(manifest)
    const guideStart = guide.indexOf(MANIFEST_START)
    const guideEnd = guide.indexOf(MANIFEST_END)
    if (guideStart < 0 || guideEnd < 0) {
      throw new Error(`the block of the manifest is not there in ${GUIDE_FILE}`)
    }
    await writeFile(
      GUIDE_FILE,
      guide.slice(0, guideStart) + manifestText + guide.slice(guideEnd + MANIFEST_END.length)
    )
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the blocks of the baseline were written',
        files: [SPECS_FILE, GUIDE_FILE],
      })
    )
    return
  }
  const problems = checkBaselineDrift({ manifest, specs, guide, workflows })
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(JSON.stringify({ level: 'error', file: problem.file, msg: problem.message }))
    }
    process.exit(1)
  }
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the baseline of the documentation agrees with the manifest',
      shuttle: manifest.repositories.shuttle.commit,
      hub: manifest.repositories.hub.commit,
    })
  )
}

if (import.meta.main) {
  await main()
}
