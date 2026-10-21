#!/usr/bin/env bun
/**
 * The publication of the bundles of policies (spec §8.5).
 *
 * The command is an operator command: it runs on the machine of the
 * deployment and it is not an HTTP route. It publishes the bundle of a
 * workspace, and the bundle that applies to a workspace is the last one
 * that was published.
 *
 * The command never authorizes anybody and it never touches the grants
 * of Hub: it says what a permission grants, and who holds a permission
 * is the business of Hub.
 *
 * The commands:
 *
 *   bun run policy -- publish --workspace <id> --file <path>
 *   bun run policy -- list --workspace <id>
 *   bun run policy -- show --workspace <id> --version <number>
 */

import { Client } from 'pg'
import { parseManifestBundle } from '../src/domains/schema'
import { parsePolicyBundle } from '../src/domains/authorization/policies'

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
  if (command === 'publish') {
    const workspaceId = options.workspace
    const file = options.file
    if (!workspaceId || !file) {
      throw new Error('the workspace and the file are required')
    }
    if (!/^[0-9a-fA-F-]{36}$/.test(workspaceId)) throw new Error('the workspace must be a uuid')

    // The bundle is validated against the manifest of the deployment
    // before it is published: a bundle that names a collection the
    // deployment does not declare, or a field that does not exist, is
    // refused and nothing is written.
    const schemaFile = process.env.DATA_SCHEMA_BUNDLE_FILE ?? 'manifests/schema.json'
    const manifest = parseManifestBundle(await Bun.file(schemaFile).text())
    const body = await Bun.file(file).text()
    const bundle = parsePolicyBundle(body, manifest)

    const workspace = await client.query<{ id: string; tenant_id: string }>(
      'select id, tenant_id from platform.workspaces where id = $1::uuid',
      [workspaceId]
    )
    const row = workspace.rows[0]
    if (!row) throw new Error('the workspace does not exist')

    const next = await client.query<{ version: number }>(
      `select coalesce(max(version), 0) + 1 as version
         from platform.policy_bundles
        where workspace_id = $1::uuid`,
      [workspaceId]
    )
    const version = next.rows[0]?.version ?? 1
    await client.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)`,
      [workspaceId, row.tenant_id, version, bundle.bundleVersion, body, options.by ?? 'operator']
    )
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the bundle was published',
        workspace: workspaceId,
        version,
        bundleVersion: bundle.bundleVersion,
        policies: bundle.policies.length,
      })
    )
  } else if (command === 'list') {
    const workspaceId = options.workspace
    if (!workspaceId) throw new Error('the workspace is required')
    const rows = await client.query(
      `select version, bundle_version, published_at, published_by
         from platform.policy_bundles
        where workspace_id = $1::uuid
        order by version desc`,
      [workspaceId]
    )
    console.log(
      JSON.stringify({ level: 'info', msg: 'the bundles of the workspace', bundles: rows.rows })
    )
  } else if (command === 'show') {
    const workspaceId = options.workspace
    const version = Number(options.version)
    if (!workspaceId || !Number.isInteger(version)) {
      throw new Error('the workspace and the version are required')
    }
    const rows = await client.query(
      `select version, bundle_version, published_at, body
         from platform.policy_bundles
        where workspace_id = $1::uuid and version = $2`,
      [workspaceId, version]
    )
    const row = rows.rows[0]
    if (!row) throw new Error('the bundle does not exist')
    console.log(JSON.stringify({ level: 'info', msg: 'the bundle', bundle: row }))
  } else {
    throw new Error('the command must be publish, list or show')
  }
} finally {
  await client.end()
}
