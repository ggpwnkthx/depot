-- The tables of the backend (spec §11.1).
--
-- The tables of the backend live in their own schema: the generic query
-- engine only reaches the registered collections, never these tables.

create schema if not exists platform;

-- The ledger of the migrations. The checksum of a migration is verified
-- at the start of the process: a migration that was changed after it was
-- applied is a drift.
create table if not exists platform.schema_migrations (
  id text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- The registry of the workspaces (spec §6.1). The tenant is an external
-- reference: there is no foreign key into the tables of Hub.
create table if not exists platform.workspaces (
  id uuid primary key,
  tenant_id uuid not null,
  slug text not null check (slug ~ '^[a-z][a-z0-9_-]{0,62}$'),
  display_name text not null check (char_length(display_name) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_id_tenant unique (id, tenant_id)
);

create unique index if not exists workspaces_tenant_slug
  on platform.workspaces (tenant_id, slug);

-- The audit log (spec §11.2). It holds the identifiers of a mutation and
-- the names of the fields that changed, never the values.
create table if not exists platform.audit_entries (
  id uuid primary key,
  occurred_at timestamptz not null,
  principal_id uuid not null,
  tenant_id uuid not null,
  workspace_id uuid not null,
  route_id text not null,
  request_id text not null,
  source text not null check (source in ('shuttle', 'worker')),
  collection text not null,
  record_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete')),
  result_version integer not null,
  changed_fields text[] not null default '{}',
  policy_bundle_version text not null,
  policy_id text not null,
  causation_event_id uuid,
  causation_principal_id uuid
);

create index if not exists audit_scope_time
  on platform.audit_entries (tenant_id, workspace_id, occurred_at desc, id desc);

-- The events (spec §11.3).
create table if not exists platform.outbox_events (
  id uuid primary key,
  version integer not null,
  type text not null,
  tenant_id uuid not null,
  workspace_id uuid not null,
  collection text not null,
  record_id uuid not null,
  record_version integer not null,
  actor_id uuid not null,
  occurred_at timestamptz not null,
  changed_fields text[] not null default '{}',
  correlation_id text not null,
  causation_id uuid,
  causation_depth integer not null default 0,
  payload jsonb not null
);

create index if not exists outbox_scope_time
  on platform.outbox_events (tenant_id, workspace_id, occurred_at);

-- The deliveries (spec §11.5). One row per event and subscriber.
create table if not exists platform.outbox_deliveries (
  event_id uuid not null references platform.outbox_events (id) on delete cascade,
  subscriber_id text not null,
  tenant_id uuid not null,
  workspace_id uuid not null,
  state text not null check (state in ('pending', 'leased', 'acked', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, subscriber_id)
);

create index if not exists deliveries_due
  on platform.outbox_deliveries (next_attempt_at)
  where state in ('pending', 'leased');

-- The receipts of the creations (spec §9.6).
create table if not exists platform.idempotency_receipts (
  tenant_id uuid not null,
  workspace_id uuid not null,
  principal_id uuid not null,
  route_id text not null,
  endpoint text not null,
  key text not null,
  fingerprint text not null,
  status text not null check (status in ('committed')),
  record_id uuid not null,
  record_version integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, workspace_id, principal_id, route_id, endpoint, key)
);

create index if not exists receipts_expiry on platform.idempotency_receipts (expires_at);
