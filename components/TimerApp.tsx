'use client';

import { useState, useCallback, useEffect, useEffectEvent, useRef } from 'react';
import toast from 'react-hot-toast';
import TaskSidebar from './TaskSidebar';

// Hooks
import { useSettings, type Settings } from '@/components/timer/hooks/useSettings';
import { useSound } from '@/components/timer/hooks/useSound';
import { useTasks } from './timer/hooks/useTasks';
import { useTimerLogic, type TimerMode } from './timer/hooks/useTimerLogic';
import { useStopwatchLogic } from './timer/hooks/useStopwatchLogic';
import { useStudySession, MIN_SAVABLE_SECONDS, type PendingStudyRecord, type SaveRecordResult } from './timer/hooks/useStudySession';
import { TASK_STATE_KEY, type SavedTaskState } from './timer/hooks/useTasks';
import { readSettingsSnapshot } from './timer/hooks/settingsStore';
import {
  GUEST_OWNER,
  clearForeignLegacyState,
  getCurrentUserId,
  getStorageOwner,
  readOwnedJson,
  writeOwnedJson,
} from '@/lib/userScopedStorage';

// UI Components
import { TaskModal } from './timer/ui/TaskModal';
import { TimerDisplay } from './timer/ui/TimerDisplay';
import { StopwatchDisplay } from './timer/ui/StopwatchDisplay';
import { ThemeBackground } from './timer/ui/ThemeBackground';
import { getDisplayCycleCount } from './timer/ui/timerDisplayUtils';

// Helper to format time for Tab Title
const formatTimeForTitle = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

interface TimerAppProps {
  settingsUpdated: number;
  onRecordSaved: () => void;
  isLoggedIn: boolean;
}

type SavedInterval = {
  start: number;
  end: number;
};

type SavedTimerState = {
  mode: TimerMode;
  isRunning: boolean;
  timeLeft: number;
  targetTime: number | null;
  cycleCount: number;
  loggedSeconds: number;
};

type SavedStopwatchState = {
  isRunning: boolean;
  elapsed: number;
  startTime: number | null;
};

type SavedAppState = {
  activeTab: 'timer' | 'stopwatch';
  timer: SavedTimerState;
  stopwatch: SavedStopwatchState;
  intervals?: SavedInterval[];
  currentIntervalStart?: number | null;
  // Full durations (seconds) configured when this snapshot was written. Lets
  // the restore effect tell an untouched idle timer (timeLeft === the full
  // duration of ITS OWN settings era) apart from partial progress, so a
  // settings change between save and restore can re-sync the idle display
  // instead of resurrecting the stale duration. Absent on legacy snapshots.
  configuredDurations?: Record<TimerMode, number>;
  lastUpdated: number;
  ownerUserId?: string;
};

const normalizeTimerMode = (value: string | null | undefined): TimerMode => {
  if (value === 'shortBreak' || value === 'longBreak') {
    return value;
  }
  return 'focus';
};

const isValidInterval = (interval: { start: number; end: number }) =>
  interval.start > 0 && interval.end > 0;

// Pure completion-transition kernel shared by the live completion handler and
// the restore-time completion of a timer that expired while the tab was
// closed — the two paths must never disagree on cadence or cycle bookkeeping.
const computeNextTimerPhase = (
  completedMode: TimerMode,
  cycleCount: number,
  settings: Settings
): { nextMode: TimerMode; nextSeconds: number; nextCycle: number } => {
  if (completedMode === 'focus') {
    const nextCycle = cycleCount + 1;
    const nextMode: TimerMode =
      nextCycle % settings.longBreakInterval === 0 ? 'longBreak' : 'shortBreak';
    return {
      nextMode,
      nextSeconds: (nextMode === 'longBreak' ? settings.longBreak : settings.shortBreak) * 60,
      nextCycle,
    };
  }
  return {
    nextMode: 'focus',
    nextSeconds: settings.pomoTime * 60,
    nextCycle: completedMode === 'longBreak' ? 0 : cycleCount,
  };
};

// Deterministic UUID-shaped batch id for a restore-completed session, derived
// from the expired deadline: every context that completes the same snapshot
// (a second tab, a remount after a failed settle-write) produces the same id,
// so the server's batch idempotency dedupes them.
const expiredSessionBatchId = (targetTime: number) =>
  `00000000-0000-4000-8000-${targetTime.toString(16).padStart(12, '0').slice(-12)}`;

const FULL_STATE_KEY = 'fomopomo_full_state';

