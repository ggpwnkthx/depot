# The changes of the service

The changes are listed from the newest to the oldest. The format
follows the keep a changelog: the version, the date, and the changes
grouped by what they change for a client.

A version that changes what a client depends on is a major version. The
rules of the change are in [`docs/contract.md`](docs/contract.md).

## 0.1.0-alpha.1 — the corrections of the first release

The first release was published as `0.1.0` and it is marked as a
pre-production release: it has never run outside its own harness. The
changes below are the corrections that the review of the first release
found, and they do not change the contract of v1.

### Fixed

- **The two evaluations of a predicate agree on every predicate.** The
  reads compile a predicate into SQL and the writes evaluate the same
  predicate in memory. The evaluation in memory compared every value
  with one rule, so a text that looks like a number was compared as a
  number, and the characters were compared with the units of the UTF-16
  where the statement compares the bytes of the UTF-8. The comparison
  is now the comparison of the type of the field. A predicate of a json
  field that holds a list is bound as its text: it was bound as the
  literal of a list of the database, and the statement was refused.
- **The fuzzing of the trust boundary.** The parser of the filter and
  the verification of the signature are written with random values and
  with the signatures of the pinned gateway with one of their
  characters changed. The audit of the dependencies is a step of the
  continuous integration.

### Added

- **[`docs/security.md`](docs/security.md)**: the model of the security
  of the service, the review of it and the findings that are still open.
- **The predicates of the check are generated.** The file
  `test/integration/filter.property.test.ts` writes the rows and the
  predicates that were not written by hand, and it compares the two
  answers of every one of them.

### Changed

- The trace of the implementation says **checked** and not **proved**: a
  check of the author of the code is not an assurance. The version of
  the service is marked as a pre-production release.

## 0.1.0 — the first release

The service is the headless data backend of the platform: the
workspaces, the registered collections, the data policies, the records,
the audit history and the committed events. The identity of the caller,
the tenants, the groups and the grants are the business of the hub.

### Added

- The **catalog of a workspace**: the collections it registered and the
  bundle of policies that applies to it. The registration is logical:
  it never creates a table and never alters one. The commands are
  `bun run collection` and `bun run policy`.
- The **negation of a predicate** (`_not`), with the three valued
  logic of the database.
- The **aggregates** of a collection: `GET /ws/{workspaceId}/v1/aggregate/{collection}`.
  They read the rows that a list reads, with the same predicates and
  the same filter, and the number of their groups is bounded.
- The **search** of a collection: the `search` parameter of the list
  and of the aggregate. The fields of the search are the fields the
  deployment declares searchable, and the index of the search is a part
  of the reviewed migration of the collection.
- The **error codes** of the service are published in the OpenAPI
  document.
- The typed client answers the aggregates, and it is built.

### The contract of v1

The stable surface of the service is written down in
[`docs/contract.md`](docs/contract.md): the paths, the envelopes, the
error codes, the grammar of the filter, the headers of a write, and the
rules of a change.
