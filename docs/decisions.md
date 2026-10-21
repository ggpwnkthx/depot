# The decisions of the implementation

The specification fixes the contract. This file records the choices the
implementation made inside that contract, and the reason of every one of
them.

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

**The projection is built for the rows of the page, and not for the
rows of the scope.** The statement reads the page first — the
identifiers, the order and the limit — and the second part builds the
payload of the rows of that page.

**Why.** The projection reads every field of a row and builds a json
value for each of them. A statement that projected every row of the
scope and then kept the page paid the projection of the whole
collection for every page: 97 milliseconds for a page of fifty rows at
two hundred thousand rows, against 0.9 milliseconds when the projection
is built for the page only. The two parts are the same promise — the
value the caller may not see never leaves the database — and the second
one is the only one that is affordable.

## 3. The order of a page is the order of the database

The order of the service is the order of the nulls last, in the two
directions. The statement writes it as `col asc nulls last`, and the
position of the cursor keeps the rank of the nulls with the value of
the column.

**Why.** `((col is null))::int asc, col asc` is the same order, and the
database does not recognise it as the order of an index: it read the
whole scope and sorted it for every page. `col asc nulls last` is the
order of an index, and the page is read with the index of the scope of
the workspace. The rank of the nulls stays in the position of the
cursor, because the continuation of a page has to compare the nulls of
a column with the nulls of the position.

**The cost.** A descending sort needs an index that the deployment
declares `desc nulls last`: the default index of a column is `asc
nulls first` for the descending direction, and the order of the service
is the order of the nulls last. The indexes belong to the reviewed
migration of the collection.

## 4. The page position is a tuple, not an offset

The cursor holds the values of the columns of the sort and the rank of
their null values, and the continuation of a page is the explicit
expansion of the tuple comparison.

**Why.** An offset grows with the table and it is not stable when a row
is inserted. The tuple is stable and it is bounded. The rank of the null
values is part of the tuple because PostgreSQL sorts the nulls last in
the two directions and the continuation has to agree with the order.

## 5. The write is authorized by one policy, and the check is evaluated in memory

The predicate of a policy is compiled to SQL for the reads and it is
evaluated in memory for the writes. The write path holds the row, so it
knows the values, and the two evaluations use the same rules.

**Why.** A write has to check the row before the change and the row
after it, and the row after it does not exist yet. Compiling the
predicate of the resulting row into a statement would mean a second
statement with the same conditions in two places. The domain evaluates
the same filter node with the same operators, so the two answers agree.

## 6. The idempotency key is claimed with a statement that waits

The claim of a key uses `insert … on conflict do update … where false`.
It waits for the transaction that holds the key, and it is bounded by a
lock timeout of two seconds.

**Why.** `on conflict do nothing` does not always wait for the
transaction that holds the conflicting row, and a duplicate that is
answered before the first one committed would create two records. The
statement that waits costs a privilege of update on the receipts, and
that privilege is limited to the rows of the scope of the transaction.

## 7. The context of the hub is never cached by the service, by default

`DATA_CONTEXT_CACHE_TTL_MS` is zero. A read may be cached when the
operator asks for it, and the entry leaves the cache at the earlier of
the validity the hub announced and the local lifetime.

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

## 9. The identity of the gateway is derived, and it is not the secret of the session

The backend holds the derived key of the identity signature, never
`SHUTTLE_SESSION_SECRET`.

**Why.** The derivation separates the two secrets: a backend that
compromises the key of the signature does not compromise the sessions
of the gateway, and the key of the signature may be rotated with the
gateway and not with the sessions. The key is a signing capable secret
and it belongs inside the trust boundary of the gateway.

## 10. The workspace is read before the context exists

The registry is read with a narrow reader: the role may select three
columns of one table and it may only look a workspace up by its exact
identifier.

**Why.** The scope of a request is the workspace, and the workspace
belongs to a tenant: the tenant of the workspace is needed before the
context of the principal exists. The reader is the narrowest exception
of the specification and it has no access to any business table.

## 11. The events and the audit are written by the domain, in the transaction of the mutation

The records service writes the audit entry, the event and the receipt
through the unit of work of the mutation.

**Why.** The specification requires the four effects to be committed
together or not at all. The only place that can guarantee it is the
transaction of the mutation itself, and the only way to prove it is to
inject a failure at every stage of the transaction.

