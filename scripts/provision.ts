#!/usr/bin/env bun
/**
 * The provisioning of the roles and of the database (spec §6.4).
 *
 * The script runs once per deployment, with the credentials of an
 * administrator of the server. It creates the roles of the separation
 * and the database of the deployment:
 *
 * - `data_owner` owns the schemas and the tables. It is the only role
 *   that may alter the schema, and it is never used by the api.
 * - `data_runtime` is the role of the api: it reads and writes the
 *   business data of the scope of its transaction, and nothing else.
 * - `data_registry` is the narrow reader of the registry: three columns
 *   of the table of the workspaces.
 * - `data_delivery` claims the metadata of the deliveries. It may not
 *   read a business record.
 * - `data_maintenance` runs the retention of the history.
 *
 * The passwords come from the environment and they are never written to
 * a log. The script never prints them.
 */

import { Client } from 'pg'

/** The roles of the deployment. */
const ROLES = ['data_owner', 'data_runtime', 'data_registry', 'data_delivery', 'data_maintenance']

/** The password of a role, from the environment. */
function passwordOf(name: string): string {
  const value = process.env[`DATA_${name.replace('data_', '').toUpperCase()}_PASSWORD`]
  if (!value || value.length < 16) {
    throw new Error(
      `DATA_${name.replace('data_', '').toUpperCase()}_PASSWORD must be set and it is at least 16 characters`
    )
  }
  return value
}

/** The identifier of the database of the deployment. */
const DATABASE = process.env.DATA_DATABASE_NAME ?? 'depot'

/** Sets the password of a role, without putting it in a log. */
async function setPassword(admin: Client, name: string, password: string): Promise<void> {
  const statement = await admin.query<{ statement: string }>(
    `select format('alter role %I with login password %L', $1::text, $2::text) as statement`,
    [name, password]
  )
  await admin.query(statement.rows[0]!.statement)
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATA_ADMIN_DATABASE_URL
  if (!adminUrl) {
    throw new Error('DATA_ADMIN_DATABASE_URL must be set: it names the administrator of the server')
  }

  // The roles first: the database is owned by the owner of the schema.
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    for (const name of ROLES) {
      const exists = await admin.query('select 1 from pg_roles where rolname = $1', [name])
      if (exists.rowCount && exists.rowCount > 0) {
        await setPassword(admin, name, passwordOf(name))
        continue
      }
      await admin.query(`create role ${name} with login`)
      await setPassword(admin, name, passwordOf(name))
      console.log(JSON.stringify({ level: 'info', msg: 'a role was created', role: name }))
    }

    const database = await admin.query('select 1 from pg_database where datname = $1', [DATABASE])
    if (!database.rowCount || database.rowCount === 0) {
      await admin.query(`create database ${DATABASE} owner data_owner`)
      console.log(
        JSON.stringify({ level: 'info', msg: 'the database was created', database: DATABASE })
      )
    }
  } finally {
    await admin.end()
  }
}

await main()
