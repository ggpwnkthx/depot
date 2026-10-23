# The development of the service

## The layout of the repository

| The path | What it holds |
| --- | --- |
| `src/app/` | The routes of Hono, the parsing, the establishment of the context, the OpenAPI and the secrets. |
| `src/domains/` | The rules of the service, one directory per domain. |
| `src/platform/` | The listener of Bun and the adapters of PostgreSQL. |
| `src/runtime/` | The configuration, the composition root, the subscribers, the readiness and the drain. |
| `src/observability/` | The logs and the metrics. |
| `src/protocol/` | The errors, the clock and the envelopes that the domains share. |
| `scripts/` | The commands of the operator and the commands of the measurement. |
| `test/` | The suites of the tests. |
| `packages/client/` | The typed client of the API. |
| `manifests/` | The manifest of the collections and the bundle of the policies of this deployment. |
| `migrations/` | The reviewed migrations of the schema. |
| `docs/` | The documentation. |

The architecture is in [the architecture](architecture.md), and the
matrix of the imports that the domains may use is there.

## The suites of the tests

| The suite | The command | What it proves |
| --- | --- | --- |
| The rules of the domains | `bun test test/unit` | The evaluation of the predicates, the rules of the fields, the composition of the checks of a write, the validation of the schema, the expiry of the context, the verification of the identity, the secrets and the metrics. |
| The contract of the API | `bun test test/contract` | The paths, the envelopes, the limits of the queries, the codes of the errors, the canonical ETags, the receipts, the aggregates, the search, the catalog and the cases of the attack. |
| The database and the worker | `bun test test/integration` | The row level security, the transactions, the claims of the workers, the replicas, the differential test of the predicates, the differential test of the guard of a write and the plan of the search. |
| The boundaries | `bun test test/architecture` | The imports that are allowed, the absence of a cycle and the construction of the private adapters. |
| The power of the suites | `bun run test:mutation` | The gate that breaks the code on purpose and checks that the suites notice: a mutation that survives is a behaviour that nothing in the repository proves. |
| The consumer of the client | `bun test packages/client/test` | The client against a mocked API. |
| The whole repository | `bun run test:all` | Every suite above. |
| The platform | `bun run test:compat` | The real gateway, the real Hub and the real backend, with the acceptance scenario through the gateway. |

The integration tests and the harness start a PostgreSQL server of
their own: the isolation, the locking and the claims of the workers are
the behaviour of a server and not of an embedded engine. The server is
the version 18, the version that the suites prove, and the script that
starts it warns when the machine has another major.

Two of the suites are not ordinary tests:

- the **differential test** of the predicates (`test/integration/filter.property.test.ts`)
  generates the predicates that were not written by hand, and it
  compares the answer of the database with the answer of the
  evaluation in memory, row by row,
- the **differential test** of the guard of a write
  (`test/integration/write-guard.test.ts`) generates the policies of a
  write, it compares the evaluation in memory of their predicates with
  the statement that the database evaluates, over the row before the
  change and over the row after it,
- the **fuzzing** of the trust boundary (`test/unit/fuzz.test.ts`) writes
  random filters, random json and random signatures, and it checks that
  nothing of the caller reaches a statement as an identifier, and that
  the verification never throws.

## The gates of a release

