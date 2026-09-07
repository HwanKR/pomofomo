begin;

set local search_path = extensions, public, pg_catalog;
select plan(158);

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.capture_sqlstate(statement text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  execute statement;
  return null;
exception
  when others then
    return sqlstate;
end;
$$;

grant execute on function tests.capture_sqlstate(text)
to anon, authenticated, service_role;

create function tests.set_auth_context(user_id uuid, jwt_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(user_id::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(jwt_role, ''), true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', user_id, 'role', jwt_role)::text,
    true
  );
end;
$$;

grant execute on function tests.set_auth_context(uuid, text)
to anon, authenticated, service_role;

insert into auth.users (
  id,
  email,
  created_at,
  confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data
)
values
  (
    '00000000-0000-0000-0000-000000000001',
    'member-a@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'member-b@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    'nonmember@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    'admin@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    'stale-unconfirmed@example.invalid',
    now() - interval '1 hour',
    null,
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into public.profiles (id, email, role, nickname)
values
  (
    '00000000-0000-0000-0000-000000000001',
    'member-a@example.invalid',
    'user',
    'Member A'
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'member-b@example.invalid',
    'user',
    'Member B'
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    'nonmember@example.invalid',
    'user',
    'Nonmember'
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    'admin@example.invalid',
    'admin',
    'Admin'
  );

insert into public.feedbacks (
  id,
  content,
  category,
  user_id
)
values (
  '20000000-0000-0000-0000-000000000001',
  'Need better timers',
  'feature',
  '00000000-0000-0000-0000-000000000001'
);

insert into public.feedback_replies (
  id,
  feedback_id,
  user_id,
  content
)
values (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Attaching a screenshot'
);

select is(
  has_table_privilege('anon', 'public.debug_logs', 'SELECT'),
  false,
  'anon cannot read internal debug logs'
);

select is(
  has_table_privilege('anon', 'public.debug_logs', 'INSERT'),
  false,
  'anon cannot write internal debug logs'
);

select is(
  has_table_privilege('authenticated', 'public.debug_logs', 'SELECT'),
  false,
  'authenticated cannot read internal debug logs'
);

select is(
  has_table_privilege('authenticated', 'public.debug_logs', 'INSERT'),
  false,
  'authenticated cannot write internal debug logs'
);

select ok(
  has_table_privilege('service_role', 'public.debug_logs', 'INSERT'),
  'the Edge service role can write internal debug logs'
);

select is(
  has_table_privilege('service_role', 'public.debug_logs', 'SELECT'),
  false,
  'the Edge service role cannot read internal debug logs'
);

select is(
  has_table_privilege('service_role', 'public.debug_logs', 'UPDATE'),
  false,
  'the Edge service role cannot rewrite internal debug logs'
);

select is(
  has_table_privilege('service_role', 'public.debug_logs', 'DELETE'),
  false,
  'the Edge service role cannot delete internal debug logs'
);

select is(
  (
    select count(*)::integer
    from pg_policies as p
    where p.schemaname = 'public'
      and p.tablename = 'debug_logs'
  ),
  0,
  'debug_logs has no browser-facing RLS policies'
);

set local role service_role;

select is(
  tests.capture_sqlstate(
    $$insert into public.debug_logs (message, details)
      values ('edge delivery summary', '{"status":"delivered"}'::jsonb)$$
  ),
  null::text,
  'the Edge service role can insert a sanitized operational log'
);

reset role;

select is(
  has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  false,
  'authenticated has no table-wide profiles UPDATE privilege'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'status', 'UPDATE'),
  'authenticated can update the operational status column'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'timer_duration', 'UPDATE'),
  'authenticated can update the operational timer_duration column'
);

select is(
  has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE'),
  false,
  'authenticated cannot update profiles.role'
);

select is(
  has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'),
  false,
  'authenticated cannot update profiles.email'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  auth.uid(),
  '00000000-0000-0000-0000-000000000001'::uuid,
  'test JWT resolves to member A'
);

select is(
  tests.capture_sqlstate(
    $$update public.profiles set role = 'admin'
      where id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'an ordinary user cannot self-promote through direct SQL'
);

select is(
  tests.capture_sqlstate(
    $$update public.profiles
      set status = 'studying', current_task = 'security test'
      where id = '00000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'an ordinary user can update allowed operational profile columns'
);

select is(
  tests.capture_sqlstate(
    $$update public.profiles set status = 'studying'
      where id = '00000000-0000-0000-0000-000000000002'$$
  ),
  null::text,
  'RLS safely filters an attempted update of another profile'
);

reset role;

select is(
  (select status from public.profiles where id = '00000000-0000-0000-0000-000000000001'),
  'studying',
  'the allowed self-update persisted'
);

select is(
  (select status from public.profiles where id = '00000000-0000-0000-0000-000000000002'),
  'offline',
  'another user profile was not modified'
);

grant update (role) on public.profiles to authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.profiles set role = 'admin'
      where id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'the guard trigger blocks role changes even if a column grant regresses'
);

reset role;
revoke update (role) on public.profiles from authenticated;

grant update (role) on public.profiles to authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000004',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.profiles set role = 'user'
      where id = '00000000-0000-0000-0000-000000000004'$$
  ),
  '42501',
  'an admin JWT also cannot directly change protected profile columns'
);

