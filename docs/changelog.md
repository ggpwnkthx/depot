# The changes of the service

The changes are listed from the newest to the oldest. The format
follows the keep a changelog: the version, the date, and the changes
grouped by what they change for a client.

A version that changes what a client depends on is a major version. The
rules of the change are in [`docs/api.md`](api.md).

The releases that are published are in the [releases of the
repository](https://github.com/ggpwnkthx/depot/releases).

## Unreleased

The changes that are not published yet. They are the step that is left
before the version `1.0.0`: the gates of the repository are green, and
the two gates that are outside of it are listed in
[the readiness of the version 1.0.0](release-readiness.md).

## 0.3.0 — the history of a record and the current platform (2026-10-23)

A collection may keep the history of the versions of its records, and a
record may be rolled back to one of them with the policies of the
deployment. The predicate of a write is evaluated by the database
itself, and the row that the write produces is the row that the
policies are read over. The baseline of the integration is the pair
that the platform publishes: the release `v1.2.0` of the gateway and
the release `v1.0.0` of Hub.

The contract of the API does not change: the path of every route is
still `v1`, the identity of the gateway is still the version `v5`, and
the access context of Hub is still the version `1`. The changes that
are added are added under the path that exists.

**This release changes the baseline of a deployment.** A deployment
that runs the gateway and Hub runs the pair of the baseline: the
release `v1.2.0` of the gateway and the release `v1.0.0` of Hub. The
gateway does not sign the legacy format `v4` of the identity any
more, so a deployment that still verifies the identity with the derived
key of the gateway has to declare it with `DATA_LEGACY_IDENTITY=allow`
until it moves to the public key; the steps are in
[the getting started](getting-started.md).

### Added

- **The history of the versions of a record.** A collection may keep
  a history: the manifest declares the table of the versions, and the
  table is a mirror of the table of the collection. The image of a
  version is written by the statement of the change itself, so the
  image and the change commit together, and a change that the guard
  refuses writes no image. The endpoints are
  `GET /items/{collection}/{id}/versions`,
  `GET /items/{collection}/{id}/versions/{version}` and
  `POST /items/{collection}/{id}/rollback`. A version is read with the
  policies of the deployment, exactly like a record: a version that the
  caller may not read answers `404`, and the fields that the policies
  hide are not in the answer. The rollback is a write and not a
  privileged command — the same policies authorize it, the version of
  the record never moves back, and a record that was deleted is
  restored with the image of its version. The images are purged after
  ninety days by the command of the retention, and the audit keeps its
  rule: it holds the names of the fields that changed and never their
  values.
- **The gate of the mutation.** The gate breaks the code on purpose —
  the type of the protected header, the expiry of a cursor, the scope
  of a cursor, the fields of a row, the predicates of a write, the
  bound of the cache of the context, the connection of the pool — and
  it checks that the suites notice. A mutation that survives is a
  behaviour that nothing in the repository proves. The gate found five
  of them, and the suites that prove them were written.
- **The bound of a tenant.** The bound of the listener is the bound of
  the machine, and a tenant that sent more requests than the others
  took the room of the others. The bound of a tenant answers a `429
  TOO_MANY_REQUESTS` with a `Retry-After`. The room of a tenant is the
  room of the process until the deployment declares another one, and a
  deployment with several tenants declares it with
  `DATA_MAX_IN_FLIGHT_REQUESTS_PER_TENANT`.
- **The bound of the cache of the context.** The cache is bounded, and
  the entries that are spent leave it. It is declared with
  `DATA_CONTEXT_CACHE_MAX_ENTRIES`.

- **The tag of the release is created by the workflow of the
  repository.** The workflow `the tag of the release` runs on every push
  to the `main` branch: it reads the version of the project, it
  compares it with the tags that exist, and it creates and pushes the
  tag when the version increased. The command
  `bun run scripts/tag-release.ts` is the same one, and it writes the
  version of the release in the three files of the project with
  `--set`. The push of the tag needs a personal access token with the
  permission `contents: write`, the secret `RELEASE_TOKEN`: a push
  made with the token of the repository does not start the workflows of
  the release.
- **The differential test of the guard of a write**
  (`test/integration/write-guard.test.ts`): it generates the policies
  of a write, it writes the rows they are read over, and it compares
  the evaluation in memory with the statement of the database. It is a
  step of the continuous integration, with the seeds of the other
  generated checks.
- **The capacity of the release candidate of the version `1.0.0`** is
  measured and published in [the capacity](capacity.md), with the same
  command as the version `0.2.0`.

### Changed

- **The baseline of the integration is the release `v1.2.0` of the
  gateway and the release `v1.0.0` of Hub.** The manifest
  `compatibility.json` holds the revisions that the compatibility
  harness proves: the gateway is `v1.2.0` and the hub is `v1.0.0`.
  It is the pair that the platform publishes together: the manifest of
  Hub `v1.0.0` pins the gateway `v1.2.0`. The contract of the API does
  not change: the identity of the gateway is still the version `v5`,
  the access context of Hub is still the version `1`, and the
  acceptance scenario through the gateway passes with the two releases.
- **The guide of the compatibility owns the copy of the manifest.** The
  guide showed the revisions of the baseline in a block of its own, and
  a revision that is written twice drifts. The block is generated from
  the manifest, and the check of the drift proves that the two agree.
- **The symmetric format `v4` of the identity of the gateway is gone
  from the gateway.** The gateway does not sign it any more: its key
  was shared with the upstreams, so an upstream that verified an
  identity could mint one. The service still refuses the format by
  default, and the compatibility harness proves that refusal with a
  signature it builds itself.
- **The fixture of the identity is the one of the revision of the
  baseline.** The generator of the fixture used a signer of the
  gateway that the release `1.0.0` of the gateway removed, so the
  fixture could not be regenerated any more. The signatures of the
  current format still come from the code of the pinned gateway, and
  the derivation of the key of the legacy format — the only part that
  the gateway does not offer any more — is local. The fixture carries
  the revision it comes from, and the suite refuses a fixture that does
  not carry the revision of the manifest.
- **The predicate of a write is evaluated by the database.** The
  statement of the write carries the `where` and the `check` of the
  applicable policies, compiled by the same compiler as the queries.
  The row after the change is given to the database as a common table
  expression of bound parameters, so the check of a write is the check
  of the row that the write produces, and not the check of a row that
  the memory assembled. The evaluation in memory stays as the oracle of
  the check: it refuses a write before it touches the database, and a
  write that the statement refuses is refused.
- **The row after the change carries the fields that the server
  maintains.** The `updated_at`, the `updated_by` and the `version` of
  the row that an update produces are part of the check of the
  policies. A policy that checks them was checked against the values
  that the row had before the change.
- **The representation of a record is built by the database, in the
  write path too.** The statement that locks the row computes the
  flags of the read policies, and the representation of the record is
  built from those flags. The service does not evaluate a predicate of
  a policy in memory any more, and the validator of a record is the
  same whether the record was read or written.
- **The development machine, the tests and the continuous integration
  use PostgreSQL 18.** The suites prove the semantics of a version, and
  they now prove the semantics of the newest major that a deployment
  may meet. The service does not require a major: a deployment may run
  PostgreSQL 15 or later, and the commands of the backup and of the
  restore refuse a client that is older than their server with a
  message that names both versions.

### Deprecated

- **The legacy verification of the identity of the gateway.** The
  symmetric format `v4` is a signing capable secret of the gateway, and
  a deployment that holds it holds the power to mint an identity. The
  new variable `DATA_LEGACY_IDENTITY` decides what the service does
  with it: `refuse` (the default of the version `1.0.0`), `warn` or
  `allow`. The format is removed in the version `2.0.0`.

  **This release changes the configuration of a deployment.** A
  deployment that verifies the identity of the gateway with the public
  key keeps working without a change. A deployment that still uses the
  legacy format has to declare it with `DATA_LEGACY_IDENTITY=allow`, and
  it has to move to the public key of the gateway: the steps are in
  [the getting started](getting-started.md).

### Fixed

- **The failures of the database are the codes of the contract.** A
  lock that was not granted in time, a constraint that was violated
  and a statement that ran out of its budget were answered with a
  `500 INTERNAL_ERROR`. They are answered with the codes that the
  contract publishes: `409 CONFLICT`, `422 VALIDATION_FAILED`,
  `504 DEADLINE_EXCEEDED` and `503 DATABASE_UNAVAILABLE`. The
  translation of the SQLSTATE of the server is one table, in the
  platform layer.
- **A refusal of a cursor is not an internal error.** A cursor that
  was tampered with answered `500 INTERNAL_ERROR`; it answers the
  `400 INVALID_CURSOR` of the contract, and a cursor that expired
  answers `409 CURSOR_STALE`.
- **A statement that failed does not take the connection of the pool
  with it.** A failing statement marked the transaction as broken, and
  a broken connection was neither returned to the pool nor destroyed:
  the connection was lost. Twenty failing writes exhausted the pool
  of the api and every request of the deployment answered `503`
  afterwards. A connection that is broken is destroyed, and a statement
  that fails does not break a connection.
- **The budget of the size of an answer bounds the memory.** The four
  mebibytes of the contract were checked once the answer was built.
  The budget is spent as the answer is built, and an answer that is
  refused is never built.
- **The expansion of a relation is read with one statement.** The
  expansion was read with one statement per root row of the page, and
  it was read in one piece. It is read in chunks whose size follows
  the size of the rows, and the relation of a page is read at once.

- **The backup of a deployment works with the roles of the
  deployment.** The tables of the deployment carry the row level
  security, and it is forced: the owner of a table is subject to it.
  The backup was taken with the owner of the schema, and `pg_dump`
  refused to read the rows. The command of the backup refuses a role
  that is subject to the policies of the tables and names the role that
  bypasses them, and the command of the restore gives the ownership of
  the restored tables back to the owner of the schema.
- **The rehearsal of the backup and of the restore is a command of the
  repository.** `bash scripts/rehearse-backup.sh` starts a server of
  its own, it provisions the roles, it applies the migrations, it
  writes a workspace and its record, and it runs the two commands of
  the deployment. The rehearsal of the release candidate of the version
  `1.0.0` is in [the backup and the restore](backup-restore.md).

## 0.2.0 — the public key of the identity of the gateway (2026-10-22)

The gateway signs the identity of a request with the private key of its
deployment, and the backend verifies it with the public one: a backend
that verifies an identity cannot mint one. The bindings of the gateway
name the verification of their own signatures, and the baseline of the
integration is one manifest.

**This release changes the configuration of a deployment.** A deployment
that keeps the file of the bindings of the version 1 keeps working: it
is read as the legacy mode it is. A deployment that moves to the public
key writes the file of the version 2 and gives the gateway the private
key of the pair; the steps are in [the getting started](getting-started.md).

### Changed

- The **identity of the gateway** is verified with the **public** key of
  the gateway, with the version `v5` of the signature and the algorithm
  `ES256`. The backend never holds the private key of the gateway and
  never holds `SHUTTLE_SESSION_SECRET`: a backend that verifies an
  identity cannot mint one.
- The **bindings of the gateway** are the file of the version 2, and
  every route names the verification of its own signatures: the version,
  the algorithm, and the file of the key. The file of the version 1 is
  still read, as the legacy mode it is: a route that names the version
  `v4` verifies with the derived key of the gateway, and it never
  accepts a public key as its secret.
- The **baseline of the integration** is the manifest
  `compatibility.json`: it owns the repositories of the gateway and of
  the hub and the revisions that are tested against them. The revision
  of the gateway is now the one that signs with `ES256`, and the
  revision of the hub is the one that carries the access context
  contract and the release of the hub.

### Added

- The **check of the drift of the baseline**: it compares the block of
  the baseline of the specification with the manifest and refuses a
  workflow that holds a revision of its own.
- The **check of the packaged client**: it packs the client with the
  command of the release, installs the tarball in a consumer outside of
  the repository, imports the client through its public name and calls
  the API with it.

### Fixed

- The signature of the identity has to be **detached**: a signature that
  carries its payload is refused. It was read as the format of the
  gateway and it is not.

## 0.1.0 — the first release (2026-10-22)

The service is the headless data backend of the platform: the
workspaces, the registered collections, the data policies, the records,
the audit history and the committed events. The identity of the caller,
the tenants, the groups and the grants are the business of the hub.

**This is the first published release of the service.** The
`0.1.0-alpha.1` of the branch was never published: its corrections are
the `Fixed` section below, and the release of `0.1.0` carries them.

**The baseline of the integration of this release** was the gateway
`e39d73efc37e0ca75ae5df24136babf56430ebc7` and the hub
`4cedcfc48e9bb4eb556d2316eb502e1ab87d3105`. Those revisions are the
historical evidence of this release: the active baseline is the manifest
`compatibility.json`, and it is the one of the gateway that signs with
`ES256`.

**Version 0.1 is a pre-production release.** It is implemented, it
passes its own gates, and the compatibility harness runs it against the
real gateway and the real hub — but it has never run outside its own
harness. It has no production history, no external user, and no review
that was written by somebody other than the author of the code. The
suites of the tests say "checked" and not "proved" for the same
reason, and the review of the security of the service, with the findings
that are still open, is in [`docs/security.md`](security.md).

### Added

- The **catalog of a workspace**: the collections it registered and the
  bundle of policies that applies to it. The registration is logical: it
  never creates a table and never alters one. The commands are
  `bun run collection` and `bun run policy`.
- The **negation of a predicate** (`_not`), with the three valued
  logic of the database.
- The **aggregates** of a collection: `GET /ws/{workspaceId}/v1/aggregate/{collection}`.
  They read the rows that a list reads, with the same predicates and the
  same filter, and the number of their groups is bounded.
- The **search** of a collection: the `search` parameter of the list
  and of the aggregate. The fields of the search are the fields the
  deployment declares searchable, and the index of the search is a part
  of the reviewed migration of the collection.
- The **error codes** of the service are published in the OpenAPI
  document.
- The typed client answers the aggregates, and it is built.
- **[`docs/security.md`](security.md)**: the model of the security
  of the service, the review of it and the findings that are still open.
- The **predicates of the check are generated.** The file
  `test/integration/filter.property.test.ts` writes the rows and the
  predicates that were not written by hand, and it compares the two
  answers of every one of them.
- The command **`bun run scripts/scale.ts`**: it writes a collection of
  a million rows, it measures the plan of the statement of a page, and
  it walks every page of the collection and compares the rows with the
  rows of one statement.
- The **types of the collections of a deployment.** The command
  `bun run scripts/generate-client.ts` writes the types of the manifest
  of the deployment, and the client reads them as a type parameter:
  `new DataClient<Collections>({ … })`. The client without a map is the
  client of the contract of v1, and the names of the collections are
  not a part of the client package: they change with the manifest of
  the deployment.
- The **typed client is in the release.** It is packed as a tarball and
  published with the binaries of the tag: it is not published on a
  registry, it is downloaded from the release of the repository.

### Fixed

- **The second page of a collection answers the collection.** The cursor
  of a page was bound with a parameter that the statement did not
  reference, and the database refused the statement: every page after
  the first one answered `500`. The check of the contract suite never
  saw it, because the only test of the cursor mocked the answer of the
  service. The contract suite walks the pages of a collection now, in
  the three orders of the service.
- **A read costs the page and not the scope.** The projection of a row
  is built by the statement, and it was built for every row of the scope
  before the page was taken. The statement reads the page first
  and builds the projection of the rows of the page. The order of the
  service is written as the order of the database, `col asc nulls
  last`, which is the order of an index: the whole scope was read and
  sorted for every page. The plan of a page of fifty rows went from a
  sequential scan of the scope to an index scan of the page — 97 ms
  became 0.9 ms at two hundred thousand rows.
- **The two evaluations of a predicate agree on every predicate.** The
  reads compile a predicate into SQL and the writes evaluate the same
  predicate in memory. The evaluation in memory compared every value
  with one rule, so a text that looks like a number was compared as a
  number, and the characters were compared with the units of the UTF-16
  where the statement compares the bytes of the UTF-8. The comparison
  is now the comparison of the type of the field. A predicate of a json
  field that holds a list is bound as its text: it was bound as the
  literal of a list of the database, and the statement was refused.
- **The answer of the health probe carries the version of the service.**
  It carried the version of the manifest of the deployment, and the
  specification asks for the version of the service (§15.1). The probe
  answers the version of the service and the version of the manifest,
  and the description of the API carries the version of the service as
  well.
- **The comparison of the token of the metrics is in constant time.** The
  token was compared with `!==`, so the time of the answer depended on
  the length of the common prefix of the secret. The two values are
  hashed before they are compared, and the length of the secret never
  leaks.
- **The fuzzing of the trust boundary.** The parser of the filter and
  the verification of the signature are written with random values and
  with the signatures of the pinned gateway with one of their
  characters changed. The audit of the dependencies is a step of the
  continuous integration.

### Changed

- The suites of the tests say **checked** and not **proved**: a
  check of the author of the code is not an assurance. The version of
  the service is marked as a pre-production release.

### The contract of v1

The stable surface of the service is written down in
[`docs/api.md`](api.md): the paths, the envelopes, the
error codes, the grammar of the filter, the headers of a write, and the
rules of a change.
