import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

import LongTermTasks, {
  computeReorderedSubtasks,
  persistSubtaskPositions,
} from '../LongTermTasks';

type TaskRow = {
  id: string;
  title: string;
  position: number;
};

type SubtaskRow = {
  id: string;
  long_term_task_id: string;
  title: string;
  position: number;
  completed_at: string | null;
};

type UpdateResult = { error: { message: string } | null };

let longTermTasks: TaskRow[];
let subtasks: SubtaskRow[];

// long_term_subtasks.update 결과 큐. 비어 있으면 즉시 성공을 돌려주고,
// 테스트가 지연/실패/거부를 밀어 넣어 롤백 경로를 재현한다.
let subtaskUpdateResultFactories: Array<() => Promise<UpdateResult>>;

// long_term_tasks.insert 결과를 한 번 가로채기 위한 훅 (중복 생성 테스트용).
let nextTaskInsert:
  | (() => Promise<{ data: TaskRow; error: null }>)
  | null;

// true면 fetch(order()) 응답을 pendingFetchResolvers로 미뤄서
// 늦게 도착하는 낡은 refetch를 재현할 수 있다.
let deferFetch: boolean;
let pendingFetchResolvers: Array<() => void>;

type ChannelHandler = {
  event: string;
  config: Record<string, unknown>;
  callback: () => void;
};

type ChannelMock = {
  topic: string;
  handlers: ChannelHandler[];
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
};

let channelMocks: ChannelMock[];

function createChannelMock(topic: string): ChannelMock {
  const channel: ChannelMock = {
    topic,
    handlers: [],
    on: vi.fn(
      (event: string, config: Record<string, unknown>, callback: () => void) => {
        channel.handlers.push({ event, config, callback });
        return channel;
      }
    ),
    subscribe: vi.fn(() => channel),
  };

  return channel;
}

function getChannelMock(topic: string) {
  const channel = channelMocks.find((current) => current.topic === topic);
  if (!channel) {
    throw new Error(`Channel not created: ${topic}`);
  }
  return channel;
}

