#!/usr/bin/env bun
/**
 * The check of the packaged client (spec §12).
 *
 * The typed client is published on a registry of packages, and it is
 * released as a tarball of the release of the repository:
 *
 *   bun add https://github.com/ggpwnkthx/depot/releases/download/v0.3.1/data-backend-client-0.3.1.tgz
 *   npm install @data-backend/client
 *
 * The check proves that the artifact that the release publishes is
 * installable and usable outside of this repository: it packs the
 * client with the command of the release, it installs the tarball in a
 * consumer that lives outside of the repository, it imports the client
 * through its public name and it calls the API with it.
 *
 * The consumer runs with **bun** and with **node**: the client of a
 * stable release is a library of the two runtimes, and a client that
 * only answers to one of them is a client of one runtime.
 *
 * The command:
 *
 *   bun run scripts/check-client-package.ts
 */

import { spawnSync } from 'bun'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The directory of the client. */
const CLIENT_DIRECTORY = 'packages/client'

/** The name of the package of the client. */
const CLIENT_PACKAGE = '@data-backend/client'

/**
 * The name of the tarball of the release.
 *
 * The name is the name of the package without its scope and with the
 * version of the release: the workflow of the release uploads the file
 * of that name and the documentation installs it with that url.
 */
export function tarballName(version: string): string {
  return `data-backend-client-${version}.tgz`
}

/**
 * The consumer of the packaged client.
 *
 * It imports the client through its public name, it calls the API with a
 * transport of its own, and it proves that the module it loaded is the
 * one of the consumer and not a file of the repository.
 */
const CONSUMER = `import { DataClient } from '@data-backend/client'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const answer = {
  data: [{ id: '11111111-1111-4111-8111-111111111111', version: 1, title: 'A row' }],
  meta: { limit: 50, nextCursor: null },
}

// The transport of the consumer: the client never invents one.
const transport = async () =>
  new Response(JSON.stringify(answer), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const client = new DataClient({
  baseUrl: 'https://api.example.test',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  fetch: transport,
})

const page = await client.list('articles', { limit: 1 })
const resolved = import.meta.resolve('@data-backend/client').slice('file://'.length)
const inside = resolved.startsWith(join(process.cwd(), 'node_modules'))
const hoisted = ['hono', 'jose', 'pg', 'zod'].filter((name) =>
  existsSync(join(process.cwd(), 'node_modules', name))
)

console.log(
  JSON.stringify({
    rows: page.data.length,
    module: resolved,
    inside,
    hoisted,
    error: page.data.length === 1 ? undefined : 'the client did not read the row',
  })
)
`

/** Runs a command and fails when it does not answer with a success. */
function run(command: string[], cwd: string): string {
  const result = spawnSync(command, { cwd })
  if (result.exitCode !== 0) {
    throw new Error(
      `the command "${command.join(' ')}" failed in ${cwd}: ${result.stderr?.toString() ?? ''}`
    )
  }
  return result.stdout?.toString() ?? ''
}

/** Reports whether a command is installed on the machine. */
function hasCommand(command: string): boolean {
  try {
    const result = spawnSync([command, '--version'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

const manifest = JSON.parse(await readFile(join(CLIENT_DIRECTORY, 'package.json'), 'utf8')) as {
  name: string
  version: string
}
if (manifest.name !== CLIENT_PACKAGE) {
  throw new Error(`the package of the client is "${manifest.name}" and not "${CLIENT_PACKAGE}"`)
}

const workspace = await mkdtemp(join(tmpdir(), 'depot-client-'))
try {
  // 1. The packing, with the command of the release.
  const packed = join(workspace, 'packed')
  await mkdir(packed, { recursive: true })
  run(['bun', 'pm', 'pack', '--destination', packed], CLIENT_DIRECTORY)
  const files = await readdir(packed)
  const expected = tarballName(manifest.version)
  if (files.length !== 1 || files[0] !== expected) {
    throw new Error(
      `the packing of the client produced ${files.join(', ')} and the release publishes "${expected}"`
    )
  }
  const tarball = join(packed, expected)
  console.log(JSON.stringify({ level: 'info', msg: 'the client is packed', tarball: expected }))

  // 2. The consumer, outside of the repository.
  const consumer = join(workspace, 'consumer')
  await mkdir(consumer, { recursive: true })
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'the-consumer-of-the-client',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { [CLIENT_PACKAGE]: `file:${tarball}` },
      },
      null,
      2
    )}\n`
  )
  await writeFile(join(consumer, 'index.mjs'), CONSUMER)
  run(['bun', 'install'], consumer)
  console.log(JSON.stringify({ level: 'info', msg: 'the tarball is installed in a consumer' }))

  // 3. The call of the client, through its public name, with bun and
  // with node. The client of a stable release is a library of the two
  // runtimes.
  for (const runtime of ['bun', 'node']) {
    if (runtime === 'node' && !hasCommand('node')) {
      console.log(
        JSON.stringify({ level: 'warn', msg: 'node is not installed: the check ran with bun only' })
      )
      continue
    }
    const output =
      runtime === 'bun'
        ? run(['bun', 'run', 'index.mjs'], consumer)
        : run(['node', 'index.mjs'], consumer)
    const report = JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as {
      rows?: number
      module?: string
      inside?: boolean
      hoisted?: string[]
      error?: string
    }
    if (report.error) {
      throw new Error(`the consumer of the client failed with ${runtime}: ${report.error}`)
    }
    if (report.rows !== 1) {
      throw new Error(
        `the consumer of the client did not read the row of the fixture with ${runtime}`
      )
    }
    if (!report.inside) {
      throw new Error(
        `the client was resolved outside of the consumer with ${runtime}: ${report.module}. ` +
          'The packaged client has to carry its own files.'
      )
    }
    if ((report.hoisted ?? []).length > 0) {
      throw new Error(
        `the consumer relies on the dependencies of the service with ${runtime}: ${(report.hoisted ?? []).join(', ')}`
      )
    }
    console.log(
      JSON.stringify({
        level: 'info',
        msg: `the packed client works outside of the repository with ${runtime}`,
        module: report.module,
        rows: report.rows,
      })
    )
  }
} finally {
  await rm(workspace, { recursive: true, force: true })
}
