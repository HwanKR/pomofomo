-- Forward-only migration.
--
-- 장기 과제와 세부 할 일을 별도 풀로 보관하고, 세부 할 일을 선택한 날에는
-- 기존 tasks 행으로 구체화한다. 일일 작업/공부 기록의 기존 경로를 재사용하면서
-- 풀의 완료 상태만 tasks.status와 동기화한다.

create table public.long_term_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  position double precision default 0,
  archived_at timestamptz,
  created_at timestamptz default now()
);

create table public.long_term_subtasks (
  id uuid primary key default gen_random_uuid(),
  long_term_task_id uuid not null
    references public.long_term_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  position double precision default 0,
  completed_at timestamptz,
  created_at timestamptz default now(),
  constraint long_term_subtasks_id_user_id_key unique (id, user_id)
);

-- 소유자 조회와 부모별 세부 할 일 조회가 전체 테이블 스캔으로 번지지 않게 한다.
create index long_term_tasks_user_id_idx
  on public.long_term_tasks (user_id);
create index long_term_subtasks_user_id_idx
  on public.long_term_subtasks (user_id);
create index long_term_subtasks_long_term_task_id_idx
  on public.long_term_subtasks (long_term_task_id);

-- 2026-04-28 Supabase Data API 권한 기본값 변경 이후에도 새 테이블이
-- authenticated 클라이언트에 노출되도록 필요한 DML 권한만 명시한다.
grant select, insert, update, delete
  on table public.long_term_tasks, public.long_term_subtasks
  to authenticated;

alter table public.long_term_tasks enable row level security;
alter table public.long_term_subtasks enable row level security;

-- 장기 과제는 소유자만 조회하거나 변경할 수 있다.
create policy "Users can manage their own long term tasks"
on public.long_term_tasks for all
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- 세부 할 일은 소유자만 다루며, 새 값의 부모 과제도 같은 사용자의 소유여야 한다.
-- user_id 검사만으로는 타인의 장기 과제 id를 부모로 지정하는 것을 막지 못한다.
create policy "Users can manage their own long term subtasks"
on public.long_term_subtasks for all
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.long_term_tasks as parent
    where parent.id = long_term_subtasks.long_term_task_id
      and parent.user_id = (select auth.uid())
  )
);

-- 원본 세부 할 일이 삭제되어도 이미 만들어진 일일 작업과 공부 기록은 남기고
-- 연결만 끊는다.
alter table public.tasks
  add column source_subtask_id uuid;

-- tasks.user_id까지 복합 FK로 묶어 공격자 소유 task가 타인의 세부 할 일을 가리킨 뒤
-- 전역 (source_subtask_id, due_date) 유니크 키를 선점하지 못하게 한다.
alter table public.tasks
  add constraint tasks_source_subtask_id_user_id_fkey
  foreign key (source_subtask_id, user_id)
  references public.long_term_subtasks (id, user_id)
  on delete set null (source_subtask_id);

-- 같은 세부 할 일은 하루에 한 번만 구체화한다. partial index가 아닌 일반
-- unique index여야 PostgREST가 on_conflict 열 목록으로 추론할 수 있다.
-- 기본 nulls distinct 동작 덕분에 source_subtask_id가 null인 일반 작업은
-- 서로 충돌하지 않는다.
create unique index tasks_source_subtask_id_due_date_key
  on public.tasks (source_subtask_id, due_date);

create function public.sync_subtask_completion_from_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'done' then
    -- 풀에서 먼저 완료했다면 그 시각을 보존한다.
    update public.long_term_subtasks as subtask
    set completed_at = coalesce(subtask.completed_at, now())
    where subtask.id = new.source_subtask_id
      and subtask.user_id = new.user_id;
  elsif old.status = 'done' then
    update public.long_term_subtasks as subtask
    set completed_at = null
    where subtask.id = new.source_subtask_id
      and subtask.user_id = new.user_id;
  end if;

  return new;
end;
$$;

-- 트리거 전용 함수는 Data API의 직접 호출 표면으로 노출하지 않는다.
revoke execute on function public.sync_subtask_completion_from_task()
  from public, anon, authenticated, service_role;

create trigger sync_subtask_completion_on_task_status
after update of status on public.tasks
for each row
when (
  new.source_subtask_id is not null
  and new.status is distinct from old.status
)
execute function public.sync_subtask_completion_from_task();

-- postgres_changes DELETE는 기본 replica identity에서 old row가 PK뿐이라
-- user_id 필터가 동작하지 않아 다른 탭의 삭제를 놓친다. 행 수가 적어
-- replica identity full의 추가 비용은 무시할 수 있다.
alter table public.long_term_tasks replica identity full;
alter table public.long_term_subtasks replica identity full;

-- 플랜 화면과 타이머 사이드바가 어느 쪽의 변경도 즉시 반영하도록 한다.
alter publication supabase_realtime add table public.long_term_tasks;
alter publication supabase_realtime add table public.long_term_subtasks;
