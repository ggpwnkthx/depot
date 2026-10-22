# The contract of v1

This document is the stable surface of the service. It says what a
client may rely on, what may change, and what a change costs.

The [specification](specification.md) is the normative contract of the
release, and it may change between the releases of the service. This
document is the subset of it that a client depends on, and it changes
only with a major version of the client.

## The paths

| Path | Method | What it answers |
| --- | --- | --- |
| `/ws/{workspaceId}/v1/me` | `GET` | The identity of the caller in the workspace. |
| `/ws/{workspaceId}/v1/schema` | `GET` | The metadata of the collections the caller may use. |
| `/ws/{workspaceId}/v1/schema/{collection}` | `GET` | The metadata of one collection. |
| `/ws/{workspaceId}/v1/items/{collection}` | `GET`, `POST` | A page of the records, and the creation of one. |
| `/ws/{workspaceId}/v1/items/{collection}/{id}` | `GET`, `PATCH`, `DELETE` | One record, its update and its deletion. |
| `/ws/{workspaceId}/v1/aggregate/{collection}` | `GET` | The groups of an aggregate. |
| `/ws/{workspaceId}/v1/audit` | `GET` | The metadata of the audit log of the workspace. |
| `/ws/{workspaceId}/v1/openapi.json` | `GET` | The description of the API. |
| `/healthz`, `/readyz`, `/metrics` | `GET` | The probes of the deployment. They are not routed through the authorization of a workspace. |

The gateway preserves the path of the request, and the backend expects
the whole of it: it does not assume that the gateway strips
`/ws/{workspaceId}` or an upstream base path.

**A path that is not in this table does not exist.** A deferred
capability answers `404 NOT_FOUND`, and it never answers with a
successful placeholder. An unknown method on a known path answers `405`
with an `Allow` header.

Every data path needs the verified identity of the gateway. The
backend has no login endpoint, no token endpoint and no session: the
caller authenticates at Shuttle, and the gateway forwards a signed
identity.

## The envelopes

| Answer | Its shape |
| --- | --- |
| A list | `{ "data": [...], "meta": { "limit", "nextCursor", "count"? } }` |
| A record | `{ "data": { ... } }`, with the validator of the record in the `etag` header |
| A creation | `201`, `{ "data": { "id", "version" } }`, and the location of the record in the `location` header |
| An aggregate | `{ "data": [...], "meta": { "limit", "groups", "truncated" } }` |
| An error | `{ "error": { "code", "message", "details"? }, "requestId" }` |

The correlation of a request is in the `x-request-id` header, and it is
the `requestId` of an error. The responses that carry sensitive or
permission dependent data use `Cache-Control: no-store`.

## The error codes

A client switches on the code and never on the message. The status of
a code is fixed inside a major version, and the codes are published in
the OpenAPI document.

| Status | Codes |
| --- | --- |
| `400` | `INVALID_REQUEST`, `INVALID_QUERY`, `INVALID_CURSOR`, `INVALID_PRECONDITION` |
| `401` | `UNAUTHENTICATED` |
| `403` | `FORBIDDEN` |
| `404` | `NOT_FOUND` |
| `409` | `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `OPERATION_IN_PROGRESS`, `CURSOR_STALE` |
| `412` | `PRECONDITION_FAILED` |
| `413` | `PAYLOAD_TOO_LARGE` |
| `422` | `VALIDATION_FAILED`, `INVALID_REFERENCE`, `RESULT_TOO_LARGE` |
| `428` | `PRECONDITION_REQUIRED` |
| `429` | `TOO_MANY_REQUESTS` |
| `500` | `INTERNAL_ERROR` |
| `503` | `AUTHORIZATION_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `OVERLOADED`, `DRAINING` |
| `504` | `DEADLINE_EXCEEDED` |

The message is a safe human readable summary. The details name only
the fields the caller is authorized to write or to query. Stack traces,
SQL text, the names of the constraints of the database, the raw reasons
of Hub and the identifiers of another tenant are never returned.

