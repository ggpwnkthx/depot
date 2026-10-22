# The implementation of the headless data backend

This document is the trace of the implementation against the contract of
[`SPECS.md`](SPECS.md). It holds the milestones, the matrix that maps
every requirement of the specification to the code, to the check that
proves it and to the command that runs the check.

**The status of the release:** version 0.1 is implemented and published
as `0.2.0`. It is a pre-production release: it has never run outside
its own harness. The one dependency that the release carries is the
extension of the hub, which is upstream since `4cedcfc` and which has
to be deployed with the hub. The change lives in the repository of the
hub. The baseline of the integration is the manifest
`compatibility.json`: it owns the repositories of the gateway and of the
hub and the revisions that are tested against them.

**What "checked" means.** The last column of the matrix says that a
requirement of the specification is *checked*: a check of this
repository exists, it runs with the command of the fourth column, and it
passes. It does not say that the requirement is *proved*, and the
difference is not a wording: the checks of this repository were written
by the author of the code, and a check of the author of the code is not
an assurance. The service has never run outside its own harness — it has
no production history, no external user and no review that was written
by somebody else. The review of the security of the service, and the
findings that are still open, are in [`docs/security.md`](docs/security.md).

## The milestones

| Milestone | What it holds | The evidence |
| --- | --- | --- |
| **M0 — Contracts and process** | The toolchain, the validated environment, the manifest of the baseline and the check of its drift, the probes, the architecture check, the fixtures of the signature of the gateway and the matrix of this document. | `bun run typecheck`, `bun run architecture`, `bun run check:compatibility`, `bun test test/unit/gateway-context.test.ts` |
| **M1 — Trust and scope** | The exact verification of the Shuttle v5 signature with the public key of the gateway, the legacy format as the migration path it is, the trusted route bindings, the registry of the workspaces, the authoritative context of the hub, the immutable context of a request, the roles and the row level security of PostgreSQL, and the refusals between the scopes. | `bun test test/unit/gateway-context.test.ts`, `bun test test/unit/identity-keys.test.ts`, `bun test test/integration/postgres.test.ts` |
| **M2 — Schema and policies** | The reviewed migrations, the registered manifests, the detection of the drift, the filtered metadata, the typed validation, the predicates of the rows, the permissions of the fields and the complete checks of a write. | `bun test test/unit/authorization.test.ts`, `bun test test/integration/postgres.test.ts` |
| **M3 — Record API** | Every endpoint of version 0.1, the bounded filtering, the sorting and the relations, the authenticated cursors, the canonical representations and their validators, the receipts of the creations, the conditional updates and deletes, the stable errors, the description of the API and the typed client. | `bun test test/contract/http.test.ts`, `bun test packages/client/test` |
| **M4 — Durable effects** | The atomic transactions of the record, the audit, the event and the receipt, the registration of the subscribers, the claims of several workers, the leases and the retries, the bound of the causation and the fresh authorization of the service principal. | `bun test test/integration/transactions.test.ts`, `bun test test/integration/worker.test.ts` |
| **M5 — Operational release** | The failures of the dependencies, the actual cancellation of the statements, the reuse of the pool, the behaviour of several replicas, the drain, the metrics and the redaction, the retention, the rehearsal of the backup, the reproducible measurement of the capacity and the whole acceptance matrix. | `bun run test:compat`, `bun run scripts/capacity.ts`, `bun test test/architecture` |

## The traceability matrix

The commands of the last column are the ones of the repository. Every
one of them has to be green before a release.

### The trust and the scope (§4, §5, §6)

