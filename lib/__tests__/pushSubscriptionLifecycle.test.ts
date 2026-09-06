import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(), from: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: mocks, from: mocks.from } }));

type Row = { user_id: string; endpoint: string; keys?: unknown };
type AuthCallback = (event: string, session: { user: { id: string }; access_token: string } | null) => void;
let currentUser: string | null;
let browserSubscription: PushSubscription | null;
let rows: Map<string, Row>;
let callbacks: Set<AuthCallback>;
let operations: string[];
let subscribeGate: Promise<void> | null;
let persistGate: Promise<void> | null;
let failDelete: boolean;
let sequence: number;
let lifecycle: typeof import('../pushSubscriptionLifecycle');
let release: (() => void) | undefined;
let registration: ServiceWorkerRegistration;
let subscribe: ReturnType<typeof vi.fn>;
let closeNotification: ReturnType<typeof vi.fn>;

const keyBytes = new Uint8Array(65).fill(7);
keyBytes[0] = 4;
const session = () => currentUser ? { user: { id: currentUser }, access_token: `token-${currentUser}` } : null;
const emit = (userId: string | null, event = userId ? 'SIGNED_IN' : 'SIGNED_OUT') => {
  currentUser = userId;
  for (const callback of callbacks) callback(event, session());
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const makeSubscription = (endpoint: string) => {
  const subscription = {
    endpoint,
    options: { applicationServerKey: keyBytes.buffer.slice(0), userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { auth: 'auth-key', p256dh: 'p256dh-key' } }),
    unsubscribe: vi.fn(async () => {
      operations.push(`unsubscribe:${endpoint}`);
      if (browserSubscription === subscription) browserSubscription = null;
      return true;
    }),
  } as unknown as PushSubscription;
  return subscription;
};
const seedSubscription = (userId: string) => {
  browserSubscription = makeSubscription(`https://push.example/${userId}-existing`);
  rows.set(browserSubscription.endpoint, { user_id: userId, endpoint: browserSubscription.endpoint });
  return browserSubscription;
};
const start = () => { release = lifecycle.startPushSubscriptionLifecycle(vi.fn()); };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', Buffer.from(keyBytes).toString('base64url'));
  currentUser = 'user-a';
  browserSubscription = null;
  rows = new Map();
  callbacks = new Set();
  operations = [];
  subscribeGate = null;
  persistGate = null;
  failDelete = false;
  sequence = 0;
  release = undefined;
  mocks.getUser.mockImplementation(async () => ({ data: { user: currentUser ? { id: currentUser } : null }, error: null }));
  mocks.getSession.mockImplementation(async () => ({ data: { session: session() }, error: null }));
  mocks.onAuthStateChange.mockImplementation((callback: AuthCallback) => {
    callbacks.add(callback);
    queueMicrotask(() => { if (callbacks.has(callback)) callback('INITIAL_SESSION', session()); });
    return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
  });
  mocks.signOut.mockImplementation(async () => {
    operations.push('signOut');
    emit(null);
    return { error: null };
  });
  // Model the table's actual ownership constraints: a different account may
  // neither see nor delete another user's endpoint, and cannot upsert it.
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe('push_subscriptions');
    const filters: Array<[keyof Row, unknown]> = [];
    let deleting = false;
    const execute = async () => {
      const visible = [...rows.values()].filter(row => row.user_id === currentUser && filters.every(([key, value]) => row[key] === value));
      if (deleting) {
        if (failDelete) return { data: null, error: new Error('database unavailable') };
        for (const row of visible) {
          operations.push(`delete:${row.user_id}:${row.endpoint}`);
          rows.delete(row.endpoint);
        }
      }
      return { data: deleting ? null : visible, error: null };
    };
    const query = {
      select: vi.fn(() => query),
      delete: vi.fn(() => { deleting = true; return query; }),
      eq: vi.fn((key: keyof Row, value: unknown) => { filters.push([key, value]); return query; }),
      maybeSingle: vi.fn(async () => { const result = await execute(); return { ...result, data: result.data?.[0] ?? null }; }),
      single: vi.fn(async () => { const result = await execute(); return { ...result, data: result.data?.[0] ?? null }; }),
      then: (resolve: (result: unknown) => void, reject: (error: unknown) => void) => execute().then(resolve, reject),
      upsert: vi.fn(async (row: Row) => {
        const requestUser = currentUser;
        operations.push(`persist:start:${row.user_id}`);
        if (persistGate) await persistGate;
        const existing = rows.get(row.endpoint);
        if (!requestUser || row.user_id !== requestUser || (existing && existing.user_id !== requestUser)) {
          return { error: { code: '42501', message: 'Changing push subscription owner is not allowed' } };
        }
        rows.set(row.endpoint, { ...row });
        operations.push(`persist:done:${row.user_id}`);
        return { error: null };
      }),
    };
    return query;
  });
  subscribe = vi.fn(async () => {
    operations.push('subscribe');
    if (subscribeGate) await subscribeGate;
    browserSubscription = makeSubscription(`https://push.example/new-${++sequence}`);
    return browserSubscription;
  });
  closeNotification = vi.fn();
  registration = {
    pushManager: { getSubscription: vi.fn(async () => browserSubscription), subscribe },
    getNotifications: vi.fn(async () => [{ close: closeNotification }]),
  } as unknown as ServiceWorkerRegistration;
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });
  lifecycle = await import('../pushSubscriptionLifecycle');
});

