# The decisions of the implementation

The specification fixes the contract. This file records the choices the
implementation made inside that contract, and the reason of each one.

## 1. The domains own the statements, the adapters own the connections

The records domain builds the SQL it runs: the identifiers come from the
manifest and the values are bound parameters. The platform owns the
connections, the scopes and the transactions.

**Why.** The rules of a query — which fields a caller may see, which
rows a policy covers, how a page is built — are the rules of the domain.
A query engine that receives a statement from the outside would have to
trust it, and the trust is exactly what the specification forbids. The
cost is that the domain knows SQL; the price of the other arrangement is
a rule that lives in two places.

## 2. The projection of a read is built in the database

The payload of a row is assembled by the statement: a field is added
only when a policy that matched the row grants it. The value of a field
the caller may not see never leaves the database.

**Why.** The specification asks for a projection that does not
materialize the unauthorized values in the code that builds the answer.
Building the payload in the statement is the only way to keep that
promise without a second round trip per row. The cost is a statement
that is longer than the one a reader would write by hand.

**The projection is built for the rows of the page, and not for the rows
of the scope.** The statement reads the page first — the identifiers,
the order and the limit — and the second part builds the payload of the
rows of that page.

**Why.** The projection reads every field of a row and builds a json
value for each of them. A statement that projected every row of the
scope and then kept the page paid the projection of the whole
collection for every page: 97 milliseconds for a page of fifty rows at
two hundred thousand rows, against 0.9 milliseconds when the projection
is built for the page only. The two parts are the same promise — the
value the caller may not see never leaves the database — and the second
one is the only one that is affordable.

**The write path builds the same projection.** The statement that locks
the row of a write computes the flags of the read policies — the
predicates of the policies, compiled by the same compiler — and the
representation of the record is built from those flags. The validator
of a record is therefore the same whether the record was read or
written, and it is the database that says which policies match the row.

**Why.** The representation was built in memory, over the values that
the lock had read, and the predicates were evaluated there a second
time. The two evaluations of the same rule were one rule in two
places, and the validator of a record was the validator of two
different implementations.

## 3. The order of a page is the order of the database

The order of the service is the order of the nulls last, in the two
directions. The statement writes it as `col asc nulls last`, and the
position of the cursor keeps the rank of the nulls with the value of the
column.

**Why.** `((col is null))::int asc, col asc` is the same order, and the
database does not recognise it as the order of an index: it read the
whole scope and sorted it for every page. `col asc nulls last` is the
order of an index, and the page is read with the index of the scope of
the workspace. The rank of the nulls stays in the position of the
cursor, because the continuation of a page has to compare the nulls of
a column with the nulls of the position.

**The cost.** A descending sort needs an index that the deployment
declares `desc nulls last`: the default index of a column is `asc nulls
first` for the descending direction, and the order of the service is the
order of the nulls last. The indexes belong to the reviewed migration of
the collection.

## 4. The page position is a tuple, not an offset

The cursor holds the values of the columns of the sort and the rank of
their null values, and the continuation of a page is the explicit
expansion of the tuple comparison.

**Why.** An offset grows with the table and it is not stable when a row
is inserted. The tuple is stable and it is bounded. The rank of the null
values is part of the tuple because PostgreSQL sorts the nulls last in
the two directions and the continuation has to agree with the order.

## 5. The write is authorized by one policy, and the database evaluates its predicates

The predicate of a policy is compiled to SQL for the reads and for the
writes. The write path holds the row, and the statement of the write
carries the predicates of the policies: the `where` over the row before
the change and the `check` over the row after it. The row after the
change is given to the database as a common table expression of bound
parameters. The evaluation in memory stays as the oracle of the check.

**Why.** A write has to check the row before the change and the row
after it, and the row after it does not exist yet. The two evaluations
of the same rule lived in two places, and they diverged three times
before the comparison was made the comparison of the type of the field.
One implementation is the fix: the database evaluates the rule, with
the compiler that the reads use, and the memory is the fast path that
refuses a write before it touches the database. The generated check of
the guard compares the two answers on predicates that were not written
by hand, so a divergence is a failure of the continuous integration and
not a surprise of a deployment.

