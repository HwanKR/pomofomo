-- study_sessions 기록 경로 보안 테스트.
--
-- 검증 대상: 20260808130000_lock_study_sessions_writes_and_batch_rpc.sql
--          + 20260808150000_batch_rpc_accept_plan_task_ids.sql
--   * record_study_session_batch RPC의 멱등성 계약
--     (같은 키+같은 payload = already_processed, 같은 키+다른 payload = 23505,
--      일부 segment 무효 = 전체 롤백)
--   * 브라우저 롤의 직접 INSERT/민감 열 UPDATE 봉쇄와 task 메모 수정/삭제 UX 유지
--   * duration/mode/task/시각 창/task_id 소유 검증
--   * 재시도가 친구/그룹 통계 합계를 부풀리지 못함
--
-- 동시성(두 세션이 같은 batch를 동시에 호출) 검증은 단일 세션인 pgTAP으로
-- 불가능하므로 별도 2-세션 psql 하니스로 수행한다.

begin;

set local search_path = extensions, public, pg_catalog;
select plan(88);

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

-- RPC가 기대하는 canonical 형태의 ended_at 문자열.
create function tests.iso(ts timestamptz)
returns text
language sql
set search_path = ''
as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

grant execute on function tests.iso(timestamptz)
to anon, authenticated, service_role;

-- 고정 payload 저장소: 재시도 테스트에서 완전히 같은 payload를 재전송하기 위함.
create table tests.payloads (
  name text primary key,
  segments jsonb not null
);

grant select on table tests.payloads to anon, authenticated, service_role;

insert into auth.users (
  id, email, created_at, confirmed_at, raw_app_meta_data, raw_user_meta_data
)
values
  ('00000000-0000-0000-0000-0000000000a1', 'batch-a@example.invalid', now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-0000000000b2', 'batch-b@example.invalid', now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-0000000000c3', 'batch-c@example.invalid', now(), now(), '{}', '{}');

insert into public.profiles (id, email, role, nickname)
values
  ('00000000-0000-0000-0000-0000000000a1', 'batch-a@example.invalid', 'user', 'Batch A'),
  ('00000000-0000-0000-0000-0000000000b2', 'batch-b@example.invalid', 'user', 'Batch B'),
  ('00000000-0000-0000-0000-0000000000c3', 'batch-c@example.invalid', 'user', 'Batch C');

-- A와 B는 친구, 같은 그룹의 멤버다(통계 불변성 테스트용).
insert into public.friendships (user_id, friend_id)
values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1');

insert into public.groups (id, name, code, leader_id)
values (
  '10000000-0000-0000-0000-0000000000d4',
  'Batch Group',
  'BATCH1',
  '00000000-0000-0000-0000-0000000000a1'
);

insert into public.group_members (group_id, user_id)
values
  ('10000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1'),
  ('10000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000b2');

insert into public.tasks (id, user_id, title)
values
  ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A의 작업'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B의 작업');

-- 타이머는 weekly_plans/monthly_plans의 행도 작업으로 선택할 수 있다
-- (20260808150000이 이 두 테이블도 task_id 소유 검증에 포함한다).
insert into public.weekly_plans (id, user_id, title, start_date, end_date)
values
  ('21000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A의 주간 계획', current_date, current_date),
  ('21000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B의 주간 계획', current_date, current_date);

insert into public.monthly_plans (id, user_id, title, month, year)
values
  ('22000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A의 월간 계획', extract(month from current_date), extract(year from current_date)),
  ('22000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B의 월간 계획', extract(month from current_date), extract(year from current_date));

-- ---------------------------------------------------------------------------
-- 1. 정적 권한 표면: 직접 쓰기 봉쇄와 task/삭제 UX 유지. (22)
-- ---------------------------------------------------------------------------

select is(
  has_table_privilege('authenticated', 'public.study_sessions', 'INSERT'),
  false,
  'authenticated cannot INSERT study_sessions directly'
);

select is(
  has_table_privilege('anon', 'public.study_sessions', 'INSERT'),
  false,
  'anon cannot INSERT study_sessions directly'
);

select is(
  has_table_privilege('authenticated', 'public.study_sessions', 'UPDATE'),
  false,
  'authenticated has no table-wide study_sessions UPDATE privilege'
);

select ok(
  has_column_privilege('authenticated', 'public.study_sessions', 'task', 'UPDATE'),
  'authenticated keeps the task-memo UPDATE column privilege (HistoryList UX)'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'duration', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.duration'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'created_at', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.created_at'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'mode', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.mode'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'user_id', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.user_id'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'session_batch_id', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.session_batch_id'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'segment_index', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.segment_index'
);