afterEach(() => {
  release?.();
  lifecycle.__resetPushSubscriptionLifecycleForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('push subscriptions across authentication changes', () => {
  it('revokes this browser and deletes its row before signing out, preserving other devices', async () => {
    const previous = seedSubscription('user-a');
    rows.set('https://push.example/other-device', { user_id: 'user-a', endpoint: 'https://push.example/other-device' });
    await lifecycle.signOutWithPushCleanup();
    expect(previous.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browserSubscription).toBeNull();
    expect(rows.has(previous.endpoint)).toBe(false);
    expect(rows.has('https://push.example/other-device')).toBe(true);
    expect(operations.indexOf(`delete:user-a:${previous.endpoint}`)).toBeLessThan(operations.indexOf('signOut'));
    expect(operations.indexOf(`unsubscribe:${previous.endpoint}`)).toBeLessThan(operations.indexOf('signOut'));
    expect(closeNotification).toHaveBeenCalled();
  });

  it('revokes the browser endpoint even if database cleanup fails', async () => {
    const previous = seedSubscription('user-a');
    failDelete = true;
    await lifecycle.signOutWithPushCleanup();
    expect(previous.unsubscribe).toHaveBeenCalled();
    expect(browserSubscription).toBeNull();
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('still deletes the row and closes displayed notifications when browser revocation fails', async () => {
    const previous = seedSubscription('user-a');
    vi.mocked(previous.unsubscribe).mockRejectedValue(new Error('push service unavailable'));
    await lifecycle.signOutWithPushCleanup();
    expect(rows.has(previous.endpoint)).toBe(false);
    expect(closeNotification).toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('signs out without waiting for serviceWorker.ready when there is no registration', async () => {
    vi.mocked(navigator.serviceWorker.getRegistration).mockResolvedValue(undefined);
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: new Promise(() => {}), configurable: true });
    await lifecycle.signOutWithPushCleanup();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  it('can sign out while automatic registration is waiting for worker activation', async () => {
    Object.defineProperty(navigator.serviceWorker, 'ready', { value: new Promise(() => {}), configurable: true });
    start();
    await waitFor(() => expect(navigator.serviceWorker.register).toHaveBeenCalled());
    await lifecycle.signOutWithPushCleanup();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(browserSubscription).toBeNull();
  });

  it('still removes existing subscriptions when permission or VAPID configuration is unavailable', async () => {
    const previous = seedSubscription('user-a');
    vi.stubGlobal('Notification', { permission: 'denied' });
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', '');
    await lifecycle.signOutWithPushCleanup();
    expect(previous.unsubscribe).toHaveBeenCalled();
    expect(rows.has(previous.endpoint)).toBe(false);
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('cleans up an old browser subscription when opened already signed out', async () => {
    const previous = seedSubscription('user-a');
    currentUser = null;
    start();
    await waitFor(() => expect(previous.unsubscribe).toHaveBeenCalled());
    expect(browserSubscription).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('cleans up after an externally triggered sign-out without relying on old database credentials', async () => {
    const previous = seedSubscription('user-a');
    start();
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    emit(null);
    await waitFor(() => expect(previous.unsubscribe).toHaveBeenCalled());
    expect(browserSubscription).toBeNull();
    expect(rows.get(previous.endpoint)?.user_id).toBe('user-a');
  });

  it('rotates an unknown legacy endpoint before registering a different account', async () => {
    const previous = seedSubscription('user-a');
    currentUser = 'user-b';
    start();
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(previous.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browserSubscription?.endpoint).not.toBe(previous.endpoint);
    expect(rows.get(browserSubscription!.endpoint)?.user_id).toBe('user-b');
    expect(rows.get(previous.endpoint)?.user_id).toBe('user-a');
  });

  it('can replace an already inactive subscription whose unsubscribe returns false', async () => {
    const previous = seedSubscription('user-a');
    vi.mocked(previous.unsubscribe).mockImplementation(async () => { browserSubscription = null; return false; });
    currentUser = 'user-b';
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(rows.get(browserSubscription!.endpoint)?.user_id).toBe('user-b');
    expect(browserSubscription?.endpoint).not.toBe(previous.endpoint);
  });

  it('does not persist another account’s endpoint when browser revocation fails', async () => {
    const previous = seedSubscription('user-a');
    vi.mocked(previous.unsubscribe).mockRejectedValue(new Error('unsubscribe unavailable'));
    currentUser = 'user-b';
    const result = await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(result.status).toBe('unsubscribe_failed');
    expect(browserSubscription).toBe(previous);
    expect(subscribe).not.toHaveBeenCalled();
    expect(operations).not.toContain('persist:start:user-b');
  });

  it('re-registers on an account change without remounting', async () => {
    const previous = seedSubscription('user-a');
    start();
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    emit('user-b');
    await waitFor(() => expect(rows.get(browserSubscription?.endpoint ?? '')?.user_id).toBe('user-b'));
    expect(previous.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browserSubscription?.endpoint).not.toBe(previous.endpoint);
  });

  it('keeps a proven same-account endpoint across repeated sign-in and token refresh events', async () => {
    const previous = seedSubscription('user-a');
    start();
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    emit('user-a');
    emit('user-a', 'TOKEN_REFRESHED');
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(browserSubscription).toBe(previous);
    expect(previous.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('shares one auth listener and one browser subscription across two managers', async () => {
    start();
    const releaseSecond = lifecycle.startPushSubscriptionLifecycle(vi.fn());
    try {
      await Promise.all([lifecycle.syncCurrentPushSubscription(vi.fn()), lifecycle.syncCurrentPushSubscription(vi.fn())]);
      expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(1);
      release?.();
      release = undefined;
      emit(null);
      await waitFor(() => expect(browserSubscription).toBeNull());
    } finally { releaseSecond(); }
    expect(callbacks.size).toBe(0);
  });

  it('revokes a subscription created after sign-out while subscribe was in flight', async () => {
    const gate = deferred();
    subscribeGate = gate.promise;
    start();
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    emit(null);
    gate.resolve();
    await waitFor(() => expect(operations.some(item => item.startsWith('unsubscribe:'))).toBe(true));
    expect(browserSubscription).toBeNull();
    expect(rows.size).toBe(0);
  });

  it('does not transfer an in-flight old-account subscription to the new account', async () => {
    const gate = deferred();
    subscribeGate = gate.promise;
    start();
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    emit('user-b');
    gate.resolve();
    await waitFor(() => expect(rows.get(browserSubscription?.endpoint ?? '')?.user_id).toBe('user-b'));
    expect(operations).toContain('unsubscribe:https://push.example/new-1');
    expect(browserSubscription?.endpoint).toBe('https://push.example/new-2');
    expect(rows.has('https://push.example/new-1')).toBe(false);
  });

  it('finishes an in-flight persistence before logout cleanup so it cannot recreate the old row', async () => {
    const gate = deferred();
    persistGate = gate.promise;
    start();
    await waitFor(() => expect(operations).toContain('persist:start:user-a'));
    const logout = lifecycle.signOutWithPushCleanup();
    gate.resolve();
    await logout;
    expect(browserSubscription).toBeNull();
    expect([...rows.values()].some(row => row.user_id === 'user-a')).toBe(false);
    expect(operations.at(-1)).toBe('signOut');
  });

  it('does not sign out a new account that signs in while the old browser subscription is being revoked', async () => {
    const previous = seedSubscription('user-a');
    const gate = deferred();
    vi.mocked(previous.unsubscribe).mockImplementation(async () => {
      await gate.promise;
      browserSubscription = null;
      return true;
    });
    const pendingLogout = lifecycle.signOutWithPushCleanup();
    await waitFor(() => expect(previous.unsubscribe).toHaveBeenCalled());
    emit('user-b');
    gate.resolve();
    await pendingLogout;
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(currentUser).toBe('user-b');
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(rows.get(browserSubscription!.endpoint)?.user_id).toBe('user-b');
  });

  it('preserves the new login even when an old logout’s delayed cleanup rejects', async () => {
    const gate = deferred();
    vi.mocked(navigator.serviceWorker.getRegistration).mockImplementation(async () => {
      await gate.promise;
      throw new Error('registration lookup failed');
    });
    const pendingLogout = lifecycle.signOutWithPushCleanup();
    await waitFor(() => expect(navigator.serviceWorker.getRegistration).toHaveBeenCalled());
    emit('user-b');
    gate.resolve();
    await pendingLogout;
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(currentUser).toBe('user-b');
  });

  it('does not force sign-out when the final account verification fails', async () => {
    const currentSession = { data: { session: session() }, error: null };
    mocks.getSession.mockResolvedValueOnce(currentSession)
      .mockResolvedValueOnce(currentSession)
      .mockRejectedValueOnce(new Error('could not verify current account'));
    await expect(lifecycle.signOutWithPushCleanup()).rejects.toThrow('could not verify current account');
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it('does not let an obsolete sign-out event revoke the new active account', async () => {
    start();
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    emit(null);
    emit('user-b');
    await lifecycle.syncCurrentPushSubscription(vi.fn());
    expect(rows.get(browserSubscription!.endpoint)?.user_id).toBe('user-b');
  });

  it('rechecks the active account after waiting for another tab to release the browser lock', async () => {
    const gate = deferred();
    const request = vi.fn(async (...args: unknown[]) => {
      await gate.promise;
      return (args.at(-1) as () => unknown)();
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    start();
    await waitFor(() => expect(request).toHaveBeenCalled());
    emit('user-b');
    gate.resolve();
    await waitFor(() => expect(rows.get(browserSubscription?.endpoint ?? '')?.user_id).toBe('user-b'));
    expect([...rows.values()].some(row => row.user_id === 'user-a')).toBe(false);
  });
});