**The cost.** The statement of a write carries two images of the row:
the row before the change and the row after it. The database does not
resolve a common table expression in the condition of an update, so the
condition is a subquery over the expressions. The write reads the row
once more, and the row it reads is the row it locked.

## 6. The idempotency key is claimed with a statement that waits

The claim of a key uses `insert … on conflict do update … where false`.
It waits for the transaction that holds the key, and it is bounded by a
lock timeout of two seconds.

**Why.** `on conflict do nothing` does not always wait for the
transaction that holds the conflicting row, and a duplicate that is
answered before the first one committed would create two records. The
statement that waits costs a privilege of update on the receipts, and
that privilege is limited to the rows of the scope of the transaction.

## 7. The context of Hub is never cached by the service, by default

`DATA_CONTEXT_CACHE_TTL_MS` is zero. A read may be cached when the
operator asks for it, and the entry leaves the cache at the earlier of
the validity Hub announced and the local lifetime.

**Why.** The specification allows a cache of zero to five thousand
milliseconds and asks for the default of no cache. The revocation of a
grant is visible in the next request, and the bound of a revocation is
the lifetime of the cache plus the duration of the request that is
running.

## 8. The scope of a transaction is set with `set_config(…, true)`

The settings `data.tenant_id`, `data.workspace_id` and
`data.principal_id` are local to the transaction.

**Why.** A pooled connection never carries the scope of another
request, and the policies of the tables deny the rows when the settings
are missing. The setting is a scope and not a credential: it is never
read by a caller and it is never sent over the wire.

## 9. The identity of the gateway is verified with a public key

The backend holds the **public** key of the identity signature of the
gateway, never `SHUTTLE_SESSION_SECRET` and never the private key of
the gateway. The legacy format, which derives the key of the signature
from the secret of the sessions, is still read: it is the migration path
of a deployment that shares a key with its gateway, and a route has to
name it explicitly.

**Why.** The derivation separates the two secrets, and it was enough
when the trust boundary of the gateway was its network: the upstream
that could verify an identity could mint one, and the key of the
signature was a signing capable secret that belonged inside the trust
boundary of the gateway. The public key moves the boundary to the key:
an upstream that verifies an identity cannot mint one, the backend never
holds a secret of the gateway, and the compromise of the backend does
not give the sessions of the gateway. The legacy format stays readable
because a deployment that changes the format of its bindings and the key
of its gateway at the same time is a deployment that is down; the route
names the format, so the two never mix.

## 10. The baseline of the integration is one file, and it is checked

The repositories of the gateway and of Hub, and the revisions that are
tested against them, live in `compatibility.json`, and the
documentation of the baseline and the workflows read it.

**Why.** A pin that is written twice is a pin that drifts, and a
harness that runs against another revision than the one of the
specification proves nothing. The check of the drift compares the block
of the baseline of the specification with the manifest, and refuses a
workflow that holds a revision of its own. The revisions of the earlier
baseline stay in the release notes: they are the historical evidence of
the release `v0.1.0` and they are not the active baseline.

## 11. The workspace is read before the context exists

The registry is read with a narrow reader: the role may select three
columns of one table and it may only look a workspace up by its exact
identifier.

**Why.** The scope of a request is the workspace, and the workspace
belongs to a tenant: the tenant of the workspace is needed before the
context of the principal exists. The reader is the narrowest exception
of the specification, and it has no access to any business table.

## 12. The events and the audit are written by the domain, in the transaction of the mutation

The records service writes the audit entry, the event and the receipt
through the unit of work of the mutation.

**Why.** The specification requires the four effects to be committed
together or not at all. The only place that can guarantee it is the
transaction of the mutation itself, and the only way to prove it is to
inject a failure at every stage of the transaction.

## 13. The subscriber is registered in the composition root

The subscribers of the deployment are code, with a stable identifier and
a filter of the events they handle. The worker resolves a fresh context
of the service principal before every command.

**Why.** The specification asks for trusted subscribers and refuses the
uploaded plugins and the caller defined handlers. The authority of a
subscriber is the authority of the service principal, and the identity
of the caller that started the chain is an attribution.

## 14. The number of the rows of a page is bounded by the answer and not by the page

