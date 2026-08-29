import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: {
    from: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

import {
  materializeSubtaskForToday,
  toggleSubtaskCompletion,
  type LongTermSubtaskRow,
  type MaterializedTaskRow,
} from '../longTermTasks';

const todayKey = '2026-08-29';
// 03:30 belongs to the previous 05:00-based study day, but tasks.due_date
// must still use August 29 because it follows the plain local calendar date.
const now = new Date(2026, 7, 29, 3, 30);
const nowIso = now.toISOString();
const taskSelect =
  'id, title, status, estimated_pomodoros, position, source_subtask_id';

const subtask: LongTermSubtaskRow = {
  id: 'subtask-1',
  long_term_task_id: 'long-task-1',
  title: 'Chapter 1',
  position: 0,
  completed_at: null,
};

const materializedTask: MaterializedTaskRow = {
  id: 'task-1',
  title: 'Chapter 1',
  status: 'todo',
  estimated_pomodoros: 1,
  position: 5,
  source_subtask_id: 'subtask-1',
};

type QueryResult = {
  data?: unknown;
  error: { message: string } | null;
};

let positionResult: QueryResult;
let upsertResult: QueryResult;
let fallbackResult: QueryResult;
let subtaskUpdateResult: QueryResult;
let taskUpdateResult: QueryResult;
let positionFilters: Array<[string, unknown]>;
let fallbackFilters: Array<[string, unknown]>;
let subtaskUpdateFilters: Array<[string, unknown]>;
let taskUpdateFilters: Array<[string, unknown]>;
let taskUpdateNotFilters: Array<[string, unknown]>;
let positionOrderCalls: Array<
  [string, { ascending: boolean; nullsFirst: boolean }]
>;
let mutationOrder: string[];
let upsertCalls: Array<{
  payload: Record<string, unknown>;
  options: Record<string, unknown>;
}>;
let taskUpdatePatches: Array<Record<string, unknown>>;
let subtaskUpdatePatches: Array<Record<string, unknown>>;

function makeThenableMutation(
  result: () => QueryResult,
  filters: Array<[string, unknown]>,
  notFilters: Array<[string, unknown]>
) {
  const query = {
    eq: vi.fn((field: string, value: unknown) => {
      filters.push([field, value]);
      return query;
    }),
    neq: vi.fn((field: string, value: unknown) => {
      notFilters.push([field, value]);
      return query;
    }),
    then: <TResult1 = QueryResult, TResult2 = never>(
      onFulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => Promise.resolve(result()).then(onFulfilled, onRejected),
  };
  return query;
}

describe('longTermTasks helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    positionResult = { data: { position: 4 }, error: null };
    upsertResult = { data: materializedTask, error: null };
    fallbackResult = { data: null, error: null };
    subtaskUpdateResult = { data: null, error: null };
    taskUpdateResult = { data: null, error: null };
    positionFilters = [];
    fallbackFilters = [];
    subtaskUpdateFilters = [];
    taskUpdateFilters = [];
    taskUpdateNotFilters = [];
    positionOrderCalls = [];
    mutationOrder = [];
    upsertCalls = [];
    taskUpdatePatches = [];
    subtaskUpdatePatches = [];

    const positionQuery = {
      eq: vi.fn((field: string, value: unknown) => {
        positionFilters.push([field, value]);
        return positionQuery;
      }),
      order: vi.fn(
        (
          field: string,
          options: { ascending: boolean; nullsFirst: boolean }
        ) => {
          positionOrderCalls.push([field, options]);
          return positionQuery;
        }
      ),
      limit: vi.fn(() => positionQuery),
      maybeSingle: vi.fn(async () => positionResult),
    };

    const fallbackQuery = {
      eq: vi.fn((field: string, value: unknown) => {
        fallbackFilters.push([field, value]);
        return fallbackQuery;
      }),
      maybeSingle: vi.fn(async () => fallbackResult),
    };

    const tasksTable = {
      select: vi.fn((columns: string) => {
        if (columns === 'position') return positionQuery;
        expect(columns).toBe(taskSelect);
        return fallbackQuery;
      }),
      upsert: vi.fn(
        (payload: Record<string, unknown>, options: Record<string, unknown>) => {
          upsertCalls.push({ payload, options });
          return {
            select: vi.fn((columns: string) => {
              expect(columns).toBe(taskSelect);
              return {
                maybeSingle: vi.fn(async () => upsertResult),
              };
            }),
          };
        }
      ),
      update: vi.fn((patch: Record<string, unknown>) => {
        mutationOrder.push('tasks');
        taskUpdatePatches.push(patch);
        return makeThenableMutation(
          () => taskUpdateResult,
          taskUpdateFilters,
          taskUpdateNotFilters
        );
      }),
    };

    const subtasksTable = {
      update: vi.fn((patch: Record<string, unknown>) => {
        mutationOrder.push('long_term_subtasks');
        subtaskUpdatePatches.push(patch);
        return makeThenableMutation(
          () => subtaskUpdateResult,
          subtaskUpdateFilters,
          []
        );
      }),
    };

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'tasks') return tasksTable;
      if (table === 'long_term_subtasks') return subtasksTable;
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('materializes at the end of the calendar-day task list with a deduplicating upsert', async () => {
    const result = await materializeSubtaskForToday('user-1', subtask);

    expect(positionFilters).toEqual([
      ['user_id', 'user-1'],
      ['due_date', todayKey],
    ]);
    expect(positionOrderCalls).toEqual([
      ['position', { ascending: false, nullsFirst: false }],
    ]);
    expect(upsertCalls).toEqual([
      {
        payload: {
          user_id: 'user-1',
          title: 'Chapter 1',
          due_date: todayKey,
          status: 'todo',
          position: 5,
          source_subtask_id: 'subtask-1',
        },
        options: {
          onConflict: 'source_subtask_id,due_date',
          ignoreDuplicates: true,
        },
      },
    ]);
    expect(upsertCalls[0].payload).not.toHaveProperty('estimated_pomodoros');
    expect(result).toEqual(materializedTask);
  });

  it('uses position zero when the calendar day has no tasks', async () => {
    positionResult = { data: null, error: null };

    await materializeSubtaskForToday('user-1', subtask);

    expect(upsertCalls[0].payload).toMatchObject({ position: 0 });
  });

  it('normalizes an existing null position before appending the task', async () => {
    positionResult = { data: { position: null }, error: null };

    await materializeSubtaskForToday('user-1', subtask);

    expect(upsertCalls[0].payload).toMatchObject({ position: 1 });
  });

  it('falls back to the existing row when a duplicate upsert returns no row', async () => {
    upsertResult = { data: null, error: null };
    fallbackResult = { data: materializedTask, error: null };

    const result = await materializeSubtaskForToday('user-1', subtask);

    expect(fallbackFilters).toEqual([
      ['source_subtask_id', 'subtask-1'],
      ['due_date', todayKey],
    ]);
    expect(result).toEqual(materializedTask);
  });

  it('updates the subtask first, then only today\'s materialized task', async () => {
    await toggleSubtaskCompletion('user-1', subtask);

    expect(mutationOrder).toEqual(['long_term_subtasks', 'tasks']);
    expect(subtaskUpdatePatches).toEqual([{ completed_at: nowIso }]);
    expect(subtaskUpdateFilters).toEqual([
      ['id', 'subtask-1'],
      ['user_id', 'user-1'],
    ]);
    expect(taskUpdatePatches).toEqual([{ status: 'done' }]);
    expect(taskUpdateFilters).toEqual([
      ['user_id', 'user-1'],
      ['source_subtask_id', 'subtask-1'],
      ['due_date', todayKey],
    ]);
    expect(taskUpdateNotFilters).toEqual([['status', 'done']]);
  });

  it('writes the exact target completion state when one is provided', async () => {
    await toggleSubtaskCompletion('user-1', subtask, '2026-08-29T00:15:00.000Z');

    expect(subtaskUpdatePatches).toEqual([
      { completed_at: '2026-08-29T00:15:00.000Z' },
    ]);
    expect(taskUpdatePatches).toEqual([{ status: 'done' }]);
  });

  it('clears completion when the explicit target is null even if the row still looks incomplete', async () => {
    // 낙관적 UI가 이미 미완료로 그린 상태를 그대로 저장해야 하는 경우:
    // 파생 로직이라면 완료로 뒤집었겠지만 목표 상태가 우선한다.
    await toggleSubtaskCompletion('user-1', subtask, null);

    expect(subtaskUpdatePatches).toEqual([{ completed_at: null }]);
    expect(taskUpdatePatches).toEqual([{ status: 'todo' }]);
  });

  it('clears completion and leaves past-day task rows outside the update filter', async () => {
    await toggleSubtaskCompletion('user-1', {
      ...subtask,
      completed_at: '2026-08-28T10:00:00.000Z',
    });

    expect(subtaskUpdatePatches).toEqual([{ completed_at: null }]);
    expect(taskUpdatePatches).toEqual([{ status: 'todo' }]);
    expect(taskUpdateFilters).toContainEqual(['due_date', todayKey]);
    expect(taskUpdateFilters).not.toContainEqual(['due_date', '2026-08-28']);
  });
});
