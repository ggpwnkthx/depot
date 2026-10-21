/**
 * The structured log of the service (spec §15.2).
 *
 * The log is a stream of JSON objects on the standard output. It carries
 * the request id, the normalized route, the safe status and the timing of
 * the dependencies.
 *
 * The values that may carry a secret, a credential or a business value
 * never reach the log: the redactor removes the fields that are known to
 * carry them, and the callers never pass a body.
 */

/** The level of a log record. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** The order of the levels. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/** A field of a log record. */
export type LogFields = Record<string, unknown>

/** The sink of the log. */
export interface LogSink {
  write: (line: string) => void
}

/** The logger of the service. */
export interface Logger {
  debug: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
  /** A logger that adds the fields to every record. */
  child: (fields: LogFields) => Logger
}

/** The names of the fields that never reach the log. */
const REDACTED_FIELDS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-shuttle-signature',
  'password',
  'secret',
  'token',
  'credential',
  'body',
  'filter',
  'query',
  'email',
  'connectionString',
  'databaseUrl',
  'accessToken',
])

/** The replacement of a redacted value. */
export const REDACTED = '[redacted]'

/**
 * Removes the values that may not be logged.
 *
 * The redactor works on the keys of the fields, not on their values: a
 * value that carries a secret under another name is the mistake of the
 * caller, and the callers of this service never pass one.
 */
export function redact(fields: LogFields): LogFields {
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_FIELDS.has(key.toLowerCase())) {
      out[key] = REDACTED
      continue
    }
    if (key.toLowerCase().endsWith('password')) {
      out[key] = REDACTED
      continue
    }
    out[key] = value
  }
  return out
}

/** A logger that writes on the standard output. */
export function createLogger(options: {
  level: LogLevel
  sink?: LogSink
  fields?: LogFields
}): Logger {
  const sink = options.sink ?? { write: (line: string) => process.stdout.write(`${line}\n`) }
  const base = options.fields ?? {}

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) return
    const record = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...base,
      ...redact(fields ?? {}),
    }
    try {
      sink.write(JSON.stringify(record))
    } catch {
      sink.write(JSON.stringify({ level: 'error', msg: 'a log record could not be written' }))
    }
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ level: options.level, sink, fields: { ...base, ...fields } }),
  }
}

/** A logger that writes nothing. */
export function silentLogger(): Logger {
  const noop = (): void => {}
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() }
}
