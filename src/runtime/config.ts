/**
 * The environment of the process (spec §14).
 *
 * The environment is read once, at the start of the process, and it is
 * validated as a whole: a value that cannot be understood stops the
 * service, because a setting that looks active but is not a security hole.
 *
 * The names of the variables never leave this module: the rest of the
 * service receives the settings it needs, not the environment. A secret is
 * read from a file, never from the command line, and it is never printed.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { DEFAULT_LEGACY_IDENTITY_MODE, type LegacyIdentityMode } from '../domains/gateway-context'

/** The environment the process runs in. */
export type Environment = 'development' | 'production'

/** The role of the process. */
export type ProcessRole = 'api' | 'worker' | 'all'

/** The settings of the listener. */
export interface NetworkSettings {
  readonly host: string
  readonly port: number
}

/** The settings of the PostgreSQL server. */
export interface DatabaseSettings {
  /** The url of the scoped data role. */
  readonly dataUrl: string
  /** The url of the narrow registry reader. */
  readonly registryUrl: string
  /** The url of the delivery metadata role. */
  readonly deliveryUrl: string
  /** The maximum number of scoped data connections. */
  readonly poolMax: number
  /** The maximum number of registry connections. */
  readonly registryPoolMax: number
  /** The maximum number of delivery connections. */
  readonly deliveryPoolMax: number
  /** How long a statement may run. */
  readonly statementTimeoutMs: number
  /** How long a transaction may run. */
  readonly transactionTimeoutMs: number
  /** How long a connection may be waited for. */
  readonly acquireTimeoutMs: number
}

/** The settings of the Hub access context contract. */
export interface HubSettings {
  /** The base url of Hub. */
  readonly url: string
  /** The service credential of the access context contract. */
  readonly credential: string
  /** How long a context request may take. */
  readonly timeoutMs: number
  /** The lifetime of the read only context cache, in milliseconds. */
  readonly contextCacheTtlMs: number
  /** The maximum number of the entries of the cache of the context. */
  readonly contextCacheMaxEntries: number
}

/** The settings of the trusted route bindings. */
export interface BindingSettings {
  /** The file that holds the bindings. */
  readonly file: string
  /**
   * What the service does with the legacy verification of the identity.
   *
   * The legacy format is symmetric: the backend holds the derived
   * secret of the gateway. It is a migration path, and it is removed
   * in the version `2.0.0` of the service.
   */
  readonly legacyIdentity: LegacyIdentityMode
}

/** The settings of the bundles of the deployment. */
export interface BundleSettings {
  /** The file that holds the collection manifests. */
  readonly schemaFile: string
  /** The file that holds the collection policies. */
  readonly policyFile: string
}

/** The settings of the worker. */
export interface WorkerSettings {
  /** The principal the worker acts as. */
  readonly principalId: string
  /** The route the worker acts on. */
  readonly routeId: string
  /** How many deliveries are handled at the same time. */
  readonly concurrency: number
}

/** The settings of the deadlines of the requests. */
export interface RequestSettings {
  /** The overall deadline of a request. */
  readonly timeoutMs: number
  /** The maximum size of a request body. */
  readonly maxBodyBytes: number
  /** The maximum number of requests that are handled at the same time. */
  readonly maxInFlightRequests: number
  /**
   * The maximum number of the requests of a tenant that run at the same
   * time.
   *
   * Zero disables the bound: every tenant may use the whole room of the
   * process.
   */
  readonly maxInFlightRequestsPerTenant: number
  /** The budget of the drain. */
  readonly drainMs: number
}

/** The settings of the observation. */
export interface ObservabilitySettings {
  /** The level of the log. */
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** The token that guards the metrics endpoint, when it is enabled. */
  readonly metricsToken?: string
}

/** Everything the process needs to start. */
export interface RuntimeSettings {
  readonly environment: Environment
  readonly production: boolean
  readonly role: ProcessRole
  readonly network: NetworkSettings
  readonly database: DatabaseSettings
  readonly hub: HubSettings
  readonly bindings: BindingSettings
  readonly bundles: BundleSettings
  readonly worker: WorkerSettings
  readonly requests: RequestSettings
  readonly observability: ObservabilitySettings
  /** The file that holds the key that signs the cursors. */
  readonly cursorKeyFile: string
}

/** The smallest size of a cursor key, in bytes. */
export const MINIMUM_CURSOR_KEY_BYTES = 32

/** The environment as a record of strings. */
export type Env = Record<string, string | undefined>

