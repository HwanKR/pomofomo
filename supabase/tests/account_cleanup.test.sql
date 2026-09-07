-- Account group cleanup authorization, all-or-nothing deletion, retry, and the
-- profile/long-term data cascades used by Auth hard deletion. All data rolls back.
begin;
set local search_path = extensions, public, pg_catalog;
select plan(22);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.capture_sqlstate(statement text)
returns text language plpgsql set search_path = '' as $$
begin
  execute statement;
  return null;
exception when others then
  return sqlstate;
end;
$$;
grant execute on function tests.capture_sqlstate(text) to anon, authenticated, service_role;

insert into auth.users (id, email, created_at, confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('51000000-0000-4000-8000-000000000001', 'cleanup-a@example.invalid', now(), now(), '{}', '{}'),
  ('51000000-0000-4000-8000-000000000002', 'cleanup-b@example.invalid', now(), now(), '{}', '{}');
insert into public.profiles (id, email)
values
  ('51000000-0000-4000-8000-000000000001', 'cleanup-a@example.invalid'),
  ('51000000-0000-4000-8000-000000000002', 'cleanup-b@example.invalid');
insert into public.groups (id, name, code, leader_id)
values
  ('52000000-0000-4000-8000-000000000001', 'Solo', 'CL0001', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000002', 'Shared', 'CL0002', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000003', 'Neighbor', 'CL0003', '51000000-0000-4000-8000-000000000002');
insert into public.group_members (group_id, user_id)
values
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002'),
  ('52000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000002');

select ok(exists (
  select 1 from pg_constraint as c
  where c.conrelid = 'public.profiles'::regclass
    and c.confrelid = 'auth.users'::regclass and c.contype = 'f' and c.confdeltype = 'c'
), 'profile deletion cascades from Auth');

set local role anon;
select is(tests.capture_sqlstate(
  $$select public.cleanup_account_groups('51000000-0000-4000-8000-000000000001')$$
), '42501', 'anonymous clients cannot clean up another account');
reset role;
set local role authenticated;
select is(tests.capture_sqlstate(
  $$select public.cleanup_account_groups('51000000-0000-4000-8000-000000000001')$$
), '42501', 'authenticated clients cannot call the privileged cleanup RPC');
reset role;

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select is(
  public.cleanup_account_groups('51000000-0000-4000-8000-000000000001'),
  '{"status":"leader","groups":[{"id":"52000000-0000-4000-8000-000000000002","name":"Shared"}]}'::jsonb,
  'shared group blocks cleanup and returns the existing leader conflict payload'
);
reset role;
select is((select count(*) from public.groups where leader_id = '51000000-0000-4000-8000-000000000001'), 2::bigint, 'blocked cleanup keeps even the solo group');
select is((select count(*) from public.group_members where group_id in ('52000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000002')), 3::bigint, 'blocked cleanup keeps all memberships');

delete from public.group_members
where group_id = '52000000-0000-4000-8000-000000000002'
  and user_id = '51000000-0000-4000-8000-000000000002';

create function tests.fail_group_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'simulated group deletion failure';
end;
$$;
create trigger cleanup_test_fail_group_delete before delete on public.groups
for each row when (old.id = '52000000-0000-4000-8000-000000000002')
execute function tests.fail_group_delete();

set local role service_role;
select is(tests.capture_sqlstate(
  $$select public.cleanup_account_groups('51000000-0000-4000-8000-000000000001')$$
), 'P0001', 'group deletion failure is reported');
reset role;
select is((select count(*) from public.groups where leader_id = '51000000-0000-4000-8000-000000000001'), 2::bigint, 'failure rolls back every group deletion');
select is((select count(*) from public.group_members where user_id = '51000000-0000-4000-8000-000000000001'), 2::bigint, 'failure rolls back cascading membership deletion');
drop trigger cleanup_test_fail_group_delete on public.groups;

set local role service_role;
select is(public.cleanup_account_groups('51000000-0000-4000-8000-000000000001')->>'status', 'ready', 'cleanup succeeds after retry');
reset role;
select is((select count(*) from public.groups where leader_id = '51000000-0000-4000-8000-000000000001'), 0::bigint, 'all eligible groups are removed');
select is((select count(*) from public.group_members where user_id = '51000000-0000-4000-8000-000000000001'), 0::bigint, 'memberships cascade with their groups');
set local role service_role;
select is(public.cleanup_account_groups('51000000-0000-4000-8000-000000000001')->>'status', 'ready', 'already-cleaned groups can be retried');
reset role;
select is((select count(*) from public.groups where leader_id = '51000000-0000-4000-8000-000000000002'), 1::bigint, 'another account groups remain untouched');

insert into public.long_term_tasks (id, user_id, title)
values
  ('53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'Cleanup task'),
  ('53000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'Neighbor task');
insert into public.long_term_subtasks (long_term_task_id, user_id, title)
values ('53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'Cleanup subtask');

create function tests.fail_profile_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'simulated profile cascade failure';
end;
$$;
create trigger cleanup_test_fail_profile_delete before delete on public.profiles
for each row when (old.id = '51000000-0000-4000-8000-000000000001')
execute function tests.fail_profile_delete();

select is(tests.capture_sqlstate(
  $$delete from auth.users where id = '51000000-0000-4000-8000-000000000001'$$
), 'P0001', 'failed Auth transaction reports the cascade failure');
select is((select count(*) from auth.users where id = '51000000-0000-4000-8000-000000000001'), 1::bigint, 'failed Auth transaction keeps the user');
select is((select count(*) from public.profiles where id = '51000000-0000-4000-8000-000000000001'), 1::bigint, 'failed Auth transaction keeps the profile');
drop trigger cleanup_test_fail_profile_delete on public.profiles;

select lives_ok($$delete from auth.users where id = '51000000-0000-4000-8000-000000000001'$$, 'Auth deletion can be retried');
select is((select count(*) from public.profiles where id = '51000000-0000-4000-8000-000000000001'), 0::bigint, 'successful Auth deletion removes the profile');
select is((select count(*) from public.long_term_tasks where user_id = '51000000-0000-4000-8000-000000000001'), 0::bigint, 'successful Auth deletion removes long-term tasks');
select is((select count(*) from public.long_term_subtasks where user_id = '51000000-0000-4000-8000-000000000001'), 0::bigint, 'successful Auth deletion removes long-term subtasks');
select is((select count(*) from public.long_term_tasks where user_id = '51000000-0000-4000-8000-000000000002'), 1::bigint, 'successful Auth deletion preserves another account tasks');

select * from finish();
rollback;
