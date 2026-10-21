#!/usr/bin/env bun
/**
 * The operator commands of the deliveries (spec §11.5).
 *
 * The requeue of a delivery is an explicit command of the operator: it
 * does not bypass the authorization of the business, the handler of the
 * subscriber asks the hub again before it does anything.
 *
 *   bun run scripts/delivery.ts list
 *   bun run scripts/delivery.ts requeue --event <uuid> --subscriber <id> --actor <name>
 *   bun run scripts/delivery.ts backlog
 */

import { Client } from 'pg'

const url = process.env.DATA_DELIVERY_DATABASE_URL ?? process.env.DATA_DATABASE_URL
if (!url) {
  throw new Error('DATA_DELIVERY_DATABASE_URL must be set: it names the delivery metadata role')
}

const args = process.argv.slice(2)
const command = args[0] ?? 'backlog'
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
  if (command === 'list') {
    const rows = await client.query(
      `select d.event_id, d.subscriber_id, d.state, d.attempts, d.next_attempt_at, d.last_error
         from platform.outbox_deliveries d
        order by d.next_attempt_at asc
        limit $1`,
      [Number(options.limit ?? '100')]
    )
    console.log(JSON.stringify({ level: 'info', msg: 'the deliveries', deliveries: rows.rows }))
  } else if (command === 'requeue') {
    const event = options.event
    const subscriber = options.subscriber
    const actor = options.actor
    if (!event || !subscriber || !actor) {
      throw new Error('the event, the subscriber and the actor are required')
    }
    const result = await client.query(
      `update platform.outbox_deliveries
          set state = 'pending', attempts = 0, next_attempt_at = now(),
              lease_expires_at = null, locked_by = null, last_error = $3, updated_at = now()
        where event_id = $1::uuid and subscriber_id = $2`,
      [event, subscriber, `requeued by ${actor}`]
    )
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the delivery was requeued',
        event,
        subscriber,
        actor,
        rows: result.rowCount,
      })
    )
  } else if (command === 'backlog') {
    const rows = await client.query(
      `select
         count(*) filter (where state in ('pending', 'leased'))::text as pending,
         count(*) filter (where state = 'failed')::text as failed,
         extract(epoch from (now() - min(created_at) filter (where state in ('pending', 'leased'))))::text as oldest
       from platform.outbox_deliveries`
    )
    console.log(JSON.stringify({ level: 'info', msg: 'the backlog', backlog: rows.rows[0] }))
  } else {
    throw new Error('the command must be list, requeue or backlog')
  }
} finally {
  await client.end()
}
