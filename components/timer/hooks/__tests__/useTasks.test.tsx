import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getStorageOwnerMock,
  materializeSubtaskForTodayMock,
  readOwnedJsonMock,
  supabaseMock,
  toggleSubtaskCompletionMock,
} = vi.hoisted(() => ({
  getStorageOwnerMock: vi.fn(),
  materializeSubtaskForTodayMock: vi.fn(),
  readOwnedJsonMock: vi.fn(),
  supabaseMock: {
    from: vi.fn(),
    auth: {
      getUser: vi.fn(),
    },
  },
  toggleSubtaskCompletionMock: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

vi.mock('@/lib/longTermTasks', () => ({
  materializeSubtaskForToday: materializeSubtaskForTodayMock,
  toggleSubtaskCompletion: toggleSubtaskCompletionMock,
}));

vi.mock('@/lib/userScopedStorage', () => ({
  GUEST_OWNER: 'guest',
  getScopedStorageKey: (baseKey: string, owner: string) =>
    owner === 'guest' ? baseKey : `${baseKey}::${owner}`,
  getStorageOwner: getStorageOwnerMock,
  readOwnedJson: readOwnedJsonMock,
}));

import { useTasks, type TaskItem } from '../useTasks';

type Row = {
  id: string;
  title: string;
  status: string;
  source_subtask_id?: string | null;
};
type SessionRow = { task_id: string | null; duration: number | null };
type LongTermRow = {
  id: string;
  title: string;
  position: number | null;
  long_term_subtasks: Array<{
    id: string;
    title: string;
    position: number | null;
    completed_at: string | null;
  }>;
};

let taskRows: Row[];
let weeklyRows: Row[];
let monthlyRows: Row[];
let longTermRows: LongTermRow[];
let sessionRows: SessionRow[];
let updateError: { message: string } | null;
let updateCalls: Array<{ table: string; patch: Record<string, unknown>; id: string }>;
let taskSelectCalls: string[];
let longTermQueryCalls: Array<
  | { method: 'select'; columns: string }
  | { method: 'eq' | 'is'; field: string; value: unknown }
  | { method: 'order'; field: string; options: Record<string, unknown> }
>;
let taskQueryResponses: Array<
  Promise<{ data: Row[]; error: { message: string } | null }>
>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function updateMockFor(table: string) {
  return vi.fn((patch: Record<string, unknown>) => ({
    eq: vi.fn(async (_field: string, id: string) => {
      updateCalls.push({ table, patch, id });
      return { error: updateError };
    }),
  }));
}

describe('useTasks', () => {
  beforeEach(() => {
    window.localStorage.clear();

    taskRows = [
      {
        id: 't1',
        title: '남은 작업',
        status: 'todo',
        source_subtask_id: 's1',
      },
      {
        id: 't2',
        title: '끝난 작업',
        status: 'done',
        source_subtask_id: null,
      },
    ];
    weeklyRows = [{ id: 'w1', title: '주간 작업', status: 'todo' }];
    monthlyRows = [{ id: 'm1', title: '월간 작업', status: 'todo' }];
    longTermRows = [
      {
        id: 'lt1',
        title: '자격증 공부',
        position: 0,
        long_term_subtasks: [
          {
            id: 's2',
            title: '2장',
            position: 2,
            completed_at: null,
          },
          {
            id: 's1',
            title: '1장',
            position: 1,
            completed_at: null,
          },
        ],
      },
    ];
    sessionRows = [
      { task_id: 't1', duration: 600 },
      { task_id: 't1', duration: 300 },
      { task_id: 'w1', duration: 1200 },
    ];
    updateError = null;
    updateCalls = [];
    taskSelectCalls = [];
    longTermQueryCalls = [];
    taskQueryResponses = [];

    getStorageOwnerMock.mockReset();
    getStorageOwnerMock.mockReturnValue('user-1');
    materializeSubtaskForTodayMock.mockReset();
    materializeSubtaskForTodayMock.mockResolvedValue(null);
    readOwnedJsonMock.mockReset();
    readOwnedJsonMock.mockReturnValue(null);
    toggleSubtaskCompletionMock.mockReset();
    toggleSubtaskCompletionMock.mockResolvedValue(undefined);

    supabaseMock.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'tasks') {
        return {
          select: vi.fn((columns: string) => {
            taskSelectCalls.push(columns);
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() =>
                  taskQueryResponses.shift() ??
                  Promise.resolve({ data: taskRows, error: null })
                ),
              })),
            };
          }),
          update: updateMockFor('tasks'),
        };
      }

      if (table === 'weekly_plans') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              gte: vi.fn(() => ({
                lte: vi.fn(async () => ({ data: weeklyRows, error: null })),
              })),
            })),
          })),
          update: updateMockFor('weekly_plans'),
        };
      }

      if (table === 'monthly_plans') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(async () => ({ data: monthlyRows, error: null })),
              })),
            })),
          })),
          update: updateMockFor('monthly_plans'),
        };
      }

      if (table === 'long_term_tasks') {
        const query = {
          eq: vi.fn((field: string, value: unknown) => {
            longTermQueryCalls.push({ method: 'eq', field, value });
            return query;
          }),
          is: vi.fn((field: string, value: unknown) => {
            longTermQueryCalls.push({ method: 'is', field, value });
            return query;
          }),
          order: vi.fn(
            async (field: string, options: Record<string, unknown>) => {
              longTermQueryCalls.push({ method: 'order', field, options });
              return { data: longTermRows, error: null };
            }
          ),
        };

        return {
          select: vi.fn((columns: string) => {
            longTermQueryCalls.push({ method: 'select', columns });
            return query;
          }),
        };
      }

      if (table === 'study_sessions') {
        return {
          select: vi.fn(() => ({
            // duration 합산은 본인 세션으로 한정된다: .eq('user_id', …).in('task_id', …)
            eq: vi.fn(() => ({
              in: vi.fn(async (_inField: string, ids: string[]) => ({
                data: sessionRows.filter(
                  (row) => row.task_id !== null && ids.includes(row.task_id)
                ),
                error: null,
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads all three lists with summed durations, including done items', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.dbTasks).toHaveLength(2);
    });

    const [todoTask, doneTask] = result.current.dbTasks;
    expect(todoTask).toMatchObject({
      id: 't1',
      status: 'todo',
      durationSeconds: 900,
      kind: 'daily',
      sourceSubtaskId: 's1',
      parentTitle: '자격증 공부',
    });
    expect(taskSelectCalls[0]).toBe(
      'id, title, status, source_subtask_id'
    );
    expect(doneTask).toMatchObject({ id: 't2', status: 'done' });

    expect(result.current.weeklyPlans[0]).toMatchObject({
      id: 'w1',
      durationSeconds: 1200,
      kind: 'weekly',
    });
    expect(result.current.monthlyPlans[0]).toMatchObject({
      id: 'm1',
      durationSeconds: 0,
      kind: 'monthly',
    });

    expect(result.current.longTermTasks).toEqual([
      {
        id: 'lt1',
        title: '자격증 공부',
        position: 0,
        subtasks: [
          {
            id: 's1',
            title: '1장',
            position: 1,
            completed_at: null,
          },
          {
            id: 's2',
            title: '2장',
            position: 2,
            completed_at: null,
          },
        ],
      },
    ]);
    expect(longTermQueryCalls).toEqual([
      {
        method: 'select',
        columns:
          'id, title, position, long_term_subtasks(id, title, position, completed_at)',
      },
      { method: 'eq', field: 'user_id', value: 'user-1' },
      { method: 'is', field: 'archived_at', value: null },
      {
        method: 'order',
        field: 'position',
        options: { ascending: true },
      },
    ]);
  });

  it('normalizes nullable parent and subtask positions before exposing items', async () => {
    longTermRows = [
      {
        id: 'lt-null',
        title: '위치 없는 과제',
        position: null,
        long_term_subtasks: [
          {
            id: 's-null',
            title: '위치 없는 챕터',
            position: null,
            completed_at: null,
          },
        ],
      },
    ];

    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toEqual([
        {
          id: 'lt-null',
          title: '위치 없는 과제',
          position: 0,
          subtasks: [
            {
              id: 's-null',
              title: '위치 없는 챕터',
              position: 0,
              completed_at: null,
            },
          ],
        },
      ]);
    });
  });

  it('reuses today\'s materialized task when selecting a subtask', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toHaveLength(1);
    });

    let selected: TaskItem | null = null;
    await act(async () => {
      selected = await result.current.selectSubtaskForTimer(
        result.current.longTermTasks[0].subtasks[0]
      );
    });

    expect(materializeSubtaskForTodayMock).not.toHaveBeenCalled();
    expect(selected).toMatchObject({ id: 't1', sourceSubtaskId: 's1' });
    expect(result.current.selectedTask).toBe('남은 작업');
    expect(result.current.selectedTaskId).toBe('t1');
  });

  it('materializes, appends, and selects a subtask without a task today', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toHaveLength(1);
    });

    const subtask = result.current.longTermTasks[0].subtasks[1];
    const createdRow = {
      id: 't3',
      title: '2장',
      status: 'todo',
      estimated_pomodoros: 1,
      position: 2,
      source_subtask_id: 's2',
    };
    materializeSubtaskForTodayMock.mockResolvedValueOnce(createdRow);
    // The helper's reconciliation fetch sees the row that was just inserted.
    taskRows.push({
      id: 't3',
      title: '2장',
      status: 'todo',
      source_subtask_id: 's2',
    });

    let selected: TaskItem | null = null;
    await act(async () => {
      selected = await result.current.selectSubtaskForTimer(subtask);
    });

    expect(materializeSubtaskForTodayMock).toHaveBeenCalledWith('user-1', subtask);
    expect(selected).toMatchObject({
      id: 't3',
      title: '2장',
      kind: 'daily',
      sourceSubtaskId: 's2',
      parentTitle: '자격증 공부',
    });
    expect(result.current.selectedTask).toBe('2장');
    expect(result.current.selectedTaskId).toBe('t3');
    await waitFor(() => {
      expect(result.current.dbTasks.some((task) => task.id === 't3')).toBe(true);
    });
  });

  it('does not restore an older persisted selection after materialization', async () => {
    getStorageOwnerMock.mockReturnValue('user-1');
    readOwnedJsonMock.mockReturnValue({
      taskId: 't1',
      taskTitle: '남은 작업',
    });
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.selectedTaskId).toBe('t1');
    });

    const subtask = result.current.longTermTasks[0].subtasks[1];
    const createdRow = {
      id: 't3',
      title: '2장',
      status: 'todo' as const,
      estimated_pomodoros: 1,
      position: 2,
      source_subtask_id: 's2',
    };
    materializeSubtaskForTodayMock.mockResolvedValueOnce(createdRow);
    taskRows.push(createdRow);

    await act(async () => {
      await result.current.selectSubtaskForTimer(subtask);
      await result.current.fetchDbTasks();
    });

    expect(result.current.selectedTask).toBe('2장');
    expect(result.current.selectedTaskId).toBe('t3');
    expect(readOwnedJsonMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an older fetch that finishes after a newer fetch', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.dbTasks).toHaveLength(2);
    });

    const olderRows = taskRows.map((row) => ({ ...row }));
    const newerRows: Row[] = [
      ...olderRows,
      {
        id: 't3',
        title: '새 작업',
        status: 'todo',
        source_subtask_id: null,
      },
    ];
    let resolveOlderFetch!: (value: {
      data: Row[];
      error: { message: string } | null;
    }) => void;
    const olderResponse = new Promise<{
      data: Row[];
      error: { message: string } | null;
    }>((resolve) => {
      resolveOlderFetch = resolve;
    });
    taskQueryResponses.push(
      olderResponse,
      Promise.resolve({ data: newerRows, error: null })
    );

    const selectCallCount = taskSelectCalls.length;
    let olderFetch!: Promise<void>;
    act(() => {
      olderFetch = result.current.fetchDbTasks();
    });
    await waitFor(() => {
      expect(taskSelectCalls).toHaveLength(selectCallCount + 1);
    });

    await act(async () => {
      await result.current.fetchDbTasks();
    });
    expect(result.current.dbTasks.some((task) => task.id === 't3')).toBe(true);

    await act(async () => {
      resolveOlderFetch({ data: olderRows, error: null });
      await olderFetch;
    });
    expect(result.current.dbTasks.some((task) => task.id === 't3')).toBe(true);
  });

  it('clears on logout and rejects a deferred response from the prior owner', async () => {
    const { result, rerender } = renderHook(
      ({ loggedIn }: { loggedIn: boolean }) => useTasks(loggedIn),
      { initialProps: { loggedIn: true } }
    );

    await waitFor(() => {
      expect(result.current.dbTasks).toHaveLength(2);
    });
    act(() => {
      result.current.setSelectedTask('A의 선택');
      result.current.setSelectedTaskId('t1');
    });

    const staleResponse = createDeferred<{
      data: Row[];
      error: { message: string } | null;
    }>();
    taskQueryResponses.push(staleResponse.promise);
    const selectCallCount = taskSelectCalls.length;
    let staleFetch!: Promise<void>;
    act(() => {
      staleFetch = result.current.fetchDbTasks();
    });
    await waitFor(() => {
      expect(taskSelectCalls).toHaveLength(selectCallCount + 1);
    });

    rerender({ loggedIn: false });
    await waitFor(() => {
      expect(result.current.dbTasks).toEqual([]);
      expect(result.current.longTermTasks).toEqual([]);
      expect(result.current.selectedTask).toBe('');
      expect(result.current.selectedTaskId).toBeNull();
    });

    await act(async () => {
      staleResponse.resolve({
        data: [
          {
            id: 'stale-a',
            title: 'A의 늦은 작업',
            status: 'todo',
            source_subtask_id: null,
          },
        ],
        error: null,
      });
      await staleFetch;
    });

    expect(result.current.dbTasks).toEqual([]);
    expect(result.current.longTermTasks).toEqual([]);
  });

  it('switches owners while logged in and rejects the prior owner deferred response', async () => {
    const { result, rerender } = renderHook(
      ({ loggedIn }: { loggedIn: boolean }) => useTasks(loggedIn),
      { initialProps: { loggedIn: true } }
    );

    await waitFor(() => {
      expect(result.current.dbTasks[0]?.id).toBe('t1');
    });
    act(() => {
      result.current.setSelectedTask('A의 선택');
      result.current.setSelectedTaskId('t1');
    });

    const staleResponse = createDeferred<{
      data: Row[];
      error: { message: string } | null;
    }>();
    taskQueryResponses.push(staleResponse.promise);
    const selectCallCount = taskSelectCalls.length;
    let staleFetch!: Promise<void>;
    act(() => {
      staleFetch = result.current.fetchDbTasks();
    });
    await waitFor(() => {
      expect(taskSelectCalls).toHaveLength(selectCallCount + 1);
    });

    getStorageOwnerMock.mockReturnValue('user-2');
    supabaseMock.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-2' } },
    });
    taskRows = [
      {
        id: 'user-b-task',
        title: 'B의 작업',
        status: 'todo',
        source_subtask_id: null,
      },
    ];
    weeklyRows = [];
    monthlyRows = [];
    longTermRows = [];
    sessionRows = [];
    rerender({ loggedIn: true });

    await waitFor(() => {
      expect(result.current.dbTasks.map((task) => task.id)).toEqual([
        'user-b-task',
      ]);
      expect(result.current.selectedTask).toBe('');
      expect(result.current.selectedTaskId).toBeNull();
    });

    await act(async () => {
      staleResponse.resolve({
        data: [
          {
            id: 'stale-a',
            title: 'A의 늦은 작업',
            status: 'todo',
            source_subtask_id: null,
          },
        ],
        error: null,
      });
      await staleFetch;
    });

    expect(result.current.dbTasks.map((task) => task.id)).toEqual([
      'user-b-task',
    ]);
  });

  it('optimistically flips the subtask and matching daily task status', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toHaveLength(1);
    });

    const subtask = result.current.longTermTasks[0].subtasks[0];
    await act(async () => {
      await result.current.toggleSubtask(subtask);
    });

    expect(toggleSubtaskCompletionMock).toHaveBeenCalledWith(
      'user-1',
      subtask,
      expect.any(String)
    );
    expect(
      result.current.longTermTasks[0].subtasks.find((item) => item.id === 's1')
        ?.completed_at
    ).toEqual(expect.any(String));
    expect(
      result.current.dbTasks.find((task) => task.sourceSubtaskId === 's1')?.status
    ).toBe('done');
  });

  it('serializes rapid subtask toggles and exposes the pending id', async () => {
    const deferredToggle = createDeferred<void>();
    toggleSubtaskCompletionMock.mockReturnValueOnce(deferredToggle.promise);
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toHaveLength(1);
    });

    const subtask = result.current.longTermTasks[0].subtasks[0];
    let firstToggle!: Promise<void>;
    act(() => {
      firstToggle = result.current.toggleSubtask(subtask);
      void result.current.toggleSubtask(subtask);
    });

    await waitFor(() => {
      expect(toggleSubtaskCompletionMock).toHaveBeenCalledTimes(1);
    });
    expect(result.current.pendingSubtaskIds.has(subtask.id)).toBe(true);
    const exactTarget = toggleSubtaskCompletionMock.mock.calls[0][2];
    expect(exactTarget).toEqual(expect.any(String));
    expect(
      result.current.longTermTasks[0].subtasks[0].completed_at
    ).toBe(exactTarget);

    await act(async () => {
      deferredToggle.resolve();
      await firstToggle;
    });

    expect(result.current.pendingSubtaskIds.has(subtask.id)).toBe(false);
    expect(toggleSubtaskCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('refetches to roll back a failed subtask toggle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    toggleSubtaskCompletionMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.longTermTasks).toHaveLength(1);
    });

    const subtask = result.current.longTermTasks[0].subtasks[0];
    await act(async () => {
      await result.current.toggleSubtask(subtask);
    });

    await waitFor(() => {
      expect(
        result.current.longTermTasks[0].subtasks.find((item) => item.id === 's1')
          ?.completed_at
      ).toBeNull();
      expect(
        result.current.dbTasks.find((task) => task.sourceSubtaskId === 's1')
          ?.status
      ).toBe('todo');
    });
  });

  it('toggles status optimistically against the table matching the kind', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.weeklyPlans).toHaveLength(1);
    });

    const weekly: TaskItem = result.current.weeklyPlans[0];
    await act(async () => {
      await result.current.toggleTaskStatus(weekly);
    });

    expect(result.current.weeklyPlans[0].status).toBe('done');
    expect(updateCalls).toEqual([
      { table: 'weekly_plans', patch: { status: 'done' }, id: 'w1' },
    ]);
  });

  it('mirrors daily task completion and undo into the long-term subtask', async () => {
    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.dbTasks).toHaveLength(2);
    });

    await act(async () => {
      await result.current.toggleTaskStatus(result.current.dbTasks[0]);
    });
    expect(result.current.dbTasks[0].status).toBe('done');
    expect(
      result.current.longTermTasks[0].subtasks.find((item) => item.id === 's1')
        ?.completed_at
    ).toEqual(expect.any(String));

    await act(async () => {
      await result.current.toggleTaskStatus(result.current.dbTasks[0]);
    });
    expect(result.current.dbTasks[0].status).toBe('todo');
    expect(
      result.current.longTermTasks[0].subtasks.find((item) => item.id === 's1')
        ?.completed_at
    ).toBeNull();
    expect(updateCalls).toEqual([
      { table: 'tasks', patch: { status: 'done' }, id: 't1' },
      { table: 'tasks', patch: { status: 'todo' }, id: 't1' },
    ]);
  });

  it('rolls back by refetching when the status update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateError = { message: 'boom' };

    const { result } = renderHook(() => useTasks(true));

    await waitFor(() => {
      expect(result.current.dbTasks).toHaveLength(2);
    });

    await act(async () => {
      await result.current.toggleTaskStatus(result.current.dbTasks[0]);
    });

    // 낙관적 업데이트가 refetch로 되돌아간다(mock 데이터는 여전히 todo).
    await waitFor(() => {
      expect(
        result.current.dbTasks.find((task) => task.id === 't1')?.status
      ).toBe('todo');
    });
  });
});
