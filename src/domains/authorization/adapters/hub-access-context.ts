/**
 * The client of the access context contract (spec §5).
 *
 * The adapter speaks the contract of Hub over the transport of the
 * runtime. It uses the service credential of the deployment and it never
 * sends anything else: the credential authorizes the context and nothing
 * else.
 */

import { ServiceError } from '../../../protocol/errors'
import {
  type AccessContext,
  type AccessContextClient,
  type AccessContextDiscovery,
  type AccessContextRequest,
  MAX_CONTEXT_BODY_BYTES,
} from '../access-context'

/** The options of the client. */
export interface HubClientOptions {
  /** The base url of Hub. */
  readonly baseUrl: string
  /** The service credential of the access context contract. */
  readonly credential: string
  /** The budget of a request, in milliseconds. */
  readonly timeoutMs: number
  /** The transport of the runtime. */
  readonly fetch?: typeof globalThis.fetch
}

/** The failure of the dependency. */
function unavailable(reason: string): never {
  throw new ServiceError('AUTHORIZATION_UNAVAILABLE', {
    message: `the authorization service is not available: ${reason}`,
  })
}

/** The client of the access context contract. */
export class HubAccessContextClient implements AccessContextClient {
  readonly #options: HubClientOptions

  constructor(options: HubClientOptions) {
    this.#options = options
  }

  /** The transport of the client. */
  get #fetch(): typeof globalThis.fetch {
    return this.#options.fetch ?? globalThis.fetch
  }

  /** Reads the discovery of the contract. */
  async discover(): Promise<AccessContextDiscovery> {
    const response = await this.#request('GET', '/v1/access-context')
    const body = await this.#body(response)
    if (!response.ok) {
      unavailable(`the discovery answered with the status ${response.status}`)
    }
    return body as unknown as AccessContextDiscovery
  }

  /** Reads the context of a principal. */
  async evaluate(request: AccessContextRequest): Promise<AccessContext> {
    const response = await this.#request('POST', '/v1/access-context', {
      version: 1,
      subject: request.subject,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      routeId: request.routeId,
    })
    const body = await this.#body(response)
    if (!response.ok) {
      unavailable(`the context answered with the status ${response.status}`)
    }
    return body as unknown as AccessContext
  }

  /** Sends a request to Hub. */
  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs)
    timer.unref?.()
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#options.credential}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      return response
    } catch (error) {
      unavailable(error instanceof Error ? error.message : 'the request failed')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Reads the body of an answer, with its budget. */
  async #body(response: Response): Promise<unknown> {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_BODY_BYTES) {
      unavailable('the answer is larger than the contract allows')
    }
    try {
      return JSON.parse(text)
    } catch {
      unavailable('the answer is not json')
    }
  }
}
