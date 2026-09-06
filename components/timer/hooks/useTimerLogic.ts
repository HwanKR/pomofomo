import { useState, useRef, useEffect, useCallback } from 'react';
import { Settings } from './useSettings';

export type TimerMode = 'focus' | 'shortBreak' | 'longBreak';

interface UseTimerLogicProps {
  settings: Settings;
  onTimerCompleteRef: React.MutableRefObject<() => void>;
  playClickSound: () => void;
  updateStatus: (status: 'studying' | 'paused' | 'online', task?: string, startTime?: string, elapsed?: number, timerType?: 'timer' | 'stopwatch', timerMode?: 'focus' | 'shortBreak' | 'longBreak', timerDuration?: number) => void;
}

export const useTimerLogic = ({
  settings,
  onTimerCompleteRef,
  playClickSound,
  updateStatus,
}: UseTimerLogicProps) => {
  const [timerMode, setTimerMode] = useState<TimerMode>('focus');
  const [timeLeft, setTimeLeft] = useState(settings.pomoTime * 60);
  // The active session may have been started on a device with different
  // settings. Its elapsed time must use its own original duration.
  const [timerDuration, setTimerDuration] = useState(settings.pomoTime * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [cycleCount, setCycleCount] = useState(0);
  const [focusLoggedSeconds, setFocusLoggedSeconds] = useState(0);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const endTimeRef = useRef<number>(0);

  // Re-sync an idle timer when the configured durations change (e.g. the
  // settings modal saves pomoTime 25 -> 50), adjusting state during render —
  // the same idiom as TimerApp's storage-owner reset. Only a timer still
  // sitting at the PREVIOUS settings' full duration for its mode is
  // re-synced: a running or paused session, and partial progress restored
  // from storage, keep their real remaining time — overwriting them would
  // fabricate or destroy elapsed time. TimerApp's restore effect commits
  // after this render, so a restored snapshot always wins over the re-sync.
  const configuredDurations: Record<TimerMode, number> = {
    focus: settings.pomoTime * 60,
    shortBreak: settings.shortBreak * 60,
    longBreak: settings.longBreak * 60,
  };
  const [prevDurations, setPrevDurations] = useState(configuredDurations);
  if (
    prevDurations.focus !== configuredDurations.focus ||
    prevDurations.shortBreak !== configuredDurations.shortBreak ||
    prevDurations.longBreak !== configuredDurations.longBreak
  ) {
    // Consume the change unconditionally: a duration change that arrives
    // mid-session must not be re-applied later against a stale baseline.
    setPrevDurations(configuredDurations);
    if (
      !isRunning &&
      focusLoggedSeconds === 0 &&
      timerDuration === prevDurations[timerMode] &&
      timeLeft === prevDurations[timerMode]
    ) {
      setTimeLeft(configuredDurations[timerMode]);
      setTimerDuration(configuredDurations[timerMode]);
    }
  }

  // Timer interval
  useEffect(() => {
    if (isRunning) {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          const now = Date.now();
          const diff = Math.ceil((endTimeRef.current - now) / 1000);
          if (diff <= 0) {
            // Stop the interval synchronously: waiting for the isRunning
            // effect cleanup would let queued ticks (e.g. after background
            // tab throttling) re-fire completion multiple times.
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            setTimeLeft(0);
            setIsRunning(false);
            onTimerCompleteRef.current();
          } else {
            setTimeLeft(diff);
          }
        }, 200);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        // Reset so a re-run of this effect can start a new interval instead
        // of mistaking the cleared id for a live one.
        timerRef.current = null;
      }
    };
  }, [isRunning, onTimerCompleteRef]);

  // Atomic start transition shared by manual toggles and auto-starts.
  // The fresh deadline MUST be computed before isRunning flips to true:
  // starting with a stale endTimeRef from a completed cycle would make the
  // first interval tick see diff <= 0 and complete the timer instantly.
  // Callers firing from stale closures (e.g. delayed auto-start) pass the
  // intended mode/remaining explicitly instead of relying on current state.
  const startTimer = useCallback((options?: { mode?: TimerMode; remainingSeconds?: number; durationSeconds?: number }) => {
    const mode = options?.mode ?? timerMode;
    const duration = options?.durationSeconds ?? (options?.mode === undefined
      ? timerDuration
      : mode === 'focus'
        ? settings.pomoTime * 60
        : mode === 'shortBreak'
          ? settings.shortBreak * 60
          : settings.longBreak * 60);
    const remaining = options?.remainingSeconds ?? timeLeft;

    endTimeRef.current = Date.now() + (remaining * 1000);
    if (options?.mode !== undefined) setTimerMode(options.mode);
    setTimerDuration(duration);
    if (options?.remainingSeconds !== undefined) setTimeLeft(options.remainingSeconds);
    setIsRunning(true);

    // We don't store "start time" for countdown timer in the same way as stopwatch (Date.now() - elapsed),
    // but we can pass the "logical start time" if we wanted to calculate drift,
    // OR just rely on "duration - elapsed" sync.
    // For sync, we need: startTime = Date.now() - (duration - timeLeft)?
    // If we want the client to calc elapsed: Date.now() - startTime.
    // So logical startTime = Date.now() - (elapsed).
    // elapsed = duration - timeLeft.
    const elapsed = duration - remaining;
    const logicalStart = Date.now() - (elapsed * 1000);

    // Only set status to 'studying' for focus mode (triggers friend notification)
    // Break modes should use 'online' to avoid sending "study started" notification
    const statusForMode = mode === 'focus' ? 'studying' : 'online';
    updateStatus(statusForMode, undefined, new Date(logicalStart).toISOString(), undefined, 'timer', mode, duration);
  }, [timerMode, timeLeft, timerDuration, settings, updateStatus]);

  const toggleTimer = useCallback((forceStart = false) => {
    playClickSound();

    if (!forceStart && isRunning) {
      // Pause
      setIsRunning(false);
      updateStatus('paused', undefined, undefined, timerDuration - timeLeft, 'timer', timerMode, timerDuration);
    } else {
      startTimer();
    }
  }, [isRunning, timeLeft, timerMode, timerDuration, playClickSound, updateStatus, startTimer]);

  const resetTimerManual = useCallback(() => {
    setIsRunning(false);
    let resetTime = 0;
    if (timerMode === "focus") resetTime = settings.pomoTime * 60;
    else if (timerMode === "shortBreak") resetTime = settings.shortBreak * 60;
    else resetTime = settings.longBreak * 60;

    setTimeLeft(resetTime);
    setTimerDuration(resetTime);
    if (timerMode === 'focus') setFocusLoggedSeconds(0);
    return resetTime;
  }, [timerMode, settings]);

  const changeTimerMode = useCallback((mode: TimerMode) => {
    if (isRunning) setIsRunning(false);
    setTimerMode(mode);

    let newTime = 0;
    if (mode === "focus") newTime = settings.pomoTime * 60;
    else if (mode === "shortBreak") newTime = settings.shortBreak * 60;
    else newTime = settings.longBreak * 60;

    setTimeLeft(newTime);
    setTimerDuration(newTime);
    if (mode === 'focus') setFocusLoggedSeconds(0);
    return newTime;
  }, [isRunning, settings]);

  return {
    timerMode,
    timeLeft,
    timerDuration,
    isRunning,
    cycleCount,
    focusLoggedSeconds,
    setTimerMode,
    setTimeLeft,
    setTimerDuration,
    setIsRunning,
    setCycleCount,
    setFocusLoggedSeconds,
    startTimer,
    toggleTimer,
    resetTimerManual,
    changeTimerMode,
    endTimeRef
  };
};
