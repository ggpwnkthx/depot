/**
 * The typed client of the headless data backend (spec §12).
 *
 * The client speaks the versioned HTTP API through the gateway. It does
 * not sign anything, it does not store a credential of the hub, it does
 * not run a login flow and it does not know anything about a studio.
 *
 * The caller supplies the transport and the credentials: the client
 * never invents them.
 */

/** The error of the API, as the client sees it. */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  /** The stable code of the error. */
  readonly code: string
  /** The status of the answer. */
  readonly status: number
  /** The details of the error. */
  readonly details: readonly { field: string; code: string }[]
  /** The correlation id of the request. */
  readonly requestId: string

  constructor(options: {
    code: string
    message: string
    status: number
    details?: readonly { field: string; code: string }[]
    requestId: string
  }) {
    super(options.message)
    this.code = options.code
    this.status = options.status
    this.details = options.details ?? []
    this.requestId = options.requestId
  }
}

/** The options of the client. */
export interface ClientOptions {
  /** The base url of the deployment, through the gateway. */
  baseUrl: string
  /** The workspace of the calls. */
  workspaceId: string
  /**
   * The transport of the caller.
   *
   * The credentials of the caller travel in the headers of this
   * transport: the client knows nothing about them.
   */
  fetch?: typeof globalThis.fetch
  /** The headers that every call carries, such as the session cookie. */
  headers?: Record<string, string>
  /** The signal that cancels the calls. */
  signal?: AbortSignal
}

/** A record of a collection. */
export type RecordValue = Record<string, unknown> & { id: string; version: number }

/**
 * The map of the collections of a deployment.
 *
 * The map is the type of the rows of every collection of a deployment:
 * the client reads the map as a type parameter, and the rows of a
 * collection are the rows of the map. A deployment that wants the types
 * of its own collections generates them with
 * `bun run scripts/generate-client.ts` and hands them to the client:
 *
 *   const client = new DataClient<Collections>({ baseUrl, workspaceId })
 *   const page = await client.list('articles')
 *
 * The client without a map is the client of the contract of v1: its rows
 * are `RecordValue`.
 */
export type CollectionMap = Record<string, unknown>

/** The options of a list. */
export interface ListOptions {
  /** The fields of the projection. */
  fields?: readonly string[]
  /** The filter of the query. */
  filter?: unknown
  /** The text of the search of the collection. */
  search?: string
  /** The sort of the query, `-name` for descending. */
  sort?: readonly string[]
  /** The size of the page, at most 200. */
  limit?: number
  /** The relations to expand. */
  include?: readonly string[]
  /** Whether the count is asked for. */
  includeCount?: boolean
}

/** A page of a list. */
export interface Page<T = RecordValue> {
  data: T[]
  meta: { limit: number; nextCursor: string | null; count?: number }
}

/** The options of an aggregate. */
export interface AggregateOptions {
  /** The fields the rows are grouped by. */
  groupBy?: readonly string[]
  /** The metrics of every group, `sum:amount` for a sum of an amount. */
  metrics?: readonly string[]
  /** The filter of the query. */
  filter?: unknown
  /** The text of the search of the collection. */
  search?: string
  /** The maximum number of the groups, at most 1000. */
  limit?: number
}

/** One group of an aggregate. */
export interface AggregateGroup {
  /** The values of the fields of the group. */
  group: Record<string, unknown>
  /** The number of the rows of the group. */
  count: number
  /** The sums of the fields, when a sum was asked. */
  sum?: Record<string, string | null>
  /** The averages of the fields, when an average was asked. */
  avg?: Record<string, string | null>
  /** The smallest values of the fields, when a minimum was asked. */
  min?: Record<string, unknown>
  /** The largest values of the fields, when a maximum was asked. */
  max?: Record<string, unknown>
}

/** The answer of an aggregate. */
export interface AggregateResult {
  data: AggregateGroup[]
  meta: { limit: number; groups: number; truncated: boolean }
}

