#!/usr/bin/env bun
/**
 * The entry point of the process (spec §3).
 *
 * The process starts the runtime, it serves the API and it drains on a
 * signal. The role of the process decides what it does: an api process
 * serves the endpoints, a worker process claims the deliveries and an
 * `all` process does both.
 */

import { Listener } from './platform/bun/server'
import { createRuntime } from './runtime/composition'

const runtime = await createRuntime()
const listener = new Listener({
  host: runtime.settings.network.host,
  port: runtime.settings.network.port,
  logger: runtime.logger,
  metrics: runtime.metrics,
  maxInFlightRequests: runtime.settings.requests.maxInFlightRequests,
  drainMs: runtime.settings.requests.drainMs,
  fetch: runtime.app.fetch,
})

await listener.start()
runtime.worker?.start()

runtime.logger.info('the service is ready', {
  role: runtime.settings.role,
  port: listener.port,
  version: '0.1.0',
})

let closing = false
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return
  closing = true
  runtime.logger.info('the service drains', { signal })
  await listener.drain()
  await runtime.stop()
  process.exit(0)
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
