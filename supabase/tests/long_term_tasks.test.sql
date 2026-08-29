-- 장기 과제/세부 할 일의 RLS, 구체화 유니크 키, 완료 동기화, 삭제 보존 계약.
--
-- 검증 대상: 20260829100000_long_term_tasks.sql
--   * 다른 사용자의 장기 과제와 세부 할 일은 조회/수정/삭제할 수 없음
--   * 세부 할 일은 호출자 소유의 장기 과제에만 연결할 수 있음
--   * 같은 세부 할 일은 같은 날짜에 한 번만 tasks 행으로 구체화됨
--   * tasks.status와 long_term_subtasks.completed_at의 양방향 동기화
--   * 풀의 행을 삭제해도 이미 구체화된 일일 작업은 보존됨

begin;

set local search_path = extensions, public, pg_catalog;
select plan(15);

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
    '40000000-0000-0000-0000-0000000000a1',
    'long-term-a@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '40000000-0000-0000-0000-0000000000b2',
    'long-term-b@example.invalid',
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into public.long_term_tasks (id, user_id, title, position)
values
  (
    '10000000-0000-0000-0000-0000000000a1',
    '40000000-0000-0000-0000-0000000000a1',
    'A 장기 과제',
    0
  ),
  (
    '10000000-0000-0000-0000-0000000000a2',
    '40000000-0000-0000-0000-0000000000a1',
    'A 삭제 과제',
    1
  ),
  (
    '10000000-0000-0000-0000-0000000000b2',
    '40000000-0000-0000-0000-0000000000b2',
    'B 장기 과제',
    0
  );

insert into public.long_term_subtasks (
  id,
  long_term_task_id,
  user_id,
  title,
  position
)
values
  (
    '11000000-0000-0000-0000-0000000000a1',
    '10000000-0000-0000-0000-0000000000a1',
    '40000000-0000-0000-0000-0000000000a1',
    '완료 동기화 대상',
    0
  ),
  (
    '11000000-0000-0000-0000-0000000000a2',
    '10000000-0000-0000-0000-0000000000a1',
    '40000000-0000-0000-0000-0000000000a1',
    '직접 삭제 대상',
    1
  ),
  (
    '11000000-0000-0000-0000-0000000000a3',
    '10000000-0000-0000-0000-0000000000a2',
    '40000000-0000-0000-0000-0000000000a1',
    '부모 연쇄 삭제 대상',
    0
  ),
  (
    '11000000-0000-0000-0000-0000000000b2',
    '10000000-0000-0000-0000-0000000000b2',
    '40000000-0000-0000-0000-0000000000b2',
    'B 세부 할 일',
    0
  );

insert into public.tasks (
  id,
  user_id,
  title,
  status,
  due_date,
  source_subtask_id
)
values
  (
    '12000000-0000-0000-0000-0000000000a1',
    '40000000-0000-0000-0000-0000000000a1',
    '완료 동기화 일일 작업',
    'todo',
    '2026-08-29',
    '11000000-0000-0000-0000-0000000000a1'
  ),
  (
    '12000000-0000-0000-0000-0000000000a2',
    '40000000-0000-0000-0000-0000000000a1',
    '직접 삭제 후 보존 작업',
    'todo',
    '2026-08-30',
    '11000000-0000-0000-0000-0000000000a2'
  ),
  (
    '12000000-0000-0000-0000-0000000000a3',
    '40000000-0000-0000-0000-0000000000a1',
    '부모 삭제 후 보존 작업',
    'todo',
    '2026-08-31',
    '11000000-0000-0000-0000-0000000000a3'
  );

-- ---------------------------------------------------------------------------
-- 1. 다른 사용자의 두 테이블 행은 SELECT/UPDATE/DELETE에서 필터링된다. (6)
-- ---------------------------------------------------------------------------

select tests.set_auth_context(
  '40000000-0000-0000-0000-0000000000a1',
  'authenticated'
);
set local role authenticated;

select is(
  (
    select count(*)::integer
    from public.long_term_tasks
    where id = '10000000-0000-0000-0000-0000000000b2'
  ),
  0,
  'a user cannot select another user''s long-term task'
);

select is(
  (
    select count(*)::integer
    from public.long_term_subtasks
    where id = '11000000-0000-0000-0000-0000000000b2'
  ),
  0,
  'a user cannot select another user''s long-term subtask'
);

with updated as (
  update public.long_term_tasks
  set title = '탈취된 장기 과제'
  where id = '10000000-0000-0000-0000-0000000000b2'
  returning id
)
select is(
  (select count(*)::integer from updated),
  0,
  'a user cannot update another user''s long-term task'
);

