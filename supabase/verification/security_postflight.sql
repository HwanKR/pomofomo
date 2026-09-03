-- Read-only post-deployment assertions. Every returned row must be true.
-- Runtime-only checks for Vault, Edge secrets/deployment, Vercel, pg_cron,
-- and browser push are intentionally kept in the operations runbook.

with expected_authenticated_functions(signature) as (
  values
    ('public.accept_friend_request(uuid)'),
    ('public.reject_friend_request(uuid)'),
    ('public.cancel_friend_request(uuid)'),
    ('public.create_group(text)'),
    ('public.delete_friend(uuid)'),
    ('public.delete_group(uuid)'),
    ('public.feedback_image_path_matches_user(uuid,text)'),
    ('public.get_group_invite_code(uuid)'),
    ('public.get_admin_dashboard_stats(timestamp with time zone)'),
    ('public.get_admin_user_study_summary(uuid)'),
    ('public.get_friends_study_time(uuid,text)'),
    ('public.get_friends_study_time(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.get_group_study_time_v3(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.is_admin()'),
    ('public.is_group_member(uuid)'),
    ('public.is_group_leader(uuid)'),
    ('public.is_safe_push_endpoint(text)'),
    ('public.join_group_by_code(text)'),
    ('public.record_study_session_batch(uuid,text,text,uuid,jsonb)'),
    ('public.send_friend_request(text)'),
    ('public.transfer_group_leadership(uuid,uuid)')
),
expected_service_role_functions(signature) as (
  values
    ('public.claim_push_notification_event(uuid,uuid,text,integer)'),
    ('public.complete_push_notification_event(uuid,text)'),
    ('public.feedback_image_path_matches_user(uuid,text)'),
    ('public.is_safe_push_endpoint(text)')
),
checks(check_name, passed) as (
  values
    (
      'profiles table-wide UPDATE revoked from authenticated',
      not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    ),
    (
      'profiles.role UPDATE revoked from authenticated',
      not has_column_privilege(
        'authenticated',
        'public.profiles',
        'role',
        'UPDATE'
      )
    ),
    (
      'profiles.email UPDATE revoked from authenticated',
      not has_column_privilege(
        'authenticated',
        'public.profiles',
        'email',
        'UPDATE'
      )
    ),
    (
      'allowed profile status UPDATE remains available',
      has_column_privilege(
        'authenticated',
        'public.profiles',
        'status',
        'UPDATE'
      )
    ),
    (
      'protected profile trigger is installed',
      exists (
        select 1
        from pg_catalog.pg_trigger as t
        where t.tgrelid = 'public.profiles'::regclass
          and t.tgname = 'guard_profile_protected_columns'
          and not t.tgisinternal
      )
    ),
    (
      'subtask completion sync trigger is installed',
      -- The isolated legacy security harness intentionally has no tasks table
      -- and does not apply this feature migration. Skip there, but enforce the
      -- trigger whenever the production table is present.
      to_regclass('public.tasks') is null
        or exists (
          select 1
          from pg_catalog.pg_trigger as t
          where t.tgrelid = to_regclass('public.tasks')
            and t.tgname = 'sync_subtask_completion_on_task_status'
            and not t.tgisinternal
        )
    ),
    (
      'long-term task tables are unavailable to anonymous roles',
      to_regclass('public.long_term_tasks') is null
        or (
          not exists (
            select 1
            from information_schema.role_table_grants as grants
            where grants.table_schema = 'public'
              and grants.table_name in (
                'long_term_tasks',
                'long_term_subtasks'
              )
              and grants.grantee in ('PUBLIC', 'anon')
          )
        )
    ),
    (
      'long-term task tables expose authenticated CRUD only',
      to_regclass('public.long_term_tasks') is null
        or (
          has_table_privilege(
            'authenticated', 'public.long_term_tasks', 'SELECT'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_tasks', 'INSERT'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_tasks', 'UPDATE'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_tasks', 'DELETE'
          )
          and not has_table_privilege(
            'authenticated', 'public.long_term_tasks', 'TRUNCATE'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_subtasks', 'SELECT'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_subtasks', 'INSERT'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_subtasks', 'UPDATE'
          )
          and has_table_privilege(
            'authenticated', 'public.long_term_subtasks', 'DELETE'
          )
          and not has_table_privilege(
            'authenticated', 'public.long_term_subtasks', 'TRUNCATE'
          )
        )
    ),
    (
      'profile self-update policy has USING and WITH CHECK',
      exists (
        select 1
        from pg_catalog.pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = 'profiles'
          and p.policyname = 'Users can update own profile'
          and p.cmd = 'UPDATE'
          and 'authenticated' = any(p.roles)
          and p.qual is not null
          and p.with_check is not null
      )
    ),
    (
      'debug logs are unavailable to anon',
      not has_table_privilege('anon', 'public.debug_logs', 'SELECT')
        and not has_table_privilege('anon', 'public.debug_logs', 'INSERT')
    ),
    (
      'debug logs are unavailable to authenticated',
      not has_table_privilege('authenticated', 'public.debug_logs', 'SELECT')
        and not has_table_privilege('authenticated', 'public.debug_logs', 'INSERT')
    ),
    (
      'debug logs service role is insert-only',
      has_table_privilege('service_role', 'public.debug_logs', 'INSERT')
        and not has_table_privilege('service_role', 'public.debug_logs', 'SELECT')
        and not has_table_privilege('service_role', 'public.debug_logs', 'UPDATE')
        and not has_table_privilege('service_role', 'public.debug_logs', 'DELETE')
    ),
    (
      'debug logs have no client-facing policies',
      not exists (
        select 1
        from pg_catalog.pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = 'debug_logs'
      )
    ),
    (
      'direct friendship INSERT is revoked',
      not has_table_privilege('authenticated', 'public.friendships', 'INSERT')
    ),
    (
      'friendship identity columns cannot be updated',
      not has_column_privilege(
        'authenticated',
        'public.friendships',
        'friend_id',
        'UPDATE'
      )
    ),
    (
      'direct friend request writes are revoked from authenticated',
      not has_table_privilege('authenticated', 'public.friend_requests', 'INSERT')
        and not has_table_privilege(
          'authenticated',
          'public.friend_requests',
          'UPDATE'
        )
        and not has_table_privilege(
          'authenticated',
          'public.friend_requests',
          'DELETE'
        )
    ),
    (
      'friend request reads remain available to authenticated',
      has_table_privilege('authenticated', 'public.friend_requests', 'SELECT')
    ),
    (
      'friend_requests exposes no direct write RLS policy',
      not exists (
        select 1
        from pg_catalog.pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = 'friend_requests'
          and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      )
    ),
    (
      'direct study session INSERT is revoked from browser roles',
      not has_table_privilege('authenticated', 'public.study_sessions', 'INSERT')
        and not has_table_privilege('anon', 'public.study_sessions', 'INSERT')
    ),
    (
      'study session sensitive columns cannot be updated directly',
      not has_table_privilege('authenticated', 'public.study_sessions', 'UPDATE')
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'duration', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'created_at', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'mode', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'user_id', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'session_batch_id', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'segment_index', 'UPDATE'
        )
        and not has_column_privilege(
          'authenticated', 'public.study_sessions', 'recorded_at', 'UPDATE'
        )
    ),
    (
      'study session task-memo UPDATE and own-record DELETE remain available',
      has_column_privilege('authenticated', 'public.study_sessions', 'task', 'UPDATE')
        and has_table_privilege('authenticated', 'public.study_sessions', 'DELETE')
    ),
    (
      'study_sessions exposes no INSERT/ALL RLS policy',
      not exists (
        select 1
        from pg_catalog.pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = 'study_sessions'
          and p.cmd in ('INSERT', 'ALL')
      )
    ),
    (
      'study_sessions UPDATE policy has USING and WITH CHECK',
      exists (
        select 1
        from pg_catalog.pg_policies as p
        where p.schemaname = 'public'
          and p.tablename = 'study_sessions'
          and p.policyname = 'Users can update their own study sessions'
          and p.cmd = 'UPDATE'
          and 'authenticated' = any(p.roles)
          and p.qual is not null
          and p.with_check is not null
      )
    ),
    (
      'study session batch idempotency table stays private to RPCs',
      to_regclass('private.study_session_batches') is not null
        and not has_table_privilege('anon', 'private.study_session_batches', 'SELECT')
        and not has_table_privilege(
          'authenticated', 'private.study_session_batches', 'SELECT'
        )
        and not has_table_privilege(
          'service_role', 'private.study_session_batches', 'SELECT'
        )
        and not has_table_privilege(
          'service_role', 'private.study_session_batches', 'INSERT'
        )
    ),
    (
      'study session segment backstop index is unique',
      exists (
        select 1
        from pg_catalog.pg_class as c
        join pg_catalog.pg_index as i
          on i.indexrelid = c.oid
        where c.relname = 'study_sessions_user_batch_segment_key'
          and i.indrelid = 'public.study_sessions'::regclass
          and i.indisunique
      )
    ),
    (
      'study session integrity CHECK constraints are installed',
      (
        select count(*)
        from pg_catalog.pg_constraint as c
        where c.conrelid = 'public.study_sessions'::regclass
          and c.conname in (
            'study_sessions_rpc_row_shape_chk',
            'study_sessions_task_length_chk'
          )
      ) = 2
    ),
    (
      'groups.code SELECT is revoked from authenticated',
      not has_column_privilege(
        'authenticated',
        'public.groups',
        'code',
        'SELECT'
      )
    ),
    (
      'group members keep non-sensitive group SELECT access',
      has_column_privilege('authenticated', 'public.groups', 'name', 'SELECT')
        and has_column_privilege(
          'authenticated',
          'public.groups',
          'created_at',
          'SELECT'
        )
    ),
    (
      'direct group membership INSERT is revoked',
      not has_table_privilege('authenticated', 'public.group_members', 'INSERT')
    ),
    (
      'group nickname-only UPDATE remains available',
      has_column_privilege(
        'authenticated',
        'public.group_members',
        'nickname',
        'UPDATE'
      )
        and not has_column_privilege(
          'authenticated',
          'public.group_members',
          'user_id',
          'UPDATE'
        )
    ),
    (
      'push subscription table-wide UPDATE is revoked',
      not has_table_privilege(
        'authenticated',
        'public.push_subscriptions',
        'UPDATE'
      )
    ),
    (
      'push subscription key UPDATE remains available',
      has_column_privilege(
        'authenticated',
        'public.push_subscriptions',
        'keys',
        'UPDATE'
      )
    ),
    (
      'push subscription safe-endpoint constraint exists',
      exists (
        select 1
        from pg_catalog.pg_constraint as c
        where c.conrelid = 'public.push_subscriptions'::regclass
          and c.conname = 'push_subscriptions_safe_endpoint_check'
      )
    ),
    (
      'push subscription guard trigger is installed',
      exists (
        select 1
        from pg_catalog.pg_trigger as t
        where t.tgrelid = 'public.push_subscriptions'::regclass
          and t.tgname = 'guard_push_subscription_identity'
          and not t.tgisinternal
      )
    ),
    (
      'public cleanup function is removed',
      to_regprocedure('public.delete_unconfirmed_users()') is null
    ),
    (
      'private cleanup function exists',
      to_regprocedure('private.delete_unconfirmed_users()') is not null
    ),
    (
      'private cleanup cannot be called by clients or service role',
      not coalesce(
        has_function_privilege(
          'anon',
          to_regprocedure('private.delete_unconfirmed_users()'),
          'EXECUTE'
        ),
        false
      )
        and not coalesce(
          has_function_privilege(
            'authenticated',
            to_regprocedure('private.delete_unconfirmed_users()'),
            'EXECUTE'
          ),
          false
        )
        and not coalesce(
          has_function_privilege(
            'service_role',
            to_regprocedure('private.delete_unconfirmed_users()'),
            'EXECUTE'
          ),
          false
        )
    ),
    (
      'private schema is unavailable to browser roles',
      not has_schema_privilege('anon', 'private', 'USAGE')
        and not has_schema_privilege('authenticated', 'private', 'USAGE')
    ),
    (
      'obsolete RPCs are removed',
      to_regprocedure('public.add_friend(uuid)') is null
        and to_regprocedure('public.get_user_id_by_email(text)') is null
        and to_regprocedure('public.get_group_study_time(uuid,text)') is null
        and to_regprocedure('public.get_group_study_time_v2(text,uuid)') is null
        and to_regprocedure('public.get_group_study_time_v2(uuid,text)') is null
    ),
    (
      'anon can execute no application functions',
      not exists (
        select 1
        from pg_catalog.pg_proc as p
        join pg_catalog.pg_namespace as n
          on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prokind = 'f'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
      )
    ),
    (
      'service role function allowlist is exact',
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
          from pg_catalog.pg_proc as p
          join pg_catalog.pg_namespace as n
            on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and p.prokind = 'f'
            and has_function_privilege('service_role', p.oid, 'EXECUTE')
        ) = (select count(*) from expected_service_role_functions)
    ),
    (
      'authenticated function allowlist is exact',
      not exists (
        select 1
        from expected_authenticated_functions as expected
        where to_regprocedure(expected.signature) is null
          or not has_function_privilege(
            'authenticated',
            to_regprocedure(expected.signature),
            'EXECUTE'
          )
      )
        and (
          select count(*)
          from pg_catalog.pg_proc as p
          join pg_catalog.pg_namespace as n
            on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
            and p.prokind = 'f'
            and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        ) = (select count(*) from expected_authenticated_functions)
    ),
    (
      'feedback image metadata table exists and rejects browser UPDATE',
      to_regclass('public.feedback_images') is not null
        and not has_table_privilege('authenticated', 'public.feedback_images', 'UPDATE')
        and has_table_privilege('authenticated', 'public.feedback_images', 'SELECT')
    ),
    (
      'legacy feedback image arrays are readable but not writable',
      has_column_privilege('authenticated', 'public.feedbacks', 'images', 'SELECT')
        and not has_column_privilege(
          'authenticated',
          'public.feedbacks',
          'images',
          'UPDATE'
        )
        and not has_column_privilege(
          'authenticated',
          'public.feedback_replies',
          'images',
          'UPDATE'
        )
    ),
    (
      'feedback upload bucket is private and size/mime restricted',
      exists (
        select 1
        from storage.buckets as b
        where b.id = 'feedback-uploads'
          and not b.public
          and b.file_size_limit = 5242880
          and b.allowed_mime_types = array[
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif'
          ]::text[]
      )
    ),
    (
      'feedback upload storage policies are present',
      (
        select count(*)
        from pg_catalog.pg_policies as p
        where p.schemaname = 'storage'
          and p.tablename = 'objects'
          and p.policyname in (
            'Feedback uploads owner select',
            'Feedback uploads owner insert',
            'Feedback uploads owner update',
            'Feedback uploads owner delete'
          )
      ) = 4
    ),
    (
      'push notification events stay private to RPCs',
      to_regclass('private.push_notification_events') is not null
        and not has_table_privilege('anon', 'private.push_notification_events', 'SELECT')
        and not has_table_privilege(
          'authenticated',
          'private.push_notification_events',
          'SELECT'
        )
        and not has_table_privilege(
          'service_role',
          'private.push_notification_events',
          'SELECT'
        )
    ),
    (
      'all application SECURITY DEFINER functions have empty search_path',
      not exists (
        select 1
        from pg_catalog.pg_proc as p
        join pg_catalog.pg_namespace as n
          on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prokind = 'f'
          and p.prosecdef
          and not (
            'search_path=""' = any(
              coalesce(p.proconfig, array[]::text[])
            )
          )
      )
    ),
    (
      'postgres future functions have no broad default EXECUTE',
      exists (
        select 1
        from pg_catalog.pg_default_acl as d
        join pg_catalog.pg_roles as r
          on r.oid = d.defaclrole
        where r.rolname = 'postgres'
          and d.defaclobjtype = 'f'
          and d.defaclnamespace = 0
          and not exists (
            select 1
            from aclexplode(d.defaclacl) as acl
            where acl.privilege_type = 'EXECUTE'
              and (
                acl.grantee = 0
                or acl.grantee in (
                  select roles.oid
                  from pg_catalog.pg_roles as roles
                  where roles.rolname in (
                    'anon',
                    'authenticated',
                    'service_role'
                  )
                )
              )
          )
      )
    ),
    (
      'friendship direction uniqueness is enforced',
      exists (
        select 1
        from pg_catalog.pg_constraint as c
        where c.conrelid = 'public.friendships'::regclass
          and c.contype = 'u'
          and c.conkey = array[
            (
              select a.attnum
              from pg_catalog.pg_attribute as a
              where a.attrelid = 'public.friendships'::regclass
                and a.attname = 'user_id'
            ),
            (
              select a.attnum
              from pg_catalog.pg_attribute as a
              where a.attrelid = 'public.friendships'::regclass
                and a.attname = 'friend_id'
            )
          ]::smallint[]
      )
    ),
    (
      'friend request direction uniqueness is enforced',
      exists (
        select 1
        from pg_catalog.pg_constraint as c
        where c.conrelid = 'public.friend_requests'::regclass
          and c.contype = 'u'
          and c.conkey = array[
            (
              select a.attnum
              from pg_catalog.pg_attribute as a
              where a.attrelid = 'public.friend_requests'::regclass
                and a.attname = 'sender_id'
            ),
            (
              select a.attnum
              from pg_catalog.pg_attribute as a
              where a.attrelid = 'public.friend_requests'::regclass
                and a.attname = 'receiver_id'
            )
          ]::smallint[]
      )
    ),
    (
      'exactly one Vault-backed profile webhook trigger is installed',
      (
        select count(*)
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
          and pn.nspname = 'private'
          and p.proname = 'enqueue_profile_status_webhook'
      ) = 1
    )
)
select
  check_name,
  passed,
  1 / case
    when bool_and(passed) over () then 1
    else 0
  end as all_checks_passed
from checks
order by check_name;
