# The operations of the service

## The probes

| Endpoint | The contract |
| --- | --- |
| `GET /healthz` | `200` while the process is alive. It calls no dependency. The answer carries the version of the service (`version`) and the version of the manifest of the deployment (`schemaVersion`). |
| `GET /readyz` | `200` only when the configuration, the schema, the privileges of the role and the discovery of Hub are in order. `503` with a safe reason otherwise. |
| `GET /metrics` | The metrics of the service. `404` when the endpoint is disabled, `401` when the bearer token is missing or wrong. |

The probes are not routed through the authorization of a workspace: a
probe of an operator is not a caller of a tenant.

The readiness of the api checks:

1. the role of the connection is not a superuser and does not have
   `BYPASSRLS`,
2. the applied migrations are the ones of the repository, with the same
   checksums,
3. the discovery of Hub spoke the version of the access context contract
   in the last ten seconds.

The readiness of a worker checks the delivery store as well, and it
refuses to be ready without a registered subscriber.

## The metrics

The endpoint answers the Prometheus text format. The labels are
bounded: the route is a pattern, the method and the status are short,
and a tenant, a principal, a workspace, a record identifier, a url, an
e-mail address and a query never become a label.

| Metric | What it counts |
| --- | --- |
| `data_requests_total` | The requests, by route, method and status. |
| `data_request_duration_ms` | The duration of the requests. |
| `data_hub_requests_total`, `data_hub_duration_ms` | The calls to Hub. |
| `data_context_cache_hits_total`, `data_context_cache_misses_total` | The cache of the context. |
| `data_db_pool_waits_total`, `data_db_acquire_duration_ms` | The waits for a connection. |
| `data_authorization_denials_total` | The refusals of the authorization. |
| `data_transaction_rollbacks_total` | The rolled back transactions. |
| `data_outbox_backlog`, `data_outbox_oldest_age_seconds` | The deliveries that are not finished, and the age of the oldest. |
| `data_delivery_failures_total`, `data_delivery_retries_total` | The failed and the retried deliveries. |
| `data_draining` | `1` while the process drains. |
| `data_in_flight_requests` | The requests that are handled. |
| `data_tenant_overload_total` | The requests that were refused because their tenant held its whole room. |

The backlog and the age of the oldest delivery are the capacity of the
outbox. A backlog that grows is a subscriber that does not keep up, and
the retention of the completed events is bounded by seven days: a
backlog that lasts longer than that is a deployment that needs more
workers.

The calls to Hub carry three labels: the method, the path of the
contract and the outcome (`ok`, `refused` or `failed`). The hits and
the misses of the cache of the context carry no label: the cache is
keyed by the scope of the credential, the principal, the tenant, the
workspace and the route, and none of them may become a label.

The buckets of the histograms are cumulative: the count of a bucket is
the count of the observations that are less than or equal to its bound.

## The image

The image of the service is built from the `Dockerfile` of the
repository:

```bash
docker build --tag depot:0.2.0 .
```

It holds the runtime, the source, the manifests, the migrations and the
operator commands, and it holds no secret: the credentials of the
database, of Hub and of the signature of the gateway are files that
the deployment mounts, and the process reads them when it starts. It
runs as a user that is not `root`, and the base image is pinned by
digest.

The stack of the development machine — the database, the roles of the
separation, the migrations and the service — is a compose file:

```bash
docker compose up --build
```

The compose file runs the api only. The worker claims the deliveries of
the events, and it needs a principal that Hub knows:

```
DATA_PROCESS_ROLE=all
DATA_WORKER_PRINCIPAL_ID=<the uuid of the principal of the worker>
DATA_WORKER_ROUTE_ID=data-worker
```

The gateway and Hub are not part of the compose file: they are the
services of the platform, and the compatibility harness runs the three
of them together against the pinned revisions.

## The logs

The log is a stream of JSON objects on the standard output. Every record
carries the level, the time, the message and the fields of the caller.

The fields that carry a secret, a credential, a cookie, a signature, a
body, a filter or an e-mail address are redacted before the record is
written. The redaction works on the names of the fields, so a caller
that renames a field does not leak it: the callers of the service never
pass one.

The refusals of the authorization are observable: the code of the error
is in the log and the reason of Hub is not. The reason of a refusal
belongs to the operator, not to the caller.

## The drain

On `SIGTERM` or `SIGINT` the process:

1. becomes unready and stops admitting the requests: the new requests
   answer `503 DRAINING`,
2. lets the requests that are running finish, with a budget of thirty
   seconds (`DATA_DRAIN_MS`),
3. stops the workers and releases the leases of the deliveries that were
   not finished, so that another worker claims them,
4. closes the listener and the pools, exactly once.

A connection whose transaction was aborted, or whose state is unknown,
is destroyed: it never returns to the pool. A mutation that was
committed before the disconnect stays committed, and the receipt of the
creation resolves the ambiguous result of a `POST`.

