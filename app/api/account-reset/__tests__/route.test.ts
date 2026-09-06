import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type OwnedGroup = { id: string; name: string };
type MemberRow = { group_id: string; user_id: string };
type StorageObject = {
  metadata?: Record<string, unknown> | null;
  name: string;
  owner?: string | null;
  owner_id?: string | null;
};

type MockClientOverrides = {
  rowsByTable?: Record<string, Array<Record<string, unknown>>>;
  deleteErrors?: Record<string, unknown>;
  ownedGroups?: OwnedGroup[];
  memberRows?: MemberRow[];
  profileUpdateError?: unknown;
  authGetUserError?: unknown;
  storageListErrorAtCall?: number;
  storagePages?: StorageObject[][];
  storageRemoveErrorAtCall?: number;
};

function toBase64Url(value: string) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeServiceRoleKey(ref: string) {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(JSON.stringify({ ref }));
  return `${header}.${payload}.signature`;
}

function makeOpaqueServiceRoleKey() {
  return 'sb_secret_test_opaque_key';
}

function createMockClient(overrides: MockClientOverrides = {}) {
  let storageListCallCount = 0;
  let storageRemoveCallCount = 0;
  const state = {
    rowsByTable: structuredClone(overrides.rowsByTable ?? {}),
    deleteEqCalls: [] as Array<{ table: string; column: string; value: unknown }>,
    deleteInCalls: [] as Array<{ table: string; column: string; values: unknown[] }>,
    profileUpdateCalls: [] as Array<{
      table: string;
      column: string;
      value: unknown;
      payload: Record<string, unknown>;
    }>,
    deleteUserMock: vi.fn(async () => ({ error: null })),
    storageListCalls: [] as Array<{ path?: string; options?: Record<string, unknown> }>,
    storageListMock: vi.fn(async (path?: string, options?: Record<string, unknown>) => {
      storageListCallCount += 1;
      state.storageListCalls.push({ path, options });
      if (overrides.storageListErrorAtCall === storageListCallCount) {
        return { data: null, error: { message: 'list failed' } };
      }

      return {
        data: overrides.storagePages?.[storageListCallCount - 1] ?? [],
        error: null,
      };
    }),
    storageRemoveMock: vi.fn(async (paths: string[]) => {
      storageRemoveCallCount += 1;
      if (overrides.storageRemoveErrorAtCall === storageRemoveCallCount) {
        return { data: null, error: { message: 'remove failed' } };
      }

      return { data: paths, error: null };
    }),
  };

  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: overrides.authGetUserError ? null : { id: 'user-1' } },
        error: overrides.authGetUserError ?? null,
      })),
      admin: {
        deleteUser: state.deleteUserMock,
      },
    },
    from: vi.fn((table: string) => {
      let mode: 'select' | 'delete' | 'update' = 'select';
      let updatePayload: Record<string, unknown> = {};

      const query = {
        select: vi.fn(() => {
          mode = 'select';
          return query;
        }),
        delete: vi.fn(() => {
          mode = 'delete';
          return query;
        }),
        update: vi.fn((value: Record<string, unknown>) => {
          mode = 'update';
          updatePayload = value;
          return query;
        }),
        eq: vi.fn(async (column: string, value: unknown) => {
          if (mode === 'select') {
            if (table === 'groups') {
              return { data: overrides.ownedGroups ?? [], error: null };
            }
            throw new Error(`Unexpected select().eq() for table ${table}`);
          }

          if (mode === 'delete') {
            state.deleteEqCalls.push({ table, column, value });
            if (overrides.deleteErrors?.[table]) {
              return { error: overrides.deleteErrors[table] };
            }
            if (state.rowsByTable[table]) {
              state.rowsByTable[table] = state.rowsByTable[table].filter(
                (row) => row[column] !== value
              );
            }
            return { error: null };
          }

          state.profileUpdateCalls.push({
            table,
            column,
            value,
            payload: updatePayload,
          });
          return { error: overrides.profileUpdateError ?? null };
        }),
        in: vi.fn(async (column: string, values: unknown[]) => {
          if (mode === 'select' && table === 'group_members') {
            return { data: overrides.memberRows ?? [], error: null };
          }

          if (mode === 'delete') {
            state.deleteInCalls.push({ table, column, values });
            return { error: null };
          }

          throw new Error(`Unexpected ${mode}.in() for table ${table}`);
        }),
      };

      return query;
    }),
    storage: {
      from: vi.fn(() => ({
        list: state.storageListMock,
        remove: state.storageRemoveMock,
      })),
    },
  };

  return { client, state };
}