A release is a green run of:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run architecture
bun run deadcode
bun test test/unit test/contract test/integration test/architecture packages/client/test
bun run test:mutation
bun run test:compat
```

The gates of the operations are the rehearsal of the backup and of the
restore, the measurement of the capacity, and the declaration of the
rate and of the latency objective of the deployment.

The continuous integration also audits the dependencies, and it refuses
a build whose dependencies carry a known vulnerability.

## The scripts

| The command | What it does |
| --- | --- |
| `bun run scripts/provision.ts` | Creates the roles of the separation and the database. |
| `bun run scripts/migrate.ts` | Applies the migrations with the owner of the schema. |
| `bun run scripts/workspace.ts` | `create`, `enable`, `disable`, `list` of the workspaces. |
| `bun run scripts/collection.ts` | `register`, `enable`, `disable`, `list` of the collections of a workspace. |
| `bun run scripts/policy.ts` | `publish`, `list`, `show` of the bundles of a workspace. |
| `bun run scripts/delivery.ts` | `list`, `requeue`, `backlog` of the deliveries. |
| `bun run scripts/retention.ts` | The retention of the history. |
| `bun run scripts/backup.sh`, `restore.sh` | The backup and the rehearsal of the restore. |
| `bash scripts/rehearse-backup.sh` | The rehearsal of the backup and of the restore, on a server of its own. |
| `bun run scripts/architecture.ts` | The check of the boundaries of the code. |
| `bun run deadcode` | The hunt of the dead code: the modules that no root reaches, the names that nobody reads and the dependencies that nothing uses. |
| `bun run scripts/capacity.ts` | The measurement of the capacity. |
| `bun run scripts/scale.ts` | The plan of the statements at a million rows, and the walk of every page. |
| `bun run scripts/generate-client.ts` | The types of the collections of the manifest. |
| `bun run scripts/generate-fixtures.ts` | The fixtures of the signature, from the pinned gateway. |
| `bun run scripts/check-compatibility.ts` | The check of the drift of the baseline of the integration. |
| `bun run scripts/check-client-package.ts` | The packed client, installed outside of the repository. |
| `bun run scripts/compatibility.ts` | The harness of the compatibility. |
| `bun run scripts/tag-release.ts` | The tag of the release, when the version of the project increased. |

Every script is an operator command: it runs on the machine of the
deployment, it is not an HTTP route, and it never bypasses Hub. The
credentials that they need are in [the configuration](configuration.md).

## The tag of a release

The release of the service is a tag: `v1.0.0` names the version
`1.0.0`, and the workflows of the release — the image, the binaries of
the seven platforms, the client and the checksums — run on the tag.

**The tag is created by the workflow of the repository.** The workflow
`the tag of the release` runs **after** the continuous integration of
the commit is green on the `main` branch: it reads the version of the
project, it compares it with the tags that exist, and it creates and
pushes the tag when the version increased. A release of a commit that
did not pass the tests is a release that has to be withdrawn, and the
tag names the commit that the continuous integration proved.

```bash
# the tag that the workflow would create, without creating it
bun run scripts/tag-release.ts --dry-run
```

The command is the same one, and it can be run by hand. It refuses a
project whose three versions do not agree — the manifest of the
service, the manifest of the client and the `ARG VERSION` of the
`Dockerfile` — and it compares the versions as numbers and never as
texts: `0.10.0` is greater than `0.9.0`.

**The release is dispatched, and it is not triggered.** A push made
with the token of the repository does not start a workflow by itself:
GitHub holds the events of the token of the repository back, so that a
workflow cannot make itself run in a loop. The workflow that cuts the
tag dispatches the workflow of the image and the workflow of the
binaries on the tag, and they run in the context of that tag: the
version, the revision and the image are the ones of the tag. A tag
that is pushed by hand starts them by itself, as it always did. No
secret of the repository is needed for it.

The tag is annotated, and git refuses an annotated tag without the
identity of the commit: the workflow sets the identity of the release
before it cuts the tag, and the command falls back to it when the
checkout has none, so that a runner without an identity of its own
still cuts the tag.

The version of a release is written in one command, and it is
written in the three files of the project — the manifest of the
service, the manifest of the client and the `ARG VERSION` of the
`Dockerfile`:

```bash
bun run scripts/tag-release.ts --set 1.0.0
git commit -m "release: the version 1.0.0 of the service, of the client and of the image"
git push origin main
```

The push of the commit is the trigger: the continuous integration runs,
and the workflow that waits for it reads the version, compares it with
the tags, and creates the tag. The command refuses a version that is
not greater than the version of the latest tag, and the continuous
integration refuses a commit whose three versions do not agree.

## The milestones of the implementation

| The milestone | What it holds |
| --- | --- |
| **M0 — Contracts and process** | The toolchain, the validated environment, the manifest of the baseline and the check of its drift, the probes, the check of the architecture, the fixtures of the signature of the gateway. |
| **M1 — Trust and scope** | The exact verification of the signature of Shuttle with the public key of the gateway, the trusted route bindings, the registry of the workspaces, the context of Hub, the roles and the row level security of PostgreSQL, and the refusals between the scopes. |
| **M2 — Schema and policies** | The reviewed migrations, the registered manifests, the detection of the drift, the filtered metadata, the typed validation, the predicates of the rows, the permissions of the fields and the complete checks of a write. |
| **M3 — Record API** | Every endpoint of the release, the bounded filtering, the sorting and the relations, the authenticated cursors, the canonical representations and their validators, the receipts of the creations, the conditional updates and deletions, the stable errors, the description of the API and the typed client. |
| **M4 — Durable effects** | The atomic transactions of the record, of the audit, of the event and of the receipt, the registration of the subscribers, the claims of several workers, the leases and the retries, the bound of the causation and the fresh authorization of the service principal. |
| **M5 — Operational release** | The failures of the dependencies, the real cancellation of the statements, the reuse of the pool, the behaviour of several replicas, the drain, the metrics and the redaction, the retention, the rehearsal of the backup, the reproducible measurement of the capacity and the whole matrix of the acceptance. |

## What "checked" means

The suites of this repository prove that a requirement of the
specification is **checked**: a check exists, it runs with a command of
the repository, and it passes. It does not say that the requirement is
**proved**, and the difference is not a wording: the checks of this
repository were written by the author of the code, and a check of the
author of the code is not an assurance. The service has never run
outside its own harness — it has no production history, no external
user and no review that was written by somebody else.

The version `1.0.0` is a release candidate, and the gates that are
outside the repository are listed in [the readiness of the version
1.0.0](release-readiness.md). The review of the security of the
service, and the findings that are still open, are in [the
security](security.md).

## Adding a collection

A collection is a physical table and a logical registration. Both are
reviewed artifacts:

1. write the migration that creates the table, with its columns, its
   composite relations and its row level security, and apply it with
   `bun run migrate`,
2. declare the collection in `manifests/schema.json`, with its fields,
   its bounds and its relations,
3. write the policies of the collection in `manifests/policies.json`,
4. regenerate the types of the client with
   `bun run scripts/generate-client.ts`,
5. register the collection for the workspaces that serve it, with
   `bun run collection -- register`.

The runtime role never creates a table and never alters one: a table
that is not described by a migration is not part of the deployment.
