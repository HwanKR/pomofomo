-- Friend status and study totals refresh from these Postgres Changes streams.
-- Existing deployments may have enabled them manually; keep this forward-only
-- migration safe to apply in either case, including FOR ALL TABLES publications.
do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach v_table in array array['profiles', 'study_sessions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;
