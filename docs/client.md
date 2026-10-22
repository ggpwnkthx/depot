# The typed client

The client of the API is the package `@data-backend/client`. It speaks
the contract of v1 through the gateway, and it hides nothing: the
refusals of the authorization and of the concurrency reach the caller
as typed errors.

## The installation

**The client is published on a registry of packages**, and it is
distributed as the tarball of the release of the repository. The
version of the tarball is the version of the client:

```bash
npm install @data-backend/client
# or, with bun:
bun add @data-backend/client
```

The tarball of the release is the same package, for a deployment that
pins a version with a url:

```bash
bun add https://github.com/ggpwnkthx/depot/releases/download/v0.2.0/data-backend-client-0.2.0.tgz
```

The root of the repository is the **service**, and it is a different
package: `bun add github:ggpwnkthx/depot` installs the root package,
and it is not the way to obtain the client.

```ts
import { DataClient } from '@data-backend/client'
```

The client runs with **bun** and with **node**: it is a library of the
two runtimes, it carries its own files, and it depends on nothing. The
check of the packaging installs the tarball in a consumer that lives
outside of the repository and calls the API with the client, once with
bun and once with node.

The client of a major version talks to the deployment of the same major
version. The client of `1.x` talks to the deployment of `1.y` for every
`y >= x`: the deployment never removes a path and never changes the
meaning of an answer inside a major version.

## The construction

```ts
const client = new DataClient({
  baseUrl: 'https://api.shuttle.test',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  headers: { cookie: sessionCookie },   // the credentials of the caller
  // fetch: myFetch,                    // the transport of the caller
  // signal: controller.signal,         // the cancellation
})
```

| Option | What it is |
| --- | --- |
| `baseUrl` | The base url of the deployment, through the gateway. |
| `workspaceId` | The workspace of the calls. |
| `fetch` | The transport of the caller. It defaults to the global one. |
| `headers` | The headers of every call, such as the cookie of the session. |
| `signal` | The signal that cancels the calls. |

The client never signs a request, never stores the credentials of Hub
and never runs a login flow. The credentials of the caller travel in
the transport, and the gateway turns them into a signed identity.

## The methods

| Method | What it does |
| --- | --- |
| `me()` | The principal, the tenant, the workspace, the route and the version of the API. |
| `schema()` | The metadata of the collections the caller may use. |
| `collection(key)` | The metadata of one collection. |
| `list(key, options)` | A page of a collection. |
| `listAll(key, options)` | Every page of a collection, one after the other. |
| `get(key, id)` | One record. |
| `getWithValidator(key, id)` | One record and its `ETag`. |
| `create(key, body, { idempotencyKey })` | The creation of a record. It answers the receipt. |
| `update(key, id, body, { etag })` | The update of a record. It answers the record and its new `ETag`. |
| `remove(key, id, { etag })` | The deletion of a record. |
| `aggregate(key, options)` | The groups of an aggregate. |
| `audit({ limit, cursor })` | A page of the metadata of the audit log. |

### The example of a write

The writes need their headers: a creation needs an idempotency key, and
an update and a deletion need the current validator of the record.

```ts
const created = await client.create(
  'articles',
  { title: 'Launch notes', body: 'Initial content.' },
  { idempotencyKey: crypto.randomUUID() }
)
// created.id, created.version

const { record, etag } = await client.getWithValidator('articles', created.id)
const updated = await client.update(
  'articles',
  created.id,
  { title: 'Launch notes, revised' },
  { etag }
)
// updated.etag is the validator of the new version
```

A `412 PRECONDITION_FAILED` means that the record changed since the
validator was issued: read it again and apply the change on the new
version. The details are in [the contract of v1](api.md).

### The traversal of the pages

```ts
for await (const rows of client.listAll('articles', { limit: 100 })) {
  for (const row of rows) {
    console.log(row.title)
  }
}
```

The traversal is bounded by the caller, which stops it. The pages are
not a snapshot of the database: a concurrent change alters the later
pages.

## The types of the collections

The client is generic: it speaks the contract of v1 and it knows
nothing of the collections of a deployment. A deployment that wants the
types of its own collections generates them with
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

The command writes the file `packages/client/src/deployment.ts` of this
repository. Another deployment writes its own file, with the same
shape, in its own repository:

```bash
bun run scripts/generate-client.ts          # writes the file
bun run scripts/generate-client.ts --check  # refuses a stale file
```

## The errors

Every failure answers an `ApiError` with the code of the service, the
status, the message, the details of the fields and the identifier of
the request:

```ts
import { ApiError } from '@data-backend/client'

try {
  await client.update('articles', id, { title: 'x' }, { etag })
} catch (error) {
  if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
    // the record changed
  }
}
```

The client never hides an authorization refusal and never hides a
conflict of the concurrency. The codes are stable inside a major
version, and they are published in the OpenAPI document.

## The versioning of the package

The client follows the semantic versioning:

- a **patch** changes nothing that a client depends on,
- a **minor** adds a method or an option, and the old code keeps
  working,
- a **major** changes the shape of an answer, the name of a method, or
  the meaning of an option.

The check of the packaging proves that the artifact of the release is
usable outside of this repository:

```bash
bun run check:client-package
```

It packs the client with the command of the release, installs the
tarball in a consumer that lives outside of the repository, imports the
client through its public name and calls the API with it.
