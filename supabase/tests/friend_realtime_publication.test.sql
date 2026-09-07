begin;
set local search_path = extensions, public, pg_catalog;
select plan(2);

select ok(exists (
  select 1 from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
), 'friend profile status updates are published to Realtime');

select ok(exists (
  select 1 from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'study_sessions'
), 'saved and deleted study sessions refresh friend study totals');

select * from finish();
rollback;
