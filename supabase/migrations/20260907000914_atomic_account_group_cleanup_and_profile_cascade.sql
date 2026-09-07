-- Keep Auth and its profile in the same deletion transaction. The original
-- baseline used NO ACTION, so explicitly correct existing projects as well as
-- fixtures that already have CASCADE. Do not delete a profile in the API before
-- auth.admin.deleteUser succeeds.
do $$
declare
  v_fk record;
  v_found boolean := false;
begin
  for v_fk in
    select c.conname, c.confdeltype
    from pg_constraint as c
    where c.conrelid = 'public.profiles'::regclass
      and c.confrelid = 'auth.users'::regclass
      and c.contype = 'f'
      and c.conkey = array[
        (select a.attnum from pg_attribute as a
         where a.attrelid = 'public.profiles'::regclass and a.attname = 'id')
      ]::smallint[]
  loop
    v_found := true;
    if v_fk.confdeltype <> 'c' then
      execute format('alter table public.profiles drop constraint %I', v_fk.conname);
      execute format(
        'alter table public.profiles add constraint %I
         foreign key (id) references auth.users(id) on delete cascade',
        v_fk.conname
      );
    end if;
  end loop;

  if not v_found then
    alter table public.profiles add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end;
$$;

-- Account reset/deletion may remove only groups in which the account is alone.
-- Lock the group rows before checking members: a concurrent join needs a
-- conflicting FK key-share lock, and a leadership transfer also waits for this
-- transaction. Delete the parent once; group_members.group_id CASCADE (enforced
-- by 20260807133000) makes deletion all-or-nothing, including multiple groups.
create function public.cleanup_account_groups(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group record;
  v_group_ids uuid[] := array[]::uuid[];
  v_blocked_groups jsonb;
begin
  if current_user <> 'service_role'
    and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;

  for v_group in
    select g.id
    from public.groups as g
    where g.leader_id = p_user_id
    order by g.id
    for update
  loop
    v_group_ids := array_append(v_group_ids, v_group.id);
  end loop;

  select coalesce(jsonb_agg(
    jsonb_build_object('id', g.id, 'name', g.name) order by g.id
  ), '[]'::jsonb)
  into v_blocked_groups
  from public.groups as g
  where g.id = any(v_group_ids)
    and exists (
      select 1 from public.group_members as gm
      where gm.group_id = g.id and gm.user_id <> p_user_id
    );

  if jsonb_array_length(v_blocked_groups) > 0 then
    return jsonb_build_object('status', 'leader', 'groups', v_blocked_groups);
  end if;

  delete from public.groups as g
  where g.id = any(v_group_ids);

  return jsonb_build_object('status', 'ready');
end;
$$;

revoke execute on function public.cleanup_account_groups(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_account_groups(uuid) to service_role;