select is(
  has_column_privilege('authenticated', 'public.study_sessions', 'recorded_at', 'UPDATE'),
  false,
  'authenticated cannot UPDATE study_sessions.recorded_at'
);

select ok(
  has_table_privilege('authenticated', 'public.study_sessions', 'DELETE'),
  'authenticated keeps the own-record DELETE privilege (HistoryList UX)'
);

select is(
  has_table_privilege('anon', 'public.study_sessions', 'DELETE'),
  false,
  'anon cannot DELETE study_sessions'
);

select is(
  (
    select count(*)::integer
    from pg_policies as p
    where p.schemaname = 'public'
      and p.tablename = 'study_sessions'
      and p.cmd in ('INSERT', 'ALL')
  ),
  0,
  'no INSERT/ALL policy remains on study_sessions'
);

select ok(
  (
    select p.with_check is not null
    from pg_policies as p
    where p.schemaname = 'public'
      and p.tablename = 'study_sessions'
      and p.cmd = 'UPDATE'
      and p.policyname = 'Users can update their own study sessions'
  ),
  'the study_sessions UPDATE policy carries a WITH CHECK clause'
);

select is(
  has_function_privilege(
    'anon',
    'public.record_study_session_batch(uuid, text, text, uuid, jsonb)',
    'EXECUTE'
  ),
  false,
  'anon cannot execute record_study_session_batch'
);

select is(
  has_function_privilege(
    'service_role',
    'public.record_study_session_batch(uuid, text, text, uuid, jsonb)',
    'EXECUTE'
  ),
  false,
  'service_role does not execute record_study_session_batch'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.record_study_session_batch(uuid, text, text, uuid, jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute record_study_session_batch'
);

select is(
  (
    select count(*)::integer
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'record_study_session_batch'
  ),
  1,
  'record_study_session_batch has exactly one overload'
);

select is(
  has_schema_privilege('authenticated', 'private', 'USAGE'),
  false,
  'authenticated has no USAGE on the private schema (idempotency table unreachable)'
);

select is(
  has_table_privilege('authenticated', 'private.study_session_batches', 'SELECT'),
  false,
  'authenticated cannot read the idempotency table'
);

select is(
  has_table_privilege('service_role', 'private.study_session_batches', 'INSERT'),
  false,
  'service_role cannot write the idempotency table'
);

-- ---------------------------------------------------------------------------
-- 2. 인증 사용자 A의 정상 기록과 멱등성 계약. (12)
-- ---------------------------------------------------------------------------

-- 재시도 시 완전히 같은 payload를 보내기 위해 segment jsonb를 고정한다.
insert into tests.payloads (name, segments)
values
  (
    'pomo_single',
    jsonb_build_array(
      jsonb_build_object(
        'index', 0,
        'duration', 1500,
        'ended_at', tests.iso(now() - interval '30 minutes')
      )
    )
  ),
  (
    'stopwatch_split',
    -- 05:00 공부일 경계 분할을 재현: 전날 경계 직전(-1ms)에 끝나는 조각과
    -- 경계 정각에 시작하는 조각이 한 batch로 저장된다. (전날 경계를 앵커로
    -- 삼아 테스트 실행 시각과 무관하게 항상 과거가 되도록 한다.)
    jsonb_build_array(
      jsonb_build_object(
        'index', 0,
        'duration', 3600,
        'ended_at', tests.iso(
          date_trunc('day', now() - interval '1 day') + interval '5 hours'
          - interval '1 millisecond'
        )
      ),
      jsonb_build_object(
        'index', 1,
        'duration', 1800,
        'ended_at', tests.iso(
          date_trunc('day', now() - interval '1 day') + interval '5 hours 30 minutes'
        )
      )
    )
  ),
  (
    'stats_probe',
    jsonb_build_array(
      jsonb_build_object(
        'index', 0,
        'duration', 999,
        'ended_at', tests.iso(now() - interval '20 minutes')
      )
    )
  );

select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

select is(
  (
    select public.record_study_session_batch(
      '30000000-0000-0000-0000-000000000001',
      'pomo',
      '  수학  ',
      '20000000-0000-0000-0000-0000000000a1',
      (select segments from tests.payloads where name = 'pomo_single')
    ) ->> 'status'
  ),
  'saved',
  'a normal pomo batch is saved'
);

select is(
  (
    select public.record_study_session_batch(
      '30000000-0000-0000-0000-000000000001',
      'pomo',
      '  수학  ',
      '20000000-0000-0000-0000-0000000000a1',
      (select segments from tests.payloads where name = 'pomo_single')
    ) ->> 'status'
  ),
  'already_processed',
  'replaying the same batch with the same payload reports already_processed'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '30000000-0000-0000-0000-000000000001',
      'pomo',
      '다른 작업',
      null,
      (select segments from tests.payloads where name = 'pomo_single'))$$
  ),
  '23505',
  'the same batch id with a different payload is rejected as a conflict'
);

