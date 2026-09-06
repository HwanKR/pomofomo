import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskList from '../TaskList';

const mocks = vi.hoisted(() => ({ from: vi.fn(), channel: vi.fn(), removeChannel: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: mocks }));

type Row = Record<string, unknown>;
type Result = { data: Row[] | Row | null; error: { message: string } | null };
type Query = {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete';
  filters: Array<[string, unknown[]]>;
  payload?: Row | Row[];
  single: boolean;
};
type Channel = { topic: string; callbacks: Array<() => void> };
const DAY_A = new Date(2026, 8, 6);
const DAY_B = new Date(2026, 8, 7);
let rows: Record<string, Row[]>;
let queries: Query[];
let channels: Channel[];
let intercept: ((query: Query) => Promise<Result> | undefined) | null;
let nextId: number;

const deferred = () => {
  let resolve!: (value: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const matches = (row: Row, query: Query) => query.filters.every(([column, values]) => values.includes(row[column]));
const selectRows = (query: Query) => structuredClone((rows[query.table] ?? []).filter(row => matches(row, query)));
const success = (data: Result['data']): Result => ({ data, error: null });
const task = (id: string, title: string, userId = 'user-1', day = '2026-09-06', source: string | null = null): Row => ({
  id, title, user_id: userId, due_date: day, source_subtask_id: source,
  status: 'todo', position: 0, estimated_pomodoros: 0,
});
const mount = (date = DAY_A, userId = 'user-1') => render(<TaskList selectedDate={date} userId={userId} />);
const view = (date = DAY_A, userId = 'user-1') => <TaskList selectedDate={date} userId={userId} />;
const emit = async (channel = channels.at(-2)!) => {
  await act(async () => { channel.callbacks.forEach(callback => callback()); });
};
const addTask = (title: string) => {
  fireEvent.click(screen.getByRole('button', { name: '작업 추가' }));
  fireEvent.change(screen.getByPlaceholderText('작업 제목을 입력하세요'), { target: { value: title } });
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
};
const taskRow = (title: string) => screen.getByText(title).closest('.group') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 6, 12));
  rows = {
    tasks: [task('a-task', '9월 6일 작업'), task('b-task', '9월 7일 작업', 'user-1', '2026-09-07')],
    pinned_tasks: [], long_term_subtasks: [], study_sessions: [],
  };
  queries = [];
  channels = [];
  intercept = null;
  nextId = 0;
  mocks.channel.mockImplementation((topic: string) => {
    const channel = {
      topic, callbacks: [] as Array<() => void>,
      on: vi.fn((_event: string, _filter: unknown, callback: () => void) => { channel.callbacks.push(callback); return channel; }),
      subscribe: vi.fn(() => channel),
    };
    channels.push(channel);
    return channel;
  });
  mocks.from.mockImplementation((table: string) => {
    const request: Query = { table, action: 'select', filters: [], single: false };
    const execute = async (): Promise<Result> => {
      queries.push(request);
      const intercepted = intercept?.(request);
      if (intercepted) return intercepted;
      if (request.action === 'insert') {
        const payloads = Array.isArray(request.payload) ? request.payload : [request.payload!];
        const inserted = payloads.map(payload => ({ id: `inserted-${++nextId}`, ...payload }));
        rows[table] = [...(rows[table] ?? []), ...inserted];
        return success(request.single ? inserted[0] : inserted);
      }
      if (request.action === 'delete') {
        rows[table] = (rows[table] ?? []).filter(row => !matches(row, request));
        return success(null);
      }
      if (request.action === 'update') {
        rows[table] = (rows[table] ?? []).map(row => matches(row, request) ? { ...row, ...request.payload } : row);
        return success(null);
      }
      return success(selectRows(request));
    };
    const query = {
      select: vi.fn(() => query),
      insert: vi.fn((payload: Row | Row[]) => { request.action = 'insert'; request.payload = payload; return query; }),
      update: vi.fn((payload: Row) => { request.action = 'update'; request.payload = payload; return query; }),
      delete: vi.fn(() => { request.action = 'delete'; return query; }),
      eq: vi.fn((column: string, value: unknown) => { request.filters.push([column, [value]]); return query; }),
      in: vi.fn((column: string, values: unknown[]) => { request.filters.push([column, values]); return query; }),
      order: vi.fn(() => query),
      single: vi.fn(() => { request.single = true; return query; }),
      then: (resolve: (result: Result) => void, reject: (error: unknown) => void) => execute().then(resolve, reject),
    };
    return query;
  });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('TaskList request ownership', () => {
  it('loads the selected day with its parent title and only the owner’s study duration', async () => {
    rows.tasks[0].source_subtask_id = 'sub-a';
    rows.long_term_subtasks = [{ id: 'sub-a', long_term_tasks: { title: '장기 과제 A' } }];
    rows.study_sessions = [
      { user_id: 'user-1', task_id: 'a-task', duration: 120 },
      { user_id: 'user-2', task_id: 'a-task', duration: 3600 },
    ];
    render(<StrictMode>{view()}</StrictMode>);
    expect(await screen.findByText('9월 6일 작업')).toBeInTheDocument();
    expect(screen.getByText('장기 과제 A')).toBeInTheDocument();
    expect(screen.getByText('2m')).toBeInTheDocument();
    expect(screen.queryByText('9월 7일 작업')).not.toBeInTheDocument();
  });

  it.each(['tasks', 'long_term_subtasks', 'study_sessions'])('ignores an old date response delayed at %s', async (table) => {
    rows.tasks[0].source_subtask_id = 'sub-a';
    rows.long_term_subtasks = [{ id: 'sub-a', long_term_tasks: { title: '이전 날짜 과제' } }];
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.action === 'select' && query.table === table) {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    const { rerender } = mount();
    await waitFor(() => expect(captured).toBeDefined());
    rerender(view(DAY_B));
    expect(await screen.findByText('9월 7일 작업')).toBeInTheDocument();
    await act(async () => pending.resolve(success(captured!)));
    expect(screen.getByText('9월 7일 작업')).toBeInTheDocument();
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
    expect(screen.queryByText('이전 날짜 과제')).not.toBeInTheDocument();
  });

  it('clears the old date immediately while the next date is loading', async () => {
    const { rerender } = mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    intercept = query => query.table === 'tasks' && query.action === 'select' ? pending.promise : undefined;
    rerender(view(DAY_B));
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
    expect(screen.getByText('작업을 불러오는 중...')).toBeInTheDocument();
    await act(async () => pending.resolve(success([rows.tasks[1]])));
    expect(await screen.findByText('9월 7일 작업')).toBeInTheDocument();
  });

  it.each(['', 'user-2'])('discards the previous user’s delayed list after changing userId to %s', async (nextUser) => {
    rows.tasks.push(task('other-task', '다른 사용자 작업', 'user-2'));
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    const { rerender } = mount();
    await waitFor(() => expect(captured).toBeDefined());
    rerender(view(DAY_A, nextUser));
    if (nextUser) await screen.findByText('다른 사용자 작업');
    await act(async () => pending.resolve(success(captured!)));
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
    if (nextUser) expect(screen.getByText('다른 사용자 작업')).toBeInTheDocument();
  });

  it('does not reuse a response from the first visit when returning to the same date', async () => {
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    const { rerender } = mount();
    await waitFor(() => expect(captured).toBeDefined());
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    rows.tasks[0].title = '새로 갱신된 9월 6일 작업';
    rerender(view(DAY_A));
    await screen.findByText('새로 갱신된 9월 6일 작업');
    await act(async () => pending.resolve(success(captured!)));
    expect(screen.getByText('새로 갱신된 9월 6일 작업')).toBeInTheDocument();
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
  });

  it('keeps the newest realtime response for the same user and date', async () => {
    mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    await emit();
    rows.tasks[0].title = '최신 제목';
    await emit();
    await screen.findByText('최신 제목');
    await act(async () => pending.resolve(success(captured!)));
    expect(screen.getByText('최신 제목')).toBeInTheDocument();
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
  });

  it('does not fetch through a removed realtime subscription', async () => {
    const { rerender } = mount();
    await screen.findByText('9월 6일 작업');
    const previousChannel = channels[0];
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    const queryCount = queries.length;
    await emit(previousChannel);
    expect(queries).toHaveLength(queryCount);
    expect(screen.getByText('9월 7일 작업')).toBeInTheDocument();
  });

  it('does not create old-date pinned tasks after an earlier lookup finishes', async () => {
    rows.pinned_tasks = [{ id: 'pin-a', user_id: 'user-1', title: '고정 작업', position: 0 }];
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'pinned_tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    const { rerender } = mount();
    await waitFor(() => expect(captured).toBeDefined());
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    await act(async () => pending.resolve(success(captured!)));
    const insertedRows = queries.filter(query => query.action === 'insert').flatMap(query => Array.isArray(query.payload) ? query.payload : [query.payload!]);
    expect(insertedRows.length).toBeGreaterThan(0);
    expect(insertedRows.every(row => row.due_date === '2026-09-07')).toBe(true);
    expect(screen.getByText('9월 7일 작업')).toBeInTheDocument();
  });

  it('does not append an old add response or clear the new date’s draft', async () => {
    const { rerender } = mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    intercept = query => query.table === 'tasks' && query.action === 'insert' ? pending.promise : undefined;
    addTask('이전 날짜 추가');
    await waitFor(() => expect(queries.some(query => query.action === 'insert')).toBe(true));
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    fireEvent.click(screen.getByRole('button', { name: '작업 추가' }));
    fireEvent.change(screen.getByPlaceholderText('작업 제목을 입력하세요'), { target: { value: '새 날짜 초안' } });
    await act(async () => pending.resolve(success(task('old-insert', '이전 날짜 추가'))));
    expect(screen.queryByText('이전 날짜 추가')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('새 날짜 초안')).toBeInTheDocument();
  });

  it('does not refetch an old date when its optimistic status update fails late', async () => {
    const { rerender } = mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    intercept = query => query.table === 'tasks' && query.action === 'update' ? pending.promise : undefined;
    fireEvent.click(within(taskRow('9월 6일 작업')).getAllByRole('button')[1]);
    await waitFor(() => expect(queries.some(query => query.action === 'update')).toBe(true));
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    const queryCount = queries.length;
    await act(async () => pending.resolve({ data: null, error: { message: 'update failed' } }));
    expect(queries).toHaveLength(queryCount);
    expect(screen.getByText('9월 7일 작업')).toBeInTheDocument();
    expect(screen.queryByText('9월 6일 작업')).not.toBeInTheDocument();
  });

  it('does not let a pre-mutation fetch undo a local completion', async () => {
    mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    await emit();
    fireEvent.click(within(taskRow('9월 6일 작업')).getAllByRole('button')[1]);
    await waitFor(() => expect(screen.getByText('9월 6일 작업')).toHaveClass('line-through'));
    await act(async () => pending.resolve(success(captured!)));
    expect(screen.getByText('9월 6일 작업')).toHaveClass('line-through');
  });

  it('discards the previous user’s pinned-list response', async () => {
    rows.tasks = [task('a-task', '공통 작업'), task('b-task', '공통 작업', 'user-2')];
    const oldPin = { id: 'pin-a', title: '공통 작업', user_id: 'user-1', position: 0 };
    rows.pinned_tasks = [oldPin];
    const pending = deferred();
    intercept = query => query.table === 'pinned_tasks' && query.filters.some(([column, values]) => column === 'user_id' && values.includes('user-1'))
      ? pending.promise : undefined;
    const { rerender } = mount();
    await waitFor(() => expect(queries.filter(query => query.table === 'pinned_tasks')).toHaveLength(2));
    rerender(view(DAY_A, 'user-2'));
    await screen.findByText('공통 작업');
    await act(async () => pending.resolve(success([oldPin])));
    expect(screen.getByTitle('작업 고정')).toBeInTheDocument();
    expect(screen.queryByTitle('작업 고정 해제')).not.toBeInTheDocument();
  });

  it('discards a previous user’s late pin creation response', async () => {
    rows.tasks = [task('a-task', '공통 작업'), task('b-task', '공통 작업', 'user-2')];
    const { rerender } = mount();
    await screen.findByText('공통 작업');
    const pending = deferred();
    intercept = query => query.table === 'pinned_tasks' && query.action === 'insert' ? pending.promise : undefined;
    fireEvent.click(screen.getByTitle('작업 고정'));
    await waitFor(() => expect(queries.some(query => query.table === 'pinned_tasks' && query.action === 'insert')).toBe(true));
    rerender(view(DAY_A, 'user-2'));
    await screen.findByText('공통 작업');
    await act(async () => pending.resolve(success({ id: 'pin-a', title: '공통 작업', position: 0 })));
    expect(screen.getByTitle('작업 고정')).toBeInTheDocument();
    expect(screen.queryByTitle('작업 고정 해제')).not.toBeInTheDocument();
  });

  it('does not apply an already-sent automatic insert after changing dates', async () => {
    rows.pinned_tasks = [{ id: 'pin-a', user_id: 'user-1', title: '자동 고정 작업', position: 0 }];
    const pending = deferred();
    let blocked = false;
    intercept = query => {
      if (!blocked && query.table === 'tasks' && query.action === 'insert') {
        blocked = true;
        return pending.promise;
      }
    };
    const { rerender } = mount();
    await waitFor(() => expect(blocked).toBe(true));
    rerender(view(DAY_B));
    await screen.findByText('9월 7일 작업');
    const queryCount = queries.length;
    await act(async () => pending.resolve(success([task('old-auto', '이전 날짜 자동 작업')])));
    expect(queries).toHaveLength(queryCount);
    expect(screen.getByText('9월 7일 작업')).toBeInTheDocument();
    expect(screen.queryByText('이전 날짜 자동 작업')).not.toBeInTheDocument();
  });

  it('stops follow-up requests and queued realtime callbacks after unmount', async () => {
    const pending = deferred();
    let captured: Row[] | undefined;
    intercept = query => {
      if (!captured && query.table === 'tasks' && query.action === 'select') {
        captured = selectRows(query);
        return pending.promise;
      }
    };
    const { unmount } = mount();
    await waitFor(() => expect(captured).toBeDefined());
    const previousChannel = channels[0];
    unmount();
    const queryCount = queries.length;
    await emit(previousChannel);
    await act(async () => pending.resolve(success(captured!)));
    expect(queries).toHaveLength(queryCount);
  });

  it('preserves a successful current-date add while realtime arrives during the insert', async () => {
    mount();
    await screen.findByText('9월 6일 작업');
    const pending = deferred();
    intercept = query => query.table === 'tasks' && query.action === 'insert' ? pending.promise : undefined;
    addTask('새 작업');
    await waitFor(() => expect(queries.some(query => query.action === 'insert')).toBe(true));
    const inserted = task('new-task', '새 작업');
    rows.tasks.push(inserted);
    await emit();
    await act(async () => pending.resolve(success(inserted)));
    expect(await screen.findByText('새 작업')).toBeInTheDocument();
    expect(screen.getAllByText('새 작업')).toHaveLength(1);
    expect(screen.getByText('9월 6일 작업')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('작업 제목을 입력하세요')).not.toBeInTheDocument();
  });

  it('refreshes after a realtime event and local mutation start in the same render batch', async () => {
    mount();
    await screen.findByText('9월 6일 작업');
    rows.tasks.push(task('external-task', '다른 탭에서 추가한 작업'));
    const toggle = within(taskRow('9월 6일 작업')).getAllByRole('button')[1];
    await act(async () => {
      channels[0].callbacks.forEach(callback => callback());
      fireEvent.click(toggle);
    });
    expect(await screen.findByText('다른 탭에서 추가한 작업')).toBeInTheDocument();
    expect(screen.getByText('9월 6일 작업')).toHaveClass('line-through');
  });
});
