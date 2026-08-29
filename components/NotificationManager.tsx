'use client';

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import toast from 'react-hot-toast';
import { syncPushSubscription } from '@/lib/pushSubscriptionSync';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

const subscribeToHydration = () => () => {};

function useHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
}

export default function NotificationManager({
  mode = 'floating',
}: {
  mode?: 'floating' | 'inline';
}) {
  const isHydrated = useHydrated();
  const [permission, setPermission] =
    useState<NotificationPermission>('default');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }

    return localStorage.getItem('fomopomo_notification_dismissed') !== 'true';
  });
  const [isAdmin, setIsAdmin] = useState(false);

  const addLog = useCallback((message: string) => {
    setDebugLog((previous) => [message, ...previous].slice(0, 10));
    console.log(message);
  }, []);

  const getCurrentUserId = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return user?.id ?? null;
  }, []);

  const persistSubscription = useCallback(
    async (subscription: PushSubscription) => {
      const userId = await getCurrentUserId();

      if (!userId) {
        addLog('No user found');
        throw new Error('A signed-in user is required to save notifications.');
      }

      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          user_id: userId,
          endpoint: subscription.endpoint,
          keys: subscription.toJSON().keys,
        },
        { onConflict: 'endpoint' }
      );

      if (error) {
        addLog('Push subscription persistence failed');
        throw error;
      }
    },
    [addLog, getCurrentUserId]
  );

  const removeStoredSubscription = useCallback(
    async ({ endpoint, userId }: { endpoint: string; userId: string }) => {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId)
        .eq('endpoint', endpoint);

      if (error) {
        addLog('Push subscription cleanup failed');
        throw error;
      }
    },
    [addLog]
  );

  const subscribeUser = useCallback(
    async (showToast = true) => {
      if (!('serviceWorker' in navigator)) return;

      try {
        const registration = await navigator.serviceWorker.ready;
        const result = await syncPushSubscription({
          getCurrentUserId,
          log: addLog,
          persistSubscription,
          registration,
          removeStoredSubscription,
          vapidPublicKey: VAPID_PUBLIC_KEY,
        });

        if (
          result.status === 'persisted_existing' ||
          result.status === 'rotated' ||
          result.status === 'subscribed_new'
        ) {
          setPermission('granted');

          if (showToast && result.status !== 'persisted_existing') {
            toast.success('알림이 설정되었습니다.');
          }

          return;
        }

        if (result.status === 'persist_failed') {
          if (showToast) {
            toast.error(
              'Notification permission is enabled, but saving the subscription failed. It will retry automatically.'
            );
          }
          return;
        }

        if (!showToast) {
          return;
        }

        if (result.status === 'cleanup_failed') {
          toast.error(
            'Could not rotate notifications because the old subscription could not be cleaned up.'
          );
          return;
        }

        if (result.status === 'missing_vapid_key') {
          toast.error('VAPID public key is not configured.');
          return;
        }

        if (result.status === 'invalid_vapid_key') {
          toast.error('VAPID public key is invalid.');
          return;
        }

        if (result.status === 'missing_user') {
          toast.error('You need to sign in before enabling notifications.');
          return;
        }

        if (result.status === 'unsubscribe_failed') {
          toast.error('Could not replace the existing notification subscription.');
          return;
        }

        toast.error('알림 설정에 실패했습니다.');
      } catch {
        addLog('Push subscription sync failed');
        if (showToast) {
          toast.error('알림 설정에 실패했습니다.');
        }
      }
    },
    [
      addLog,
      getCurrentUserId,
      persistSubscription,
      removeStoredSubscription,
    ]
  );

  useEffect(() => {
    const syncAdminRole = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) return;

        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        setIsAdmin(profile?.role === 'admin');
      } catch (error) {
        console.error('Error checking admin role:', error);
      }
    };

    void syncAdminRole();

    const registerServiceWorker = async () => {
      if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('/sw.js');
          addLog('Service Worker registered');
        } catch {
          addLog('Service Worker registration failed');
        }
      }

      if (typeof window !== 'undefined' && 'Notification' in window) {
        const currentPermission = Notification.permission;
        setPermission(currentPermission);
        addLog(`Current permission: ${currentPermission}`);

        if (currentPermission === 'granted') {
          await subscribeUser(false);
        }
      }
    };

    void registerServiceWorker();
  }, [addLog, subscribeUser]);

  const requestPermission = async () => {
    if (!('Notification' in window)) {
      toast.error('이 브라우저는 알림을 지원하지 않습니다.');
      return;
    }

    if (permission === 'denied') {
      toast.error(
        '알림이 차단되어 있습니다.\n브라우저 주소창 옆 설정에서 알림 권한을 허용해주세요.',
        { duration: 5000 }
      );
      return;
    }

    const result = await Notification.requestPermission();
    setPermission(result);
    addLog(`Permission result: ${result}`);

    if (result === 'granted') {
      await subscribeUser();
    } else if (result === 'denied') {
      toast.error('알림 권한이 거부되었습니다.\n설정에서 직접 허용해야 합니다.');
    }
  };

  const sendTestNotification = async () => {
    if (!('serviceWorker' in navigator)) return;

    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification('테스트 알림', {
        body: '알림이 정상적으로 동작합니다.',
        icon: '/icon-192x192.png',
      });
      addLog('Test notification sent');
    } catch {
      addLog('Test notification failed');
    }
  };

  const handleDismiss = () => {
    setIsVisible(false);
    localStorage.setItem('fomopomo_notification_dismissed', 'true');
  };

  if (mode === 'floating') {
    if (!isHydrated || permission === 'granted' || !isVisible) return null;

    return (
      <aside
        className="mx-auto my-6 w-[calc(100%_-_1.5rem)] max-w-2xl rounded-xl border border-gray-200 bg-white px-4 py-4 text-gray-900 dark:border-slate-700 dark:bg-slate-800 dark:text-gray-100"
        aria-label="타이머 종료 알림 안내"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">타이머 종료 알림</h2>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              화면을 보고 있지 않아도 종료 시간을 알려드려요.
            </p>
          </div>
          <button
            onClick={handleDismiss}
            className="shrink-0 text-sm font-medium text-gray-500 underline-offset-2 transition-colors hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-white"
            aria-label="타이머 종료 알림 안내 닫기"
          >
            닫기
          </button>
        </div>
        <button
          onClick={requestPermission}
          className="mt-3 inline-flex rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-600"
        >
          알림 켜기
        </button>
      </aside>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-600">알림 권한 상태</span>
        <span
          className={`rounded px-2 py-1 text-xs font-bold ${
            permission === 'granted'
              ? 'bg-green-100 text-green-600'
              : permission === 'denied'
                ? 'bg-red-100 text-red-600'
                : 'bg-gray-100 text-gray-600'
          }`}
        >
          {permission === 'granted'
            ? '허용됨'
            : permission === 'denied'
              ? '거부됨'
              : '미설정'}
        </span>
      </div>

      {permission !== 'granted' && (
        <button
          onClick={requestPermission}
          className="w-full rounded-lg bg-rose-500 py-2 text-sm font-bold text-white transition-colors hover:bg-rose-600"
        >
          알림 권한 요청하기
        </button>
      )}

      {permission === 'granted' && (
        <button
          onClick={sendTestNotification}
          className="w-full rounded-lg bg-blue-50 py-2 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-100"
        >
          테스트 알림 보내기
        </button>
      )}

      {isAdmin && (
        <div className="pt-2">
          <button
            onClick={() => setIsOpen((current) => !current)}
            className="text-[10px] text-gray-400 underline hover:text-gray-600"
          >
            {isOpen ? '디버그 로그 숨기기' : '디버그 로그 보기'}
          </button>

          {isOpen && (
            <div className="mt-2 h-32 overflow-y-auto rounded bg-gray-900 p-2 font-mono text-[10px] text-green-400">
              {debugLog.map((log, index) => (
                <div
                  key={index}
                  className="border-b border-gray-800 py-0.5 last:border-0"
                >
                  &gt; {log}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