## The budgets

| Setting | Default | What it bounds |
| --- | --- | --- |
| `DATA_REQUEST_TIMEOUT_MS` | 10000 | The whole work of a request. |
| `DATA_HUB_TIMEOUT_MS` | 1000 | A call to Hub. |
| `DATA_DB_STATEMENT_TIMEOUT_MS` | 3000 | A statement. The server cancels it. |
| `DATA_DB_TRANSACTION_TIMEOUT_MS` | 5000 | A transaction. The connection is destroyed when the budget is spent. |
| `DATA_DB_ACQUIRE_TIMEOUT_MS` | 1000 | The wait for a connection. |
| `DATA_MAX_IN_FLIGHT_REQUESTS` | 200 | The requests that are handled at the same time. |
| `DATA_MAX_BODY_BYTES` | 1048576 | The body of a request. The body of a record is 256 KiB. |
| `DATA_DB_POOL_MAX` | 20 | The connections of the process. |

The effective timeout of a request is the smallest of the budgets that
apply to it. A timer that leaves a statement running is not a
cancellation: the statement timeout is a server side cancellation, and
the transaction timeout destroys the connection, so the server rolls the
transaction back.

The variables and their bounds are in [the configuration](configuration.md).

## The catalog of the workspaces

The catalog of a workspace is what it serves: the collections it
registered and the bundle of policies that applies to it. Both are
changed with the commands of the operator, with the credentials of the
owner of the schema:

```bash
# The collections a workspace serves.
DATA_OWNER_DATABASE_URL=... bun run collection -- register \
  --workspace 22222222-2222-4222-8222-222222222222 --collection articles
DATA_OWNER_DATABASE_URL=... bun run collection -- list \
  --workspace 22222222-2222-4222-8222-222222222222

# The bundle of policies of a workspace.
DATA_OWNER_DATABASE_URL=... bun run policy -- publish \
  --workspace 22222222-2222-4222-8222-222222222222 --file policies.json
DATA_OWNER_DATABASE_URL=... bun run policy -- list \
  --workspace 22222222-2222-4222-8222-222222222222
```

The commands never create a table and never alter one: the tables of
the collections come from the reviewed migrations of the deployment.
The registration of a collection and the publication of a bundle are
local administrative entry points, and they are not HTTP routes that
bypass Hub: a bundle says what a permission grants, and the grants of a
principal are the business of Hub.

A bundle is validated against the manifest of the deployment before it
is published, and it is parsed again when it is resolved: a bundle that
cannot be used never applies, and the service fails closed. The
publications are kept: a version is never changed and never removed.

The catalog is read with the registry of the workspaces, in one
statement, and nothing is cached from the database: a bundle that was
published is visible in the next request.

The other commands of the operator are in [the development](development.md)
and in [the retention](retention.md).

## The rotation of the secrets

| Secret | Where it lives | The rotation |
| --- | --- | --- |
| The public key of the identity of the gateway | The file of the binding (`publicKeyFile`) | It is a coordinated operation: the gateway signs with the private key of the pair and the backend verifies with the public one. The backend holds one key per binding, so a rotation is a change of the configuration and a restart. The pair is generated by the gateway with `bun run identity:key`, and the private key never reaches the backend. |
| The derived identity key of the gateway (legacy) | The file of the binding (`identityKeyFile`) | It is the migration path of the deployments that still share a key with their gateway. It is a signing capable secret, and a route that names the version `v4` is the only one that reads it. A deployment that leaves the legacy mode deletes the key of its secret store. |
| The credential of the access context | `DATA_HUB_CONTEXT_TOKEN_FILE` | It is changed at Hub first, then at the backend. The backend answers `503 AUTHORIZATION_UNAVAILABLE` while the two do not agree. |
| The key of the cursors | `DATA_CURSOR_KEY_FILE` | A change invalidates the cursors that are alive: the clients receive `400 INVALID_CURSOR` and they start again. |
| The password of the roles | The secret manager | `scripts/provision.ts` changes it. The pools reconnect. |

## The alarms

| Signal | What it means | What to do |
| --- | --- | --- |
| `data_outbox_oldest_age_seconds` grows | A subscriber does not keep up. | More workers, or a subscriber that fails. See `data_delivery_failures_total`. |
| `data_delivery_failures_total` grows | A handler fails, or a subscriber is missing after a deployment. | `bun run scripts/delivery.ts list`, then requeue with the attribution of the operator. |
| `data_authorization_denials_total` grows | A client asks for what it may not have, or a grant was revoked. | The code of the error and the route are enough to know the client. |
| `data_db_pool_waits_total` grows | The pool is too small, or the database is slow. | The pool, the statement timeout, the indexes of the collection. |
| `/readyz` answers 503 | A dependency is not in order. | The reason of the answer names the dependency. |