The budget of four mebibytes is checked while the rows are encoded, and
the expansion of the relations is bounded before the rows are
materialized.

**Why.** A limit that is checked after the page was built is not a
limit. The expansion uses one statement per relation and per batch of
the parents, never one statement per parent.

## 15. The extension of Hub lives in Hub and not in a copy here

The extension of the access context contract is a change of Hub, and it
was taken upstream: Hub carries it since `4cedcfc`, the depot pins a
revision of Hub that carries it in `compatibility.json`, and the depot
holds no copy of the change.

**Why.** The gateway and Hub are the contracts of the platform, and a
change of them is a change of the platform. A patch that is reviewed
against a pinned revision is reviewable; a fork is not. Once the change
is in the repository of Hub, a copy of it here would be a second source
of truth that can only rot: the depot proves the contract with the
compatibility harness, against the real Hub, at the pinned revision.

## 16. The tests run against a real PostgreSQL server

The integration tests and the compatibility harness start a PostgreSQL
server of their own.

**Why.** The isolation, the locking and the claims of the workers are
the behaviour of a server. An embedded engine proves the rules of the
domain and nothing else, and the specification asks for the server level
checks.

## 17. The null of a comparison follows the database

The predicate of a policy is compiled to SQL for the reads and it is
evaluated in memory for the writes. The two evaluations use the three
valued logic of the database: a comparison with a null value is unknown
and it never matches, and only `_is_null` matches a null value.

**Why.** The two evaluations answer the same question about the same
row, and they have to answer it the same way. A policy that reads the
records whose body differs from a value does not cover a record whose
body is null, exactly as the statement of the read does not match it.
The evaluation in memory that treated the null as a value would let a
caller write a record that the read hides, and the two rules of the
service would contradict each other inside the same request.

The comparison of the text is the comparison of the bytes, and not the
comparison of the locale of the database: the compiler writes the
collation `C` on the columns of the text, and the evaluation in memory
compares the code units. A deployment whose database carries a collation
of the locale would otherwise answer differently from the evaluation in
memory — `'Zebra' < 'apple'` is true for the bytes and false for the
collation of the unicode.

The two normalizations of the database are part of the parser, and not
of the two evaluations: the uuid is written in lower case, and the json
does not keep the order of its keys. The parser normalizes the operand
of a uuid, and the comparison of a json compares the content and not the
order, so the two evaluations compare the same values.

The two evaluations are compared by a differential test: the same
predicates run against the same rows, in memory and in the server, and
the two answers have to be the same. The fixture of the test carries a
column with the collation of the unicode, so the test proves that the
compiler does not depend on the collation of the deployment. The test is
the proof that a change of one of the two engines does not change the
meaning of a policy.

## 18. The metrics of the dependency and of the cache are recorded by the component that owns them

The client of Hub records the calls it makes and their duration, the
resolver records the hits and the misses of the cache of the context,
the pool records the waits for a connection, and the store records the
rolled back transactions.

**Why.** A metric that the component that knows the event does not
record is a metric that drifts from the truth. The specification asks
for the duration of Hub, for the hits of the cache and for the
rollbacks, and the component that holds the event is the only one that
can count it without a guess.

## 19. The catalog of a workspace is a logical registry over the tables of the deployment

A workspace registers the collections of the deployment that it serves,
and it publishes the bundle of policies that applies to it. The
registration never creates a table and never names one that the
deployment does not declare.

**Why.** The physical schema is the strongest property of the service:
the tables come from reviewed migrations, their isolation is written in
those migrations, the role of the api may not alter them, and the
readiness compares the manifest with the deployed schema and refuses the
drift. A registry that created a table per tenant would give all of
that away: the policies of the isolation would have to be written at
runtime, on tables that no migration describes, and the drift of the
schema would have nothing to compare against. The registry keeps the
physical schema global and reviewed, and it makes the *logical* schema
per workspace, which is what a customer of the platform actually asks
for.

The cost is that a workspace cannot have a field that another workspace
does not have. The tables of the deployment are the vocabulary of the
platform, and a deployment that needs another vocabulary adds a
migration: the review of the change stays where it belongs.

A workspace that registered nothing serves every collection of the
deployment. The default of a deployment that has not used the registry
yet is the deployment itself, and a deployment that starts to use it
does not change the behaviour of the workspaces that did not.

