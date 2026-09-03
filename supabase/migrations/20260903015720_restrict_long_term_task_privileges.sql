-- Forward-only least-privilege correction for projects whose legacy default
-- privileges granted broad access on newly created public tables.
--
-- Long-term tasks are available only to signed-in users through owner-scoped
-- RLS policies. Remove inherited anonymous and schema-wide privileges, then
-- grant authenticated clients only the CRUD operations used by the app.

revoke all privileges
  on table public.long_term_tasks, public.long_term_subtasks
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.long_term_tasks, public.long_term_subtasks
  to authenticated;