async function loadPostHandler(
  client: ReturnType<typeof createMockClient>['client'],
  envOverrides: {
    supabaseUrl?: string;
    serviceRoleKey?: string;
    projectRef?: string | undefined;
    allowedProjectRefs?: string | undefined;
  } = {}
) {
  vi.resetModules();
  const createClientMock = vi.fn(() => client);
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: createClientMock,
  }));

  process.env.NEXT_PUBLIC_SUPABASE_URL =
    envOverrides.supabaseUrl ?? 'https://project123.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    envOverrides.serviceRoleKey ?? makeServiceRoleKey('project123');

  if (envOverrides.projectRef === undefined) {
    process.env.SUPABASE_PROJECT_REF = 'project123';
  } else if (envOverrides.projectRef === '') {
    delete process.env.SUPABASE_PROJECT_REF;
  } else {
    process.env.SUPABASE_PROJECT_REF = envOverrides.projectRef;
  }

  if (envOverrides.allowedProjectRefs === undefined) {
    process.env.SUPABASE_ALLOWED_PROJECT_REFS = 'project123';
  } else if (envOverrides.allowedProjectRefs === '') {
    delete process.env.SUPABASE_ALLOWED_PROJECT_REFS;
  } else {
    process.env.SUPABASE_ALLOWED_PROJECT_REFS = envOverrides.allowedProjectRefs;
  }

  const routeModule = await import('../route');
  return {
    POST: routeModule.POST,
    createClientMock,
  };
}

