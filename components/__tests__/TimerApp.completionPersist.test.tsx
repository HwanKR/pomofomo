import { render, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import TimerApp from '../TimerApp';

// Regression tests for the stale post-completion storage state:
// handleTimerComplete used to leave "running focus with an expired deadline
// plus the old interval start" in localStorage, so a refresh during the break
// resurrected the save button and re-saved the already-recorded session
// inflated by the break time. Completion must persist the clean break state,
// and the popup path must park the record in the outbox before the modal
// opens so a refresh cannot lose it.

const mocks = vi.hoisted(() => ({
  timerDisplayProps: [] as Record<string, unknown>[],
  taskModalProps: [] as Record<string, unknown>[],
  playAlarm: vi.fn(),
  playClickSound: vi.fn(),
  updateStatus: vi.fn(),
  createPendingRecord: vi.fn(),
  savePendingRecord: vi.fn(),
  currentIntervalStartRef: { current: null as number | null },
  stopwatchStartTimeRef: { current: null as number | null },
  settings: {
    pomoTime: 25,
    shortBreak: 5,
    longBreak: 15,
    longBreakInterval: 4,
    autoStartPomos: false,
    autoStartBreaks: false,
    volume: 0.5,
    isMuted: true,
    taskPopupEnabled: false,
    seasonalEffectEnabled: false,
    tasks: [] as string[],
    presets: [],
  },
  useSettingsResult: null as Record<string, unknown> | null,
  useSoundResult: null as Record<string, unknown> | null,
  useTasksResult: null as Record<string, unknown> | null,
  useStudySessionResult: null as Record<string, unknown> | null,
  useStopwatchLogicResult: null as Record<string, unknown> | null,
}));

mocks.useSettingsResult = {
  settings: mocks.settings,
  // The real setSettings writes the settings store synchronously; mirror
  // that by mutating the shared settings object, so the mocked
  // readSettingsSnapshot() sees the update immediately like production.
  setSettings: vi.fn((value: unknown) => {
    const next =
      typeof value === 'function'
        ? (value as (prev: typeof mocks.settings) => typeof mocks.settings)(
            mocks.settings
          )
        : (value as typeof mocks.settings);
    Object.assign(mocks.settings, next);
  }),
  persistSettings: vi.fn(),
};

mocks.useSoundResult = {
  playAlarm: mocks.playAlarm,
  playClickSound: mocks.playClickSound,
};

mocks.useTasksResult = {
  dbTasks: [],
  weeklyPlans: [],
  monthlyPlans: [],
  selectedTask: '',
  selectedTaskId: null,
  setSelectedTask: vi.fn(),
  setSelectedTaskId: vi.fn(),
  getSelectedTaskTitle: () => '',
};

mocks.useStudySessionResult = {
  isSaving: false,
  intervals: [],
  setIntervals: vi.fn(),
  currentIntervalStartRef: mocks.currentIntervalStartRef,
  updateStatus: mocks.updateStatus,
  createPendingRecord: mocks.createPendingRecord,
  savePendingRecord: mocks.savePendingRecord,
  checkActiveSession: vi.fn(),
};

mocks.useStopwatchLogicResult = {
  stopwatchTime: 0,
  isStopwatchRunning: false,
  setIsStopwatchRunning: vi.fn(),
  setStopwatchTime: vi.fn(),
  toggleStopwatch: vi.fn(),
  resetStopwatch: vi.fn(),
  stopwatchStartTimeRef: mocks.stopwatchStartTimeRef,
};

vi.mock('@/components/timer/hooks/useSettings', () => ({
  useSettings: () => mocks.useSettingsResult,
}));

// TimerApp reads the persisted settings synchronously through the store for
// restore-time decisions; route that to the same mock settings object.
vi.mock('@/components/timer/hooks/settingsStore', () => ({
  readSettingsSnapshot: () => mocks.settings,
}));

vi.mock('@/components/timer/hooks/useSound', () => ({
  useSound: () => mocks.useSoundResult,
}));

vi.mock('@/components/timer/hooks/useTasks', () => ({
  useTasks: () => mocks.useTasksResult,
  TASK_STATE_KEY: 'fomopomo_task_state',
}));

vi.mock('@/components/timer/hooks/useStudySession', () => ({
  useStudySession: () => mocks.useStudySessionResult,
  MIN_SAVABLE_SECONDS: 10,
}));

vi.mock('@/components/timer/hooks/useStopwatchLogic', () => ({
  useStopwatchLogic: () => mocks.useStopwatchLogicResult,
}));

vi.mock('@/components/TaskSidebar', () => ({
  default: () => null,
}));

vi.mock('@/components/timer/ui/TaskModal', () => ({
  TaskModal: (props: Record<string, unknown>) => {
    mocks.taskModalProps.push(props);
    return null;
  },
}));

vi.mock('@/components/timer/ui/TimerDisplay', () => ({
  TimerDisplay: (props: Record<string, unknown>) => {
    mocks.timerDisplayProps.push(props);
    return null;
  },
}));

vi.mock('@/components/timer/ui/StopwatchDisplay', () => ({
  StopwatchDisplay: () => null,
}));

vi.mock('@/components/timer/ui/ThemeBackground', () => ({
  ThemeBackground: () => null,
}));

vi.mock('react-hot-toast', () => {
  const toastFn = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  });
  return { default: toastFn };
});