const EnvSchema = z.object({
  DATA_HOST: z.string().default('127.0.0.1'),
  DATA_PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
  DATA_PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  DATA_ENVIRONMENT: z.enum(['development', 'production']).default('development'),

  DATA_DATABASE_URL: z.string().optional(),
  DATA_REGISTRY_DATABASE_URL: z.string().optional(),
  DATA_DELIVERY_DATABASE_URL: z.string().optional(),

  DATA_SHUTTLE_BINDINGS_FILE: z.string().optional(),
  DATA_LEGACY_IDENTITY: z.enum(['refuse', 'warn', 'allow']).default(DEFAULT_LEGACY_IDENTITY_MODE),
  DATA_SCHEMA_BUNDLE_FILE: z.string().optional(),
  DATA_POLICY_BUNDLE_FILE: z.string().optional(),
  DATA_HUB_URL: z.string().optional(),
  DATA_HUB_CONTEXT_TOKEN_FILE: z.string().optional(),
  DATA_CURSOR_KEY_FILE: z.string().optional(),

  DATA_CONTEXT_CACHE_TTL_MS: z.coerce.number().int().min(0).max(5_000).default(0),
  DATA_CONTEXT_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(4096),
  DATA_HUB_TIMEOUT_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),

  DATA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
  DATA_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(3_000),
  DATA_DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  DATA_DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(10).max(600_000).default(1_000),
  DATA_DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  DATA_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(1_048_576),
  DATA_MAX_IN_FLIGHT_REQUESTS: z.coerce.number().int().min(1).max(10_000).default(200),
  DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT: z.coerce.number().int().min(1).max(10_000).optional(),
  DATA_DRAIN_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),

  DATA_WORKER_PRINCIPAL_ID: z.string().optional(),
  DATA_WORKER_ROUTE_ID: z.string().optional(),
  DATA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  DATA_METRICS_TOKEN_FILE: z.string().optional(),
  DATA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

/** Reports whether a value is an absolute http url. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Reads a secret from a file.
 *
 * The secret is never read from the command line: a command line is
 * visible in the process list of the machine.
 */
function readSecretFile(path: string, name: string, problems: string[]): string | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    problems.push(`${name} names a file that cannot be read: ${path}`)
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    problems.push(`${name} names a file that is empty: ${path}`)
    return undefined
  }
  return trimmed
}

/** Reports whether a database url points at a local host. */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === 'postgres'
  } catch {
    return false
  }
}

/**
 * Reads the environment.
 *
 * Every problem is reported at once: a deployment that fixes one variable
 * and restarts to learn about the next one is a deployment that stays down.
 */
