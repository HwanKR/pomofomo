import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { cleanupUserFeedbackStorage } from '@/lib/server/feedbackStorageCleanup';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const base64UrlToUtf8 = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '='
  );
  return Buffer.from(padded, 'base64').toString('utf-8');
};

const getProjectRefFromUrl = (url: string) => {
  try {
    const host = new URL(url).host;
    return host.split('.')[0] || null;
  } catch {
    return null;
  }
};

const getProjectRefFromServiceKey = (token: string) => {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlToUtf8(parts[1]));
    return typeof payload?.ref === 'string' ? payload.ref : null;
  } catch {
    return null;
  }
};

const getServiceRoleKeyKind = (token: string) => {
  if (token.startsWith('sb_secret_')) return 'opaque_secret';
  if (token.split('.').length === 3) return 'legacy_jwt';
  return 'unknown';
};

const validateServiceRoleKeyProjectRef = ({
  serviceRoleKey,
  urlProjectRef,
  expectedProjectRef,
}: {
  serviceRoleKey: string;
  urlProjectRef: string;
  expectedProjectRef?: string;
}) => {
  const keyKind = getServiceRoleKeyKind(serviceRoleKey);

  if (keyKind === 'opaque_secret') {
    return {
      keyKind,
      keyProjectRef: null,
      ok: expectedProjectRef === urlProjectRef,
    };
  }

  if (keyKind === 'legacy_jwt') {
    const keyProjectRef = getProjectRefFromServiceKey(serviceRoleKey);
    return {
      keyKind,
      keyProjectRef,
      ok: keyProjectRef === urlProjectRef,
    };
  }

  return {
    keyKind,
    keyProjectRef: null,
    ok: false,
  };
};

const getAccessToken = (request: NextRequest) => {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
};

export async function POST(request: NextRequest) {
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'Server not configured' },
      { status: 500 }
    );
  }

  const urlProjectRef = getProjectRefFromUrl(supabaseUrl);
  const expectedProjectRef = process.env.SUPABASE_PROJECT_REF;
  const serviceRoleKeyValidation = urlProjectRef
    ? validateServiceRoleKeyProjectRef({
        serviceRoleKey,
        urlProjectRef,
        expectedProjectRef,
      })
    : { keyKind: 'unknown', keyProjectRef: null, ok: false };
  if (!urlProjectRef || !serviceRoleKeyValidation.ok) {
    console.error('Supabase project ref mismatch', {
      urlProjectRef,
      keyProjectRef: serviceRoleKeyValidation.keyProjectRef,
      keyKind: serviceRoleKeyValidation.keyKind,
      expectedProjectRef:
        serviceRoleKeyValidation.keyKind === 'opaque_secret'
          ? expectedProjectRef ?? null
          : undefined,
    });
    return NextResponse.json(
      { error: 'Supabase config mismatch' },
      { status: 500 }
    );
  }

  if (expectedProjectRef && expectedProjectRef !== urlProjectRef) {
    console.error('Supabase project ref does not match expected', {
      urlProjectRef,
      expectedProjectRef,
    });
    return NextResponse.json(
      { error: 'Supabase project ref mismatch' },
      { status: 500 }
    );
  }

  const allowedProjectRefs = process.env.SUPABASE_ALLOWED_PROJECT_REFS;
  if (allowedProjectRefs) {
    const allowed = allowedProjectRefs
      .split(',')
      .map((ref) => ref.trim())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(urlProjectRef)) {
      console.error('Supabase project ref not allowed', {
        urlProjectRef,
        allowed,
      });
      return NextResponse.json(
        { error: 'Supabase project ref not allowed' },
        { status: 500 }
      );
    }
  }

  const accessToken = getAccessToken(request);
  if (!accessToken) {
    return NextResponse.json({ error: 'Missing auth token' }, { status: 401 });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: { user }, error: userError } =
    await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !user) {
    return NextResponse.json({ error: 'Invalid auth token' }, { status: 401 });
  }

  const { data: groupCleanup, error: groupCleanupError } = await supabaseAdmin
    .rpc('cleanup_account_groups', { p_user_id: user.id });

  if (groupCleanupError || !groupCleanup ||
      !['ready', 'leader'].includes(groupCleanup.status)) {
    console.error('Failed to clean up account groups:', groupCleanupError);
    return NextResponse.json(
      { error: 'Failed to clean up groups' },
      { status: 500 }
    );
  }

  if (groupCleanup.status === 'leader') {
    return NextResponse.json(
      {
        error: 'leader',
        message: 'Group leaders must transfer ownership before deleting the account.',
        groups: groupCleanup.groups,
      },
      { status: 409 }
    );
  }

  const storageCleanup = await cleanupUserFeedbackStorage({
    storage: supabaseAdmin.storage,
    userId: user.id,
  });

  if (!storageCleanup.ok) {
    console.error('Feedback storage cleanup failed', {
      retryable: storageCleanup.retryable,
      status: storageCleanup.status,
    });
    return NextResponse.json(
      {
        error: 'Feedback storage cleanup failed',
        retryable: storageCleanup.retryable,
        storageCleanup,
      },
      { status: 500 }
    );
  }

  try {
    const deleteByUserId = async (table: string, column = 'user_id') => {
      const { error } = await supabaseAdmin
        .from(table)
        .delete()
        .eq(column, user.id);
      if (error) throw error;
    };

    await deleteByUserId('feedback_likes');
    await deleteByUserId('feedback_images');
    await deleteByUserId('feedback_replies');
    await deleteByUserId('feedbacks');

    await deleteByUserId('friendships');
    await deleteByUserId('friendships', 'friend_id');
    await deleteByUserId('friend_requests', 'sender_id');
    await deleteByUserId('friend_requests', 'receiver_id');

    await deleteByUserId('group_members');
    await deleteByUserId('study_sessions');

    await deleteByUserId('tasks');
    await deleteByUserId('pinned_tasks');
    await deleteByUserId('weekly_plans');
    await deleteByUserId('monthly_plans');

    await deleteByUserId('user_settings');
    await deleteByUserId('timer_states');
    await deleteByUserId('push_subscriptions');

    // profiles.id references auth.users(id) ON DELETE CASCADE. Keep the profile
    // until Auth commits deletion so a transient Auth failure remains retryable.
    const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (authDeleteError) throw authDeleteError;
  } catch (error) {
    console.error('Account delete failed:', error);
    return NextResponse.json(
      { error: 'Account delete failed' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