const seedTimerState = (overrides: {
  mode?: string;
  isRunning?: boolean;
  secondsLeft?: number;
  targetTime?: number | null;
  loggedSeconds?: number;
  intervals?: { start: number; end: number }[];
  currentIntervalStart?: number | null;
  configuredDurations?: { focus: number; shortBreak: number; longBreak: number };
  cycleCount?: number;
  lastUpdated?: number;
}) => {
  const now = Date.now();
  const isRunning = overrides.isRunning ?? true;
  const secondsLeft = overrides.secondsLeft ?? 3;
  window.localStorage.setItem(
    'fomopomo_full_state',
    JSON.stringify({
      activeTab: 'timer',
      timer: {
        mode: overrides.mode ?? 'focus',
        isRunning,
        timeLeft: secondsLeft,
        targetTime:
          overrides.targetTime !== undefined
            ? overrides.targetTime
            : isRunning
              ? now + secondsLeft * 1000
              : null,
        cycleCount: overrides.cycleCount ?? 0,
        loggedSeconds: overrides.loggedSeconds ?? 0,
      },
      stopwatch: { isRunning: false, elapsed: 0, startTime: null },
      intervals: overrides.intervals ?? [],
      currentIntervalStart:
        overrides.currentIntervalStart !== undefined
          ? overrides.currentIntervalStart
          : isRunning
            ? now
            : null,
      configuredDurations: overrides.configuredDurations,
      lastUpdated: overrides.lastUpdated ?? now,
    })
  );
};

const seedRunningFocusTimer = (secondsLeft: number) => seedTimerState({ secondsLeft });

const savedFullState = () =>
  JSON.parse(window.localStorage.getItem('fomopomo_full_state') as string);

const fakeRecord = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'record-1',
  ownerId: 'user-1',
  mode: 'pomo',
  duration: 25 * 60,
  forcedEndTime: 0,
  segments: [{ index: 0, duration: 25 * 60, ended_at: '2026-08-09T12:00:00.000Z' }],
  ...overrides,
});

