# The architecture of the service

## What the service is

The depot is a **headless, permission aware data API**. It exposes
versioned HTTP endpoints over the records of a workspace, and every
answer it gives is filtered by the policies of the deployment and by
the grants of Hub.

It is a modular monolith with an optional worker process. It serves no
user interface: a studio, a website, a script or another service are
all clients of the same API, and none of them has a privileged
connection to the database.

## The platform

| Project | What it owns |
| --- | --- |
| **Hub** | The identity of the principals, the tenants, the groups, the permission keys and the grants. |
| **Shuttle** | The sessions of the browser, the admission of a workspace, the limits of the gateway, and the signature of the identity of the caller. |
| **The depot** | The workspaces, the registered collections, the data policies, the records, the audit history and the committed events. |
| **Studio** | A separate project. It is a client of the API and nothing more. |

The rules of the separation:

- The backend never reads the tables of Hub, and it never keeps a second
  directory of the identities or of the grants.
- The backend never mints an identity: it verifies the signature of the
  gateway with the **public** key of the gateway.
- The backend never creates a session and never runs a login flow: the
  forwarded credentials are not a source of data permissions.

## The topology of a request

```
clients ──▶ Shuttle ──▶ data backend ──▶ PostgreSQL
                │              │
                │              └──▶ Hub (the access context)
                └─────────────────▶ Hub (the login and the decisions)
```

The path of a data request:

1. **The gateway forwards.** Shuttle signs the identity of the caller
   and forwards the request to the backend with the header
   `x-shuttle-signature`.
2. **The backend verifies the signature.** It rebuilds the canonical
   payload of the gateway from the method, the path, the query, the
   host and the headers, and it verifies it with the public key of the
   route. The transmitted payload is never an input of the decision.
3. **The backend resolves the workspace.** It reads the registry of the
   workspaces with a narrow reader, and it reads the catalog of the
   workspace — its collections and its bundle of policies — in the same
   statement.
4. **The backend asks Hub for the context.** The request carries the
   subject, the tenant of the workspace, the workspace and the route;
   Hub answers the permission keys of the principal, or a refusal.
5. **The backend enforces the policies.** The scope is set on the
   transaction, the statement projects only the fields that a policy
   grants, and the write is authorized by one complete policy.
6. **The backend commits.** The record, the audit entry, the domain
   event and the receipt of a creation commit in one transaction.

The order of the steps is fixed. A business operation never starts
without a verified principal and a resolved workspace, and the context
of Hub is fetched outside of the transaction of the business data.

## The storage

PostgreSQL 15 or later, with the row level security of the database as
the isolation of the tenants and of the workspaces.

Every business table carries `tenant_id` and `workspace_id`, and the
scope is set on the transaction with `set_config(…, true)`. A pooled
connection never carries the scope of another request, and a statement
that runs without a scope is refused by the policies of the tables.

The separation of the privileges is the point of the design: the
migration owner, the runtime role of the api, the narrow registry
reader, the delivery role and the maintenance role are five different
roles, and the api never holds the credentials of the other four. The
roles are in [migrations.md](migrations.md).

The tables are created by the reviewed migrations of the repository. The
service never creates a table and never alters one while it runs.

## The catalog of a workspace

The **catalog** of a workspace is what it serves: the collections it
registered and the bundle of policies that applies to it. The
deployment holds a default catalog, and a workspace may hold its own.

The catalog is a **logical registry**. It never creates a table and
never alters one: a registration names a collection of the deployment
manifest and the table that the deployment declares for it. The
physical schema stays global and reviewed, and the logical schema is
per workspace.

- A workspace that registered nothing serves every collection of the
  deployment.
- A workspace that registered something serves exactly the registered
  and enabled collections. The others answer `404 NOT_FOUND`.
- The registration and the publication of a bundle are operator
  commands, never HTTP routes: a bundle says what a permission grants,
  and the grants of a principal are the business of Hub.

The catalog is read with the registry of the workspaces, in one
statement, and nothing is cached from the database: a bundle that was
published is visible in the next request.

## The events and the worker

Every committed mutation writes a domain event in the same transaction
as the record. The events are delivered to the subscribers that the
deployment registered in the composition root, at least once, and they
may arrive out of order.

The worker claims the deliveries with leases, so several workers can
run at the same time. A subscriber that needs current data reads it
through an authorized domain read, with the fresh context of the
service principal of the worker: the identity of the user that started
the chain is an attribution, never a credential.

## The boundaries of the code

| Layer | What it owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. |
| `src/app/` | The routes, the parsing, the establishment of the context, the mapping of the failures. |
| `src/domains/<domain>/` | The rules, the use cases, the ports and the public entry point of a domain. |
| `src/domains/<domain>/adapters/` | The concrete implementations of the ports. |
| `src/platform/bun/` | The listener and the transport. |
| `src/platform/postgres/` | The connections, the scoped transactions, the statements, the migrations. |
| `src/runtime/` | The configuration, the composition root, the subscribers, the readiness, the drain. |
| `src/observability/` | The logs and the metrics. |
| `test/` | The suites of the tests. |

The domains may only import each other along this matrix:

| Domain | It may import |
| --- | --- |
| `gateway-context`, `workspaces`, `schema`, `audit`, `events` | nothing |
| `authorization` | `gateway-context`, `workspaces`, `schema` |
| `catalog` | `schema`, `authorization`, `workspaces` |
| `records` | `gateway-context`, `workspaces`, `schema`, `authorization`, `audit`, `events` |

The core of a domain imports no framework, no runtime and no adapter.
Only the composition root builds the concrete adapters. The check
`bun run architecture` refuses a violation, and it refuses a cycle,
even a cycle of types.

## The process roles

One binary, three roles, chosen with `DATA_PROCESS_ROLE`:

| Role | What it does |
| --- | --- |
| `api` | The endpoints and the probes. |
| `worker` | The claims of the deliveries. |
| `all` | Both. The default of a development machine. |

An api process needs the bindings of the gateway and the key of the
cursors. A worker needs the credentials of the deliveries and the
principal of the service principal.
