#!/usr/bin/env bun
/**
 * The administration of the workspaces (spec §6.1).
 *
 * The command is an operator command: it runs on the machine of the
 * deployment and it is not an HTTP route. It never bypasses Hub: it
 * stores the reference of a tenant of Hub, it does not authorize anybody.
 */

import { Client } from 'pg'

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
  if (command === 'create') {
    const id = options.id
    const tenant = options.tenant
    const slug = options.slug
    const name = options.name ?? slug
    if (!id || !tenant || !slug) {
      throw new Error('the id, the tenant and the slug are required')
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('the id must be a uuid')
    if (!/^[0-9a-fA-F-]{36}$/.test(tenant)) throw new Error('the tenant must be a uuid')
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(slug)) throw new Error('the slug is not valid')
    await client.query(
      `insert into platform.workspaces (id, tenant_id, slug, display_name, status)
       values ($1::uuid, $2::uuid, $3, $4, 'active')
       on conflict (id) do update set tenant_id = excluded.tenant_id, slug = excluded.slug,
         display_name = excluded.display_name, updated_at = now()`,
      [id, tenant, slug, name]
    )
    console.log(
      JSON.stringify({ level: 'info', msg: 'the workspace was created', id, tenant, slug })
    )
  } else if (command === 'disable' || command === 'enable') {
    const id = options.id
    if (!id) throw new Error('the id is required')
    const status = command === 'disable' ? 'disabled' : 'active'
    await client.query(
      `update platform.workspaces set status = $2, updated_at = now() where id = $1::uuid`,
      [id, status]
    )
    console.log(JSON.stringify({ level: 'info', msg: 'the workspace was updated', id, status }))
  } else if (command === 'list') {
    const rows = await client.query(
      'select id, tenant_id, slug, display_name, status from platform.workspaces order by slug'
    )
    console.log(JSON.stringify({ level: 'info', msg: 'the workspaces', workspaces: rows.rows }))
  } else {
    throw new Error('the command must be create, enable, disable or list')
  }
} finally {
  await client.end()
}