reset role;
revoke update (role) on public.profiles from authenticated;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000004","role":"service_role"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000004',
  'service_role'
);
set local role service_role;

select is(
  tests.capture_sqlstate(
    $$update public.profiles set role = 'verified-system-change'
      where id = '00000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'service_role can perform a deliberate protected-column update'
);

select is(
  tests.capture_sqlstate(
    $$update public.profiles set role = 'user'
      where id = '00000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'service_role can restore the protected column'
);

reset role;

select is(
  to_regprocedure('public.delete_unconfirmed_users()'),
  null::regprocedure,
  'the destructive cleanup function is absent from public'
);

select is(
  has_function_privilege('anon', 'private.delete_unconfirmed_users()', 'EXECUTE'),
  false,
  'anon cannot execute the private cleanup function'
);

select is(
  has_function_privilege('authenticated', 'private.delete_unconfirmed_users()', 'EXECUTE'),
  false,
  'authenticated cannot execute the private cleanup function'
);

select is(
  has_function_privilege('service_role', 'private.delete_unconfirmed_users()', 'EXECUTE'),
  false,
  'service_role cannot execute the cron-only cleanup function'
);

select ok(
  has_function_privilege('postgres', 'private.delete_unconfirmed_users()', 'EXECUTE'),
  'the postgres owner can execute the cron-only cleanup function'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select tests.set_auth_context(null, 'anon');
set local role anon;
select is(
  tests.capture_sqlstate('select private.delete_unconfirmed_users()'),
  '42501',
  'an anon call to the destructive cleanup function fails'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;
select is(
  tests.capture_sqlstate('select private.delete_unconfirmed_users()'),
  '42501',
  'an authenticated call to the destructive cleanup function fails'
);
reset role;

select is(
  tests.capture_sqlstate('select private.delete_unconfirmed_users()'),
  null::text,
  'the postgres owner can execute cleanup successfully'
);

select is(
  (select count(*) from auth.users where id = '00000000-0000-0000-0000-000000000005'),
  0::bigint,
  'cleanup removes the stale unconfirmed test user'
);

select is(
  (select count(*) from auth.users where id = '00000000-0000-0000-0000-000000000001'),
  1::bigint,
  'cleanup preserves a confirmed user'
);

select is(
  (
    select count(*)
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) as acl
    where n.nspname in ('public', 'private')
      and acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
      and p.proname in (
        'delete_unconfirmed_users',
        'send_friend_request',
        'accept_friend_request',
        'reject_friend_request',
        'cancel_friend_request',
        'delete_friend',
        'create_group',
        'join_group_by_code',
        'get_group_invite_code',
        'transfer_group_leadership',
        'get_friends_study_time',
        'get_group_study_time_v3',
        'get_admin_dashboard_stats',
        'get_admin_user_study_summary',
        'is_group_leader',
        'feedback_image_path_matches_user',
        'is_safe_push_endpoint',
        'claim_push_notification_event',
        'complete_push_notification_event'
      )
  ),
  0::bigint,
  'sensitive RPCs have no PUBLIC execute ACL'
);

select is(
  (
    select count(*)
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname in (
        'delete_unconfirmed_users',
        'send_friend_request',
        'accept_friend_request',
        'reject_friend_request',
        'cancel_friend_request',
        'delete_friend',
        'create_group',
        'join_group_by_code',
        'get_group_invite_code',
        'transfer_group_leadership',
        'get_friends_study_time',
        'get_group_study_time_v3',
        'get_admin_dashboard_stats',
        'get_admin_user_study_summary',
        'is_group_leader',
        'feedback_image_path_matches_user',
        'is_safe_push_endpoint',
        'claim_push_notification_event',
        'complete_push_notification_event'
      )
  ),
  0::bigint,
  'anon has no effective execute access to sensitive RPCs'
);

with expected_service_role_functions(signature) as (
  values
    ('public.claim_push_notification_event(uuid,uuid,text,integer)'),
    ('public.cleanup_account_groups(uuid)'),
    ('public.complete_push_notification_event(uuid,text)'),
    ('public.feedback_image_path_matches_user(uuid,text)'),
    ('public.is_safe_push_endpoint(text)')
)
select ok(
  not exists (
    select 1
    from expected_service_role_functions as expected
    where to_regprocedure(expected.signature) is null
      or not has_function_privilege(
        'service_role',
        to_regprocedure(expected.signature),
        'EXECUTE'
      )
  )
    and (
      select count(*)
      from pg_proc as p
      join pg_namespace as n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prokind = 'f'
        and has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) = (select count(*) from expected_service_role_functions),
  'service_role execute access is limited to the supported service RPCs'
);

select ok(
  has_function_privilege('authenticated', 'public.send_friend_request(text)', 'EXECUTE'),
  'authenticated can execute the supported friend-request RPC'
);

select ok(
  has_function_privilege('authenticated', 'public.accept_friend_request(uuid)', 'EXECUTE'),
  'authenticated can execute the supported friend-accept RPC'
);

select ok(
  has_function_privilege('authenticated', 'public.create_group(text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.join_group_by_code(text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_group_invite_code(uuid)', 'EXECUTE')
    and has_function_privilege(
      'authenticated',
      'public.transfer_group_leadership(uuid,uuid)',
      'EXECUTE'
    ),
  'authenticated can execute the hardened group RPCs'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.feedback_image_path_matches_user(uuid,text)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'public.is_safe_push_endpoint(text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.feedback_image_path_matches_user(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.is_safe_push_endpoint(text)',
      'EXECUTE'
    ),
  'authenticated can execute the validator helpers used by client RLS paths'
);

select is(
  to_regprocedure('public.add_friend(uuid)'),
  null::regprocedure,
  'the consent-bypassing add_friend RPC was removed'
);

select is(
  to_regprocedure('public.get_user_id_by_email(text)'),
  null::regprocedure,
  'the direct email-to-user-id lookup RPC was removed'
);

select is(
  to_regprocedure('public.get_group_study_time(uuid,text)'),
  null::regprocedure,
  'the legacy unrestricted group stats RPC was removed'
);

select is(
  to_regprocedure('public.get_group_study_time_v2(text,uuid)'),
  null::regprocedure,
  'the second legacy unrestricted group stats RPC was removed'
);

select is(
  (
    select count(*)
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not coalesce(p.proconfig, '{}'::text[])
        @> array['search_path=""']::text[]
  ),
  0::bigint,
  'every SECURITY DEFINER function has an empty fixed search_path'
);

set local role postgres;
create function public.__security_acl_probe()
returns integer
language sql
as $$ select 1 $$;
reset role;

select ok(
  not has_function_privilege('anon', 'public.__security_acl_probe()', 'EXECUTE')
    and not has_function_privilege(
      'authenticated',
      'public.__security_acl_probe()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.__security_acl_probe()',
      'EXECUTE'
    ),
  'new functions do not regain client or service-role execute by default'
);

select is(
  has_table_privilege('authenticated', 'public.friendships', 'INSERT'),
  false,
  'authenticated cannot directly create a friendship'
);

select is(
  has_column_privilege('authenticated', 'public.friendships', 'friend_id', 'UPDATE'),
  false,
  'authenticated cannot rewrite friendship identity columns'
);

select ok(
  has_column_privilege('authenticated', 'public.friendships', 'nickname', 'UPDATE'),
  'authenticated can still update a local friend nickname'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.friendships (user_id, friend_id)
      values (
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002'
      )$$
  ),
  '42501',
  'direct SQL cannot create a friendship without acceptance'
);

select is(
  tests.capture_sqlstate(
    $$select public.send_friend_request('member-b@example.invalid')$$
  ),
  null::text,
  'member A can send a normal friend request'
);

reset role;

select is(
  (
    select count(*)
    from public.friend_requests
    where sender_id = '00000000-0000-0000-0000-000000000001'
      and receiver_id = '00000000-0000-0000-0000-000000000002'
      and status = 'pending'
  ),
  1::bigint,
  'the normal friend request is pending exactly once'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.accept_friend_request(
      (
        select id
        from public.friend_requests
        where sender_id = '00000000-0000-0000-0000-000000000001'
          and receiver_id = '00000000-0000-0000-0000-000000000002'
      )
    )$$
  ),
  null::text,
  'the intended receiver can accept the friend request'
);

