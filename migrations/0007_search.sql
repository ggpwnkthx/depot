-- The index of the search of the example deployment (spec §9.9).
--
-- The search of a collection is a text search of the database over the
-- fields that the manifest declares searchable. The index is the one
-- that makes it cheap, and it is a part of the reviewed migration of
-- the collection: the runtime role never creates an index and never
-- alters one.
--
-- The expression of the index is the expression of the statement of the
-- search, field by field: the database only uses the index when the two
-- are the same expression.

create index if not exists articles_search_idx
  on data.articles
  using gin (
    (to_tsvector('english'::regconfig, coalesce(title, ''))
    || to_tsvector('english'::regconfig, coalesce(body, '')))
  );