## 20. The publication of a bundle is an operator command and not an HTTP route

A bundle of policies is published with a command of the operator, on the
machine of the deployment. There is no endpoint that writes a bundle.

**Why.** A bundle says what a permission grants. An endpoint that
publishes a bundle is an authority that does not go through Hub, and it
would have to be guarded by a permission of its own: a tenant that can
publish a bundle can grant itself the read of every field of every
collection, and the isolation of the workspaces would hold only as long
as that endpoint is closed. The command runs with the credentials of the
owner of the schema, it is on the machine of the operator, and it leaves
a history of the publications that the audit log of the records points
at. The grants of a principal stay the business of Hub, and the two
authorities do not mix.

The cost is that a tenant cannot change its own policies through the
api. A studio that edits the policies of a workspace will need an
endpoint, and that endpoint will need an authority of its own, defined
in Hub and not in the deployment.

## 21. The negation of a predicate keeps the three valued logic of the database

The operator `_not` negates a whole predicate, and the negation of an
unknown is an unknown: a row whose value is null is never matched by a
negated comparison. The evaluation in memory carries the third value
explicitly, and the statement of the database carries it natively.

**Why.** The two evaluations of a predicate have to answer the same
question about the same row: the reads compile the predicate into SQL
and the writes evaluate it in memory over the row that is locked. The
negation is the first operator that forces the unknown to be a value of
its own: `not (a = 1 and b = 2)` is unknown when `b` is null, and a
negation that treated the unknown as a false would let a caller write a
record that the read hides. The differential test carries the cases of
the negation, and it runs them against a real server: the two answers
have to be the same, row by row.

## 22. The catalog is read with the registry of the workspaces, and it is carried by the context

The narrow reader of the registry reads the workspace **and** the
registry of its catalog in one statement, and the application puts the
resolved catalog in the context that the domain operations receive. The
records service reads the manifest and the bundle of the context, and it
never resolves them itself.

**Why.** The registry of the workspaces is on the path of every
request: the service needs the tenant of the workspace before it asks
Hub. The catalog is the configuration of the workspace, and it is read
with it: a second round trip for the catalog would double the work of
the registry pool, which is the smallest pool of the deployment, and
the measurement showed a third of the throughput of the read path. The
statement that reads both costs a tenth of a millisecond more than the
statement that read the workspace alone.

The catalog is carried by the context because it is the same for every
operation of a request: a bundle that was published in the middle of a
request does not change the answer of that request, and the cursors,
the audit entries and the statements of the request all name the same
versions. A service that resolved the catalog itself would have to
answer the question "which bundle applies" in a second place.

The resolved catalog is memoized in the process, and the fingerprint of
its inputs is the key: the collections that the workspace registered and
the digest of the bundle it published. The memoization removes the
parsing of the bundle from the path of the request, and it does not
weaken the guarantee: a bundle that was edited in the database has
another digest, and it is parsed again and refused when it cannot be
used.

## 23. The search is a parameter of the query and not an operator of the filter

The search of a collection is the `search` parameter of the list and of
the aggregate. It is not an operator of the filter grammar.

**Why.** The predicates of the policies are evaluated twice: they are
compiled to SQL for the reads and they are evaluated in memory for the
writes, over the row that is locked. The two evaluations have to answer
the same question about the same row, and the differential test proves
that they do. A text search has no meaning in the second evaluation:
the ranking and the stemming of the database have no equivalent in the
memory of the process, and a policy that read a text search would
authorize a write with a rule that the reads do not apply. The search
is therefore a parameter of the queries of the callers, and it never
reaches a predicate of a policy.

The fields of the search are the fields that the deployment declares
searchable, and they have to be the fields the caller may filter and
sort by: a search over a field that a policy hides would disclose what
the policy protects, exactly as a sort over that field would.

The index of the search is a part of the reviewed migration of the
collection, and its expression is the expression of the statement of the
search. The database only uses the index when the two are the same, and
a difference is a silent regression: the search answers the same rows
and it costs a scan of the table. The test of the integration reads the
plan of the database and it fails when the index is not used.

## 24. The aggregate reads the rows that a list reads, and it uses the fields that the caller may filter by