| The requirement | The implementation | The check | The command | The status |
| --- | --- | --- | --- | --- |
| The canonical payload of the identity is the one of the gateway (§4.2) | `src/domains/gateway-context/verify.ts` | `test/unit/gateway-context.test.ts` (the fixtures of the pinned gateway) | `bun test test/unit` | checked |
| The signature is verified with the public key of the gateway, `ES256` and the type `shuttle-identity` (§4.2) | `src/domains/gateway-context/verify.ts` | the same file (the tampering of the path, the query, the host, the subject, the key and the version) | `bun test test/unit` | checked |
| The version, the algorithm and the key of a route are the ones of its binding, and there is no fallback (§4.1, §4.2) | `src/domains/gateway-context/bindings.ts`, `src/domains/gateway-context/index.ts` | `test/unit/gateway-context.test.ts` (the confusion of the version and of the algorithm, the legacy mode) | `bun test test/unit` | checked |
| The key of a route is loaded and validated at the start of the process (§4.2) | `src/runtime/identity-keys.ts` | `test/unit/identity-keys.test.ts` (the private key, the other curve, the other kind of key) | `bun test test/unit` | checked |
| The route and the tenant come from the bindings, never from a header (§4.1) | `src/domains/gateway-context/bindings.ts`, `src/app/app.ts` | `test/unit/gateway-context.test.ts` (the ambiguity of the bindings), `test/contract/http.test.ts` | `bun test test/unit test/contract` | checked |
| The workspace of the path and the workspace of the signature are the same (§4.2) | `src/domains/gateway-context/index.ts` | `test/unit/gateway-context.test.ts` | `bun test test/unit` | checked |
| The context of the hub is validated before it is used (§5.3) | `src/domains/authorization/access-context.ts` | `test/unit/authorization.test.ts`, `test/contract/http.test.ts` | `bun test test/unit test/contract` | checked |
| The context is fresh for the mutations and for the worker commands (§5.4) | `src/domains/authorization/index.ts`, `src/runtime/worker.ts` | `test/integration/worker.test.ts` | `bun test test/integration` | checked |
| The deadline of the authorization is checked before the commit (§5.4) | `src/domains/records/service.ts`, `src/platform/postgres/scoped.ts` | `test/integration/transactions.test.ts` | `bun test test/integration` | checked |
| The registry is read with a narrow reader (§6.3) | `src/platform/postgres/adapters.ts`, `migrations/0004_isolation.sql` | `test/integration/postgres.test.ts` (the three columns) | `bun test test/integration` | checked |
| The isolation of the rows is enforced by the database (§6.4) | `migrations/0004_isolation.sql`, `src/platform/postgres/scoped.ts` | `test/integration/postgres.test.ts` | `bun test test/integration` | checked |
| A pooled connection keeps no scope (§6.4) | `src/platform/postgres/scoped.ts` | `test/integration/postgres.test.ts` (the reuse of the pool) | `bun test test/integration` | checked |
| The relations are composite and they reject the references of another scope (§6.4) | `migrations/0003_collections.sql` | `test/integration/postgres.test.ts` | `bun test test/integration` | checked |
| The runtime role may not alter the schema, edit the audit or read the deliveries (§6.4) | `migrations/0004_isolation.sql` | `test/integration/postgres.test.ts` | `bun test test/integration` | checked |

### The schema and the authorization (§7, §8)