select is(
  (
    select public.record_study_session_batch(
      '30000000-0000-0000-0000-000000000002',
      'stopwatch',
      null,
      null,
      (select segments from tests.payloads where name = 'stopwatch_split')
    ) ->> 'status'
  ),
  'saved',
  'a stopwatch batch split at the 05:00 study-day boundary is saved'
);

select is(
  (
    select count(*)::integer
    from public.study_sessions
    where session_batch_id = '30000000-0000-0000-0000-000000000002'
  ),
  2,
  'the split batch stores exactly one row per segment'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.study_sessions
    where session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  1,
  'sequential duplicate calls insert the pomo batch exactly once'
);

select is(
  (
    select sum(duration)::bigint
    from public.study_sessions
    where user_id = '00000000-0000-0000-0000-0000000000a1'
  ),
  (1500 + 3600 + 1800)::bigint,
  'the duration total counts every batch exactly once'
);

select is(
  (
    select array_agg(distinct ss.user_id)
    from public.study_sessions as ss
    where ss.session_batch_id in (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002'
    )
  ),
  array['00000000-0000-0000-0000-0000000000a1']::uuid[],
  'rows are owned by auth.uid(), not by any client-supplied identity'
);

select is(
  (
    select ss.task
    from public.study_sessions as ss
    where ss.session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  '수학',
  'task text is trimmed before storage'
);

select ok(
  (
    select bool_and(ss.recorded_at is not null)
    from public.study_sessions as ss
    where ss.session_batch_id in (
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002'
    )
  ),
  'the server stamps recorded_at on every RPC-written row'
);

select is(
  (
    select tests.iso(ss.created_at)
    from public.study_sessions as ss
    where ss.session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  (
    select p.segments -> 0 ->> 'ended_at'
    from tests.payloads as p
    where p.name = 'pomo_single'
  ),
  'created_at preserves the submitted interval end time (study-day semantics)'
);

select is(
  (
    select b.total_seconds
    from private.study_session_batches as b
    where b.batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  1500::bigint,
  'the idempotency table records the committed batch'
);

-- ---------------------------------------------------------------------------
-- 3. 검증 규칙: duration/mode/task/segment 구조/시각 창/task_id 소유. (29)
-- ---------------------------------------------------------------------------

select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000001', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 9,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'a 9-second segment is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000002', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 86400,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'a 24-hour segment is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000003', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', null,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'a NULL duration is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000004', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', -600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'a negative duration is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000005', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 9223372036854775807,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'an absurdly large bigint duration is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000006', 'focus', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'a mode outside pomo/stopwatch is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000007', 'pomo', repeat('가', 201), null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '22023',
  'an over-long task is rejected instead of silently truncated'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000008', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() + interval '16 minutes'))))$$
  ),
  '22023',
  'a segment ending beyond the allowed future clock skew is rejected'
);

select is(
  (
    select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000009',
      'pomo',
      null,
      null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() + interval '5 minutes')
      ))
    ) ->> 'status'
  ),
  'saved',
  'a segment within the future clock-skew allowance is accepted'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000a', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '401 days'))))$$
  ),
  '22023',
  'a segment older than the offline-recovery window is rejected'
);

select is(
  (
    select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000b',
      'stopwatch',
      null,
      null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '30 days')
      ))
    ) ->> 'status'
  ),
  'saved',
  'a weeks-old offline recovery batch is still accepted'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000c', 'pomo', null,
      '20000000-0000-0000-0000-0000000000b2',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '42501',
  'a task_id owned by another user is rejected'
);

select is(
  (
    select ss.task_id
    from public.study_sessions as ss
    where ss.session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  '20000000-0000-0000-0000-0000000000a1'::uuid,
  'an owned task_id is stored on the recorded rows'
);

select is(
  (
    select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000d',
      'pomo',
      '지워진 작업',
      '20000000-0000-0000-0000-00000000dead',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '4 minutes')
      ))
    ) ->> 'status'
  ),
  'saved',
  'a batch referencing a deleted task is saved (outbox recovery path)'
);

