# Headless Data Backend — Specification
**Runtime:** TypeScript on Bun; Hono at the HTTP boundary; PostgreSQL in production.  
**Delivery:** A standalone backend repository and deployable. Studio is a separate project.

## Contents

1. [Purpose and authority](#1-purpose-and-authority)
2. [Release scope and invariants](#2-release-scope-and-invariants)
3. [Deployment and request topology](#3-deployment-and-request-topology)
4. [Shuttle trust contract](#4-shuttle-trust-contract)
5. [Required Hub access-context extension](#5-required-hub-access-context-extension)
6. [Workspaces, context, and database isolation](#6-workspaces-context-and-database-isolation)
7. [Schema and collection model](#7-schema-and-collection-model)
8. [Data authorization](#8-data-authorization)
9. [HTTP API](#9-http-api)
10. [Mutation and transaction rules](#10-mutation-and-transaction-rules)
11. [Persistence, audit, and domain events](#11-persistence-audit-and-domain-events)
12. [Typed client and independent Studio contract](#12-typed-client-and-independent-studio-contract)
13. [Architecture and code boundaries](#13-architecture-and-code-boundaries)
14. [Configuration and resource limits](#14-configuration-and-resource-limits)
15. [Operations and data lifecycle](#15-operations-and-data-lifecycle)
16. [Verification and release acceptance](#16-verification-and-release-acceptance)
17. [Implementation sequence and completion criteria](#17-implementation-sequence-and-completion-criteria)
18. [Decisions fixed by this draft](#18-decisions-fixed-by-this-draft)

## 1. Purpose and authority

The Data Backend provides reusable, permission-aware data APIs for applications behind Shuttle. It uses Hub as the authority for principals, tenants, groups, and grants. It owns workspaces, registered collections, record operations, data policies, audit history, and committed domain events.

This document is the normative contract for the first release. MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY indicate requirement strength. A behavior described as deferred is outside version 0.1 and MUST NOT be advertised as available.

Examples are illustrative configuration and protocol fixtures. They do not describe features already present in Shuttle or Hub. Proposed Hub endpoints in section 5 are required integration changes.

### 1.1 Existing references

<!-- compatibility-baseline:start -->

The baseline of the integration is the one of `compatibility.json`: the
one file of this repository that owns the repositories of the gateway and
of the hub and the revisions that are tested against them.

| Project | Repository | Revision |
| --- | --- | --- |
| Shuttle | https://github.com/ggpwnkthx/shuttle.git | `1199d6d350be86b0081cb367e022722649825544` |
| Hub | https://github.com/ggpwnkthx/hub.git | `c52681fb3164ee952df93ae9dec8317dc6f9ce91` |

<!-- compatibility-baseline:end -->

The revisions are full commits: they are immutable, and a change of the
baseline is a change of the manifest and a new run of the compatibility
harness.

Additional implementation evidence:

- [Shuttle architecture](https://github.com/ggpwnkthx/shuttle/blob/1199d6d350be86b0081cb367e022722649825544/docs/architecture.md).
- [Shuttle identity signature](https://github.com/ggpwnkthx/shuttle/blob/1199d6d350be86b0081cb367e022722649825544/src/domains/forwarding/identity.ts).
- [Hub decision query](https://github.com/ggpwnkthx/hub/blob/c52681fb3164ee952df93ae9dec8317dc6f9ce91/src/platform/postgres/decisions.ts).
- [Hub transaction-scoped tenant isolation](https://github.com/ggpwnkthx/hub/blob/c52681fb3164ee952df93ae9dec8317dc6f9ce91/src/platform/postgres/scope.ts).

A compatibility change requires updating the manifest and passing the integration suite. Hub's integration changes are implemented in its own repository and must preserve the existing gateway contract. The revisions of the earlier baseline are historical evidence of the release `v0.1.0` and they stay in the release notes of this repository: they are not the active baseline.

### 1.2 Service ownership

| Owner | Responsibility |
| --- | --- |
| Tenant identity provider | Authenticate the external identity. |
| Hub | Broker login; map identities to principals; own tenants, groups, permission keys, and scoped grants. |
| Shuttle | Maintain browser sessions; validate caller credentials; ask Hub about workspace/route admission; apply gateway limits; forward requests with signed identity. |
| Data Backend | Verify upstream identity; establish tenant/workspace scope; resolve current grants; enforce record and field policies; expose data and metadata APIs. |
| Studio, a separate project | Browser application, navigation, forms, tables, dashboards, preview UI, and other presentation behavior. |
| Other clients | Websites, application servers, scripts, and future tool integrations consuming the headless API. |

Hub's tables remain private to Hub. The Data Backend MUST NOT query or mutate them directly, expose them as collections, or maintain a second identity/grant database.

### 1.3 Headless boundary

The service MUST:

- Expose versioned HTTP APIs and machine-readable schema metadata.
- Work without Studio being installed, running, or reachable.
- Support independent clients through the same domain operations and authorization rules.
- Publish an OpenAPI description and a small typed client package.

The service MUST NOT serve a Studio application, login page, dashboard, form renderer, theme system, visual workflow editor, or web preview application. It MUST NOT depend on a Studio repository, package, origin, or release version.

Collection metadata may contain semantic labels and descriptions. Widget identifiers, component implementations, page layouts, navigation state, and presentation preferences belong to Studio. Backend validation and policy evaluation MUST NOT depend on client presentation metadata.

## 2. Release scope and invariants

### 2.1 Required in version 0.1

| Capability | Required behavior |
| --- | --- |
| Gateway integration | Verify Shuttle v5 identity signatures with the public key of the gateway, and map verified requests to trusted route bindings. The legacy v4 format is a migration path and it is never the default. |
| Hub integration | Obtain authoritative, current access context through the proposed contract in section 5. |
| Workspaces | Maintain workspace-to-tenant ownership and enabled/disabled state. |
| Registered collections | Load declarative collection manifests backed by reviewed SQL migrations. |
| Catalog of a workspace | Register the collections a workspace serves and publish the bundle of policies that applies to it, without altering the physical schema. |
| Headless metadata | Return policy-filtered collection, field, relation, and action metadata. |
| Record API | Create, list, fetch, update, and delete records with bounded queries and optimistic concurrency. |
| Aggregates | Group the rows that a list would read, with bounded groups and the same predicates and filters. |
| Authorization | Enforce tenant/workspace isolation, action permissions, row predicates, field visibility, and write checks. |
| Audit | Record committed mutations in an append-only audit log. |
| Events | Commit an outbox event with each mutation; deliver to trusted, code-registered subscribers. |
| Client contract | OpenAPI, versioned error responses, and a typed client using caller-supplied credentials/fetch. |
| Operations | Health/readiness probes, bounded resources, metrics, structured logs, migrations, backups, and graceful drain. |

### 2.2 Deferred capabilities

| Capability | Future integration boundary |
| --- | --- |
| Files and media | Asset domain; bytes in object storage; metadata and authorization in this backend. |
| Drafts, publishing, revisions, translations | Content domain using the same record authorization and transaction mechanisms. Audit is not a revision store. |
| Public realtime subscriptions | Subscription domain over committed events, with continuing authorization and revocation handling. Shuttle supplies transport proxying. |
| Webhooks, schedules, configurable workflows | Delivery/jobs domains using outbox events and explicit service-principal authority. |
| GraphQL | Another transport over the same query and command services. |
| Bulk writes, exports | Bounded operations using the same row and field rules; no separate privileged query path. The aggregates of section 9.8 and the searches of section 9.9 are the exceptions: they are bounded and they use the same row and field rules. |
| Runtime schema editing and arbitrary database introspection | Versioned schema-management contract and reviewed migration workflow. The catalog of a workspace is a logical registry and it never creates or alters a table. |
| Editing the policies of a workspace over HTTP | The publication of a bundle is an operator command. An endpoint that writes policies would be an authority that bypasses Hub, and the grants of a principal stay the business of Hub. |
| Marketplace or uploaded extensions | Explicit execution and trust model. Version 0.1 only allows code registered by the deployer. |
| MCP and AI features | Clients/adapters invoking authorized domain operations. |
| Additional database engines | Storage adapters after their transaction, isolation, and query semantics are specified. |
| Studio and visual analytics | External client project; outside this service's implementation and release criteria. |

Deferred endpoints MUST be absent, rather than return successful placeholder results. The service MUST NOT claim Directus feature parity.

### 2.3 Non-negotiable invariants

1. No business-data operation starts without a trusted principal and a resolved workspace/tenant context.
2. A workspace belongs to exactly one Hub tenant. Workspace ownership is immutable in version 0.1.
3. Authentication, workspace admission, and data authorization are separate checks.
4. An enabled workspace and any Hub grant do not imply permission to access every collection or perform every action.
5. Forwarded roles and email addresses are never authoritative data permissions.
6. Missing context, unavailable authorization dependencies, unknown policy, and incomplete capability responses fail closed.
7. Every business-record query is tenant/workspace scoped, including relation lookups and validation queries.
8. Client input cannot select a tenant, change a workspace owner, choose SQL identifiers, supply server audit fields, or execute SQL.
9. A committed business-record mutation includes its audit entry and outbox event in the same PostgreSQL transaction.
10. API clients, internal subscribers, and future transports use the same domain authorization services.
11. A runtime database role cannot bypass the required isolation policies.
12. Background execution uses its own explicit authority; an initiating user's historical headers are not reusable credentials.

## 3. Deployment and request topology

~~~mermaid
flowchart TD
    Clients["Studio or other API clients"] --> Shuttle["Shuttle"]
    Shuttle -->|"Login and workspace admission"| Hub["Hub"]
    Shuttle -->|"Signed request"| Backend["Data Backend"]
    Backend -->|"Current scoped access context"| Hub
    Backend --> Database["PostgreSQL"]
    Database -->|"Outbox deliveries"| Worker["Subscriber worker"]
    Worker -->|"Authorized domain commands"| Backend
~~~

Arrows show requests and event delivery. Studio is an external client and a separate deployable.

### 3.1 Supported topology

A straightforward initial deployment has tenant-specific Shuttle deployments pointing to a shared Hub and shared Data Backend. Hub's shared-client topology is also compatible when explicitly configured and covered by compatibility tests.

The backend does not change how Shuttle selects an identity provider. Sharing a backend does not require adding tenant-aware login behavior to Shuttle.

Production ingress to data endpoints MUST be restricted to the configured gateway trust boundary. TLS termination and private/service transport are deployment responsibilities.

Separate projects may be mounted behind the same public origin. Version 0.1's browser integration assumes that arrangement. Cross-origin cookie sessions and unauthenticated browser preflight routing require a separately specified ingress/CORS contract; Studio being a separate project does not imply a separate browser origin.

### 3.2 Public paths

Workspace APIs use:

`/ws/{workspaceId}/v1/...`

Shuttle preserves the request path. The backend MUST accept that complete path and MUST NOT assume that the gateway strips `/ws/{workspaceId}` or an upstream base path.

A deployment using an upstream base path includes that path in both its backend router and its trusted binding. The signature is verified against the path as received upstream.

Operational probes and metrics use dedicated, non-business endpoints. There is no public backend login, logout, password, or token-issuance endpoint.

## 4. Shuttle trust contract

### 4.1 Trusted route bindings

The deployer provides an immutable binding configuration for each accepted gateway route:

| Field | Meaning |
| --- | --- |
| `id` | Local identifier for diagnostics. |
| `host` | Exact signed public authority, including a non-default port when applicable. |
| `upstreamPathPattern` | Backend-received path pattern containing the workspace parameter. |
| `routeId` | Hub route scope corresponding to the actual Shuttle route. |
| `identity` | The verification of the signatures of the route: the expected version, the permitted algorithm, and the file of the key. |
| `expectedTenantId` | Optional tenant restriction for a tenant-specific gateway. |

The `identity` of a binding names the three values that belong together:

| Version | Algorithm | File of the key | Meaning |
| --- | --- | --- | --- |
| `v5` | `ES256` | `publicKeyFile` | The public key of the gateway, on the curve P-256. The gateway holds the private one. |
| `v4` | `HS256` | `identityKeyFile` | The legacy derived key of the gateway. It is a signing-capable secret and it is a migration path only. |

The version, the algorithm, and the name of the file of the key MUST agree: a binding that names an algorithm that does not belong to its version, or a file of the wrong kind of key, is refused. The backend MUST NOT infer the version, the algorithm, or the key from a request, from a header, or from a fallback after a failed verification. A route of the version `v5` MUST refuse the version `v4`, and a legacy route MUST NOT accept a public key as its secret.

Bindings MUST be unambiguous over the signed host, received path, and verifying key. Configuration ambiguity stops startup.

The file shape is `{"version":2,"bindings":[...]}`, with at most 100 bindings. `host` is a lowercase ASCII DNS authority (punycode where needed) with an explicit port when required. `upstreamPathPattern` contains literal path segments, exactly one `{workspaceId}` segment, and a terminal `/*` remainder; it accepts no executable regex or other substitutions. A typical pattern is `/ws/{workspaceId}/v1/*`; a configured upstream base path appears literally before it. UUID segments cannot contain encoded separators, backslashes, or dot segments. The backend verifies the original signed target bytes before using normalized routing values.

The file of the version 1 held one derived identity key per binding. It is still read, as the legacy mode it is, and it is the migration path of a deployment that still shares a key with its gateway. A deployment that writes the version 2 does not use it any more, and the deployment of the key of the gateway is the only way to leave the legacy mode.

Shuttle does not forward a signed `routeId` or a tenant identifier. The backend MUST derive the route ID from the matching operator-controlled binding. It MUST NOT accept a client-supplied route ID, tenant header, or decoded-but-unverified claim as a substitute.

### 4.2 Identity verification

For each data request, the backend MUST:

1. Identify candidate bindings from the received path and signed forwarded host.
2. Reject missing, duplicated, malformed, or conflicting required identity headers.
3. Require `x-shuttle-signature` with the `v5=` prefix of the route, and refuse every other version.
4. Reconstruct the exact canonical Shuttle payload of that version, using received method, upstream-received path, raw query string, forwarded host, subject, workspace, optional email, and sorted roles.
5. Verify the detached JWS with the public key of the route, allowing only `ES256` and the expected protected-header type `shuttle-identity`. The payload of the signature MUST be detached, and a critical header the backend does not know MUST be refused.
6. Only after successful verification, validate and normalize the principal/workspace UUIDs.
7. Require the signed workspace to equal the workspace in the path.
8. Match exactly one binding and reject a host/path/identity combination outside that binding.

Canonical serialization, field order, role handling, and signature fixtures MUST match the pinned Shuttle contract. Values MUST NOT be normalized before reconstructing the signed bytes.

The backend receives the **public** verification key of the gateway, not `SHUTTLE_SESSION_SECRET` and not the private signing key of the gateway. A backend that can verify an identity cannot mint one: the trust boundary is the key and not the network. The key of a route is loaded and validated at startup, and a key that cannot be loaded stops the service.

The legacy format `v4` is the symmetric one: its key is derived from the secret of the sessions of the gateway, it is a signing-capable secret, and it belongs only inside the gateway/upstream trust boundary. It is a migration path: a deployment that configures it is a deployment whose upstream can mint identities. Key replacement is a coordinated deployment operation.

The signature binds request target and identity. It does not bind the body or provide a timestamp/nonce. The backend MUST NOT present it as an anti-replay mechanism or a substitute for protected transport.

### 4.3 Credential handling

The backend MUST NOT create a second browser session or reimplement Hub's login flow. Caller authorization headers and cookies are not used to resolve data permissions.

Gateway routes SHOULD set `forwardAuthorization: false` when the upstream does not require the original bearer token. The backend MUST NOT log forwarded credentials.

The principal is the Hub principal UUID carried as Shuttle's subject. Email is an optional display value. Forwarded roles are optional diagnostic context and MUST NOT determine data access.

Missing/invalid gateway proof yields `401 UNAUTHENTICATED`. A signed/path workspace mismatch or an ambiguous binding yields the same generic rejection without revealing policy or tenant details.

## 5. Required Hub access-context extension

**Integration status:** Implemented. Hub carries the two endpoints since `4cedcfc48e9bb4eb556d2316eb502e1ab87d3105`, and the Hub baseline of this release is the revision of the manifest of §1.1, which carries it. The change lives in the repository of the hub, not in a copy of this repository; the compatibility harness proves the contract against the real hub.

The backend MUST NOT substitute Hub's admin API, direct SQL, forwarded roles, or the boolean `/v1/decisions` answer for this contract. Shuttle continues to use its existing decision endpoint.

### 5.1 Service authentication and discovery

Both methods on `/v1/access-context` require a dedicated read-only service credential over protected transport:

`Authorization: Bearer <access-context service credential>`

Hub MUST restrict that credential to an explicit set of tenant UUIDs. An explicitly provisioned platform-wide credential is permitted for a shared backend; that scope must be a deployment choice, not the default of a tenant credential. These credentials do not authorize Hub administration or grant creation.

`GET /v1/access-context` returns:

~~~json
{
  "versions": [1],
  "maxPermissionKeys": 4096,
  "maxLifetimeMs": 5000
}
~~~

The backend uses this authenticated discovery contract for compatibility/readiness checks. Unknown contract versions stop readiness.

### 5.2 Context request

`POST /v1/access-context` accepts:

~~~json
{
  "version": 1,
  "subject": "11111111-1111-4111-8111-111111111111",
  "tenantId": "22222222-2222-4222-8222-222222222222",
  "workspaceId": "33333333-3333-4333-8333-333333333333",
  "routeId": "data-api"
}
~~~

- `subject` comes from verified gateway identity, or an explicitly configured internal service principal.
- `tenantId` comes from the backend's workspace registry.
- `workspaceId` comes from the verified request and resolved registry entry.
- `routeId` comes from a trusted route binding or internal worker configuration.
- The body is bounded to 64 KiB; unknown fields and invalid types are rejected.

Hub MUST evaluate one consistent policy snapshot and require:

1. The service credential may ask about the requested tenant.
2. The principal exists, is active, and belongs to that tenant.
3. The tenant is enabled.
4. At least one enabled, unrevoked, unexpired grant applies to that principal or a current group membership.
5. Each returned permission comes from a grant whose workspace and route scopes match this request, or whose respective scope is unrestricted.

Hub does not own a workspace catalog in the baseline. The supplied tenant/workspace ownership relationship is the backend's responsibility. Hub MUST still verify the principal's tenant rather than merely echo the requested tenant.

### 5.3 Context response

A successful allowance returns:

~~~json
{
  "version": 1,
  "allow": true,
  "subject": "11111111-1111-4111-8111-111111111111",
  "tenantId": "22222222-2222-4222-8222-222222222222",
  "workspaceId": "33333333-3333-4333-8333-333333333333",
  "routeId": "data-api",
  "permissionKeys": ["content.editor", "content.reader"],
  "evaluatedAt": "2026-10-21T16:00:00.000Z",
  "validUntil": "2026-10-21T16:00:05.000Z"
}
~~~

`permissionKeys` MUST be the complete, sorted, deduplicated set of enabled permission keys from matching live user/group grants. It MUST NOT inherit the token's 64-role truncation.

The response limit is 4,096 keys and 512 KiB. Exceeding either bound is an error, never a partial allowance.

`validUntil` MUST be no later than `evaluatedAt + 5000 ms` and no later than the earliest expiry among contributing grants. Conservative early expiry is acceptable. It is not a promise that a grant cannot be revoked earlier.

A denial uses HTTP `200`, echoes the bound context fields, sets `allow: false` and `permissionKeys: []`, and omits `validUntil`. It does not disclose whether the cause was an unknown principal, another tenant, disabled state, or missing grant.

Other responses:

| Status | Meaning |
| --- | --- |
| `400` | Unsupported version or invalid request. |
| `401` | Invalid service credential. |
| `403` | Credential cannot request that tenant. |
| `503` | Policy cannot be evaluated completely, including timeout or oversized result. |

The backend MUST validate response version, bound identifiers, key types/counts, timestamp bounds, and completeness before using it. Dependency errors are `503 AUTHORIZATION_UNAVAILABLE` to the API client; a valid negative context is `403 FORBIDDEN`.

### 5.4 Freshness and revocation

The default is no cross-request context cache. Every mutation and every background command MUST obtain fresh context. A read-only cache may be explicitly configured from 0 to 5,000 ms.

A cache key includes service-credential scope, principal, tenant, workspace, and route. Cached data MUST expire at the earlier of Hub's validity limit and the configured local TTL. Failure MUST NOT extend a cached allowance or fall back to stale roles.

No transaction may begin using expired context or issue further business SQL after its known authorization deadline. Immediately before issuing COMMIT, a mutation checks that deadline again; an expired context requires rollback. A COMMIT already in progress can complete after that instant and cannot be retroactively undone. The service must resolve a committed/unknown outcome correctly rather than report that an already durable effect was rolled back.

Authorization is evaluated at Hub's decision time. A revocation after that evaluation can leave an already running operation in flight. The documented bound is the configured read-cache lifetime plus the bounded in-flight operation duration, subject to known grant expiry. This is not a distributed transaction with Hub.

Servers must maintain clock synchronization within 1 second. Responses evaluated more than 1 second in the future, already expired responses, or responses with validity exceeding the contractual maximum are unusable. The client also limits validity using a local monotonic deadline established when its Hub request starts.

## 6. Workspaces, context, and database isolation

### 6.1 Workspace registry

A workspace is a backend resource:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | UUID | Globally unique, immutable. |
| `tenant_id` | UUID | External Hub tenant reference; immutable. |
| `slug` | text | Unique within a tenant; 1–63 lowercase letters, digits, underscores, or hyphens, beginning with a letter. |
| `display_name` | text | 1–200 characters. |
| `status` | enum | `active` or `disabled`. |
| `created_at`, `updated_at` | timestamp | Server-maintained UTC values. |

Workspace creation/disablement is an operator command in version 0.1, not generic collection CRUD. The operator supplies an existing Hub tenant ID. A workspace cannot authorize any user until Hub confirms that user's tenant and grants.

The registry stores external IDs, not a duplicate tenant/principal directory. It does not grant access by itself.

### 6.2 Request context

A trusted, immutable context contains:

~~~typescript
interface RequestContext {
  principalId: string;
  tenantId: string;
  workspaceId: string;
  routeId: string;
  permissionKeys: readonly string[];
  requestId: string;
  source: 'shuttle' | 'worker';
  policyBundleVersion: string;
  authorizationDeadline: number;
}
~~~

The deadline is an internal monotonic-time value, never a client credential. The application constructs context only after the checks above.

All domain operations receive this context explicitly. Ambient global tenant state and caller-constructed contexts are forbidden. Email and roles are not required domain inputs.

### 6.3 Scope establishment

The order is:

1. Verify gateway proof.
2. Look up the exact workspace UUID in the registry, together with the catalog of the workspace.
3. Reject an unknown/disabled workspace with `404 NOT_FOUND`.
4. Check any binding-level tenant restriction.
5. Ask Hub for context using the registry's tenant ID.
6. Resolve the immutable schema/policy bundle.
7. Execute a scoped domain operation.

The pre-context registry lookup is a narrow bootstrap exception. Its SQL role may select only `id`, `tenant_id`, and `status` from the registry. A registry-reader-only SELECT policy permits that projection before tenant scope is established; ordinary data roles retain the scoped policy. Its adapter exposes only lookup-by-exact-UUID; it cannot expose enumeration or arbitrary queries to callers. It has no business-table access.

The catalog of the workspace is read with the registry of the workspaces, in the same statement: the registry is on the path of every request, and a second round trip for the catalog would double the work of the smallest pool of the deployment. The catalog is the configuration of the workspace and not business data, and the reader of the registry reads it with the workspace that it names.

A binding-level tenant mismatch is `404 NOT_FOUND`. Registry connection/query failure is `503 DATABASE_UNAVAILABLE`, not a fabricated missing workspace.

### 6.4 PostgreSQL isolation

Workspace-owned rows MUST contain `tenant_id` and `workspace_id`. PostgreSQL MUST enforce matching tenant/workspace row-level security for reads and writes, including `WITH CHECK` behavior.

For every data transaction, the adapter sets transaction-local settings:

- `data.tenant_id`
- `data.workspace_id`
- `data.principal_id`

Missing/invalid settings deny access. Context MUST NOT survive transaction completion or leak through a connection pool.

Tables MUST enable and force row-level security. The runtime data role MUST NOT be a superuser, have `BYPASSRLS`, own protected tables, or have DDL privileges. The migration owner, registry reader, runtime data role, subscriber-delivery role, and retention/maintenance role have separate privileges. Credentials may point to the same PostgreSQL server; privilege separation still applies.

The subscriber-delivery role may claim delivery metadata across workspaces. It MUST NOT read or mutate business records. A worker's business operation uses the ordinary scoped data role after fresh Hub authorization.

Relations require composite tenant/workspace foreign keys or equivalent constraints that reject cross-scope references. Business references are not authorized merely because a UUID exists.

The generic query engine only accesses registered business collections. Registry, policy, audit, outbox, delivery, and idempotency tables are not exposed as generic collections.

## 7. Schema and collection model

### 7.1 Managed schema

Version 0.1 is PostgreSQL-first and manifest-driven. Collections are registered by trusted deployment code/configuration and backed by explicit SQL migrations.

A collection manifest defines:

- Stable collection key and physical table mapping.
- Fields, types, nullability, defaults, and bounds.
- Relationships and allowed query behavior.
- Semantic labels/descriptions.
- The fields of the search of the collection, when it has one, and the configuration of the text search of the database.
- A schema version and the policy references that apply to the collection.

It does not contain executable client scripts or Studio component implementations. Manifest and policy files are UTF-8 JSON, at most 1 MiB each, validated against strict versioned schemas. Policy bundles contain at most 1,000 policies. Unknown configuration properties are rejected.

A collection/table identifier matches `^[a-z][a-z0-9_]{0,62}$`. Physical mappings are deployment-controlled. Request parameters may select a registered key but never a physical SQL schema, table, expression, or identifier.

### 7.2 Example manifest

~~~json
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
        },
        "body": {
          "type": "text",
          "required": false,
          "nullable": true,
          "maxLength": 200000
        }
      },
      "relations": {}
    }
  ]
}
~~~

The table also contains the server fields in section 7.3. A `status` field added by an application remains ordinary business data; it does not imply built-in drafting or publishing support.

### 7.3 Server-maintained fields

Every business record includes:

| Field | Behavior |
| --- | --- |
| `id` | Server-generated UUID, immutable. |
| `tenant_id`, `workspace_id` | Filled from verified context, immutable. |
| `created_by`, `created_at` | Principal UUID and UTC creation time, immutable. |
| `updated_by`, `updated_at` | Principal UUID and UTC time of the latest committed change. |
| `version` | Positive integer beginning at 1, incremented by every successful update. |

Clients MUST NOT set server-maintained fields. Supplying one in a write is `422 VALIDATION_FAILED` rather than silently ignoring it.

Scope columns are internal. API representations always include `id` and `version`; other server metadata requires read permission. Deletions retain audit identifiers without requiring a foreign key to the deleted record.

### 7.4 Types and validation

Supported types are bounded string/text, boolean, safe integer, decimal, UUID, timestamp, JSON, and string enum.

- Decimal values are decimal strings in JSON to avoid floating-point conversion.
- Integers MUST remain in JavaScript's safe integer range; a future big-integer type needs an explicit string contract.
- Timestamps use RFC 3339 UTC output. Inputs require an explicit offset and are normalized to UTC.
- `required` means a value must be present on creation unless a server default supplies it.
- `nullable` independently controls whether the explicit value `null` is accepted.
- An omitted PATCH field remains unchanged; explicit `null` requests a nullable value.
- Unknown fields, wrong types, excessive lengths/depths, and invalid enum values are rejected. String length bounds count Unicode code points.
- Business defaults and validation run on the server. Client-side validation is advisory.

A record body is at most 256 KiB after JSON parsing/encoding normalization. JSON fields have a maximum nesting depth of 10. Application validation cannot execute caller-provided functions or regular expressions.

### 7.5 Schema lifecycle

The migration command runs with migration-owner credentials and an exclusive migration lock. API/worker startup validates migration checksums and compares manifests against the deployed physical schema.

Missing columns, incompatible types, invalid relation constraints, or unprotected registered tables prevent readiness. The service MUST NOT create/alter tables opportunistically during an API request or silently repair drift.

Schema and policy bundles are immutable per process generation and have content-derived versions. A deployment changes them through a reviewed release. Mixed-version replicas require backward-compatible SQL/API behavior; incompatible schema rollout requires draining old replicas first.

Operator commands create/disable workspaces and apply migrations. They are local administrative entry points, not HTTP routes that bypass Hub.

### 7.6 The catalog of a workspace

The **catalog** of a workspace is what it serves: the collections it registered and the bundle of policies that applies to it. The deployment holds a default catalog, and a workspace may hold its own.

The catalog is a **logical registry**. The physical tables of the collections are created by the reviewed migrations of the deployment, their isolation is written in those migrations, and the runtime role MUST NOT create or alter them. A registration names a collection of the deployment manifest and the physical table that the deployment declares for it. A registration that names an unknown collection or another table is refused, and a catalog that cannot be built MUST NOT serve a partial answer.

The rules are:

- A workspace that registered nothing serves every collection of the deployment manifest. This is the default of a deployment that has not used the registry yet.
- A workspace that registered something serves exactly the registered and enabled collections, and nothing else. A collection that the workspace does not serve is not a collection of the service: it answers `404 NOT_FOUND`.
- A relation to a collection that the workspace does not serve is absent from its manifest. A relation is never expanded towards a collection that is not served.
- The registry is read with the registry of the workspaces, by the narrow reader of the registry, in one statement. The tables keep their row level security, and the role of the api reads them inside the scope of its transaction.
- The registration of a collection and the publication of a bundle are operator commands. They are local administrative entry points, not HTTP routes that bypass Hub.

The schema of a workspace is the schema of the deployment restricted to its collections. The version of the schema of a workspace is the version of the deployment, and the cursors bind it: a cursor of a workspace whose catalog changed is stale.

## 8. Data authorization

### 8.1 Policies and capabilities

Hub owns capability assignment. The backend owns the meaning of a capability for a collection.

A policy includes a stable ID, required permission key, collection, action, row predicate, and permitted fields. Actions in version 0.1 are `read`, `create`, `update`, and `delete`.

Policies are allow rules. No matching rule means deny. Tenant/workspace constraints are mandatory and cannot be weakened by a policy. There is no implicit administrator role or wildcard capability that bypasses isolation.

Example:

~~~json
{
  "version": 1,
  "policies": [
    {
      "id": "read-articles",
      "permission": "content.reader",
      "collection": "articles",
      "action": "read",
      "where": {},
      "fields": ["title", "body"]
    },
    {
      "id": "edit-own-articles",
      "permission": "content.editor",
      "collection": "articles",
      "action": "update",
      "where": {"created_by": {"_eq": "$principalId"}},
      "check": {"created_by": {"_eq": "$principalId"}},
      "fields": ["title", "body"]
    }
  ]
}
~~~

`$principalId`, `$tenantId`, and `$workspaceId` are typed server substitutions. They are not evaluated code. A user needs a separately applicable read capability to inspect records; an update capability does not grant read access automatically.

Policy bundles are trusted deployment artifacts. Version 0.1 exposes no end-user policy-editing API.

### 8.2 Read composition

For a record:

1. Apply tenant/workspace scope.
2. Keep the row only if at least one applicable read policy's predicate matches.
3. Expose a field only if at least one matching policy grants that field for that row.
4. Always expose `id` and `version` of a readable record.

Requested fields may come from the union of applicable read-policy fields. Fields not visible for a particular row are omitted, not emitted as fabricated nulls. Actual database null values remain null.

Filtering and sorting are more conservative: a referenced field MUST be readable under every applicable read policy for that collection/action. This intersection prevents hidden-field inference across policies with different field sets. Unauthorized or unknown query fields receive the same `400 INVALID_QUERY` shape.

The SQL projection MUST avoid materializing unauthorized field values into response-building code. Internal predicate evaluation may use trusted policy fields without making them public.

### 8.3 Write composition

A write is allowed only when one complete applicable policy authorizes that operation. Update/delete also require a separately applicable read policy, as specified in section 9.5:

- All client-written fields are included in that policy's write field set.
- For update/delete, its `where` predicate matches the current row.
- For create/update, its `check` predicate matches the resulting row.
- Required schema validation and relation checks pass.
- Scope and server fields remain server-controlled.

Predicates/field grants from different policies MUST NOT be mixed to synthesize a write that no individual policy permits.

Updates must check both existing and resulting state. A caller cannot gain access by changing a record's ownership, scope, or policy-dependent values during the update.

### 8.4 Relations

Version 0.1 supports registered many-to-one references and derived one-to-many reads. It does not support nested writes, arbitrary joins, or automatic many-to-many junction management.

A writable reference requires an authorized read of its target in the same tenant/workspace. Failure uses a generic invalid-reference response without revealing whether a target exists elsewhere.

An included relation must be in the applicable read-field union. On each parent row, the relation is omitted unless a matching parent read policy grants that relation field. Every permitted expansion then independently applies the target collection's row and field policies. An inaccessible to-one target is represented as null; an inaccessible to-many target is omitted from that list. The parent's own foreign-key field is governed separately by its field permissions.

Relation expansion is limited to depth 1, 100 related rows per root record, and 1,000 related rows per response, within the overall result budget. Expansion uses bounded batched queries, not one unbounded query per parent. Exceeding an expansion budget fails the whole request with `422 RESULT_TOO_LARGE`; it never silently truncates a relationship. Reference IDs supplied to query filters do not bypass target/scope validation.

### 8.5 Isolation-sensitive operations

Single-item reads and mutations return `404 NOT_FOUND` for an unknown or row-inaccessible record. A missing collection-level action capability returns `403 FORBIDDEN` without a record existence check.

Counts use exactly the same row predicates and client filter as the corresponding list. The aggregates of section 9.8 use exactly the same row predicates and client filter as the corresponding list. Version 0.1 has no generic export, full-text, or bulk-mutation endpoint.

Audit access requires `data.audit.read`. This is a separately granted workspace-scoped capability, not a side effect of editing business records. Audit readers can see the workspace's audit identifiers and field-name metadata as an explicit privilege.

### 8.6 The bundle of a workspace

The bundle of policies of a workspace is the last bundle that was published for it, and the bundle of the deployment when it published none.

- A bundle is validated against the deployment manifest before it is published: a bundle that names an unknown collection or an unknown field is refused, and nothing is written.
- A bundle is published by an operator command. It is never written by a request of a tenant: a bundle says what a permission grants, and the grants of a principal are the business of Hub.
- The history of the publications is kept. A version is never changed and never removed, and the version that applies is the last one that was published.
- The bundle is parsed again when it is resolved. A bundle that was edited in the database, or that was published against another manifest, never applies: the service fails closed.
- The policies of a collection that the workspace does not serve are not part of the effective bundle, and the effective bundle has its own content-derived version. The cursors bind it and the audit log records it.

The catalog is not cached from the database: the bundle that was published is read with every request, and a bundle that was published is visible in the next one. The resolved catalog is memoized in the process, and the fingerprint of its inputs is the key: the collections that the workspace registered and the digest of the bundle it published. A bundle that was edited in the database has another digest, and it is parsed again and refused when it cannot be used.


## 9. HTTP API

### 9.1 Common contract

All business endpoints require the verified context in sections 4–6.

- Prefix: `/ws/{workspaceId}/v1`.
- Request/response encoding: UTF-8 JSON; write bodies require `Content-Type: application/json`.
- Success objects use `{"data": ...}`. Lists also contain `meta`.
- Correlation is in `X-Request-Id`; successful single-record bodies do not contain a per-request timestamp or request ID.
- Sensitive/permission-dependent responses use `Cache-Control: no-store`.
- Unknown methods return `405` with `Allow`; unsupported routes return `404`.
- Malformed JSON is `400`, oversized input is `413`, and well-formed invalid record data is `422`.
- Every collection/field reference is validated against the authorized schema before SQL compilation.
- No endpoint accepts raw SQL, unrestricted expressions, arbitrary URL fetches, or uploaded executable code.

Version 0.1 exposes:

| Method | Path relative to prefix | Behavior |
| --- | --- | --- |
| `GET` | `/me` | Principal, tenant, workspace, and local API version. No credential or raw Hub response. |
| `GET` | `/schema` | Authorized collection/field/relation metadata and supported operation descriptions. |
| `GET` | `/schema/{collection}` | The same metadata for one visible collection. |
| `GET` | `/items/{collection}` | Bounded, filtered, permission-aware list. |
| `GET` | `/items/{collection}/{id}` | Canonical authorized record representation and concurrency ETag. |
| `POST` | `/items/{collection}` | Create one record; requires an idempotency key. |
| `PATCH` | `/items/{collection}/{id}` | Update one record; requires a current `If-Match` validator. |
| `DELETE` | `/items/{collection}/{id}` | Delete one record; requires a current `If-Match` validator. |
| `GET` | `/audit` | Paginated audit metadata for holders of `data.audit.read`. |
| `GET` | `/openapi.json` | Versioned API description; dynamic collection details remain in authorized schema metadata. |

`/me` and schema metadata still require a valid positive Hub context. They do not make an otherwise ungranted principal a workspace member.

### 9.2 Metadata for independent clients

Schema responses expose only collections for which the caller has at least one applicable action policy. They may describe a write-only collection without exposing its records.

Each collection response includes:

- Collection key, semantic label/description, and schema version.
- Supported actions for the caller; action availability does not imply access to every record.
- Readable/writable field unions for applicable policies, with types and validation bounds.
- The conservative fields available for filtering/sorting.
- Visible relation targets and expansion limits.
- Policy bundle version and API limits.

The response MUST NOT include SQL identifiers, internal row predicates, secrets, subscriber configuration, Hub grant rows, or Studio implementation instructions. Field-specific metadata is omitted when the caller has no access to that field for any action.

An SDK or Studio MUST tolerate per-record field omission and a later operation being denied after grants change.

### 9.3 List queries

Supported parameters:

| Parameter | Format and default |
| --- | --- |
| `fields` | Comma-separated field names; default is the applicable readable union plus `id`/`version`. Maximum 50 explicitly selected fields. |
| `filter` | URL-encoded JSON filter object. |
| `sort` | Up to 3 comma-separated fields; `-field` means descending. Default `id` ascending. |
| `limit` | Positive integer, default 50, maximum 200. |
| `cursor` | Opaque authenticated pagination token. |
| `include` | Comma-separated registered relation names, maximum 5. |
| `include_count` | Boolean; default false. |

Unknown query parameters and duplicate occurrences of a parameter are rejected. The complete raw query string is at most 16 KiB.

Filters support `_and`, `_or`, `_not`, `_eq`, `_neq`, `_in`, `_nin`, `_lt`, `_lte`, `_gt`, `_gte`, and `_is_null`. Operator compatibility is type-checked. Null comparisons use `_is_null`; equality/ordering operands cannot be null.

- `_and`/`_or` contain non-empty arrays of filter objects.
- `_not` contains one filter object and negates it.
- Filter depth is at most 5, with at most 50 leaf predicates.
- `_in`/`_nin` contain 1–100 values of the field's type.
- An empty filter object means no additional client predicate.
- Dotted relation filters, JSON-path expressions, arbitrary functions, and SQL-style wildcards are unsupported.
- SQL values are bound parameters. Identifiers come only from the validated manifest.

The negation follows the three valued logic of the database: the negation of an unknown is an unknown, and a row whose value is null is never matched by a negated comparison. The evaluation in memory and the statement of the database answer the same question about the same row, and the differential test proves it.

Example filter:

~~~json
{
  "_and": [
    {"title": {"_eq": "Launch notes"}},
    {"created_at": {"_gte": "2026-10-01T00:00:00Z"}}
  ]
}
~~~

This example is permitted only when both fields are in the caller's filter/sort intersection.

A deterministic `id` tie-breaker is appended when not already present. Pagination uses keyset positions rather than growing SQL offsets.

Example response:

~~~json
{
  "data": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "version": 1,
      "title": "Launch notes",
      "body": "Initial content."
    }
  ],
  "meta": {
    "limit": 50,
    "nextCursor": null,
    "count": 1
  }
}
~~~

`count` is present only when requested. Rows and count are evaluated in one bounded read-only snapshot transaction. The total encoded response, including expansions, is at most 4 MiB; exceeding it returns `422 RESULT_TOO_LARGE` without a partial page. Row fetching and encoding must enforce this budget incrementally; the adapter must not first materialize an arbitrarily large expanded result and only then measure it. No success bytes are sent before the bounded response is complete.

### 9.4 Cursors

A cursor is signed with a backend-only key and binds:

- Principal, tenant, workspace, collection, and route.
- Normalized filter, field selection, sort, includes, count option, and limit.
- Pagination position and expiry.
- Schema version, policy bundle version, and current scoped permission-key fingerprint.

Cursor lifetime is 15 minutes. Tampering or request mismatch is `400 INVALID_CURSOR`. An expired cursor or changed schema/policy/permission fingerprint is `409 CURSOR_STALE`. A cursor is never an authorization credential.

Each page obtains current context and applies current data policies. Separate pages are not a persistent database snapshot; concurrent inserts, updates, or deletes can change later pages.

### 9.5 Canonical reads and concurrency validators

The single-record GET returns all currently readable fields for that row, plus `id` and `version`. Version 0.1 does not accept `fields` or `include` on this endpoint; clients use list projections when needed.

The backend deterministically serializes the canonical `{"data": ...}` representation and emits a strong `ETag` of `"sha256:<lowercase hex digest>"` over those exact UTF-8 bytes. Object keys are sorted recursively; array order is preserved; JSON is emitted without insignificant whitespace. No volatile envelope values are included. The bytes include the record version, so a record change invalidates its validator. API representation compression is outside version 0.1.

Updates and deletes require both an applicable read policy and the complete action-specific write policy. The HTTP adapter compares one strong `If-Match` validator against the current canonical representation while holding the record lock.

| Condition | Response |
| --- | --- |
| Missing `If-Match` | `428 PRECONDITION_REQUIRED` |
| Weak, wildcard, malformed, or multiple validators | `400 INVALID_PRECONDITION` |
| Current authorized representation differs | `412 PRECONDITION_FAILED` |
| Record is missing or no longer row-readable | `404 NOT_FOUND` |

Conditional GET/cache revalidation is outside version 0.1; responses always use `no-store`. A successful PATCH returns the new canonical representation and ETag. DELETE returns `204` with no body.

Internal commands carry an explicit expected record version and undergo the same read/write authorization and atomic version check. They do not manufacture HTTP headers.

### 9.6 Create and idempotency

POST requires `Idempotency-Key`, 1–128 ASCII letters/digits/periods/underscores/hyphens. The key is opaque client input, not authority.

A successful create returns `201`, a `Location` for the canonical record URL, and a minimal receipt:

~~~json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "version": 1
  }
}
~~~

Clients may fetch the record separately if authorized. A creation receipt does not grant subsequent read permission.

Idempotency rules:

1. The key is scoped to principal, tenant, workspace, route, and create endpoint.
2. A canonical request fingerprint includes the method, path, and validated client body.
3. Key claim, business insert, audit entry, outbox event/deliveries, and receipt commit atomically.
4. An identical committed request returns the original receipt and `Idempotency-Replayed: true` without creating anything.
5. Replay reauthenticates and requires a currently applicable create capability and permission for the submitted fields. It does not execute creation again or re-evaluate historical record state, and it never replays sensitive business-field values.
6. Reusing a key with another body returns `409 IDEMPOTENCY_CONFLICT`.
7. A concurrent uncommitted duplicate waits within the request budget; if unresolved after 2 seconds, return `409 OPERATION_IN_PROGRESS` with `Retry-After: 1`.
8. A rolled-back transaction leaves neither a committed receipt nor a business effect.
9. Receipts are retained for at least 24 hours from commit. After expiry, reusing the key is a new operation; clients must not assume permanent deduplication.
10. A deleted or subsequently changed record does not change the historical create receipt or cause recreation within the retention window.

PATCH/DELETE use concurrency preconditions, not create-idempotency semantics. The backend MUST NOT automatically retry arbitrary business writes after an ambiguous transport failure.

### 9.7 Error envelope

~~~json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request contains invalid values.",
    "details": [
      {
        "field": "title",
        "code": "MAX_LENGTH"
      }
    ]
  },
  "requestId": "request-123"
}
~~~

Error codes are stable machine-readable identifiers. Messages are safe human-readable summaries. Details may name only fields the caller is authorized to write or query. Stack traces, SQL text, database constraint names, raw Hub reasons, credentials, and foreign-tenant identifiers are never returned.

Core status mapping:

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

A Hub service-credential error is an operator/dependency failure, not a request for the end user to log in again.

### 9.8 Aggregates

`GET /ws/{workspaceId}/v1/aggregate/{collection}` groups the records of a collection.

| Parameter | Format and default |
| --- | --- |
| `group_by` | Comma-separated field names; at most 3. Default is no grouping, and the answer holds one group. |
| `metrics` | Comma-separated metrics: `sum:field`, `avg:field`, `min:field`, `max:field`. At most 10. The count of the rows is always part of the answer. |
| `filter` | URL-encoded JSON filter object, with the grammar of section 9.3. |
| `limit` | The maximum number of the groups; default 100, maximum 1000. |

The aggregate reads the rows that the corresponding list reads: the same scope, the same disjunction of the read predicates of the policies and the same filter of the caller. It is not a privileged query path.

The fields of the group and the fields of the metrics are the fields the caller may filter and sort by: the intersection of the read policies is the conservative answer, and an aggregate over a field that a policy hides would disclose what the policy protects.

The functions are checked against the types of the fields: `sum` and `avg` are the functions of the integers and the decimals, `min` and `max` are the functions of the values that have an order. A function that is not defined for a type is `400 INVALID_QUERY`.

The sum and the average of an integer are decimals, exactly as the database answers them: the sum of a big integer does not fit in a big integer. The minimum and the maximum of a field are the values of the field, in the representation the rows use.

The answer holds the number of the groups and whether the groups of the answer are all of them. The groups are ordered by the fields of the group, so the answer is stable.

~~~json
{
  "data": [
    {
      "group": { "status": "draft" },
      "count": 12,
      "sum": { "amount": "42.50" },
      "min": { "amount": "1.00" },
      "max": { "amount": "9.00" }
    }
  ],
  "meta": { "limit": 100, "groups": 1, "truncated": false }
}
~~~

### 9.9 Search

`GET /ws/{workspaceId}/v1/items/{collection}?search=<text>` searches the collection. The aggregate of section 9.8 accepts the same parameter.

The search is a text search of the database over the fields that the manifest declares searchable. The caller supplies the text and the deployment supplies the fields and the configuration of the text search: a caller never chooses the fields of a search and never chooses the configuration.

The search is combined with the filter of the caller, and the count of a list counts the rows of the search.

The searchable fields of a collection have to be the fields the caller may filter and sort by. A search over a field that a policy hides would disclose what the policy protects, and the service refuses it with `403 FORBIDDEN`.

The search is not an operator of the filter grammar. The predicates of the policies are evaluated in memory by the write path, and a text search has no meaning there: the search is a query of the callers and it never reaches the predicates of a policy.

The text of a search is at most 256 characters. The index of the search is a part of the reviewed migration of the collection, and the expression of the index is the expression of the statement: a deployment that changes one of them changes the other.

## 10. Mutation and transaction rules

A mutation follows this sequence:

1. Verify identity, resolve workspace, and obtain fresh Hub context outside the data transaction.
2. Validate the requested action, input shape, field grants, and preliminary query budget.
3. Acquire a data connection within a bounded wait.
4. Begin a transaction and set its tenant/workspace/principal scope.
5. Claim the create idempotency key, or lock and authorize the existing record.
6. Recheck the canonical precondition and existing-row write predicate under that lock.
7. Resolve/authorize references and validate the resulting row, including the write `check` predicate.
8. Apply the insert/update/delete and server-maintained fields.
9. Insert the audit entry, domain event, configured subscriber deliveries, and any create receipt.
10. Verify the known authorization deadline remains valid immediately before issuing COMMIT, and commit within the bounded execution model in section 5.4.
11. Return a success response only after commit succeeds.

Any failure before commit rolls back all effects. The backend MUST NOT call Hub or a remote subscriber while holding the business transaction open.

Every successful update, including one supplying values equal to current values, increments the record version and emits one update event. An empty PATCH is invalid. DELETE is a hard delete in version 0.1; soft deletion requires an explicit application collection model.

Automatic cascading business deletes and nested mutations are unsupported. Referential constraints use restrict/no-action semantics for generic business CRUD. Deleting dependent records requires separately authorized commands.

User-facing unique constraints MUST be tenant/workspace scoped. A uniqueness conflict returns a generic `409 CONFLICT` without another record's identifier or values. Global uniqueness of server-generated UUIDs is permitted.

Transaction deadlines MUST result in actual database cancellation/rollback and connection disposal when cleanliness cannot be proven. Racing a Promise against a timer without stopping its SQL is insufficient.

Requests rejected before mutation are logged for diagnostics; they are not recorded as successful business audit entries.

## 11. Persistence, audit, and domain events

### 11.1 Backend-owned persistence

The minimum logical entities are:

| Entity | Purpose |
| --- | --- |
| `workspaces` | External tenant reference, workspace identity, display metadata, status. |
| Collection tables | Typed business records with server-maintained scope/version fields. |
| Migration ledger | Applied migration IDs and checksums. |
| `audit_entries` | Immutable mutation receipts and safe changed-field metadata. |
| `outbox_events` | Durable committed domain events. |
| `outbox_deliveries` | One delivery state per event and configured subscriber. |
| `idempotency_receipts` | Scoped create keys, request fingerprints, and minimal committed receipts. |

Manifests/policies are deployment artifacts in version 0.1, so no editable policy or schema tables are required. Backend tables use a separate SQL schema from registered business collections.

A workspace's tenant ID is an external reference, not a cross-database foreign key into Hub. The same applies to principal references in audit and server fields.

Required indexes include:

- Unique workspace ID and unique `(tenant_id, slug)`.
- Unique business `(tenant_id, workspace_id, id)` for scoped relation constraints.
- Query indexes beginning with `tenant_id, workspace_id` where appropriate.
- Scoped audit pagination by `occurred_at, id`.
- Scoped unique idempotency key/fingerprint lookups and receipt-expiry cleanup.
- Delivery claim indexes on state/next-attempt/lease expiry.
- Unique `(event_id, subscriber_id)` delivery identity.

Indexes for optional business filters belong to reviewed collection migrations. API requests never create indexes.

### 11.2 Audit entries

Each committed mutation records:

- Audit UUID and UTC occurrence time.
- Principal, tenant, workspace, route, and request/correlation ID.
- Source: gateway request or worker.
- Collection, record ID, action, and resulting version (last version for a delete).
- Changed field names.
- Policy bundle version and authorizing policy ID.
- Causation event and initiating principal when a worker is involved.

Audit entries MUST NOT store access tokens, cookies, provider secrets, signatures, arbitrary request bodies, or full record before/after images. Revision history is deferred.

Runtime data credentials have append/read privileges as required and no audit update/delete privilege. The dedicated maintenance role performs policy-controlled retention. Audit API readers cannot edit or purge entries.

The audit endpoint supports `limit` and cursor pagination, using the same identity/scope binding rules as other cursors. It returns metadata only. It does not promise a durable changefeed across concurrent commits.

### 11.3 Domain event envelope

~~~json
{
  "version": 1,
  "eventId": "55555555-5555-4555-8555-555555555555",
  "type": "record.updated",
  "tenantId": "22222222-2222-4222-8222-222222222222",
  "workspaceId": "33333333-3333-4333-8333-333333333333",
  "collection": "articles",
  "recordId": "44444444-4444-4444-8444-444444444444",
  "recordVersion": 2,
  "actorId": "11111111-1111-4111-8111-111111111111",
  "occurredAt": "2026-10-21T16:00:00.000Z",
  "changedFields": ["title"],
  "correlationId": "request-123",
  "causationId": null,
  "causationDepth": 0
}
~~~

Types are `record.created`, `record.updated`, and `record.deleted`. Events contain identifiers and changed field names, not business-field values. A subscriber needing current data must obtain it through an authorized domain read.

Event IDs are identities, not commit-order cursors. Subscriber delivery is at least once and may be out of order. A consumer needing ordered effects must reconcile record versions. The backend MUST NOT claim exactly-once delivery or ordered changefeed semantics.

### 11.4 Trusted subscribers

Subscribers are registered by trusted server code in the composition root. Each has a stable ID and declared event filters. Version 0.1 has no uploaded plugins, arbitrary target URLs, workflow definitions, or caller-defined executable handlers.

The transaction captures deliveries for the subscriber configuration active at mutation time. Registering a new subscriber affects future events only. Events with no matching subscribers have no pending deliveries and remain subject to completed-event retention.

Execution uses a configured Hub service principal and worker route ID. Hub resolves that principal's current workspace-scoped grants before each command/read. The initiating user's identity is audit attribution, never the worker's reusable authority.

A subscriber MUST NOT access business records through delivery-storage credentials, raw SQL shortcuts, or replayed gateway signatures. Worker writes identify the service principal as `updated_by` and preserve the initiating principal in causation/audit metadata.

### 11.5 Claiming, retry, and replay

- Claim due deliveries atomically with PostgreSQL locking/leases, supporting multiple worker processes.
- Default concurrency: 4; default lease: 30 seconds; heartbeat interval: 10 seconds.
- Acknowledgement occurs after the handler finishes its intended durable effect.
- A crashed/expired worker lease makes the delivery eligible again.
- Handlers receive `eventId + subscriberId` as a stable idempotency identity.
- Retry transient failures with exponential backoff and jitter, from 1 second up to 5 minutes, at most 8 attempts.
- A permanent authorization denial or exhausted retry budget marks the delivery failed for operator review.
- Requeue/replay is an explicit bounded operator command, with actor attribution; it does not bypass fresh business authorization.
- A subscriber missing after a deployment leaves its deliveries blocked/failed with a visible diagnostic; they are not silently acknowledged.
- Subscriber-triggered writes carry causation metadata. Depth above 10 is rejected before commit to bound recursive event loops.

No handler runs inside the business transaction. External side effects cannot be atomic with PostgreSQL and must be idempotent on the subscriber side.

Completed event/delivery metadata is retained for at least 7 days. Pending/failed deliveries MUST NOT be deleted automatically. Capacity limits must reject new work before a transaction commits an event that cannot be retained; backlog is observable.

## 12. Typed client and independent Studio contract

The backend repository publishes a typed client package that:

- Uses the versioned HTTP API through Shuttle.
- Accepts a base URL, workspace ID, caller-supplied fetch/credential handling, and cancellation signal.
- Implements collection/schema queries, cursor traversal, create idempotency keys, and record preconditions.
- Exposes stable typed error codes without hiding authorization or concurrency failures.
- Does not issue signatures, store Hub service credentials, run login flows, or depend on Studio.

The OpenAPI document covers the fixed protocol, envelopes, endpoints, and error cases. It describes caller credentials at Shuttle as the external authentication boundary; clients are not instructed to manufacture internal signed headers. Runtime collection metadata covers deployment-specific field definitions. Generated collection types are build artifacts tied to a schema version; they do not replace runtime validation.

The client is the nested package `@data-backend/client` of this repository, and it is not published on a registry: it is distributed as the tarball of the release, whose name is `data-backend-client-<version>.tgz`. The root package of the repository is the service itself, and installing it does not install the client. The release MUST publish a tarball that installs and works outside of this repository, and the continuous integration MUST prove it: the tarball is packed with the command of the release, installed in a consumer outside of the repository, imported through its public name, and called.

Studio consumes the same public APIs as any client. It has no privileged database connection or secret backend shortcut. A future Hub-administration screen requires a separately authorized server-side adapter to Hub's administrative API; that functionality is outside this service's first release.

## 13. Architecture and code boundaries

The service is a modular monolith with an optional separate worker process. Distribution of code into additional services is not required for version 0.1.

| Layer | Owns |
| --- | --- |
| `src/main.ts` | Process entry; starts the runtime. |
| `src/app/` | Hono routes, HTTP parsing, context establishment, response/error mapping. |
| `src/domains/<domain>/` | Policy, use cases, ports, public entry point, domain tests. |
| `src/domains/<domain>/adapters/` | Concrete domain-port implementations assembled by runtime. |
| `src/platform/bun/` | Listener, transport primitives, process-specific APIs. |
| `src/platform/postgres/` | Connection lifecycle, scoped transactions, query execution, migration mechanics. |
| `src/runtime/` | Configuration, composition root, subscribers, readiness, signals, drain. |
| `src/observability/` | Structured logging and metric interfaces. |
| `test/` | Contract, compatibility, database integration, load, and architecture verification. |

Required domains are `gateway-context`, `workspaces`, `schema`, `authorization`, `catalog`, `records`, `audit`, and `events`.

Allowed cross-domain imports:

| Domain | May import public contracts from |
| --- | --- |
| `gateway-context` | None |
| `workspaces` | None |
| `schema` | None |
| `authorization` | `gateway-context`, `workspaces`, `schema` |
| `catalog` | `schema`, `authorization` |
| `audit` | None |
| `events` | None |
| `records` | `gateway-context`, `workspaces`, `schema`, `authorization`, `audit`, `events` |

Worker orchestration resides in runtime and calls public domain use cases. Audit/events accept primitive typed envelopes and injected persistence ports; they do not import records. A transaction/unit-of-work port lets records coordinate its repositories, audit sink, and outbox without importing concrete SQL adapters.

Domain core code imports no Hono, Bun API, application handler, runtime, or concrete adapter. The application imports domain public entry points, not their internals. Only composition constructs concrete adapters.

Architecture checks MUST enforce this matrix, reject cycles including type-only cycles, and reject catch-all shared implementation directories. Shared protocol packages may contain small versioned DTOs/codecs; they MUST NOT expose another service's tables or internal repositories.

## 14. Configuration and resource limits

Configuration is loaded and validated as a whole before the service becomes ready. Invalid configuration fails startup with the variable name and a safe explanation, without printing its secret value. Version 0.1 has no remote configuration-editing API or partial hot reload.

| Variable | Default / requirement |
| --- | --- |
| `DATA_HOST` | `127.0.0.1`; production may bind an explicitly protected service interface. |
| `DATA_PORT` | `8082`. |
| `DATA_PROCESS_ROLE` | `all`; supported values `api`, `worker`, `all`. |
| `DATA_DATABASE_URL` | Required in production; runtime scoped-data credentials. |
| `DATA_REGISTRY_DATABASE_URL` | Required in production; narrow registry-reader credentials. |
| `DATA_DELIVERY_DATABASE_URL` | Required when workers run; delivery-metadata credentials. |
| `DATA_SHUTTLE_BINDINGS_FILE` | Required for API processes; validated bindings and verification-key file paths. |
| `DATA_SCHEMA_BUNDLE_FILE` | Required; registered collection manifests. |
| `DATA_POLICY_BUNDLE_FILE` | Required; immutable collection/action policies. |
| `DATA_HUB_URL` | Required; pinned expected Hub base URL over protected transport. |
| `DATA_HUB_CONTEXT_TOKEN_FILE` | Required; dedicated access-context service credential. |
| `DATA_CURSOR_KEY_FILE` | Required for API processes; at least 32 random bytes, separate from gateway/Hub keys. |
| `DATA_CONTEXT_CACHE_TTL_MS` | `0`; read-only cache, range 0–5000. Mutations/worker commands always fetch fresh context. |
| `DATA_CATALOG_CACHE_TTL_MS` | `0`; read-only cache of the catalog of the workspaces, range 0–60000. The default is no cache: a bundle that was published is visible in the next request. |
| `DATA_HUB_TIMEOUT_MS` | `1000`; bounded access-context request. |
| `DATA_REQUEST_TIMEOUT_MS` | `10000`; overall HTTP work deadline. |
| `DATA_DB_STATEMENT_TIMEOUT_MS` | `3000`. |
| `DATA_DB_TRANSACTION_TIMEOUT_MS` | `5000`; shortened to remaining authorization/request lifetime. |
| `DATA_DB_ACQUIRE_TIMEOUT_MS` | `1000`; maximum wait for a data connection. |
| `DATA_DB_POOL_MAX` | `20` scoped-data connections per process; registry/delivery pools have separately bounded maxima of 5 each. |
| `DATA_MAX_BODY_BYTES` | `1048576`; the parsed business-record bound remains 256 KiB. |
| `DATA_MAX_IN_FLIGHT_REQUESTS` | `200`; admission rejects excess work rather than growing an unbounded queue. |
| `DATA_WORKER_PRINCIPAL_ID` | Required when any subscriber is enabled. |
| `DATA_WORKER_ROUTE_ID` | Required when any subscriber is enabled; typically `data-worker`. |
| `DATA_WORKER_CONCURRENCY` | `4`; must be positive and fit the process/database budget. |
| `DATA_METRICS_TOKEN_FILE` | Optional; absent disables the metrics endpoint. |

Migration-owner and maintenance credentials are supplied to their operator commands, not retained by the API process.

Numeric inputs MUST be finite bounded integers. Request/body/query/result bounds cannot be disabled with zero/negative values. The effective timeout is the minimum of all applicable deadlines.

Production MUST reject absent/placeholder secrets, unprotected remote dependency URLs, unsafe database roles, schema drift, unverified bindings, or unsupported Hub context versions. Secrets come from files/secret mounts, never command-line values that are echoed to logs.

Development may use PGlite and deterministic Shuttle/Hub fixtures. Production requires a PostgreSQL server. PostgreSQL-server integration tests remain mandatory; embedded tests alone do not establish production isolation, locking, or worker-claim correctness.

## 15. Operations and data lifecycle

### 15.1 Probes and metrics

| Endpoint | Contract |
| --- | --- |
| `GET /healthz` | `200` with service/API version while the process is alive; no dependency calls. |
| `GET /readyz` | `200` only when config, schema/policies, database privilege checks, and recent Hub context-discovery checks pass. Otherwise `503` with a safe readiness code. |
| `GET /metrics` | Prometheus text with a dedicated bearer token; `404` when disabled, `401` for invalid/missing credentials when enabled. |

Readiness may reuse a successful authenticated Hub discovery result for at most 10 seconds. Workers additionally require access to the delivery store and valid registered subscriber configuration. Probes are not routed through ordinary workspace authorization.

Metrics include request counts/durations by normalized route and status, Hub duration/failures, context-cache hits, database pool waits, authorization denials, transaction rollbacks, outbox backlog/age, failed deliveries, retries, and drain state. The hits and the misses of the cache of the catalog are counted as well.

Tenant, principal, workspace, record ID, raw URL, email, and query text MUST NOT become unbounded metric labels.

### 15.2 Logging

Structured logs include request/correlation ID, normalized route, action, safe status/error code, dependency timing, and internal tenant/workspace identifiers where operationally necessary.

Credentials, cookies, signatures, complete filters/bodies, business-field values, and connection strings with secrets are redacted. Authorization denials are observable without returning raw Hub reasons to callers.

### 15.3 Shutdown and cancellation

On shutdown, the process:

1. Becomes unready and stops admitting new API requests/delivery claims.
2. Allows in-flight bounded transactions to finish or cancels/rolls them back.
3. Stops subscriber execution; unfinished deliveries retain/release leases safely.
4. Closes HTTP listeners, transports, and database pools exactly once.

The drain budget is 30 seconds. A client disconnect cancels ongoing reads. If a mutation has committed before a disconnect, its effect remains committed; the create idempotency receipt resolves an ambiguous POST result.

A connection with an aborted or unknown transaction state is rolled back/discarded before it can return to the pool.

### 15.4 Retention, backup, and removal

Default retention:

| Data | Policy |
| --- | --- |
| Business records | Application-owned; no automatic purge. |
| Audit entries | 90 days by default, adjustable by the operator's documented retention policy. |
| Create receipts | At least 24 hours. |
| Completed event/delivery metadata | At least 7 days. |
| Pending/failed deliveries | No automatic deletion; operator resolution required. |

Retention runs under dedicated maintenance privileges, in bounded batches, with metrics and operator audit attribution. No generic collection endpoint can purge platform history.

Backups include business records, workspaces, manifests/policy bundle versions, audit/outbox/delivery state, and migration history. Secrets are backed up/rotated under the deployment's secret-management process. A restore rehearsal must verify tenant isolation and safely resume idempotent deliveries before production launch.

Tenant/workspace removal is an explicit operator procedure: disable access, stop relevant deliveries, satisfy retention/export requirements, and remove data in bounded operations. Moving a workspace between tenants is unsupported.

### 15.5 Capacity and rollout

Before production launch, publish a repeatable capacity report containing hardware, dataset shape, policy complexity, concurrent clients, database pool settings, p50/p95/p99 latency, failure rates, and oldest outbox age.

Required scenarios include:

- Read-heavy access with no context cache.
- Mixed create/update traffic under tenant isolation.
- Concurrent updates to one record.
- Multiple backend replicas and worker lease recovery.
- Hub outage, slow SQL, expired authorization, and dependency recovery.
- Maximum allowed filters, page sizes, relation expansions, and response budgets.

A deployment declares its required request rate and latency objective; no invented capacity number is a release claim. The report must show bounded memory/queues and recovery under the declared load.

Rolling releases preserve backward-compatible schema/API behavior. Destructive migrations require a reviewed maintenance plan and a tested restore/forward-fix path. Database rollback is not assumed safe after data-changing migrations.

## 16. Verification and release acceptance

No item is complete until its behavior is demonstrated by an appropriate automated check. The artifact produced by implementing this specification must include:

| Suite | Required evidence |
| --- | --- |
| Domain unit | Predicate evaluation, field rules, write-check composition, schema validation, context expiry, and event-envelope rules. |
| HTTP contract | Paths, envelopes, query limits, status/error codes, canonical ETags, idempotency receipts, and absent deferred endpoints. |
| Shuttle compatibility | Unmodified pinned gateway forwards real requests signed with `ES256` and accepted by the backend signature verification against the public key of the gateway; forged signatures, tampered identities and workspace mismatches fail, and the legacy format is refused by a route of the current format. |
| Client packaging | The tarball of the client installs outside of the repository, the client is imported through its public name, and it resolves its own files without the dependencies of the service. |
| Baseline drift | The manifest of the baseline, the block of the baseline of the specification, and the workflows agree. |
| Hub compatibility | Real proposed context implementation returns complete scoped user/group keys and preserves the existing decision contract. |
| PostgreSQL integration | RLS, composite reference constraints, missing-context denial, pool reuse, concurrent version checks, migration drift, and role restrictions. |
| Transaction failure | Inject failures at each mutation stage; record/audit/event/receipt are all committed or all absent. |
| Subscriber integration | Multi-worker claims, lease expiry, duplicate delivery, retry exhaustion, missing handlers, service-principal revocation, and causation-depth bounds. |
| Architecture | Allowed imports, public entry points, no cycles, and private adapter construction. |
| Operations/load | Deadlines cancel SQL, resources remain bounded, dependency failures fail closed, drain completes, and restore is rehearsed. |

Mandatory adversarial/edge cases:

1. A grant for workspace A cannot read, write, count, reference, or expand data in workspace B.
2. A tenant-wide Hub grant does not make another tenant's registered workspace accessible.
3. A forged tenant/route header, email match, or stale role claim cannot influence authorization.
4. Group removal, grant revocation/expiry, disabled principals, and disabled tenants take effect within the documented freshness bounds.
5. Filtering/sorting by a hidden field is rejected; counts and relation expansions cannot bypass row policies.
6. Two policies with complementary field sets cannot authorize a synthetic write neither policy permits.
7. An update that moves a row outside its write check is rejected atomically.
8. Concurrent updates using one ETag yield one successful version change and one precondition failure.
9. A retried POST after a committed-but-lost response creates one record and returns its original receipt.
10. Reusing a create key with a different body cannot create another record inside the retention window.
11. Expired or malformed Hub context, wrong context identifiers, and incomplete capability sets never allow a data operation.
12. A pooled connection never retains a previous tenant/workspace/principal scope.
13. Runtime credentials cannot disable RLS, alter schema, edit audit history, or query Hub tables.
14. A subscriber cannot turn historical actor attribution into current authorization.
15. Backend functionality and all API tests run with no Studio process or package.

## 17. Implementation sequence and completion criteria

The implementation should progress through independently demonstrable milestones:

| Milestone | Concrete result |
| --- | --- |
| M0 — Contracts and process | Validated environment, pinned references, probes, architecture checker, proposed Hub context contract tests. |
| M1 — Trust and scope | Real Shuttle verification, workspace registry, fresh Hub context, PostgreSQL roles/RLS, and cross-tenant refusal tests. |
| M2 — Schema and policies | One registered collection, migrations, filtered metadata, predicates, and field-aware authorization. |
| M3 — Record API | Bounded reads, create receipts, optimistic updates/deletes, relation checks, error contract, and OpenAPI/client basics. |
| M4 — Durable effects | Atomic audit/outbox/idempotency behavior, subscriber claims, retries, and service-principal execution. |
| M5 — Operational release | Multi-replica tests, deadlines/drain, capacity report, backup/restore rehearsal, and complete acceptance matrix. |

Version 0.1 is complete when an external client can discover an `articles` collection, create an article under its own authorized identity, read permitted fields, update its own article with a current validator, observe the corresponding authorized audit metadata, and demonstrate that another tenant/workspace cannot access that data.

The same demonstration must succeed through the unmodified pinned Shuttle gateway and the extended Hub implementation. Studio is not part of that demonstration or a dependency of the release.

## 18. Decisions fixed by this draft

1. The service is headless; Studio is a separate project.
2. Hub remains authoritative for identity and capability assignment.
3. Shuttle remains the authenticated gateway; integration uses its existing signed-identity contract.
4. A new Hub access-context contract is required; stale role snapshots are insufficient.
5. Workspaces and collection/data policy semantics belong to the backend.
6. PostgreSQL, reviewed migrations, and registered manifests are the first supported schema model.
7. REST is the first transport, with metadata/OpenAPI and a small typed client.
8. Audit, committed events, and create receipts are transactional parts of mutation correctness.
9. Trusted subscribers use explicit service-principal authority and at-least-once delivery.
10. Assets, content lifecycle, public realtime, workflow configuration, GraphQL, MCP/AI, and additional database engines require subsequent specifications.

Changes to these decisions must update this file and its acceptance criteria before changing the implementation contract.