A refusal is a refusal: the service never says which policy refused
the request, and it never distinguishes an unknown principal of an
unknown grant.

The codes of the failures of the database are the codes of the
contract: a lock that was not granted in time is a `409 CONFLICT`, a
constraint that was violated is a `409 CONFLICT` or a
`422 VALIDATION_FAILED`, a statement that ran out of its budget is a
`504 DEADLINE_EXCEEDED`, and a database that is not reachable is a
`503 DATABASE_UNAVAILABLE`. A `500 INTERNAL_ERROR` is a defect of the
service and nothing else.

The `429 TOO_MANY_REQUESTS` is the answer of a tenant that holds its
whole room, and it carries a `Retry-After`. The room of a tenant is the
room of the process until the deployment declares another one; a
deployment with several tenants declares it with
`DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT`.

## The parameters of the queries

| Parameter | Where | What it is |
| --- | --- | --- |
| `fields` | The list | The fields of the projection, at most 50. The default is the union of the readable fields of the policies, plus `id` and `version`. |
| `filter` | The list, the aggregate | The JSON filter of the query, URL encoded. |
| `search` | The list, the aggregate | The text of the search of the collection, at most 256 characters. |
| `sort` | The list | Up to three fields, `-field` for descending. The default is `id` ascending. |
| `limit` | The list | The size of the page: 50 by default, 200 at most. |
| `cursor` | The list | The cursor of the next page. |
| `include` | The list | The relations to expand, at most 5. |
| `include_count` | The list | Whether the count of the rows is returned. It is false by default. |
| `group_by` | The aggregate | The fields the rows are grouped by, at most 3. |
| `metrics` | The aggregate | The metrics of the groups: `sum:field`, `avg:field`, `min:field`, `max:field`, at most 10. The count of the rows is always part of the answer. |
| `limit` | The aggregate | The maximum number of the groups: 100 by default, 1000 at most. |

An unknown parameter and a repeated parameter are both refused: the
answer would otherwise depend on which value the reader picked. The
complete raw query string is at most 16 KiB.

## The grammar of the filter

The operators are `_and`, `_or`, `_not`, `_eq`, `_neq`, `_in`, `_nin`,
`_lt`, `_lte`, `_gt`, `_gte` and `_is_null`.

```json
{
  "_and": [
    { "title": { "_eq": "Launch notes" } },
    { "created_at": { "_gte": "2026-10-01T00:00:00Z" } }
  ]
}
```

- `_and` and `_or` hold non empty arrays of filter objects.
- `_not` holds one filter object and negates it.
- The depth of the grammar is at most 5, with at most 50 leaf
  predicates.
- `_in` and `_nin` hold 1 to 100 values of the type of the field.
- An empty filter object means no additional predicate of the caller.
- The null is compared with `_is_null`. The operands of an equality or
  of an ordering cannot be null.

The operators are checked against the type of the field. Dotted
relation filters, the JSON path expressions, the arbitrary functions
and the wildcards of SQL are not supported: the values are bound
parameters and the identifiers come from the validated manifest.

**The negation keeps the three valued logic of the database.** The
negation of an unknown is an unknown, and a row whose value is null is
never matched by a negated comparison.

A field that the caller may not filter or sort by is refused with
`400 INVALID_QUERY`. The rule is the intersection of the read policies
of the collection: a field that one policy hides cannot be used to
infer what it hides.

## The list

The list is bounded, filtered and permission aware. The rows and the
count are evaluated in one read only snapshot, with the same
predicates and the same filter.

The total encoded response, expansions included, is at most 4 MiB.
Exceeding it answers `422 RESULT_TOO_LARGE` without a partial page: no
success byte is sent before the bounded answer is complete.

An expansion is bounded too: depth 1, 100 related rows per root
record and 1000 related rows per answer.

## The cursors