reset role;

select is(
  (
    select count(*)
    from public.friendships
    where (user_id, friend_id) in (
      (
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid
      ),
      (
        '00000000-0000-0000-0000-000000000002'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      )
    )
  ),
  2::bigint,
  'acceptance creates one friendship row in each direction'
);

-- ==========================================================================
-- friend_requests direct-DML lockdown and RPC-only state transitions
-- ==========================================================================
-- These assertions reproduce the identity-forgery attack and prove it is now
-- blocked: browser roles have no direct INSERT/UPDATE/DELETE on friend_requests
-- (neither table GRANT nor RLS write policy), and every transition is decided
-- by a SECURITY DEFINER RPC that derives identity from auth.uid().

-- Direct write privileges are fully revoked from browser roles; reads remain.
select is(
  has_table_privilege('authenticated', 'public.friend_requests', 'INSERT'),
  false,
  'authenticated cannot directly INSERT a friend request'
);
select is(
  has_table_privilege('authenticated', 'public.friend_requests', 'UPDATE'),
  false,
  'authenticated cannot directly UPDATE a friend request'
);
select is(
  has_table_privilege('authenticated', 'public.friend_requests', 'DELETE'),
  false,
  'authenticated cannot directly DELETE a friend request'
);
select ok(
  has_table_privilege('authenticated', 'public.friend_requests', 'SELECT'),
  'authenticated can still read friend requests for lists and Realtime'
);
select is(
  has_table_privilege('anon', 'public.friend_requests', 'INSERT'),
  false,
  'anon cannot directly INSERT a friend request'
);
select is(
  has_table_privilege('anon', 'public.friend_requests', 'UPDATE'),
  false,
  'anon cannot directly UPDATE a friend request'
);
select is(
  (
    select count(*)::integer
    from pg_policies as p
    where p.schemaname = 'public'
      and p.tablename = 'friend_requests'
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ),
  0,
  'friend_requests exposes no direct write RLS policy'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.reject_friend_request(uuid)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'public.cancel_friend_request(uuid)',
      'EXECUTE'
    ),
  'authenticated can execute the reject and cancel RPCs'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.reject_friend_request(uuid)',
    'EXECUTE'
  )
    and not has_function_privilege(
      'anon',
      'public.cancel_friend_request(uuid)',
      'EXECUTE'
    ),
  'anon cannot execute the reject or cancel RPCs'
);

