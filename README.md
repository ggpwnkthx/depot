# The headless data backend

A headless, permission aware data API for the applications behind
[Shuttle](https://github.com/ggpwnkthx/shuttle).

The backend owns the workspaces, the registered collections, the data
policies, the records, the audit history, the history of the versions
of the records and the committed events.
[Hub](https://github.com/ggpwnkthx/hub) owns the identity, the
tenants, the groups and the grants.

It is a standalone deployment. It does not serve a studio, it does not
depend on a studio, and it does not know that a studio exists: a studio
is one of its clients, like any other client.

- **Runtime:** TypeScript on Bun 1.4.3, Hono at the HTTP boundary.
- **Storage:** PostgreSQL 15 or later in a deployment, with the row level
  security of the database as the isolation of the tenants and of the
  workspaces. The development machine, the tests and the continuous
  integration use PostgreSQL 18.

```
clients ──▶ Shuttle ──▶ data backend ──▶ PostgreSQL
                │              │
                │              └──▶ Hub (the access context)
                └─────────────────▶ Hub (the login and the decisions)
```

The gateway signs the identity of the caller. The backend verifies the
signature, resolves the workspace in its registry, asks Hub for the
current capabilities of the principal, and enforces the policies of the
deployment on every record.

## The status of the release

**Version 0.4.0 is published, and it is a pre-production release.** It
is implemented, it passes its own gates, and the compatibility harness
runs it against the real gateway and the real hub — but it has never
run outside its own harness. It has no production history, no external
user, and no review that was written by somebody other than the author
of the code.

**The next version is `1.0.0`, and it is a release candidate.** Every
gate of the repository is green: the types, the style, the boundaries,
the suites, the fuzzing of the trust boundary, the differential tests
of the predicates and of the guard of a write, the client outside of
the repository with bun and with node, the image that is built and
started, the compatibility with the pinned gateway and the pinned hub,
the rehearsal of the backup and of the restore, and the measurement of
the capacity. Two gates are outside the repository: a deployment with a
real studio and a real tenant, and a review that was written by
somebody other than the author of the code. They are listed in [the
readiness of the version 1.0.0](docs/release-readiness.md).

The release carries the service in three forms:

| What | Where |
| --- | --- |
| The image | `ghcr.io/ggpwnkthx/depot:0.4.0` |
| The standalone binaries | The assets of the [release `v0.4.0`](https://github.com/ggpwnkthx/depot/releases/tag/v0.4.0) |
| The typed client | `data-backend-client-0.4.0.tgz`, an asset of the same release |

```bash
# The image of the service.
docker pull ghcr.io/ggpwnkthx/depot:0.4.0

# The typed client.
bun add https://github.com/ggpwnkthx/depot/releases/download/v0.4.0/data-backend-client-0.4.0.tgz
# or, from the registry of the packages:
bun add @data-backend/client
```

The client is published on a registry of packages, and it is downloaded
from the release of the repository as well. The root of the repository
is the **service** itself, and `bun add github:ggpwnkthx/depot` is not
the way to obtain the client. The client is the nested package
`@data-backend/client`, and it runs with bun and with node.

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

The integration tests and the compatibility harness need a PostgreSQL
server. The tests start one themselves in `.pg/test-data`; the harness
starts one in a temporary directory.

## The commands

| Command | What it does |
| --- | --- |
| `bun run start` | The api and, when the role says so, the worker. |
| `bun run migrate` | Applies the migrations with the owner of the schema. |
| `bun run workspace -- create --id <uuid> --tenant <uuid> --slug <slug>` | Creates a workspace. |
| `bun run collection -- register --workspace <uuid> --collection <key>` | Registers a collection for a workspace. |
| `bun run policy -- publish --workspace <uuid> --file <path>` | Publishes the bundle of policies of a workspace. |
| `bun run typecheck` / `bun run lint` / `bun run format:check` | The types and the style of the repository. |
| `bun run architecture` | The boundaries of the domains. |
| `bun test test/unit` | The rules of the domains. |
| `bun test test/contract` | The contract of the HTTP API. |
| `bun test test/integration` | The database, the transactions and the worker. |
| `bun run test:mutation` | The gate that breaks the code on purpose and checks that the suites notice. |
| `bun run test:compat` | The real gateway, the real hub and the real backend. |
| `bun run check:client-package` | The packed client, installed outside of the repository. |
| `docker build .` / `docker compose up --build` | The image and the stack of the development machine. |

## The documentation

The whole documentation is in [`docs/`](docs/README.md). The two
documents that answer the most questions are:

- [the contract of v1](docs/api.md) — what a client may rely on,
- [the specification](docs/specification.md) — the normative contract of
  the release.

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

## The license

MIT. See [the LICENSE](LICENSE).