/** The metadata of a collection. */
export interface CollectionMetadata {
  key: string
  label: string
  schemaVersion: string
  actions: readonly string[]
  readableFields: readonly string[]
  writableFields: readonly string[]
  filterableFields: readonly string[]
  fields: readonly { name: string; type: string; required: boolean; nullable: boolean }[]
  relations: readonly { name: string; target: string; type: string }[]
}

/** The receipt of a creation. */
export interface Receipt {
  id: string
  version: number
}

/**
 * The client of the API.
 *
 * The map of the collections is a type parameter: the client of a
 * deployment that declares its collections answers with the rows of
 * those collections, and the client of a deployment that declares
 * nothing answers with the rows of the contract.
 */
export class DataClient<M extends CollectionMap = Record<string, RecordValue>> {
  readonly #options: ClientOptions

  constructor(options: ClientOptions) {
    this.#options = options
  }

  /** The transport of the client. */
  get #fetch(): typeof globalThis.fetch {
    return this.#options.fetch ?? globalThis.fetch
  }

  /** The prefix of the calls. */
  get #prefix(): string {
    const base = this.#options.baseUrl.replace(/\/+$/, '')
    return `${base}/ws/${this.#options.workspaceId}/v1`
  }

  /** Sends a request to the API. */
  async #call<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
    } = {}
  ): Promise<{ body: T; status: number; headers: Headers }> {
    const headers = new Headers({
      accept: 'application/json',
      ...(this.#options.headers ?? {}),
      ...(options.headers ?? {}),
    })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    const response = await this.#fetch(`${this.#prefix}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(this.#options.signal ? { signal: this.#options.signal } : {}),
    })
    const text = await response.text()
    let body: unknown = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    if (!response.ok) {
      const envelope = (body ?? {}) as {
        error?: { code?: string; message?: string; details?: { field: string; code: string }[] }
        requestId?: string
      }
      throw new ApiError({
        code: envelope.error?.code ?? 'UNKNOWN',
        message: envelope.error?.message ?? 'the request failed',
        status: response.status,
        details: envelope.error?.details ?? [],
        requestId: envelope.requestId ?? 'unknown',
      })
    }
    return { body: body as T, status: response.status, headers: response.headers }
  }

  /** The identity of the caller. */
  async me(): Promise<{
    principalId: string
    tenantId: string
    workspaceId: string
    routeId: string
    apiVersion: string
  }> {
    const answer = await this.#call<{ data: Record<string, unknown> }>('/me')
    return answer.body.data as never
  }

  /** The metadata of the collections. */
  async schema(): Promise<{
    apiVersion: string
    schemaVersion: string
    policyBundleVersion: string
    collections: readonly CollectionMetadata[]
  }> {
    const answer = await this.#call<{ data: Record<string, unknown> }>('/schema')
    return answer.body.data as never
  }

  /** The metadata of one collection. */
  async collection(key: string): Promise<CollectionMetadata> {
    const answer = await this.#call<{ data: CollectionMetadata }>(`/schema/${key}`)
    return answer.body.data
  }

  /** A page of a collection. */
  async list<K extends keyof M & string>(
    key: K,
    options: ListOptions & { cursor?: string } = {}
  ): Promise<Page<M[K]>> {
    const query = new URLSearchParams()
    if (options.fields) query.set('fields', options.fields.join(','))
    if (options.filter !== undefined) query.set('filter', JSON.stringify(options.filter))
    if (options.search !== undefined) query.set('search', options.search)
    if (options.sort) query.set('sort', options.sort.join(','))
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.include) query.set('include', options.include.join(','))
    if (options.includeCount) query.set('include_count', 'true')
    const suffix = query.toString()
    const answer = await this.#call<{ data: M[K][]; meta: Page<M[K]>['meta'] }>(
      `/items/${key}${suffix ? `?${suffix}` : ''}`
    )
    return { data: answer.body.data, meta: answer.body.meta }
  }

  /**
   * Every page of a collection.
   *
   * The pages are read one after the other with the cursor of the
   * previous one: the traversal is bounded by the caller, which stops it.
   */
  async *listAll<K extends keyof M & string>(
    key: K,
    options: ListOptions = {}
  ): AsyncGenerator<M[K][], void, void> {
    let cursor: string | undefined
    do {
      const page = await this.list(key, { ...options, ...(cursor ? { cursor } : {}) })
      yield page.data
      cursor = page.meta.nextCursor ?? undefined
    } while (cursor)
  }

  /**
   * The groups of an aggregate.
   *
   * The metrics are the names of the functions and of the fields:
   * `sum:amount`. The count of the rows is always part of the answer.
   */
  async aggregate(key: string, options: AggregateOptions = {}): Promise<AggregateResult> {
    const query = new URLSearchParams()
    if (options.groupBy) query.set('group_by', options.groupBy.join(','))
    if (options.metrics) query.set('metrics', options.metrics.join(','))
    if (options.filter !== undefined) query.set('filter', JSON.stringify(options.filter))
    if (options.search !== undefined) query.set('search', options.search)
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    const suffix = query.toString()
    const answer = await this.#call<{ data: AggregateGroup[]; meta: AggregateResult['meta'] }>(
      `/aggregate/${key}${suffix ? `?${suffix}` : ''}`
    )
    return { data: answer.body.data, meta: answer.body.meta }
  }

  /** One record. */
  async get<K extends keyof M & string>(key: K, id: string): Promise<M[K]> {
    const answer = await this.#call<{ data: M[K] }>(`/items/${key}/${id}`)
    return answer.body.data
  }

  /** The validator of a record. */
  async getWithValidator<K extends keyof M & string>(
    key: K,
    id: string
  ): Promise<{ record: M[K]; etag: string }> {
    const answer = await this.#call<{ data: M[K] }>(`/items/${key}/${id}`)
    const etag = answer.headers.get('etag')
    if (!etag) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'the answer does not carry a validator',
        status: 500,
        requestId: 'unknown',
      })
    }
    return { record: answer.body.data, etag }
  }

  /** Creates a record. */
  async create<K extends keyof M & string>(
    key: K,
    body: Partial<M[K]> & Record<string, unknown>,
    options: { idempotencyKey: string }
  ): Promise<Receipt> {
    const answer = await this.#call<{ data: Receipt }>(`/items/${key}`, {
      method: 'POST',
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
    })
    return answer.body.data
  }

  /** Updates a record. */
  async update<K extends keyof M & string>(
    key: K,
    id: string,
    body: Partial<M[K]> & Record<string, unknown>,
    options: { etag: string }
  ): Promise<{ record: M[K]; etag: string }> {
    const answer = await this.#call<{ data: M[K] }>(`/items/${key}/${id}`, {
      method: 'PATCH',
      body,
      headers: { 'if-match': options.etag },
    })
    const etag = answer.headers.get('etag') ?? ''
    return { record: answer.body.data, etag }
  }

  /** Deletes a record. */
  async remove<K extends keyof M & string>(
    key: K,
    id: string,
    options: { etag: string }
  ): Promise<void> {
    await this.#call(`/items/${key}/${id}`, {
      method: 'DELETE',
      headers: { 'if-match': options.etag },
    })
  }

  /** A page of the audit log. */
  async audit(options: { limit?: number; cursor?: string } = {}): Promise<{
    data: readonly Record<string, unknown>[]
    meta: { limit: number; nextCursor: string | null }
  }> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor) query.set('cursor', options.cursor)
    const suffix = query.toString()
    const answer = await this.#call<{
      data: Record<string, unknown>[]
      meta: { limit: number; nextCursor: string | null }
    }>(`/audit${suffix ? `?${suffix}` : ''}`)
    return answer.body
  }
}
