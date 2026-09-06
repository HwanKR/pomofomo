'use client';

export type PushSubscriptionSyncStatus =
  | 'cancelled'
  | 'cleanup_failed'
  | 'invalid_vapid_key'
  | 'missing_user'
  | 'missing_vapid_key'
  | 'ownership_failed'
  | 'persist_failed'
  | 'persisted_existing'
  | 'rotated'
  | 'subscribed_new'
  | 'subscribe_failed'
  | 'unsupported'
  | 'unsubscribe_failed';

export type PushSubscriptionSyncResult = {
  error?: unknown;
  status: PushSubscriptionSyncStatus;
};

type PushSubscriptionSyncOptions = {
  getCurrentUserId: () => Promise<string | null>;
  isCurrent?: () => boolean;
  log: (message: string) => void;
  persistSubscription: (subscription: PushSubscription) => Promise<void>;
  registration: ServiceWorkerRegistration;
  removeStoredSubscription: (params: {
    endpoint: string;
    userId: string;
  }) => Promise<void>;
  vapidPublicKey: string;
};

function decodeBase64(base64: string) {
  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(base64);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(base64, 'base64').toString('binary');
  }

  throw new Error('No base64 decoder available');
}

export function decodeVapidPublicKey(
  vapidPublicKey: string
): Uint8Array | null {
  const trimmed = vapidPublicKey.trim();

  if (!trimmed || !/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) {
    return null;
  }

  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4);
  const normalized = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/');

  try {
    const rawData = decodeBase64(normalized);
    const output = new Uint8Array(rawData.length);

    for (let index = 0; index < rawData.length; index += 1) {
      output[index] = rawData.charCodeAt(index);
    }

    // Web Push uses an uncompressed P-256 public key: 0x04 + X + Y.
    if (output.length !== 65 || output[0] !== 0x04) {
      return null;
    }

    return output;
  } catch {
    return null;
  }
}

export function getApplicationServerKeyBytes(
  subscription: Pick<PushSubscription, 'options'> | null | undefined
): Uint8Array | null {
  const source = subscription?.options?.applicationServerKey;

  if (!source || typeof source === 'string') {
    return null;
  }

  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(0));
  }

  if (ArrayBuffer.isView(source as ArrayBufferView<ArrayBufferLike>)) {
    const view = source as ArrayBufferView<ArrayBufferLike>;
    return Uint8Array.from(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    );
  }

  return null;
}

export function keysMatch(
  configuredKey: Uint8Array,
  existingKey: Uint8Array | null
) {
  if (!existingKey || configuredKey.length !== existingKey.length) {
    return false;
  }

  for (let index = 0; index < configuredKey.length; index += 1) {
    if (configuredKey[index] !== existingKey[index]) {
      return false;
    }
  }

  return true;
}

async function persistMatchingSubscription(
  subscription: PushSubscription,
  persistSubscription: (subscription: PushSubscription) => Promise<void>,
  log: (message: string) => void,
  isCurrent: () => boolean
): Promise<PushSubscriptionSyncResult> {
  try {
    await persistSubscription(subscription);
    if (!isCurrent()) return { status: 'cancelled' };
    log('Push subscription persisted');
    return { status: 'persisted_existing' };
  } catch (error) {
    if (!isCurrent()) return { status: 'cancelled' };
    log('Push subscription persistence failed');
    return { error, status: 'persist_failed' };
  }
}

export async function syncPushSubscription({
  getCurrentUserId,
  isCurrent = () => true,
  log,
  persistSubscription,
  registration,
  removeStoredSubscription,
  vapidPublicKey,
}: PushSubscriptionSyncOptions): Promise<PushSubscriptionSyncResult> {
  const configuredKey = decodeVapidPublicKey(vapidPublicKey);

  if (!vapidPublicKey.trim()) {
    log('Missing VAPID public key');
    return { status: 'missing_vapid_key' };
  }

  if (!configuredKey) {
    log('Invalid VAPID public key');
    return { status: 'invalid_vapid_key' };
  }

  const userId = await getCurrentUserId();
  if (!isCurrent()) return { status: 'cancelled' };

  if (!userId) {
    log('No signed-in user for push subscription sync');
    return { status: 'missing_user' };
  }

  const existingSubscription = await registration.pushManager.getSubscription();
  if (!isCurrent()) return { status: 'cancelled' };

  if (existingSubscription) {
    const existingKey = getApplicationServerKeyBytes(existingSubscription);

    if (keysMatch(configuredKey, existingKey)) {
      log('Existing push subscription matches configured VAPID key');
      return persistMatchingSubscription(
        existingSubscription,
        persistSubscription,
        log,
        isCurrent
      );
    }

    log(
      existingKey
        ? 'Existing push subscription uses a different VAPID key'
        : 'Existing push subscription is missing an applicationServerKey'
    );

    try {
      await removeStoredSubscription({
        endpoint: existingSubscription.endpoint,
        userId,
      });
      if (!isCurrent()) return { status: 'cancelled' };
      log('Removed stored push subscription before rotation');
    } catch (error) {
      log('Failed to remove stored push subscription before rotation');
      return { error, status: 'cleanup_failed' };
    }

    try {
      // false means the subscription was already inactive.
      await existingSubscription.unsubscribe();
      if (!isCurrent()) return { status: 'cancelled' };
    } catch (error) {
      log('Push subscription unsubscribe failed');
      return { error, status: 'unsubscribe_failed' };
    }
  } else {
    log('No existing push subscription found');
  }

  let newSubscription: PushSubscription;

  try {
    const applicationServerKeyBytes = new Uint8Array(configuredKey.length);
    applicationServerKeyBytes.set(configuredKey);

    newSubscription = await registration.pushManager.subscribe({
      applicationServerKey: applicationServerKeyBytes.buffer,
      userVisibleOnly: true,
    });
    if (!isCurrent()) return { status: 'cancelled' };
    log('Created browser push subscription');
  } catch (error) {
    log('Push subscription creation failed');
    return { error, status: 'subscribe_failed' };
  }

  try {
    await persistSubscription(newSubscription);
    if (!isCurrent()) return { status: 'cancelled' };
    log('Push subscription persisted');
  } catch (error) {
    if (!isCurrent()) return { status: 'cancelled' };
    log('Push subscription persistence failed');
    return { error, status: 'persist_failed' };
  }

  return {
    status: existingSubscription ? 'rotated' : 'subscribed_new',
  };
}