| The requirement | The implementation | The check | The command | The status |
| --- | --- | --- | --- | --- |
| The manifests are validated as a whole and the unknown properties are refused (§7.1) | `src/domains/schema/manifest.ts` | `test/unit/authorization.test.ts` (the bundle of the deployment is parsed) | `bun test test/unit` | checked |
| The drift between the manifest and the schema stops the readiness (§7.5) | `src/platform/postgres/migrations.ts` | `test/integration/postgres.test.ts` (the drift) | `bun test test/integration` | checked |
| The server maintained fields may not be written (§7.3) | `src/domains/records/validation.ts` | `test/contract/http.test.ts` (`SERVER_FIELD`) | `bun test test/contract` | checked |
| The types and the bounds are checked on the server (§7.4) | `src/domains/records/validation.ts` | `test/contract/http.test.ts` (`MAX_LENGTH`) | `bun test test/contract` | checked |
| The read composition exposes a field only when a policy that matches the row grants it (§8.2) | `src/domains/records/service.ts` (the projection of the statement) | `test/contract/http.test.ts`, `test/unit/authorization.test.ts` | `bun test test/unit test/contract` | checked |
| The two evaluations of a predicate agree (§8.2) | `src/domains/authorization/filter.ts` | `test/integration/filter.test.ts` (the differential test against the server), `test/contract/null-semantics.test.ts` | `bun test test/integration test/contract` | checked || The filter and the sort use the intersection of the policies (§8.2) | `src/domains/records/service.ts` | `test/contract/http.test.ts` (the filter of a hidden field) | `bun test test/contract` | checked |
| A write is authorized by one complete policy (§8.3) | `src/domains/authorization/rules.ts` | `test/unit/authorization.test.ts` | `bun test test/unit` | checked |
| The update checks the row before and the row after (§8.3) | `src/domains/records/service.ts` | `test/unit/authorization.test.ts` (the write that moves the row) | `bun test test/unit` | checked |
| The relations are expanded with the policies of the target (§8.4) | `src/domains/records/service.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The metadata is filtered and it never carries a SQL identifier (§9.2) | `src/app/schema-metadata.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| A workspace serves the collections it registered, and nothing else (§7.6) | `src/domains/catalog/index.ts`, `src/domains/records/service.ts` | `test/unit/catalog.test.ts`, `test/contract/catalog.test.ts` | `bun test test/unit test/contract` | checked |
| A registration never creates or alters a table, and a registration that names another table is refused (§7.6) | `src/domains/catalog/index.ts`, `migrations/0006_catalog.sql` | `test/unit/catalog.test.ts`, `test/integration/catalog.test.ts` | `bun test test/unit test/integration` | checked |
| The registry of a workspace is read with the registry of the workspaces, and another workspace is invisible (§7.6) | `src/platform/postgres/catalog.ts`, `migrations/0006_catalog.sql` | `test/integration/catalog.test.ts` (the row level security, the narrow reader) | `bun test test/integration` | checked |
| The bundle a workspace published applies, and a bundle that cannot be used fails closed (§8.6) | `src/domains/catalog/index.ts` | `test/unit/catalog.test.ts`, `test/contract/catalog.test.ts` | `bun test test/unit test/contract` | checked |
| The catalog is memoized with the fingerprint of its inputs, and an edited bundle is parsed again (§8.6) | `src/domains/catalog/index.ts` | `test/unit/catalog.test.ts`, `test/contract/catalog.test.ts` | `bun test test/unit test/contract` | checked |
| The publication of a bundle is an operator command and never an HTTP route (§8.6) | `scripts/policy.ts`, `scripts/collection.ts` | the absence of a route in `src/app/app.ts` and the command itself | `bun run architecture`, `bun test test/contract` | checked |
| The negation of a predicate follows the three valued logic of the database (§9.3) | `src/domains/authorization/filter.ts` | `test/integration/filter.test.ts` (the differential test against the server), `test/unit/authorization.test.ts` | `bun test test/integration test/unit` | checked |
| The aggregate reads the rows that the list reads, with the same predicates and the same filter (§9.8) | `src/domains/records/service.ts`, `src/domains/records/sql.ts` | `test/contract/aggregate.test.ts` | `bun test test/contract` | checked |
| The fields of an aggregate are the fields the caller may filter and sort by (§9.8) | `src/domains/records/service.ts` | `test/contract/aggregate.test.ts` | `bun test test/contract` | checked |
| The groups of an aggregate are bounded, and the answer says when they are not all of them (§9.8) | `src/domains/records/service.ts` | `test/contract/aggregate.test.ts` | `bun test test/contract` | checked |
| The search reads the fields the deployment declares searchable, and the index of the search is used (§9.9) | `src/domains/records/sql.ts`, `migrations/0007_search.sql` | `test/contract/search.test.ts`, `test/integration/search.test.ts` (the plan of the database) | `bun test test/contract test/integration` | checked |
| A search never reaches the predicates of a policy (§9.9) | `src/domains/records/service.ts` | `test/contract/search.test.ts` | `bun test test/contract` | checked |
| Two replicas serve the same records, and the drain of one leaves the other serving (§15.3) | `src/runtime/composition.ts` | `test/integration/replicas.test.ts` | `bun test test/integration` | checked |

### The API and the transactions (§9, §10)

