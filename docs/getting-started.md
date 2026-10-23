# The development machine

The instructions of this document take a checkout to a running
service. They are the shortest path that exercises the whole trust
chain: a signed request, a real PostgreSQL, the real roles and the
real migrations.

## What you need

| Tool | Version |
| --- | --- |
| [Bun](https://bun.sh) | 1.4.3 or later |
| PostgreSQL | 18, with the binaries of the server in the path |
| Docker | only for the stack of the development machine |

The integration tests start a PostgreSQL server of their own, in
`.pg/test-data`, so a local server is not needed for them. The
compatibility harness starts one in a temporary directory.

The version 18 is the version that the suites prove. A deployment may
run PostgreSQL 15 or later, and the requirement of a deployment is in
[the readme](../README.md); it is not the version of the machine of a
developer.

## The steps

```bash
bun install
cp .env.example .env                      # and change the secrets
bun run scripts/provision.ts               # the roles and the database
bun run migrate                            # the schema
bun run workspace -- create --id 22222222-2222-4222-8222-222222222222 \
  --tenant aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --slug acme
bun run start
```

The service listens on `127.0.0.1:8082` by default, and it answers:

```bash
curl -s http://127.0.0.1:8082/healthz
curl -s http://127.0.0.1:8082/readyz
```

`/healthz` answers while the process is alive. `/readyz` answers `200`
only when the configuration, the schema, the privileges of the role and
the discovery of Hub are in order.

The data paths need a signed request, so a plain `curl` of `/ws/…`
answers `401 UNAUTHENTICATED`: the gateway signs the identity and the
backend verifies it. The client of the API does the same thing through
the gateway.

## The environment

`.env.example` is the reference of the variables, and
[configuration.md](configuration.md) is their full description. The
values of the example are the values of a development machine, and they
are not secrets.

The secrets are files, and they are read at the start of the process. The
committed fixtures of the development machine are in `deploy/secrets/`,
and the paths of `.env.example` (`./secrets/…`) are the ones a
deployment mounts:

| File | What it holds |
| --- | --- |
| `hub-context.token` | The credential of the access context at Hub. |
| `cursor.key` | The key that signs the cursors of the pages. At least 32 bytes, and it is not a key of the gateway. |
| `metrics.token` | The token that guards the metrics endpoint. Without it the endpoint is absent. |
| `identity.public.pem` | The **public** key of the gateway of the development machine. |

The private key of the pair of the gateway is **not** in the
repository: the gateway of the machine holds it, and it is generated
with the script of the gateway (`bun run identity:key`).

## The bindings of the gateway

The service reads the routes the deployment accepts from
`DATA_SHUTTLE_BINDINGS_FILE`. The file holds the routes and the
verification of the identity of every route: the version of the
signature, the algorithm and the file of the key.

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

A binding may also name `expectedTenantId`, and it restricts the route
to one tenant of Hub.

## The migration from the shared key

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

A binding of the legacy mode names the version, the algorithm and the
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

## The stack of the development machine

```bash
docker compose up --build
```

The compose file starts the database, it provisions the roles, it
applies the migrations and it runs the api. The gateway and the hub are
not part of it: they are the services of the platform, and the
compatibility harness runs the three of them together against the
pinned revisions — see [compatibility.md](compatibility.md).

The compose file runs the api only. The worker claims the deliveries of
the events, and it needs a principal that Hub knows:

```
DATA_PROCESS_ROLE=all
DATA_WORKER_PRINCIPAL_ID=<the uuid of the principal of the worker>
DATA_WORKER_ROUTE_ID=data-worker
```

## The files of `deploy/`

The files of `deploy/` are the fixtures of a development machine, and
they are committed on purpose:

| File | What it holds |
| --- | --- |
| `bindings.json` | The routes of the machine, and the verification of their identities. |
| `secrets/identity.public.pem` | The public key of the gateway of the machine. |
| `secrets/identity.key` | The **legacy** derived key of the gateway. It is a signing capable secret, and it belongs inside the trust boundary of the gateway. |
| `secrets/hub-context.token` | The credential of the deployment at the hub of the access context contract. |
| `secrets/cursor.key` | The key that signs the cursors of the pages. |

**These values are not secrets.** They are committed, and anyone who
reads the repository knows them. A deployment mounts the credentials of
its secret manager, and it never writes them in an image.

## The first record

With the service running and a workspace created, the operator
registers the collections it serves and publishes a bundle of policies:

```bash
export DATA_OWNER_DATABASE_URL=postgres://data_owner:...@127.0.0.1:5432/depot

bun run collection -- register \
  --workspace 22222222-2222-4222-8222-222222222222 --collection articles

bun run policy -- publish \
  --workspace 22222222-2222-4222-8222-222222222222 \
  --file manifests/policies.json
```

The operator commands run with the credentials of the owner of the
schema, and they never run inside the api.

A workspace that registered nothing serves every collection of the
deployment, so the two commands are optional on a machine that only
wants to see the service answer.
