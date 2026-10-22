# The changes of the service

The changes are listed from the newest to the oldest. The format
follows the keep a changelog: the version, the date, and the changes
grouped by what they change for a client.

A version that changes what a client depends on is a major version. The
rules of the change are in [`docs/contract.md`](docs/contract.md).

## 0.1.0 — the first release (2026-10-22)

The service is the headless data backend of the platform: the
workspaces, the registered collections, the data policies, the records,
the audit history and the committed events. The identity of the caller,
the tenants, the groups and the grants are the business of the hub.

**This is the first published release of the service.** The
`0.1.0-alpha.1` of the branch was never published: its corrections are
the `Fixed` section below, and the release of `0.1.0` carries them.

**Version 0.1 is a pre-production release.** It is implemented, it
passes its own gates, and the compatibility harness runs it against the
real gateway and the real hub — but it has never run outside its own
harness. It has no production history, no external user, and no review
that was written by somebody other than the author of the code. The
trace of the implementation says "checked" and not "proved" for the same
reason, and the review of the security of the service, with the findings
that are still open, is in [`docs/security.md`](docs/security.md).

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
- **[`docs/security.md`](docs/security.md)**: the model of the security
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

- The trace of the implementation says **checked** and not **proved**: a
  check of the author of the code is not an assurance. The version of
  the service is marked as a pre-production release.

### The contract of v1

The stable surface of the service is written down in
[`docs/contract.md`](docs/contract.md): the paths, the envelopes, the
error codes, the grammar of the filter, the headers of a write, and the
rules of a change.
