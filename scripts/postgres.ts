#!/usr/bin/env bun
/**
 * The PostgreSQL of the development machine and of the tests.
 *
 * The script starts a PostgreSQL server in a directory of the working
 * tree, with a socket of its own and a port of its own. It is used by
 * the development stack and by the integration tests: the tests need a
 * real server, because the isolation, the locking and the claims of the
 * workers are the behaviour of a server and not of an embedded engine.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

/** The candidates for the binaries of PostgreSQL. */
const BINARIES = [
  '/usr/lib/postgresql/17/bin',
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/local/pgsql/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
]

/** The directory of the binaries of PostgreSQL. */
export function binaries(): string {
  for (const candidate of BINARIES) {
    if (existsSync(join(candidate, 'initdb'))) return candidate
  }
  throw new Error('the binaries of PostgreSQL were not found')
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
