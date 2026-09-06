import { signOutWithPushCleanup } from '@/lib/pushSubscriptionLifecycle';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Session } from '@supabase/supabase-js';

export function useAuthSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial session check
    const checkSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();

        if (error) {
          // Only log error if it's NOT a refresh token issue
          const isRefreshTokenError = error.message && (
            error.message.includes('Refresh Token Not Found') ||
            error.message.includes('Invalid Refresh Token')
          );

          if (!isRefreshTokenError) {
            console.error('Error getting session:', error);
          }

          // If refresh token is invalid, sign out to clear storage
          if (isRefreshTokenError) {
            await signOutWithPushCleanup();
            setSession(null);
          }
        } else {
          setSession(session);
        }
      } catch (err) {
        console.error('Unexpected error checking session:', err);
      } finally {
        setLoading(false);
      }
    };

    checkSession();

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        setSession(null);
      } else if (session) {
        setSession(session);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return { session, loading };
}
