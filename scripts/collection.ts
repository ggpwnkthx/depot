#!/usr/bin/env bun
/**
 * The registration of the collections of a workspace (spec §7.6).
 *
 * The command is an operator command: it runs on the machine of the
 * deployment and it is not an HTTP route. It registers the collections
 * of the deployment that a workspace serves.
 *
 * **The registration is logical.** The command never creates a table and
 * never alters one: the tables of the collections come from the reviewed
 * migrations of the deployment, their isolation is written in those
 * migrations, and the role of the api never alters them. The command
 * names a collection of the manifest of the deployment and the table
 * that the deployment declares for it.
 *
 * The commands:
 *
 *   bun run collection -- register --workspace <id> --collection <key>
 *   bun run collection -- enable --workspace <id> --collection <key>
 *   bun run collection -- disable --workspace <id> --collection <key>
 *   bun run collection -- list --workspace <id>
 */

import { Client } from 'pg'
import { parseManifestBundle } from '../src/domains/schema'

const url = process.env.DATA_OWNER_DATABASE_URL ?? process.env.DATA_DATABASE_URL
if (!url) {
  throw new Error('DATA_OWNER_DATABASE_URL must be set: it names the owner of the schema')
}

const args = process.argv.slice(2)
const command = args[0]
const options: Record<string, string> = {}
for (let index = 1; index < args.length; index += 1) {
  const key = args[index]
  if (!key?.startsWith('--')) continue
  options[key.slice(2)] = args[index + 1] ?? ''
  index += 1
}

const client = new Client({ connectionString: url })
await client.connect()

try {
  if (command === 'register' || command === 'enable' || command === 'disable') {
    const workspaceId = options.workspace
    const key = options.collection
    if (!workspaceId || !key) {
      throw new Error('the workspace and the collection are required')
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId)) throw new Error('the workspace must be a uuid')

    const schemaFile = process.env.DATA_SCHEMA_BUNDLE_FILE ?? 'manifests/schema.json'
    const manifest = parseManifestBundle(await Bun.file(schemaFile).text())
    const collection = manifest.collections.find((entry) => entry.key === key)
    if (!collection) {
      throw new Error(`the collection "${key}" is not declared by the deployment`)
    }

    const workspace = await client.query<{ id: string; tenant_id: string }>(
      'select id, tenant_id from platform.workspaces where id = $1::uuid',
      [workspaceId]
    )
    const row = workspace.rows[0]
    if (!row) throw new Error('the workspace does not exist')

    const enabled = command !== 'disable'
    await client.query(
      `insert into platform.collection_registry
         (workspace_id, tenant_id, collection_key, table_name, schema_version, enabled)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6)
       on conflict (workspace_id, collection_key) do update
         set table_name = excluded.table_name,
             schema_version = excluded.schema_version,
             enabled = excluded.enabled,
             updated_at = now()`,
      [workspaceId, row.tenant_id, key, collection.table, manifest.schemaVersion, enabled]
    )
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the collection was registered',
        workspace: workspaceId,
        collection: key,
        table: collection.table,
        enabled,
      })
    )
  } else if (command === 'list') {
    const workspaceId = options.workspace
    if (!workspaceId) throw new Error('the workspace is required')
    const rows = await client.query(
      `select collection_key, table_name, schema_version, enabled, updated_at
         from platform.collection_registry
        where workspace_id = $1::uuid
        order by collection_key`,
      [workspaceId]
    )
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the collections of the workspace',
        collections: rows.rows,
      })
    )
  } else {
    throw new Error('the command must be register, enable, disable or list')
  }
} finally {
  await client.end()
}
