-- The catalog of the workspaces (spec §7.6 and §8.5).
--
-- The catalog is a logical registry: it says which collections of the
-- deployment a workspace serves and which bundle of policies applies to
-- it. The tables of the collections are not created here: they come
-- from the reviewed migrations of the deployment, their isolation is
-- written in those migrations, and the role of the api never alters
-- them. A registration names a collection of the manifest of the
-- deployment and the table that the deployment declares for it.
--
-- The registry and the bundles are read by the role of the api inside
-- the scope of the transaction of the request: the row level security
-- of the tables is the isolation of the workspaces, exactly as it is for
-- the records.

create table if not exists platform.collection_registry (
  workspace_id uuid not null,
  tenant_id uuid not null,
  collection_key text not null check (collection_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$'),
  schema_version text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, collection_key),
  constraint collection_registry_scope_fk
    foreign key (workspace_id, tenant_id)
    references platform.workspaces (id, tenant_id) on delete cascade
);

-- The bundles a workspace published. The history is kept: a version is
-- never changed and never removed, and the version that applies is the
-- last one that was published.
create table if not exists platform.policy_bundles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  tenant_id uuid not null,
  version integer not null check (version > 0),
  bundle_version text not null,
  body jsonb not null,
  published_at timestamptz not null default now(),
  published_by text not null default '',
  constraint policy_bundles_scope_fk
    foreign key (workspace_id, tenant_id)
    references platform.workspaces (id, tenant_id) on delete cascade,
  constraint policy_bundles_version unique (workspace_id, version)
);

create index if not exists policy_bundles_workspace
  on platform.policy_bundles (workspace_id, version desc);

-- The isolation of the tables of the catalog.
alter table platform.collection_registry enable row level security;
alter table platform.collection_registry force row level security;

create policy collection_registry_scope on platform.collection_registry
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

alter table platform.policy_bundles enable row level security;
alter table platform.policy_bundles force row level security;

create policy policy_bundles_scope on platform.policy_bundles
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The owner of the schema writes the catalog of the workspaces: the
-- registration of a collection and the publication of a bundle are
-- operator commands and not requests of a tenant.
create policy collection_registry_owner on platform.collection_registry
  for all
  to data_owner
  using (true)
  with check (true);

create policy policy_bundles_owner on platform.policy_bundles
  for all
  to data_owner
  using (true)
  with check (true);

-- The narrow reader of the registry reads the catalog of the workspace it
-- names, exactly as it looks a workspace up by its exact identifier. The
-- catalog is the configuration of a workspace and not business data.
create policy collection_registry_registry_read on platform.collection_registry
  for all
  to data_registry
  using (true)
  with check (false);

create policy policy_bundles_registry_read on platform.policy_bundles
  for all
  to data_registry
  using (true)
  with check (false);

-- The role of the api reads the catalog of the workspace of the scope of
-- its transaction. It never writes it.
grant select on platform.collection_registry to data_runtime;
grant select on platform.policy_bundles to data_runtime;

-- The narrow reader of the registry.
grant select on platform.collection_registry to data_registry;
grant select on platform.policy_bundles to data_registry;