-- Attack step 1: the attacker (member A) tries to seed a self-request directly.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.friend_requests (sender_id, receiver_id, sender_email)
      values (
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001',
        'member-a@example.invalid'
      )$$
  ),
  '42501',
  'attack step 1: a direct self-request INSERT is denied'
);

reset role;

-- Seed a legitimate pending request from member C to member A via the RPC.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000003',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.send_friend_request('member-a@example.invalid')$$
  ),
  null::text,
  'member C can send a normal pending request to member A'
);

reset role;

-- Stash the seeded request id (reset role bypasses RLS) for later RPC calls.
select set_config(
  'tests.fr_c_to_a',
  (
    select id::text
    from public.friend_requests
    where sender_id = '00000000-0000-0000-0000-000000000003'
      and receiver_id = '00000000-0000-0000-0000-000000000001'
  ),
  true
);

-- Attack step 2+: as the receiver, member A tries to forge identity/status or
-- delete the row through direct DML. Every attempt is denied.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.friend_requests
      set sender_id = '00000000-0000-0000-0000-000000000004'
      where receiver_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'attack step 2: a receiver cannot rewrite sender_id to forge a victim'
);
select is(
  tests.capture_sqlstate(
    $$update public.friend_requests
      set status = 'accepted'
      where receiver_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'a receiver cannot self-approve a request through a direct status UPDATE'
);
select is(
  tests.capture_sqlstate(
    $$update public.friend_requests
      set sender_email = 'attacker@example.invalid'
      where receiver_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'a receiver cannot rewrite sender_email'
);
select is(
  tests.capture_sqlstate(
    $$delete from public.friend_requests
      where receiver_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'a receiver cannot directly DELETE a received request'
);

reset role;

-- The blocked forge changed nothing: no victim friendship, row identity intact.
select is(
  (
    select count(*)
    from public.friendships
    where (user_id, friend_id) in (
      (
        '00000000-0000-0000-0000-000000000004'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      ),
      (
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000004'::uuid
      )
    )
  ),
  0::bigint,
  'the blocked identity forge created no friendship with the victim'
);
select is(
  (
    select sender_id
    from public.friend_requests
    where receiver_id = '00000000-0000-0000-0000-000000000001'
  ),
  '00000000-0000-0000-0000-000000000003'::uuid,
  'the received request sender_id was not mutated by the forge attempt'
);
select is(
  (
    select status
    from public.friend_requests
    where receiver_id = '00000000-0000-0000-0000-000000000001'
  ),
  'pending',
  'the received request is still pending after the blocked forge'
);

-- reject: only the receiver of a pending request may reject it.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.reject_friend_request(
      current_setting('tests.fr_c_to_a')::uuid
    )$$
  ),
  '42501',
  'a non-receiver cannot reject a friend request'
);

reset role;

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.reject_friend_request(
      current_setting('tests.fr_c_to_a')::uuid
    )$$
  ),
  null::text,
  'the receiver can reject a pending friend request'
);

reset role;

select is(
  (
    select status
    from public.friend_requests
    where id = current_setting('tests.fr_c_to_a')::uuid
  ),
  'rejected',
  'rejecting transitions the request to rejected'
);
select is(
  (
    select count(*)
    from public.friendships
    where (user_id, friend_id) in (
      (
        '00000000-0000-0000-0000-000000000003'::uuid,
        '00000000-0000-0000-0000-000000000001'::uuid
      ),
      (
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000003'::uuid
      )
    )
  ),
  0::bigint,
  'rejecting a request creates no friendship'
);

-- cancel: only the sender of a pending request may withdraw it.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.send_friend_request('admin@example.invalid')$$
  ),
  null::text,
  'member B can send a pending request to the admin user'
);

reset role;

select set_config(
  'tests.fr_b_to_d',
  (
    select id::text
    from public.friend_requests
    where sender_id = '00000000-0000-0000-0000-000000000002'
      and receiver_id = '00000000-0000-0000-0000-000000000004'
  ),
  true
);

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000003',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.cancel_friend_request(
      current_setting('tests.fr_b_to_d')::uuid
    )$$
  ),
  '42501',
  'a non-sender cannot cancel a friend request'
);

reset role;

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.cancel_friend_request(
      current_setting('tests.fr_b_to_d')::uuid
    )$$
  ),
  null::text,
  'the sender can cancel their own pending request'
);

