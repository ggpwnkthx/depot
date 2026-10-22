# The capacity of the service

The numbers of this report were measured by `bun run scripts/capacity.ts`
on the machine that is described below. They are **not** a promise about
another machine: a deployment declares its own request rate and its own
latency objective, and it measures them with the same command on its
own hardware.

## The method

The command starts a complete deployment of the development machine: a
PostgreSQL server, a hub of the fixtures, the backend and a load of
concurrent clients. The clients speak the protocol of the gateway: they
sign their requests with the private key of the pair of the identity,
exactly like the pinned gateway does, and the backend verifies them
with the public one.

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
| The context cache | `DATA_CONTEXT_CACHE_TTL_MS=0`: every request asks Hub |
| The catalog | the workspace registered nothing: the catalog of the deployment is read with the registry of the workspaces, in one statement |
| The data | 1000 articles of one workspace, one policy per action, the read of a page of 50 |

The database is on the same machine and it does not fsync: these are the
numbers of a development machine, and a deployment measures its own.

## The results

The numbers below are the ones of the release candidate of the version
`1.0.0`, measured on the machine that is described above, with the
guarded write path of the version `1.0.0`.

| Scenario | The requests | The rate | p50 | p95 | p99 | The failures |
| --- | --- | --- | --- | --- | --- | --- |
| Read heavy, a page of 50 | 16589 | 1659/s | 9.4 ms | 11.8 ms | 13.4 ms | 0 |
| Mixed, half of the creations | 21127 | 2113/s | 7.4 ms | 9.8 ms | 11.2 ms | 0 |
| The concurrent updates of one record | 6218 | 622/s | 25.7 ms | 30.2 ms | 33.2 ms | 0 (389 successes, 5829 precondition failures) |
| Hub is down | 62091 | 6209/s | 2.5 ms | 3.3 ms | 4.8 ms | 62091 answers 503 |

What the numbers say:

- **The read path holds.** A page of fifty records is read in nine
  milliseconds at the fiftieth percentile, with the context of Hub asked
  for every time. Hub is the dependency of every request, and it is not
  on the critical path of the read of the records: the context is
  fetched before the statement, and the statement is the cheap part.
- **The writes cost more than the reads.** A creation writes the
  record, the audit entry, the event and the receipt, in one
  transaction. The mixed scenario is slower at the ninety fifth
  percentile than the read heavy one, and it is the writes that pay.
- **The optimistic concurrency works.** The concurrent updates of one
  record answer `412 PRECONDITION_FAILED` for every update that does not
  hold the current validator: one version change and one refusal per
  attempt, and no lost update. The latency of the scenario is the
  latency of the lock of the row.
- **The service fails closed and fast.** When Hub is down, every request
  answers `503 AUTHORIZATION_UNAVAILABLE` in two milliseconds: the
  service does not queue the work, and it does not serve a context it
  cannot prove. The rate of the refusals is the rate of the failures of
  the dependency.

**The numbers of the version 0.2.0** were 991/s, 1251/s, 313/s and
4280/s, with a fiftieth percentile of 15.8 ms, 11.6 ms, 50.8 ms and
3.6 ms. The two measurements are not comparable: they are two runs on
a shared machine, and the numbers of a development machine are the
numbers of that machine and of that moment. The report is a
measurement, and not a promise.

## The shape of the statements at scale

The report above measures the latency of the service on a small table.
The shape of the statements is another question, and the command
`bun run scripts/scale.ts` measures it: it writes a collection of a
million rows, it reads the plan of the database for the statement of a
page, and it walks every page of the collection and compares the rows
with the rows of one statement.

The statement of a read is in two parts. The first one reads the page:
the identifiers of the rows, the order and the limit. The second one
builds the payload of the rows of the page — and the payload is built
by the statement, because a value the caller may not see must never
leave the database (see [the decisions](decisions.md) §2).

The order of the service is the order of the nulls last, in the two
directions. The database writes it as `col asc nulls last`, and that is
the order of an index: the page is read with the index of the scope and
without a sort.

| The collection | The plan before | The plan now | The time of the page |
| --- | --- | --- | --- |
| 200 000 rows | sequential scan, sort of the whole scope, projection of every row | index scan of the page, 51 lookups | 97 ms → 0.9 ms |
| 1 000 000 rows | the same, three times the rows | the same plan | 0.9 ms |

The pagination of the service was walked over a collection of 200 000
rows: 4 000 pages, and every row of the collection, in the order of the
database.

**A deployment declares the indexes of its collections.** The page is
read with the index of the scope of the workspace, and a sort on a field
needs the index of that field in the reviewed migration of the
collection. A descending sort needs an index that is declared
`desc nulls last`: the default index of a column is `asc nulls first`
for the descending direction, and the order of the service is the order
of the nulls last.

## What is not measured here

- **The replicas.** The measurement runs one api process. A deployment
  with several replicas scales the reads with the number of the
  replicas, and it scales the writes with the database.
- **The worker.** The claims of the deliveries, the leases and the
  retries are checked by the integration tests, and their capacity is
  measured with the metrics of the outbox: `data_outbox_backlog` and
  `data_outbox_oldest_age_seconds`.
- **The slow statements.** The measurement uses a small table. The
  shape of the statements at scale is measured by
  `bun run scripts/scale.ts`, and the indexes of the filters of a
  collection belong to the reviewed migration of the collection.
- **The maximum of the bounds.** The scenarios do not use a page of 200
  records, a filter of fifty predicates or an expansion of a thousand
  rows. The bounds are checked by the contract tests, and the answer of
  the service refuses them with `422 RESULT_TOO_LARGE`.

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

### The declaration of the reference deployment

The deployment of this repository is the reference, and it declares:

| | The declaration |
| --- | --- |
| The rate of the requests | 1 000 requests per second, with the context of Hub asked for every request |
| The objective of the latency | the ninety fifth percentile under 25 milliseconds for a page of fifty records, and under 50 milliseconds for a write |
| The shape of the data | 1 000 records of one workspace, a page of fifty, a filter of ten predicates |
| The complexity of the policies | one policy per action, five fields of a policy |
| The settings of the pool | `DATA_DB_POOL_MAX=20`, and the pools of the registry and of the deliveries of five |
| The replicas | one api process and one worker, on the machine of the measurement |
| The availability | `DATA_CONTEXT_CACHE_TTL_MS=0`: the revocation of a grant is visible in the next request, and a Hub that is down answers `503` to every call |

The objectives are the ones of the measurement above, with a margin of
a half: the measurement reached 1 659 requests per second on the read
heavy scenario and 2 113 on the mixed one, and the ninety fifth
percentile was 11.8 and 9.8 milliseconds. A deployment that declares
more than its machine holds is a deployment that answers `503` when it
is full, and the service is measured with the command of the
repository, not with a promise.

The bound of the revocation of a grant is the lifetime of the cache of
the context plus the duration of the request that is running: with the
default of no cache, it is the duration of the request.