with updated as (
  update public.long_term_subtasks
  set title = '탈취된 세부 할 일'
  where id = '11000000-0000-0000-0000-0000000000b2'
  returning id
)
select is(
  (select count(*)::integer from updated),
  0,
  'a user cannot update another user''s long-term subtask'
);

with deleted as (
  delete from public.long_term_tasks
  where id = '10000000-0000-0000-0000-0000000000b2'
  returning id
)
select is(
  (select count(*)::integer from deleted),
  0,
  'a user cannot delete another user''s long-term task'
);

with deleted as (
  delete from public.long_term_subtasks
  where id = '11000000-0000-0000-0000-0000000000b2'
  returning id
)
select is(
  (select count(*)::integer from deleted),
  0,
  'a user cannot delete another user''s long-term subtask'
);

select is(
  tests.capture_sqlstate(
    $$insert into public.long_term_subtasks (
        id, long_term_task_id, user_id, title
      )
      values (
        '11000000-0000-0000-0000-0000000000ff',
        '10000000-0000-0000-0000-0000000000b2',
        '40000000-0000-0000-0000-0000000000a1',
        '타인 과제에 붙이기'
      )$$
  ),
  '42501',
  'WITH CHECK rejects a subtask attached to another user''s parent'
);

reset role;

-- ---------------------------------------------------------------------------
-- 2. 구체화 유니크 키와 완료 상태 동기화 트리거. (4)
-- ---------------------------------------------------------------------------

select is(
  tests.capture_sqlstate(
    $$insert into public.tasks (
        id, user_id, title, status, due_date, source_subtask_id
      )
      values (
        '12000000-0000-0000-0000-0000000000ff',
        '40000000-0000-0000-0000-0000000000a1',
        '중복 구체화',
        'todo',
        '2026-08-29',
        '11000000-0000-0000-0000-0000000000a1'
      )$$
  ),
  '23505',
  'the same subtask cannot be materialized twice for one due date'
);

update public.tasks
set status = 'done'
where id = '12000000-0000-0000-0000-0000000000a1';

select ok(
  (
    select completed_at is not null
    from public.long_term_subtasks
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  'moving a materialized task to done sets the source completed_at'
);

update public.tasks
set status = 'todo'
where id = '12000000-0000-0000-0000-0000000000a1';

select is(
  (
    select completed_at
    from public.long_term_subtasks
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  null::timestamptz,
  'moving a materialized task out of done clears the source completed_at'
);

update public.long_term_subtasks
set completed_at = '2026-01-02 03:04:05+00'::timestamptz
where id = '11000000-0000-0000-0000-0000000000a1';

update public.tasks
set status = 'done'
where id = '12000000-0000-0000-0000-0000000000a1';

select is(
  (
    select completed_at
    from public.long_term_subtasks
    where id = '11000000-0000-0000-0000-0000000000a1'
  ),
  '2026-01-02 03:04:05+00'::timestamptz,
  'moving to done preserves a pre-set completed_at through coalesce'
);

-- ---------------------------------------------------------------------------
-- 3. 풀 삭제는 일일 작업을 지우지 않고 원본 연결만 해제한다. (4)
-- ---------------------------------------------------------------------------

select tests.set_auth_context(
  '40000000-0000-0000-0000-0000000000a1',
  'authenticated'
);
set local role authenticated;

delete from public.long_term_subtasks
where id = '11000000-0000-0000-0000-0000000000a2';

reset role;

select is(
  (
    select count(*)::integer
    from public.tasks
    where id = '12000000-0000-0000-0000-0000000000a2'
  ),
  1,
  'deleting a source subtask preserves its materialized task row'
);

select is(
  (
    select source_subtask_id
    from public.tasks
    where id = '12000000-0000-0000-0000-0000000000a2'
  ),
  null::uuid,
  'deleting a source subtask clears tasks.source_subtask_id'
);

select tests.set_auth_context(
  '40000000-0000-0000-0000-0000000000a1',
  'authenticated'
);
set local role authenticated;

delete from public.long_term_tasks
where id = '10000000-0000-0000-0000-0000000000a2';

reset role;

select is(
  (
    select count(*)::integer
    from public.long_term_subtasks
    where id = '11000000-0000-0000-0000-0000000000a3'
  ),
  0,
  'deleting a long-term task cascades to its subtasks'
);

select ok(
  exists (
    select 1
    from public.tasks
    where id = '12000000-0000-0000-0000-0000000000a3'
      and source_subtask_id is null
  ),
  'deleting a long-term task preserves and unlinks materialized tasks'
);

select * from finish();
rollback;