select is(
  (
    select ss.task_id
    from public.study_sessions as ss
    where ss.session_batch_id = '31000000-0000-0000-0000-00000000000d'
  ),
  null::uuid,
  'a nonexistent task_id is unlinked instead of failing the recovery'
);

-- weekly_plans/monthly_plans의 행도 tasks와 동일한 3-분기 소유 검증을 받는다.
select is(
  (
    select public.record_study_session_batch(
      '35000000-0000-0000-0000-000000000001',
      'pomo',
      'A의 주간 계획',
      '21000000-0000-0000-0000-0000000000a1',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '3 minutes')
      ))
    ) ->> 'status'
  ),
  'saved',
  'a batch linked to an owned weekly plan is saved'
);

select is(
  (
    select ss.task_id
    from public.study_sessions as ss
    where ss.session_batch_id = '35000000-0000-0000-0000-000000000001'
  ),
  '21000000-0000-0000-0000-0000000000a1'::uuid,
  'an owned weekly-plan task_id is stored on the recorded rows'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '35000000-0000-0000-0000-000000000002', 'pomo', null,
      '21000000-0000-0000-0000-0000000000b2',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '42501',
  'a weekly-plan task_id owned by another user is rejected'
);

select is(
  (
    select public.record_study_session_batch(
      '35000000-0000-0000-0000-000000000003',
      'stopwatch',
      'A의 월간 계획',
      '22000000-0000-0000-0000-0000000000a1',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '2 minutes')
      ))
    ) ->> 'status'
  ),
  'saved',
  'a batch linked to an owned monthly plan is saved'
);

select is(
  (
    select ss.task_id
    from public.study_sessions as ss
    where ss.session_batch_id = '35000000-0000-0000-0000-000000000003'
  ),
  '22000000-0000-0000-0000-0000000000a1'::uuid,
  'an owned monthly-plan task_id is stored on the recorded rows'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '35000000-0000-0000-0000-000000000004', 'pomo', null,
      '22000000-0000-0000-0000-0000000000b2',
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '42501',
  'a monthly-plan task_id owned by another user is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000e', 'pomo', null, null,
      '[]'::jsonb)$$
  ),
  '22023',
  'an empty segment list is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-00000000000f', 'pomo', null, null,
      (select jsonb_agg(jsonb_build_object(
        'index', g - 1, 'duration', 10,
        'ended_at', tests.iso(now() - interval '1 day' + make_interval(secs => g * 20))))
       from generate_series(1, 65) as g))$$
  ),
  '22023',
  'more segments than the batch limit are rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000010', 'stopwatch', null, null,
      (select jsonb_agg(jsonb_build_object(
        'index', g - 1, 'duration', 86399,
        'ended_at', tests.iso(now() - interval '30 days' + make_interval(days => g))))
       from generate_series(1, 8) as g))$$
  ),
  '22023',
  'a batch exceeding the total-duration cap is rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000011', 'pomo', null, null,
      jsonb_build_array(
        jsonb_build_object('index', 1, 'duration', 600,
          'ended_at', tests.iso(now() - interval '30 minutes')),
        jsonb_build_object('index', 2, 'duration', 600,
          'ended_at', tests.iso(now() - interval '10 minutes'))))$$
  ),
  '22023',
  'non-contiguous segment indexes are rejected'
);

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000012', 'pomo', null, null,
      jsonb_build_array(
        jsonb_build_object('index', 0, 'duration', 600,
          'ended_at', tests.iso(now() - interval '30 minutes')),
        jsonb_build_object('index', 1, 'duration', 3000,
          'ended_at', tests.iso(now() - interval '10 minutes'))))$$
  ),
  '22023',
  'overlapping segments are rejected'
);

-- 일부 segment만 유효한 batch: 첫 segment는 정상, 둘째가 무효 → 전체 롤백.
select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '31000000-0000-0000-0000-000000000013', 'pomo', null, null,
      jsonb_build_array(
        jsonb_build_object('index', 0, 'duration', 600,
          'ended_at', tests.iso(now() - interval '30 minutes')),
        jsonb_build_object('index', 1, 'duration', 5,
          'ended_at', tests.iso(now() - interval '10 minutes'))))$$
  ),
  '22023',
  'a batch with one invalid segment is rejected as a whole'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.study_sessions
    where session_batch_id = '31000000-0000-0000-0000-000000000013'
  ),
  0,
  'no partial rows survive a rejected batch (atomic rollback)'
);

