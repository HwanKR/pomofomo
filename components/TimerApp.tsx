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

  // --- 🔊 소리 재생 ---
  const playAlarm = () => {
    try {
      const audio = new Audio('/alarm.mp3');
      audio.play();
    } catch (error) {
      console.error('소리 재생 실패:', error);
    }
  };

  // --- 💾 DB 저장 ---
  const saveRecord = async (recordMode: string, duration: number) => {
    if (duration < 10) return;

    setIsSaving(true);
    const toastId = toast.loading('기록 저장 중...', {
      style: {
        background: 'rgba(0, 0, 0, 0.8)', // 반투명 검정
        color: '#fff',
        backdropFilter: 'blur(10px)', // ✨ 블러 효과
      },
    });

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error('로그인이 필요합니다!', { id: toastId });
        return;
      }

      const { error } = await supabase.from('study_sessions').insert({
        mode: recordMode,
        duration: duration,
        user_id: user.id,
      });

      if (error) throw error;

      toast.success('🔥 공부 기록 저장 완료!', {
        id: toastId,
        style: {
          background: 'rgba(0, 0, 0, 0.8)',
          color: '#fff',
          backdropFilter: 'blur(10px)',
        },
      });
    } catch (e) {
      console.error(e);
      toast.error('저장에 실패했습니다.', { id: toastId });
    } finally {
      setIsSaving(false);
    }
  };

  // --- 🍅 뽀모도로 로직 ---
  const [pomoTime, setPomoTime] = useState(25 * 60);
  const [initialPomoTime, setInitialPomoTime] = useState(25 * 60);
  const [isPomoRunning, setIsPomoRunning] = useState(false);
  const pomoRef = useRef<NodeJS.Timeout | null>(null);

  // ⭐️ 핵심 수정: 숫자가 0이 되었는지 감시하는 별도의 눈 (useEffect)
  useEffect(() => {
    if (pomoTime === 0 && isPomoRunning) {
      // 1. 타이머 멈춤
      if (pomoRef.current) clearInterval(pomoRef.current);
      setIsPomoRunning(false);

      // 2. 소리 재생
      playAlarm();

      // 3. ✨ 흐림 효과 알림 띄우기 (딱 한 번만 실행됨)
      toast('⏰ 집중 시간이 끝났습니다! 고생했어요.', {
        duration: 5000,
        icon: '👏',
        style: {
          background: 'rgba(255, 255, 255, 0.1)', // 아주 투명한 흰색 배경
          color: '#fff',
          border: '1px solid rgba(255, 255, 255, 0.2)', // 얇은 테두리
          backdropFilter: 'blur(12px)', // ✨ 뒤가 흐릿하게 비치는 효과 (Frosted Glass)
          boxShadow: '0 4px 30px rgba(0, 0, 0, 0.1)', // 그림자
          borderRadius: '16px', // 둥글게
          padding: '16px',
          fontWeight: 'bold',
        },
      });

      // 4. 저장
      saveRecord('pomo', initialPomoTime);
    }
  }, [pomoTime, isPomoRunning, initialPomoTime]); // 이 값들이 변할 때만 검사함

  const togglePomo = () => {
    if (isPomoRunning) {
      if (pomoRef.current) clearInterval(pomoRef.current);
      setIsPomoRunning(false);
      toast('잠시 멈췄어요', {
        icon: '⏸️',
        style: { background: '#333', color: '#fff' },
      });
    } else {
      setIsPomoRunning(true);
      toast('집중 시작! 화이팅 🔥', {
        icon: '🍅',
        style: { background: '#333', color: '#fff' },
      });

      pomoRef.current = setInterval(() => {
        setPomoTime((prev) => {
          if (prev <= 0) return 0; // 0 밑으로는 내려가지 않게 방어
          return prev - 1;
        });
      }, 1000);
    }
  };

  const setPomoDuration = (minutes: number) => {
    if (pomoRef.current) clearInterval(pomoRef.current);
    setIsPomoRunning(false);
    setPomoTime(minutes * 60);
    setInitialPomoTime(minutes * 60);
    toast.success(`${minutes === 0.1 ? '5초' : minutes + '분'}으로 설정됨`, {
      style: { background: '#333', color: '#fff' },
    });
  };

  const resetPomo = () => {
    setPomoDuration(25);
  };

  // --- ⏱️ 스톱워치 로직 ---
  const [stopwatchTime, setStopwatchTime] = useState(0);
  const [isStopwatchRunning, setIsStopwatchRunning] = useState(false);
  const stopwatchRef = useRef<NodeJS.Timeout | null>(null);

  const toggleStopwatch = () => {
    if (isStopwatchRunning) {
      if (stopwatchRef.current) clearInterval(stopwatchRef.current);
      setIsStopwatchRunning(false);
      toast('스톱워치 일시정지', {
        icon: '⏸️',
        style: { background: '#333', color: '#fff' },
      });
    } else {
      setIsStopwatchRunning(true);
      toast('기록 시작!', {
        icon: '⏱️',
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
  };

  const resetStopwatch = () => {
    if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    setIsStopwatchRunning(false);
    setStopwatchTime(0);
    toast('리셋되었습니다', {
      style: { background: '#333', color: '#fff' },
    });
  };

  useEffect(() => {
    return () => {
      if (pomoRef.current) clearInterval(pomoRef.current);
      if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-md bg-gray-800 rounded-3xl shadow-2xl border border-gray-700 overflow-hidden mb-8 transition-all duration-300 hover:shadow-red-900/10">
      {/* 상단 탭 */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setMode('pomo')}
          className={`flex-1 py-4 text-lg font-medium transition-colors ${
            mode === 'pomo'
              ? 'bg-gray-700 text-red-400'
              : 'bg-gray-800 text-gray-500 hover:bg-gray-750'
          }`}
        >
          뽀모도로
        </button>
        <button
          onClick={() => setMode('stopwatch')}
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
        {mode === 'pomo' ? (
          <div className="text-center animate-fade-in w-full">
            {/* ✨ 상태 배지 */}
            <div className="mb-6 flex justify-center">
              {isPomoRunning ? (
                <span className="px-4 py-1 rounded-full bg-red-500/20 text-red-400 text-sm font-bold border border-red-500/50 animate-pulse flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500"></span>
                  🔥 집중하는 중
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-gray-700 text-gray-400 text-sm font-medium border border-gray-600">
                  💤 대기 중
                </span>
              )}
            </div>

            <div
              className={`text-7xl font-bold mb-8 font-mono tabular-nums tracking-tighter transition-colors ${
                isPomoRunning
                  ? 'text-red-400 drop-shadow-[0_0_15px_rgba(248,113,113,0.5)]'
                  : 'text-gray-500'
              }`}
            >
              {formatTime(pomoTime)}
            </div>

            <div className="flex gap-2 justify-center mb-8">
              <button
                onClick={() => setPomoDuration(25)}
                className="px-3 py-1 rounded-full text-sm border border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
              >
                🔥 집중 (25분)
              </button>
              <button
                onClick={() => setPomoDuration(5)}
                className="px-3 py-1 rounded-full text-sm border border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
              >
                ☕ 휴식 (5분)
              </button>
              <button
                onClick={() => setPomoDuration(0.1)}
                className="px-3 py-1 rounded-full text-sm border border-red-900 text-red-500 hover:bg-red-900 transition-colors"
              >
                ⚡ 테스트 (5초)
              </button>
            </div>

            <div className="flex gap-4 justify-center">
              <button
                onClick={togglePomo}
                className={`px-8 py-3 rounded-xl font-bold text-lg transition-all ${
                  isPomoRunning
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/50'
                    : 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30'
                }`}
              >
                {isPomoRunning ? '일시정지' : '집중 시작'}
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
            {/* ✨ 스톱워치 상태 배지 */}
            <div className="mb-6 flex justify-center">
              {isStopwatchRunning ? (
                <span className="px-4 py-1 rounded-full bg-blue-500/20 text-blue-400 text-sm font-bold border border-blue-500/50 animate-pulse flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                  ⏱️ 기록 중
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-gray-700 text-gray-400 text-sm font-medium border border-gray-600">
                  💤 대기 중
                </span>
              )}
            </div>

            <div
              className={`text-7xl font-bold mb-8 font-mono tabular-nums tracking-tighter transition-colors ${
                isStopwatchRunning
                  ? 'text-blue-400 drop-shadow-[0_0_15px_rgba(96,165,250,0.5)]'
                  : 'text-gray-500'
              }`}
            >
              {formatTime(stopwatchTime)}
            </div>

            <div className="flex gap-4 justify-center">
              <button
                onClick={toggleStopwatch}
                className={`px-8 py-3 rounded-xl font-bold text-lg transition-all ${
                  isStopwatchRunning
                    ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/50'
                    : 'bg-blue-500 text-white hover:bg-blue-600 shadow-lg shadow-blue-500/30'
                }`}
              >
                {isStopwatchRunning ? '일시정지' : '기록 시작'}
              </button>
              {!isStopwatchRunning && stopwatchTime > 0 && (
                <button
                  onClick={handleStopwatchSave}
                  disabled={isSaving}
                  className="px-4 py-3 rounded-xl font-bold text-white bg-green-600 hover:bg-green-500 shadow-lg shadow-green-500/30 transition-all flex items-center gap-2"
                >
                  {isSaving ? '저장 중...' : '💾 기록 저장'}
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