reset role;

select is(
  (
    select count(*)
    from public.friend_requests
    where sender_id = '00000000-0000-0000-0000-000000000002'
      and receiver_id = '00000000-0000-0000-0000-000000000004'
  ),
  0::bigint,
  'cancel removes the pending request row'
);

-- accept: sender / unrelated users are rejected; re-accept makes no duplicate.
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.send_friend_request('nonmember@example.invalid')$$
  ),
  null::text,
  'member B can send a pending request to member C'
);

reset role;

select set_config(
  'tests.fr_b_to_c',
  (
    select id::text
    from public.friend_requests
    where sender_id = '00000000-0000-0000-0000-000000000002'
      and receiver_id = '00000000-0000-0000-0000-000000000003'
  ),
  true
);

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.accept_friend_request(
      current_setting('tests.fr_b_to_c')::uuid
    )$$
  ),
  '42501',
  'the sender cannot accept their own request'
);

reset role;

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000004',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.accept_friend_request(
      current_setting('tests.fr_b_to_c')::uuid
    )$$
  ),
  '42501',
  'an unrelated user cannot accept another pair''s request'
);

reset role;

select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000003',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.accept_friend_request(
      current_setting('tests.fr_b_to_c')::uuid
    )$$
  ),
  null::text,
  'the receiver can accept the pending request'
);
select is(
  tests.capture_sqlstate(
    $$select public.accept_friend_request(
      current_setting('tests.fr_b_to_c')::uuid
    )$$
  ),
  '42501',
  're-accepting an already-accepted request is rejected'
);

reset role;

select is(
  (
    select count(*)
    from public.friendships
    where (user_id, friend_id) in (
      (
        '00000000-0000-0000-0000-000000000002'::uuid,
        '00000000-0000-0000-0000-000000000003'::uuid
      ),
      (
        '00000000-0000-0000-0000-000000000003'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid
      )
    )
  ),
  2::bigint,
  'acceptance yields exactly one friendship per direction with no duplicate on re-accept'
);

insert into public.groups (id, name, code, leader_id)
values (
  '10000000-0000-0000-0000-000000000001',
  'Security Test Group',
  'security-test-group',
  '00000000-0000-0000-0000-000000000001'
);

insert into public.group_members (group_id, user_id)
values
  (
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001'
  ),
  (
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002'
  );

insert into public.study_sessions (user_id, group_id, duration, created_at)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    60,
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    120,
    now()
  );

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  (
    select total_seconds
    from public.get_friends_study_time(
      '00000000-0000-0000-0000-000000000001',
      current_date::text
    )
    where friend_id = '00000000-0000-0000-0000-000000000002'
  ),
  120::bigint,
  'a caller can read study time for an actual friend'
);

select is(
  tests.capture_sqlstate(
    format(
      'select * from public.get_friends_study_time(%L::uuid, %L)',
      '00000000-0000-0000-0000-000000000003',
      current_date::text
    )
  ),
  '42501',
  'a caller cannot supply another user_id to read friend stats'
);

select is(
  (
    select sum(total_seconds)::bigint
    from public.get_group_study_time_v3(
      '10000000-0000-0000-0000-000000000001',
      now() - interval '1 day',
      now() + interval '1 day'
    )
  ),
  180::bigint,
  'a group member can read the normal group aggregate'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000003',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select * from public.get_group_study_time_v3(
      '10000000-0000-0000-0000-000000000001',
      now() - interval '1 day',
      now() + interval '1 day'
    )$$
  ),
  '42501',
  'a nonmember cannot read group study statistics'
);

reset role;

select is(
  has_table_privilege('authenticated', 'public.push_subscriptions', 'UPDATE'),
  false,
  'authenticated has no table-wide push subscription UPDATE privilege'
);

select ok(
  has_column_privilege('authenticated', 'public.push_subscriptions', 'keys', 'UPDATE'),
  'authenticated can update push subscription keys for upsert'
);

select is(
  has_column_privilege('authenticated', 'public.push_subscriptions', 'created_at', 'UPDATE'),
  false,
  'authenticated cannot rewrite push subscription creation time'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.push_subscriptions (user_id, endpoint, keys)
      values (
        '00000000-0000-0000-0000-000000000001',
        'https://fcm.googleapis.com/fcm/send/test-endpoint-a',
        '{"p256dh":"first","auth":"first"}'::jsonb
      )
      on conflict (endpoint) do update
      set user_id = excluded.user_id,
          endpoint = excluded.endpoint,
          keys = excluded.keys$$
  ),
  null::text,
  'the first push subscription insert succeeds'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.push_subscriptions (user_id, endpoint, keys)
      values (
        '00000000-0000-0000-0000-000000000001',
        'https://fcm.googleapis.com/fcm/send/test-endpoint-a',
        '{"p256dh":"second","auth":"second"}'::jsonb
      )
      on conflict (endpoint) do update
      set user_id = excluded.user_id,
          endpoint = excluded.endpoint,
          keys = excluded.keys$$
  ),
  null::text,
  'the current client upsert path can update an owned subscription'
);

