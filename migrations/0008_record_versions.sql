-- The history of the versions of the records (spec §11.6).
--
-- A collection that keeps a history declares the table of its versions
-- in its manifest: the table holds the image of a record before it was
-- changed, and the service writes it in the same statement as the
-- change, so the image and the change commit together or not at all.
--
-- The table is a mirror of the table of the collection: the columns of
-- the record carry the same names and the same types, so the statement
-- of a read of a version is the statement of a read of a record, and
-- the policies of the deployment are evaluated by the database over the
-- image exactly as they are over the record.
--
-- The table holds the versions that are not the current one: the
-- current version of a record is the row of the collection itself. A
-- deletion writes the image of the last version of the record with the
-- operation `delete`: that row is the tombstone of the record, and it
-- is what a restoration reads.
--
-- The table is created by a reviewed migration of the deployment and
-- the role of the api never alters it: the service writes the images
-- and reads them, and the retention of the history is the work of the
-- maintenance role.

create table if not exists data.article_versions (
  id uuid not null,
  version integer not null check (version > 0),
  tenant_id uuid not null,
  workspace_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null,
  updated_by uuid not null,
  updated_at timestamptz not null,
  title text not null check (char_length(title) between 1 and 240),
  body text check (body is null or char_length(body) <= 200000),
  status text not null check (status in ('draft', 'review', 'published')),
  category_id uuid,
  parent_id uuid,
  -- What happened to the version after this one.
  operation text not null check (operation in ('update', 'delete')),
  -- The names of the fields that the next change touched.
  changed_fields text[] not null default '{}',
  -- The version that the next change restored, when it was a rollback.
  restored_from integer,
  -- The instant of the change that superseded the version, and its author.
  superseded_at timestamptz not null,
  superseded_by uuid not null,
  constraint article_versions_scope_fk
    foreign key (workspace_id, tenant_id) references platform.workspaces (id, tenant_id) on delete restrict,
  constraint article_versions_pk primary key (tenant_id, workspace_id, id, version)
);

-- The versions of one record, from the latest to the oldest.
create index if not exists article_versions_record
  on data.article_versions (tenant_id, workspace_id, id, version desc);

-- The retention of the history reads the instant of the supersession.
create index if not exists article_versions_retention
  on data.article_versions (superseded_at);

-- The isolation of the table of the versions is the isolation of the
-- collection: the tenant and the workspace, and nothing else.
alter table data.article_versions enable row level security;
alter table data.article_versions force row level security;

create policy article_versions_scope on data.article_versions
  using (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  )
  with check (
    tenant_id = nullif(current_setting('data.tenant_id', true), '')::uuid
    and workspace_id = nullif(current_setting('data.workspace_id', true), '')::uuid
  );

-- The owner of the schema writes the business data when a deployment
-- restores a backup or prepares an export: the images of the versions
-- are part of the business data, and the owner sees them.
create policy article_versions_owner on data.article_versions
  for all
  to data_owner
  using (true)
  with check (true);

-- The role of the maintenance purges the history that is too old: it
-- removes the images of the versions of every workspace.
create policy article_versions_maintenance on data.article_versions
  for all
  to data_maintenance
  using (true)
  with check (true);

-- The privileges of the roles: the api writes the images and reads them,
-- and the maintenance role purges the history that is too old.
grant select, insert on data.article_versions to data_runtime;

-- The maintenance role reaches the tables of the versions: the usage of
-- the schema is the only privilege it needs beside the ones of the
-- tables, and the tables of the collections stay closed to it.
grant usage on schema data to data_maintenance;

grant select, delete on data.article_versions to data_maintenance;
