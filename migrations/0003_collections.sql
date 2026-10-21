-- The collections of the example deployment (spec §7).
--
-- Every business table carries the scope of its rows and the server
-- maintained fields, and the relations are composite foreign keys: a
-- reference that leaves the tenant or the workspace is rejected by the
-- database and not by a convention.

create schema if not exists data;

create table if not exists data.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  name text not null check (char_length(name) between 1 and 120),
  constraint categories_scope_fk
    foreign key (workspace_id, tenant_id) references platform.workspaces (id, tenant_id) on delete restrict,
  constraint categories_scope_unique unique (id, tenant_id, workspace_id)
);

create index if not exists categories_scope_idx
  on data.categories (tenant_id, workspace_id, id);

create table if not exists data.articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  title text not null check (char_length(title) between 1 and 240),
  body text check (body is null or char_length(body) <= 200000),
  status text not null default 'draft' check (status in ('draft', 'review', 'published')),
  category_id uuid,
  parent_id uuid,
  constraint articles_scope_fk
    foreign key (workspace_id, tenant_id) references platform.workspaces (id, tenant_id) on delete restrict,
  constraint articles_scope_unique unique (id, tenant_id, workspace_id),
  constraint articles_category_fk
    foreign key (category_id, tenant_id, workspace_id)
    references data.categories (id, tenant_id, workspace_id) on delete restrict,
  constraint articles_parent_fk
    foreign key (parent_id, tenant_id, workspace_id)
    references data.articles (id, tenant_id, workspace_id) on delete restrict
);

create index if not exists articles_scope_idx
  on data.articles (tenant_id, workspace_id, id);

create index if not exists articles_scope_created
  on data.articles (tenant_id, workspace_id, created_at desc);

create index if not exists articles_scope_title
  on data.articles (tenant_id, workspace_id, title);

create index if not exists articles_category_idx
  on data.articles (category_id) where category_id is not null;

create index if not exists articles_parent_idx
  on data.articles (parent_id) where parent_id is not null;

-- The projection the subscriber writes. The event identifier is unique
-- in a workspace: the effect of a subscriber is idempotent.
create table if not exists data.article_stats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  workspace_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  article_id uuid not null,
  word_count bigint not null check (word_count >= 0),
  event_id uuid not null,
  constraint article_stats_scope_fk
    foreign key (workspace_id, tenant_id) references platform.workspaces (id, tenant_id) on delete restrict,
  constraint article_stats_scope_unique unique (id, tenant_id, workspace_id),
  constraint article_stats_article_fk
    foreign key (article_id, tenant_id, workspace_id)
    references data.articles (id, tenant_id, workspace_id) on delete restrict
);

create unique index if not exists article_stats_event_unique
  on data.article_stats (tenant_id, workspace_id, event_id);

create index if not exists article_stats_scope_idx
  on data.article_stats (tenant_id, workspace_id, id);
