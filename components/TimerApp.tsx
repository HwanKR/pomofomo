'use client';

import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import toast from 'react-hot-toast';

const formatTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export default function TimerApp() {
  const [mode, setMode] = useState<'pomo' | 'stopwatch'>('pomo');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const [pomoTime, setPomoTime] = useState(25 * 60);
  const [initialPomoTime, setInitialPomoTime] = useState(25 * 60);
  const [isPomoRunning, setIsPomoRunning] = useState(false);
  const pomoRef = useRef<NodeJS.Timeout | null>(null);

  const [stopwatchTime, setStopwatchTime] = useState(0);
  const [isStopwatchRunning, setIsStopwatchRunning] = useState(false);
  const stopwatchRef = useRef<NodeJS.Timeout | null>(null);

  // --- ☁️ 1. 로드 (로그인 한 사람만) ---
  useEffect(() => {
    const loadServerState = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      // 로그인 안 했으면 서버에서 불러올 것도 없음 -> 그냥 패스
      if (!user) {
        setIsLoaded(true);
        return;
      }

      const { data } = await supabase
        .from('timer_states')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (data) {
        setPomoTime(data.pomo_time);
        setStopwatchTime(data.stopwatch_time);
        setMode(data.mode as 'pomo' | 'stopwatch');
      }
      setIsLoaded(true);
    };

    loadServerState();
  }, []);

  // --- ☁️ 2. 동기화 (로그인 한 사람만) ---
  const syncStateToServer = async (
    currentMode: string,
    pTime: number,
    sTime: number
  ) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return; // 로그인 안 했으면 조용히 종료

    await supabase.from('timer_states').upsert({
      user_id: user.id,
      mode: currentMode,
      pomo_time: pTime,
      stopwatch_time: sTime,
    });
  };

  const playAlarm = () => {
    try {
      const audio = new Audio('/alarm.mp3');
      audio.play();
    } catch (error) {
      console.error('Audio playback failed:', error);
    }
  };

  // --- 💾 DB 저장 (핵심 수정: 비로그인 시 에러 안 내고 패스) ---
  const saveRecord = async (recordMode: string, duration: number) => {
    if (duration < 10) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    // ⭐️ 로그인 안 했으면 여기서 "저장 안 함" 처리하고 끝냄
    if (!user) {
      // (선택사항) 사용자에게 저장이 안 됐음을 가볍게 알릴 수도 있고, 그냥 넘어갈 수도 있음
      // 여기선 깔끔하게 아무것도 안 띄우거나, "로그인하면 기록됨" 힌트만 줄 수 있음
      return;
    }

    setIsSaving(true);
    const toastId = toast.loading('기록 저장 중...', {
      style: {
        background: 'rgba(0, 0, 0, 0.8)',
        color: '#fff',
        backdropFilter: 'blur(10px)',
      },
    });

    try {
      const { error } = await supabase.from('study_sessions').insert({
        mode: recordMode,
        duration: duration,
        user_id: user.id,
      });

      if (error) throw error;

      toast.success('저장이 완료되었습니다.', {
        id: toastId,
        style: {
          background: 'rgba(0, 0, 0, 0.8)',
          color: '#fff',
          backdropFilter: 'blur(10px)',
        },
      });
    } catch (e) {
      console.error(e);
      toast.error('저장 실패', { id: toastId });
    } finally {
      setIsSaving(false);
    }
  };

  // --- 🍅 뽀모도로 로직 ---
  useEffect(() => {
    if (pomoTime === 0 && isPomoRunning) {
      if (pomoRef.current) clearInterval(pomoRef.current);
      setIsPomoRunning(false);
      playAlarm();

      toast('집중 시간이 종료되었습니다.', {
        duration: 5000,
        icon: '🔔',
        style: {
          background: 'rgba(255, 255, 255, 0.1)',
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 4px 30px rgba(0, 0, 0, 0.1)',
          borderRadius: '16px',
          padding: '16px',
          fontWeight: '500',
        },
      });

      saveRecord('pomo', initialPomoTime);
      setPomoTime(initialPomoTime);
      syncStateToServer('pomo', initialPomoTime, stopwatchTime);
    }
  }, [pomoTime, isPomoRunning, initialPomoTime]);

  const togglePomo = () => {
    if (isPomoRunning) {
      if (pomoRef.current) clearInterval(pomoRef.current);
      setIsPomoRunning(false);
      toast('타이머가 일시 정지되었습니다.', {
        icon: '⏸️',
        style: { background: '#333', color: '#fff' },
      });
      syncStateToServer('pomo', pomoTime, stopwatchTime);
    } else {
      setIsPomoRunning(true);
      toast('집중 모드를 시작합니다.', {
        icon: '▶️',
        style: { background: '#333', color: '#fff' },
      });
      pomoRef.current = setInterval(() => {
        setPomoTime((prev) => (prev <= 0 ? 0 : prev - 1));
      }, 1000);
    }
  };

  const setPomoDuration = (minutes: number) => {
    if (pomoRef.current) clearInterval(pomoRef.current);
    setIsPomoRunning(false);
    const newTime = minutes * 60;
    setPomoTime(newTime);
    setInitialPomoTime(newTime);
    toast.success(
      `${minutes === 0.1 ? '5초' : minutes + '분'}으로 설정되었습니다.`,
      { style: { background: '#333', color: '#fff' } }
    );
    syncStateToServer('pomo', newTime, stopwatchTime);
  };

  const resetPomo = () => {
    setPomoDuration(25);
  };

  // --- ⏱️ 스톱워치 로직 ---
  const toggleStopwatch = () => {
    if (isStopwatchRunning) {
      if (stopwatchRef.current) clearInterval(stopwatchRef.current);
      setIsStopwatchRunning(false);
      toast('측정이 일시 정지되었습니다.', {
        icon: '⏸️',
        style: { background: '#333', color: '#fff' },
      });
      syncStateToServer('stopwatch', pomoTime, stopwatchTime);
    } else {
      setIsStopwatchRunning(true);
      toast('시간 측정을 시작합니다.', {
        icon: '▶️',
        style: { background: '#333', color: '#fff' },
      });
      stopwatchRef.current = setInterval(() => {
        setStopwatchTime((prev) => prev + 1);
      }, 1000);
    }
  };

  const handleStopwatchSave = async () => {
    await saveRecord('stopwatch', stopwatchTime);
    setStopwatchTime(0);
    setIsStopwatchRunning(false);
    if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    syncStateToServer('stopwatch', pomoTime, 0);
  };

  const resetStopwatch = () => {
    if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    setIsStopwatchRunning(false);
    setStopwatchTime(0);
    toast('초기화되었습니다.', {
      style: { background: '#333', color: '#fff' },
    });
    syncStateToServer('stopwatch', pomoTime, 0);
  };

  const changeMode = (newMode: 'pomo' | 'stopwatch') => {
    setMode(newMode);
    if (!isPomoRunning && !isStopwatchRunning) {
      syncStateToServer(newMode, pomoTime, stopwatchTime);
    }
  };

  useEffect(() => {
    return () => {
      if (pomoRef.current) clearInterval(pomoRef.current);
      if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-md bg-gray-800 rounded-3xl shadow-2xl border border-gray-700 overflow-hidden mb-8 transition-all duration-300">
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => changeMode('pomo')}
          className={`flex-1 py-4 text-lg font-medium transition-colors ${
            mode === 'pomo'
              ? 'bg-gray-700 text-red-400'
              : 'bg-gray-800 text-gray-500 hover:bg-gray-750'
          }`}
        >
          뽀모도로
        </button>
        <button
          onClick={() => changeMode('stopwatch')}
          className={`flex-1 py-4 text-lg font-medium transition-colors ${
            mode === 'stopwatch'
              ? 'bg-gray-700 text-blue-400'
              : 'bg-gray-800 text-gray-500 hover:bg-gray-750'
          }`}
        >
          스톱워치
        </button>
      </div>

      <div className="p-8 flex flex-col items-center justify-center min-h-[300px]">
        {!isLoaded ? (
          <div className="text-gray-500 animate-pulse">준비 중...</div>
        ) : mode === 'pomo' ? (
          <div className="text-center animate-fade-in w-full">
            <div className="mb-6 flex justify-center">
              {isPomoRunning ? (
                <span className="px-4 py-1 rounded-full bg-red-500/10 text-red-400 text-sm font-bold border border-red-500/30 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                  집중 모드
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-gray-700 text-gray-400 text-sm font-medium border border-gray-600">
                  대기
                </span>
              )}
            </div>

            <div
              className={`text-7xl font-bold mb-8 font-mono tabular-nums tracking-tighter transition-colors ${
                isPomoRunning ? 'text-red-400' : 'text-gray-500'
              }`}
            >
              {formatTime(pomoTime)}
            </div>

            <div className="flex gap-2 justify-center mb-8">
              <button
                onClick={() => setPomoDuration(25)}
                className="px-4 py-1 rounded-full text-sm border border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
              >
                집중 (25분)
              </button>
              <button
                onClick={() => setPomoDuration(5)}
                className="px-4 py-1 rounded-full text-sm border border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
              >
                휴식 (5분)
              </button>
              <button
                onClick={() => setPomoDuration(0.1)}
                className="px-4 py-1 rounded-full text-sm border border-red-900 text-red-500 hover:bg-red-900 transition-colors"
              >
                테스트 (5초)
              </button>
            </div>

            <div className="flex gap-4 justify-center">
              <button
                onClick={togglePomo}
                className={`px-8 py-3 rounded-xl font-bold text-lg transition-all ${
                  isPomoRunning
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30'
                    : 'bg-red-600 text-white hover:bg-red-700 shadow-lg'
                }`}
              >
                {isPomoRunning ? '일시 정지' : '시작'}
              </button>
              {!isPomoRunning && pomoTime !== initialPomoTime && (
                <button
                  onClick={resetPomo}
                  className="px-4 py-3 rounded-xl font-medium text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                >
                  초기화
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center animate-fade-in w-full">
            <div className="mb-6 flex justify-center">
              {isStopwatchRunning ? (
                <span className="px-4 py-1 rounded-full bg-blue-500/10 text-blue-400 text-sm font-bold border border-blue-500/30 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
                  측정 중
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-gray-700 text-gray-400 text-sm font-medium border border-gray-600">
                  대기
                </span>
              )}
            </div>

            <div
              className={`text-7xl font-bold mb-8 font-mono tabular-nums tracking-tighter transition-colors ${
                isStopwatchRunning ? 'text-blue-400' : 'text-gray-500'
              }`}
            >
              {formatTime(stopwatchTime)}
            </div>

            <div className="flex gap-4 justify-center">
              <button
                onClick={toggleStopwatch}
                className={`px-8 py-3 rounded-xl font-bold text-lg transition-all ${
                  isStopwatchRunning
                    ? 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30'
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg'
                }`}
              >
                {isStopwatchRunning ? '일시 정지' : '시작'}
              </button>
              {!isStopwatchRunning && stopwatchTime > 0 && (
                <button
                  onClick={handleStopwatchSave}
                  disabled={isSaving}
                  className="px-4 py-3 rounded-xl font-bold text-white bg-green-600 hover:bg-green-700 shadow-lg transition-all flex items-center gap-2"
                >
                  {isSaving ? '저장 중...' : '저장'}
                </button>
              )}
              {!isStopwatchRunning && stopwatchTime > 0 && !isSaving && (
                <button
                  onClick={resetStopwatch}
                  className="px-4 py-3 rounded-xl font-medium text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
                >
                  초기화
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