## 12. The subscriber is registered in the composition root

The subscribers of the deployment are code, with a stable identifier and
a filter of the events they handle. The worker resolves a fresh context
of the service principal before every command.

**Why.** The specification asks for trusted subscribers and refuses the
uploaded plugins and the caller defined handlers. The authority of a
subscriber is the authority of the service principal, and the identity
of the caller that started the chain is an attribution.

## 13. The number of the rows of a page is bounded by the answer and not by the page

The budget of four mebibytes is checked while the rows are encoded, and
the expansion of the relations is bounded before the rows are
materialized.

**Why.** A limit that is checked after the page was built is not a
limit. The expansion uses one statement per relation and per batch of
the parents, never one statement per parent.

## 14. The extension of the hub lives in the hub and not in a copy here

The extension of the access context contract is a change of the hub, and
it was taken upstream: the hub carries it since `4cedcfc`, the depot
pins that revision, and the depot holds no copy of the change.

**Why.** The gateway and the hub are the contracts of the platform, and
a change of them is a change of the platform. A patch that is reviewed
against a pinned revision is reviewable; a fork is not. Once the change
is in the repository of the hub, a copy of it here would be a second
source of truth that can only rot: the depot proves the contract with
the compatibility harness, against the real hub, at the pinned revision.

## 15. The tests run against a real PostgreSQL server

The integration tests and the compatibility harness start a PostgreSQL
server of their own.

**Why.** The isolation, the locking and the claims of the workers are
the behaviour of a server. An embedded engine proves the rules of the
domain and nothing else, and the specification asks for the server level
checks.

## 16. The null of a comparison follows the database

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
of a uuid and the comparison of a json compares the content and not the
order, so the two evaluations compare the same values.

The two evaluations are compared by a differential test: the same
predicates run against the same rows, in memory and in the server, and
the two answers have to be the same. The fixture of the test carries a
column with the collation of the unicode, so the test proves that the
compiler does not depend on the collation of the deployment. The test is
the proof that a change of one of the two engines does not change the
meaning of a policy.

## 17. The metrics of the dependency and of the cache are recorded by the component that owns them

The client of the hub records the calls it makes and their duration, the
resolver records the hits and the misses of the cache of the context, the
pool records the waits for a connection and the store records the rolled
back transactions.

**Why.** A metric that the component that knows the event does not
record is a metric that drifts from the truth. The specification asks
for the duration of the hub, for the hits of the cache and for the
rollbacks, and the component that holds the event is the only one that
can count it without a guess.

## 18. The catalog of a workspace is a logical registry over the tables of the deployment

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

## 19. The publication of a bundle is an operator command and not an HTTP route

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
in the hub and not in the deployment.

## 20. The negation of a predicate keeps the three valued logic of the database

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

## 21. The catalog is read with the registry of the workspaces, and it is carried by the context

The narrow reader of the registry reads the workspace **and** the
registry of its catalog in one statement, and the application puts the
resolved catalog in the context that the domain operations receive. The
records service reads the manifest and the bundle of the context, and
it never resolves them itself.

**Why.** The registry of the workspaces is on the path of every
request: the service needs the tenant of the workspace before it asks
the hub. The catalog is the configuration of the workspace, and it is
read with it: a second round trip for the catalog would double the
work of the registry pool, which is the smallest pool of the
deployment, and the measurement showed a third of the throughput of the
read path. The statement that reads both costs a tenth of a
millisecond more than the statement that read the workspace alone.

The catalog is carried by the context because it is the same for every
operation of a request: a bundle that was published in the middle of a
request does not change the answer of that request, and the cursors,
the audit entries and the statements of the request all name the same
versions. A service that resolved the catalog itself would have to
answer the question "which bundle applies" in a second place.

The resolved catalog is memoized in the process, and the fingerprint of
its inputs is the key: the collections that the workspace registered
and the digest of the bundle it published. The memoization removes the
parsing of the bundle from the path of the request, and it does not
weaken the guarantee: a bundle that was edited in the database has
another digest, and it is parsed again and refused when it cannot be
used.

## 22. The search is a parameter of the query and not an operator of the filter

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

## 23. The aggregate reads the rows that a list reads, and it uses the fields that the caller may filter by

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
