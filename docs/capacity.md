# The capacity of the service

The numbers of this report were measured by `bun run scripts/capacity.ts`
on the machine that is described below. They are **not** a promise about
another machine: a deployment declares its own request rate and its own
latency objective, and it measures them with the same command on its own
hardware.

## The method

The command starts a complete deployment of the development machine: a
PostgreSQL server, a hub of the fixtures, the backend and a load of
concurrent clients. The clients speak the protocol of the gateway: they
sign their requests with the derived identity key, exactly like the
pinned gateway does.

```bash
bun run scripts/capacity.ts
```

The scenarios are the ones of the specification: a read heavy access
without a cache of the context, a mixed traffic of creations and of
reads, the concurrent updates of one record, and the failure of the
authorization dependency.

The knobs are the environment:

| Variable | Default | What it changes |
| --- | --- | --- |
| `CAPACITY_CLIENTS` | 16 | The number of the concurrent clients. |
| `CAPACITY_DURATION_MS` | 10000 | The duration of every scenario. |

## The machine of the measurement

| | |
| --- | --- |
| The processor | 16 cores, x86_64 |
| The memory | 31 gibibytes |
| The kernel | Linux 7.2.9 |
| The runtime | Bun 1.4.3 |
| The database | PostgreSQL 15.19, on the same machine, `fsync=off` and `synchronous_commit=off` |
| The deployment | one api process, `DATA_DB_POOL_MAX=20`, the registry and the delivery pools of 5 |
| The context cache | `DATA_CONTEXT_CACHE_TTL_MS=0`: every request asks the hub |
| The data | 1000 articles of one workspace, one policy per action, the read of a page of 50 |

The database is on the same machine and it does not fsync: these are the
numbers of a development machine, and a deployment measures its own.

## The results

| Scenario | The requests | The rate | p50 | p95 | p99 | The failures |
| --- | --- | --- | --- | --- | --- | --- |
| Read heavy, a page of 50 | 14375 | 1438/s | 10.8 ms | 14.7 ms | 18.8 ms | 0 |
| Mixed, half of the creations | 18692 | 1869/s | 6.3 ms | 21.4 ms | 27.1 ms | 0 |
| The concurrent updates of one record | 2898 | 290/s | 54.6 ms | 66.0 ms | 75.9 ms | 0 (265 successes, 2633 precondition failures) |
| The hub is down | 70163 | 7016/s | 2.2 ms | 3.0 ms | 4.3 ms | 70163 answers 503 |

What the numbers say:

- **The read path holds.** A page of fifty records is read in ten
  milliseconds at the fiftieth percentile, with the context of the hub
  asked for every time. The hub is the dependency of every request and
  it is not on the critical path of the read of the records: the
  context is fetched before the statement, and the statement is the
  cheap part.
- **The writes cost more than the reads.** A creation writes the
  record, the audit entry, the event and the receipt, in one
  transaction. The mixed scenario is slower at the ninety fifth
  percentile than the read heavy one, and it is the writes that pay.
- **The optimistic concurrency works.** The concurrent updates of one
  record answer `412 PRECONDITION_FAILED` for every update that does not
  hold the current validator: one version change and one refusal per
  attempt, and no lost update. The latency of the scenario is the
  latency of the lock of the row.
- **The service fails closed and fast.** When the hub is down, every
  request answers `503 AUTHORIZATION_UNAVAILABLE` in two milliseconds:
  the service does not queue the work and it does not serve a context
  it cannot prove. The rate of the refusals is the rate of the failures
  of the dependency.

## What is not measured here

- **The replicas.** The measurement runs one api process. A deployment
  with several replicas scales the reads with the number of the
  replicas, and it scales the writes with the database.
- **The worker.** The claims of the deliveries, the leases and the
  retries are proved by the integration tests, and their capacity is
  measured with the metrics of the outbox: `data_outbox_backlog` and
  `data_outbox_oldest_age_seconds`.
- **The slow statements.** The measurement uses a small table. A
  collection with millions of rows needs the indexes of its own filters,
  and the indexes of a filter belong to the reviewed migration of the
  collection.
- **The maximum of the bounds.** The scenarios do not use a page of
  200 records, a filter of fifty predicates or an expansion of a
  thousand rows. The bounds are proved by the contract tests, and the
  answer of the service refuses them with `422 RESULT_TOO_LARGE`.

## The declaration of a deployment

A deployment declares:

| | |
| --- | --- |
| The rate of the requests | the number of the requests per second that it accepts |
| The objective of the latency | the percentile that it holds, and the number |
| The shape of the data | the number of the records, the size of the page, the number of the predicates of a filter |
| The complexity of the policies | the number of the policies of a collection, the number of the fields of a policy |
| The settings of the pool | `DATA_DB_POOL_MAX` and the size of the database |
| The replicas | the number of the api processes and the number of the workers |

And it measures them with the same command, on its own hardware, and it
publishes the result the way this document publishes the one above.