describe('account-reset route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns 401 when the bearer token is missing', async () => {
    const { client } = createMockClient();
    const { POST, createClientMock } = await loadPostHandler(client);

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Missing auth token' });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the user leads a group with other members', async () => {
    const { client } = createMockClient({
      ownedGroups: [{ id: 'group-1', name: 'Study Group' }],
      memberRows: [{ group_id: 'group-1', user_id: 'other-user' }],
    });
    const { POST } = await loadPostHandler(client);

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'leader',
      groups: [{ id: 'group-1', name: 'Study Group' }],
    });
  });

  it('returns 401 when auth.getUser rejects the bearer token', async () => {
    const { client } = createMockClient({
      authGetUserError: { message: 'invalid token' },
    });
    const { POST } = await loadPostHandler(client);

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid auth token' });
  });

  it('accepts opaque service role keys when the configured project ref matches the URL', async () => {
    const { client } = createMockClient();
    const { POST } = await loadPostHandler(client, {
      serviceRoleKey: makeOpaqueServiceRoleKey(),
    });

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('fails closed for opaque service role keys when the configured project ref mismatches the URL', async () => {
    const { client } = createMockClient();
    const { POST, createClientMock } = await loadPostHandler(client, {
      serviceRoleKey: makeOpaqueServiceRoleKey(),
      projectRef: 'other-project',
    });

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Supabase config mismatch',
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('fails closed for unknown non-JWT service role keys', async () => {
    const { client } = createMockClient();
    const { POST, createClientMock } = await loadPostHandler(client, {
      serviceRoleKey: 'not-a-jwt-or-secret',
    });

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Supabase config mismatch',
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns 200, skips unverified objects, and resets the profile instead of deleting the auth user', async () => {
    const { client, state } = createMockClient({
      storagePages: [[
        { name: '123e4567-e89b-42d3-a456-426614174000.webp', owner: 'user-1' },
        { name: 'legacy-photo.gif', owner_id: 'user-1' },
        { name: 'other-user.png', owner: 'user-2' },
        { name: 'nested\\\\path.png', owner: 'user-1' },
      ]],
    });
    const { POST } = await loadPostHandler(client);

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    expect(state.profileUpdateCalls).toHaveLength(1);
    expect(state.profileUpdateCalls[0]).toMatchObject({
      table: 'profiles',
      column: 'id',
      value: 'user-1',
      payload: expect.objectContaining({
        status: 'offline',
        current_task: null,
        study_start_time: null,
        total_stopwatch_time: 0,
        timer_type: 'stopwatch',
        timer_mode: 'focus',
        timer_duration: 0,
        is_task_public: true,
      }),
    });
    expect(state.deleteUserMock).not.toHaveBeenCalled();
    expect(state.storageListCalls).toEqual([
      {
        path: 'user-1',
        options: {
          limit: 100,
          offset: 0,
          sortBy: { column: 'name', order: 'asc' },
        },
      },
    ]);
    expect(state.storageRemoveMock).toHaveBeenCalledWith([
      'user-1/123e4567-e89b-42d3-a456-426614174000.webp',
      'user-1/legacy-photo.gif',
    ]);
    expect(
      state.deleteEqCalls.some(
        (call) => call.table === 'study_sessions' && call.column === 'user_id'
      )
    ).toBe(true);
    expect(
      state.deleteEqCalls.some(
        (call) => call.table === 'pinned_tasks' && call.column === 'user_id'
      )
    ).toBe(true);
    expect(
      state.deleteEqCalls.some(
        (call) => call.table === 'feedback_images' && call.column === 'user_id'
      )
    ).toBe(true);
  });

  it('returns 500 and stops before database cleanup when storage removal fails', async () => {
    const { client, state } = createMockClient({
      storagePages: [[
        { name: '123e4567-e89b-42d3-a456-426614174000.webp', owner: 'user-1' },
      ]],
      storageRemoveErrorAtCall: 1,
    });
    const { POST } = await loadPostHandler(client);

    const response = await POST(
      new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
        },
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Feedback storage cleanup failed',
      retryable: true,
      storageCleanup: {
        counts: {
          eligible: 1,
          listed: 1,
          pages: 1,
          removeRequests: 1,
          removed: 0,
          skipped: 0,
        },
        ok: false,
        retryable: true,
        status: 'storage_remove_failed',
      },
    });
    expect(state.deleteEqCalls).toEqual([]);
    expect(state.profileUpdateCalls).toEqual([]);
    expect(state.deleteUserMock).not.toHaveBeenCalled();
  });

  it('clears long-term tasks, subtasks, and daily tasks only for the authenticated user', async () => {
    const otherUserRows = {
      tasks: { id: 'other-daily', user_id: 'user-2', source_subtask_id: 'other-subtask' },
      long_term_subtasks: { id: 'other-subtask', user_id: 'user-2', long_term_task_id: 'other-parent' },
      long_term_tasks: { id: 'other-parent', user_id: 'user-2', archived_at: null },
    };
    const { client, state } = createMockClient({
      rowsByTable: {
        tasks: [
          { id: 'daily-1', user_id: 'user-1', source_subtask_id: 'subtask-1' },
          otherUserRows.tasks,
        ],
        long_term_subtasks: [
          { id: 'subtask-1', user_id: 'user-1', long_term_task_id: 'parent-1', completed_at: null },
          { id: 'subtask-2', user_id: 'user-1', long_term_task_id: 'parent-2', completed_at: '2026-09-01T00:00:00Z' },
          otherUserRows.long_term_subtasks,
        ],
        long_term_tasks: [
          { id: 'parent-1', user_id: 'user-1', archived_at: null },
          { id: 'parent-2', user_id: 'user-1', archived_at: '2026-09-01T00:00:00Z' },
          otherUserRows.long_term_tasks,
        ],
      },
    });
    const { POST } = await loadPostHandler(client);
    const makeRequest = () => new NextRequest('http://localhost/api/account-reset', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      // A caller-supplied id must never override the verified token's owner.
      body: JSON.stringify({ user_id: 'user-2' }),
    });

    const response = await POST(makeRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    for (const [table, otherUserRow] of Object.entries(otherUserRows)) {
      expect(state.rowsByTable[table]).toEqual([otherUserRow]);
    }
    expect(state.deleteEqCalls.filter(call => call.table in otherUserRows)).toEqual([
      { table: 'tasks', column: 'user_id', value: 'user-1' },
      { table: 'long_term_subtasks', column: 'user_id', value: 'user-1' },
      { table: 'long_term_tasks', column: 'user_id', value: 'user-1' },
    ]);
    expect(state.profileUpdateCalls[0]).toMatchObject({ column: 'id', value: 'user-1' });
    expect(state.deleteUserMock).not.toHaveBeenCalled();

    // An already-empty account can be reset again without touching its neighbor.
    const repeatedResponse = await POST(makeRequest());
    expect(repeatedResponse.status).toBe(200);
    for (const [table, otherUserRow] of Object.entries(otherUserRows)) {
      expect(state.rowsByTable[table]).toEqual([otherUserRow]);
    }
  });

  it.each(['long_term_subtasks', 'long_term_tasks'])(
    'returns 500 instead of reporting success when deleting %s fails',
    async (table) => {
      const { client, state } = createMockClient({
        deleteErrors: { [table]: { message: 'delete failed' } },
      });
      const { POST } = await loadPostHandler(client);
      const response = await POST(new NextRequest('http://localhost/api/account-reset', {
        method: 'POST',
        headers: { authorization: 'Bearer valid-token' },
      }));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Account reset failed' });
      expect(state.deleteEqCalls.at(-1)).toEqual({ table, column: 'user_id', value: 'user-1' });
      expect(state.profileUpdateCalls).toEqual([]);
      expect(state.deleteUserMock).not.toHaveBeenCalled();
    }
  );
});