select is(
  tests.capture_sqlstate(
    $$update public.push_subscriptions
      set created_at = now() - interval '1 day'
      where endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-a'$$
  ),
  '42501',
  'a client cannot rewrite protected push subscription metadata'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.push_subscriptions (user_id, endpoint, keys)
      values (
        '00000000-0000-0000-0000-000000000001',
        'https://localhost/push',
        '{"p256dh":"bad","auth":"bad"}'::jsonb
      )$$
  ),
  '42501',
  'a localhost push endpoint is rejected for authenticated inserts'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.push_subscriptions (user_id, endpoint, keys)
      values (
        '00000000-0000-0000-0000-000000000002',
        'https://fcm.googleapis.com/fcm/send/test-endpoint-a',
        '{"p256dh":"other","auth":"other"}'::jsonb
      )
      on conflict (endpoint) do update
      set user_id = excluded.user_id,
          endpoint = excluded.endpoint,
          keys = excluded.keys$$
  ),
  '42501',
  'another user cannot claim an existing push subscription row'
);

reset role;

select is(
  (
    select user_id
    from public.push_subscriptions
    where endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-a'
  ),
  '00000000-0000-0000-0000-000000000001'::uuid,
  'the subscription remains owned by the original user'
);

select is(
  (
    select keys ->> 'p256dh'
    from public.push_subscriptions
    where endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-a'
  ),
  'second',
  'the owned subscription upsert persisted the latest keys once'
);

select is(
  has_column_privilege('authenticated', 'public.groups', 'code', 'SELECT'),
  false,
  'authenticated cannot read groups.code directly'
);

select ok(
  has_column_privilege('authenticated', 'public.groups', 'name', 'SELECT')
    and has_column_privilege('authenticated', 'public.groups', 'created_at', 'SELECT'),
  'authenticated keeps direct access to the non-sensitive group columns'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  (
    select count(*)
    from public.groups
    where id = '10000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'an existing group member can still read their group row'
);

select is(
  tests.capture_sqlstate(
    $$select code from public.groups
      where id = '10000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct groups.code reads are denied even to members'
);

select set_config(
  'tests.rpc_group_id',
  (
    select id::text
    from public.create_group('RPC Group Alpha')
  ),
  true
);

reset role;

select ok(
  current_setting('tests.rpc_group_id', true) is not null,
  'create_group returned a persisted group id'
);

select is(
  (
    select count(*)
    from public.group_members
    where group_id = current_setting('tests.rpc_group_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000001'
  ),
  1::bigint,
  'create_group atomically adds the creator as a member'
);

select ok(
  (
    select code ~ '^[A-Z0-9]{6}$'
    from public.groups
    where id = current_setting('tests.rpc_group_id')::uuid
  ),
  'create_group generated a canonical six-character invite code'
);

select set_config(
  'tests.rpc_group_code',
  public.get_group_invite_code(current_setting('tests.rpc_group_id')::uuid),
  true
);

select ok(
  current_setting('tests.rpc_group_code') ~ '^[A-Z0-9]{6}$',
  'the current leader can fetch the invite code through the leader-only RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000003',
  'authenticated'
);
set local role authenticated;

select is(
  (
    select count(*)
    from public.groups
    where id = '10000000-0000-0000-0000-000000000001'
  ),
  0::bigint,
  'a nonmember cannot read group rows'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.group_members (group_id, user_id)
      values (
        '10000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000003'
      )$$
  ),
  '42501',
  'direct group membership inserts are denied'
);

select is(
  tests.capture_sqlstate(
    $$select public.join_group_by_code('BAD!')$$
  ),
  '22023',
  'an invalid join code format is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.join_group_by_code('ZZZZZZ')$$
  ),
  '22023',
  'a well-formed but nonexistent join code returns the same generic error'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.join_group_by_code(
      current_setting('tests.rpc_group_code')
    )$$
  ),
  null::text,
  'a valid join_group_by_code call succeeds'
);

select is(
  tests.capture_sqlstate(
    $$select public.join_group_by_code(
      current_setting('tests.rpc_group_code')
    )$$
  ),
  null::text,
  'replaying join_group_by_code is idempotent for an existing member'
);

select is(
  (
    select count(*)
    from public.group_members
    where group_id = current_setting('tests.rpc_group_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000002'
  ),
  1::bigint,
  'the joined member still has exactly one membership row after replay'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.group_members'::regclass
      and c.contype = 'u'
      and c.conkey = array[
        (
          select a.attnum
          from pg_catalog.pg_attribute as a
          where a.attrelid = 'public.group_members'::regclass
            and a.attname = 'group_id'
        ),
        (
          select a.attnum
          from pg_catalog.pg_attribute as a
          where a.attrelid = 'public.group_members'::regclass
            and a.attname = 'user_id'
        )
      ]::smallint[]
  ),
  'group membership uniqueness is enforced by UNIQUE(group_id, user_id)'
);

select is(
  tests.capture_sqlstate(
    $$select public.get_group_invite_code(
      current_setting('tests.rpc_group_id')::uuid
    )$$
  ),
  '42501',
  'a nonleader member cannot fetch the invite code'
);