| The requirement | The implementation | The check | The command | The status |
| --- | --- | --- | --- | --- |
| The paths, the envelopes and the errors (§9.1, §9.7) | `src/app/app.ts`, `src/app/errors.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The deferred endpoints are absent (§2.2) | `src/app/app.ts` | `test/contract/http.test.ts` (the deferred paths) | `bun test test/contract` | checked |
| The list is bounded and the count uses the same predicates (§9.3) | `src/domains/records/service.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The cursor is signed, it binds the query and it expires (§9.4) | `src/domains/records/canonical.ts` | `test/contract/http.test.ts` (the traversal), `test/unit/authorization.test.ts` | `bun test test/unit test/contract` | checked |
| The pages of a collection cover it in the order of the database, in the three orders of the service (§9.4) | `src/domains/records/sql.ts` | `test/contract/http.test.ts` (the pagination), `scripts/scale.ts` (the walk of every page) | `bun test test/contract` | checked |
| A read of a page costs the page and not the scope (§9.3) | `src/domains/records/service.ts` | `scripts/scale.ts` (the plan of the statement at a million rows) | `bun run scripts/scale.ts` | checked |
| The validator is the digest of the canonical bytes (§9.5) | `src/domains/records/canonical.ts` | `test/contract/http.test.ts` (the update with a current and with an old validator) | `bun test test/contract` | checked |
| The creation needs an idempotency key and answers a minimal receipt (§9.6) | `src/domains/records/service.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The replay of a key answers the original receipt (§9.6) | `src/domains/records/service.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The record, the audit, the event and the receipt commit together (§10) | `src/domains/records/service.ts` | `test/integration/transactions.test.ts` (the failure at every stage) | `bun test test/integration` | checked |
| The transaction deadline cancels the statement (§10, §14) | `src/platform/postgres/scoped.ts` | `test/integration/postgres.test.ts` | `bun test test/integration` | checked |

### The persistence, the events and the operations (§11, §14, §15)

| The requirement | The implementation | The check | The command | The status |
| --- | --- | --- | --- | --- |
| The audit log is append only and it holds no value (§11.2) | `migrations/0002_platform.sql`, `src/platform/postgres/adapters.ts` | `test/contract/http.test.ts` (the metadata of the audit) | `bun test test/contract` | checked |
| The event carries the identifiers and the names of the fields (§11.3) | `src/domains/records/service.ts`, `src/platform/postgres/adapters.ts` | `test/integration/transactions.test.ts` | `bun test test/integration` | checked |
| The subscribers are registered by the deployment (§11.4) | `src/runtime/subscribers.ts`, `src/runtime/composition.ts` | `test/integration/worker.test.ts` | `bun test test/integration` | checked |
| The delivery is at least once and the lease recovers (§11.5) | `src/platform/postgres/adapters.ts`, `src/runtime/worker.ts` | `test/integration/worker.test.ts` | `bun test test/integration` | checked |
| The depth of the chain of the events is bounded (§11.5) | `src/runtime/worker.ts` | `test/integration/worker.test.ts` | `bun test test/integration` | checked |
| The environment is validated as a whole (§14) | `src/runtime/config.ts` | the start of the service refuses an invalid environment | `bun run start` | checked |
| The probes answer without the authorization of a workspace (§15.1) | `src/app/app.ts`, `src/runtime/readiness.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The health probe answers the version of the service (§15.1) | `src/app/app.ts`, `src/version.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The token of the metrics is compared in constant time (§15.1) | `src/app/secrets.ts` | `test/unit/secrets.test.ts` | `bun test test/unit` | checked |
| The metrics have bounded labels (§15.1) | `src/observability/metrics.ts` | the metrics of the process | `bun run start` | checked |
| The metrics of the hub, of the cache, of the pool and of the rollbacks are recorded (§15.1) | `src/domains/authorization/adapters/hub-access-context.ts`, `src/domains/authorization/index.ts`, `src/platform/postgres/database.ts`, `src/platform/postgres/scoped.ts` | `test/unit/metrics.test.ts` | `bun test test/unit` | checked |
| The buckets of the histograms are cumulative (§15.1) | `src/observability/metrics.ts` | `test/unit/metrics.test.ts` | `bun test test/unit` | checked |
| The drain is bounded and the pools close once (§15.3) | `src/platform/bun/server.ts`, `src/main.ts` | the harness of the compatibility stops the processes with a signal | `bun run test:compat` | checked |
| The retention runs with the maintenance role, in batches (§15.4) | `scripts/retention.ts` | the command of the operator | `bun run scripts/retention.ts` | checked |
| The backup and the restore are rehearsed (§15.4) | `scripts/backup.sh`, `scripts/restore.sh` | the rehearsal of the restore (the record of the run is in `docs/backup-restore.md`) | `./scripts/restore.sh` | checked |
| The capacity is measured and published (§15.5) | `scripts/capacity.ts`, `docs/capacity.md` | the measurement of the development machine | `bun run scripts/capacity.ts` | checked |

