# The contract of v1

This document is the stable surface of the service. It says what a
client may rely on, what may change, and what a change costs.

`SPECS.md` is the normative contract of the release and it may change
between the releases of the service. This document is the subset of it
that a client depends on, and it changes only with a major version of
the client.

## What is stable

### The paths

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

A path that is not in this table does not exist. A deferred capability
answers `404 NOT_FOUND`, and it never answers with a successful
placeholder.

### The envelopes

Every answer of the data paths is an envelope:

- a list answers `{ "data": [...], "meta": { "limit", "nextCursor", "count"? } }`,
- a record answers `{ "data": { ... } }` with the validator of the record
  in the `etag` header,
- a creation answers `201` with `{ "data": { "id", "version" } }` and the
  location of the record in the `location` header,
- an aggregate answers `{ "data": [...], "meta": { "limit", "groups", "truncated" } }`,
- an error answers `{ "error": { "code", "message", "details"? }, "requestId" }`.

### The error codes

The codes of `src/protocol/errors.ts` are stable, and they are published
in the OpenAPI document. A client switches on the code and never on the
message. The status of a code is fixed and does not change inside a
major version.

### The grammar of the filter

The operators `_and`, `_or`, `_not`, `_eq`, `_neq`, `_in`, `_nin`,
`_lt`, `_lte`, `_gt`, `_gte` and `_is_null`, the bounds of the grammar
(the depth, the number of the predicates and the number of the values)
and the semantics of the null are stable. A new operator may be added
inside a major version: a client that does not know it refuses the
filter it does not understand, and the service refuses it as well.

### The parameters of the queries

| Parameter | Where | What it is |
| --- | --- | --- |
| `fields` | The list | The fields of the projection, at most 50. |
| `filter` | The list, the aggregate | The json filter of the query. |
| `search` | The list, the aggregate | The text of the search of the collection, at most 256 characters. |
| `sort` | The list | Up to three fields, `-` for descending. |
| `limit` | The list, the aggregate | The size of the page (at most 200) or the maximum number of the groups (at most 1000). |
| `cursor` | The list | The cursor of the next page. |
| `include` | The list | The relations to expand, at most 5. |
| `include_count` | The list | Whether the count of the rows is returned. |
| `group_by` | The aggregate | The fields the rows are grouped by, at most 3. |
| `metrics` | The aggregate | The metrics of the groups: `sum:field`, `avg:field`, `min:field`, `max:field`. |

### The headers of a write

| Header | What it carries |
| --- | --- |
| `idempotency-key` | The key of a creation. The same key and the same body answer with the same receipt. |
| `if-match` | The validator of the record that is written. It is required, and it is strong. |

### The client package

The client of `@data-backend/client` follows the semantic versioning:

- a **patch** changes nothing that a client depends on,
- a **minor** adds a method or an option, and the old code keeps
  working,
- a **major** changes the shape of an answer, the name of a method, or
  the meaning of an option.

**The client is not published on a registry.** It is distributed as the
tarball of the release of the repository, and the version of the tarball
is the version of the client:

```bash
bun add https://github.com/ggpwnkthx/depot/releases/download/v0.2.0/data-backend-client-0.2.0.tgz
```

The root of the repository is the **service**, and it is a different
package: `bun add github:ggpwnkthx/depot` installs the root package and
it is not the way to obtain the client. The client is the nested package
`@data-backend/client`, and it is installed from the tarball of the
release.

```ts
import { DataClient } from '@data-backend/client'
```

The client of a major version talks to the deployment of the same major
version. The client of `1.x` talks to the deployment of `1.y` for every
`y >= x`: the deployment never removes a path and never changes the
meaning of an answer inside a major version.

**The types of the collections are the artifact of the deployment.** The
client is generic: it speaks the contract of v1 and it knows nothing of
the collections of a deployment. A deployment that wants the types of
its own collections generates them with
`bun run scripts/generate-client.ts` and hands them to the client:

```ts
import { DataClient } from '@data-backend/client'
import type { Collections } from './generated/collections'

const client = new DataClient<Collections>({ baseUrl, workspaceId })
const page = await client.list('articles')   // the rows of the articles
```

The client without a map is the client of the contract: its rows are
`RecordValue`, and every collection is a string. The names of the
collections and the types of their fields are not part of the client
package: they change with the manifest of the deployment, and the
manifest is not a part of a major version of the client.

## What is not stable

- **The deployment artifacts.** The manifest of the collections, the
  bundle of the policies, the tables of the database and the identifiers
  of the columns are the business of the deployment. A client reads them
  through the metadata of the schema, and never through the database.
- **The metadata of the schema.** The fields of the collections, their
  labels, their relations and the permissions of the caller change with
  the deployment. The *shape* of the metadata is stable, its content is
  not.
- **The tables of the database and the statements.** They are the
  business of the service. A client never reaches them.
- **The metrics and the logs.** They are the business of the operator.
- **The reasons of a refusal.** A refusal answers `403 FORBIDDEN` and
  nothing else: the service never says which policy refused the
  request.

## The rules of a change

1. A change that a client depends on is a **major** change: a new path
   version, or a new major of the client. The path version is bumped
   only when the old version cannot be kept, and the old version is
   kept for at least one release.
2. A change that only adds something is a **minor** change, and it is
   announced in `CHANGELOG.md`.
3. A change of the behavior of an existing path that a client may
   depend on is a change of the specification first. The specification
   is amended, the matrix of `IMPLEMENTATION.md` names the check that
   proves it, and the change lands with its check.
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
| The access context contract | `1` | The discovery of the hub. |
| The signature of the gateway | `v5` | The header of the identity. The legacy version `v4` is a migration path. |
| The format of the manifest | `1` | The `version` of the manifest. |
| The format of the policy bundle | `1` | The `version` of the bundle. |

The versions of the contract of the hub and of the gateway are the
versions of the platform, and they are pinned in `compatibility.json`,
the manifest of the baseline of the integration. The baseline of the
documentation and the workflows read it, and the check
`bun run check:compatibility` proves that they still agree with it.