export function readEnv(env: Env = process.env): RuntimeSettings {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'the environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`the environment is invalid: ${problems}`)
  }
  const values = parsed.data
  const production = values.DATA_ENVIRONMENT === 'production'
  const role = values.DATA_PROCESS_ROLE
  const problems: string[] = []

  const apiRuns = role === 'api' || role === 'all'
  const workerRuns = role === 'worker' || role === 'all'

  // The database of the business data.
  const dataUrl = values.DATA_DATABASE_URL
  if (!dataUrl) {
    problems.push('DATA_DATABASE_URL must be set: it names the scoped data credentials')
  } else if (!/^postgres(ql)?:\/\//i.test(dataUrl)) {
    problems.push('DATA_DATABASE_URL must name a PostgreSQL server (postgres://...)')
  } else if (production && !isLocalUrl(dataUrl) && !/sslmode=/.test(dataUrl)) {
    problems.push(
      'DATA_DATABASE_URL must ask for a protected transport (sslmode=require) in production'
    )
  }

  // The narrow registry reader. It is a separate credential: the role may
  // only read the identity of a workspace.
  const registryUrl = values.DATA_REGISTRY_DATABASE_URL
  if (!registryUrl) {
    problems.push('DATA_REGISTRY_DATABASE_URL must be set: it names the narrow registry reader')
  } else if (!/^postgres(ql)?:\/\//i.test(registryUrl)) {
    problems.push('DATA_REGISTRY_DATABASE_URL must name a PostgreSQL server (postgres://...)')
  } else if (production && !isLocalUrl(registryUrl) && !/sslmode=/.test(registryUrl)) {
    problems.push(
      'DATA_REGISTRY_DATABASE_URL must ask for a protected transport (sslmode=require) in production'
    )
  }

  // The delivery metadata role. It exists when workers run.
  const deliveryUrl = values.DATA_DELIVERY_DATABASE_URL
  if (workerRuns && !deliveryUrl) {
    problems.push('DATA_DELIVERY_DATABASE_URL must be set when workers run')
  }
  if (deliveryUrl && !/^postgres(ql)?:\/\//i.test(deliveryUrl)) {
    problems.push('DATA_DELIVERY_DATABASE_URL must name a PostgreSQL server (postgres://...)')
  }

  // The bundles of the deployment.
  const schemaFile = values.DATA_SCHEMA_BUNDLE_FILE
  if (!schemaFile) problems.push('DATA_SCHEMA_BUNDLE_FILE must be set: it names the manifests')
  const policyFile = values.DATA_POLICY_BUNDLE_FILE
  if (!policyFile) problems.push('DATA_POLICY_BUNDLE_FILE must be set: it names the policies')

  // The bindings of the gateway.
  const bindingsFile = values.DATA_SHUTTLE_BINDINGS_FILE
  if (apiRuns && !bindingsFile) {
    problems.push('DATA_SHUTTLE_BINDINGS_FILE must be set for an api process')
  }

  // The hub of the access context contract.
  const hubUrl = values.DATA_HUB_URL
  if (!hubUrl) {
    problems.push('DATA_HUB_URL must be set: it names the hub of the access context contract')
  } else if (!isHttpUrl(hubUrl)) {
    problems.push('DATA_HUB_URL must be an absolute http url')
  } else if (production && !hubUrl.startsWith('https://')) {
    problems.push(
      'DATA_HUB_URL must use https in production: the credential of the context travels with it'
    )
  }

  // The credential of the access context contract.
  let credential: string | undefined
  if (values.DATA_HUB_CONTEXT_TOKEN_FILE) {
    credential = readSecretFile(
      values.DATA_HUB_CONTEXT_TOKEN_FILE,
      'DATA_HUB_CONTEXT_TOKEN_FILE',
      problems
    )
  } else {
    problems.push('DATA_HUB_CONTEXT_TOKEN_FILE must be set: it names the access context credential')
  }

  // The key that signs the cursors.
  const cursorKeyFile = values.DATA_CURSOR_KEY_FILE
  if (!cursorKeyFile) {
    problems.push('DATA_CURSOR_KEY_FILE must be set: it names the key that signs the cursors')
  } else {
    const key = readSecretFile(cursorKeyFile, 'DATA_CURSOR_KEY_FILE', problems)
    if (key && Buffer.byteLength(key, 'utf8') < MINIMUM_CURSOR_KEY_BYTES) {
      problems.push(
        `DATA_CURSOR_KEY_FILE must hold at least ${MINIMUM_CURSOR_KEY_BYTES} bytes: it signs the cursors`
      )
    }
  }

  // The worker.
  let workerPrincipal: string | undefined
  let workerRoute: string | undefined
  if (workerRuns) {
    workerPrincipal = values.DATA_WORKER_PRINCIPAL_ID
    if (!workerPrincipal) {
      problems.push('DATA_WORKER_PRINCIPAL_ID must be set when workers run')
    }
    workerRoute = values.DATA_WORKER_ROUTE_ID
    if (!workerRoute) {
      problems.push('DATA_WORKER_ROUTE_ID must be set when workers run')
    }
  }

  // The metrics.
  let metricsToken: string | undefined
  if (values.DATA_METRICS_TOKEN_FILE) {
    metricsToken = readSecretFile(
      values.DATA_METRICS_TOKEN_FILE,
      'DATA_METRICS_TOKEN_FILE',
      problems
    )
  }

  // A development deployment may run without a worker, an api role may run
  // without the delivery credentials.
  if (problems.length > 0) {
    throw new Error(`the environment is invalid: ${problems.join('; ')}`)
  }

  return {
    environment: values.DATA_ENVIRONMENT,
    production,
    role,
    network: { host: values.DATA_HOST, port: values.DATA_PORT },
    database: {
      dataUrl: dataUrl!,
      registryUrl: registryUrl!,
      deliveryUrl: deliveryUrl ?? dataUrl!,
      poolMax: values.DATA_DB_POOL_MAX,
      registryPoolMax: 5,
      deliveryPoolMax: 5,
      statementTimeoutMs: values.DATA_DB_STATEMENT_TIMEOUT_MS,
      transactionTimeoutMs: values.DATA_DB_TRANSACTION_TIMEOUT_MS,
      acquireTimeoutMs: values.DATA_DB_ACQUIRE_TIMEOUT_MS,
    },
    hub: {
      url: hubUrl!.replace(/\/+$/, ''),
      credential: credential!,
      timeoutMs: values.DATA_HUB_TIMEOUT_MS,
      contextCacheTtlMs: values.DATA_CONTEXT_CACHE_TTL_MS,
      contextCacheMaxEntries: values.DATA_CONTEXT_CACHE_MAX_ENTRIES,
    },
    bindings: { file: bindingsFile ?? '', legacyIdentity: values.DATA_LEGACY_IDENTITY },
    bundles: { schemaFile: schemaFile!, policyFile: policyFile! },
    worker: {
      principalId: workerPrincipal ?? '',
      routeId: workerRoute ?? '',
      concurrency: values.DATA_WORKER_CONCURRENCY,
    },
    requests: {
      timeoutMs: values.DATA_REQUEST_TIMEOUT_MS,
      maxBodyBytes: values.DATA_MAX_BODY_BYTES,
      maxInFlightRequests: values.DATA_MAX_IN_FLIGHT_REQUESTS,
      // The bound of a tenant is the bound of the process until the
      // deployment declares another one: a deployment with one tenant
      // gives the whole room to its tenant.
      maxInFlightRequestsPerTenant:
        values.DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT ?? values.DATA_MAX_IN_FLIGHT_REQUESTS,
      drainMs: values.DATA_DRAIN_MS,
    },
    observability: {
      logLevel: values.DATA_LOG_LEVEL,
      ...(metricsToken ? { metricsToken } : {}),
    },
    cursorKeyFile: cursorKeyFile!,
  }
}