The aggregate is a statement of a list with a `group by`: the same
scope, the same disjunction of the read predicates of the policies and
the same filter of the caller. The fields of the group and the fields
of the metrics are the fields the caller may filter and sort by.

**Why.** An aggregate that reads the rows of another query is a
privileged query path, and the specification refuses them. The
intersection of the read policies is the conservative answer, and it is
the answer the filter and the sort already give: a caller that may not
filter by a field may not learn the distribution of that field either.

The sum and the average of an integer are decimals, exactly as the
database answers them: the sum of a big integer does not fit in a big
integer, and a number that does not fit would be a lie. The number of
the groups is bounded, and the answer says when the groups of the
answer are not all of them: a truncated answer that does not say it is
truncated is a lie too.

## 25. The failures of the database are translated into the codes of the contract

The driver of PostgreSQL answers with the SQLSTATE of the server. The
service translates it into the code of the contract in one table, in
the platform layer, and the domain never sees the state of the server.

**Why.** The contract publishes the codes, and a client switches on the
code. A lock that was not granted in time is a `409 CONFLICT` and not
an internal error of the service, and a statement that ran out of its
budget is a `504 DEADLINE_EXCEEDED`. The translation is deliberately
conservative: a state that is not in the table is not translated, and a
defect of the service — a statement that does not parse, a column that
does not exist — stays an internal error. A translation that hides a
defect behind a plausible answer is worse than an answer that is
obviously wrong.

**The cost.** The reason of the failure is the cause of the error and
not its message: the answer of the service is the safe summary of the
code, and the reason belongs to the log. The log of a failure of the
database carries the state of the server, and the answer of the service
does not.

## 26. A statement that fails does not break a connection

A statement that fails — a constraint that is violated, a lock that is
not granted — leaves the connection usable: the transaction is rolled
back and the session is clean. A failure of the connection itself does
not: the state of the session is unknown, and the connection must not
go back to the pool.

**Why.** The two failures were not told apart, and a failing statement
took the connection with it: the connection was neither returned to the
pool nor destroyed, and it was lost. Twenty failing writes exhausted
the pool of the api, and every request of the deployment answered
`503` afterwards. The pool of the api is the resource that the
isolation of the tenants relies on, and a client that may spend it
with twenty bad requests may spend it with twenty thousand.

**The cost.** A connection that is broken is destroyed, and the pool
opens a new one: a failure of the network costs a connection of the
pool and not a request.

## 27. The size of an answer is measured by the database, and the budget is spent as the answer is built

The four mebibytes of the contract are a bound of the resources of the
service and not only of the bytes that leave it. The size of every
piece of the payload of a row is measured by the statement that built
the row, the budget is spent as the answer is built, and the answer is
refused as soon as the budget is spent.

**Why.** The budget was checked once the answer was built, so it
bounded the bytes that leave the service and not the memory that it
holds: the answer of four megabytes could cost two hundred megabytes
of memory before it was refused. The measurement is in the database
because the data is there: the process does not serialize a row to
know how big it is, and the measurement costs the hot path nothing.

**The expansion of a relation is read in chunks.** The chunk aims at a
mebibyte and its size follows the size of the rows: a collection of
small rows is read in big chunks, and a collection of large rows is
read in small ones. The relation of a page is read with one statement
and not with one statement per root row: the expansion was a query per
row of the page, and the bound of the rows was a thousand per root
record.

**The cost.** The measure counts the pieces that the policies do not
grant for a row: the budget is an upper bound of the size of the
answer, and never a lower one. An answer that is just under the bound
may be refused a little early.

## 28. The cache of the context is bounded

The cache of the context is bounded, the entries that are spent leave
it, and the entry that is the least recently used leaves it when it is
full.

**Why.** The cache is the mitigation of the availability of Hub: it is
the answer of a deployment that prefers the availability over the
instant revocation. It was a map without a bound and without a sweep,
and an entry left it only when the same key was asked again. A
mitigation that grows without a bound is a leak, and the leak appears
exactly when the mitigation is used.

## 29. The bound of a tenant is applied after the tenant is known

