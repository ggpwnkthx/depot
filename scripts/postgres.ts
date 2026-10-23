#!/usr/bin/env bun
/**
 * The PostgreSQL of the development machine and of the tests.
 *
 * The script starts a PostgreSQL server in a directory of the working
 * tree, with a socket of its own and a port of its own. It is used by
 * the development stack and by the integration tests: the tests need a
 * real server, because the isolation, the locking and the claims of the
 * workers are the behaviour of a server and not of an embedded engine.
 *
 * The development machine, the tests and the continuous integration use
 * the version `DEVELOPMENT_MAJOR`. A deployment may run an older major:
 * the requirement of a deployment is in `README.md`, and it is not
 * checked here.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

/**
 * The major of PostgreSQL that the development machine, the tests and
 * the continuous integration use.
 *
 * It is the newest major that the repository proves, and it is not the
 * requirement of a deployment: a deployment may run an older major, and
 * the suites of the floor prove it.
 */
export const DEVELOPMENT_MAJOR = 18

/**
 * The major that the machine asks for.
 *
 * It is the way the continuous integration proves the floor of the
 * deployments: the suites run against the version of the development
 * machine and against the oldest major that a deployment may run.
 */
function requestedMajor(): number | null {
  const requested = process.env.POSTGRES_MAJOR
  if (!requested) return null
  if (!/^\d+$/.test(requested)) {
    throw new Error(`the major of PostgreSQL is not a number: ${requested}`)
  }
  return Number(requested)
}

/** The candidates for the binaries of PostgreSQL, the newest first. */
const BINARIES = [
  '/usr/lib/postgresql/18/bin',
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/local/pgsql/bin',
  '/opt/homebrew/opt/postgresql@18/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
]

/** The directory of the binaries of PostgreSQL. */
export function binaries(): string {
  const requested = requestedMajor()
  if (requested !== null) {
    const candidate = `/usr/lib/postgresql/${requested}/bin`
    if (existsSync(join(candidate, 'initdb'))) return candidate
    throw new Error(`the binaries of the PostgreSQL ${requested} were not found`)
  }
  for (const candidate of BINARIES) {
    if (existsSync(join(candidate, 'initdb'))) return candidate
  }
  throw new Error('the binaries of PostgreSQL were not found')
}

/**
 * The major of the server of a directory of binaries.
 *
 * It is null when the binaries do not answer: the version is then
 * unknown, and it is not guessed.
 */
export function majorOf(bin: string): number | null {
  const version = spawnSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' })
  if (version.status !== 0) return null
  const match = /\(\s*PostgreSQL\)\s+(\d+)\./.exec(version.stdout)
  return match ? Number(match[1]) : null
}

/** Finds a free port. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** A PostgreSQL server of the development machine. */
export interface StartedPostgres {
  /** The url of the server, with the superuser of the development machine. */
  readonly url: string
  /** The port of the server. */
  readonly port: number
  /** The directory of the data. */
  readonly dataDir: string
  /** Stops the server. */
  stop: () => void
}

/** The options of the server. */
export interface PostgresOptions {
  /** The directory of the data. */
  readonly dataDir?: string
  /** The port of the server. */
  readonly port?: number
  /** The user of the server. */
  readonly user?: string
  /** The password of the user. */
  readonly password?: string
  /** Removes the data of a previous run. */
  readonly fresh?: boolean
}

/** Starts a PostgreSQL server. */
export async function startPostgres(options: PostgresOptions = {}): Promise<StartedPostgres> {
  const bin = binaries()
  const major = majorOf(bin)
  if (major !== null && major !== DEVELOPMENT_MAJOR && requestedMajor() === null) {
    // The suites prove the semantics of a version, and a suite that
    // runs against another major proves another version. The warning is
    // on the standard error: the standard output is the url.
    console.warn(
      `the server of the development is PostgreSQL ${major} and not ${DEVELOPMENT_MAJOR}: the suites prove another version`
    )
  }
  const dataDir = resolve(options.dataDir ?? join(process.cwd(), '.pg', 'data'))
  const socketDir = resolve(join(dataDir, '..', 'socket'))
  const port = options.port ?? (await freePort())
  const user = options.user ?? 'depot'
  const password = options.password ?? 'depot'

  if (options.fresh && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
  mkdirSync(socketDir, { recursive: true })

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    const init = spawnSync(
      join(bin, 'initdb'),
      ['-D', dataDir, '-U', user, '--auth-local=trust', '--auth-host=scram-sha-256', '-E', 'UTF8'],
      { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }
    )
    if (init.status !== 0) {
      throw new Error(`initdb failed: ${init.stderr}`)
    }
  } else if (major !== null) {
    // A data directory of another major is not a data directory of this
    // server: the server refuses to start on it, and the refusal of the
    // server is not the message that the developer needs.
    const installed = readFileSync(join(dataDir, 'PG_VERSION'), 'utf8').trim()
    if (installed !== String(major)) {
      throw new Error(
        `the data directory ${dataDir} is of the version ${installed} and the server is the version ${major}: remove it or start with --fresh`
      )
    }
  }

  const start = spawnSync(
    join(bin, 'pg_ctl'),
    [
      '-D',
      dataDir,
      '-l',
      join(dataDir, '..', 'server.log'),
      '-o',
      `-p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      '-w',
      'start',
    ],
    { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }
  )
  if (start.status !== 0) {
    throw new Error(`pg_ctl failed: ${start.stderr}\n${start.stdout}`)
  }

  const url = `postgres://${user}:${password}@127.0.0.1:${port}/postgres`
  const stop = (): void => {
    spawnSync(join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' })
  }
  return { url, port, dataDir, stop }
}

if (import.meta.main) {
  const postgres = await startPostgres({
    ...(process.argv.includes('--fresh') ? { fresh: true } : {}),
  })
  console.log(postgres.url)
}