describe('TimerApp completion persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createPendingRecord.mockImplementation((mode: string, duration: number, forcedEndTime?: number) =>
      fakeRecord({ mode, duration, forcedEndTime })
    );
    mocks.savePendingRecord.mockResolvedValue('saved');
    mocks.timerDisplayProps.length = 0;
    mocks.taskModalProps.length = 0;
    mocks.currentIntervalStartRef.current = null;
    mocks.settings.taskPopupEnabled = false;
    mocks.settings.pomoTime = 25;
    mocks.settings.shortBreak = 5;
    mocks.settings.longBreak = 15;
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('creates and saves the record once at completion, stamped with the real end time', async () => {
    seedRunningFocusTimer(3);

    render(
      <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
    );

    await act(async () => {
      vi.advanceTimersByTime(3400);
    });

    // The record was created once (freezing content + parking durably) with
    // the timer's real end time, then saved unlabeled.
    expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
    expect(mocks.createPendingRecord).toHaveBeenCalledWith(
      'pomo',
      25 * 60,
      expect.any(Number)
    );
    expect(mocks.savePendingRecord).toHaveBeenCalledTimes(1);
    expect(mocks.savePendingRecord).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pomo', duration: 25 * 60 }),
      '',
      null
    );

    // Storage now holds the post-completion state: a stopped break with no
    // expired deadline, no leftover interval start, and nothing loggable —
    // restoring this state cannot show a save button for the saved session.
    const saved = savedFullState();
    expect(saved.timer.mode).toBe('shortBreak');
    expect(saved.timer.isRunning).toBe(false);
    expect(saved.timer.targetTime).toBeNull();
    expect(saved.timer.timeLeft).toBe(5 * 60);
    expect(saved.timer.loggedSeconds).toBe(0);
    expect(saved.timer.cycleCount).toBe(1);
    expect(saved.intervals).toEqual([]);
    expect(saved.currentIntervalStart).toBeNull();
    // The snapshot is stamped with its settings era so a later restore can
    // tell "untouched idle" apart from partial progress.
    expect(saved.configuredDurations).toEqual({
      focus: 25 * 60,
      shortBreak: 5 * 60,
      longBreak: 15 * 60,
    });
  });

  it('hands the created record to the task popup instead of saving immediately', async () => {
    mocks.settings.taskPopupEnabled = true;
    seedRunningFocusTimer(3);

    render(
      <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
    );

    await act(async () => {
      vi.advanceTimersByTime(3400);
    });

    // The popup path still creates (and thereby durably parks) the record,
    // but defers the labeled save to the user's answer.
    expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
    expect(mocks.savePendingRecord).not.toHaveBeenCalled();

    // The clean break state is persisted on this path too.
    const saved = savedFullState();
    expect(saved.timer.mode).toBe('shortBreak');
    expect(saved.timer.isRunning).toBe(false);
    expect(saved.timer.targetTime).toBeNull();
  });

  describe('late manual save responses', () => {
    const stateKey = 'fomopomo_full_state::user-1';
    const lastTimerProps = () => mocks.timerDisplayProps.at(-1)!;
    const readSavedState = () => JSON.parse(window.localStorage.getItem(stateKey)!);
    const clickTimer = (name: string) => (lastTimerProps()[name] as () => void)();
    const deferredSave = () => {
      let resolve!: (value: 'saved' | 'rejected' | 'failed') => void;
      const promise = new Promise<'saved' | 'rejected' | 'failed'>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const mountPausedFocus = async () => {
      seedTimerState({
        isRunning: false,
        secondsLeft: 15 * 60,
        intervals: [{ start: Date.now() - 10 * 60_000, end: Date.now() }],
      });
      window.localStorage.setItem(stateKey, JSON.stringify({
        ...savedFullState(), ownerUserId: 'user-1',
      }));
      window.localStorage.removeItem('fomopomo_full_state');
      const view = render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});
      expect(lastTimerProps().showSaveButton).toBe(true);
      return view;
    };

    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://review.supabase.co');
      window.localStorage.setItem('sb-review-auth-token', JSON.stringify({ user: { id: 'user-1' } }));
    });

    it.each(['saved', 'rejected'] as const)('preserves a restarted timer when the old record is %s', async (outcome) => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      expect(readSavedState().timer.loggedSeconds).toBe(600);
      await act(async () => clickTimer('onToggleTimer'));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      const snapshot = readSavedState();
      const intervalStart = mocks.currentIntervalStartRef.current;
      const statusCalls = mocks.updateStatus.mock.calls.length;

      await act(async () => response.resolve(outcome));

      expect(lastTimerProps().isRunning).toBe(true);
      expect(lastTimerProps().timeLeft).toBe(14 * 60);
      expect(mocks.currentIntervalStartRef.current).toBe(intervalStart);
      expect(readSavedState()).toEqual(snapshot);
      expect(mocks.updateStatus).toHaveBeenCalledTimes(statusCalls);
      await act(async () => clickTimer('onToggleTimer'));
      expect(lastTimerProps().showSaveButton).toBe(true);
      await act(async () => clickTimer('onSaveTimer'));
      expect(mocks.createPendingRecord).toHaveBeenLastCalledWith('pomo', 60, Date.now());
    });

    it('preserves new paused progress even when the timer is no longer running', async () => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      await act(async () => clickTimer('onToggleTimer'));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      await act(async () => clickTimer('onToggleTimer'));
      const snapshot = readSavedState();
      expect(snapshot.intervals).toHaveLength(1);

      await act(async () => response.resolve('saved'));

      expect(lastTimerProps().isRunning).toBe(false);
      expect(lastTimerProps().timeLeft).toBe(14 * 60);
      expect(lastTimerProps().showSaveButton).toBe(true);
      expect(readSavedState()).toEqual(snapshot);
    });

    it.each(['mode', 'preset'] as const)('preserves a newer %s selection', async (change) => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      await act(async () => {
        if (change === 'mode') (lastTimerProps().onChangeMode as (mode: string) => void)('shortBreak');
        else (lastTimerProps().onPresetClick as (minutes: number) => void)(50);
      });
      const snapshot = readSavedState();

      await act(async () => response.resolve('saved'));

      expect(lastTimerProps().timerMode).toBe(change === 'mode' ? 'shortBreak' : 'focus');
      expect(lastTimerProps().timeLeft).toBe((change === 'mode' ? 5 : 50) * 60);
      expect(readSavedState()).toEqual(snapshot);
    });

    it('still resets the saved timer when nothing changed while saving', async () => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      expect(lastTimerProps().timeLeft).toBe(15 * 60);
      expect(lastTimerProps().showSaveButton).toBe(false);

      await act(async () => response.resolve('saved'));

      expect(lastTimerProps().timeLeft).toBe(25 * 60);
      expect(lastTimerProps().isRunning).toBe(false);
      expect(readSavedState().timer).toMatchObject({ timeLeft: 1500, loggedSeconds: 0 });
    });

    it('does not overwrite a remounted timer or its persisted progress', async () => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      const view = await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      view.unmount();
      render(<TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />);
      await act(async () => {});
      await act(async () => clickTimer('onToggleTimer'));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      const snapshot = readSavedState();

      await act(async () => response.resolve('saved'));

      expect(lastTimerProps().isRunning).toBe(true);
      expect(lastTimerProps().timeLeft).toBe(14 * 60);
      expect(readSavedState()).toEqual(snapshot);
    });

    it('does not change the guest timer or old account snapshot after logout', async () => {
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      const view = await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      const accountSnapshot = readSavedState();
      window.localStorage.removeItem('sb-review-auth-token');
      view.rerender(<TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={false} />);
      await act(async () => {});
      await act(async () => clickTimer('onToggleTimer'));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      const guestSnapshot = savedFullState();

      await act(async () => response.resolve('saved'));

      expect(lastTimerProps().isRunning).toBe(true);
      expect(lastTimerProps().timeLeft).toBe(24 * 60);
      expect(savedFullState()).toEqual(guestSnapshot);
      expect(readSavedState()).toEqual(accountSnapshot);
    });

    it('keeps a newer session when retrying the old record succeeds', async () => {
      mocks.savePendingRecord.mockResolvedValueOnce('failed');
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      const record = mocks.savePendingRecord.mock.calls[0][0];
      const retryContent = vi.mocked(toast).mock.calls.at(-1)![0] as (value: { id: string }) => ReactNode;
      const retryView = render(retryContent({ id: 'retry-old-record' }));
      await act(async () => clickTimer('onToggleTimer'));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      const snapshot = readSavedState();

      await act(async () => {
        fireEvent.click(retryView.getByRole('button', { name: '재시도' }));
      });

      expect(mocks.savePendingRecord).toHaveBeenLastCalledWith(record, '', null);
      expect(lastTimerProps().isRunning).toBe(true);
      expect(lastTimerProps().timeLeft).toBe(14 * 60);
      expect(readSavedState()).toEqual(snapshot);
    });

    it.each(['onSave', 'onSkip', 'onDisablePopup'] as const)('retains normal reset behavior after the task popup %s action', async (action) => {
      mocks.settings.taskPopupEnabled = true;
      const persistSettings = mocks.useSettingsResult!.persistSettings as ReturnType<typeof vi.fn>;
      if (action === 'onDisablePopup') persistSettings.mockResolvedValueOnce(true);
      const response = deferredSave();
      mocks.savePendingRecord.mockReturnValueOnce(response.promise);
      await mountPausedFocus();
      await act(async () => clickTimer('onSaveTimer'));
      expect(mocks.taskModalProps.at(-1)!.isOpen).toBe(true);
      expect(mocks.savePendingRecord).not.toHaveBeenCalled();
      let submitted!: Promise<void>;
      await act(async () => {
        submitted = (mocks.taskModalProps.at(-1)![action] as () => Promise<void>)();
      });
      expect(lastTimerProps().timeLeft).toBe(15 * 60);

      await act(async () => {
        response.resolve('saved');
        await submitted;
      });

      expect(lastTimerProps().timeLeft).toBe(25 * 60);
      expect(lastTimerProps().isRunning).toBe(false);
      expect(mocks.taskModalProps.at(-1)!.isOpen).toBe(false);
      expect(readSavedState().timer).toMatchObject({ timeLeft: 1500, loggedSeconds: 0 });
      expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.savePendingRecord).toHaveBeenCalledTimes(1);
    });
  });

  describe('manual mode switch persistence', () => {
    const lastTimerDisplayProps = () =>
      mocks.timerDisplayProps[mocks.timerDisplayProps.length - 1];

    describe.each([
      {
        name: 'default durations',
        settings: { pomoTime: 25, shortBreak: 5, longBreak: 15 },
        seconds: { focus: 1500, shortBreak: 300, longBreak: 900 },
      },
      {
        name: 'custom durations',
        settings: { pomoTime: 42, shortBreak: 7, longBreak: 18 },
        seconds: { focus: 2520, shortBreak: 420, longBreak: 1080 },
      },
    ])('$name', ({ settings, seconds }) => {
      it.each([
        ['focus', 'shortBreak'],
        ['focus', 'longBreak'],
        ['shortBreak', 'focus'],
        ['longBreak', 'focus'],
      ] as const)('keeps %s → %s at its full duration after a reload without offering phantom saves', async (from, to) => {
        Object.assign(mocks.settings, settings);
        seedTimerState({
          mode: from,
          isRunning: false,
          secondsLeft: seconds[from],
          configuredDurations: seconds,
        });
        const view = render(
          <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
        );
        await act(async () => {});

        await act(async () => {
          (lastTimerDisplayProps().onChangeMode as (mode: string) => void)(to);
        });

        expect(lastTimerDisplayProps().timerMode).toBe(to);
        expect(lastTimerDisplayProps().timeLeft).toBe(seconds[to]);
        const saved = savedFullState();

        // A fresh mount exercises the same persisted snapshot as a reload.
        view.unmount();
        render(
          <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
        );
        await act(async () => {});

        expect(lastTimerDisplayProps().timerMode).toBe(to);
        expect(lastTimerDisplayProps().timeLeft).toBe(seconds[to]);
        expect(lastTimerDisplayProps().showSaveButton).toBe(false);
        expect(saved.timer).toMatchObject({
          mode: to,
          timeLeft: seconds[to],
          isRunning: false,
          targetTime: null,
        });
        expect(mocks.createPendingRecord).not.toHaveBeenCalled();
        expect(mocks.savePendingRecord).not.toHaveBeenCalled();
      });
    });

    it('saves actual unsaved focus time once when switching to a break', async () => {
      seedRunningFocusTimer(25 * 60);
      const view = render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });

      await act(async () => {
        (lastTimerDisplayProps().onChangeMode as (mode: string) => void)('shortBreak');
      });

      expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.createPendingRecord).toHaveBeenCalledWith('pomo', 60, Date.now());
      expect(mocks.savePendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.savePendingRecord).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'pomo', duration: 60 }),
        '',
        null
      );

      view.unmount();
      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(5 * 60);
      expect(lastTimerDisplayProps().showSaveButton).toBe(false);
      expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.savePendingRecord).toHaveBeenCalledTimes(1);
    });
  });

  describe('timer expired while the tab was closed', () => {
    const expiredBatchId = (targetTime: number) =>
      `00000000-0000-4000-8000-${targetTime.toString(16).padStart(12, '0').slice(-12)}`;

    it('saves the interval evidence clamped at the deadline with the persisted task label and settles into the break', async () => {
      const now = Date.now();
      const targetTime = now - 10 * 60_000; // deadline passed 10 minutes ago
      const closedInterval = { start: targetTime - 20 * 60_000, end: targetTime - 15 * 60_000 };
      const openStart = targetTime - 10 * 60_000;
      seedTimerState({
        targetTime,
        intervals: [closedInterval],
        currentIntervalStart: openStart,
      });
      window.localStorage.setItem(
        'fomopomo_task_state',
        JSON.stringify({ taskId: 't1', taskTitle: '독서' })
      );

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      // The record is built from the snapshot's intervals under a
      // deterministic batch id, ends at the real deadline, is sized by the
      // interval evidence (5min closed + 10min open = 15min — never the full
      // pomoTime), and keeps the persisted label.
      expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.createPendingRecord).toHaveBeenCalledWith(
        'pomo',
        15 * 60,
        targetTime,
        {
          intervals: [closedInterval],
          currentStart: openStart,
          sessionId: expiredBatchId(targetTime),
        }
      );
      expect(mocks.savePendingRecord).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'pomo' }),
        '독서',
        't1'
      );

      // The transition is settled and persisted: a stopped break, cycle
      // advanced, no expired deadline left to re-trigger this branch.
      const saved = savedFullState();
      expect(saved.timer.mode).toBe('shortBreak');
      expect(saved.timer.isRunning).toBe(false);
      expect(saved.timer.targetTime).toBeNull();
      expect(saved.timer.cycleCount).toBe(1);
      expect(saved.intervals).toEqual([]);
      expect(saved.currentIntervalStart).toBeNull();
    });

    it('routes the expired record through the task popup when it is enabled and no task is persisted', async () => {
      mocks.settings.taskPopupEnabled = true;
      const now = Date.now();
      const targetTime = now - 60_000;
      seedTimerState({
        targetTime,
        intervals: [],
        currentIntervalStart: targetTime - 20 * 60_000,
      });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      // The record exists (durably parked by the real hook) but the save
      // waits for the user's label — nothing is sent unlabeled.
      expect(mocks.createPendingRecord).toHaveBeenCalledTimes(1);
      expect(mocks.savePendingRecord).not.toHaveBeenCalled();
    });

    it('does not fabricate a record when the snapshot holds no interval evidence', async () => {
      seedTimerState({
        targetTime: Date.now() - 60_000,
        intervals: [],
        currentIntervalStart: null,
      });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      // No evidence → no record; the transition still settles.
      expect(mocks.createPendingRecord).not.toHaveBeenCalled();
      const saved = savedFullState();
      expect(saved.timer.mode).toBe('shortBreak');
      expect(saved.timer.isRunning).toBe(false);
    });

    it('completes a session from a stale (>24h) snapshot instead of discarding it', async () => {
      const now = Date.now();
      const targetTime = now - 25 * 60 * 60_000; // expired 25 hours ago
      seedTimerState({
        targetTime,
        intervals: [],
        currentIntervalStart: targetTime - 20 * 60_000,
        lastUpdated: targetTime - 20 * 60_000,
      });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      // The snapshot is too old to rehydrate UI state, but the session it
      // holds is still saved (segments end at the deadline).
      expect(mocks.createPendingRecord).toHaveBeenCalledWith(
        'pomo',
        20 * 60,
        targetTime,
        expect.objectContaining({ currentStart: targetTime - 20 * 60_000 })
      );
    });

    it('settles an expired break into a fresh focus without saving a record', async () => {
      seedTimerState({
        mode: 'shortBreak',
        targetTime: Date.now() - 60_000,
      });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(mocks.createPendingRecord).not.toHaveBeenCalled();
      expect(mocks.savePendingRecord).not.toHaveBeenCalled();

      const saved = savedFullState();
      expect(saved.timer.mode).toBe('focus');
      expect(saved.timer.isRunning).toBe(false);
      expect(saved.timer.timeLeft).toBe(25 * 60);
    });
  });

  describe('idle snapshot restore after a settings change', () => {
    const lastTimerDisplayProps = () =>
      mocks.timerDisplayProps[mocks.timerDisplayProps.length - 1];

    it('re-syncs an untouched idle snapshot to the newly configured duration', async () => {
      // Saved while sitting untouched at the full 25:00 of its own settings
      // era; pomoTime has since been raised to 50 (settings modal on this
      // device before a reload, or another device via remote settings).
      seedTimerState({
        isRunning: false,
        secondsLeft: 25 * 60,
        configuredDurations: { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 },
      });
      mocks.settings.pomoTime = 50;

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(50 * 60);
      // Regression: restoring the stale 25:00 against pomoTime 50 used to
      // offer a save button for 25 phantom minutes never studied.
      expect(lastTimerDisplayProps().showSaveButton).toBe(false);
    });

    it('restores partial idle progress verbatim', async () => {
      seedTimerState({
        isRunning: false,
        secondsLeft: 20 * 60,
        configuredDurations: { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 },
      });
      mocks.settings.pomoTime = 50;

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(20 * 60);
    });

    it('restores an unstamped legacy snapshot verbatim', async () => {
      seedTimerState({ isRunning: false, secondsLeft: 25 * 60 });
      mocks.settings.pomoTime = 50;

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(25 * 60);
    });

    it('preset clicks stamp the just-written settings era, not the stale closure', async () => {
      // No snapshot seeded: the timer mounts idle at 25:00.
      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      await act(async () => {
        (lastTimerDisplayProps().onPresetClick as (minutes: number) => void)(50);
      });

      const saved = savedFullState();
      expect(saved.timer.timeLeft).toBe(50 * 60);
      // Regression: the stamp used to come from the pre-preset settings
      // closure (25:00 era), so the snapshot read as partial progress on
      // restore and was excluded from the idle re-sync forever after.
      expect(saved.configuredDurations).toEqual({
        focus: 50 * 60,
        shortBreak: 5 * 60,
        longBreak: 15 * 60,
      });
    });

    it('recovers an idle snapshot stuck at 00:00 to the full duration', async () => {
      // An old client that persisted pomoTime 0 (cleared input) left an idle
      // snapshot with timeLeft 0. Settings now clamp to a positive duration;
      // restoring 0 verbatim would show 00:00 and offer a phantom save for
      // the full pomoTime.
      seedTimerState({ isRunning: false, secondsLeft: 0 });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(25 * 60);
      expect(lastTimerDisplayProps().showSaveButton).toBe(false);
    });

    it('clears banked seconds when recovering a broken 00:00 snapshot', async () => {
      // Keeping loggedSeconds against a freshly recovered full timer would
      // violate elapsed >= logged and under-record the next real session.
      seedTimerState({ isRunning: false, secondsLeft: 0, loggedSeconds: 300 });

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(25 * 60);

      // Starting the timer persists the live state — loggedSeconds must be 0.
      await act(async () => {
        (lastTimerDisplayProps().onToggleTimer as () => void)();
      });
      expect(savedFullState().timer.loggedSeconds).toBe(0);
    });

    it('restores an idle snapshot with banked focus seconds verbatim', async () => {
      seedTimerState({
        isRunning: false,
        secondsLeft: 25 * 60,
        loggedSeconds: 300,
        configuredDurations: { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 },
      });
      mocks.settings.pomoTime = 50;

      render(
        <TimerApp settingsUpdated={0} onRecordSaved={vi.fn()} isLoggedIn={true} />
      );
      await act(async () => {});

      expect(lastTimerDisplayProps().timeLeft).toBe(25 * 60);
    });
  });
});