A cursor is an opaque, signed token. It binds the principal, the
tenant, the workspace, the collection, the route, the filter, the
fields, the sort, the expansions, the count option, the limit, the
position, the schema version, the version of the bundle of the
policies and the fingerprint of the permissions of the caller.

- The lifetime of a cursor is 15 minutes.
- A tampered cursor, or a cursor of another request, is
  `400 INVALID_CURSOR`.
- An expired cursor, or a cursor of a schema, of a bundle or of a set
  of permissions that changed, is `409 CURSOR_STALE`.
- A cursor is never an authorization credential.

Every page obtains a fresh context and applies the current policies.
The pages are not a snapshot of the database: a concurrent insert,
update or delete changes the later pages.

## The canonical read and the validators

The read of one record answers all the fields that are readable for
that row, plus `id` and `version`. The endpoint accepts no parameter
of a query: `fields` and `include` are refused with a
`400 INVALID_QUERY`, like every parameter that is not known, and a
client that wants a projection uses the list.

The backend serializes the canonical representation deterministically —
the keys are sorted recursively, the order of the arrays is preserved,
and there is no insignificant whitespace — and it answers a strong
`ETag` of `"sha256:<lowercase hex digest>"` over exactly those bytes.
The bytes carry the version of the record, so a change invalidates the
validator.

A `PATCH` and a `DELETE` require a current validator:

| Condition | The answer |
| --- | --- |
| No `If-Match` | `428 PRECONDITION_REQUIRED` |
| A weak, a wildcard, a malformed or a multiple validator | `400 INVALID_PRECONDITION` |
| The current authorized representation is different | `412 PRECONDITION_FAILED` |
| The record is missing or is no longer readable | `404 NOT_FOUND` |

An update also needs a read policy and the complete write policy of
the action. A successful `PATCH` answers the new canonical
representation and its `ETag`; a `DELETE` answers `204` without a
body.

An update always increments the version of the record, even when the
values do not change. An empty `PATCH` is invalid.

## The creation and the idempotency

A `POST` requires an `Idempotency-Key`: 1 to 128 ASCII letters,
digits, periods, underscores or hyphens. The key is opaque input, not
an authority.

The rules:

1. The key is scoped to the principal, the tenant, the workspace, the
   route and the endpoint.
2. A fingerprint of the request — the method, the path and the
   validated body — is stored with it.
3. The claim of the key, the insert, the audit entry, the event, the
   deliveries and the receipt commit atomically.
4. The same key with the same body answers the original receipt with
   `Idempotency-Replayed: true`, and it creates nothing.
5. The replay authenticates again and needs a currently applicable
   create capability; it never replays the values of the business
   fields.
6. The same key with another body is `409 IDEMPOTENCY_CONFLICT`.
7. A concurrent duplicate waits within the budget of the request. If it
   is unresolved after two seconds, the answer is
   `409 OPERATION_IN_PROGRESS` with a `Retry-After: 1`.
8. A rolled back transaction leaves neither a receipt nor an effect.
9. A receipt is kept for at least 24 hours. After that, the reuse of
   the key is a new operation: the deduplication is not permanent.
10. A record that is deleted or changed afterwards does not change the
    receipt of its creation, and it does not recreate it.

The answer of a creation is a receipt, not a record:

```json
{ "data": { "id": "44444444-4444-4444-8444-444444444444", "version": 1 } }
```

The client fetches the record separately if it is authorized to read
it. The receipt never grants a read.

## The aggregate

`GET /ws/{workspaceId}/v1/aggregate/{collection}` groups the records of
a collection. It reads the rows that the corresponding list reads: the
same scope, the same disjunction of the read predicates and the same
filter of the caller. It is not a privileged query path.

The fields of the group and the fields of the metrics are the fields
the caller may filter and sort by. A function that is not defined for
the type of its field is `400 INVALID_QUERY`.

