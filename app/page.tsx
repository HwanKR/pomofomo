'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import TimerApp from '@/components/TimerApp';
import HistoryList from '@/components/HistoryList';
import LoginModal from '@/components/LoginModal'; // 👈 모달 불러오기
import { Toaster } from 'react-hot-toast';

export default function Home() {
  const [session, setSession] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false); // 모달 열림/닫힘 상태

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

  const handleGoogleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
      },
    });
  };

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gray-900 text-white">
        <div className="text-xl animate-pulse text-gray-500">로딩 중...</div>
      </main>
    );
  }

  // ✨ 버튼 스타일 변경 (붉은색 -> 투명한 흰색)
  // bg-white/10: 흰색인데 투명도 10%
  const headerBtnStyle =
    'flex items-center gap-2 px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-white/90 text-sm font-medium transition-colors';

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-900 text-white p-4 overflow-y-auto">
      <Toaster position="top-center" reverseOrder={false} />

      {/* ✨ 로그인 모달창 (상태에 따라 보여줌) */}
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onGoogleLogin={handleGoogleLogin}
      />

      <div className="py-10 flex flex-col items-center w-full max-w-md relative">
        {/* --- 상단 헤더 --- */}
        <div className="w-full flex justify-end items-center gap-2 mb-8">
          <button className={headerBtnStyle}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-4 h-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
            Report
          </button>

          <button className={headerBtnStyle}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-4 h-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.253-.962.584-1.892.985-2.783.247-.55.06-1.21-.463-1.511l-.657-.38c-.551-.318-1.26-.117-1.527.461a20.845 20.845 0 01-1.44 4.282m3.102-.069a18.03 18.03 0 01.59 4.59c0 1.586-.205 3.124-.59 4.59m0-9.18a23.848 23.848 0 01-8.835-2.535"
              />
            </svg>
            Setting
          </button>

          {session ? (
            <button
              onClick={() => supabase.auth.signOut()}
              className={headerBtnStyle}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
                />
              </svg>
              Sign Out
            </button>
          ) : (
            // 비로그인 상태: 클릭하면 모달창 오픈
            <button
              onClick={() => setIsLoginModalOpen(true)}
              className={headerBtnStyle}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-4 h-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"
                />
              </svg>
              Sign In
            </button>
          )}

          <button className={`${headerBtnStyle} px-2`}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
              />
            </svg>
          </button>
        </div>

        <h1 className="text-5xl font-extrabold mb-2 text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-orange-400">
          Pomofomo
        </h1>
        <p className="text-gray-400 mb-8 text-lg">
          뽀모도로를 안 하면 포모가 온다!
        </p>

        <div className="w-full flex flex-col items-center animate-fade-in gap-8">
          <TimerApp />

          {session ? (
            <HistoryList />
          ) : (
            <div className="text-center text-gray-600 text-xs mt-4">
              로그인하면 공부 기록이 자동 저장됩니다
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
