'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import TimerApp from '@/components/TimerApp';
import Login from '@/components/Login';
import HistoryList from '@/components/HistoryList';

export default function Home() {
  const [session, setSession] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-900 text-white">
        <div className="text-xl animate-pulse text-gray-500">로딩 중...</div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-900 text-white p-4 overflow-y-auto">
      <div className="py-10 flex flex-col items-center w-full max-w-md">
        <h1 className="text-5xl font-extrabold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-orange-400">
          Pomofomo
        </h1>
        <p className="text-gray-400 mb-10 text-lg">
          뽀모도로를 안 하면 포모가 온다!
        </p>

        {session ? (
          <div className="w-full flex flex-col items-center animate-fade-in gap-8">
            {/* 1. 사용자 정보 및 로그아웃 */}
            <div className="text-sm text-gray-500 flex gap-2 items-center bg-gray-800 px-4 py-2 rounded-full border border-gray-700">
              <span>
                👋 {session.user.user_metadata.full_name || session.user.email}
                님
              </span>
              <div className="w-px h-3 bg-gray-600"></div>
              <button
                onClick={() => supabase.auth.signOut()}
                className="text-red-400 hover:text-red-300 font-medium text-xs"
              >
                로그아웃
              </button>
            </div>

            {/* 2. 타이머 (하나만!) */}
            <TimerApp />

            {/* 3. 기록 리스트 */}
            <HistoryList />
          </div>
        ) : (
          <Login />
        )}
      </div>
    </main>
  );
}
