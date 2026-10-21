-- The isolation and the privileges (spec §6.4).
--
-- The tables of the backend and the tables of the collections have the
-- row level security enabled and forced: the owner of a table is subject
-- to the policies of the table as well.
--
-- The runtime role may not alter the schema, may not read the tables of
-- the platform beyond what it needs, and may not change the history of
-- the audit log.

-- The registry of the workspaces.
alter table platform.workspaces enable row level security;
alter table platform.workspaces force row level security;

create policy workspaces_data_scope on platform.workspaces
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
  );

-- The narrow bootstrap reader: it may read the identity of a workspace
-- before the scope of a request exists. Its projection is restricted by
-- the privileges of its role, not by the policy.
create policy workspaces_registry_read on platform.workspaces
  using (true)
  with check (false);

-- The collections.
alter table data.categories enable row level security;
alter table data.categories force row level security;

create policy categories_scope on data.categories
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

alter table data.articles enable row level security;
alter table data.articles force row level security;
create policy articles_scope on data.articles
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

alter table data.article_stats enable row level security;
alter table data.article_stats force row level security;

create policy article_stats_scope on data.article_stats
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The audit log: the rows of a workspace.
alter table platform.audit_entries enable row level security;
alter table platform.audit_entries force row level security;

create policy audit_scope on platform.audit_entries
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The events and their deliveries.
alter table platform.outbox_events enable row level security;
alter table platform.outbox_events force row level security;

create policy outbox_events_scope on platform.outbox_events
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

alter table platform.outbox_deliveries enable row level security;
alter table platform.outbox_deliveries force row level security;

create policy outbox_deliveries_scope on platform.outbox_deliveries
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The delivery role may claim the deliveries of every workspace. It may
-- not read a business record: it has no privilege on the schema of the
-- collections.
create policy outbox_deliveries_delivery on platform.outbox_deliveries
  using (true)
  with check (true);

create policy outbox_events_delivery on platform.outbox_events
  using (true)
  with check (false);

-- The receipts of the creations.
alter table platform.idempotency_receipts enable row level security;
alter table platform.idempotency_receipts force row level security;

create policy idempotency_scope on platform.idempotency_receipts
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The privileges of the roles.
grant usage on schema platform to data_runtime, data_registry, data_delivery, data_maintenance;
grant usage on schema data to data_runtime;

grant select, insert, update, delete on data.articles, data.categories, data.article_stats to data_runtime;

-- The ledger of the migrations: the process verifies it when it starts
-- and when it answers its readiness probe.
grant select on platform.schema_migrations to data_runtime;

grant insert on platform.audit_entries to data_runtime;
grant select on platform.audit_entries to data_runtime;

grant insert on platform.outbox_events to data_runtime;
grant select on platform.outbox_events to data_runtime;

grant insert on platform.outbox_deliveries to data_runtime;

grant insert, select, update on platform.idempotency_receipts to data_runtime;

-- The narrow registry reader: three columns of the registry and nothing
-- else.
grant select (id, tenant_id, status) on platform.workspaces to data_registry;

-- The delivery role: the metadata of the deliveries and of the events.
grant select, update on platform.outbox_deliveries to data_delivery;
grant select on platform.outbox_events to data_delivery;

-- The maintenance role: the retention of the history.
grant delete on platform.audit_entries, platform.outbox_events, platform.outbox_deliveries,
  platform.idempotency_receipts to data_maintenance;
grant select on platform.audit_entries, platform.outbox_events, platform.outbox_deliveries,
  platform.idempotency_receipts to data_maintenance;