async function fireRealtime(topic: string) {
  const channel = getChannelMock(topic);
  await act(async () => {
    channel.handlers.forEach((handler) => handler.callback());
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// eq/neq 필터를 몇 번을 거치든 await 시점에 id 필터로 저장소에 patch를
// 적용하는 thenable 체인. 결과가 에러면 저장소는 건드리지 않아 서버
// 실패를 흉내 낸다.
function createUpdateChain(
  applyPatch: (idValue: unknown) => void,
  getResult: () => Promise<UpdateResult> = () => Promise.resolve({ error: null })
) {
  const filters: Array<[string, unknown]> = [];
  const chain = {
    eq: vi.fn((field: string, value: unknown) => {
      filters.push([field, value]);
      return chain;
    }),
    neq: vi.fn(() => chain),
    then: <TResult1 = UpdateResult, TResult2 = never>(
      onFulfilled?:
        | ((value: UpdateResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) => {
      const idFilter = filters.find(([field]) => field === 'id');
      return getResult()
        .then((result) => {
          if (!result.error && idFilter) {
            applyPatch(idFilter[1]);
          }
          return result;
        })
        .then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function buildFetchRows() {
  return longTermTasks.map((task) => ({
    ...task,
    long_term_subtasks: subtasks
      .filter((subtask) => subtask.long_term_task_id === task.id)
      .map(({ id, title, position, completed_at }) => ({
        id,
        title,
        position,
        completed_at,
      })),
  }));
}

let tasksTable: {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let subtasksTable: {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function renderTasks() {
  return render(<LongTermTasks userId="user-1" />);
}

function getRowForTitle(title: string) {
  const label = screen.getByText(title);
  const row = label.parentElement;
  if (!row) {
    throw new Error(`Unable to locate row for ${title}`);
  }

  return row;
}

// 세부 할 일 행의 버튼: [드래그 핸들(role=button), 완료 토글, 수정, 삭제]
const SUBTASK_TOGGLE = 1;
const SUBTASK_EDIT = 2;
const SUBTASK_DELETE = 3;

describe('LongTermTasks', () => {
  beforeEach(() => {
    window.localStorage.clear();

    longTermTasks = [{ id: 'task-1', title: '빅데이터분석기사', position: 0 }];
    subtasks = [
      {
        id: 'subtask-1',
        long_term_task_id: 'task-1',
        title: '챕터 1',
        position: 0,
        completed_at: '2026-03-18T03:00:00.000Z',
      },
      {
        id: 'subtask-2',
        long_term_task_id: 'task-1',
        title: '챕터 2',
        position: 1,
        completed_at: null,
      },
    ];

    subtaskUpdateResultFactories = [];
    nextTaskInsert = null;
    deferFetch = false;
    pendingFetchResolvers = [];
    channelMocks = [];

    supabaseMock.channel.mockImplementation((topic: string) => {
      const channel = createChannelMock(topic);
      channelMocks.push(channel);
      return channel;
    });
    supabaseMock.removeChannel.mockReset();

    tasksTable = {
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            order: vi.fn(() => {
              // 스냅샷은 요청 시점의 저장소 상태다. 지연 모드에서는 낡은
              // 응답이 늦게 도착하는 상황을 테스트가 직접 연출한다.
              const snapshot = buildFetchRows();
              if (!deferFetch) {
                return Promise.resolve({ data: snapshot, error: null });
              }
              return new Promise((resolve) => {
                pendingFetchResolvers.push(() =>
                  resolve({ data: snapshot, error: null })
                );
              });
            }),
          })),
        })),
      })),
      insert: vi.fn(
        (payload: { user_id: string; title: string; position: number }) => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => {
              if (nextTaskInsert) {
                const resolveInsert = nextTaskInsert;
                nextTaskInsert = null;
                return resolveInsert();
              }
              const created = {
                id: `task-${longTermTasks.length + 1}`,
                title: payload.title,
                position: payload.position,
              };
              longTermTasks = [...longTermTasks, created];
              return { data: created, error: null };
            }),
          })),
        })
      ),
      update: vi.fn((patch: Partial<TaskRow>) => ({
        eq: vi.fn(async (_field: string, id: string) => {
          longTermTasks = longTermTasks.map((task) =>
            task.id === id ? { ...task, ...patch } : task
          );
          return { error: null };
        }),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn(async (_field: string, id: string) => {
          longTermTasks = longTermTasks.filter((task) => task.id !== id);
          subtasks = subtasks.filter(
            (subtask) => subtask.long_term_task_id !== id
          );
          return { error: null };
        }),
      })),
    };

    subtasksTable = {
      insert: vi.fn(
        (payload: {
          user_id: string;
          long_term_task_id: string;
          title: string;
          position: number;
        }) => ({
          select: vi.fn(() => ({
            single: vi.fn(async () => {
              const created = {
                id: `subtask-${subtasks.length + 1}`,
                long_term_task_id: payload.long_term_task_id,
                title: payload.title,
                position: payload.position,
                completed_at: null,
              };
              subtasks = [...subtasks, created];
              return {
                data: {
                  id: created.id,
                  title: created.title,
                  position: created.position,
                  completed_at: created.completed_at,
                },
                error: null,
              };
            }),
          })),
        })
      ),
      update: vi.fn((patch: Partial<SubtaskRow>) =>
        createUpdateChain(
          (id) => {
            subtasks = subtasks.map((subtask) =>
              subtask.id === id ? { ...subtask, ...patch } : subtask
            );
          },
          () =>
            (subtaskUpdateResultFactories.shift() ??
              (() => Promise.resolve({ error: null })))()
        )
      ),
      delete: vi.fn(() => ({
        eq: vi.fn(async (_field: string, id: string) => {
          subtasks = subtasks.filter((subtask) => subtask.id !== id);
          return { error: null };
        }),
      })),
    };

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'long_term_tasks') return tasksTable;
      if (table === 'long_term_subtasks') return subtasksTable;

      if (table === 'tasks') {
        // toggleSubtaskCompletion이 오늘 구체화된 일일 작업을 best-effort로
        // 동기화하는 경로. 이 테스트에서는 성공 응답만 필요하다.
        return {
          update: vi.fn(() => createUpdateChain(() => {})),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders long term tasks with chapter progress', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();
    expect(screen.getByText('챕터 1')).toBeInTheDocument();
    expect(screen.getByText('챕터 2')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('챕터 1')).toHaveClass('line-through');
    expect(screen.getByText(/3월 18일/)).toBeInTheDocument();
  });

  it('adds a new long term task', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /장기 과제 추가/i }));
    fireEvent.change(
      screen.getByPlaceholderText('장기 과제를 입력하세요 (예: 빅데이터분석기사)'),
      { target: { value: 'SQLD' } }
    );
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    await waitFor(() => {
      expect(screen.getByText('SQLD')).toBeInTheDocument();
    });
  });

  it('adds a chapter to a long term task', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /세부 할 일 추가/i }));
    fireEvent.change(screen.getByPlaceholderText('세부 할 일을 입력하세요'), {
      target: { value: '챕터 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    await waitFor(() => {
      expect(screen.getByText('챕터 3')).toBeInTheDocument();
    });
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('edits a long term task title on Enter', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    const row = getRowForTitle('빅데이터분석기사');
    fireEvent.click(within(row).getAllByRole('button')[0]);

    const input = within(row).getByDisplayValue('빅데이터분석기사');
    fireEvent.change(input, { target: { value: '정보처리기사' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('정보처리기사')).toBeInTheDocument();
    });
  });

  it('deletes a long term task after confirmation', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    const row = getRowForTitle('빅데이터분석기사');
    fireEvent.click(within(row).getAllByRole('button')[1]);

    expect(
      screen.getByText(
        '이 장기 과제를 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
    });
  });

  it('keeps the task when the delete confirmation is cancelled', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    const row = getRowForTitle('빅데이터분석기사');
    fireEvent.click(within(row).getAllByRole('button')[1]);

    expect(
      screen.getByText(
        '이 장기 과제를 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(
      screen.queryByText(
        '이 장기 과제를 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다.'
      )
    ).not.toBeInTheDocument();
    expect(screen.getByText('빅데이터분석기사')).toBeInTheDocument();
    expect(tasksTable.delete).not.toHaveBeenCalled();
    expect(longTermTasks).toHaveLength(1);
  });

  it('completes a chapter and records completed_at', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const row = getRowForTitle('챕터 2');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_TOGGLE]);

    await waitFor(() => {
      expect(screen.getByText('챕터 2')).toHaveClass('line-through');
    });
    expect(screen.getByText('2/2')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-2')?.completed_at
      ).not.toBeNull();
    });
  });

  it('clears completed_at when a completed chapter is toggled back', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 1')).toBeInTheDocument();

    const row = getRowForTitle('챕터 1');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_TOGGLE]);

    await waitFor(() => {
      expect(screen.getByText('챕터 1')).not.toHaveClass('line-through');
    });
    expect(screen.getByText('0/2')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-1')?.completed_at
      ).toBeNull();
    });
  });

  it('renames a chapter through the inline editor', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const row = getRowForTitle('챕터 2');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_EDIT]);

    const input = screen.getByDisplayValue('챕터 2');
    fireEvent.change(input, { target: { value: '챕터 2 심화' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('챕터 2 심화')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-2')?.title
      ).toBe('챕터 2 심화');
    });
  });

  it('deletes a chapter after confirmation', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const row = getRowForTitle('챕터 2');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_DELETE]);

    expect(
      screen.getByText(
        '이 세부 할 일을 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다.'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(screen.queryByText('챕터 2')).not.toBeInTheDocument();
    });
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(subtasks.find((subtask) => subtask.id === 'subtask-2')).toBeUndefined();
  });

  it('starts the chapter edit draft from the latest title after a realtime rename', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    // 다른 탭이 제목을 바꿔 realtime refetch가 반영된 상황.
    subtasks = subtasks.map((subtask) =>
      subtask.id === 'subtask-2' ? { ...subtask, title: '챕터 2 (개정)' } : subtask
    );
    await fireRealtime('long-term-subtask-updates');
    expect(await screen.findByText('챕터 2 (개정)')).toBeInTheDocument();

    const row = getRowForTitle('챕터 2 (개정)');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_EDIT]);

    expect(screen.getByDisplayValue('챕터 2 (개정)')).toBeInTheDocument();
  });

  it('subscribes filtered per-user channels, refetches on events, and removes them on unmount', async () => {
    const { unmount } = renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    expect(supabaseMock.channel).toHaveBeenCalledWith('long-term-task-updates');
    expect(supabaseMock.channel).toHaveBeenCalledWith(
      'long-term-subtask-updates'
    );

    const taskChannel = getChannelMock('long-term-task-updates');
    const subtaskChannel = getChannelMock('long-term-subtask-updates');

    expect(taskChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'long_term_tasks',
        filter: 'user_id=eq.user-1',
      },
      expect.any(Function)
    );
    expect(subtaskChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'long_term_subtasks',
        filter: 'user_id=eq.user-1',
      },
      expect.any(Function)
    );
    expect(taskChannel.subscribe).toHaveBeenCalled();
    expect(subtaskChannel.subscribe).toHaveBeenCalled();

    // 이벤트 콜백이 refetch로 이어져 다른 탭의 변경이 화면에 나타난다.
    longTermTasks = [
      ...longTermTasks,
      { id: 'task-2', title: 'SQLD', position: 1 },
    ];
    await fireRealtime('long-term-task-updates');
    expect(await screen.findByText('SQLD')).toBeInTheDocument();

    unmount();
    expect(supabaseMock.removeChannel).toHaveBeenCalledTimes(2);
    expect(supabaseMock.removeChannel).toHaveBeenCalledWith(taskChannel);
    expect(supabaseMock.removeChannel).toHaveBeenCalledWith(subtaskChannel);
  });

  it('ignores a stale refetch that resolves after a newer one', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    deferFetch = true;

    // 낡은 refetch가 먼저 시작해 옛 제목을 스냅샷으로 들고 있다.
    await fireRealtime('long-term-task-updates');
    expect(pendingFetchResolvers).toHaveLength(1);

    longTermTasks = [{ id: 'task-1', title: '정보처리기사', position: 0 }];
    await fireRealtime('long-term-task-updates');
    expect(pendingFetchResolvers).toHaveLength(2);

    // 새 refetch가 먼저 도착한다.
    await act(async () => {
      pendingFetchResolvers[1]();
    });
    expect(await screen.findByText('정보처리기사')).toBeInTheDocument();

    // 낡은 refetch가 늦게 도착해도 최신 상태를 덮어쓰지 못한다.
    await act(async () => {
      pendingFetchResolvers[0]();
    });
    expect(screen.getByText('정보처리기사')).toBeInTheDocument();
    expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
  });

  it('keeps a committed toggle when a stale refetch resolves after it', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    // 토글보다 먼저 시작한 refetch가 미완료 상태를 스냅샷으로 들고 있다.
    // realtime 이벤트로 시작된 refetch가 로딩 화면을 그리기 전에 같은
    // 프레임의 클릭이 도착한 상황을 하나의 act 안에서 재현한다.
    deferFetch = true;
    const row = getRowForTitle('챕터 2');
    const staleChannel = getChannelMock('long-term-subtask-updates');
    await act(async () => {
      staleChannel.handlers.forEach((handler) => handler.callback());
      fireEvent.click(within(row).getAllByRole('button')[SUBTASK_TOGGLE]);
    });
    expect(pendingFetchResolvers).toHaveLength(1);

    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-2')?.completed_at
      ).not.toBeNull();
    });

    // 낡은 refetch가 늦게 도착해도 커밋된 완료 상태를 덮어쓰지 못한다.
    await act(async () => {
      pendingFetchResolvers[0]();
    });
    expect(screen.getByText('챕터 2')).toHaveClass('line-through');
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('keeps a committed chapter rename when a stale refetch resolves after it', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const row = getRowForTitle('챕터 2');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_EDIT]);
    const input = screen.getByDisplayValue('챕터 2');
    fireEvent.change(input, { target: { value: '챕터 2 심화' } });

    // 저장 직전에 시작한 refetch가 옛 제목을 스냅샷으로 들고 있다.
    deferFetch = true;
    const staleChannel = getChannelMock('long-term-subtask-updates');
    await act(async () => {
      staleChannel.handlers.forEach((handler) => handler.callback());
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(pendingFetchResolvers).toHaveLength(1);

    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-2')?.title
      ).toBe('챕터 2 심화');
    });

    // 낡은 refetch가 늦게 도착해도 커밋된 제목을 덮어쓰지 못한다.
    await act(async () => {
      pendingFetchResolvers[0]();
    });
    expect(screen.getByText('챕터 2 심화')).toBeInTheDocument();
    expect(screen.queryByText('챕터 2')).not.toBeInTheDocument();
  });

  it('does not resurrect a deleted task when a stale refetch resolves after it', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    // 삭제 확인 모달은 로딩 중에도 떠 있으므로, refetch가 진행 중인 채로
    // 삭제를 확정하는 흐름이 실제로 가능하다.
    const row = getRowForTitle('빅데이터분석기사');
    fireEvent.click(within(row).getAllByRole('button')[1]);

    deferFetch = true;
    await fireRealtime('long-term-task-updates');
    expect(pendingFetchResolvers).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));

    await waitFor(() => {
      expect(longTermTasks).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getByText('아직 장기 과제가 없어요.')).toBeInTheDocument();
    });

    // 낡은 refetch가 늦게 도착해도 지운 과제를 되살리지 못한다.
    await act(async () => {
      pendingFetchResolvers[0]();
    });
    expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
  });

  it('clears the previous owner\'s list synchronously when userId changes', async () => {
    const { rerender } = renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    // 새 사용자의 초기 fetch는 아직 시작 전(setTimeout)이다. 렌더만으로
    // 이전 사용자의 목록이 남아 있으면 안 된다.
    deferFetch = true;
    longTermTasks = [{ id: 'task-9', title: '유저2 과제', position: 0 }];
    subtasks = [];

    rerender(<LongTermTasks userId="user-2" />);

    expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
    expect(screen.getByText('불러오는 중...')).toBeInTheDocument();

    // 새 사용자의 초기 fetch는 정상적으로 반영된다.
    await waitFor(() => {
      expect(pendingFetchResolvers).toHaveLength(1);
    });
    await act(async () => {
      pendingFetchResolvers[0]();
    });
    expect(await screen.findByText('유저2 과제')).toBeInTheDocument();
    expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
  });

  it('drops the previous owner\'s in-flight fetch when userId changes', async () => {
    const { rerender } = renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    // 이전 사용자의 refetch가 진행 중인 채로 소유자가 바뀐다.
    deferFetch = true;
    await fireRealtime('long-term-task-updates');
    expect(pendingFetchResolvers).toHaveLength(1);

    longTermTasks = [{ id: 'task-9', title: '유저2 과제', position: 0 }];
    subtasks = [];

    // 새 사용자의 초기 fetch(setTimeout)를 얼려 두고, 그 전에 이전
    // 사용자의 낡은 응답이 먼저 도착하는 틈을 재현한다.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      rerender(<LongTermTasks userId="user-2" />);

      expect(pendingFetchResolvers).toHaveLength(1);
      await act(async () => {
        pendingFetchResolvers[0]();
      });
      // 이전 사용자의 데이터가 새 사용자 화면에 그려지지 않는다.
      expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
      expect(screen.getByText('불러오는 중...')).toBeInTheDocument();

      // 새 사용자의 초기 fetch를 진행시킨다.
      await act(async () => {
        vi.runOnlyPendingTimers();
      });
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() => {
      expect(pendingFetchResolvers).toHaveLength(2);
    });
    await act(async () => {
      pendingFetchResolvers[1]();
    });
    expect(await screen.findByText('유저2 과제')).toBeInTheDocument();
    expect(screen.queryByText('빅데이터분석기사')).not.toBeInTheDocument();
  });

  it('does not duplicate a created task the realtime refetch already delivered', async () => {
    renderTasks();

    expect(await screen.findByText('빅데이터분석기사')).toBeInTheDocument();

    const deferredInsert = createDeferred<{ data: TaskRow; error: null }>();
    nextTaskInsert = () => deferredInsert.promise;

    fireEvent.click(screen.getByRole('button', { name: /장기 과제 추가/i }));
    fireEvent.change(
      screen.getByPlaceholderText('장기 과제를 입력하세요 (예: 빅데이터분석기사)'),
      { target: { value: 'SQLD' } }
    );
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    // insert 응답이 오기 전에 realtime refetch가 생성된 행을 먼저 반영한다.
    longTermTasks = [
      ...longTermTasks,
      { id: 'task-2', title: 'SQLD', position: 1 },
    ];
    await fireRealtime('long-term-task-updates');
    expect(await screen.findByText('SQLD')).toBeInTheDocument();

    await act(async () => {
      deferredInsert.resolve({
        data: { id: 'task-2', title: 'SQLD', position: 1 },
        error: null,
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText('SQLD')).toHaveLength(1);
    });
  });

  it('disables the toggle while pending and rolls back when the write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const deferredUpdate = createDeferred<UpdateResult>();
    subtaskUpdateResultFactories.push(() => deferredUpdate.promise);

    const row = getRowForTitle('챕터 2');
    fireEvent.click(within(row).getAllByRole('button')[SUBTASK_TOGGLE]);

    // 낙관적 완료 표시가 먼저 그려지고, 쓰기가 끝날 때까지 토글은 잠긴다.
    await waitFor(() => {
      expect(screen.getByText('챕터 2')).toHaveClass('line-through');
    });
    expect(
      within(getRowForTitle('챕터 2')).getAllByRole('button')[SUBTASK_TOGGLE]
    ).toBeDisabled();

    await act(async () => {
      deferredUpdate.resolve({ error: { message: 'update failed' } });
    });

    await waitFor(() => {
      expect(screen.getByText('챕터 2')).not.toHaveClass('line-through');
    });
    expect(
      subtasks.find((subtask) => subtask.id === 'subtask-2')?.completed_at
    ).toBeNull();
    await waitFor(() => {
      expect(
        within(getRowForTitle('챕터 2')).getAllByRole('button')[SUBTASK_TOGGLE]
      ).not.toBeDisabled();
    });
  });

  it('serializes rapid double toggles into a single write', async () => {
    renderTasks();

    expect(await screen.findByText('챕터 2')).toBeInTheDocument();

    const deferredUpdate = createDeferred<UpdateResult>();
    subtaskUpdateResultFactories.push(() => deferredUpdate.promise);

    const row = getRowForTitle('챕터 2');
    const toggle = within(row).getAllByRole('button')[SUBTASK_TOGGLE];
    // 재렌더 전에 두 번 눌러도 두 번째 클릭은 무시되어야 한다.
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(subtasksTable.update).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferredUpdate.resolve({ error: null });
    });

    await waitFor(() => {
      expect(
        subtasks.find((subtask) => subtask.id === 'subtask-2')?.completed_at
      ).not.toBeNull();
    });
    expect(subtasksTable.update).toHaveBeenCalledTimes(1);
    expect(screen.getByText('챕터 2')).toHaveClass('line-through');
  });
});

