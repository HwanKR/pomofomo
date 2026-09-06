'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import Link from 'next/link';
import { ArrowLeft, Mail, Copy } from 'lucide-react';
import Navbar from '@/components/Navbar';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useTheme } from '@/components/ThemeProvider';
import { supabase } from '@/lib/supabase';
import { useState } from 'react';
import LoginModal from '@/components/LoginModal';
import SettingsModal from '@/components/SettingsModal';
import { toast } from 'react-hot-toast';
import { isInAppBrowser, handleInAppBrowser } from '@/lib/userAgent';

export default function ContactPage() {
  const { session, loading: isAuthLoading } = useAuthSession();
  const { theme, isDarkMode, toggleDarkMode } = useTheme();
  
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  
  const handleGoogleLogin = async () => {
    if (isInAppBrowser()) {
      const handled = handleInAppBrowser();
      if (handled) {
        toast.error(
          '구글 로그인은 보안 정책상\n외부 브라우저(크롬, 사파리 등)에서\n진행해야 합니다.',
          { duration: 5000 }
        );
        return;
      }
    }

    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  };
  
  if (isAuthLoading) return null;

  return (
    <main className="flex min-h-screen flex-col items-center bg-[#f8f9fa] dark:bg-[#0f172a] transition-colors duration-300 font-sans text-gray-900 dark:text-gray-100">
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onGoogleLogin={handleGoogleLogin}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={() => {}} 
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
      
      <div className="container max-w-lg mx-auto py-6 px-4 pb-24 mt-4 animate-fade-in">
        {/* 뒤로가기 */}
        <Link 
          href="/"
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          홈으로
        </Link>
        
        {/* 헤더 */}
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white mb-3">
            Contact
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
            궁금한 점이나 문의사항이 있으시면 아래 방법으로 연락해주세요.
          </p>
        </div>
        
        {/* 연락처 카드 */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 shadow-sm overflow-hidden">
          {/* 이메일 */}
          <button 
            onClick={() => {
              navigator.clipboard.writeText('fabronjeon@naver.com');
              toast.success('이메일이 복사되었습니다');
            }}
            className="group w-full flex items-center gap-4 p-5 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center justify-center w-12 h-12 bg-rose-100 dark:bg-rose-900/30 rounded-full">
              <Mail className="w-5 h-5 text-rose-500" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">이메일</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">fabronjeon@naver.com</p>
            </div>
            <Copy className="w-4 h-4 text-gray-400 dark:text-gray-500 group-hover:text-rose-500 dark:group-hover:text-rose-400 transition-colors" />
          </button>
        </div>
        
        {/* 부가 안내 */}
        <p className="text-center text-xs text-gray-500 dark:text-gray-500 mt-8">
          가능한 빠르게 답변 드리겠습니다
        </p>
      </div>
    </main>
  );
}
