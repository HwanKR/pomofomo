import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { toastMock, supabaseMock, routerReplaceMock } = vi.hoisted(() => ({
  toastMock: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
  supabaseMock: {
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
  routerReplaceMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: supabaseMock,
}));

vi.mock('react-hot-toast', () => ({
  default: toastMock,
}));

vi.mock('../NotificationManager', () => ({
  default: ({ mode }: { mode: string }) => (
    <div data-mode={mode} data-testid="notification-manager" />
  ),
}));

import SettingsModal from '../SettingsModal';

type SettingsShape = {
  pomoTime: number;
  shortBreak: number;
  longBreak: number;
  autoStartBreaks: boolean;
  autoStartPomos: boolean;
  longBreakInterval: number;
  volume: number;
  isMuted: boolean;
  taskPopupEnabled: boolean;
  seasonalEffectEnabled: boolean;
  seasonalTheme?: 'light' | 'dark' | 'spring';
  tasks: string[];
  presets: Array<{ id: string; label: string; minutes: number }>;
};

type SessionUser = { id: string };

type SessionShape = {
  data: {
    session: {
      user: SessionUser;
      access_token: string;
    } | null;
  };
  error: unknown;
};

const DEFAULT_SETTINGS: SettingsShape = {
  pomoTime: 25,
  shortBreak: 5,
  longBreak: 15,
  autoStartBreaks: false,
  autoStartPomos: false,
  longBreakInterval: 4,
  volume: 50,
  isMuted: false,
  taskPopupEnabled: true,
  seasonalEffectEnabled: true,
  tasks: ['국어', '수학', '영어'],
  presets: [
    { id: '1', label: '집중', minutes: 25 },
    { id: '2', label: '집중', minutes: 50 },
    { id: '3', label: '집중', minutes: 90 },
  ],
};

let userSettingsResult: { data: { settings: SettingsShape } | null };
let selectMock: ReturnType<typeof vi.fn>;
let eqMock: ReturnType<typeof vi.fn>;
let singleMock: ReturnType<typeof vi.fn>;
let upsertMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let dispatchSpy: ReturnType<typeof vi.spyOn>;
let reloadSpy: ReturnType<typeof vi.spyOn>;

function renderModal() {
  const onClose = vi.fn();
  const onSave = vi.fn();

  const view = render(
    <SettingsModal isOpen onClose={onClose} onSave={onSave} />
  );

  return { ...view, onClose, onSave };
}

function getTimeInputs(): HTMLInputElement[] {
  const section = screen.getByText(/기본 시간 설정/).closest('section');
  if (!section) {
    throw new Error('Failed to locate time settings section');
  }

  return Array.from(
    section.querySelectorAll('input[type="number"]')
  ) as HTMLInputElement[];
}

function mockUser(id: string | null) {
  supabaseMock.auth.getUser.mockResolvedValue({
    data: { user: id ? { id } : null },
  });
}

function mockSession(session: SessionShape['data']['session']) {
  supabaseMock.auth.getSession.mockResolvedValue({
    data: { session },
    error: null,
  } satisfies SessionShape);
}

function setStoredSettings(settings: Partial<SettingsShape>) {
  window.localStorage.setItem(
    'fomopomo_settings',
    JSON.stringify({
      ...DEFAULT_SETTINGS,
      ...settings,
    })
  );
}

function buildFetchResponse(
  ok: boolean,
  status: number,
  payload: Record<string, unknown>
) {
  return Promise.resolve({
    ok,
    status,
    json: async () => payload,
  });
}

function expectSettingsChangedEventDispatched() {
  expect(
    dispatchSpy.mock.calls.some((call: unknown[]) => {
      const event = call[0] as Event | undefined;
      return event instanceof Event
        ? event.type === 'settingsChanged'
        : false;
    })
  ).toBe(true);
}

describe('SettingsModal', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/before');

    userSettingsResult = { data: null };

    singleMock = vi.fn(async () => userSettingsResult);
    eqMock = vi.fn(() => ({ single: singleMock }));
    selectMock = vi.fn(() => ({ eq: eqMock }));
    upsertMock = vi.fn(async () => ({ error: null }));

    supabaseMock.from.mockImplementation((table: string) => {
      if (table === 'user_settings') {
        return {
          select: selectMock,
          upsert: upsertMock,
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    });

    mockUser(null);
    mockSession(null);
    supabaseMock.auth.signOut.mockResolvedValue({ error: null });
    routerReplaceMock.mockReset();

    toastMock.loading.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.loading.mockReturnValue('toast-id');

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    reloadSpy = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('loads remote settings on open when user settings exist', async () => {
    mockUser('user-remote');
    setStoredSettings({
      pomoTime: 31,
      tasks: ['로컬'],
      presets: [{ id: 'local', label: '로컬', minutes: 31 }],
    });
    userSettingsResult = {
      data: {
        settings: {
          ...DEFAULT_SETTINGS,
          pomoTime: 77,
          shortBreak: 13,
          longBreak: 29,
          longBreakInterval: 9,
          volume: 12,
          taskPopupEnabled: false,
          seasonalEffectEnabled: false,
          seasonalTheme: 'spring' as const,
          tasks: ['물리'],
          presets: [{ id: 'remote', label: '심화', minutes: 61 }],
        },
      },
    };

    renderModal();

    await waitFor(() => {
      expect(screen.getByDisplayValue('77')).toBeInTheDocument();
    });

    expect(screen.getByDisplayValue('13')).toBeInTheDocument();
    expect(screen.getByDisplayValue('29')).toBeInTheDocument();
    expect(screen.getByDisplayValue('물리')).toBeInTheDocument();
    expect(screen.getByDisplayValue('심화')).toBeInTheDocument();
    expect(screen.getByTestId('notification-manager')).toHaveAttribute(
      'data-mode',
      'inline'
    );
  });

  it('falls back to localStorage settings when remote settings are absent', async () => {
    setStoredSettings({
      pomoTime: 64,
      shortBreak: 8,
      longBreak: 19,
      longBreakInterval: 6,
      tasks: ['화학'],
      presets: [{ id: 'fallback', label: '복습', minutes: 64 }],
    });

    renderModal();

    await waitFor(() => {
      expect(getTimeInputs()[0]).toHaveValue(64);
    });

    expect(getTimeInputs()[1]).toHaveValue(8);
    expect(getTimeInputs()[2]).toHaveValue(19);
    expect(screen.getByDisplayValue('화학')).toBeInTheDocument();
    expect(screen.getByDisplayValue('복습')).toBeInTheDocument();
  });

  it('saves settings to localStorage, dispatches settingsChanged, and closes', async () => {
    mockUser('user-save');
    setStoredSettings({ pomoTime: 26 });

    const { onClose, onSave } = renderModal();

    // Saves are gated on the stored settings having hydrated the form.
    await waitFor(() => {
      expect(getTimeInputs()[0]).toHaveValue(26);
    });

    const [pomoInput] = getTimeInputs();
    fireEvent.change(pomoInput, { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));

    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalled();
    });

    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;

    expect(savedSettings.pomoTime).toBe(33);
    expect(upsertMock).toHaveBeenCalledWith({
      user_id: 'user-save',
      settings: expect.objectContaining({ pomoTime: 33 }),
    });
    expectSettingsChangedEventDispatched();
    expect(toastMock.success).toHaveBeenCalledWith('설정이 저장되었습니다!');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error and keeps the modal open when persisting settings fails', async () => {
    mockUser('user-save-fail');
    setStoredSettings({ pomoTime: 26 });
    upsertMock.mockImplementationOnce(async () => {
      throw new Error('save failed');
    });

    const { onClose, onSave } = renderModal();

    await waitFor(() => {
      expect(getTimeInputs()[0]).toHaveValue(26);
    });

    const [pomoInput] = getTimeInputs();
    fireEvent.change(pomoInput, { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '설정을 저장할 수 없습니다. 데이터를 복구하거나 초기화한 뒤 다시 시도해주세요.'
      );
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses without saving when the stored settings have not loaded yet', async () => {
    setStoredSettings({ pomoTime: 40 });
    // Keep the load permanently in flight.
    supabaseMock.auth.getUser.mockReturnValue(new Promise(() => {}));

    const { onClose, onSave } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // The stored settings survive: the untouched default form was never
    // persisted over them.
    expect(upsertMock).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;
    expect(savedSettings.pomoTime).toBe(40);
  });

  it('recovers cleared inputs to the stored values and clamps zeros on save', async () => {
    setStoredSettings({ pomoTime: 30 });
    mockUser('user-clamp');

    renderModal();

    // Wait for the async settings load so it cannot overwrite the form
    // edits below.
    await waitFor(() => {
      expect(getTimeInputs()[0]).toHaveValue(30);
    });

    const [pomoInput, shortBreakInput] = getTimeInputs();
    // Clearing a field is allowed while typing — no snap to 0…
    fireEvent.change(pomoInput, { target: { value: '' } });
    expect(pomoInput).toHaveValue(null);
    fireEvent.change(shortBreakInput, { target: { value: '0' } });

    const intervalRow = screen.getByText(/긴 휴식 간격/).closest('div');
    const intervalInput = intervalRow?.querySelector('input[type="number"]');
    if (!intervalInput) {
      throw new Error('Failed to locate long break interval input');
    }
    fireEvent.change(intervalInput, { target: { value: '0' } });

    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));

    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalled();
    });

    // …but the save stores sane values: a field left cleared keeps the value
    // the user already had (dismissing the modal mid-edit must never destroy
    // it), and an explicit 0 clamps to the minimum.
    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;
    expect(savedSettings.pomoTime).toBe(30);
    expect(savedSettings.shortBreak).toBe(1);
    expect(savedSettings.longBreakInterval).toBe(1);
    expect(upsertMock).toHaveBeenCalledWith({
      user_id: 'user-clamp',
      settings: expect.objectContaining({
        pomoTime: 30,
        shortBreak: 1,
        longBreakInterval: 1,
      }),
    });

    // The form reflects exactly what was stored.
    expect(getTimeInputs()[0]).toHaveValue(30);
    expect(getTimeInputs()[1]).toHaveValue(1);
  });

  it('keeps a preset whose minutes were cleared instead of saving a 1-minute preset', async () => {
    setStoredSettings({
      presets: [{ id: 'p1', label: '심화', minutes: 47 }],
    });
    mockUser('user-preset');

    renderModal();

    await waitFor(() => {
      expect(screen.getByDisplayValue('47')).toBeInTheDocument();
    });

    const presetMinutesInput = screen.getByDisplayValue('47');
    // Clearing shows an empty field, not a snap to 0…
    fireEvent.change(presetMinutesInput, { target: { value: '' } });
    expect(presetMinutesInput).toHaveValue(null);

    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));

    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalled();
    });

    // …and saving recovers the preset's previous minutes.
    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;
    expect(savedSettings.presets).toEqual([
      { id: 'p1', label: '심화', minutes: 47 },
    ]);
  });

  it('resets settings to defaults through the confirm flow', async () => {
    mockUser('user-reset-settings');
    setStoredSettings({
      pomoTime: 60,
      shortBreak: 20,
      longBreak: 30,
      tasks: ['생물'],
      presets: [{ id: 'custom', label: '커스텀', minutes: 60 }],
    });

    const { onClose, onSave } = renderModal();

    await waitFor(() => {
      expect(getTimeInputs()[0]).toHaveValue(60);
    });

    fireEvent.click(screen.getByRole('button', { name: /설정 초기화/ }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));

    await waitFor(() => {
      expect(upsertMock).toHaveBeenCalled();
    });

    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;

    expect(savedSettings).toEqual(DEFAULT_SETTINGS);
    expect(upsertMock).toHaveBeenCalledWith({
      user_id: 'user-reset-settings',
      settings: DEFAULT_SETTINGS,
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      '설정이 기본값으로 초기화되었습니다!'
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('repairs corrupt local settings during reset but stays open when remote persistence fails', async () => {
    mockUser('user-reset-fail');
    window.localStorage.setItem('fomopomo_settings', 'not-json');
    upsertMock.mockImplementationOnce(async () => {
      throw new Error('reset failed');
    });

    const { onClose, onSave } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /설정 초기화/ }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        '설정을 기본값으로 저장할 수 없습니다. 다시 시도해주세요.'
      );
    });

    const savedSettings = JSON.parse(
      window.localStorage.getItem('fomopomo_settings') ?? '{}'
    ) as SettingsShape;

    expect(savedSettings).toEqual(DEFAULT_SETTINGS);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sends the bearer token to account reset and clears local state on success', async () => {
    mockSession({
      user: { id: 'user-reset' },
      access_token: 'token-reset',
    });
    fetchMock.mockImplementation(() =>
      buildFetchResponse(true, 200, { success: true })
    );

    [
      'fomopomo_settings',
      'fomopomo_pomoTime',
      'fomopomo_initialPomoTime',
      'fomopomo_stopwatchTime',
      'fomopomo_selectedTask',
      'fomopomo_selectedTaskId',
      'fomopomo_full_state',
      'fomopomo_task_state',
      'fomopomo_notification_dismissed',
      'fomopomo_changelog_last_viewed',
    ].forEach((key) =>
      window.localStorage.setItem(
        key,
        key === 'fomopomo_settings' ? JSON.stringify(DEFAULT_SETTINGS) : 'stale'
      )
    );
    // User-scoped variants and the pending-session outbox must be cleared for
    // the resetting account only.
    window.localStorage.setItem('fomopomo_full_state::user-reset', 'stale-owned');
    window.localStorage.setItem(
      'fomopomo_pending_sessions',
      JSON.stringify({
        'draft-mine': {
          sessionId: 'draft-mine',
          rows: [{ duration: 60, user_id: 'user-reset', group_id: 'draft-mine' }],
          failedAt: 1,
        },
        'draft-other': {
          sessionId: 'draft-other',
          rows: [{ duration: 60, user_id: 'user-other', group_id: 'draft-other' }],
          failedAt: 1,
        },
      })
    );

    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /계정 초기화/ }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/account-reset', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-reset',
        },
      });
    });

    await waitFor(() => {
      expect(reloadSpy).toHaveBeenCalled();
    });

    expect(window.localStorage.getItem('fomopomo_settings')).toBeNull();
    expect(window.localStorage.getItem('fomopomo_full_state')).toBeNull();
    expect(window.localStorage.getItem('fomopomo_full_state::user-reset')).toBeNull();
    const remainingOutbox = JSON.parse(
      window.localStorage.getItem('fomopomo_pending_sessions') ?? '{}'
    );
    expect(Object.keys(remainingOutbox)).toEqual(['draft-other']);
    expect(toastMock.success).toHaveBeenCalledWith('계정 초기화 완료', {
      id: 'toast-id',
    });
  });

  it('shows the leader-conflict message for account reset failures', async () => {
    mockSession({
      user: { id: 'user-conflict' },
      access_token: 'token-conflict',
    });
    fetchMock.mockImplementation(() =>
      buildFetchResponse(false, 409, {
        groups: [{ name: '스터디 A' }],
      })
    );

    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /계정 초기화/ }));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringContaining('스터디 A'),
        expect.objectContaining({ id: 'toast-id', duration: 5000 })
      );
    });
  });

  it('sends the bearer token to account delete, signs out, and redirects home on success', async () => {
    mockSession({
      user: { id: 'user-delete' },
      access_token: 'token-delete',
    });
    fetchMock.mockImplementation(() =>
      buildFetchResponse(true, 200, { success: true })
    );
    window.localStorage.setItem(
      'fomopomo_settings',
      JSON.stringify(DEFAULT_SETTINGS)
    );

    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /계정 탈퇴/ }));
    fireEvent.click(screen.getByRole('button', { name: '탈퇴' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/account-delete', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-delete',
        },
      });
    });

    await waitFor(() => {
      expect(supabaseMock.auth.signOut).toHaveBeenCalled();
    });

    expect(window.localStorage.getItem('fomopomo_settings')).toBeNull();
    expect(routerReplaceMock).toHaveBeenCalledWith('/');
  });

  it('short-circuits account actions when there is no active session', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /계정 탈퇴/ }));
    fireEvent.click(screen.getByRole('button', { name: '탈퇴' }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('로그인 상태가 아닙니다.');
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