select is(
  (
    select count(*)::integer
    from private.study_session_batches
    where batch_id = '31000000-0000-0000-0000-000000000013'
  ),
  0,
  'no idempotency row survives a rejected batch (atomic rollback)'
);

-- ---------------------------------------------------------------------------
-- 4. 신원 위조와 비인증 접근. (9)
-- ---------------------------------------------------------------------------

-- 인증 role이지만 JWT sub가 없는 호출(비인증)은 거부된다.
select tests.set_auth_context(null, 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '32000000-0000-0000-0000-000000000001', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '42501',
  'a call without an authenticated uid is rejected'
);

reset role;

select tests.set_auth_context(null, 'anon');
set local role anon;

select is(
  tests.capture_sqlstate(
    $$select public.record_study_session_batch(
      '32000000-0000-0000-0000-000000000002', 'pomo', null, null,
      jsonb_build_array(jsonb_build_object(
        'index', 0, 'duration', 600,
        'ended_at', tests.iso(now() - interval '5 minutes'))))$$
  ),
  '42501',
  'anon cannot execute the recording RPC at all'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions (user_id, mode, duration, created_at)
      values ('00000000-0000-0000-0000-0000000000a1', 'pomo', 600, now())$$
  ),
  '42501',
  'anon cannot INSERT study_sessions directly'
);

reset role;

-- 인증 사용자 C의 직접 DML 공격: INSERT/민감 열 UPDATE가 모두 막힌다.
select tests.set_auth_context('00000000-0000-0000-0000-0000000000c3', 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions (user_id, mode, duration, created_at)
      values ('00000000-0000-0000-0000-0000000000c3', 'pomo', 999999, now())$$
  ),
  '42501',
  'an authenticated user cannot INSERT study_sessions directly (own id)'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions (user_id, mode, duration, created_at)
      values ('00000000-0000-0000-0000-0000000000a1', 'pomo', 999999, now())$$
  ),
  '42501',
  'an authenticated user cannot INSERT study_sessions for another user'
);

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set duration = 999999
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct UPDATE of duration is rejected'
);

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set created_at = now() - interval '10 years'
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct UPDATE of created_at is rejected'
);

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set user_id = '00000000-0000-0000-0000-0000000000c3'
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct UPDATE of user_id is rejected'
);

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set session_batch_id = '99999999-0000-0000-0000-000000000001'
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  '42501',
  'direct UPDATE of session_batch_id is rejected'
);

reset role;

-- ---------------------------------------------------------------------------
-- 5. task 메모 수정/자기 기록 삭제 UX는 유지된다. (6)
-- ---------------------------------------------------------------------------

select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set task = '업데이트된 메모'
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'the owner can still edit the task memo (HistoryList UX)'
);

reset role;

select is(
  (
    select ss.task
    from public.study_sessions as ss
    where ss.session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  '업데이트된 메모',
  'the task memo edit is applied'
);

-- 타인의 행은 RLS가 걸러내므로 같은 문장이 0행에 적용된다.
select tests.set_auth_context('00000000-0000-0000-0000-0000000000c3', 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$update public.study_sessions
      set task = '탈취된 메모'
      where session_batch_id = '30000000-0000-0000-0000-000000000001'$$
  ),
  null::text,
  'updating another user''s task memo does not error (RLS filters the rows)'
);

reset role;

select is(
  (
    select ss.task
    from public.study_sessions as ss
    where ss.session_batch_id = '30000000-0000-0000-0000-000000000001'
  ),
  '업데이트된 메모',
  'another user''s task-memo update touches zero rows'
);

select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

select is(
  tests.capture_sqlstate(
    $$delete from public.study_sessions
      where session_batch_id = '31000000-0000-0000-0000-00000000000d'$$
  ),
  null::text,
  'the owner can still delete their own record (HistoryList UX)'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.study_sessions
    where session_batch_id = '31000000-0000-0000-0000-00000000000d'
  ),
  0,
  'the own-record delete is applied'
);

-- ---------------------------------------------------------------------------
-- 6. 재시도는 친구/그룹 통계를 부풀리지 못한다. (4)
-- ---------------------------------------------------------------------------

-- B가 자기 기록을 저장한 뒤, 같은 batch를 재전송(응답 유실 시나리오)한다.
select tests.set_auth_context('00000000-0000-0000-0000-0000000000b2', 'authenticated');
set local role authenticated;

