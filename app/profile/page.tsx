'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
// import { User } from '@supabase/supabase-js'; // Removed unused
import ProfileHeader from '@/components/profile/ProfileHeader';
import ContributionGraph from '@/components/profile/ContributionGraph';
import StudyReport from '@/components/StudyReport';
import { useStudyStats } from '@/hooks/useStudyStats';
import Navbar from '@/components/Navbar';
import LoginModal from '@/components/LoginModal';
import SettingsModal from '@/components/SettingsModal';
import { useTheme } from '@/components/ThemeProvider';
import { useAuthSession } from '@/hooks/useAuthSession';
import { toast } from 'react-hot-toast';
import { isInAppBrowser, handleInAppBrowser } from '@/lib/userAgent';

export default function ProfilePage() {
  const { session, loading: sessionLoading } = useAuthSession();
  const userId = session?.user?.id ?? null;
  const {
    fetchStats,
    heatmapData,
    totalFocusTime,
    earliestYear,
    loading: statsLoading,
  } = useStudyStats(userId);
  const { theme, isDarkMode, toggleDarkMode } = useTheme();

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);

  const availableYears = useMemo(() => {
    const startYear = earliestYear ?? currentYear;
    const years: number[] = [];
    for (let year = currentYear; year >= startYear; year -= 1) {
      years.push(year);
    }
    return years;
  }, [earliestYear, currentYear]);

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  useEffect(() => {
    if (userId) {
        // Fetch stats to populate heatmap and total time
        fetchStats('year', new Date());
    }
  }, [userId, fetchStats]);

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

  if (sessionLoading) return null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-20 transition-colors duration-300">
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onGoogleLogin={handleGoogleLogin}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        onSave={() => {
          fetchStats('year', new Date(selectedYear, 0, 1));
        }}
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

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8 animate-fade-in mt-16">
        
        {/* Header Section */}
        <section>
          <ProfileHeader user={session?.user || null} totalFocusTime={totalFocusTime} />
        </section>

        {/* 로그인한 사용자에게만 개인 데이터 섹션을 렌더링한다 (로그아웃 후 잔존 데이터 방지) */}
        {session ? (
          <>
            {/* Contribution Graph Section */}
            <section className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-slate-700">
              <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center gap-2">
                <span>공부 기록</span>
                <select
                  aria-label="연도"
                  value={selectedYear}
                  onChange={(event) => setSelectedYear(Number(event.target.value))}
                  className="text-xs font-normal text-gray-400 bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full border border-transparent focus:outline-none focus:ring-2 focus:ring-rose-400/50"
                >
                  {availableYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </h2>
              {statsLoading && heatmapData.length === 0 ? (
                   <div className="h-32 flex items-center justify-center text-gray-400 text-sm">잔디 심는 중...</div>
              ) : (
                   <ContributionGraph data={heatmapData} year={selectedYear} />
              )}
            </section>

            {/* Detailed Report Section */}
            <section>
               <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-4 px-2">상세 리포트</h2>
               <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-gray-100 dark:border-slate-700">
                 <StudyReport key={userId ?? 'guest'} />
               </div>
            </section>
          </>
        ) : (
          <section className="bg-white dark:bg-slate-800 rounded-2xl p-10 text-center shadow-sm border border-gray-100 dark:border-slate-700">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              로그인하고 공부 기록과 상세 리포트를 확인해보세요!
            </p>
            <button
              onClick={() => setIsLoginModalOpen(true)}
              className="px-4 py-2 bg-rose-500 text-white rounded-lg text-sm font-medium hover:bg-rose-600 transition-colors"
            >
              로그인하기
            </button>
          </section>
        )}

      </div>
    </div>
  );
}
