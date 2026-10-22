# The troubleshooting

## The api answers 401 UNAUTHENTICATED

The request did not come through the gateway, or the signature does not
match the request.

- The signature header is `x-shuttle-signature`, and its value starts
  with the version of the binding: `v5=` for a route of the current
  format. A signature of another version is refused, and there is no
  fallback to another one.
- The key of the binding is the **public** key of the gateway, a key of
  the curve P-256 in pem (`publicKeyFile`). A route of the legacy format
  names the derived key of the gateway
  (`HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")`)
  in `identityKeyFile`, and the backend refuses a pem in that file.
- The gateway signs with the private key of its pair
  (`SHUTTLE_IDENTITY_SIGNING_KEY`), and the backend never holds it: a
  gateway that signs with another key is refused.
- The signature covers the path and the query **as the upstream
  received them**. A proxy that rewrites the path after the gateway
  breaks the signature: the path of the binding has to be the path the
  gateway forwards.
- The workspace of the path and the workspace of the signature have to
  be the same. A gateway that rewrites the path of the workspace breaks
  it.
- The host of the binding is the authority the gateway signs, with its
  port when there is one.

## The api answers 403 FORBIDDEN

Hub refused the context of the principal, or the principal does not
hold a capability for the collection.

- The credentials of Hub are the ones of the contract of the access
  context, and they are scoped to the tenants of the deployment.
- The grant of the principal has to match the workspace and the route of
  the request. The route of the request is the `routeId` of the
  binding, and it is not the identifier of the collection.
- The answers of Hub are not cached by default. A revocation is visible
  in the next request.
- A search over a field that a policy hides is also a `403`.

## The api answers 404 NOT_FOUND for a workspace that exists

- The workspace is disabled: `bun run scripts/workspace.ts list` shows
  the state of the registry.
- The tenant of the binding is not the tenant of the workspace: a
  binding with `expectedTenantId` refuses the workspaces of the other
  tenants.
- The registry reader answers nothing: the credential of
  `DATA_REGISTRY_DATABASE_URL` may not read the three columns of the
  registry any more.
- The collection is not registered for the workspace: a workspace that
  registered something serves exactly the registered collections.

## The api answers 503 AUTHORIZATION_UNAVAILABLE

Hub is not available, or it does not speak the version of the contract.

- The hub is at a revision that carries the extension: a hub before
  `4cedcfc` does not answer `/v1/access-context`. The baseline of Hub
  is the revision of `compatibility.json`.
- The credential of the access context is the one of the deployment, and
  it is scoped to the tenant of the workspace.
- The clock of the two servers is synchronized within a second: an
  answer that was evaluated in the future is refused.

## The api answers 503 DATABASE_UNAVAILABLE

- The role of the connection may not be a superuser, and it may not
  have `BYPASSRLS`.
- The pool may not be exhausted: `data_db_pool_waits_total` grows.
- The statement timeout may be too short for a slow query.
- The database may not be reachable: the answer of the connection is
  the one of the dependency, and it is not an internal error.

## The api answers 429 TOO_MANY_REQUESTS

- The tenant of the request holds its whole room: the answer carries a
  `Retry-After` of one second, and the caller has to slow down.
- The bound is declared with `DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT`.
  It is zero by default, and a deployment with one tenant does not
  need it.
- The refusals are counted by `data_tenant_overload_total`. A tenant
  that is refused often is a tenant that sends too much, and the answer
  of the listener is a `503 OVERLOADED` when the whole process is
  full.

## The api answers 409 CONFLICT

- A lock of a row was not granted in time: another transaction holds
  the row. The answer is a conflict with the current state of the
  record, and the caller reads the record again before it writes it.
- A unique constraint was violated: two writes of the same record
  raced, and one of them won.
- The same operation is already running: the answer is a `409
  OPERATION_IN_PROGRESS` with a `Retry-After` of one second, and the
  caller retries with the same body and the same idempotency key.

## The api answers 422 RESULT_TOO_LARGE

The answer of the request is larger than four mebibytes, or an
expansion of a relation is larger than its budget.

- The client asks for fewer fields, for a smaller page, or for a
  narrower expansion.
- The budget is not configurable: it is the contract of the release.

## A write answers 412 PRECONDITION_FAILED

The record changed since the validator was issued. The client reads the
record again and it applies its change on the new version.

A write that answers 412 in a loop is a client that keeps a stale
validator: the validator is the digest of the canonical representation,
and it changes with every write.

## A creation answers 409 IDEMPOTENCY_CONFLICT

The key was used with another body. The key is scoped to the principal,
the tenant, the workspace, the route and the endpoint: a key of another
scope is another key.

A creation answers `409 OPERATION_IN_PROGRESS` with a `Retry-After` of
one second when the same key is being used at the same moment. The
client retries with the same body and the same key.

## The deliveries do not run

- The subscriber is not registered in the deployment: a delivery whose
  subscriber is missing is failed, not acknowledged.
- The service principal of the worker does not hold the permission of
  the subscriber: the handler asks Hub for a fresh context and it is
  refused.
- The chain of the events is deeper than ten: the delivery is failed.

`bun run scripts/delivery.ts list` shows the state of the deliveries,
and `bun run scripts/delivery.ts requeue --event <uuid> --subscriber <id> --actor <name>`
puts one back in the queue with its attribution.

## The readiness answers 503

The answer carries the reason: the role of the connection, the
migrations, Hub or the delivery store. The migrations that were changed
after they were applied are a drift: a new migration is the answer, not
a change of the old one.

## The audit log is empty

- The principal does not hold `data.audit.read`: the endpoint answers
  `403`.
- The audit log is read with the scope of the workspace: the reader runs
  inside a scoped transaction, like every other read.

## The gateway refuses the request with 502

The backend answered with an error the gateway does not understand, or
the connection was closed. The log of the backend holds the request id
of the gateway: it is the correlation of the two sides.