select is(
  (
    select public.record_study_session_batch(
      '33000000-0000-0000-0000-000000000001',
      'stopwatch',
      null,
      null,
      (select segments from tests.payloads where name = 'stats_probe')
    ) ->> 'status'
  ),
  'saved',
  'B''s batch is saved once'
);

-- A가 친구/그룹 통계로 B의 합계를 읽는다(재시도 전 기준값).
reset role;
select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

create temporary table friend_stats_before on commit drop as
select total_seconds
from public.get_friends_study_time(
  '00000000-0000-0000-0000-0000000000a1',
  now() - interval '1 day',
  now() + interval '1 day'
)
where friend_id = '00000000-0000-0000-0000-0000000000b2';

create temporary table group_stats_before on commit drop as
select user_id, total_seconds
from public.get_group_study_time_v3(
  '10000000-0000-0000-0000-0000000000d4',
  now() - interval '1 day',
  now() + interval '1 day'
);

reset role;
select tests.set_auth_context('00000000-0000-0000-0000-0000000000b2', 'authenticated');
set local role authenticated;

select is(
  (
    select public.record_study_session_batch(
      '33000000-0000-0000-0000-000000000001',
      'stopwatch',
      null,
      null,
      (select segments from tests.payloads where name = 'stats_probe')
    ) ->> 'status'
  ),
  'already_processed',
  'replaying B''s batch reports already_processed'
);

reset role;
select tests.set_auth_context('00000000-0000-0000-0000-0000000000a1', 'authenticated');
set local role authenticated;

select is(
  (
    select total_seconds
    from public.get_friends_study_time(
      '00000000-0000-0000-0000-0000000000a1',
      now() - interval '1 day',
      now() + interval '1 day'
    )
    where friend_id = '00000000-0000-0000-0000-0000000000b2'
  ),
  (select total_seconds from friend_stats_before),
  'a retry does not inflate the friend study-time total'
);

select is(
  (
    select sum(total_seconds)::bigint
    from public.get_group_study_time_v3(
      '10000000-0000-0000-0000-0000000000d4',
      now() - interval '1 day',
      now() + interval '1 day'
    )
  ),
  (select sum(total_seconds)::bigint from group_stats_before),
  'a retry does not inflate the group study-time total'
);

reset role;

-- ---------------------------------------------------------------------------
-- 7. DB 백스톱: segment 유니크 인덱스와 신규 행 형태 제약. (6)
-- ---------------------------------------------------------------------------

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions
      (user_id, mode, duration, created_at, session_batch_id, segment_index)
      values
      ('00000000-0000-0000-0000-0000000000a1', 'pomo', 600, now(),
       '30000000-0000-0000-0000-000000000001', 0)$$
  ),
  '23505',
  'even a privileged writer cannot duplicate a (user, batch, segment) row'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions
      (user_id, mode, duration, created_at, session_batch_id, segment_index)
      values
      ('00000000-0000-0000-0000-0000000000a1', 'pomo', -5, now(),
       '34000000-0000-0000-0000-000000000001', 0)$$
  ),
  '23514',
  'the row-shape CHECK rejects out-of-range durations on RPC-shaped rows'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions
      (user_id, mode, duration, created_at, session_batch_id, segment_index)
      values
      ('00000000-0000-0000-0000-0000000000a1', 'focus', 600, now(),
       '34000000-0000-0000-0000-000000000002', 0)$$
  ),
  '23514',
  'the row-shape CHECK rejects unknown modes on RPC-shaped rows'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.study_sessions (user_id, mode, duration, created_at, task)
      values ('00000000-0000-0000-0000-0000000000a1', 'pomo', 600, now(),
              repeat('가', 201))$$
  ),
  '23514',
  'the task-length CHECK rejects over-long tasks on new writes'
);

select is(
  (
    select count(*)::integer
    from pg_constraint
    where conrelid = 'public.study_sessions'::regclass
      and conname in ('study_sessions_rpc_row_shape_chk', 'study_sessions_task_length_chk')
  ),
  2,
  'both study_sessions CHECK constraints are installed'
);

select ok(
  (
    select i.indisunique
    from pg_class as c
    join pg_index as i on i.indexrelid = c.oid
    where c.relname = 'study_sessions_user_batch_segment_key'
  ),
  'the (user, batch, segment) backstop index is UNIQUE'
);

select * from finish();
rollback;
