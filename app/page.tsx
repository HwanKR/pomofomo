'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuthSession } from '@/hooks/useAuthSession';

import TimerApp from '@/components/TimerApp';
import HistoryList from '@/components/HistoryList';
import LoginModal from '@/components/LoginModal';

import SettingsModal from '@/components/SettingsModal';
import { toast } from 'react-hot-toast';

import { isInAppBrowser, handleInAppBrowser } from '@/lib/userAgent';
import Navbar from '@/components/Navbar';
import { useTheme } from '@/components/ThemeProvider';

export default function Home() {
  const { session, loading: isLoading } = useAuthSession();

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);


  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  const { theme, isDarkMode, toggleDarkMode } = useTheme();
  const [settingsUpdateTrigger, setSettingsUpdateTrigger] = useState(0);

  // ✨ [추가] 기록 목록 새로고침을 위한 트리거 상태
  const [historyUpdateTrigger, setHistoryUpdateTrigger] = useState(0);

  const handleGoogleLogin = async () => {
    if (isInAppBrowser()) {
      const handled = handleInAppBrowser();
      if (handled) {
        toast.error(
          '구글 로그인은 보안 정책상\n외부 브라우저(크롬, 사파리 등)에서\n진행해야 합니다.',
          {
            duration: 5000,
          }
        );
        return;
      }
    }

    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  };

  if (isLoading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[#f8f9fa] dark:bg-[#0f172a]"
        suppressHydrationWarning
      >
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-gray-900 dark:border-white" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-[#f8f9fa] dark:bg-[#0f172a] transition-colors duration-300 font-sans text-gray-900 dark:text-gray-100">
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onGoogleLogin={handleGoogleLogin}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={() => setSettingsUpdateTrigger((prev) => prev + 1)}
      />

      <Navbar
        session={session}
        theme={theme}
        isDarkMode={isDarkMode}
        toggleDarkMode={toggleDarkMode}
        onOpenSettings={() => setIsSettingsModalOpen(true)}

        onOpenLogin={() => setIsLoginModalOpen(true)}
        onLogout={() => signOutWithPushCleanup()}
      />

      {/* Content Container - Narrow for Focus */}
      <div className="w-full max-w-lg flex flex-col items-center gap-8 animate-fade-in p-3 sm:p-4 mt-4">
        {/* ✨ TimerApp에 콜백 전달: 저장 완료 시 트리거 숫자를 증가시킴 */}
        <TimerApp
          settingsUpdated={settingsUpdateTrigger}
          onRecordSaved={() => setHistoryUpdateTrigger((prev) => prev + 1)}
          isLoggedIn={!!session}
        />

        {/* ✨ HistoryList에 트리거 전달: 숫자가 바뀌면 새로고침 됨 */}
        <HistoryList 
          updateTrigger={historyUpdateTrigger} 
          session={session}
          onOpenLogin={() => setIsLoginModalOpen(true)}
        />
      </div>
    </div>
  );
}
