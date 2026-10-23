# The configuration of the service

The environment is read once, at the start of the process, and it is
validated as a whole: every problem is reported at once, and a value
that cannot be understood stops the service. A setting that looks
active but is not is a security hole.

The names of the variables never leave the configuration module: the
rest of the service receives the settings it needs, not the
environment. **A secret is a file, never a value of the environment**:
the process list of a machine is visible, and the logs are not private.

## The variables of the process

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_HOST` | `127.0.0.1` | The address the listener binds. In production, bind an explicitly protected service interface. |
| `DATA_PORT` | `8082` | The port of the listener. |
| `DATA_PROCESS_ROLE` | `all` | `api`, `worker` or `all`. |
| `DATA_ENVIRONMENT` | `development` | `production` turns on the checks of the transport and of the secrets. |
| `DATA_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## The database

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_DATABASE_URL` | required | The credentials of the scoped data role: the rows of the scope of the transaction, and nothing else. |
| `DATA_REGISTRY_DATABASE_URL` | required | The narrow reader of the registry of the workspaces. |
| `DATA_DELIVERY_DATABASE_URL` | the data url | The metadata of the deliveries. It is required when workers run. |

In production, a remote database url must ask for a protected
transport (`sslmode=require`).

The pools are bounded: `DATA_DB_POOL_MAX` connections of the data role
per process, and five connections each for the registry and for the
delivery pools.

## The artifacts of the deployment

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_SHUTTLE_BINDINGS_FILE` | required for an api | The routes the deployment accepts, and the verification of their identities. |
| `DATA_LEGACY_IDENTITY` | `refuse` | What the service does with the legacy verification of the identity: `refuse`, `warn` or `allow`. The legacy format is symmetric: the backend holds the derived secret of the gateway and it can sign an identity with it. The version `1.0.0` refuses it, and it is removed in the version `2.0.0`. |
| `DATA_SCHEMA_BUNDLE_FILE` | required | The manifests of the collections. |
| `DATA_POLICY_BUNDLE_FILE` | required | The bundle of the policies. |
| `DATA_CURSOR_KEY_FILE` | required | The key that signs the cursors of the pages. At least 32 bytes, and it is not a key of the gateway. |

The manifests and the policies are immutable per generation of the
process, and their version is the digest of their content.

## The hub

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_HUB_URL` | required | The base url of Hub. It must be `https` in production: the credential of the context travels with it. |
| `DATA_HUB_CONTEXT_TOKEN_FILE` | required | The file of the service credential of the access context contract. |
| `DATA_CONTEXT_CACHE_TTL_MS` | `0` | The lifetime of the read only cache of the context, from 0 to 5000. The default is no cache: a mutation and a worker command always ask for a fresh one. |
| `DATA_CONTEXT_CACHE_MAX_ENTRIES` | `4096` | The number of the entries of the cache of the context. The cache is bounded: the entry that is the least recently used leaves it when it is full, and the entries that are spent leave it when it is written. |
| `DATA_HUB_TIMEOUT_MS` | `1000` | The bound of a call to Hub. |

## The budgets

| Variable | Default | What it bounds |
| --- | --- | --- |
| `DATA_REQUEST_TIMEOUT_MS` | `10000` | The whole work of a request. |
| `DATA_DB_STATEMENT_TIMEOUT_MS` | `3000` | A statement. The server cancels it. |
| `DATA_DB_TRANSACTION_TIMEOUT_MS` | `5000` | A transaction. The connection is destroyed when the budget is spent. |
| `DATA_DB_ACQUIRE_TIMEOUT_MS` | `1000` | The wait for a connection. |
| `DATA_MAX_BODY_BYTES` | `1048576` | The body of a request. The body of a record is 256 KiB. |
| `DATA_MAX_IN_FLIGHT_REQUESTS` | `200` | The requests that are handled at the same time. The excess is refused, not queued. |
| `DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT` | the value of `DATA_MAX_IN_FLIGHT_REQUESTS` | The requests of a tenant that are handled at the same time. The default is the bound of the whole process: a deployment with one tenant gives the whole room to its tenant, and a deployment with several declares the room that each of them holds. The excess is a `429 TOO_MANY_REQUESTS` and not a `503 OVERLOADED`. |
| `DATA_DRAIN_MS` | `30000` | The budget of the drain. |
| `DATA_DB_POOL_MAX` | `20` | The connections of the data role of the process. |

The effective timeout of a request is the smallest of the budgets that
apply to it. A timer that leaves a statement running is not a
cancellation: the statement timeout is a server side cancellation, and
the transaction timeout destroys the connection, so the server rolls
the transaction back.

## The worker

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_WORKER_PRINCIPAL_ID` | required when workers run | The principal the worker acts as. |
| `DATA_WORKER_ROUTE_ID` | required when workers run | The route the worker acts on, typically `data-worker`. |
| `DATA_WORKER_CONCURRENCY` | `4` | The deliveries that are handled at the same time. |

## The observation

| Variable | Default | What it is |
| --- | --- | --- |
| `DATA_METRICS_TOKEN_FILE` | absent | The token that guards the metrics endpoint. Without it, the endpoint is absent and answers `404`. |
| `DATA_LOG_LEVEL` | `info` | The level of the log. |

## The variables of the operator commands

The credentials of the operator commands are never in the environment
of the api. Each command reads the one it needs.

