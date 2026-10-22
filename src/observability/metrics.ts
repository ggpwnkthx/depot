/**
 * The metrics of the service (spec §15.1).
 *
 * The metrics are a small Prometheus text exposition. The labels are
 * bounded: a tenant, a principal, a workspace, a record id, a raw url, an
 * e-mail address and a query never become a label, because a label that
 * carries a value grows without a bound.
 */

/** The kind of a counter. */
export type MetricKind = 'counter' | 'gauge' | 'histogram'

/** The buckets of the histograms, in milliseconds. */
const DEFAULT_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000]

interface MetricDefinition {
  name: string
  kind: MetricKind
  help: string
  buckets?: number[]
}

/** A value of a metric with its labels. */
interface Sample {
  labels: Record<string, string>
  value: number
  count?: number
  sum?: number
  /** The cumulative count of the observations of every bucket. */
  buckets?: number[]
}

/** The registry of the metrics. */
export class Metrics {
  readonly #definitions = new Map<string, MetricDefinition>()
  readonly #samples = new Map<string, Sample>()

  constructor(definitions: MetricDefinition[] = []) {
    for (const definition of definitions) this.#definitions.set(definition.name, definition)
  }

  /** Declares a metric. */
  define(definition: MetricDefinition): void {
    this.#definitions.set(definition.name, definition)
  }

  #key(name: string, labels: Record<string, string>): string {
    const parts = Object.keys(labels)
      .sort()
      .map((label) => `${label}="${labels[label]?.replace(/"/g, '') ?? ''}"`)
    return parts.length === 0 ? name : `${name}{${parts.join(',')}}`
  }

  #sample(name: string, labels: Record<string, string>): Sample {
    const key = this.#key(name, labels)
    let sample = this.#samples.get(key)
    if (!sample) {
      sample = { labels, value: 0, count: 0, sum: 0, buckets: [] }
      this.#samples.set(key, sample)
    }
    return sample
  }

  /** Adds a value to a counter. */
  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const sample = this.#sample(name, labels)
    sample.value += by
  }

  /** Sets the value of a gauge. */
  set(name: string, value: number, labels: Record<string, string> = {}): void {
    this.#sample(name, labels).value = value
  }

  /** Records a duration in a histogram. */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const sample = this.#sample(name, labels)
    sample.count = (sample.count ?? 0) + 1
    sample.sum = (sample.sum ?? 0) + value
    // The buckets are cumulative: an observation belongs to every bucket
    // whose bound is greater than or equal to its value, and to none of
    // the others. The count of a bucket is the count of the observations
    // that are less than or equal to its bound.
    const bounds = this.#definitions.get(name)?.buckets ?? DEFAULT_BUCKETS
    const buckets = sample.buckets ?? new Array<number>(bounds.length).fill(0)
    if (buckets.length !== bounds.length) {
      buckets.length = bounds.length
      buckets.fill(0)
    }
    sample.buckets = buckets
    for (let index = 0; index < bounds.length; index += 1) {
      if (value <= (bounds[index] as number)) buckets[index] = (buckets[index] ?? 0) + 1
    }
  }

  /** Renders the metrics in the Prometheus text format. */
  render(): string {
    const lines: string[] = []
    for (const definition of this.#definitions.values()) {
      const samples = [...this.#samples.entries()].filter(
        ([key]) => key === definition.name || key.startsWith(`${definition.name}{`)
      )
      if (samples.length === 0) continue
      lines.push(`# HELP ${definition.name} ${definition.help}`)
      lines.push(`# TYPE ${definition.name} ${definition.kind}`)
      for (const [, sample] of samples) {
        if (definition.kind === 'histogram') {
          const buckets = definition.buckets ?? DEFAULT_BUCKETS
          const observations = sample.count ?? 0
          for (let index = 0; index < buckets.length; index += 1) {
            lines.push(
              `${this.#key(definition.name, sample.labels)}_bucket{le="${buckets[index]}"} ${
                sample.buckets?.[index] ?? 0
              }`
            )
          }
          lines.push(
            `${this.#key(definition.name, sample.labels)}_bucket{le="+Inf"} ${observations}`
          )
          lines.push(`${this.#key(definition.name, sample.labels)}_sum ${sample.sum ?? 0}`)
          lines.push(`${this.#key(definition.name, sample.labels)}_count ${observations}`)
          continue
        }
        lines.push(`${this.#key(definition.name, sample.labels)} ${sample.value}`)
      }
    }
    return `${lines.join('\n')}\n`
  }
}

/** The metrics of the service. */
export function createMetrics(): Metrics {
  return new Metrics([
    { name: 'data_requests_total', kind: 'counter', help: 'The requests of the service.' },
    { name: 'data_request_duration_ms', kind: 'histogram', help: 'The duration of the requests.' },
    { name: 'data_hub_requests_total', kind: 'counter', help: 'The requests to the hub.' },
    { name: 'data_hub_duration_ms', kind: 'histogram', help: 'The duration of the hub requests.' },
    {
      name: 'data_context_cache_hits_total',
      kind: 'counter',
      help: 'The hits of the context cache.',
    },
    {
      name: 'data_context_cache_misses_total',
      kind: 'counter',
      help: 'The misses of the context cache.',
    },
    { name: 'data_db_pool_waits_total', kind: 'counter', help: 'The waits for a connection.' },
    { name: 'data_db_acquire_duration_ms', kind: 'histogram', help: 'The wait for a connection.' },
    {
      name: 'data_authorization_denials_total',
      kind: 'counter',
      help: 'The denials of the authorization.',
    },
    {
      name: 'data_transaction_rollbacks_total',
      kind: 'counter',
      help: 'The rolled back transactions.',
    },
    { name: 'data_outbox_backlog', kind: 'gauge', help: 'The deliveries that are not finished.' },
    {
      name: 'data_outbox_oldest_age_seconds',
      kind: 'gauge',
      help: 'The age of the oldest delivery.',
    },
    { name: 'data_delivery_failures_total', kind: 'counter', help: 'The failed deliveries.' },
    { name: 'data_delivery_retries_total', kind: 'counter', help: 'The retried deliveries.' },
    { name: 'data_draining', kind: 'gauge', help: '1 when the process drains.' },
    { name: 'data_in_flight_requests', kind: 'gauge', help: 'The requests that are handled.' },
    {
      name: 'data_tenant_overload_total',
      kind: 'counter',
      help: 'The requests that were refused because their tenant held its whole room.',
    },
  ])
}