export default function TimerApp({
  settingsUpdated,
  onRecordSaved,
  isLoggedIn,
}: TimerAppProps) {
  const [tab, setTab] = useState<'timer' | 'stopwatch'>('timer');
  const [isTaskSidebarOpen, setIsTaskSidebarOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);

  // The record the task popup is waiting on. The record object carries its
  // own batch id, frozen segments and real end time, so answering the popup
  // late (or after other sessions ran) can neither inflate the record nor
  // attach it to another record's identity.
  const [pendingRecord, setPendingRecord] = useState<{
    record: PendingStudyRecord;
    onAfterSave?: () => void;
  } | null>(null);

  // 1. Settings Hook
  const { settings, setSettings, persistSettings } = useSettings(settingsUpdated);

  // 2. Sound Hook
  const { playAlarm, playClickSound } = useSound({
    volume: settings.volume,
    isMuted: settings.isMuted,
  });

  // 3. Tasks Hook
  const {
    dbTasks,
    weeklyPlans,
    monthlyPlans,
    longTermTasks,
    selectedTask,
    selectedTaskId,
    setSelectedTask,
    setSelectedTaskId,
    getSelectedTaskTitle,
    fetchDbTasks,
    toggleTaskStatus,
    selectSubtaskForTimer,
    toggleSubtask,
    pendingSubtaskIds,
  } = useTasks(isLoggedIn);

  // 사이드바를 열 때마다 목록과 작업별 누적 시간을 새로 가져온다.
  const openTaskSidebar = useCallback(() => {
    setIsTaskSidebarOpen(true);
    void fetchDbTasks();
  }, [fetchDbTasks]);

  // 4. Study Session Hook
  const {
    isSaving,
    intervals,
    setIntervals,
    currentIntervalStartRef,
    updateStatus,
    createPendingRecord,
    savePendingRecord,
    checkActiveSession,
  } = useStudySession({
    isLoggedIn,
    onRecordSaved,
    selectedTaskTitle: getSelectedTaskTitle() || selectedTask,
  });

  // 4.5. Callback Ref for Timer Completion (Must be defined before useTimerLogic)
  // We need to use a Ref because handleTimerComplete depends on state that changes,
  // but we want the callback passed to useTimerLogic to be stable to prevent interval resets.
  const onTimerCompleteCallback = useRef<() => void>(() => { });

  // 5. Timer Logic Hook
  const {
    timerMode,
    timeLeft,
    isRunning,
    cycleCount,
    focusLoggedSeconds,
    setTimerMode,
    setTimeLeft,
    setIsRunning,
    setCycleCount,
    setFocusLoggedSeconds,
    startTimer,
    toggleTimer,
    resetTimerManual,
    changeTimerMode,
    endTimeRef
  } = useTimerLogic({
    settings,
    onTimerCompleteRef: onTimerCompleteCallback,
    playClickSound,
    updateStatus: (status, task, startTime, elapsed, timerType, timerMode, timerDuration) => updateStatus(status, task, startTime, elapsed, timerType, timerMode, timerDuration),
  });

  // 6. Stopwatch Logic Hook
  const {
    stopwatchTime,
    isStopwatchRunning,
    setIsStopwatchRunning,
    setStopwatchTime,
    toggleStopwatch,
    resetStopwatch,
    stopwatchStartTimeRef,
  } = useStopwatchLogic({
    playClickSound,
    updateStatus: (status, task, startTime, elapsed) => updateStatus(status, task, startTime, elapsed),
  });

  // --- Account-scoped persistence namespace ---
  // Storage owner for every persisted key: the authenticated user id, or the
  // guest namespace when logged out. Ref to track if server sync has been done
  // (once per mount per account).
  const storageOwner = isLoggedIn ? getStorageOwner() : GUEST_OWNER;
  const hasSyncedRef = useRef(false);
  // Version session transitions so a delayed save can only reset the state
  // that created its record. Comparing displayed values would miss a
  // restart/pause or reset cycle that happens to return to the same values.
  const sessionRevisionRef = useRef(0);
  // Guards the task-persistence effect below: stays false until a real
  // (restored or user-made) task selection has been seen for this owner.
  const taskStateDirtyRef = useRef(false);

  // Auth changed (login/logout/account switch): reset all in-memory timer
  // state during this render — before any effect can persist the previous
  // account's state into the new namespace. The restore effect below then
  // rehydrates from the new owner's own keys.
  const [prevStorageOwner, setPrevStorageOwner] = useState(storageOwner);
  if (prevStorageOwner !== storageOwner) {
    setPrevStorageOwner(storageOwner);
    setTab('timer');
    setTimerMode('focus');
    setIsRunning(false);
    setTimeLeft(settings.pomoTime * 60);
    setCycleCount(0);
    setFocusLoggedSeconds(0);
    setIsStopwatchRunning(false);
    setStopwatchTime(0);
    setIntervals([]);
    setSelectedTask('');
    setSelectedTaskId(null);
    // The task popup must not survive the owner switch: savePendingRecord
    // refuses records whose owner no longer matches, but the stale modal
    // would still be dead UI — close it. The record's parked draft stays in
    // the outbox until its owner signs back in.
    setTaskModalOpen(false);
    setPendingRecord(null);
  }

  // --- Persistence Logic ---
  const saveState = useCallback((
    currentTab: "timer" | "stopwatch",
    tMode: "focus" | "shortBreak" | "longBreak",
    tRunning: boolean,
    tLeft: number,
    tTarget: number | null,
    cycle: number,
    tLogged: number,
    sRunning: boolean,
    sElapsed: number,
    sStart: number | null,
    currentIntervals: { start: number; end: number }[],
    currentStart: number | null // NEW PARAMETER
  ) => {
    sessionRevisionRef.current += 1;
    // Stamp from the store, not the React `settings` closure: the preset
    // handler writes the store synchronously right before saving (the closure
    // still holds the pre-preset durations), and the expired-timer settle
    // path can run while the closure is still the hydration default. The
    // stamp must come from the same settings era as the timeLeft beside it,
    // or the restore re-sync misreads the snapshot.
    const configuredSettings = readSettingsSnapshot();
    const state = {
      activeTab: currentTab,
      timer: {
        mode: tMode,
        isRunning: tRunning,
        timeLeft: tLeft,
        targetTime: tTarget,
        cycleCount: cycle,
        loggedSeconds: tLogged,
      },
      stopwatch: {
        isRunning: sRunning,
        elapsed: sElapsed,
        startTime: sStart,
      },
      intervals: currentIntervals,
      currentIntervalStart: currentStart, // SAVE IT
      configuredDurations: {
        focus: configuredSettings.pomoTime * 60,
        shortBreak: configuredSettings.shortBreak * 60,
        longBreak: configuredSettings.longBreak * 60,
      },
      lastUpdated: Date.now(),
    };
    writeOwnedJson(FULL_STATE_KEY, storageOwner, state);
  }, [storageOwner]);

  // --- Handlers ---

  // Saves a created record and, on a retryable failure, offers a toast retry
  // that re-saves the SAME record object — the batch id and segments travel in
  // the closure, so a retry can never attach to a different record.
  const attemptRecordSave = useCallback(async function attempt(record: PendingStudyRecord, taskText: string, taskId: string | null, onAfterSave?: () => void): Promise<SaveRecordResult> {
    const result = await savePendingRecord(record, taskText, taskId);
    if (result === 'saved' || result === 'rejected') {
      // Reset/close only when the save reached a terminal verdict: confirmed
      // ('saved') or permanently refused with the draft parked in the outbox
      // ('rejected'). A retryable failure keeps the draft for a retry.
      if (onAfterSave) onAfterSave();
    } else if (result === 'failed') {
      toast(
        (t) => (
          <div className="flex items-center gap-3">
            <span>저장에 실패했습니다. 기록은 보관 중입니다.</span>
            <button
              onClick={() => {
                toast.dismiss(t.id);
                void attempt(record, taskText, taskId, onAfterSave);
              }}
              className="shrink-0 rounded-lg bg-rose-500 px-3 py-1.5 text-sm font-bold text-white"
            >
              재시도
            </button>
          </div>
        ),
        { duration: 12000, icon: '⚠️' }
      );
    }
    // 'skipped': another save is in flight or the account changed — the
    // parked draft keeps the record recoverable either way.
    return result;
  }, [savePendingRecord]);

  // Saving Logic Helper: creates the record (freezing its content and parking
  // it durably, both synchronous) and either saves it directly or hands it to
  // the task popup. onRecordCreated runs right after the record exists so the
  // caller can persist its own "content consumed" state in the same tick.
  const triggerSave = useCallback(async (recordMode: string, duration: number, onAfterSave?: () => void, forcedEndTime?: number, onRecordCreated?: () => void) => {
    // No in-flight guard here: a completion arriving while another save's RPC
    // is on the wire must still CREATE (and durably park) its record — the
    // attempt below then returns 'skipped' and mount recovery finishes the
    // parked draft. Double-clicks are already inert because onRecordCreated
    // consumes the content synchronously (the second click has nothing left
    // to save), and savePendingRecord's own synchronous lock serializes RPCs.
    if (duration < MIN_SAVABLE_SECONDS) {
      toast.error('10초 미만은 저장되지 않습니다.');
      return;
    }
    if (!isLoggedIn) {
      toast.error('로그인이 필요한 기능입니다.');
      return;
    }

    const record = createPendingRecord(recordMode, duration, forcedEndTime);
    if (!record) {
      toast.error('로그인이 필요한 기능입니다.');
      return;
    }
    if (onRecordCreated) onRecordCreated();

    if (settings.taskPopupEnabled && !selectedTaskId) {
      if (pendingRecord) {
        // A second completion arrived while the modal was still waiting for
        // an answer: finish the displaced record unlabeled under its own
        // batch id. Fire-and-forget — a failure leaves its parked draft for
        // recovery, and awaiting here would delay the modal swap.
        void attemptRecordSave(pendingRecord.record, '', null, pendingRecord.onAfterSave);
      }
      setPendingRecord({ record, onAfterSave });
      setTaskModalOpen(true);
    } else {
      await attemptRecordSave(record, selectedTask, selectedTaskId, onAfterSave);
    }
  }, [isLoggedIn, settings.taskPopupEnabled, selectedTaskId, selectedTask, createPendingRecord, attemptRecordSave, pendingRecord]);

  // Auto-start must go through the same atomic start transition as a manual
  // start: a bare setIsRunning(true) would reuse the expired endTimeRef, so
  // the first interval tick would complete the timer again instantly and
  // paired auto-start settings would loop alarms/saves forever.
  // Invoked through a ref (same pattern as onTimerCompleteCallback) so the
  // delayed call reads post-completion state: fresh isRunning guard, updated
  // cycleCount/intervals for persistence.
  const autoStartTimer = useCallback((mode: TimerMode, seconds: number) => {
    // The user may have started something else during the delay; never
    // stomp an already-active session.
    if (isRunning || isStopwatchRunning || stopwatchTime > 0) return;

    startTimer({ mode, remainingSeconds: seconds });
    currentIntervalStartRef.current = Date.now();
    saveState(tab, mode, true, seconds, endTimeRef.current, cycleCount, focusLoggedSeconds, isStopwatchRunning, stopwatchTime, null, intervals, currentIntervalStartRef.current);
  }, [isRunning, isStopwatchRunning, stopwatchTime, startTimer, saveState, tab, cycleCount, focusLoggedSeconds, intervals, currentIntervalStartRef, endTimeRef]);

  const autoStartTimerRef = useRef(autoStartTimer);
  useEffect(() => {
    autoStartTimerRef.current = autoStartTimer;
  }, [autoStartTimer]);

  const handleTimerComplete = useCallback(() => {
    // Play alarm (handled in useEffect/hook but let's make sure)
    playAlarm();

    const { nextMode, nextSeconds, nextCycle } = computeNextTimerPhase(timerMode, cycleCount, settings);

    if (timerMode === 'focus') {
      const duration = settings.pomoTime * 60;
      const remaining = duration - focusLoggedSeconds;

      if (remaining > 0) {
        // Pass endTimeRef.current as forcedEndTime to ensure exact recording time
        const forcedEndTime = endTimeRef.current > 0 ? endTimeRef.current : undefined;
        triggerSave('pomo', remaining, undefined, forcedEndTime);
      }
      setFocusLoggedSeconds(0);
      setCycleCount(nextCycle);

      toast(nextMode === 'longBreak' ? '🎉 긴 휴식 시간입니다!' : '잠시 휴식하세요.', { icon: '☕' });
      if (settings.autoStartBreaks) setTimeout(() => {
        autoStartTimerRef.current(nextMode, nextSeconds);
      }, 1000);
    } else {
      // 긴 휴식 완료 후 focus로 돌아올 때 사이클 리셋
      if (nextCycle !== cycleCount) setCycleCount(nextCycle);
      setFocusLoggedSeconds(0);
      toast('다시 집중할 시간입니다!', { icon: '🔥' });
      if (settings.autoStartPomos) setTimeout(() => {
        autoStartTimerRef.current('focus', nextSeconds);
      }, 1000);
    }

    // Apply and persist the post-completion transition from the same values,
    // so the on-screen state and the stored snapshot cannot diverge. Without
    // the persist, storage kept "running focus with an expired deadline plus
    // the old interval start" and a refresh during the break resurrected the
    // save button, re-saving the session inflated by the break time. (The
    // record itself is already durable: triggerSave parked it synchronously.)
    setTimerMode(nextMode);
    setTimeLeft(nextSeconds);
    saveState(tab, nextMode, false, nextSeconds, null, nextCycle, 0, isStopwatchRunning, stopwatchTime, null, [], null);

    // ✨ Push Notification Trigger
    if ('serviceWorker' in navigator && Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then(registration => {
        const title = timerMode === 'focus' ? '집중 시간 종료! ☕' : '휴식 종료! 다시 집중해볼까요? 🔥';
        const body = timerMode === 'focus'
          ? '수고하셨습니다. 잠시 머리를 식히세요.'
          : '휴식이 끝났습니다. 목표를 향해 다시 달려봐요!';

        registration.showNotification(title, {
          body,
          icon: '/icon-192x192.png',
          requireInteraction: true,
          tag: 'timer-complete',
          renotify: true,
          data: {
            url: window.location.href
          }
        } as NotificationOptions);
      });
    }

    // For logged-in users triggerSave's record creation already consumed the
    // interval state; this covers the guest path, where no record is created.
    setIntervals([]);
    currentIntervalStartRef.current = null;
  }, [timerMode, settings, focusLoggedSeconds, cycleCount, triggerSave, playAlarm, setFocusLoggedSeconds, setCycleCount, setTimerMode, setTimeLeft, setIntervals, endTimeRef, saveState, tab, isStopwatchRunning, stopwatchTime, currentIntervalStartRef]);

  // Update the ref handler whenever `handleTimerComplete` changes
  useEffect(() => {
    onTimerCompleteCallback.current = handleTimerComplete;
  }, [handleTimerComplete]);


  // --- Wrappers for Toggle to handle persistence ---
  const handleToggleTimer = () => {
    if (isStopwatchRunning || stopwatchTime > 0) {
      toast.error('스톱워치 기록이 있습니다.\n먼저 스톱워치를 초기화하거나 저장해주세요.');
      return;
    }

    if (isRunning) {
      // Stopping
      let newIntervals = intervals;
      if (currentIntervalStartRef.current) {
        newIntervals = [...intervals, { start: currentIntervalStartRef.current, end: Date.now() }];
        setIntervals(newIntervals);
        currentIntervalStartRef.current = null;
      }
      saveState(tab, timerMode, false, timeLeft, null, cycleCount, focusLoggedSeconds, isStopwatchRunning, stopwatchTime, null, newIntervals, null);
    } else {
      // Starting
      const target = Date.now() + (timeLeft * 1000);
      currentIntervalStartRef.current = Date.now();
      saveState(tab, timerMode, true, timeLeft, target, cycleCount, focusLoggedSeconds, isStopwatchRunning, stopwatchTime, null, intervals, currentIntervalStartRef.current);
    }
    toggleTimer();
  };

  const handleToggleStopwatch = () => {
    const fullTime = timerMode === 'focus' ? settings.pomoTime * 60 : timerMode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60;
    const hasTimerProgress = !isRunning && timeLeft < fullTime && timeLeft > 0;

    if (isRunning || (timerMode === 'focus' && focusLoggedSeconds > 0) || hasTimerProgress) {
      toast.error('타이머 기록이 있습니다.\n먼저 타이머를 초기화하거나 저장해주세요.');
      return;
    }

    if (isStopwatchRunning) {
      // Stopping
      let newIntervals = intervals;
      if (currentIntervalStartRef.current) {
        newIntervals = [...intervals, { start: currentIntervalStartRef.current, end: Date.now() }];
        setIntervals(newIntervals);
        currentIntervalStartRef.current = null;
      }
      saveState(tab, timerMode, isRunning, timeLeft, null, cycleCount, focusLoggedSeconds, false, stopwatchTime, null, newIntervals, null);
    } else {
      // Starting
      const start = Date.now() - (stopwatchTime * 1000);
      currentIntervalStartRef.current = Date.now();
      saveState(tab, timerMode, isRunning, timeLeft, null, cycleCount, focusLoggedSeconds, true, stopwatchTime, start, intervals, currentIntervalStartRef.current);
    }
    toggleStopwatch();
  };

  const handleChangeTimerMode = (mode: TimerMode) => {
    if (timerMode === 'focus' && isLoggedIn) {
      const fullTime = settings.pomoTime * 60;
      const elapsed = fullTime - timeLeft;
      const additional = elapsed - focusLoggedSeconds;
      // Save unsaved focus time before the switch discards it — but only
      // with actual session evidence: `elapsed` derived from settings alone
      // can be phantom time (pomoTime raised while the timer sat idle).
      // Sub-savable remainders and guests skip silently — a mode switch must
      // never surface an error toast.
      const hasSessionEvidence = intervals.length > 0 || currentIntervalStartRef.current !== null;
      if (additional >= MIN_SAVABLE_SECONDS && hasSessionEvidence) {
        triggerSave('pomo', additional, undefined, Date.now());
      }
    }

    // Persist the duration applied by the hook, not this render's old timeLeft.
    const nextTimeLeft = changeTimerMode(mode);
    setIntervals([]);
    saveState(tab, mode, false, nextTimeLeft, null, cycleCount, mode === 'focus' ? 0 : focusLoggedSeconds, isStopwatchRunning, stopwatchTime, null, [], null);
  };

  const handlePresetClick = (minutes: number) => {
    if (isStopwatchRunning || stopwatchTime > 0) {
      toast.error('스톱워치 기록이 있습니다.\n먼저 스톱워치를 초기화하거나 저장해주세요.');
      return;
    }
    if (isRunning) {
      toast.error("타이머가 작동 중입니다.\n먼저 정지해주세요.");
      return;
    }
    setTimerMode("focus");
    setTimeLeft(minutes * 60);
    setFocusLoggedSeconds(0);
    setSettings((prev: Settings) => ({ ...prev, pomoTime: minutes }));
    setIntervals([]);
    saveState(tab, "focus", false, minutes * 60, null, cycleCount, 0, isStopwatchRunning, stopwatchTime, null, [], null);
    toast.success(`${minutes === 0.1 ? '5초' : minutes + '분'}으로 설정됨`);
  };

  const handleSaveTimer = () => {
    const fullTime = timerMode === 'focus' ? settings.pomoTime * 60 : timerMode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60;
    const elapsed = fullTime - timeLeft;
    const additional = elapsed - focusLoggedSeconds;

    if (additional > 0) {
      let savedRevision: number | null = null;
      const afterSave = () => {
        // This callback also runs after retries, terminal rejections and task
        // popup answers. The record can finish saving without owning the
        // timer anymore; leave newer progress and its persisted state alone.
        if (
          savedRevision !== sessionRevisionRef.current ||
          getStorageOwner() !== storageOwner
        ) return;
        const currentSettings = readSettingsSnapshot();
        const currentFullTime = (timerMode === 'focus'
          ? currentSettings.pomoTime
          : timerMode === 'shortBreak'
            ? currentSettings.shortBreak
            : currentSettings.longBreak) * 60;
        // Settings can change without a session snapshot being written.
        if (currentFullTime !== fullTime) return;

        resetTimerManual();
        setIntervals([]);
        saveState(tab, timerMode, false, fullTime, null, cycleCount, 0, isStopwatchRunning, stopwatchTime, null, [], null);
        updateStatus('online', undefined, undefined, 0, 'timer', timerMode, 0);
      };
      triggerSave('pomo', additional, afterSave, Date.now(), () => {
        // The record now owns these minutes: advance loggedSeconds (hiding
        // the save button) and persist the consumed snapshot, so a refresh
        // cannot re-offer time whose durable copy is the parked draft.
        const newLogged = focusLoggedSeconds + additional;
        setFocusLoggedSeconds(newLogged);
        saveState(tab, timerMode, false, timeLeft, null, cycleCount, newLogged, isStopwatchRunning, stopwatchTime, null, [], null);
        savedRevision = sessionRevisionRef.current;
      });
    }
  };

  const handleSaveStopwatch = async () => {
    await triggerSave('stopwatch', stopwatchTime, undefined, Date.now(), () => {
      // Stop only once the record actually exists: flipping the flag before
      // triggerSave's guards would desync memory from the persisted snapshot
      // on an early return.
      setIsStopwatchRunning(false);
      // The record froze the full session content (including the still-open
      // interval, closed at the click time above) — consume the stopwatch
      // eagerly and persist the consumed snapshot, so neither a re-click nor
      // a refresh can save the same time again.
      setStopwatchTime(0);
      saveState(tab, timerMode, isRunning, timeLeft, null, cycleCount, focusLoggedSeconds, false, 0, null, [], null);
      updateStatus('online', undefined, undefined, 0);
    });
  };

  const handleResetStopwatch = () => {
    resetStopwatch();
    setIntervals([]);
    currentIntervalStartRef.current = null;
    saveState(tab, timerMode, isRunning, timeLeft, null, cycleCount, focusLoggedSeconds, false, 0, null, [], null);
    // Clear server state
    updateStatus('online', undefined, undefined, 0);
  };

  // 'failed' keeps the modal open for an in-place retry. 'skipped' with no
  // save in flight means clicking again can never succeed (the auth session
  // is gone or changed; savePendingRecord already toasted) — close the modal
  // instead of trapping the user under a full-screen overlay with no dismiss
  // control. The record's parked outbox draft keeps it recoverable.
  const closeIfUnrecoverable = (result: SaveRecordResult) => {
    if (result === 'skipped' && !isSaving) {
      setTaskModalOpen(false);
      setPendingRecord(null);
    }
  };

  const handleDisableTaskPopup = async () => {
    const previousSettings = { ...settings };
    const updated = { ...previousSettings, taskPopupEnabled: false };
    setSettings(updated);
    const didPersist = await persistSettings(updated);
    if (!didPersist) {
      setSettings(previousSettings);
      toast.error('설정을 저장할 수 없습니다. 데이터를 복구하거나 초기화한 뒤 다시 시도해주세요.');
      return;
    }
    // Announce only the setting change here; the save outcome gets its own
    // toast from savePendingRecord, so a premature success message can't
    // contradict a failed save.
    toast.success('자동 팝업을 껐어요. 설정에서 다시 켤 수 있어요.');
    if (pendingRecord) {
      const result = await savePendingRecord(pendingRecord.record, selectedTask, selectedTaskId);
      // Keep the modal and pending record only on retryable failure; 'rejected'
      // is terminal (the draft is parked in the outbox) so clean up as well.
      if (result !== 'saved' && result !== 'rejected') {
        closeIfUnrecoverable(result);
        return;
      }
      if (pendingRecord.onAfterSave) pendingRecord.onAfterSave();
      setPendingRecord(null);
      setSelectedTask('');
      setSelectedTaskId(null);
    }
    setTaskModalOpen(false);
  };

  const handleTaskSubmit = async () => {
    if (!pendingRecord) return;
    const result = await savePendingRecord(pendingRecord.record, selectedTask, selectedTaskId);
    // Keep the modal and pending record only on retryable failure; 'rejected'
    // is terminal (the draft is parked in the outbox) so clean up as well.
    if (result !== 'saved' && result !== 'rejected') {
      closeIfUnrecoverable(result);
      return;
    }
    if (pendingRecord.onAfterSave) pendingRecord.onAfterSave();
    setTaskModalOpen(false);
    setPendingRecord(null);
    setSelectedTask('');
    setSelectedTaskId(null);
  };

  const handleTaskSkip = async () => {
    if (!pendingRecord) return;
    // Skipping means "record this session without a task": pass an explicit
    // null taskId so a db-task chip clicked (then abandoned) inside the modal
    // cannot attribute the session to that task.
    const result = await savePendingRecord(pendingRecord.record, '', null);
    // Keep the modal and pending record only on retryable failure; 'rejected'
    // is terminal (the draft is parked in the outbox) so clean up as well.
    if (result !== 'saved' && result !== 'rejected') {
      closeIfUnrecoverable(result);
      return;
    }
    if (pendingRecord.onAfterSave) pendingRecord.onAfterSave();
    setTaskModalOpen(false);
    setPendingRecord(null);
    setSelectedTask('');
    setSelectedTaskId(null);
  };


  // Reset every hydration/sync ref (including hasSyncedRef) whenever the
  // storage owner changes. Effects run in declaration order, so this is
  // guaranteed to run before the restore and server-sync effects below and
  // they can never reuse the previous account's refs.
  useEffect(() => {
    hasSyncedRef.current = false;
    endTimeRef.current = 0;
    stopwatchStartTimeRef.current = 0;
    currentIntervalStartRef.current = null;
    taskStateDirtyRef.current = false;
    return () => {
      // Invalidate callbacks on unmount and account changes, including an
      // eventual return to the original account before a save resolves.
      sessionRevisionRef.current += 1;
    };
  }, [storageOwner, endTimeRef, stopwatchStartTimeRef, currentIntervalStartRef]);

  // Completion transition for a timer whose deadline passed while the tab was
  // closed: the closed tab never ran handleTimerComplete, so the restore must
  // save the focus session (clamped at the real deadline — the away time is
  // NOT study time) and settle the mode transition. useEffectEvent so the
  // mount-time restore effect can read live settings/handlers without them
  // becoming re-run triggers.
  const completeExpiredTimer = useEffectEvent((state: SavedAppState, targetTime: number) => {
    // Cross-account race guard: this snapshot belongs to storageOwner. If the
    // live auth identity moved on between render and this effect, leave the
    // snapshot untouched for its owner's next mount instead of attributing
    // the session to the wrong account.
    if (storageOwner !== GUEST_OWNER && getCurrentUserId() !== storageOwner) return;

    // The React settings snapshot can still be the hydration default when
    // this runs in the mount effect; read the persisted settings directly so
    // the transition and the record use the user's real configuration.
    const currentSettings = readSettingsSnapshot();

    let savedDirectly = false;

    if (state.timer.mode === 'focus') {
      // Only time that actually passed before the deadline counts — clamp
      // every piece of evidence at targetTime.
      const savedIntervals = (state.intervals ?? [])
        .filter(isValidInterval)
        .filter((interval) => interval.start < targetTime)
        .map((interval) => ({ start: interval.start, end: Math.min(interval.end, targetTime) }));
      const currentStart =
        state.currentIntervalStart && state.currentIntervalStart < targetTime
          ? state.currentIntervalStart
          : null;
      // The record can never exceed the snapshot's actual interval evidence:
      // a settings change while away (or clock skew) must not let the
      // synthesized fallback fabricate study time.
      const evidenceSeconds = Math.round(
        (savedIntervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0) +
          (currentStart ? targetTime - currentStart : 0)) / 1000
      );
      const remaining = Math.min(
        currentSettings.pomoTime * 60 - (state.timer.loggedSeconds || 0),
        evidenceSeconds
      );

      if (remaining >= MIN_SAVABLE_SECONDS && isLoggedIn) {
        const record = createPendingRecord('pomo', remaining, targetTime, {
          intervals: savedIntervals,
          currentStart,
          sessionId: expiredSessionBatchId(targetTime),
        });
        if (!record) {
          // isLoggedIn is stale-true but no auth owner is resolvable: leave
          // the snapshot claimable instead of consuming its content with no
          // durable copy anywhere.
          return;
        }
        // The task selection is restored asynchronously elsewhere; read the
        // persisted selection directly so the record keeps its label.
        const savedTask = readOwnedJson<SavedTaskState>(TASK_STATE_KEY, storageOwner);
        if (currentSettings.taskPopupEnabled && !savedTask?.taskId) {
          // Same labeling policy as a live completion: the user labels the
          // finished session in the popup. The record is already parked, so
          // abandoning the popup cannot lose it.
          setPendingRecord({ record });
          setTaskModalOpen(true);
        } else {
          void attemptRecordSave(record, savedTask?.taskTitle || '', savedTask?.taskId || null);
          savedDirectly = true;
        }
      }
    }

    const { nextMode, nextSeconds, nextCycle } = computeNextTimerPhase(
      state.timer.mode,
      state.timer.cycleCount,
      currentSettings
    );
    setCycleCount(nextCycle);
    setTimerMode(nextMode);
    setTimeLeft(nextSeconds);
    setFocusLoggedSeconds(0);
    setIsRunning(false);
    // Persist the settled transition. The stopwatch slice is carried over
    // faithfully so storage cannot disagree with the hydration this restore
    // performs from the same snapshot.
    const stopwatchRunning = Boolean(state.stopwatch?.isRunning && state.stopwatch?.startTime);
    saveState(
      state.activeTab, nextMode, false, nextSeconds, null, nextCycle, 0,
      stopwatchRunning, state.stopwatch?.elapsed ?? 0, state.stopwatch?.startTime ?? null,
      [], null
    );

    if (state.timer.mode === 'focus') {
      toast(
        savedDirectly
          ? '자리 비운 사이 뽀모도로가 완료되어 기록을 저장했어요. 휴식할 시간!'
          : '자리 비운 사이 뽀모도로가 완료되었어요.',
        { icon: '✅' }
      );
    } else {
      toast('휴식이 끝났어요. 다시 집중할 시간입니다!', { icon: '🔥' });
    }

    // The session is settled: skip this mount's server-state sync so stale
    // paused/studying profile data cannot resurrect what was just recorded,
    // and clear the server-side session state (the closed tab's offline
    // beacon is best-effort and may never have landed).
    hasSyncedRef.current = true;
    void updateStatus('online', undefined, undefined, 0, 'timer', nextMode, 0);
  });

  // --- Restore ---
  useEffect(() => {
    const restoreState = () => {
      if (storageOwner !== GUEST_OWNER) {
        // Explicit migration for authenticated accounts: legacy global-key
        // state of unknown or foreign ownership is discarded, never
        // inherited, so a newly authenticated account starts from defaults
        // (or its own saved state) instead of silently adopting guest state.
        clearForeignLegacyState(FULL_STATE_KEY);
        clearForeignLegacyState(TASK_STATE_KEY);
      }

      const state = readOwnedJson<SavedAppState>(FULL_STATE_KEY, storageOwner);
      if (state) {
        try {
          const now = Date.now();
          // A deadline that passed while the tab was closed means the timer
          // completed without its completion handler ever running.
          const expiredTargetTime =
            state.timer?.isRunning && state.timer.targetTime && state.timer.targetTime <= now
              ? state.timer.targetTime
              : null;

          if (now - state.lastUpdated < 24 * 60 * 60 * 1000) {
            setTab(state.activeTab);

            // For an expired timer, completeExpiredTimer (below) both applies
            // and persists the settled transition, and the snapshot's
            // intervals belong to the record it creates — so the timer slice
            // and interval hydration are skipped entirely in that case.
            if (!expiredTargetTime) {
              setTimerMode(state.timer.mode);
              setCycleCount(state.timer.cycleCount);
              setFocusLoggedSeconds(state.timer.loggedSeconds || 0);

              if (state.timer.isRunning && state.timer.targetTime) {
                setTimeLeft(Math.ceil((state.timer.targetTime - now) / 1000));
                setIsRunning(true);
                endTimeRef.current = state.timer.targetTime;
                currentIntervalStartRef.current = Date.now();
              } else {
                // An idle snapshot still sitting at the full duration that
                // was configured when it was written adopts the CURRENTLY
                // configured duration instead: settings may have changed
                // since (another tab, another device, or a save right before
                // this reload), and resurrecting the stale full time would
                // both display the old duration and open a phantom-save
                // window (fullTime - timeLeft counting minutes never
                // studied). Anything else — partial progress, banked
                // seconds, unstamped legacy snapshots — restores verbatim.
                const stampedFull = state.configuredDurations?.[state.timer.mode];
                const restoredSettings = readSettingsSnapshot();
                const configuredFull =
                  state.timer.mode === 'focus'
                    ? restoredSettings.pomoTime * 60
                    : state.timer.mode === 'shortBreak'
                      ? restoredSettings.shortBreak * 60
                      : restoredSettings.longBreak * 60;
                const idleAtStampedFull =
                  stampedFull !== undefined &&
                  state.timer.timeLeft === stampedFull &&
                  !(state.timer.loggedSeconds > 0);
                // A non-positive (or non-numeric) idle timeLeft is never
                // real progress — it is a finished-but-unsettled or corrupt
                // snapshot (e.g. an old client that persisted pomoTime 0
                // from a cleared input, whose settings now clamp to a
                // positive duration). Restoring it verbatim would show 00:00
                // and offer a save button for fullTime seconds never studied.
                const brokenIdle = !(state.timer.timeLeft > 0);
                if (brokenIdle) {
                  // The banked seconds' durable copy is the saved record or
                  // parked draft; keeping them against a fresh full timer
                  // would violate elapsed >= logged and silently under-record
                  // the next session.
                  setFocusLoggedSeconds(0);
                }
                setTimeLeft(
                  idleAtStampedFull || brokenIdle
                    ? configuredFull
                    : state.timer.timeLeft
                );
                setIsRunning(false);
              }
            }

            if (state.stopwatch.isRunning && state.stopwatch.startTime) {
              if (state.stopwatch.startTime > 1704067200000) {
                const elapsed = Math.floor((now - state.stopwatch.startTime) / 1000);
                setStopwatchTime(elapsed);
                setIsStopwatchRunning(true);
                stopwatchStartTimeRef.current = state.stopwatch.startTime;
                currentIntervalStartRef.current = Date.now();
              } else {
                setStopwatchTime(0);
                setIsStopwatchRunning(false);
              }
            } else {
              setStopwatchTime(state.stopwatch.elapsed);
              setIsStopwatchRunning(false);
            }

            if (!expiredTargetTime) {
              if (state.intervals) {
                setIntervals(state.intervals.filter(isValidInterval));
              }

              // Restore current interval start if available
              if (state.currentIntervalStart) {
                currentIntervalStartRef.current = state.currentIntervalStart;
              } else if ((state.timer.isRunning || state.stopwatch.isRunning) && !currentIntervalStartRef.current) {
                // Fallback for migration or if missing but running
                currentIntervalStartRef.current = Date.now();
              }
            } else {
              completeExpiredTimer(state, expiredTargetTime);
            }
          } else if (expiredTargetTime) {
            // The snapshot is too old to rehydrate UI state, but the session
            // it holds is still real and its segments end at the deadline —
            // complete and save it instead of silently discarding it.
            completeExpiredTimer(state, expiredTargetTime);
          }
        } catch (e) { console.error(e); }
      }

      // Sync with Server (Priority over local storage for active status)
      if (isLoggedIn) {
        // We need a way to check server status. 
        // Since useStudySession is a hook used in this component, we can use the exposed function if we added one, 
        // OR just do a direct call here if we didn't add it to the return of useStudySession yet. 
        // But we added `checkActiveSession` to useStudySession result in the previous step (conceptually).
        // Let's assume we can access it. 
        // Wait, destructuring `checkActiveSession` from `useStudySession` result at the top of component is needed first.
      }
    };
    restoreState();
  }, [setTimerMode, setCycleCount, setFocusLoggedSeconds, setTimeLeft, setIsRunning, endTimeRef, setIsStopwatchRunning, setStopwatchTime, stopwatchStartTimeRef, setIntervals, setSelectedTaskId, setSelectedTask, isLoggedIn, currentIntervalStartRef, storageOwner]);

  useEffect(() => {
    if (!isLoggedIn) return;

    // 이미 동기화 완료된 경우 스킵 (계정별로 마운트 시 1회만 실행)
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;

    // Dropped when the storage owner changes mid-flight so a late server
    // response can never hydrate another account's session.
    let cancelled = false;

    const syncServerState = async () => {
      try {
        // 로컬에서 이미 실행 중으로 복원된 경우 확인 (로컬 스토리지에서)
        const parsed = readOwnedJson<SavedAppState>(FULL_STATE_KEY, storageOwner);
        let localIsRunning = false;
        let localIsStopwatchRunning = false;
        let localElapsed = 0;
        let localTimerElapsed = 0;

        if (parsed) {
          try {
            localIsRunning = parsed.timer?.isRunning || false;
            localIsStopwatchRunning = parsed.stopwatch?.isRunning || false;
            localElapsed = parsed.stopwatch?.elapsed || 0;

            // 로컬에서 실행 중이었다면 startTime 기반으로 실제 경과 시간 계산
            if (localIsStopwatchRunning && parsed.stopwatch?.startTime) {
              const now = Date.now();
              localElapsed = Math.floor((now - parsed.stopwatch.startTime) / 1000);
            }

            // For timer, calculate elapsed from timeLeft and duration
            if (parsed.timer?.mode && parsed.timer?.timeLeft !== undefined) {
              const localMode = parsed.timer.mode;
              const localTimeLeft = parsed.timer.timeLeft;
              const localDuration = localMode === 'focus'
                ? settings.pomoTime * 60
                : localMode === 'shortBreak'
                  ? settings.shortBreak * 60
                  : settings.longBreak * 60;
              localTimerElapsed = localDuration - localTimeLeft;

              // 타이머가 실행 중이었다면 targetTime 기반으로 실제 남은 시간 계산
              if (localIsRunning && parsed.timer?.targetTime) {
                const now = Date.now();
                const actualRemaining = Math.max(0, Math.floor((parsed.timer.targetTime - now) / 1000));
                localTimerElapsed = localDuration - actualRemaining;
              }
            }
          } catch (e) {
            console.error('Error parsing local state for sync', e);
          }
        }

        // 로컬에서 이미 실행 중으로 복원된 경우, 서버 동기화 스킵
        if (localIsRunning || localIsStopwatchRunning) {
          console.log('[Sync] 로컬에서 실행 중인 세션이 복원됨. 서버 동기화 스킵.');
          return;
        }

        const data = await checkActiveSession();
        if (cancelled) return;
        if (data?.status === 'studying' && data.study_start_time) {
          const startTime = new Date(data.study_start_time).getTime();
          const now = Date.now();
          const elapsed = Math.floor((now - startTime) / 1000);

          if (elapsed >= 0) {
            // Found active session on server!
            if (data.timer_type === 'timer') {
              // Sync Pomodoro Timer
              const mode = normalizeTimerMode(data.timer_mode);
              const duration = data.timer_duration || (mode === 'focus' ? settings.pomoTime * 60 : mode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60);

              const remaining = duration - elapsed;
              if (remaining > 0) {
                // Remote hydration does not write through saveState.
                sessionRevisionRef.current += 1;
                setTab('timer');
                setTimerMode(mode);
                setTimeLeft(remaining);
                setIsRunning(true);
                endTimeRef.current = now + (remaining * 1000);

                if (mode === 'focus' && elapsed === 0) setFocusLoggedSeconds(0);
                if (mode === 'focus') setFocusLoggedSeconds(elapsed);

                toast.success('다른 기기에서 진행 중인 타이머를 불러왔습니다.', { icon: '🔄' });
              }
            } else {
              // Sync Stopwatch (Default)
              sessionRevisionRef.current += 1;
              setTab('stopwatch');
              setStopwatchTime(elapsed);
              setIsStopwatchRunning(true);
              stopwatchStartTimeRef.current = startTime;
              currentIntervalStartRef.current = now;

              toast.success('다른 기기에서 진행 중인 스톱워치를 불러왔습니다.', { icon: '🔄' });
            }
          }
        } else if (data?.total_stopwatch_time && data.total_stopwatch_time > 0) {
          // Found paused session - compare with local storage to prevent data loss

          if (data.timer_type === 'timer') {
            const mode = normalizeTimerMode(data.timer_mode);
            const duration = data.timer_duration || 0;
            const serverElapsed = data.total_stopwatch_time;

            // Use the larger elapsed time to prevent data loss
            const finalElapsed = Math.max(serverElapsed, localTimerElapsed);

            if (localTimerElapsed > serverElapsed) {
              console.log(`[Sync] 로컬 타이머 시간(${localTimerElapsed}s)이 DB(${serverElapsed}s)보다 큼. 로컬 값 유지.`);
            } else {
              const remaining = duration - finalElapsed;
              if (remaining > 0) {
                sessionRevisionRef.current += 1;
                setTab('timer');
                setTimerMode(mode);
                setTimeLeft(remaining);
                setIsRunning(false);
                if (mode === 'focus') setFocusLoggedSeconds(finalElapsed);
              }
            }
          } else {
            // Use the larger time to prevent data loss
            const serverTime = data.total_stopwatch_time;
            const maxTime = Math.max(localElapsed, serverTime);

            if (localElapsed > serverTime) {
              console.log(`[Sync] 로컬 스톱워치 시간(${localElapsed}s)이 DB(${serverTime}s)보다 큼. 로컬 값 유지.`);
            } else if (maxTime > 0) {
              // 서버 시간이 더 클 때만 업데이트
              sessionRevisionRef.current += 1;
              setTab('stopwatch');
              setStopwatchTime(maxTime);
              setIsStopwatchRunning(false);
            }
          }
        }
      } catch (e) {
        console.error('Sync failed', e);
      }
    };

    syncServerState();

    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, checkActiveSession, setTab, setStopwatchTime, setIsStopwatchRunning, stopwatchStartTimeRef, currentIntervalStartRef, setIntervals, settings, endTimeRef, setFocusLoggedSeconds, setIsRunning, setTimeLeft, setTimerMode, storageOwner]);




  // Persist Task. The mount-time flush runs with the initial empty selection
  // while useTasks' restore only reads the key after its async fetch — an
  // unconditional write here would clobber the stored selection before it is
  // ever read, so hold off until a real (restored or user-made) selection has
  // been seen for this storage owner.
  useEffect(() => {
    if (!taskStateDirtyRef.current) {
      if (selectedTaskId === null && selectedTask === '') return;
      taskStateDirtyRef.current = true;
    }
    writeOwnedJson(TASK_STATE_KEY, storageOwner, {
      taskId: selectedTaskId,
      taskTitle: selectedTask,
    });
  }, [selectedTaskId, selectedTask, storageOwner]);

  const handleSpaceToggle = useEffectEvent((event: KeyboardEvent) => {
    if (event.code !== 'Space' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName;
    const isFormField =
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      tagName === 'SELECT' ||
      target?.isContentEditable;
    if (isFormField || taskModalOpen) return;
    event.preventDefault();
    if (tab === 'timer') handleToggleTimer();
    else handleToggleStopwatch();
  });

  // Keyboard
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleSpaceToggle(event);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const displayCycleCount = getDisplayCycleCount(
    cycleCount,
    settings.longBreakInterval
  );

  // Update Document Title
  useEffect(() => {
    let modeString = 'fomopomo';
    let timeString = '';

    if (tab === 'timer') {
      timeString = formatTimeForTitle(timeLeft);
      if (timerMode === 'focus') modeString = '뽀모도로';
      else if (timerMode === 'shortBreak') modeString = '짧은 휴식';
      else if (timerMode === 'longBreak') modeString = '긴 휴식';
    } else {
      timeString = formatTimeForTitle(stopwatchTime);
      modeString = '스톱워치';
    }

    document.title = `${timeString} | ${modeString}`;

    return () => {
      document.title = 'Fomopomo';
    };
  }, [tab, timerMode, timeLeft, stopwatchTime]);


  return (
    <>
      <TaskModal
        isOpen={taskModalOpen}
        dbTasks={dbTasks}
        selectedTask={selectedTask}
        selectedTaskId={selectedTaskId}
        onSelectTask={(task, id) => { setSelectedTask(task); setSelectedTaskId(id); }}
        onSave={handleTaskSubmit}
        onSkip={handleTaskSkip}
        onDisablePopup={handleDisableTaskPopup}
      />

      <div className="relative w-full max-w-md mx-auto">
        <ThemeBackground tab={tab} timerMode={timerMode} isRunning={isRunning} isStopwatchRunning={isStopwatchRunning} />
        <div className={`relative w-full bg-white dark:bg-slate-800 rounded-[2rem] shadow-xl border border-gray-100 dark:border-slate-700 overflow-hidden transition-all duration-300 transform ${(isRunning || isStopwatchRunning) ? 'shadow-2xl scale-[1.02] ring-2 ring-offset-2 dark:ring-offset-slate-900' : ''
          } ${(isRunning || isStopwatchRunning) ? (
            tab === 'stopwatch' ? 'ring-indigo-200 dark:ring-indigo-900' :
              timerMode === 'focus' ? 'ring-rose-200 dark:ring-rose-900' :
                'ring-emerald-200 dark:ring-emerald-900'
          ) : ''
          }`}>

          <div className="flex items-center gap-2 m-2">
            <div className="flex-1 flex p-1 bg-gray-100 dark:bg-slate-900/50 rounded-2xl">
              <button onClick={() => setTab('timer')} className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all ${tab === 'timer' ? 'bg-white dark:bg-slate-800 text-gray-700 dark:text-white shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>타이머</button>
              <button onClick={() => setTab('stopwatch')} className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all ${tab === 'stopwatch' ? 'bg-white dark:bg-slate-800 text-gray-700 dark:text-white shadow-sm' : 'text-gray-400 dark:text-gray-500'}`}>스톱워치</button>
            </div>
            <button onClick={openTaskSidebar} className={`p-4 rounded-2xl transition-all shadow-sm border active:scale-95 ${selectedTaskId ? 'bg-rose-50 dark:bg-rose-900/20 text-rose-500 dark:text-rose-400 border-rose-100 dark:border-rose-900/50' : 'bg-white dark:bg-slate-800 text-gray-400 dark:text-gray-500 border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 17.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>
            </button>
          </div>

          <TaskSidebar isOpen={isTaskSidebarOpen} onClose={() => setIsTaskSidebarOpen(false)} tasks={dbTasks} weeklyPlans={weeklyPlans} monthlyPlans={monthlyPlans} longTermTasks={longTermTasks} pendingToggleSubtaskIds={pendingSubtaskIds} selectedTaskId={selectedTaskId} onSelectTask={(task) => { if (task) { setSelectedTask(task.title); setSelectedTaskId(task.id); } else { setSelectedTask(''); setSelectedTaskId(null); } }} onToggleTask={(task) => { void toggleTaskStatus(task); }} onSelectSubtask={(subtask) => selectSubtaskForTimer(subtask).then((row) => { if (row) { setSelectedTask(row.title); setSelectedTaskId(row.id); } return row; })} onToggleSubtask={(subtask) => { void toggleSubtask(subtask); }} />

          <div className={`px-6 py-8 sm:px-10 sm:py-10 flex flex-col items-center justify-center min-h-[360px] transition-colors duration-500 ${tab === 'stopwatch' ? 'bg-indigo-50 dark:bg-indigo-950/30' : (timerMode === 'focus' ? 'bg-rose-50 dark:bg-rose-950/30' : 'bg-emerald-50 dark:bg-emerald-950/30')}`}>
            {tab === 'timer' ? (
              <TimerDisplay
                timerMode={timerMode} timeLeft={timeLeft} isRunning={isRunning} isSaving={isSaving} cycleCount={displayCycleCount} longBreakInterval={settings.longBreakInterval} presets={settings.presets}
                showSaveButton={timerMode === 'focus' && !isRunning && (timerMode === 'focus' ? (settings.pomoTime * 60) : (timerMode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60)) - timeLeft - focusLoggedSeconds > 0}
                showResetButton={!isRunning && timeLeft !== (timerMode === 'focus' ? (settings.pomoTime * 60) : (timerMode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60))}
                onToggleTimer={handleToggleTimer}
                onResetTimer={() => {
                  resetTimerManual();
                  setIntervals([]);
                  saveState(tab, timerMode, false, timerMode === 'focus' ? settings.pomoTime * 60 : (timerMode === 'shortBreak' ? settings.shortBreak * 60 : settings.longBreak * 60), null, cycleCount, timerMode === 'focus' ? 0 : focusLoggedSeconds, isStopwatchRunning, stopwatchTime, null, [], null);
                  updateStatus('online', undefined, undefined, 0, 'timer', timerMode, 0);
                }}
                onSaveTimer={handleSaveTimer} onChangeMode={handleChangeTimerMode} onPresetClick={handlePresetClick}
                selectedTaskId={selectedTaskId} selectedTaskTitle={getSelectedTaskTitle() || selectedTask} onOpenTaskSidebar={openTaskSidebar} onClearTask={(e) => { e.stopPropagation(); setSelectedTaskId(null); setSelectedTask(''); }}
              />
            ) : (
              <StopwatchDisplay stopwatchTime={stopwatchTime} isStopwatchRunning={isStopwatchRunning} isSaving={isSaving} onToggleStopwatch={handleToggleStopwatch} onSaveStopwatch={handleSaveStopwatch} onResetStopwatch={handleResetStopwatch} selectedTaskId={selectedTaskId} selectedTaskTitle={getSelectedTaskTitle() || selectedTask} onOpenTaskSidebar={openTaskSidebar} onClearTask={(e) => { e.stopPropagation(); setSelectedTaskId(null); setSelectedTask(''); }} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
