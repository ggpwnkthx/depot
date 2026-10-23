# The specification of the headless data backend

**Runtime:** TypeScript on Bun; Hono at the HTTP boundary; PostgreSQL in
production.
**Delivery:** a standalone backend repository and deployable. Studio is
a separate project.

This document is the normative contract of the release. MUST, MUST NOT,
SHOULD, SHOULD NOT and MAY indicate the strength of the requirement.
A behavior described as deferred is outside the release and MUST NOT be
advertised as available.

The examples are illustrative configuration and protocol fixtures. They
do not describe features that already exist in Shuttle or Hub.

## Contents

1. [Purpose and authority](#1-purpose-and-authority)
2. [Scope and invariants](#2-scope-and-invariants)
3. [The topology](#3-the-topology)
4. [The trust contract of Shuttle](#4-the-trust-contract-of-shuttle)
5. [The access context contract of Hub](#5-the-access-context-contract-of-hub)
6. [Workspaces, context and isolation](#6-workspaces-context-and-isolation)
7. [The schema and the collections](#7-the-schema-and-the-collections)
8. [The authorization of the data](#8-the-authorization-of-the-data)
9. [The HTTP API](#9-the-http-api)
10. [The mutations and the transactions](#10-the-mutations-and-the-transactions)
11. [The persistence, the audit and the events](#11-the-persistence-the-audit-and-the-events)
12. [The typed client](#12-the-typed-client)
13. [The architecture](#13-the-architecture)
14. [The configuration](#14-the-configuration)
15. [The operations and the lifecycle of the data](#15-the-operations-and-the-lifecycle-of-the-data)
16. [The verification and the acceptance of a release](#16-the-verification-and-the-acceptance-of-a-release)
17. [The decisions fixed by this contract](#17-the-decisions-fixed-by-this-contract)

## 1. Purpose and authority

The backend provides reusable, permission aware data APIs for the
applications behind Shuttle. It uses Hub as the authority for the
principals, the tenants, the groups and the grants. It owns the
workspaces, the registered collections, the record operations, the
data policies, the audit history and the committed domain events.

### 1.1 The baseline of the integration

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
harness. The revisions of the earlier baseline are the historical
evidence of the release `v0.1.0` and they stay in the release notes:
they are not the active baseline.

### 1.2 The ownership

| Owner | Responsibility |
| --- | --- |
| The identity provider | The authentication of the external identity. |
| Hub | The login, the principals, the tenants, the groups, the permission keys and the scoped grants. |
| Shuttle | The sessions, the credentials of the caller, the admission of a workspace, the limits of the gateway, and the forward with the signed identity. |
| The backend | The verification of the upstream identity, the scope of the tenant and of the workspace, the current grants, the policies of the records and of the fields, and the data APIs. |
| Studio, a separate project | The browser application, the navigation, the forms, the tables, the dashboards and the preview. |
| The other clients | The websites, the application servers and the scripts that consume the headless API. |

The tables of Hub remain private to Hub. The backend MUST NOT query or
mutate them, expose them as collections, or keep a second directory of
the identities and of the grants.

### 1.3 The headless boundary

The service MUST:

- expose versioned HTTP APIs and machine readable schema metadata,
- work without Studio being installed, running or reachable,
- support the independent clients through the same domain operations
  and the same authorization rules,
- publish an OpenAPI description and a small typed client package.

The service MUST NOT serve a studio application, a login page, a
dashboard, a form renderer, a theme system, a visual workflow editor or
a web preview. It MUST NOT depend on a repository, a package, an origin
or a release of Studio.

The metadata of a collection may hold semantic labels and descriptions.
The identifiers of the widgets, the implementations of the components,
the layouts, the navigation state and the preferences of the
presentation belong to Studio, and the validation and the evaluation of
the policies MUST NOT depend on them.

## 2. Scope and invariants

### 2.1 The capabilities of the release

| Capability | The required behavior |
| --- | --- |
| The gateway | The verification of the Shuttle identity of the version `v5` with the public key of the gateway, and the mapping of the verified requests to the trusted route bindings. The legacy format `v4` is a migration path: the deployment that still uses it declares it with `DATA_LEGACY_IDENTITY`, and the service refuses it by default. |
| Hub | The current and authoritative access context, through the contract of section 5. |
| The workspaces | The ownership of a workspace and its enabled or disabled state. |
| The collections | The declarative manifests of the collections, backed by the reviewed SQL migrations. |
| The catalog | The collections a workspace serves and the bundle of policies that applies to it, without a change of the physical schema. |
| The metadata | The collection, field, relation and action metadata, filtered by the policies. |
| The records | The creation, the list, the read, the update and the deletion, with bounded queries and optimistic concurrency. |
| The aggregates | The groups of the rows a list would read, with the same predicates and the same filter. |
| The authorization | The isolation of the tenant and of the workspace, the permissions of the actions, the predicates of the rows, the visibility of the fields and the checks of the writes. |
| The audit | The mutations that are committed, in an append only log. |
| The events | An outbox event with every mutation, delivered to the subscribers that the deployment registered. |
| The client | The OpenAPI, the versioned errors and a typed client that uses the credentials and the fetch of the caller. |
| The operations | The probes, the bounded resources, the metrics, the logs, the migrations, the backups and the drain. |

### 2.2 The deferred capabilities

| Capability | The boundary of its integration |
| --- | --- |
| The files and the media | An asset domain; the bytes in an object storage, the metadata and the authorization here. |
| The drafts, the publication, the editorial revisions, the translations | A content domain that uses the same authorization and the same transactions. The audit is not a revision store. The history of the versions of a record is not one of them: it is a bounded capability of the backend (spec §11.6). |
| The public realtime subscriptions | A subscription domain over the committed events, with the continuing authorization and the revocation. |
| The webhooks, the schedules, the workflows | Delivery and job domains over the outbox events, with an explicit authority of a service principal. |
| GraphQL | Another transport over the same services of queries and of commands. |
| The bulk writes and the exports | Bounded operations with the same rules of rows and of fields, and no privileged path of queries. The aggregates and the searches are the exceptions: they are bounded and they use the same rules. |
| The edition of the schema at runtime | A versioned contract of schema management and a reviewed workflow of migrations. The catalog is a logical registry: it never creates or alters a table. |
| The edition of the policies over HTTP | The publication of a bundle is an operator command. An endpoint that writes policies would be an authority that bypasses Hub. |
| The extensions of a marketplace | An explicit model of execution and of trust. Only the code that the deployer registered is allowed. |
| The MCP and the AI features | The clients and the adapters that invoke the authorized domain operations. |
| The other database engines | The storage adapters, once their transaction, isolation and query semantics are specified. |
| The studio and the visual analytics | An external client project, outside the implementation and the criteria of the release. |

A deferred endpoint MUST be absent, rather than answer with a
successful placeholder. The service MUST NOT claim the parity of
Directus.

### 2.3 The invariants

1. No operation of the business data starts without a trusted principal
   and a resolved context of workspace and of tenant.
2. A workspace belongs to exactly one tenant of Hub. The ownership is
   immutable.
3. The authentication, the admission of the workspace and the
   authorization of the data are three separate checks.
4. An enabled workspace and a grant of Hub do not imply the access to
   every collection or to every action.
5. The forwarded roles and the e-mail addresses are never authoritative
   data permissions.
6. A missing context, an unavailable dependency, an unknown policy and
   an incomplete answer of capabilities fail closed.
7. Every query of a business record is scoped by the tenant and by the
   workspace, including the lookups of the relations and the validation
   queries.
8. The input of a client cannot choose a tenant, change the owner of a
   workspace, choose an identifier of SQL, supply the fields of the
   audit of the server, or execute SQL.
9. A committed mutation of a business record carries its audit entry
   and its outbox event in the same transaction of PostgreSQL.
10. The clients, the internal subscribers and the future transports use
    the same services of authorization.
11. A role of the runtime cannot bypass the policies of the isolation.
12. The background execution has its own explicit authority: the
    headers of a user are not reusable credentials.

## 3. The topology

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

A straightforward deployment has the tenant specific deployments of
Shuttle pointing to a shared Hub and to a shared backend. The shared
client topology of Hub is compatible when it is configured explicitly
and covered by the tests of compatibility.

The backend does not change the way Shuttle selects an identity
provider. The ingress to the data endpoints MUST be restricted to the
configured trust boundary of the gateway, and the termination of TLS is
the responsibility of the deployment.

The paths of the workspace are `/ws/{workspaceId}/v1/...`. Shuttle
preserves the path of the request, and the backend MUST accept the
whole of it: it MUST NOT assume that the gateway strips
`/ws/{workspaceId}` or an upstream base path. A deployment that uses an
upstream base path includes it in its router and in its binding, and
the signature is verified against the path as it was received.

The probes and the metrics use their own endpoints. There is no public
endpoint of login, of logout, of password or of token.

## 4. The trust contract of Shuttle

### 4.1 The trusted route bindings

The deployer provides an immutable configuration for every accepted
route of the gateway:

| Field | What it means |
| --- | --- |
| `id` | The local name of the route, for the diagnostics. |
| `host` | The exact public authority that is signed, with the port when there is one. |
| `upstreamPathPattern` | The path that the backend receives, with the parameter of the workspace. |
| `routeId` | The route scope of Hub that corresponds to the route. |
| `identity` | The verification of the signatures of the route: the version, the algorithm and the file of the key. |
| `expectedTenantId` | The optional restriction of a tenant specific gateway. |

The `identity` of a binding names three values that belong together:

| Version | Algorithm | The file of the key | What it means |
| --- | --- | --- | --- |
| `v5` | `ES256` | `publicKeyFile` | The public key of the gateway, on the curve P-256. The gateway holds the private one. |
| `v4` | `HS256` | `identityKeyFile` | The legacy derived key of the gateway. It is a signing capable secret and it is a migration path only. |

The version, the algorithm and the file of the key MUST agree: a
binding that names an algorithm that does not belong to its version, or
a file of the wrong kind of key, is refused. The backend MUST NOT
infer the version, the algorithm or the key from a request, from a
header, or from a fallback after a failed verification. A route of the
version `v5` MUST refuse the version `v4`, and a legacy route MUST NOT
accept a public key as its secret.

The bindings MUST be unambiguous over the signed host, the received
path and the verifying key. An ambiguity stops the startup.

The file shape is `{"version":2,"bindings":[...]}`, with at most 100
bindings. The `host` is a lowercase ASCII DNS authority, with the port
when it is required. The `upstreamPathPattern` holds literal path
segments, exactly one `{workspaceId}` segment and a terminal `/*`: it
accepts no executable regex and no other substitution. A UUID segment
cannot hold encoded separators, backslashes or dot segments. The
backend verifies the original signed bytes before it uses the
normalized values of the routing.

The file of the version 1 held one derived identity key per binding. It
is read as the legacy mode it is, and the deployment that reads it
declares it with `DATA_LEGACY_IDENTITY`: the default of the service is
to refuse the legacy format, and the legacy format is removed in the
version `2.0.0`.

Shuttle does not forward a signed `routeId` or a tenant identifier.
The backend MUST derive the route from the matching binding. It MUST
NOT accept a client supplied route, a tenant header or an
unverified claim as a substitute.

### 4.2 The verification of the identity

For every data request, the backend MUST:

1. identify the candidate bindings from the received path and the
   signed forwarded host,
2. reject the missing, the duplicated, the malformed and the
   conflicting identity headers,
3. require `x-shuttle-signature` with the `v5=` prefix of the route,
   and refuse every other version,
4. rebuild the exact canonical payload of that version, from the
   received method, the received path, the raw query string, the
   forwarded host, the subject, the workspace, the optional e-mail and
   the sorted roles,
5. verify the detached JWS with the public key of the route, allowing
   only `ES256` and the type `shuttle-identity` in the protected
   header. The payload of the signature MUST be detached, and a
   critical header that the backend does not know MUST be refused,
6. only after the verification, validate and normalize the identifiers
   of the principal and of the workspace,
7. require the signed workspace to be the workspace of the path,
8. match exactly one binding, and reject a combination of host, path and
   identity that is outside of it.

The canonical serialization, the order of the fields, the handling of
the roles and the fixtures of the signature MUST match the pinned
contract of Shuttle. The values MUST NOT be normalized before the
signed bytes are rebuilt.

The backend receives the **public** key of the gateway, never
`SHUTTLE_SESSION_SECRET` and never the private key of the gateway. A
backend that can verify an identity cannot mint one: the boundary of
the trust is the key and not the network. The key of a route is loaded
and validated at the startup, and a key that cannot be loaded stops the
service.

The legacy format `v4` is symmetric: its key is derived from the secret
of the sessions of the gateway, and it is a signing capable secret that
belongs only inside the boundary of the gateway. It is a migration path:
a deployment that configures it is a deployment whose upstream can mint
identities, and the replacement of the key is a coordinated operation
of the deployment. The service refuses it by default, and it is removed
in the version `2.0.0`.

The signature binds the target of the request and the identity. It does
not bind the body, and it provides no timestamp and no nonce. The
backend MUST NOT present it as an anti replay mechanism or as a
substitute of a protected transport.

### 4.3 The handling of the credentials

The backend MUST NOT create a second session of the browser or
reimplement the login of Hub. The headers and the cookies of the
caller are not used to resolve the permissions of the data.

The routes of the gateway SHOULD set `forwardAuthorization: false` when
the upstream does not need the bearer token of the caller. The backend
MUST NOT log the forwarded credentials.

The principal is the UUID of the principal of Hub that Shuttle carries
as its subject. The e-mail is an optional display value, and the
forwarded roles are an optional diagnostic context that MUST NOT
determine the access to the data.

A missing or an invalid proof of the gateway is `401
UNAUTHENTICATED`. A mismatch of the workspace of the path and of the
signature, and an ambiguous binding, are the same generic refusal,
without a detail of the policies or of the tenants.

## 5. The access context contract of Hub

**The status of the integration:** it is implemented. Hub carries the
two endpoints since `4cedcfc48e9bb4eb556d2316eb502e1ab87d3105`, and
the baseline of Hub is the revision of the manifest of section 1.1.
The change lives in the repository of Hub and not in a copy of this
repository; the compatibility harness proves the contract against the
real Hub.

The backend MUST NOT substitute the admin API of Hub, a direct SQL, the
forwarded roles or the boolean answer of `/v1/decisions` for this
contract. Shuttle keeps using its own endpoint of decisions.

### 5.1 The authentication and the discovery

The two methods of `/v1/access-context` require a dedicated read only
service credential over a protected transport:

`Authorization: Bearer <the service credential of the access context>`

Hub MUST restrict that credential to an explicit set of tenants. A
platform wide credential is allowed for a shared backend, and that
scope is a choice of the deployment and not the default of a tenant
credential. These credentials do not authorize the administration of
Hub and the creation of grants.

`GET /v1/access-context` returns:

~~~json
{
  "versions": [1],
  "maxPermissionKeys": 4096,
  "maxLifetimeMs": 5000
}
~~~

The backend uses this authenticated discovery for the checks of
compatibility and of readiness. An unknown version of the contract
stops the readiness.

### 5.2 The request of the context

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

- `subject` comes from the verified identity of the gateway, or from an
  explicitly configured internal service principal.
- `tenantId` comes from the registry of the backend.
- `workspaceId` comes from the verified request and from the resolved
  registry entry.
- `routeId` comes from a trusted binding or from the configuration of
  the worker.

The body is bounded to 64 KiB, and the unknown fields and the invalid
types are rejected.

Hub MUST evaluate one consistent snapshot of the policies and require:

1. the service credential may ask about the requested tenant,
2. the principal exists, is active and belongs to that tenant,
3. the tenant is enabled,
4. at least one enabled, unrevoked and unexpired grant applies to that
   principal or to a current membership of a group,
5. every permission that is returned comes from a grant whose scope of
   workspace and of route matches the request, or whose scope is
   unrestricted.

Hub does not own a catalog of workspaces in the baseline. The
relationship of the tenant and of the workspace is the responsibility of
the backend. Hub MUST still verify the tenant of the principal, and not
merely echo the tenant of the request.

### 5.3 The answer of the context

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

`permissionKeys` MUST be the complete, sorted and deduplicated set of
the permission keys of the enabled grants of the user and of the groups
that are alive. It MUST NOT inherit the truncation of the roles of the
token.

The limit of the answer is 4096 keys and 512 KiB. Exceeding one of the
two bounds is an error and never a partial allowance.

`validUntil` MUST be no later than `evaluatedAt + 5000 ms` and no later
than the earliest expiry of the grants that contributed. An early
expiry is acceptable. It is not a promise that a grant cannot be
revoked earlier.

A denial uses the status `200`, echoes the bound fields of the
context, sets `allow: false` and `permissionKeys: []`, and omits
`validUntil`. It does not disclose whether the cause was an unknown
principal, another tenant, a disabled state or a missing grant.

| Status | What it means |
| --- | --- |
| `400` | An unsupported version or an invalid request. |
| `401` | An invalid service credential. |
| `403` | The credential cannot ask about that tenant. |
| `503` | The policies cannot be evaluated completely, including a timeout and an oversized answer. |

The backend MUST validate the version of the answer, the bound
identifiers, the types and the number of the keys, the bounds of the
timestamps and the completeness before it uses it. An error of the
dependency is `503 AUTHORIZATION_UNAVAILABLE` for the client of the
API, and a valid negative context is `403 FORBIDDEN`.

### 5.4 The freshness and the revocation

The default is no cache of the context between the requests. Every
mutation and every background command MUST obtain a fresh context. A
read only cache MAY be configured explicitly, from 0 to 5000 ms.

The key of the cache holds the scope of the credential, the principal,
the tenant, the workspace and the route. The cached data MUST expire at
the earlier of the validity that Hub announced and the local lifetime.
A failure MUST NOT extend a cached allowance and MUST NOT fall back to
stale roles.

No transaction may start with an expired context, and no business SQL
may run after the known deadline of the authorization. Immediately
before the `COMMIT`, a mutation checks the deadline again, and an
expired context rolls the transaction back. A commit that is already in
progress may complete after that instant, and it cannot be undone: the
service MUST resolve the committed or unknown outcome correctly rather
than report an effect that is durable as rolled back.

The authorization is evaluated at the moment of the decision of Hub. A
revocation after that evaluation may leave an operation in flight. The
documented bound is the lifetime of the configured read cache plus the
bounded duration of the operation in flight, subject to the known
expiry of the grants. This is not a distributed transaction with Hub.

The servers MUST keep their clocks synchronized within one second. An
answer that was evaluated more than one second in the future, an
expired answer, and an answer whose validity exceeds the contractual
maximum are unusable. The client also bounds the validity with a local
monotonic deadline that starts when its request to Hub starts.

## 6. Workspaces, context and isolation

### 6.1 The registry of the workspaces

| Field | Type | The rule |
| --- | --- | --- |
| `id` | UUID | Globally unique and immutable. |
| `tenant_id` | UUID | The reference of a tenant of Hub, immutable. |
| `slug` | text | Unique in a tenant: 1 to 63 lowercase letters, digits, underscores or hyphens, beginning with a letter. |
| `display_name` | text | 1 to 200 characters. |
| `status` | enum | `active` or `disabled`. |
| `created_at`, `updated_at` | timestamp | The UTC values of the server. |

The creation and the disablement of a workspace are operator commands,
not generic CRUD of a collection. The operator supplies a tenant of Hub
that exists. A workspace cannot authorize anybody until Hub confirms
the tenant and the grants of the user.

The registry stores the external identifiers. It does not grant an
access by itself.

### 6.2 The context of a request

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

The deadline is an internal value of the monotonic time, and it is never
a credential of the client. The application constructs the context only
after the checks of the sections 4 to 6.

Every domain operation receives the context explicitly. The ambient
state of a tenant and a context built by a caller are forbidden. The
e-mail and the roles are not inputs of the domain.

### 6.3 The establishment of the scope

The order is:

1. verify the proof of the gateway,
2. look up the exact UUID of the workspace in the registry, with the
   catalog of the workspace,
3. reject an unknown or a disabled workspace with `404 NOT_FOUND`,
4. check the restriction of the tenant of the binding,
5. ask Hub for the context, with the tenant of the registry,
6. resolve the schema and the bundle of the policies,
7. execute the scoped domain operation.

The lookup of the registry before the context is a narrow exception of
the bootstrap. Its SQL role may select only `id`, `tenant_id` and
`status` of the registry, and a policy of the reader allows that
projection before the scope of the tenant is established. Its adapter
exposes only the lookup by the exact UUID: it cannot enumerate and it
cannot run an arbitrary query. It has no access to a business table.

The catalog of the workspace is read with the registry of the
workspaces, in the same statement: the registry is on the path of every
request, and a second round trip would double the work of the smallest
pool of the deployment. The catalog is the configuration of the
workspace and not business data.

A mismatch of the tenant of the binding is `404 NOT_FOUND`. A failure
of the connection or of the registry is `503 DATABASE_UNAVAILABLE`, and
not a fabricated missing workspace.

### 6.4 The isolation of PostgreSQL

The rows that belong to a workspace MUST hold `tenant_id` and
`workspace_id`. PostgreSQL MUST enforce the matching of the row level
security of the tenant and of the workspace, for the reads and for the
writes, including the behavior of `WITH CHECK`.

Every transaction of the data sets the settings of the transaction:

- `data.tenant_id`
- `data.workspace_id`
- `data.principal_id`

The settings that are missing or invalid deny the access. The context
MUST NOT survive the end of a transaction and MUST NOT leak through a
pool of connections.

The tables MUST enable and force the row level security. The role of
the runtime MUST NOT be a superuser, MUST NOT have `BYPASSRLS`, MUST
NOT own the protected tables and MUST NOT have the privileges of the
DDL. The migration owner, the reader of the registry, the role of the
runtime, the role of the deliveries and the role of the maintenance are
separate privileges, even when the credentials point at the same
server.

The role of the deliveries may claim the metadata of the deliveries of
every workspace. It MUST NOT read or mutate a business record. A
business operation of a worker uses the ordinary scoped role, after a
fresh authorization of Hub.

The relations require the composite foreign keys of the tenant and of
the workspace, or the equivalent constraints that reject the references
of another scope. A business reference is not authorized because a UUID
exists.

The engine of the queries only reaches the registered business
collections. The registry, the policies, the audit, the outbox, the
deliveries and the receipts are not exposed as generic collections.

## 7. The schema and the collections

### 7.1 The managed schema

The collections are registered by the trusted code or the configuration
of the deployment, and they are backed by explicit SQL migrations. A
manifest defines:

- the stable key of the collection and the mapping of its table,
- the fields, the types, the nullability, the defaults and the bounds,
- the relations and the behavior of the queries that they allow,
- the semantic labels and descriptions,
- the fields of the search of the collection and the configuration of
  the text search of the database,
- the table of the versions of the collection, when the collection keeps
  a history (spec §11.6),
- a version of the schema and the references of the policies.

It holds no executable script of a client and no implementation of a
component of Studio. The manifests and the policies are UTF-8 JSON, at
most 1 MiB each, validated against strict versioned schemas. A bundle
holds at most 1000 policies, and the unknown properties are rejected.

The key of a collection and of a table matches
`^[a-z][a-z0-9_]{0,62}$`. The physical mappings are deployment
controlled. The parameters of a request may select a registered key,
and never a schema, a table, an expression or an identifier of SQL.

### 7.2 The server maintained fields

| Field | The behavior |
| --- | --- |
| `id` | The UUID of the server, immutable. |
| `tenant_id`, `workspace_id` | Filled from the verified context, immutable. |
| `created_by`, `created_at` | The UUID of the principal and the UTC time of the creation, immutable. |
| `updated_by`, `updated_at` | The UUID of the principal and the UTC time of the last committed change. |
| `version` | A positive integer that begins at 1 and that every successful update increments. |

The clients MUST NOT set the fields of the server. A field of the
server in a write is `422 VALIDATION_FAILED`, and not a silent ignore.

The columns of the scope are internal. The representation of the API
always holds `id` and `version`, and the other metadata of the server
requires a read permission. The deletions keep the identifiers of the
audit without a foreign key to the deleted record.

### 7.3 The types and the validation

The supported types are the bounded string and text, the boolean, the
safe integer, the decimal, the UUID, the timestamp, the JSON and the
enumeration of strings.

- The decimal values are decimal strings in the JSON, to avoid the
  conversion of a floating point.
- The integers MUST stay in the safe integer range of JavaScript; a
  type of big integer needs an explicit contract of strings.
- The timestamps use the RFC 3339 UTC in the output. The input requires
  an explicit offset, and it is normalized to UTC.
- `required` means that a value MUST be present on a creation, unless
  a default of the server supplies it.
- `nullable` controls independently whether the explicit value `null`
  is accepted.
- A field of a PATCH that is omitted stays unchanged, and an explicit
  `null` asks for a nullable value.
- The unknown fields, the wrong types, the excessive lengths and
  depths, and the invalid values of an enumeration are refused. The
  bounds of the length of a string count the code points.
- The defaults and the validation of the business run on the server.
  The validation of a client is advisory.

The body of a record is at most 256 KiB after the normalization of the
JSON. A field of JSON has a depth of at most 10. The validation of the
application cannot execute a function or a regular expression of the
caller.

### 7.4 The lifecycle of the schema

The command of the migrations runs with the credentials of the owner of
the schema and with an exclusive lock. The startup of the api and of
the worker validates the checksums of the migrations and compares the
manifests with the deployed physical schema.

A missing column, an incompatible type, an invalid constraint of a
relation, and a registered table that is not protected prevent the
readiness. The service MUST NOT create or alter a table during a
request, and it MUST NOT silently repair a drift.

The schema and the bundle of the policies are immutable per generation
of the process, and their version is derived from their content. A
deployment changes them through a reviewed release. The replicas of
mixed versions require a backward compatible behavior of the SQL and of
the API, and an incompatible rollout of the schema requires the
draining of the old replicas.

### 7.5 The catalog of a workspace

The catalog is what a workspace serves: the collections it registered and
the bundle of the policies that applies to it. The deployment holds a
default catalog, and a workspace may hold its own.

The catalog is a **logical registry**: it never creates a table and never
alters one. The tables come from the reviewed migrations of the
deployment, their isolation is written in those migrations, and the role
of the api may never alter them. A registration names a collection of
the manifest of the deployment and the table that the deployment
declares for it. A registration that names an unknown collection or
another table is refused, and a catalog that cannot be built MUST NOT
serve a partial answer.

The rules:

- A workspace that registered nothing serves every collection of the
  manifest of the deployment. It is the default of a deployment that has
  not used the registry yet.
- A workspace that registered something serves exactly the registered
  and enabled collections, and nothing else. A collection that the
  workspace does not serve answers `404 NOT_FOUND`.
- A relation towards a collection that the workspace does not serve is
  absent from its manifest. A relation is never expanded towards a
  collection that is not served.
- The registry is read with the registry of the workspaces, by the
  narrow reader, in one statement. The tables keep their row level
  security, and the role of the api reads them inside the scope of its
  transaction.
- The registration of a collection and the publication of a bundle are
  operator commands. They are local administrative entry points, and
  they are not HTTP routes that bypass Hub.

The schema of a workspace is the schema of the deployment restricted to
its collections. The version of the schema of a workspace is the
version of the deployment, and the cursors bind it: a cursor of a
workspace whose catalog changed is stale.

## 8. The authorization of the data

### 8.1 The policies and the capabilities

Hub owns the assignment of the capabilities. The backend owns the
meaning of a capability for a collection.

A policy holds a stable identifier, the permission key that it
requires, the collection, the action, the predicate of the rows and the
permitted fields. The actions are `read`, `create`, `update` and
`delete`.

The policies are allow rules: no matching rule means deny. The
constraints of the tenant and of the workspace are mandatory, and a
policy cannot weaken them. There is no implicit administrator and no
wildcard capability that bypasses the isolation.

`$principalId`, `$tenantId` and `$workspaceId` are typed server
substitutions. They are not evaluated code. A user needs a read
capability of its own to inspect the records: an update capability does
not grant a read.

The bundles of policies are trusted artifacts of the deployment. The
release exposes no API of edition of the policies for the end users.

### 8.2 The composition of a read

For a record:

1. apply the scope of the tenant and of the workspace,
2. keep the row when at least one applicable read policy matches it,
3. expose a field when at least one matching policy grants it for that
   row,
4. always expose `id` and `version` of a readable record.

The requested fields may come from the union of the fields of the
applicable read policies. The fields that are not visible for a row are
omitted, and not emitted as nulls. The null values of the database stay
null.

The filtering and the sorting are more conservative: a field that is
referenced MUST be readable under every applicable read policy of the
collection and of the action. This intersection prevents the inference
of a hidden field across policies with different sets of fields. A
field of a query that is unknown or not authorized receives the same
`400 INVALID_QUERY`.

The SQL projection MUST NOT materialize the unauthorized values in the
code that builds the answer. The evaluation of a predicate may use the
fields of a trusted policy without making them public.

### 8.3 The composition of a write

A write is allowed only when one complete applicable policy authorizes
it. An update and a deletion also require a separately applicable read
policy:

- every field written by the client is in the set of the fields of that
  policy,
- for an update and a deletion, its `where` matches the current row,
- for a creation and an update, its `check` matches the resulting row,
- the validation of the schema and the checks of the relations pass,
- the scope and the fields of the server stay under the control of the
  server.

The predicates and the field grants of different policies MUST NOT be
mixed to synthesize a write that no individual policy permits.

An update checks the existing state and the resulting state. A caller
cannot gain an access by changing the ownership, the scope or the
values of a record during the update.

**The predicates of a write are evaluated by the database.** The
statement of the write carries the `where` and the `check` of the
applicable policies, compiled by the same compiler as the queries, and
the database evaluates them: the `where` over the row before the change
and the `check` over the row after it. The row after the change is
given to the database as a common table expression of bound parameters,
so the check of a write is the check of the row that the write
produces. The evaluation of the same predicates in memory is the oracle
of the check and not its authority: a write that the statement refuses
is refused, and the two evaluations are compared by a generated check
on every predicate that was not written by hand.

**The predicates of a read are evaluated by the database as well.** The
statement that locks the row of a write computes the flags of the read
policies, and the representation of the record is built from those
flags. The validator of a record MUST be the same whether the record
was read or written: the service MUST NOT evaluate a predicate of a
policy in memory.

### 8.4 The relations

The release supports the registered references of many to one and the
derived reads of one to many. It does not support the nested writes, the
arbitrary joins, nor the management of the junctions of many to many.

A writable reference requires an authorized read of its target in the
same tenant and in the same workspace. The failure is a generic
invalid reference, without a disclosure of the existence of the target
elsewhere.

An included relation must be in the union of the fields of the read. On
each parent row, the relation is omitted unless a read policy of the
parent grants the relation. Every permitted expansion then applies the
policies of the rows and of the fields of the target on its own. An
inaccessible to-one target is a null, and an inaccessible to-many target
is omitted from the list. The foreign key of the parent is governed
separately by its permissions of fields.

The expansion is limited to a depth of 1, 100 related rows per root
record and 1000 related rows per answer, inside the global budget of
the answer. The expansion uses bounded batched queries, and not one
unbounded query per parent. Exceeding a budget fails the whole request
with `422 RESULT_TOO_LARGE`; it never truncates a relationship silently.
The identifiers of a reference that a filter supplies do not bypass the
validation of the target and of the scope.

### 8.5 The operations that are sensitive to the isolation

The read and the mutation of one item answer `404 NOT_FOUND` for a
record that is unknown or that the row does not reach. A missing
capability of the action of a collection answers `403 FORBIDDEN`,
without a check of the existence of a record.

The counts use exactly the same predicates of the rows and the same
filter of the caller as the corresponding list. The aggregates of
section 9 use exactly the same predicates and the same filter.

The access to the audit requires `data.audit.read`. It is a capability
of its own, scoped to the workspace, and not a side effect of the
edition of the records. The readers of the audit see the identifiers of
the workspace and the names of the fields, and that is the explicit
privilege of the privilege.

### 8.6 The bundle of a workspace

The bundle that applies to a workspace is the last one that was
published for it, and the bundle of the deployment when it published
none.

- A bundle is validated against the manifest of the deployment before
  it is published: a bundle that names an unknown collection or an
  unknown field is refused, and nothing is written.
- A bundle is published by an operator command. It is never written by
  a request of a tenant: a bundle says what a permission grants, and
  the grants of a principal are the business of Hub.
- The history of the publications is kept. A version is never changed
  and never removed, and the version that applies is the last one that
  was published.
- The bundle is parsed again when it is resolved. A bundle that was
  edited in the database, or that was published against another
  manifest, never applies: the service fails closed.
- The policies of a collection that the workspace does not serve are not
  part of the effective bundle, and the effective bundle has its own
  version, derived from its content. The cursors bind it, and the audit
  records it.

The catalog is not cached from the database: the bundle that was
published is read with every request, and it is visible in the next one.
The resolved catalog is memoized in the process, and the fingerprint of
its inputs is the key: the collections that the workspace registered and
the digest of the bundle it published.

## 9. The HTTP API

The details of the surface are in [the contract of v1](api.md). This
section holds the rules that the surface obeys.

- The prefix is `/ws/{workspaceId}/v1`.
- The encoding is UTF-8 JSON, and the bodies of a write require
  `Content-Type: application/json`.
- The successful objects hold `{"data": ...}`, and the lists hold
  `meta` as well.
- The correlation is in `X-Request-Id`, and the body of a record does
  not hold a timestamp of the request.
- The answers that are sensitive or permission dependent use
  `Cache-Control: no-store`.
- An unknown method answers `405` with an `Allow`, and an unsupported
  route answers `404`.
- The malformed JSON is `400`, the oversized input is `413`, and the
  well formed data of a record that is invalid is `422`.
- Every reference to a collection and to a field is validated against
  the authorized schema before the SQL is compiled.
- No endpoint accepts raw SQL, unrestricted expressions, arbitrary
  fetches of an url, or uploaded executable code.

The endpoints of the release:

| Method | The path after the prefix | What it does |
| --- | --- | --- |
| `GET` | `/me` | The principal, the tenant, the workspace and the local version of the API. No credential and no raw answer of Hub. |
| `GET` | `/schema` | The metadata of the collections, of the fields and of the relations, filtered by the policies. |
| `GET` | `/schema/{collection}` | The same metadata for one visible collection. |
| `GET` | `/items/{collection}` | A bounded, filtered and permission aware list. |
| `GET` | `/items/{collection}/{id}` | The canonical representation of a record and its validator. |
| `POST` | `/items/{collection}` | The creation of one record. It requires an idempotency key. |
| `PATCH` | `/items/{collection}/{id}` | The update of one record. It requires a current `If-Match`. |
| `DELETE` | `/items/{collection}/{id}` | The deletion of one record. It requires a current `If-Match`. |
| `GET` | `/items/{collection}/{id}/versions` | The history of the versions of one record, for the collections that keep one. |
| `GET` | `/items/{collection}/{id}/versions/{version}` | One version of one record, read with the policies of the deployment. |
| `POST` | `/items/{collection}/{id}/rollback` | The rollback of one record to one of its versions. It requires a current `If-Match`. |
| `GET` | `/aggregate/{collection}` | The groups of an aggregate. |
| `GET` | `/audit` | The metadata of the audit, for the holders of `data.audit.read`. |
| `GET` | `/openapi.json` | The versioned description of the API. |

`/me` and the metadata of the schema still require a valid and positive
context of Hub. They do not make a principal without a grant a member
of the workspace.

The metadata of the schema exposes only the collections for which the
caller holds at least one applicable policy of an action. It may
describe a collection that is write only, without exposing its records.
It MUST NOT hold an identifier of SQL, an internal predicate of the
rows, a secret, the configuration of the subscribers, the grants of Hub
or the instructions of a studio.

The answers of the metadata are the fields of the union of the policies
that apply, their types and their bounds, the conservative fields that
are available for filtering and for sorting, the visible relations and
their limits, the version of the bundle of the policies and the limits
of the API. The metadata of a field is omitted when the caller has no
access to that field for any action.

A SDK or a studio MUST tolerate the omission of a field of a record and
the refusal of a later operation, when the grants change.

## 10. The mutations and the transactions

A mutation follows this sequence:

1. verify the identity, resolve the workspace and obtain a fresh
   context of Hub, outside of the transaction of the data,
2. validate the requested action, the shape of the input, the grants of
   the fields and the preliminary budget of the query,
3. acquire a data connection within a bounded wait,
4. begin a transaction and set its scope of tenant, workspace and
   principal,
5. claim the key of the idempotency, or lock and authorize the existing
   record,
6. check the canonical precondition and the predicate of the write on
   the existing row, under the lock,
7. resolve and authorize the references and validate the resulting row,
   including the `check` of the policy,
8. apply the insertion, the update or the deletion, with the fields of
   the server,
9. insert the audit entry, the domain event, the deliveries of the
   subscribers and the receipt of a creation,
10. verify that the deadline of the authorization is still valid
    immediately before the `COMMIT`, and commit inside the bounded
    model of the section 5.4,
11. answer a success only after the commit succeeds.

A failure before the commit rolls back every effect. The backend MUST
NOT call Hub or a remote subscriber while it holds the transaction of
the business open.

Every successful update, including one that supplies the values that
are already there, increments the version of the record and emits one
event of update. An empty PATCH is invalid. The deletion is a hard
deletion; a soft deletion requires an explicit collection model of the
application.

The cascading deletions and the nested mutations are unsupported. The
constraints of the references use the semantics of restrict or of no
action for the generic CRUD of the business. The deletion of the
dependent records requires separately authorized commands.

The unique constraints that a user sees MUST be scoped by the tenant and
by the workspace. A conflict answers a generic `409 CONFLICT`, without
the identifier or the values of another record. The global uniqueness of
the generated UUIDs is allowed.

The deadlines of a transaction MUST result in a real cancellation or
rollback of the database and in the disposal of the connection when the
cleanliness cannot be proven. Racing a promise against a timer without
stopping its SQL is not enough.

The requests that are refused before a mutation are logged for the
diagnostics. They are not audit entries of the business.

## 11. The persistence, the audit and the events

### 11.1 The persistence of the backend

| The entity | What it holds |
| --- | --- |
| `workspaces` | The reference of the tenant, the identity of the workspace, the metadata of the display and the status. |
| The tables of the collections | The typed records of the business, with the fields of the scope and of the version. |
| The ledger of the migrations | The identifiers and the checksums of the applied migrations. |
| `audit_entries` | The immutable receipts of the mutations and the safe metadata of the changed fields. |
| `outbox_events` | The durable domain events of the committed mutations. |
| `outbox_deliveries` | The state of the delivery of every event and of every subscriber. |
| `idempotency_receipts` | The keys of the creations, the fingerprints of the requests and the minimal committed receipts. |

The manifests and the policies are artifacts of the deployment, so no
table of editable policies or of editable schema is required. The
tables of the backend use a SQL schema of their own, apart from the
registered business collections.

The tenant of a workspace is an external reference, not a foreign key
into another database. The same holds for the principals of the audit
and of the fields of the server.

The required indexes include the unique identifier of a workspace, the
unique `(tenant_id, slug)`, the unique business
`(tenant_id, workspace_id, id)` of the relations, the indexes that begin
with `tenant_id, workspace_id`, the pagination of the audit by
`occurred_at, id`, the unique lookups of the idempotency and the
cleanup of the receipts, the indexes of the claim of the deliveries on
the state, the next attempt and the expiry of the lease, and the unique
`(event_id, subscriber_id)`.

The indexes of the optional filters of the business belong to the
reviewed migrations of the collections. A request of the API never
creates an index.

### 11.2 The audit entries

Every committed mutation records:

- the UUID of the audit and the UTC time of the occurrence,
- the principal, the tenant, the workspace, the route and the
  identifier of the request,
- the source: a request of the gateway or a worker,
- the collection, the identifier of the record, the action and the
  resulting version, the last version for a deletion,
- the names of the fields that changed,
- the version of the bundle of the policies and the identifier of the
  policy that authorized,
- the event of the cause and the principal of the origin, when a worker
  is involved.

The audit entries MUST NOT hold the access tokens, the cookies, the
secrets of the provider, the signatures, the arbitrary bodies of the
requests, nor the full images of a record before and after. The history
of the revisions is deferred.

The credentials of the runtime have the privileges of insertion and of
reading that they need, and no privilege of update or of deletion of the
audit. The role of the maintenance runs the retention of the policies.
The readers of the audit cannot edit nor purge the entries.

The endpoint of the audit supports `limit` and the pagination of a
cursor, with the same rules of binding of identity and of scope as the
other cursors. It returns metadata only, and it does not promise a
durable changefeed across the concurrent commits.

### 11.3 The envelope of a domain event

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

The types are `record.created`, `record.updated` and `record.deleted`.
The events hold identifiers and the names of the changed fields, and not
the values of the business fields. A subscriber that needs the current
data obtains it through an authorized read of the domain.

The identifiers of the events are identities and not cursors of the
order of the commits. The delivery is at least once and it may be out
of order. A consumer that needs ordered effects reconciles the versions
of the records. The backend MUST NOT claim the semantics of a delivery
of exactly once, nor those of a changefeed ordered.

### 11.4 The trusted subscribers

The subscribers are registered by the trusted code of the server, in the
composition root. Every one has a stable identifier and the filters of
the events that it handles. The release has no uploaded plugins, no
arbitrary urls of a target, no definitions of workflows and no handlers
that a caller defines.

The transaction captures the deliveries for the configuration of the
subscribers that is active at the moment of the mutation. The
registration of a new subscriber affects the future events only. The
events that have no matching subscriber have no pending delivery, and
they stay subject to the retention of the completed events.

The execution uses a configured service principal of Hub and the route
of the worker. Hub resolves the current grants of that principal for
the scope of the workspace before every command and every read. The
identity of the user that initiated the work is an attribution, and
never the reusable authority of the worker.

A subscriber MUST NOT reach the business records through the
credentials of the storage of the deliveries, through a shortcut of raw
SQL, or through a replayed signature of the gateway. The writes of a
worker identify the service principal in `updated_by` and keep the
principal of the origin in the metadata of the cause and of the audit.

### 11.5 The claim, the retry and the replay

- The due deliveries are claimed atomically with the locks and the
  leases of PostgreSQL, and several worker processes are supported.
- The default concurrency is 4, the default lease is 30 seconds, and
  the heartbeat is every 10 seconds.
- The acknowledgement happens after the handler finished its durable
  effect.
- A worker that crashed, or whose lease expired, makes the delivery
  eligible again.
- The handlers receive `eventId + subscriberId` as a stable identity of
  idempotency.
- A transient failure is retried with an exponential backoff and a
  jitter, from one second to five minutes, at most 8 attempts.
- A permanent refusal of the authorization, or an exhausted budget of
  the retries, marks the delivery as failed for the review of the
  operator.
- The requeue and the replay are an explicit and bounded command of the
  operator, with the attribution of the actor. They do not bypass the
  fresh authorization of the business.
- A subscriber that is missing after a deployment leaves its deliveries
  blocked or failed, with a visible diagnostic. They are never
  acknowledged silently.
- The writes of a subscriber carry the metadata of the cause. A depth
  above 10 is refused before the commit, which bounds the recursive
  loops of the events.

No handler runs inside the transaction of the business. The external
side effects cannot be atomic with PostgreSQL, and they must be
idempotent on the side of the subscriber.

The metadata of the completed events and of the deliveries is kept for
at least seven days. The pending and the failed deliveries MUST NOT be
deleted automatically. The limits of the capacity MUST refuse the new
work before a transaction commits an event that cannot be kept, and the
backlog is observable.

### 11.6 The history of the versions of the records

A collection MAY keep a history of its versions. The manifest of the
collection declares the table of the versions, and the table is created
by a reviewed migration of the deployment: the role of the api never
creates a table and never alters one.

The table of the versions is a **mirror** of the table of the
collection: it holds the same columns, with the same names and the
same types, and the columns of the history:

| Column | What it holds |
| --- | --- |
| `operation` | The change that superseded the version: `update` or `delete`. |
| `changed_fields` | The names of the fields that the change touched. |
| `restored_from` | The version that the change restored, when it was a rollback. |
| `superseded_at`, `superseded_by` | The instant of the change and its principal. |

The rules:

- The table holds the versions that are **not** the current one: the
  current version of a record is the row of the collection itself. A
  record that was deleted holds its tombstone, the image of its last
  version with the operation `delete`.
- The image of a version is written by the **statement of the change
  itself**: the image and the change commit together or not at all, and
  a change that the guard of the write refuses writes no image.
- The image is the row before the change, and it carries the version it
  had. The version of a record never moves back: a rollback is a
  change like any other, and the record holds the version that follows
  the one it had.
- The history is read with the **policies of the deployment**: the
  database evaluates the predicates of the read policies over the image
  of every version, exactly as it evaluates them over the record. A
  version that the caller may not read answers `404 NOT_FOUND`, and it
  is absent from the list of the versions.
- The fields that the policies do not grant are not in the answer of a
  version, and the answer of a version is the canonical representation
  of a record: it carries `id` and `version`, and it carries a
  validator.
- A rollback is a **write**, and not a privileged command: the write
  that restores a version is authorized by the same policies as any
  other update, and a version that the policies forbid to write answers
  `403 FORBIDDEN`. A rollback that the policies accept but that the
  guard of the write refuses is refused.
- A rollback requires a current `If-Match`: the validator of the
  record, or the validator of its tombstone when the record was
  deleted. A stale validator is `412 PRECONDITION_FAILED`.
- A record that was deleted is restored with the image of the version,
  and its version follows the one of its tombstone. The identity of the
  record and the instant of its creation are the ones it had.
- The history of a collection is bounded by the retention of the
  history: the images that are too old are removed by the maintenance
  role. The answer of the list of the versions is bounded as well.

The history of the versions is not the audit: the audit holds the
identifiers of a mutation and the names of the fields that changed,
never the values, and it is never a store of the images. The tables
are different, the retention is different, and the audit may not be
edited by the role of the api.

## 12. The typed client

The repository publishes a client package that:

- uses the versioned HTTP API through Shuttle,
- accepts a base url, a workspace, the fetch and the credentials of the
  caller, and a signal of cancellation,
- implements the queries of the collections and of the schema, the
  traversal of the cursors, the keys of idempotency and the
  preconditions of the records,
- exposes the stable codes of the errors without hiding the refusals of
  the authorization and of the concurrency,
- never issues a signature, never stores the credentials of Hub, never
  runs a login flow and never depends on Studio.

The OpenAPI document covers the fixed protocol, the envelopes, the
endpoints and the cases of the errors. It describes the credentials at
Shuttle as the external boundary of the authentication, and it never
asks a client to manufacture the internal signed headers. The metadata
of the runtime covers the definitions of the fields of the deployment.
The generated types of the collections are build artifacts of a version
of the schema, and they do not replace the validation of the runtime.

The client is the nested package `@data-backend/client` of this
repository. It is published on a registry of packages, and it is
distributed as the tarball of the release, whose name is
`data-backend-client-<version>.tgz`. The root package of the repository
is the service itself, and installing it does not install the client.
The release MUST publish a tarball that installs and works outside of
this repository, and the continuous integration MUST prove it: the
tarball is packed with the command of the release, installed in a
consumer that lives outside of the repository, imported through its
public name and called.

The client is a library of **bun** and of **node**: it carries its own
files, it depends on nothing, and the check of the packaging calls the
API with it once with each runtime.

A studio consumes the same public APIs as any client. It has no
privileged connection to the database and no shortcut to the secrets.
A future screen of the administration of Hub requires a separately
authorized server side adapter to the admin API of Hub, and that is
outside this release.

## 13. The architecture

The service is a modular monolith with an optional separate worker
process. The distribution of the code into more services is not
required.

| The layer | What it owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. |
| `src/app/` | The routes of Hono, the parsing of the HTTP, the establishment of the context, the mapping of the answers and of the errors. |
| `src/domains/<domain>/` | The policies, the use cases, the ports, the public entry point and the tests of a domain. |
| `src/domains/<domain>/adapters/` | The concrete implementations of the ports, assembled by the runtime. |
| `src/platform/bun/` | The listener, the primitives of the transport, the APIs of the process. |
| `src/platform/postgres/` | The lifecycle of the connections, the scoped transactions, the execution of the statements, the mechanics of the migrations. |
| `src/runtime/` | The configuration, the composition root, the subscribers, the readiness, the signals, the drain. |
| `src/observability/` | The structured logs and the interfaces of the metrics. |
| `test/` | The suites of the contract, of the compatibility, of the database, of the load and of the architecture. |

The required domains are `gateway-context`, `workspaces`, `schema`,
`authorization`, `catalog`, `records`, `audit` and `events`. The matrix
of the imports that they may use is in [the architecture](architecture.md),
and the check of the architecture enforces it: it refuses a cycle, even
a cycle of types, and it refuses a catch all directory of shared
implementations.

The core of a domain imports no Hono, no API of Bun, no handler of the
application, no runtime and no concrete adapter. The application imports
the public entry points of the domains and not their internals. Only
the composition constructs the concrete adapters.

The orchestration of the worker lives in the runtime and calls the
public use cases of the domains. The audit and the events accept the
envelopes of primitive types and the injected ports of persistence, and
they do not import the records. A port of the unit of work lets the
records coordinate its repositories, its sink of the audit and its
outbox without importing the concrete adapters of SQL.

## 14. The configuration

The configuration is loaded and validated as a whole before the service
becomes ready. An invalid configuration fails the startup with the name
of the variable and a safe explanation, and it never prints the value
of a secret. There is no remote API of edition of the configuration and
no partial hot reload.

The variables, their defaults and their bounds are in
[the configuration](configuration.md). The rules:

- The numeric inputs MUST be finite and bounded integers. The bounds of
  the requests, of the bodies, of the queries and of the answers
  cannot be disabled with a zero or a negative value.
- The effective timeout is the minimum of the deadlines that apply.
- The production MUST refuse the absent or the placeholder secrets, the
  unprotected urls of the remote dependencies, the unsafe roles of the
  database, the drift of the schema, the bindings that are not verified
  and the unsupported versions of the context of Hub. The secrets come
  from files and from mounts, and never from a command line value that
  is echoed in the logs.
- The development may use the fixtures of Shuttle and of Hub. The
  production requires a PostgreSQL server. The integration tests against
  a real server remain mandatory: an embedded engine alone does not
  establish the isolation, the locking or the correctness of the claims
  of the worker.

## 15. The operations and the lifecycle of the data

### 15.1 The probes and the metrics

| The endpoint | The contract |
| --- | --- |
| `GET /healthz` | `200` with the version of the service and the version of the manifest, while the process is alive. It calls no dependency. |
| `GET /readyz` | `200` only when the configuration, the schema and the policies, the privileges of the role and the recent discovery of the context of Hub pass. Otherwise `503` with a safe code of readiness. |
| `GET /metrics` | The text of Prometheus, with a dedicated bearer token. `404` when it is disabled, `401` when the credentials are invalid or absent. |

The readiness may reuse a successful authenticated discovery of Hub for
at most ten seconds. The workers also require the access to the store
of the deliveries and a valid configuration of the subscribers. The
probes are not routed through the ordinary authorization of a workspace.

The metrics hold the counts and the durations of the requests by the
normalized route and by the status, the duration and the failures of
Hub, the hits of the cache of the context, the waits of the pool of the
database, the refusals of the authorization, the rollbacks of the
transactions, the backlog and the age of the outbox, the failed
deliveries, the retries and the state of the drain. The hits and the
misses of the cache of the catalog are counted as well.

The tenant, the principal, the workspace, the identifier of a record,
the raw url, the e-mail address and the text of a query MUST NOT become
labels of a metric.

### 15.2 The logs

The structured logs hold the identifier of the request, the normalized
route, the action, the safe status or code of the error, the duration
of the dependencies, and the internal identifiers of the tenant and of
the workspace where they are operationally necessary.

The credentials, the cookies, the signatures, the complete filters and
bodies, the values of the business fields, and the connection strings
that hold a secret are redacted. The refusals of the authorization are
observable, without returning the raw reasons of Hub to the caller.

### 15.3 The shutdown and the cancellation

On the shutdown, the process:

1. becomes unready and stops admitting the requests and the claims of
   the deliveries,
2. lets the transactions in flight finish, or cancels and rolls them
   back,
3. stops the execution of the subscribers, and the unfinished
   deliveries keep or release their leases safely,
4. closes the listeners, the transports and the pools exactly once.

The budget of the drain is thirty seconds. A disconnection of a client
cancels the reads in flight. If a mutation committed before the
disconnection, its effect stays committed, and the receipt of the
creation resolves the ambiguous answer of a `POST`.

A connection whose transaction was aborted, or whose state is unknown,
is rolled back and discarded before it can return to the pool.

### 15.4 The retention, the backup and the removal

| The data | The default |
| --- | --- |
| The business records | Owned by the application. No automatic purge. |
| The images of the versions of the records | 90 days, adjustable by the operator. The tables are the ones that the manifest declares. |
| The audit entries | 90 days, adjustable by the operator. |
| The receipts of the creations | At least 24 hours. |
| The metadata of the completed events and of the deliveries | At least seven days. |
| The pending and the failed deliveries | No automatic deletion. The operator resolves them. |

The retention runs with the dedicated privileges of the maintenance, in
bounded batches, with the metrics and the attribution of the operator.
No generic endpoint of a collection can purge the history of the
platform.

The backups hold the business records, the workspaces, the versions of
the manifests and of the bundle of the policies, the state of the
audit, of the outbox and of the deliveries, the images of the versions
of the records, and the history of the migrations. The secrets are backed up and rotated by the secret
management of the deployment. A rehearsal of the restore MUST verify
the isolation of the tenants and the safe resumption of the idempotent
deliveries before the production.

The removal of a tenant or of a workspace is an explicit procedure of
the operator: disable the access, stop the deliveries that are
relevant, satisfy the obligations of the retention and of the export,
and remove the data in bounded operations. Moving a workspace from one
tenant to another is unsupported.

### 15.5 The capacity and the rollout

Before the production, a deployment publishes a repeatable report of the
capacity, with the hardware, the shape of the data, the complexity of
the policies, the concurrent clients, the settings of the pool, the
latencies p50, p95 and p99, the rates of the failures and the age of
the oldest event of the outbox.

The required scenarios:

- a read heavy access without a cache of the context,
- a mixed traffic of creations and of reads under the isolation of the
  tenants,
- the concurrent updates of one record,
- several replicas of the backend and the recovery of the leases,
- the outage of Hub, the slow SQL, the expired authorization and the
  recovery of the dependencies,
- the maximum of the filters, of the sizes of the pages, of the
  expansions and of the budgets of the answers.

A deployment declares its own rate of requests and its own objective of
latency; no number of capacity is a claim of a release without a
measurement. The report MUST show that the memory and the queues stay
bounded, and that the service recovers under the declared load.

The rolling releases preserve the backward compatibility of the schema
and of the API. The destructive migrations require a reviewed plan of
maintenance and a tested path of restore or of forward fix. The
rollback of a database is not assumed to be safe after a migration that
changed the data.

## 16. The verification and the acceptance of a release

No item is complete until its behavior is demonstrated by an
appropriate automated check.

| The suite | The evidence that it requires |
| --- | --- |
| The domain | The evaluation of the predicates, the rules of the fields, the composition of the checks of a write, the validation of the schema, the expiry of the context and the rules of the envelope of the events. |
| The contract of the HTTP | The paths, the envelopes, the limits of the queries, the codes of the errors, the canonical ETags, the receipts of the creations, and the absence of the deferred endpoints. |
| The compatibility of Shuttle | The pinned gateway, unmodified, forwards real requests signed with `ES256` and accepted by the verification of the backend with the public key; the forged signatures, the tampered identities and the mismatches of the workspace fail; the legacy format is refused by a route of the current format. |
| The packaging of the client | The tarball of the client installs outside of the repository, the client is imported through its public name, and it resolves its own files without the dependencies of the service. |
| The drift of the baseline | The manifest of the baseline, the block of the baseline of this specification and the workflows agree. |
| The compatibility of Hub | The real implementation of the context returns the complete set of the keys of the user and of the groups, and it preserves the existing contract of the decisions. |
| The integration with PostgreSQL | The row level security, the composite constraints of the references, the refusal of a missing context, the reuse of the pool, the concurrent checks of the versions, the drift of the migrations and the restrictions of the roles. |
| The failure of a transaction | A failure is injected at every stage of a mutation: the record, the audit, the event and the receipt are all committed, or all absent. |
| The history of the versions | The image of a version is written by the statement of the change, a change that the guard refuses writes no image, a version that the caller may not read is not found, and a rollback is authorized by the policies of the deployment. |
| The integration of the subscribers | The claims of several workers, the expiry of the leases, the duplicated delivery, the exhaustion of the retries, the missing handlers, the revocation of the service principal and the bounds of the depth of the cause. |
| The architecture | The imports that are allowed, the public entry points, the absence of a cycle and the construction of the private adapters. |
| The dead code | The modules that no root reaches, the exported names that nobody reads, and the dependencies that nothing uses. |
| The operations and the load | The deadlines cancel the SQL, the resources stay bounded, the failures of the dependencies fail closed, the drain completes, and the restore is rehearsed. |

The adversarial cases are mandatory:

1. A grant of the workspace A cannot read, write, count, reference or
   expand the data of the workspace B.
2. A grant of Hub for a tenant does not make the registered workspace of
   another tenant accessible.
3. A forged tenant, a forged route, a match of an e-mail address or a
   stale claim of a role cannot influence the authorization.
4. The removal of a group, the revocation and the expiry of a grant, a
   disabled principal and a disabled tenant take effect inside the
   documented bounds of the freshness.
5. The filtering and the sorting by a hidden field are refused; the
   counts and the expansions of the relations cannot bypass the
   policies of the rows.
6. Two policies with complementary sets of fields cannot authorize a
   synthetic write that neither of them permits.
7. An update that moves a row outside of its check is refused
   atomically.
8. The concurrent updates with one ETag yield one successful change of
   version and one refusal of a precondition.
9. A version that the policies of the deployment hide is not found in
   the history, and a rollback that they forbid is refused: the history
   is not a path that bypasses the authorization.
10. A `POST` that is retried after a committed but lost answer creates
    one record and answers its original receipt.
11. The reuse of a key of a creation with another body cannot create
    another record inside the window of the retention.
12. An expired or a malformed context of Hub, the wrong identifiers of
    the context and the incomplete sets of capabilities never allow an
    operation of the data.
13. A connection of a pool never keeps the scope of a previous tenant,
    workspace or principal.
14. The credentials of the runtime cannot disable the row level
    security, alter the schema, edit the history of the audit, or
    query the tables of Hub.
15. A subscriber cannot turn the attribution of an actor into the
    current authorization.
16. The functionality of the backend and all the tests of the API run
    without a process and without a package of Studio.

## 17. The decisions fixed by this contract

1. The service is headless; Studio is a separate project.
2. Hub remains the authority of the identity and of the assignment of
   the capabilities.
3. Shuttle remains the authenticated gateway; the integration uses its
   existing contract of signed identity.
4. A new contract of the access context of Hub is required; the
   snapshots of the stale roles are not enough.
5. The workspaces and the semantics of the policies of the data belong
   to the backend.
6. PostgreSQL, the reviewed migrations and the registered manifests are
   the first supported model of the schema.
7. REST is the first transport, with the metadata, the OpenAPI and a
   small typed client.
8. The audit, the committed events and the receipts of the creations
   are the transactional parts of the correctness of a mutation.
9. The trusted subscribers use an explicit authority of a service
   principal and a delivery of at least once.
10. The assets, the lifecycle of the content, the public realtime, the
    configuration of the workflows, GraphQL, the MCP and the AI, and
    the other database engines need subsequent specifications.

A change of these decisions MUST amend this document and its criteria
of acceptance before it changes the contract of the implementation.
