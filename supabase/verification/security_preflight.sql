-- Read-only production inventory. This intentionally returns no email,
-- credential, webhook body, push endpoint, or function source values.

with friendship_duplicates as (
  select count(*) as row_count
  from public.friendships
  group by user_id, friend_id
  having count(*) > 1
),
friend_request_duplicates as (
  select count(*) as row_count
  from public.friend_requests
  group by sender_id, receiver_id
  having count(*) > 1
),
group_member_duplicates as (
  select count(*) as row_count
  from public.group_members
  group by group_id, user_id
  having count(*) > 1
),
study_session_inventory as (
  -- study_sessions 무결성 제약(20260808130000) 적용 전 기존 위반 데이터 탐지.
  -- 여기 잡힌 행은 자동 보정하지 않는다: 수량을 확인한 뒤 개별 판단한다.
  -- task_over_limit_rows가 0이면 다음을 실행해 NOT VALID 제약을 검증한다:
  --   alter table public.study_sessions
  --     validate constraint study_sessions_task_length_chk;
  select
    count(*) filter (where ss.duration is null) as duration_null_rows,
    count(*) filter (where ss.duration < 10) as duration_below_min_rows,
    count(*) filter (where ss.duration >= 86400) as duration_above_max_rows,
    count(*) filter (
      where ss.mode is null or ss.mode not in ('pomo', 'stopwatch')
    ) as unexpected_mode_rows,
    count(*) filter (
      where ss.task is not null and char_length(ss.task) > 200
    ) as task_over_limit_rows,
    count(*) filter (
      where ss.created_at > now() + interval '15 minutes'
    ) as future_created_at_rows
  from public.study_sessions as ss
),
study_session_duplicate_segments as (
  -- 과거 check-then-insert 경쟁으로 이미 중복 저장된 batch 추정치:
  -- 같은 (user, batch, created_at, duration) 조합이 두 번 이상 존재하면
  -- 사실상 같은 segment의 복제본이다.
  select count(*) as duplicate_groups
  from (
    select 1
    from public.study_sessions as ss
    -- The preflight also runs before the migration that adds session_batch_id.
    -- Row JSON keeps this inventory readable on both schema versions.
    where to_jsonb(ss) ->> 'session_batch_id' is not null
    group by ss.user_id, to_jsonb(ss) ->> 'session_batch_id', ss.created_at, ss.duration
    having count(*) > 1
  ) as d
),
push_endpoint_inventory as (
  select
    lower(
      substring(ps.endpoint from '^https://(\[[^]]+\]|[^/:?#]+)')
    ) as endpoint_host,
    count(*)::integer as endpoint_count
  from public.push_subscriptions as ps
  group by 1
),
function_inventory as (
  select
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments,
    p.prosecdef as security_definer,
    coalesce(array_to_string(p.proconfig, ','), '') as configuration,
    has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE')
      as authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE')
      as service_role_execute
  from pg_catalog.pg_proc as p
  join pg_catalog.pg_namespace as n
    on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prokind = 'f'
),
routine_privilege_inventory as (
  select
    rp.routine_schema,
    rp.routine_name,
    rp.specific_name,
    array_agg(rp.grantee order by rp.grantee) as execute_grantees
  from information_schema.routine_privileges as rp
  where rp.routine_schema in ('public', 'private')
    and rp.privilege_type = 'EXECUTE'
  group by rp.routine_schema, rp.routine_name, rp.specific_name
),
trigger_inventory as (
  select
    t.tgname as trigger_name,
    pn.nspname as function_schema,
    p.proname as function_name
  from pg_catalog.pg_trigger as t
  join pg_catalog.pg_class as c
    on c.oid = t.tgrelid
  join pg_catalog.pg_namespace as cn
    on cn.oid = c.relnamespace
  join pg_catalog.pg_proc as p
    on p.oid = t.tgfoid
  join pg_catalog.pg_namespace as pn
    on pn.oid = p.pronamespace
  where not t.tgisinternal
    and cn.nspname = 'public'
    and c.relname = 'profiles'
)
select
  jsonb_build_object(
    'friendship_duplicate_groups',
    (select count(*)::integer from friendship_duplicates),
    'friendship_rows_to_remove',
    (
      select coalesce(sum(row_count - 1), 0)::integer
      from friendship_duplicates
    ),
    'friend_request_duplicate_groups',
    (select count(*)::integer from friend_request_duplicates),
    'friend_request_rows_to_remove',
    (
      select coalesce(sum(row_count - 1), 0)::integer
      from friend_request_duplicates
    ),
    'group_member_duplicate_groups',
    (select count(*)::integer from group_member_duplicates),
    'group_member_rows_to_remove',
    (
      select coalesce(sum(row_count - 1), 0)::integer
      from group_member_duplicates
    )
  ) as duplicate_summary,
  jsonb_build_object(
    'authenticated_profiles_table_update',
    has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
    'authenticated_profiles_role_update',
    has_column_privilege(
      'authenticated',
      'public.profiles',
      'role',
      'UPDATE'
    ),
    'authenticated_profiles_status_update',
    has_column_privilege(
      'authenticated',
      'public.profiles',
      'status',
      'UPDATE'
    ),
    'authenticated_groups_code_select',
    has_column_privilege(
      'authenticated',
      'public.groups',
      'code',
      'SELECT'
    ),
    'authenticated_group_members_insert',
    has_table_privilege(
      'authenticated',
      'public.group_members',
      'INSERT'
    ),
    'authenticated_feedback_images_update',
    case
      when to_regclass('public.feedback_images') is null then null
      else has_table_privilege(
        'authenticated',
        'public.feedback_images',
        'UPDATE'
      )
    end,
    'anon_debug_logs_select',
    has_table_privilege('anon', 'public.debug_logs', 'SELECT'),
    'authenticated_debug_logs_select',
    has_table_privilege('authenticated', 'public.debug_logs', 'SELECT'),
    'authenticated_friend_requests_insert',
    has_table_privilege('authenticated', 'public.friend_requests', 'INSERT'),
    'authenticated_friend_requests_update',
    has_table_privilege('authenticated', 'public.friend_requests', 'UPDATE'),
    'authenticated_friend_requests_delete',
    has_table_privilege('authenticated', 'public.friend_requests', 'DELETE'),
    'authenticated_friend_requests_select',
    has_table_privilege('authenticated', 'public.friend_requests', 'SELECT')
  ) as privilege_summary,
  (
    select
      to_jsonb(ssi) || jsonb_build_object(
        'duplicate_segment_groups',
        (select d.duplicate_groups from study_session_duplicate_segments as d)
      )
    from study_session_inventory as ssi
  ) as study_session_summary,
  jsonb_build_object(
    'feedback_upload_bucket_exists',
    exists (
      select 1
      from storage.buckets as b
      where b.id = 'feedback-uploads'
    ),
    'feedback_upload_bucket_is_public',
    coalesce(
      (
        select b.public
        from storage.buckets as b
        where b.id = 'feedback-uploads'
        limit 1
      ),
      null
    ),
    'feedback_upload_object_rows',
    case
      when to_regclass('storage.objects') is null then null
      else (
        select count(*)::integer
        from storage.objects as o
        where o.bucket_id = 'feedback-uploads'
      )
    end
  ) as storage_summary,
  (
    select jsonb_agg(
      to_jsonb(pei)
      order by pei.endpoint_host
    )
    from push_endpoint_inventory as pei
  ) as push_endpoint_hosts,
  (
    select jsonb_agg(
      to_jsonb(fi)
      order by fi.schema_name, fi.function_name, fi.arguments
    )
    from function_inventory as fi
  ) as functions,
  (
    select jsonb_agg(
      to_jsonb(rpi)
      order by rpi.routine_schema, rpi.routine_name, rpi.specific_name
    )
    from routine_privilege_inventory as rpi
  ) as routine_privileges,
  (
    select jsonb_agg(
      to_jsonb(ti)
      order by ti.trigger_name
    )
    from trigger_inventory as ti
  ) as profile_triggers;