describe('computeReorderedSubtasks', () => {
  const list = [
    { id: 'a', title: 'A', position: 0, completed_at: null },
    { id: 'b', title: 'B', position: 1, completed_at: null },
    { id: 'c', title: 'C', position: 2, completed_at: null },
  ];

  it('moves the dragged subtask and reindexes every position', () => {
    const result = computeReorderedSubtasks(list, 'c', 'a');

    expect(result?.map((subtask) => [subtask.id, subtask.position])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
    // 입력 배열은 그대로 남는다.
    expect(list.map((subtask) => subtask.position)).toEqual([0, 1, 2]);
  });

  it('returns null when the drop changes nothing or an id is unknown', () => {
    expect(computeReorderedSubtasks(list, 'a', 'a')).toBeNull();
    expect(computeReorderedSubtasks(list, 'ghost', 'a')).toBeNull();
    expect(computeReorderedSubtasks(list, 'a', 'ghost')).toBeNull();
  });
});

describe('persistSubtaskPositions', () => {
  beforeEach(() => {
    subtasks = [
      {
        id: 'subtask-1',
        long_term_task_id: 'task-1',
        title: '챕터 1',
        position: 0,
        completed_at: null,
      },
      {
        id: 'subtask-2',
        long_term_task_id: 'task-1',
        title: '챕터 2',
        position: 1,
        completed_at: null,
      },
    ];
    subtaskUpdateResultFactories = [];

    subtasksTable = {
      insert: vi.fn(),
      update: vi.fn((patch: Partial<SubtaskRow>) =>
        createUpdateChain(
          (id) => {
            subtasks = subtasks.map((subtask) =>
              subtask.id === id ? { ...subtask, ...patch } : subtask
            );
          },
          () =>
            (subtaskUpdateResultFactories.shift() ??
              (() => Promise.resolve({ error: null })))()
        )
      ),
      delete: vi.fn(),
    };

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'long_term_subtasks') return subtasksTable;
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes every reordered position and reports success', async () => {
    const result = await persistSubtaskPositions([
      { id: 'subtask-2', position: 0 },
      { id: 'subtask-1', position: 1 },
    ]);

    expect(result).toBe(true);
    expect(subtasksTable.update).toHaveBeenCalledTimes(2);
    expect(subtasksTable.update).toHaveBeenCalledWith({ position: 0 });
    expect(subtasksTable.update).toHaveBeenCalledWith({ position: 1 });
    expect(
      subtasks.find((subtask) => subtask.id === 'subtask-2')?.position
    ).toBe(0);
    expect(
      subtasks.find((subtask) => subtask.id === 'subtask-1')?.position
    ).toBe(1);
  });

  it('reports failure when any position write returns an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    subtaskUpdateResultFactories.push(
      () => Promise.resolve({ error: null }),
      () => Promise.resolve({ error: { message: 'position write failed' } })
    );

    const result = await persistSubtaskPositions([
      { id: 'subtask-2', position: 0 },
      { id: 'subtask-1', position: 1 },
    ]);

    expect(result).toBe(false);
  });

  it('reports failure when a position write rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    subtaskUpdateResultFactories.push(() =>
      Promise.reject(new Error('network down'))
    );

    const result = await persistSubtaskPositions([
      { id: 'subtask-1', position: 0 },
    ]);

    expect(result).toBe(false);
  });
});
