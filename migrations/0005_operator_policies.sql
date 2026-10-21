-- The policies of the operator roles (spec §6.1 and §15.4).
--
-- The owner of the schema writes the registry of the workspaces: the
-- creation of a workspace is an operator command, not a request of a
-- tenant. The maintenance role runs the retention of the history.
--
-- The two roles are separated from the role of the api: the role of the
-- api never writes the registry and never purges the history.

create policy workspaces_owner on platform.workspaces
  for all
  to data_owner
  using (true)
  with check (true);

create policy audit_owner on platform.audit_entries
  for all
  to data_owner
  using (true)
  with check (true);

create policy audit_maintenance on platform.audit_entries
  for all
  to data_maintenance
  using (true)
  with check (true);

create policy outbox_events_owner on platform.outbox_events
  for all
  to data_owner
  using (true)
  with check (true);

create policy outbox_events_maintenance on platform.outbox_events
  for all
  to data_maintenance
  using (true)
  with check (true);

create policy outbox_deliveries_owner on platform.outbox_deliveries
  for all
  to data_owner
  using (true)
  with check (true);

create policy outbox_deliveries_maintenance on platform.outbox_deliveries
  for all
  to data_maintenance
  using (true)
  with check (true);

create policy idempotency_owner on platform.idempotency_receipts
  for all
  to data_owner
  using (true)
  with check (true);

create policy idempotency_maintenance on platform.idempotency_receipts
  for all
  to data_maintenance
  using (true)
  with check (true);

-- The owner of the schema writes the business data when a deployment
-- restores a backup or prepares an export. The role of the api never
-- uses these policies.
create policy articles_owner on data.articles
  for all
  to data_owner
  using (true)
  with check (true);

create policy categories_owner on data.categories
  for all
  to data_owner
  using (true)
  with check (true);

create policy article_stats_owner on data.article_stats
  for all
  to data_owner
  using (true)
  with check (true);