```json
{
  "data": [
    { "group": { "status": "draft" }, "count": 12, "sum": { "amount": "42.50" } }
  ],
  "meta": { "limit": 100, "groups": 1, "truncated": false }
}
```

The sum and the average of an integer are decimals, exactly as the
database answers them. The groups are ordered by the fields of the
group, so the answer is stable, and `truncated` says when the groups
of the answer are not all of them.

## The search

The `search` parameter is a text search of the database over the
fields that the manifest declares searchable. The caller supplies the
text; the deployment supplies the fields and the configuration of the
search. A caller never chooses them.

The search is combined with the filter of the caller, and the count of
a list counts the rows of the search. A search over a field that a
policy hides is `403 FORBIDDEN`.

The search is not an operator of the filter grammar: the predicates of
the policies are evaluated in memory by the write path, and a text
search has no meaning there.

## The metadata

`/schema` answers the collections for which the caller holds at least
one applicable action policy. A collection may be described as
write only, and its records are still not readable.

The answer carries the key, the label, the schema version, the
supported actions of the caller, the readable and the writable fields
with their bounds, the fields available for filtering and sorting, the
visible relations, the version of the bundle of the policies and the
limits of the API.

It never carries a SQL identifier, an internal row predicate, a
secret, the configuration of the subscribers, the grants of Hub or the
instructions of a studio.

## The audit

`GET /ws/{workspaceId}/v1/audit` answers the metadata of the
committed mutations of the workspace, with `limit` and a cursor. It
requires the permission `data.audit.read`, which is granted on its
own: it is not a side effect of editing the records.

The audit answers identifiers and the names of the fields that
changed. It never holds the values of the fields, and it is not a
revision history.

## What is not stable

- **The artifacts of the deployment.** The manifest of the
  collections, the bundle of the policies, the tables of the database
  and the identifiers of the columns are the business of the
  deployment. A client reads them through the metadata of the schema,
  and never through the database.
- **The content of the metadata.** The fields of the collections, their
  labels, their relations and the permissions of the caller change
  with the deployment. The *shape* of the metadata is stable, its
  content is not.
- **The tables and the statements.** They are the business of the
  service. A client never reaches them.
- **The metrics and the logs.** They are the business of the operator.
- **The reasons of a refusal.** A refusal answers `403 FORBIDDEN` and
  nothing else.

## The rules of a change

1. A change that a client depends on is a **major** change: a new path
   version, or a new major of the client. The path version is bumped
   only when the old version cannot be kept, and the old version is
   kept for at least one release.
2. A change that only adds something is a **minor** change, and it is
   announced in [the changelog](changelog.md).
3. A change of the behavior of an existing path that a client may
   depend on is a change of the specification first. The
   specification is amended, a check that proves it is named, and the
   change lands with its check.
4. The error codes are never removed and never change their meaning. A
   code that is not used any more is kept and answers nothing.
5. The bounds may only grow, and never for a request that a client
   already sends: a client that sends a page of 50 records keeps
   receiving a page of 50 records.

## The versions

| The thing | Its version | Where it is |
| --- | --- | --- |
| The service | `0.2.0` | The answer of `/healthz` (`version`), the label of the image and the version of the package. |
| The API | `v1` | The path of every route of the data. |
| The client | `0.2.0` | `packages/client/package.json` and the tarball of the release. |
| The access context contract | `1` | The discovery of Hub. |
| The signature of the gateway | `v5` | The header of the identity. The legacy version `v4` is a migration path: the deployment declares it with `DATA_LEGACY_IDENTITY`, and the service refuses it by default. |
| The format of the manifest | `1` | The `version` of the manifest. |
| The format of the policy bundle | `1` | The `version` of the bundle. |

The versions of the contract of Hub and of the gateway are the versions
of the platform, and they are pinned in `compatibility.json`, the
manifest of the baseline of the integration. The check
`bun run check:compatibility` proves that the documentation and the
workflows still agree with it.
