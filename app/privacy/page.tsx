'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import Navbar from '@/components/Navbar';
import { useTheme } from '@/components/ThemeProvider';
import { supabase } from '@/lib/supabase';
import { useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';

export default function PrivacyPage() {
  const { theme, isDarkMode, toggleDarkMode } = useTheme();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <Navbar
        session={session}
        theme={theme}
        isDarkMode={isDarkMode}
        toggleDarkMode={toggleDarkMode}
        onLogout={() => signOutWithPushCleanup()}
        onOpenLogin={() => supabase.auth.signInWithOAuth({ provider: 'google' })}
      />
      
      <main className="max-w-4xl mx-auto px-4 py-12 md:py-20">
        <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 md:p-12 shadow-sm border border-gray-200 dark:border-slate-800">
          <h1 className="text-3xl font-bold mb-8 text-gray-900 dark:text-white">개인정보처리방침</h1>
          
          <div className="space-y-8 text-gray-600 dark:text-gray-300 leading-relaxed">
            <section>
              <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">1. 수집하는 개인정보 항목</h2>
              <p className="mb-2">Fomopomo는 원활한 서비스 제공을 위해 최소한의 정보를 수집합니다.</p>
              <ul className="list-disc pl-5 space-y-2">
                <li>필수항목: 이메일, 닉네임, 프로필 이미지 (Google 계정 정보 연동)</li>
                <li>생성정보: 서비스 이용 기록, 접속 로그, 쿠키, 공부 시간 기록</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">2. 개인정보의 처리 목적</h2>
              <p>수집한 개인정보는 다음의 목적을 위해서만 활용합니다.</p>
              <ul className="list-disc pl-5 space-y-2 mt-2">
                <li>회원 가입 및 관리, 사용자 식별</li>
                <li>공부 시간 측정, 통계 제공, 그룹 및 랭킹 서비스 운영</li>
                <li>서비스 관련 공지사항 전달 및 문의 응대</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">3. 개인정보의 보유 및 이용 기간</h2>
              <p>
                이용자의 개인정보는 원칙적으로 회원 탈퇴 시 지체 없이 파기합니다. 단, 관계법령의 규정에 의하여 보존할 필요가 있는 경우 관련 법령에서 정한 기간 동안 보관합니다.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">4. 개인정보의 제3자 제공</h2>
              <p>
                Fomopomo는 이용자의 개인정보를 외부 업체에 위탁하지 않으나, 서비스 운영을 위해 다음의 인프라 서비스를 이용합니다.
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-2">
                <li>데이터베이스 호스팅: Supabase (AWS)</li>
                <li>인증 처리: Google Cloud Platform (OAuth)</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">5. 문의처</h2>
              <p>
                개인정보 관련 문의는 아래 이메일로 연락 주시기 바랍니다.<br />
                이메일: <a href="mailto:fabronjeon@naver.com" className="text-rose-500 hover:underline">fabronjeon@naver.com</a>
              </p>
            </section>

            <div className="pt-8 border-t border-gray-100 dark:border-slate-800 text-sm text-gray-500">
              <p>공고일자: 2026년 1월 28일</p>
              <p>시행일자: 2026년 1월 28일</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