| Variable | The command |
| --- | --- |
| `DATA_ADMIN_DATABASE_URL` | `provision.ts`, `restore.sh` — the administrator of the server. |
| `DATA_OWNER_DATABASE_URL` | `migrate.ts`, `workspace.ts`, `collection.ts`, `policy.ts` — the owner of the schema. |
| `DATA_MAINTENANCE_DATABASE_URL` | `retention.ts` — the maintenance role. |
| `DATA_DELIVERY_DATABASE_URL` | `delivery.ts` — the metadata of the deliveries. |
| `DATA_BACKUP_DATABASE_URL`, `DATA_BACKUP_DIR` | `backup.sh`. The role of the backup bypasses the row level security: the backup holds the rows of every tenant. |
| `DATA_BACKUP_FILE`, `DATA_RESTORE_DATABASE`, `DATA_RUNTIME_DATABASE_URL` | `restore.sh`. |
| `DATA_AUDIT_RETENTION_DAYS`, `DATA_RECEIPT_RETENTION_HOURS`, `DATA_EVENT_RETENTION_DAYS`, `DATA_VERSIONS_RETENTION_DAYS`, `DATA_RETENTION_ACTOR` | `retention.ts`. |
| `DATA_MIGRATIONS_DIR` | `migrate.ts` — the directory of the migrations, `./migrations` by default. |
| `DATA_OWNER_PASSWORD`, `DATA_RUNTIME_PASSWORD`, `DATA_REGISTRY_PASSWORD`, `DATA_DELIVERY_PASSWORD`, `DATA_MAINTENANCE_PASSWORD` | `provision.ts` — the passwords of the roles. They are never printed. |

## The file of the bindings

The file of the bindings names the routes that the deployment accepts
and the verification of the identity of every route. Its shape is
`{"version": 2, "bindings": [...]}`, with at most 100 bindings.

| Field | What it is |
| --- | --- |
| `id` | The local name of the route, for the diagnostics. |
| `host` | The exact public authority that the gateway signs, lowercase ASCII, with the port when there is one. |
| `upstreamPathPattern` | The path the backend receives, with exactly one `{workspaceId}` segment and a terminal `/*`. |
| `routeId` | The route scope of Hub that corresponds to the route of the gateway. |
| `expectedTenantId` | Optional. The restriction of the route to one tenant. |
| `identity.version` | `v5` for the current format, `v4` for the legacy one. |
| `identity.algorithm` | `ES256` with a public key, `HS256` with the derived key. |
| `identity.publicKeyFile` | The file of the public key of the gateway, on the curve P-256, in pem. |
| `identity.identityKeyFile` | The file of the derived key of the legacy format. |

The version, the algorithm and the file of the key have to agree: a
binding that names an algorithm that does not belong to its version, or
a file of the wrong kind of key, is refused. A route of the version
`v5` refuses the version `v4`, and a legacy route never accepts a
public key as its secret. There is no fallback after a failed
verification.

The bindings must be unambiguous over the signed host, the received
path and the verifying key. An ambiguity stops the startup.

## The manifest of the collections

`DATA_SCHEMA_BUNDLE_FILE` is a UTF-8 JSON file of at most 1 MiB,
validated against a strict schema. The unknown properties are refused.

```json
{
  "version": 1,
  "schemaVersion": "articles-v1",
  "collections": [
    {
      "key": "articles",
      "table": "data.articles",
      "label": "Articles",
      "fields": {
        "title": {
          "type": "string",
          "required": true,
          "nullable": false,
          "maxLength": 240
        }
      },
      "search": { "fields": ["title"], "config": "english" },
      "relations": {
        "category": {
          "target": "categories",
          "type": "many-to-one",
          "field": "category_id"
        }
      }
    }
  ]
}
```

| Part | What it holds |
| --- | --- |
| `key` | The name of the collection. It matches `^[a-z][a-z0-9_]{0,62}$`, and it is what a caller uses in a path. |
| `table` | The physical table of the deployment, as `schema.table`. The mapping is deployment controlled, and a request never chooses it. |
| `fields` | The types, the nullability, the defaults and the bounds. The types are `string`, `text`, `boolean`, `integer`, `decimal`, `uuid`, `timestamp`, `json` and `enum`. A field may also declare `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `default`, `label` and `description`. |
| `search.fields` | The fields of the text search of the collection, and the configuration of the text search of the database. |
| `relations` | The registered relations. Version 0.1 supports many-to-one references and derived one-to-many reads. |
| `label`, `description` | The semantic metadata. The presentation of a studio is not here. |

The manifest never holds executable scripts, widget identifiers or page
layouts. The runtime fields of a record — `id`, `tenant_id`,
`workspace_id`, `created_by`, `created_at`, `updated_by`, `updated_at`
and `version` — are added by the service and a client may never write
them.

## The bundle of the policies

`DATA_POLICY_BUNDLE_FILE` is a UTF-8 JSON file of at most 1 MiB with
at most 1000 policies.

```json
{
  "version": 1,
  "policies": [
    {
      "id": "edit-own-articles",
      "permission": "content.editor",
      "collection": "articles",
      "action": "update",
      "where": { "created_by": { "_eq": "$principalId" } },
      "check": { "created_by": { "_eq": "$principalId" } },
      "fields": ["title", "body"]
    }
  ]
}
```

| Field | What it is |
| --- | --- |
| `id` | The stable name of the policy. It is recorded in the audit. |
| `permission` | The permission key of Hub that the policy applies to. |
| `collection` | The collection of the manifest. |
| `action` | `read`, `create`, `update` or `delete`. |
| `where` | The predicate of the rows the policy covers. |
| `check` | The predicate of the resulting row of a creation or of an update. |
| `fields` | The fields the policy grants. |

`$principalId`, `$tenantId` and `$workspaceId` are typed server
substitutions. They are not evaluated code.

The policies are allow rules: no matching rule means deny. A write is
allowed only when **one** complete policy authorizes it; the predicates
and the fields of two policies are never mixed.
