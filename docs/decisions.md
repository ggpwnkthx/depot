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

## 3. The page position is a tuple, not an offset

The cursor holds the values of the columns of the sort and the rank of
their null values, and the continuation of a page is the explicit
expansion of the tuple comparison.

**Why.** An offset grows with the table and it is not stable when a row
is inserted. The tuple is stable and it is bounded. The rank of the null
values is part of the tuple because PostgreSQL sorts the nulls last in
the two directions and the continuation has to agree with the order.

## 4. The write is authorized by one policy, and the check is evaluated in memory

The predicate of a policy is compiled to SQL for the reads and it is
evaluated in memory for the writes. The write path holds the row, so it
knows the values, and the two evaluations use the same rules.

**Why.** A write has to check the row before the change and the row
after it, and the row after it does not exist yet. Compiling the
predicate of the resulting row into a statement would mean a second
statement with the same conditions in two places. The domain evaluates
the same filter node with the same operators, so the two answers agree.

## 5. The idempotency key is claimed with a statement that waits

The claim of a key uses `insert … on conflict do update … where false`.
It waits for the transaction that holds the key, and it is bounded by a
lock timeout of two seconds.

**Why.** `on conflict do nothing` does not always wait for the
transaction that holds the conflicting row, and a duplicate that is
answered before the first one committed would create two records. The
statement that waits costs a privilege of update on the receipts, and
that privilege is limited to the rows of the scope of the transaction.

## 6. The context of the hub is never cached by the service, by default

`DATA_CONTEXT_CACHE_TTL_MS` is zero. A read may be cached when the
operator asks for it, and the entry leaves the cache at the earlier of
the validity the hub announced and the local lifetime.

**Why.** The specification allows a cache of zero to five thousand
milliseconds and asks for the default of no cache. The revocation of a
grant is visible in the next request, and the bound of a revocation is
the lifetime of the cache plus the duration of the request that is
running.

## 7. The scope of a transaction is set with `set_config(…, true)`

The settings `data.tenant_id`, `data.workspace_id` and
`data.principal_id` are local to the transaction.

**Why.** A pooled connection never carries the scope of another
request, and the policies of the tables deny the rows when the settings
are missing. The setting is a scope and not a credential: it is never
read by a caller and it is never sent over the wire.

## 8. The identity of the gateway is derived, and it is not the secret of the session

The backend holds the derived key of the identity signature, never
`SHUTTLE_SESSION_SECRET`.

**Why.** The derivation separates the two secrets: a backend that
compromises the key of the signature does not compromise the sessions
of the gateway, and the key of the signature may be rotated with the
gateway and not with the sessions. The key is a signing capable secret
and it belongs inside the trust boundary of the gateway.

## 9. The workspace is read before the context exists

The registry is read with a narrow reader: the role may select three
columns of one table and it may only look a workspace up by its exact
identifier.

**Why.** The scope of a request is the workspace, and the workspace
belongs to a tenant: the tenant of the workspace is needed before the
context of the principal exists. The reader is the narrowest exception
of the specification and it has no access to any business table.

## 10. The events and the audit are written by the domain, in the transaction of the mutation

The records service writes the audit entry, the event and the receipt
through the unit of work of the mutation.

**Why.** The specification requires the four effects to be committed
together or not at all. The only place that can guarantee it is the
transaction of the mutation itself, and the only way to prove it is to
inject a failure at every stage of the transaction.

## 11. The subscriber is registered in the composition root

The subscribers of the deployment are code, with a stable identifier and
a filter of the events they handle. The worker resolves a fresh context
of the service principal before every command.

**Why.** The specification asks for trusted subscribers and refuses the
uploaded plugins and the caller defined handlers. The authority of a
subscriber is the authority of the service principal, and the identity
of the caller that started the chain is an attribution.

## 12. The number of the rows of a page is bounded by the answer and not by the page

The budget of four mebibytes is checked while the rows are encoded, and
the expansion of the relations is bounded before the rows are
materialized.

**Why.** A limit that is checked after the page was built is not a
limit. The expansion uses one statement per relation and per batch of
the parents, never one statement per parent.

## 13. The extension of the hub lives in the hub and not in a copy here

The extension of the access context contract is a change of the hub, and
it was taken upstream: the hub carries it since `4cedcfc`, the depot
pins that revision, and the depot holds no copy of the change.

**Why.** The gateway and the hub are the contracts of the platform, and
a change of them is a change of the platform. A patch that is reviewed
against a pinned revision is reviewable; a fork is not. Once the change
is in the repository of the hub, a copy of it here would be a second
source of truth that can only rot: the depot proves the contract with
the compatibility harness, against the real hub, at the pinned revision.

## 14. The tests run against a real PostgreSQL server

The integration tests and the compatibility harness start a PostgreSQL
server of their own.

**Why.** The isolation, the locking and the claims of the workers are
the behaviour of a server. An embedded engine proves the rules of the
domain and nothing else, and the specification asks for the server level
checks.
