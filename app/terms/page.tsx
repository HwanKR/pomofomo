'use client';

import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import Navbar from '@/components/Navbar';
import { useTheme } from '@/components/ThemeProvider';
import { supabase } from '@/lib/supabase';

export default function TermsPage() {
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

      <main className="mx-auto max-w-4xl px-4 py-12 md:py-20">
        <div className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900 md:p-12">
          <h1 className="mb-8 text-3xl font-bold text-gray-900 dark:text-white">
            이용약관
          </h1>

          <div className="space-y-8 leading-relaxed text-gray-600 dark:text-gray-300">
            <section>
              <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                제1조 (목적)
              </h2>
              <p>
                본 약관은 Fomopomo(이하 &quot;서비스&quot;)가 제공하는 모든
                서비스의 이용 조건 및 절차, 이용자와 서비스의 권리, 의무 및
                책임사항을 규정함을 목적으로 합니다.
              </p>
            </section>

            <section>
              <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                제2조 (서비스의 제공)
              </h2>
              <p>
                Fomopomo는 뽀모도로 타이머, 공부 시간 측정, 그룹 스터디 등의
                기능을 제공합니다. 서비스는 운영상의 필요에 따라 사전 고지 없이
                변경되거나 중단될 수 있습니다.
              </p>
            </section>

            <section>
              <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                제3조 (책임의 한계)
              </h2>
              <p>
                본 서비스는 &quot;있는 그대로(As-Is)&quot; 제공됩니다. 서비스 이용
                중 발생한 데이터 손실, 접속 오류, 기타 손해에 대해 운영자는 법적
                책임을 지지 않습니다. 중요한 데이터는 이용자가 별도로
                백업해야 합니다.
              </p>
            </section>

            <section>
              <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                제4조 (이용자의 의무)
              </h2>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  이용자는 타인의 명예를 훼손하거나 불법적인 목적으로 서비스를
                  이용할 수 없습니다.
                </li>
                <li>
                  비정상적인 방법(매크로, 자동화 도구 등)으로 서비스에 과도한
                  요청을 보내는 행위를 금지합니다.
                </li>
                <li>
                  이용 약관을 위반하는 경우, 사전 통보 없이 계정 이용이 제한될
                  수 있습니다.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                제5조 (준거법)
              </h2>
              <p>본 약관은 대한민국 법령에 따라 해석되고 적용됩니다.</p>
            </section>

            <div className="border-t border-gray-100 pt-8 text-sm text-gray-500 dark:border-slate-800">
              <p>공고일자: 2026년 1월 28일</p>
              <p>시행일자: 2026년 1월 28일</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