The bound of the listener is the bound of the machine, and it answers a
`503 OVERLOADED`. The bound of a tenant is applied once the tenant of
the request is known — after the signature of the gateway and the
registry of the workspaces — and it answers a `429 TOO_MANY_REQUESTS`
with a `Retry-After`.

**Why.** The two bounds answer two different questions. The first one
says that the service is full; the second one says that the caller is
sending too much. A tenant that takes the room of the others receives
an answer that tells it that the service is broken, and it does not
know that it is the one that is talking too much.

**The cost.** The room of a tenant is the room of the process until the
deployment declares another one. A deployment with one tenant does not
need to declare it, and a deployment with several declares the room
that each of them holds. A bound may not be disabled: the
specification refuses a bound that a zero turns off.

## 30. The suites are broken on purpose, and they have to notice

The gate of the mutation takes the code, breaks it on purpose, and
checks that the suites notice. A mutation that survives is a behaviour
that nothing in the repository proves.

**Why.** Every check of this repository was written by the author of
the code, and a check that agrees with the code because it shares its
assumptions proves nothing. The gate is the part of the answer that a
machine can give: it does not replace the review of somebody else, and
it found five behaviours that nothing proved — the type of the
protected header of the signature, the critical header, the fields of a
row, the bound of a collection, and the connection of the pool.

**The cost.** The gate is slow: it runs a suite per mutation. It only
covers the mutations that were thought of, and a mutation that is
equivalent — a defect that another defect already covers — survives
without meaning anything.

## 31. The history of the versions is a typed mirror, and the image is written by the statement of the change

A collection that keeps a history declares the table of its versions in
the manifest, and the table is a mirror of the table of the collection:
the same columns, the same names and the same types, plus the columns
of the history. The image of a version is written by the statement of
the change itself — the change is a common table expression and the
image is the insert that reads it — and the rollback is an ordinary
update, or an ordinary creation for a record that was deleted.

**Why.** The authorization of a version is the authorization of a
record: the database evaluates the predicates of the read policies over
the image, and the fields that the policies hide are not in the
answer. A history held as a json document would have to be evaluated in
memory, and the evaluation in memory of a predicate is the thing that
decision 5 removed from the write path. The image is written by the
statement of the change because a history that is written by another
statement is a history that may disagree with the record: a change that
commits without its image, or an image of a change that was refused,
is a history that lies.

**The cost.** The table of the versions holds the values of the
business, and it is the first surface of the service that does. It is
declared by the deployment, it is created by a reviewed migration, it
is bounded by the retention, and it is read with the policies of the
deployment. The rollback is not a privileged command: a version that
the policies forbid to write is refused, and the version of the record
never moves back.

**The alternative that was refused.** A trigger of the database would
have written the image without touching the service, and it would have
caught the writes of the scripts and of the workers. The trigger writes
the image of every row of the table, and the service would not know
which rows it wrote: the history of a deployment would then depend on
the paths that reach the database. The service writes what it changes,
and it knows what it changed.

## 32. The development machine and the continuous integration use PostgreSQL 18, and a deployment may run 15 or later

The development machine, the integration tests, the compatibility
harness and the continuous integration run PostgreSQL 18. The service
itself does not require a major: a deployment may run PostgreSQL 15 or
later, and the scripts of the deployment check the version of their
client against the version of their server.

**Why.** The suites prove the semantics of a version, and a suite that
runs against another major proves another version. The major that the
suites run against is the newest one that a deployment may meet, and
the tests that prove the semantics of the version are the ones that
catch a difference between the versions before a deployment meets it.

**The cost.** The machine of a developer needs the binaries of the
version 18, and the continuous integration installs them: the runner
does not have them, and the image of the database of the stack of the
development machine is the one of the version 18 as well. The script
that starts the server of the tests warns when the machine has another
major, and it refuses a data directory of another major: a server of
the version 18 does not start on the files of the version 15, and the
refusal of the server is not the message that a developer needs.

**The alternative that was refused.** The requirement of the version 18
in the contract of the service was refused: the managed PostgreSQL of
the operators lags the newest major by months, and a requirement of
the version 18 in the contract of the version `1.0.0` would close the
door of the deployments that use a managed database. The requirement
belongs to the machine of the developers and not to the contract of the
deployments.
