# The headless data backend

A headless, permission aware data API for the applications behind
[Shuttle](https://github.com/ggpwnkthx/shuttle). The backend owns the
workspaces, the registered collections, the data policies, the records,
the audit history and the committed events. [Hub](https://github.com/ggpwnkthx/hub)
owns the identity, the tenants, the groups and the grants.

The service is a standalone deployment. It does not serve a studio, it
does not depend on a studio and it does not know that a studio exists: a
studio is one of its clients, like any other client.

- **Runtime:** TypeScript on Bun 1.4.3, Hono at the HTTP boundary.
- **Storage:** PostgreSQL 15 or later, with the row level security of the
  database as the isolation of the tenants and of the workspaces.
- **Specification:** [`SPECS.md`](SPECS.md) is the contract of the
  release. [`IMPLEMENTATION.md`](IMPLEMENTATION.md) is the trace of the
  implementation against it.

## The status of the release

**Version 0.2.0 is published, and it is a pre-production release.** It is
implemented, it passes its own gates, and the compatibility harness runs
it against the real gateway and the real hub — but it has never run
outside its own harness. It has no production history, no external user,
and no review that was written by somebody other than the author of the
code. The trace of the implementation says "checked" and not "proved"
for the same reason, and the review of the security of the service,
with the findings that are still open, is in
[`docs/security.md`](docs/security.md).

The release carries the service in three forms:

| What | Where |
| --- | --- |
| The image | `ghcr.io/ggpwnkthx/depot:0.2.0` |
| The standalone binaries | The assets of the [release `v0.2.0`](https://github.com/ggpwnkthx/depot/releases/tag/v0.2.0) |
| The typed client | `data-backend-client-0.2.0.tgz`, an asset of the same release |

The client is not published on a registry: it is downloaded from the
release of the repository.

```bash
# The image of the service.
docker pull ghcr.io/ggpwnkthx/depot:0.2.0

# The typed client.
bun add https://github.com/ggpwnkthx/depot/releases/download/v0.2.0/data-backend-client-0.2.0.tgz
```

The root of the repository and the client are two different packages:
`bun add github:ggpwnkthx/depot` installs the **root** package, the
service itself, and it is not the way to obtain the client. The client
is the nested package `@data-backend/client`, and the release publishes
it as a tarball:

```ts
import { DataClient } from '@data-backend/client'
```

The check of the packaging proves it: `bun run check:client-package`
packs the client with the command of the release, installs the tarball
in a consumer outside of the repository, and calls the API with it.

The binaries are archives that hold the executable, the manifests of the
collections, the policies and the migrations of the deployment, next to
each other. The checksums of every asset are in `checksums.txt`, in the
release itself.

## The shape of the service

```
clients ──▶ Shuttle ──▶ data backend ──▶ PostgreSQL
                │              │
                │              └──▶ Hub (the access context)
                └─────────────────▶ Hub (the login and the decisions)
```

The gateway signs the identity of the caller. The backend verifies the
signature, resolves the workspace in its registry, asks Hub for the
current capabilities of the principal and enforces the policies of the
deployment on every record.

## The commands

| Command | What it does |
| --- | --- |
| `bun run start` | The api and, when the role says so, the worker. |
| `bun run migrate` | Applies the migrations with the owner of the schema. |
| `bun run workspace -- create --id <uuid> --tenant <uuid> --slug <slug>` | Creates a workspace. |
| `bun run workspace -- list` | Lists the workspaces. |
| `bun run collection -- register --workspace <uuid> --collection <key>` | Registers a collection for a workspace. |
| `bun run policy -- publish --workspace <uuid> --file <path>` | Publishes the bundle of policies of a workspace. |
| `bun run typecheck` | The types of the whole repository. |
| `bun run lint` / `bun run format:check` | The style of the repository. |
| `bun run architecture` | The boundaries of the domains. |
| `bun test test/unit` | The rules of the domains. |
| `bun test test/contract` | The contract of the HTTP API. |
| `bun test test/integration` | The database, the transactions and the worker. |
| `bun test packages/client/test` | The consumer of the typed client. |
| `bun run check:client-package` | The packed client, installed outside of the repository. |
| `bun run check:compatibility` | The baseline of the documentation against the manifest. |
| `bun run test:compat` | The real gateway, the real hub and the real backend. |
| `bun run scripts/capacity.ts` | The latency of the service on a development machine. |
| `bun run scripts/scale.ts` | The plan of the statements, and the pagination, on a large collection. |
| `docker build .` | The image of the service. |
| `docker compose up --build` | The stack of the development machine. |

The integration tests and the compatibility harness need a PostgreSQL
server. The tests start one themselves in `.pg/test-data`; the harness
starts one in a temporary directory.

The harness clones the gateway and the hub at the revisions of the
baseline, the ones of `compatibility.json`, the one file of this
repository that owns them. It takes them from the network when it can,
and it takes them from local checkouts when it cannot:

```bash
SHUTTLE_REPOSITORY=/srv/mirrors/shuttle HUB_REPOSITORY=/srv/mirrors/hub bun run test:compat
```

The order of the sources is the one of the list: an explicit repository
wins over a mirror, and a mirror wins over the url of the manifest. A
repository that is a path on the disk is cloned from that path, and the
clone of a local path does not use the network. `COMPAT_MIRROR` names a
directory that holds the bare mirrors `shuttle.git` and `hub.git`, and
the harness uses them when the network is not there. A url with or
without the suffix `.git` names the same mirror.

`SHUTTLE_COMMIT` and `HUB_COMMIT` name another revision: a run with an
override is a run of a candidate, and the harness says that it is not
the proof of the baseline. An override that is not a full revision is an
error, and the harness never falls back to another source.

## The development machine

```bash
bun install
cp .env.example .env                      # and change the secrets
bun run scripts/provision.ts               # the roles and the database
bun run migrate                            # the schema
bun run workspace -- create --id 22222222-2222-4222-8222-222222222222 \
  --tenant aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --slug acme
bun run start
```

The service reads the bindings of the gateway from
`DATA_SHUTTLE_BINDINGS_FILE`. The file holds the routes the deployment
accepts, and the verification of the identity of every route: the
version of the signature, the algorithm, and the file of the key.
```json
{
  "version": 2,
  "bindings": [
    {
      "id": "data-api",
      "host": "api.shuttle.test",
      "upstreamPathPattern": "/ws/{workspaceId}/v1/*",
      "routeId": "data-api",
      "identity": {
        "version": "v5",
        "algorithm": "ES256",
        "publicKeyFile": "./secrets/identity.public.pem"
      }
    }
  ]
}
```

The key of a route is the **public** key of the gateway: a key of the
curve P-256, in pem. The gateway holds the private one and signs the
identity with it, and the backend verifies with the public one. A
backend that can verify an identity cannot mint one.

The gateway generates the pair with `bun run identity:key`: the private
key goes to the secret store of the deployment and to
`SHUTTLE_IDENTITY_SIGNING_KEY`, and the public key goes to the file of
the binding. The backend never holds the private key and never holds
`SHUTTLE_SESSION_SECRET`.

### The migration from the shared key

The previous format, `v4`, is symmetric: the backend held the key that
is derived from the secret of the sessions of the gateway
(`HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")`),
and an upstream that could verify an identity could mint one.

The migration is a change of the deployment of the gateway and of the
deployment of the backend, and it happens in this order:

1. The gateway is given the private key of a new pair, and it signs
   with it. The old derived key still works for the upstreams that
   have not changed yet.
2. The backend is given the public key of the pair, in a binding of the
   version 2. It refuses the version `v4` from that moment: a route
   verifies one version, and it never falls back to another one.
3. The deployments that still share the derived key stay on the file of
   the version 1 of the bindings, which is read as the legacy mode it
   is. A deployment that leaves the legacy mode deletes the derived key
   of its secret store.

A binding of the legacy mode names the version, the algorithm, and the
file of the key explicitly:

```json
{
  "version": 2,
  "bindings": [
    {
      "id": "data-api",
      "host": "api.shuttle.test",
      "upstreamPathPattern": "/ws/{workspaceId}/v1/*",
      "routeId": "data-api",
      "identity": {
        "version": "v4",
        "algorithm": "HS256",
        "identityKeyFile": "./secrets/identity.key"
      }
    }
  ]
}
```

## The catalog of a workspace

The **catalog** of a workspace is what it serves: the collections it
registered and the bundle of policies that applies to it. The deployment
holds a default catalog — the manifest of the collections and the bundle
of the policies of the deployment — and a workspace may hold its own.

The catalog is a **logical registry**. It never creates a table and
never alters one: the tables of the collections come from the reviewed
migrations, their isolation is written in those migrations, and the role
of the api may never alter them. A registration names a collection of
the deployment and the table that the deployment declares for it.

```bash
# The collections a workspace serves.
bun run collection -- register --workspace <uuid> --collection articles
bun run collection -- list --workspace <uuid>

# The bundle of policies of a workspace.
bun run policy -- publish --workspace <uuid> --file policies.json
bun run policy -- list --workspace <uuid>
```

Both commands are operator commands: they run on the machine of the
deployment, they are not HTTP routes, and they never bypass Hub. The
grants of a principal stay the business of Hub, and the bundles of the
workspaces are the business of the operator.

The catalog is read with the registry of the workspaces, in one
statement, and nothing is cached: a bundle that was published is visible
in the next request.

## The documentation

| Document | What it holds |
| --- | --- |
| [`SPECS.md`](SPECS.md) | The contract of the release. |
| [`IMPLEMENTATION.md`](IMPLEMENTATION.md) | The milestones and the traceability matrix. |
| [`docs/contract.md`](docs/contract.md) | The stable surface of the service: the contract of v1. |
| [`CHANGELOG.md`](CHANGELOG.md) | The changes of the service. |
| [`docs/security.md`](docs/security.md) | The model of the security, the review of it and the findings that are open. |
| [`docs/decisions.md`](docs/decisions.md) | The choices of the implementation and their reasons. |
| [`docs/operations.md`](docs/operations.md) | The probes, the metrics, the logs and the drain. |
| [`docs/migrations.md`](docs/migrations.md) | The migrations and the drift. |
| [`docs/retention.md`](docs/retention.md) | The retention of the history. |
| [`docs/backup-restore.md`](docs/backup-restore.md) | The backup and the restore rehearsal. |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | The failures and what to do about them. |
| [`docs/capacity.md`](docs/capacity.md) | The capacity report of the release. |
| [`packages/client`](packages/client) | The typed client of the API. |

## The hub extension

The access context contract that this service needs is a **required
integration and deployment dependency**: a hub that does not answer
`/v1/access-context` cannot serve this backend, and the backend fails
closed without it.

The extension is **upstream**: hub carries it since `4cedcfc`, and the
baseline of the hub is the revision of `compatibility.json`. The depot
holds no copy of the change: a contract of the platform lives in the
repository of the platform, and the compatibility harness proves the
contract against the real hub.
