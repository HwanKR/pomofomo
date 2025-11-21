'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type StudySession = {
  id: number;
  mode: string;
  duration: number;
  created_at: string;
};

export default function HistoryList() {
  const [history, setHistory] = useState<StudySession[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // 로그인 안 했으면 데이터 요청 자체를 안 함
      if (!user) {
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('study_sessions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);

      if (error) throw error;
      if (data) setHistory(data);
    } catch (error) {
      console.error('데이터 불러오기 실패:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}분 ${s}초`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return `${
      date.getMonth() + 1
    }월 ${date.getDate()}일 ${date.getHours()}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-md">
      <div className="flex justify-between items-center mb-4 px-2">
        <h3 className="text-xl font-bold text-white">📋 최근 학습 기록</h3>
        <button
          onClick={fetchHistory}
          className="text-sm text-gray-400 hover:text-white"
        >
          새로고침
        </button>
      </div>

      <div className="bg-gray-800 rounded-2xl p-4 shadow-xl border border-gray-700">
        {loading ? (
          <div className="text-center text-gray-500 py-4">
            기록을 불러오는 중...
          </div>
        ) : history.length === 0 ? (
          <div className="text-center text-gray-500 py-4">
            아직 기록이 없어요. <br /> 공부를 시작해보세요!
          </div>
        ) : (
          <ul className="space-y-3">
            {history.map((item) => (
              <li
                key={item.id}
                className="flex justify-between items-center p-3 bg-gray-700/50 rounded-xl hover:bg-gray-700 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-2xl">
                    {item.mode === 'pomo' ? '🍅' : '⏱️'}
                  </span>
                  <div>
                    <div className="font-bold text-gray-200">
                      {item.mode === 'pomo' ? '뽀모도로' : '스톱워치'}
                    </div>
                    <div className="text-xs text-gray-400">
                      {formatDate(item.created_at)}
                    </div>
                  </div>
                </div>
                <div className="font-mono text-lg font-bold text-white">
                  {formatDuration(item.duration)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
