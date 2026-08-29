import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { supabaseMock } = vi.hoisted(() => ({
  supabaseMock: {
    auth: {
      getUser: vi.fn(),
    },
    from: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

import {
  DEFAULT_FOMOPOMO_SETTINGS,
  DEFAULT_TASK_OPTIONS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_KEY,
  getSettingsStorageKey,
  loadPersistedSettings,
  loadTaskOptions,
  normalizeSettings,
  persistSettings,
  readSettingsSnapshot,
  resetSettingsSnapshot,
  writeSettingsSnapshot,
  type FomopomoSettings,
} from '../settingsStore';

type UserSettingsResult = {
  data: { settings: Partial<FomopomoSettings> } | null;
  error?: { code?: string } | null;
};

const TEST_USER_A = 'user-a';
const TEST_USER_B = 'user-b';
const TOKEN_KEY = 'sb-testproj-auth-token';

describe('settingsStore', () => {
  const upsertMock = vi.fn();
  let userSettingsResult: UserSettingsResult;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  let selectMock: ReturnType<typeof vi.fn>;
  let eqMock: ReturnType<typeof vi.fn>;
  let singleMock: ReturnType<typeof vi.fn>;

  const signInLocally = (userId: string) => {
    window.localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ access_token: 'token', user: { id: userId } })
    );
  };

  const signOutLocally = () => {
    window.localStorage.removeItem(TOKEN_KEY);
  };

  const setAuthenticatedUser = (userId: string | null) => {
    supabaseMock.auth.getUser.mockResolvedValue({
      data: { user: userId ? { id: userId } : null },
    });
  };

  const setStoredSettings = (
    owner: string,
    settings: Partial<FomopomoSettings>,
    rawOverride?: string
  ) => {
    if (rawOverride !== undefined) {
      window.localStorage.setItem(getSettingsStorageKey(owner), rawOverride);
      return;
    }

    const payload =
      owner === 'guest' ? settings : { ...settings, ownerUserId: owner };
    window.localStorage.setItem(
      getSettingsStorageKey(owner),
      JSON.stringify(payload)
    );
  };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://testproj.supabase.co');
    window.localStorage.clear();

    upsertMock.mockReset();
    supabaseMock.auth.getUser.mockReset();
    supabaseMock.from.mockReset();

    userSettingsResult = { data: null, error: null };
    singleMock = vi.fn(async () => userSettingsResult);
    eqMock = vi.fn(() => ({ single: singleMock }));
    selectMock = vi.fn(() => ({ eq: eqMock }));

    supabaseMock.from.mockReturnValue({
      select: selectMock,
      upsert: upsertMock,
    });
    setAuthenticatedUser(null);

    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('uses 집중 for every default preset label', () => {
    expect(DEFAULT_FOMOPOMO_SETTINGS.presets.map((preset) => preset.label)).toEqual(
      ['집중', '집중', '집중']
    );
  });

  it('normalizes missing seasonal effect, tasks, and presets from canonical defaults', () => {
    expect(
      normalizeSettings({
        pomoTime: 40,
        shortBreak: 8,
        tasks: [],
        presets: [],
      })
    ).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 40,
      shortBreak: 8,
    });
  });

  describe('numeric validation', () => {
    it('clamps zero and negative values up to their minimums', () => {
      expect(
        normalizeSettings({
          pomoTime: 0,
          shortBreak: 0,
          longBreak: -3,
          longBreakInterval: 0,
          volume: -5,
        })
      ).toEqual({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 1,
        shortBreak: 1,
        longBreak: 1,
        longBreakInterval: 1,
        volume: 0,
      });
    });

    it('recovers NaN and non-numeric values to defaults', () => {
      expect(
        normalizeSettings({
          pomoTime: Number.NaN,
          shortBreak: '10' as unknown as number,
          longBreak: 'abc' as unknown as number,
          longBreakInterval: Number.POSITIVE_INFINITY,
          volume: null as unknown as number,
        })
      ).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
    });

    it('rounds fractional values and clamps runaway numbers to sane caps', () => {
      expect(
        normalizeSettings({
          pomoTime: 25.6,
          shortBreak: 1e9,
          longBreakInterval: 1000,
          volume: 250,
        })
      ).toEqual({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 26,
        shortBreak: 999,
        longBreakInterval: 99,
        volume: 100,
      });
    });

    it('sanitizes preset minutes the same way', () => {
      expect(
        normalizeSettings({
          presets: [
            { id: '1', label: '즉시 완료', minutes: 0 },
            { id: '2', label: '깨진 값', minutes: Number.NaN },
            { id: '3', label: '정상', minutes: 50 },
          ],
        }).presets
      ).toEqual([
        { id: '1', label: '즉시 완료', minutes: 1 },
        { id: '2', label: '깨진 값', minutes: 25 },
        { id: '3', label: '정상', minutes: 50 },
      ]);
    });

    it('survives null preset entries in persisted data instead of crashing the snapshot read', () => {
      setStoredSettings('guest', {
        ...DEFAULT_FOMOPOMO_SETTINGS,
        presets: [null, { id: 'ok', label: '생존', minutes: 40 }] as unknown as
          FomopomoSettings['presets'],
      });

      expect(readSettingsSnapshot().presets).toEqual([
        { id: 'ok', label: '생존', minutes: 40 },
      ]);

      setStoredSettings('guest', {
        ...DEFAULT_FOMOPOMO_SETTINGS,
        presets: [null] as unknown as FomopomoSettings['presets'],
      });

      expect(readSettingsSnapshot().presets).toEqual(
        DEFAULT_FOMOPOMO_SETTINGS.presets
      );
    });

    it('sanitizes corrupt remote settings on load', async () => {
      signInLocally(TEST_USER_A);
      setAuthenticatedUser(TEST_USER_A);
      userSettingsResult = {
        data: {
          settings: {
            ...DEFAULT_FOMOPOMO_SETTINGS,
            pomoTime: 0,
            longBreakInterval: 0,
          },
        },
        error: null,
      };

      await expect(loadPersistedSettings()).resolves.toEqual({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 1,
        longBreakInterval: 1,
      });
    });
  });

  it('falls back to canonical defaults when persisted JSON is invalid', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    setStoredSettings('guest', {}, 'not-json');

    expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('blocks writes while the current owner storage is still corrupted', () => {
    setStoredSettings('guest', {}, 'not-json');

    expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);

    const didWrite = writeSettingsSnapshot({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 60,
    });

    expect(didWrite).toBe(false);
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe('not-json');
    expect(readSettingsSnapshot()).toMatchObject({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 60,
    });
  });

  it('keeps corruption tracking scoped to the active owner key', () => {
    setStoredSettings('guest', {}, 'not-json');
    expect(writeSettingsSnapshot({ ...DEFAULT_FOMOPOMO_SETTINGS, pomoTime: 60 })).toBe(
      false
    );

    signInLocally(TEST_USER_A);

    expect(
      writeSettingsSnapshot({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 30,
      })
    ).toBe(true);

    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe('not-json');
    expect(
      JSON.parse(
        window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
      )
    ).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 30,
      ownerUserId: TEST_USER_A,
    });
  });

  it('writes normalized settings locally and dispatches the shared event', () => {
    expect(
      writeSettingsSnapshot({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        seasonalEffectEnabled: false,
        tasks: [],
        presets: [],
      })
    ).toBe(true);

    expect(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}')).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      seasonalEffectEnabled: false,
    });
    expect(
      dispatchSpy.mock.calls.some((call: unknown[]) => {
        const event = call[0] as Event | undefined;
        return event instanceof Event
          ? event.type === SETTINGS_CHANGED_EVENT
          : false;
      })
    ).toBe(true);
  });

  it('prefers remote persisted settings over the scoped local snapshot when authenticated', async () => {
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    userSettingsResult = {
      data: {
        settings: {
          ...DEFAULT_FOMOPOMO_SETTINGS,
          pomoTime: 77,
          seasonalEffectEnabled: false,
          tasks: ['work'],
        },
      },
      error: null,
    };

    setStoredSettings(TEST_USER_A, {
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 33,
      tasks: ['local work'],
    });

    await expect(loadPersistedSettings()).resolves.toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 77,
      seasonalEffectEnabled: false,
      tasks: ['work'],
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
      )
    ).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 77,
      seasonalEffectEnabled: false,
      tasks: ['work'],
      ownerUserId: TEST_USER_A,
    });
  });

  it('refreshes the active scoped snapshot from remote settings even when local data is corrupt', async () => {
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    setStoredSettings(TEST_USER_A, {}, 'not-json');
    userSettingsResult = {
      data: {
        settings: {
          ...DEFAULT_FOMOPOMO_SETTINGS,
          pomoTime: 88,
          longBreakInterval: 12,
        },
      },
      error: null,
    };

    await expect(loadPersistedSettings()).resolves.toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 88,
      longBreakInterval: 12,
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
      )
    ).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 88,
      longBreakInterval: 12,
      ownerUserId: TEST_USER_A,
    });
  });

  it('falls back to the local snapshot when remote persisted settings are absent', async () => {
    setStoredSettings('guest', {
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 64,
      tasks: ['local work'],
    });

    await expect(loadPersistedSettings()).resolves.toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      pomoTime: 64,
      tasks: ['local work'],
    });
  });

  it('preserves remote -> local -> default precedence for task options', async () => {
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    setStoredSettings(TEST_USER_A, {
      ...DEFAULT_FOMOPOMO_SETTINGS,
      tasks: ['local work'],
    });

    userSettingsResult = {
      data: { settings: { tasks: ['remote work'] } },
      error: null,
    };
    await expect(loadTaskOptions()).resolves.toEqual(['remote work']);

    userSettingsResult = {
      data: { settings: { tasks: [] } },
      error: null,
    };
    await expect(loadTaskOptions()).resolves.toEqual(['local work']);

    window.localStorage.removeItem(getSettingsStorageKey(TEST_USER_A));
    await expect(loadTaskOptions()).resolves.toEqual(DEFAULT_TASK_OPTIONS);
  });

  describe('account-scoped storage', () => {
    it('writes authenticated settings under a user-scoped key with an owner stamp', () => {
      signInLocally(TEST_USER_A);

      writeSettingsSnapshot({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 30,
      });

      expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
      expect(
        JSON.parse(
          window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
        )
      ).toEqual({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 30,
        ownerUserId: TEST_USER_A,
      });
    });

    it('does not leak guest settings into a newly authenticated account', async () => {
      setStoredSettings('guest', {
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 99,
      });

      signInLocally(TEST_USER_B);

      expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
      await expect(loadPersistedSettings()).resolves.toEqual(
        DEFAULT_FOMOPOMO_SETTINGS
      );
    });

    it('keeps settings isolated between accounts and the guest namespace', () => {
      signInLocally(TEST_USER_A);
      writeSettingsSnapshot({ ...DEFAULT_FOMOPOMO_SETTINGS, pomoTime: 30 });
      expect(readSettingsSnapshot().pomoTime).toBe(30);

      signInLocally(TEST_USER_B);
      expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
      writeSettingsSnapshot({ ...DEFAULT_FOMOPOMO_SETTINGS, pomoTime: 45 });
      expect(readSettingsSnapshot().pomoTime).toBe(45);

      signInLocally(TEST_USER_A);
      expect(readSettingsSnapshot().pomoTime).toBe(30);

      signOutLocally();
      expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
    });
  });

  it('writes locally before remote upsert during async persistence', async () => {
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    upsertMock.mockImplementation(async () => {
      expect(
        JSON.parse(
          window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
        )
      ).toEqual(
        expect.objectContaining({
          pomoTime: 45,
          seasonalEffectEnabled: false,
          ownerUserId: TEST_USER_A,
        })
      );

      return { error: null };
    });

    await expect(
      persistSettings({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 45,
        seasonalEffectEnabled: false,
      })
    ).resolves.toBe(true);

    expect(upsertMock).toHaveBeenCalledWith({
      user_id: TEST_USER_A,
      settings: expect.objectContaining({
        pomoTime: 45,
        seasonalEffectEnabled: false,
      }),
    });
  });

  it('returns false and skips remote upsert when local persistence is blocked by corruption', async () => {
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    setStoredSettings(TEST_USER_A, {}, 'not-json');

    await expect(
      persistSettings({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 42,
      })
    ).resolves.toBe(false);

    expect(window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A))).toBe(
      'not-json'
    );
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('returns false when the remote upsert returns an error result', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    signInLocally(TEST_USER_A);
    setAuthenticatedUser(TEST_USER_A);
    upsertMock.mockResolvedValueOnce({
      error: { message: 'remote write failed' },
    });

    await expect(
      persistSettings({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 42,
      })
    ).resolves.toBe(false);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to persist settings',
      expect.objectContaining({ message: 'remote write failed' })
    );

    consoleErrorSpy.mockRestore();
  });

  it('returns false when local storage rejects the write', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: originalLocalStorage.getItem.bind(originalLocalStorage),
        setItem: vi.fn(() => {
          throw new Error('quota exceeded');
        }),
        removeItem: originalLocalStorage.removeItem.bind(originalLocalStorage),
        clear: originalLocalStorage.clear.bind(originalLocalStorage),
        key: originalLocalStorage.key.bind(originalLocalStorage),
        get length() {
          return originalLocalStorage.length;
        },
      } satisfies Storage,
    });

    expect(
      writeSettingsSnapshot({
        ...DEFAULT_FOMOPOMO_SETTINGS,
        pomoTime: 42,
      })
    ).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to persist settings locally',
      expect.any(Error)
    );

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
    consoleErrorSpy.mockRestore();
  });

  it('restores canonical defaults when explicitly reset', () => {
    signInLocally(TEST_USER_A);
    setStoredSettings(TEST_USER_A, {}, 'corrupt-reset-json');

    expect(readSettingsSnapshot()).toEqual(DEFAULT_FOMOPOMO_SETTINGS);
    expect(resetSettingsSnapshot()).toBe(true);
    expect(
      JSON.parse(
        window.localStorage.getItem(getSettingsStorageKey(TEST_USER_A)) ?? '{}'
      )
    ).toEqual({
      ...DEFAULT_FOMOPOMO_SETTINGS,
      ownerUserId: TEST_USER_A,
    });
  });
});