### The client, the boundaries and the compatibility (§12, §13, §16, §17)

| The requirement | The implementation | The check | The command | The status |
| --- | --- | --- | --- | --- |
| The client uses the API through the gateway and it hides nothing (§12) | `packages/client/src/index.ts` | `packages/client/test/client.test.ts` | `bun test packages/client/test` | checked |
| The types of the collections of a deployment are the types of its manifest (§12) | `scripts/generate-client.ts`, `packages/client/src/deployment.ts` | `packages/client/test/client.test.ts`, the check of the generated file | `bun run scripts/generate-client.ts --check` | checked |
| The image of the service holds the artifacts and it starts (§15) | `Dockerfile`, `docker-compose.yml` | the job of the image of the continuous integration | `docker build .` | checked |
| The description of the API is published (§12) | `src/app/openapi.ts` | `test/contract/http.test.ts` | `bun test test/contract` | checked |
| The imports follow the matrix and there is no cycle (§13) | `scripts/architecture.ts` | `test/architecture/architecture.test.ts` | `bun run architecture` | checked |
| The forged roles, the forged e-mail and the revoked grants never influence the authorization (§16) | `src/domains/authorization/`, `src/app/app.ts` | `test/contract/adversarial.test.ts` | `bun test test/contract` | checked |
| The expired and the malformed contexts never allow a data operation (§16) | `src/domains/authorization/access-context.ts` | `test/contract/adversarial.test.ts` | `bun test test:contract` | checked |
| Two updates with the same validator answer one success and one refusal (§16) | `src/domains/records/service.ts` | `test/contract/adversarial.test.ts` | `bun test test/contract` | checked |
| The pinned gateway forwards the requests the backend accepts, and it signs them with `ES256` (§16) | `scripts/compatibility.ts` | the harness of the compatibility | `bun run test:compat` | checked |
| The real hub answers the complete set of the keys and the decision still works (§16) | the extension of the hub (`4cedcfc`), the baseline of `compatibility.json` | the harness of the compatibility | `bun run test:compat` | checked |
| The baseline of the integration is one manifest, and the documentation agrees with it (§1.1) | `compatibility.json`, `scripts/compatibility-manifest.ts` | `test/unit/compatibility.test.ts`, `scripts/check-compatibility.ts` | `bun run check:compatibility` | checked |
| The packed client is installed and used outside of the repository (§12) | `packages/client`, `scripts/check-client-package.ts` | the check of the packaging | `bun run check:client-package` | checked |
| The acceptance scenario of §17 succeeds through the gateway | `scripts/compatibility.ts` | the harness of the compatibility | `bun run test:compat` | checked |
| The service works without a studio (§1.3, §15) | the whole repository | there is no dependency on a studio: the repository has no studio package and no studio process | `bun run typecheck`, `bun run test:all` | checked |

## The verification matrix of the specification (§16)

| The suite | The command | The result of the last run |
| --- | --- | --- |
| The rules of the domains | `bun test test/unit` | 76 passed |
| The contract of the API | `bun test test/contract` | 75 passed |
| The database, the transactions and the worker | `bun test test/integration` | 44 passed |
| The boundaries of the code | `bun test test/architecture` | 2 passed |
| The consumer of the client | `bun test packages/client/test` | 13 passed |
| The whole repository | `bun run test:all` | 210 passed |
| The gateway, the hub and the backend | `bun run test:compat` | 21 steps, passed |
| The capacity | `bun run scripts/capacity.ts` | four scenarios, the report of `docs/capacity.md` |
| The shape of the statements at scale | `bun run scripts/scale.ts` | the plan of a page at a million rows, and the walk of every page |

## The gates of a release

A release is a green run of:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run architecture
bun test test/unit test/contract test/integration test/architecture packages/client/test
bun run test:compat
```

The gates of the operations are the rehearsal of the backup and of the
restore, the measurement of the capacity and the declaration of the
rate and of the latency objective of the deployment.