select is(
  tests.capture_sqlstate(
    $$select public.transfer_group_leadership(
      current_setting('tests.rpc_group_id')::uuid,
      '00000000-0000-0000-0000-000000000001'
    )$$
  ),
  '42501',
  'a nonleader cannot transfer group leadership'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.group_members
      set user_id = '00000000-0000-0000-0000-000000000003'
      where group_id = current_setting('tests.rpc_group_id')::uuid
        and user_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'group membership identity updates are denied'
);

select is(
  tests.capture_sqlstate(
    $$select public.transfer_group_leadership(
      current_setting('tests.rpc_group_id')::uuid,
      '00000000-0000-0000-0000-000000000002'
    )$$
  ),
  null::text,
  'the current leader can transfer leadership to an existing member'
);

reset role;

select is(
  (
    select leader_id
    from public.groups
    where id = current_setting('tests.rpc_group_id')::uuid
  ),
  '00000000-0000-0000-0000-000000000002'::uuid,
  'leadership transfer persisted on the group row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.get_group_invite_code(
      current_setting('tests.rpc_group_id')::uuid
    )$$
  ),
  '42501',
  'the former leader loses invite-code access after transfer'
);

select is(
  tests.capture_sqlstate(
    $$delete from public.group_members
      where group_id = current_setting('tests.rpc_group_id')::uuid
        and user_id = '00000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'the former leader can leave the group through the normal self-delete path'
);

reset role;

select is(
  (
    select count(*)
    from public.group_members
    where group_id = current_setting('tests.rpc_group_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000001'
  ),
  0::bigint,
  'the former leader membership row is removed after leaving'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select ok(
  public.get_group_invite_code(current_setting('tests.rpc_group_id')::uuid)
    = current_setting('tests.rpc_group_code'),
  'the new leader can fetch the same invite code after transfer'
);

select is(
  tests.capture_sqlstate(
    $$delete from public.groups
      where id = current_setting('tests.rpc_group_id')::uuid$$
  ),
  null::text,
  'the new leader can delete the group through the normal delete path'
);

reset role;

select is(
  (
    select count(*)
    from public.groups
    where id = current_setting('tests.rpc_group_id')::uuid
  ),
  0::bigint,
  'the group row is removed after leader deletion'
);

select is(
  (
    select count(*)
    from public.group_members
    where group_id = current_setting('tests.rpc_group_id')::uuid
  ),
  0::bigint,
  'deleting the group cascades away the remaining membership rows'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select ok(
  has_column_privilege('authenticated', 'public.feedbacks', 'images', 'SELECT')
    and not has_column_privilege('authenticated', 'public.feedbacks', 'images', 'UPDATE')
    and not has_column_privilege(
      'authenticated',
      'public.feedback_replies',
      'images',
      'UPDATE'
    ),
  'legacy feedback image arrays remain readable but not client-writable'
);

select is(
  tests.capture_sqlstate(
    $$update public.feedbacks
      set images = array['https://example.invalid/unsafe.png']
      where id = '20000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct feedback image URL array updates are denied'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.feedback_replies (
        feedback_id,
        user_id,
        content,
        images
      )
      values (
        '20000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'unsafe reply',
        array['https://example.invalid/unsafe.png']
      )$$
  ),
  '42501',
  'direct reply image URL injection is denied at insert time'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.feedback_images (
        user_id,
        bucket_id,
        object_path,
        feedback_id
      )
      values (
        '00000000-0000-0000-0000-000000000001',
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000001/40000000-0000-0000-0000-000000000001.png',
        '20000000-0000-0000-0000-000000000001'
      )$$
  ),
  null::text,
  'a feedback author can attach canonical image metadata to their own feedback'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.feedback_images (
        user_id,
        bucket_id,
        object_path,
        reply_id
      )
      values (
        '00000000-0000-0000-0000-000000000001',
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000001/40000000-0000-0000-0000-000000000002.webp',
        '30000000-0000-0000-0000-000000000001'
      )$$
  ),
  null::text,
  'a reply author can attach canonical image metadata to their own reply'
);

select ok(
  tests.capture_sqlstate(
    $$insert into public.feedback_images (
        user_id,
        bucket_id,
        object_path,
        feedback_id
      )
      values (
        '00000000-0000-0000-0000-000000000001',
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000002/40000000-0000-0000-0000-000000000003.png',
        '20000000-0000-0000-0000-000000000001'
      )$$
  ) in ('42501', '23514'),
  'feedback image metadata must use the canonical owner namespace'
);

select is(
  tests.capture_sqlstate(
    $$insert into storage.objects (bucket_id, name, owner_id)
      values (
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000001/40000000-0000-0000-0000-000000000001.png',
        '00000000-0000-0000-0000-000000000001'
      )$$
  ),
  null::text,
  'the object owner can upload a canonical feedback image object'
);

select is(
  tests.capture_sqlstate(
    $$insert into storage.objects (bucket_id, name, owner_id)
      values (
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000001/40000000-0000-0000-0000-000000000002.webp',
        '00000000-0000-0000-0000-000000000001'
      )$$
  ),
  null::text,
  'the object owner can upload a canonical feedback reply image object'
);

select is(
  tests.capture_sqlstate(
    $$insert into storage.objects (bucket_id, name, owner_id)
      values (
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000002/40000000-0000-0000-0000-000000000004.png',
        '00000000-0000-0000-0000-000000000001'
      )$$
  ),
  '42501',
  'storage uploads reject a namespace that does not match the owner'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000002',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.feedback_images (
        user_id,
        bucket_id,
        object_path,
        feedback_id
      )
      values (
        '00000000-0000-0000-0000-000000000002',
        'feedback-uploads',
        '00000000-0000-0000-0000-000000000002/40000000-0000-0000-0000-000000000005.png',
        '20000000-0000-0000-0000-000000000001'
      )$$
  ),
  '42501',
  'another user cannot attach image metadata to someone else''s feedback'
);

