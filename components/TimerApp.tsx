'use client';

import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabase'; // @ 별명으로 수정됨

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

  // --- 💾 DB 저장 함수 (업데이트: 사용자 ID 추가!) ---
  const saveRecord = async (recordMode: string, duration: number) => {
    if (duration < 10) {
      alert('10초 미만은 기록되지 않아요!');
      return;
    }

    setIsSaving(true);
    try {
      // 1. 현재 로그인한 사용자 정보 가져오기
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        alert('로그인이 필요합니다!');
        return;
      }

      // 2. 데이터 저장 (user_id 포함)
      const { error } = await supabase.from('study_sessions').insert({
        mode: recordMode,
        duration: duration,
        user_id: user.id, // 👈 여기가 핵심! 내 아이디를 같이 저장함
      });

      if (error) throw error;

      // 저장 성공하면 화면 새로고침 없이 리스트를 업데이트하고 싶지만,
      // 일단은 알림만 띄웁니다. (나중에 자동 갱신 기능 추가 가능)
      alert('🔥 공부 기록이 저장되었습니다!');
    } catch (e) {
      console.error(e);
      alert('저장에 실패했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  // --- 🍅 뽀모도로 로직 ---
  const [pomoTime, setPomoTime] = useState(25 * 60);
  const [initialPomoTime, setInitialPomoTime] = useState(25 * 60);
  const [isPomoRunning, setIsPomoRunning] = useState(false);
  const pomoRef = useRef<NodeJS.Timeout | null>(null);

  const togglePomo = () => {
    if (isPomoRunning) {
      if (pomoRef.current) clearInterval(pomoRef.current);
      setIsPomoRunning(false);
    } else {
      setIsPomoRunning(true);
      pomoRef.current = setInterval(() => {
        setPomoTime((prev) => {
          if (prev <= 1) {
            if (pomoRef.current) clearInterval(pomoRef.current);
            setIsPomoRunning(false);
            alert('집중 끝! 휴식하세요.');
            saveRecord('pomo', initialPomoTime);
            return 0;
          }
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
    } else {
      setIsStopwatchRunning(true);
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
  };

  useEffect(() => {
    return () => {
      if (pomoRef.current) clearInterval(pomoRef.current);
      if (stopwatchRef.current) clearInterval(stopwatchRef.current);
    };
  }, []);

  return (
    <div className="w-full max-w-md bg-gray-800 rounded-3xl shadow-2xl border border-gray-700 overflow-hidden mb-8">
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
            <div className="text-7xl font-bold text-red-400 mb-8 font-mono tabular-nums tracking-tighter">
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
            <div className="text-7xl font-bold text-blue-400 mb-8 font-mono tabular-nums tracking-tighter">
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
