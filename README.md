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
| `bun run typecheck` | The types of the whole repository. |
| `bun run lint` / `bun run format:check` | The style of the repository. |
| `bun run architecture` | The boundaries of the domains. |
| `bun test test/unit` | The rules of the domains. |
| `bun test test/contract` | The contract of the HTTP API. |
| `bun test test/integration` | The database, the transactions and the worker. |
| `bun test packages/client/test` | The consumer of the typed client. |
| `bun run test:compat` | The real gateway, the real hub and the real backend. |

The integration tests and the compatibility harness need a PostgreSQL
server. The tests start one themselves in `.pg/test-data`; the harness
starts one in a temporary directory.

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
accepts and the file of the derived identity key of every route:

```json
{
  "version": 1,
  "bindings": [
    {
      "id": "data-api",
      "host": "api.shuttle.test",
      "upstreamPathPattern": "/ws/{workspaceId}/v1/*",
      "routeId": "data-api",
      "identityKeyFile": "./secrets/identity.key"
    }
  ]
}
```

The identity key is the **derived** key of the gateway
(`HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")`),
in base64. It is a signing capable secret: it belongs inside the trust
boundary of the gateway and it is never in the repository.

## The documentation

| Document | What it holds |
| --- | --- |
| [`SPECS.md`](SPECS.md) | The contract of the release. |
| [`IMPLEMENTATION.md`](IMPLEMENTATION.md) | The milestones and the traceability matrix. |
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
pinned hub of the baseline is that revision. The depot holds no copy of
the change: a contract of the platform lives in the repository of the
platform, and the compatibility harness proves the contract against the
real hub.