select is(
  (
    select count(*)
    from public.feedback_images
  ),
  2::bigint,
  'authenticated users can read attachment metadata for authenticated-visible feedback'
);

select is(
  (
    select count(*)
    from storage.objects
    where bucket_id = 'feedback-uploads'
  ),
  2::bigint,
  'authenticated users can read referenced private feedback upload objects'
);

with deleted as (
  delete from storage.objects
  where bucket_id = 'feedback-uploads'
    and name = '00000000-0000-0000-0000-000000000001/40000000-0000-0000-0000-000000000001.png'
  returning id
)
select is(
  (select count(*) from deleted),
  0::bigint,
  'a nonowner cannot delete another user''s feedback upload object'
);

reset role;

select ok(
  (
    select not public
      and file_size_limit = 5242880
      and allowed_mime_types = array[
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif'
      ]::text[]
    from storage.buckets
    where id = 'feedback-uploads'
  ),
  'the feedback upload bucket is private and restricted to the approved image MIME types'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_push_notification_event(uuid,uuid,text,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'service_role',
      'public.complete_push_notification_event(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.claim_push_notification_event(uuid,uuid,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_push_notification_event(uuid,text)',
      'EXECUTE'
    ),
  'only the service role can execute the push event state RPCs'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000001',
  'authenticated'
);
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )$$
  ),
  '42501',
  'authenticated callers cannot claim push notification events'
);

reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select tests.set_auth_context(null, 'anon');
set local role anon;

select is(
  tests.capture_sqlstate(
    $$select public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )$$
  ),
  '42501',
  'anon callers cannot claim push notification events'
);

reset role;

select set_config('request.jwt.claims', '{}'::text, true);

select is(
  tests.capture_sqlstate(
    $$select public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000011',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )$$
  ),
  '42501',
  'owner-context calls without a service-role JWT are rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.complete_push_notification_event(
      '50000000-0000-0000-0000-000000000001',
      'delivered'
    )$$
  ),
  '42501',
  'owner-context calls without a service-role JWT cannot complete push events'
);

reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000004","role":"service_role"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000004',
  'service_role'
);
set local role service_role;

select is(
  (
    select status
    from public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )
  ),
  'claimed',
  'the first unseen push event is claimed'
);

select is(
  (
    select status
    from public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )
  ),
  'duplicate',
  'replaying the same push event id is treated as a duplicate'
);

select is(
  (
    select status
    from public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )
  ),
  'cooldown',
  'a second unseen event inside the cooldown window is suppressed'
);

reset role;

select ok(
  (
    select completed_at is not null
      and outcome = 'suppressed_cooldown'
    from private.push_notification_events
    where event_id = '50000000-0000-0000-0000-000000000002'
  ),
  'cooldown-suppressed events are recorded immediately with a completion outcome'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000004","role":"service_role"}',
  true
);
select tests.set_auth_context(
  '00000000-0000-0000-0000-000000000004',
  'service_role'
);
set local role service_role;

select is(
  (
    select status
    from public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000001',
      'profile_status_studying',
      60
    )
  ),
  'duplicate',
  'replaying a suppressed event id stays duplicate forever'
);

select is(
  (
    select status
    from public.claim_push_notification_event(
      '50000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000001',
      'different_event_kind',
      60
    )
  ),
  'claimed',
  'the cooldown lock is scoped per user and event kind'
);

select is(
  tests.capture_sqlstate(
    $$select public.complete_push_notification_event(
      '50000000-0000-0000-0000-000000000001',
      'delivered'
    )$$
  ),
  null::text,
  'the service role can mark a claimed push event as delivered'
);

reset role;

select ok(
  (
    select completed_at is not null
      and outcome = 'delivered'
    from private.push_notification_events
    where event_id = '50000000-0000-0000-0000-000000000001'
  ),
  'completing a push event persists the outcome and completion timestamp'
);

select is(
  tests.capture_sqlstate(
    $$select public.complete_push_notification_event(
      '50000000-0000-0000-0000-000000000003',
      'unsupported_outcome'
    )$$
  ),
  '22023',
  'push event completion rejects unsupported outcomes'
);

select * from finish();
rollback;
