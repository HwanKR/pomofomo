import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useTimerLogic } from '../useTimerLogic';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Settings } from '../useSettings';

// Mock dependencies
const mockPlayClickSound = vi.fn();
const mockUpdateStatus = vi.fn();
const mockOnTimerComplete = vi.fn();

const defaultSettings: Settings = {
  pomoTime: 25,
  shortBreak: 5,
  longBreak: 15,
  longBreakInterval: 4,
  autoStartPomos: false,
  autoStartBreaks: false,
  volume: 0.5,
  isMuted: false,
  taskPopupEnabled: true,
  seasonalEffectEnabled: true,
  tasks: ['국어', '수학', '영어'],
  presets: []
};

describe('useTimerLogic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockPlayClickSound.mockClear();
    mockUpdateStatus.mockClear();
    mockOnTimerComplete.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should initialize with default states', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: defaultSettings,
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    expect(result.current.timerMode).toBe('focus');
    expect(result.current.timeLeft).toBe(25 * 60);
    expect(result.current.isRunning).toBe(false);
  });

  it('should start timer and decrease time', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: defaultSettings,
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    act(() => {
      result.current.toggleTimer();
    });

    expect(result.current.isRunning).toBe(true);
    expect(mockPlayClickSound).toHaveBeenCalled();

    // Advance by 1 second
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Since the logic relies on Date.now(), we need to advance system time too
    // vi.advanceTimersByTime handles this automatically if configured, or checks intervals
    // but the hook uses `Date.now()` inside the interval.
    // Vitest's fake timers should mock Date.now() as well.
    
    // The hook updates every 200ms.
    // 1000ms passed -> timeLeft should be 25*60 - 1
    
    expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 1, 0);
  });

  it('should call onTimerComplete when time runs out', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: { ...defaultSettings, pomoTime: 0.1 }, // 6 seconds
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    // Set time explicitly or trust init? 0.1 min = 6 sec
    expect(result.current.timeLeft).toBe(6);

    act(() => {
      result.current.toggleTimer();
    });

    act(() => {
      vi.advanceTimersByTime(6500); // 6.5s to be safe
    });

    expect(result.current.timeLeft).toBe(0);
    expect(result.current.isRunning).toBe(false);
    expect(mockOnTimerComplete).toHaveBeenCalled();
  });

  it('should pause and resume without losing time', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: defaultSettings,
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    // Start
    act(() => {
      result.current.toggleTimer();
    });
    
    // Advance 10 seconds
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    
    expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 10, 0);

    // Pause
    act(() => {
      result.current.toggleTimer();
    });
    expect(result.current.isRunning).toBe(false);
    expect(mockUpdateStatus).toHaveBeenLastCalledWith(
      'paused',
      undefined,
      undefined,
      10,
      'timer',
      'focus',
      25 * 60
    );

    // Wait 5 seconds (paused)
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Time should not change
    expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 10, 0);

    // Resume
    act(() => {
      result.current.toggleTimer();
    });
    expect(result.current.isRunning).toBe(true);

    // Advance 5 more seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Total elapsed should be 15 seconds
    expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 15, 0);
  });

  it('should change functionality when mode switches', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: defaultSettings, // Short Break is 5 min
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    act(() => {
      result.current.changeTimerMode('shortBreak');
    });

    expect(result.current.timerMode).toBe('shortBreak');
    expect(result.current.timeLeft).toBe(5 * 60);

    // Start in break mode
    act(() => {
      result.current.toggleTimer();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.timeLeft).toBe(5 * 60 - 1);
  });

  describe('startTimer (atomic start used by auto-start)', () => {
    it('does not instantly complete when started after a completed cycle left an expired deadline', () => {
      const { result } = renderHook(() =>
        useTimerLogic({
          settings: { ...defaultSettings, pomoTime: 0.1 }, // 6 seconds
          onTimerCompleteRef: { current: mockOnTimerComplete },
          playClickSound: mockPlayClickSound,
          updateStatus: mockUpdateStatus,
        })
      );

      // Run the focus session to completion → endTimeRef now points at the past
      act(() => {
        result.current.toggleTimer();
      });
      act(() => {
        vi.advanceTimersByTime(6500);
      });
      expect(mockOnTimerComplete).toHaveBeenCalledTimes(1);
      expect(result.current.isRunning).toBe(false);

      // TimerApp schedules the auto-start 1s after completion
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // Atomic auto-start: explicit mode + remaining recompute the deadline
      act(() => {
        result.current.startTimer({ mode: 'shortBreak', remainingSeconds: 5 * 60 });
      });

      expect(result.current.isRunning).toBe(true);
      expect(result.current.timerMode).toBe('shortBreak');
      expect(result.current.timeLeft).toBe(5 * 60);

      // Regression: the old code kept the expired deadline, so the first
      // 200ms tick completed the timer again immediately.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(mockOnTimerComplete).toHaveBeenCalledTimes(1); // still only the focus completion
      expect(result.current.isRunning).toBe(true);
      expect(result.current.timeLeft).toBeCloseTo(5 * 60 - 2, 0);

      // Break start reports 'online' status like a manual break start
      expect(mockUpdateStatus).toHaveBeenLastCalledWith(
        'online',
        undefined,
        expect.any(String),
        undefined,
        'timer',
        'shortBreak',
        5 * 60
      );

      // The break completes exactly once, at its real duration
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(mockOnTimerComplete).toHaveBeenCalledTimes(2);
      expect(result.current.isRunning).toBe(false);
    });

    it('starts from current state when called without overrides', () => {
      const { result } = renderHook(() =>
        useTimerLogic({
          settings: defaultSettings,
          onTimerCompleteRef: { current: mockOnTimerComplete },
          playClickSound: mockPlayClickSound,
          updateStatus: mockUpdateStatus,
        })
      );

      act(() => {
        result.current.startTimer();
      });

      expect(result.current.isRunning).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 1, 0);
      expect(mockOnTimerComplete).not.toHaveBeenCalled();
    });
  });

  describe('settings changes while idle (re-sync)', () => {
    // StrictMode locks in the render-phase state adjustment's double-render
    // safety (the app runs under Next's default reactStrictMode).
    const renderTimer = (initialSettings: Settings = defaultSettings) =>
      renderHook(
        ({ settings }: { settings: Settings }) =>
          useTimerLogic({
            settings,
            onTimerCompleteRef: { current: mockOnTimerComplete },
            playClickSound: mockPlayClickSound,
            updateStatus: mockUpdateStatus,
          }),
        { initialProps: { settings: initialSettings }, wrapper: StrictMode }
      );

    it('uses the scheduled auto-start duration even if settings change during its delay', () => {
      const { result, rerender } = renderTimer();
      const scheduledBreak = 5 * 60;
      rerender({ settings: { ...defaultSettings, shortBreak: 10 } });

      act(() => {
        result.current.startTimer({
          mode: 'shortBreak', remainingSeconds: scheduledBreak, durationSeconds: scheduledBreak,
        });
      });
      expect(result.current.timerDuration).toBe(scheduledBreak);
      expect(mockUpdateStatus).toHaveBeenLastCalledWith(
        'online', undefined, new Date().toISOString(), undefined, 'timer', 'shortBreak', scheduledBreak
      );

      act(() => { vi.advanceTimersByTime(60_000); });
      act(() => { result.current.toggleTimer(); });
      expect(result.current.timeLeft).toBe(240);
      expect(mockUpdateStatus).toHaveBeenLastCalledWith(
        'paused', undefined, undefined, 60, 'timer', 'shortBreak', scheduledBreak
      );
    });

    it('re-syncs an idle focus timer to the new pomoTime', () => {
      const { result, rerender } = renderTimer();
      expect(result.current.timeLeft).toBe(25 * 60);

      rerender({ settings: { ...defaultSettings, pomoTime: 50 } });

      expect(result.current.timeLeft).toBe(50 * 60);

      // Starting now runs against the new duration, not the stale one
      act(() => {
        result.current.toggleTimer();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.timeLeft).toBeCloseTo(50 * 60 - 1, 0);
    });

    it('re-syncs an idle break timer to the new break length', () => {
      const { result, rerender } = renderTimer();
      act(() => {
        result.current.changeTimerMode('shortBreak');
      });
      expect(result.current.timeLeft).toBe(5 * 60);

      rerender({ settings: { ...defaultSettings, shortBreak: 10 } });

      expect(result.current.timeLeft).toBe(10 * 60);
    });

    it('keeps the remaining time of a running timer', () => {
      const { result, rerender } = renderTimer();
      act(() => {
        result.current.toggleTimer();
      });
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 10, 0);

      rerender({ settings: { ...defaultSettings, pomoTime: 50 } });

      expect(result.current.isRunning).toBe(true);
      expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 10, 0);

      // Still counting down against the original deadline
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 11, 0);
    });

    it('keeps the remaining time of a paused timer', () => {
      const { result, rerender } = renderTimer();
      act(() => {
        result.current.toggleTimer();
      });
      act(() => {
        vi.advanceTimersByTime(10000);
      });
      act(() => {
        result.current.toggleTimer(); // pause
      });
      expect(result.current.isRunning).toBe(false);

      rerender({ settings: { ...defaultSettings, pomoTime: 50 } });

      expect(result.current.timeLeft).toBeCloseTo(25 * 60 - 10, 0);
    });

    it('keeps partial progress hydrated from a restored snapshot', () => {
      const { result, rerender } = renderTimer();
      // Simulate TimerApp's restore effect rehydrating a paused snapshot
      act(() => {
        result.current.setTimeLeft(20 * 60);
      });

      rerender({ settings: { ...defaultSettings, pomoTime: 50 } });

      expect(result.current.timeLeft).toBe(20 * 60);
    });

    it('keeps a session with banked focus seconds even at full duration', () => {
      const { result, rerender } = renderTimer();
      act(() => {
        result.current.setFocusLoggedSeconds(600);
      });

      rerender({ settings: { ...defaultSettings, pomoTime: 50 } });

      expect(result.current.timeLeft).toBe(25 * 60);
    });
  });

  it('should reset timer manually', () => {
    const { result } = renderHook(() =>
      useTimerLogic({
        settings: defaultSettings,
        onTimerCompleteRef: { current: mockOnTimerComplete },
        playClickSound: mockPlayClickSound,
        updateStatus: mockUpdateStatus,
      })
    );

    // Start and advance
    act(() => {
      result.current.toggleTimer();
    });
    
    act(() => {
      vi.advanceTimersByTime(60000); // 1 min
    });

    expect(result.current.timeLeft).toBe(24 * 60);

    // Reset
    act(() => {
      result.current.resetTimerManual();
    });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.timeLeft).toBe(25 * 60);
    expect(result.current.focusLoggedSeconds).toBe(0);
  });
});
