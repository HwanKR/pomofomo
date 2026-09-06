'use client';

import { supabase } from '@/lib/supabase';
import { syncPushSubscription, type PushSubscriptionSyncResult } from './pushSubscriptionSync';

type Log = (message: string) => void;
type SignOutResult = Awaited<ReturnType<typeof supabase.auth.signOut>>;
const LOCK_NAME = 'fomopomo-push-subscription';
const CANCELLED = Symbol('cancelled');

let desiredUserId: string | null | undefined;
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();
let observer: { unsubscribe: () => void } | null = null;
let observerGeneration = 0;
let initialization: Promise<void> | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
let cachedRegistration: ServiceWorkerRegistration | null = null;
let scheduled: ReturnType<typeof setTimeout> | null = null;
let users = 0;
let logout: Promise<SignOutResult> | null = null;
const logs = new Set<Log>();
const cancelledWaits = new Set<() => void>();
// A just-created endpoint is known to belong to this operation even if its
// first database write failed. Reloaded/legacy endpoints need RLS evidence.
const createdOwners = new Map<string, string>();

const log = (message: string) => { for (const listener of logs) listener(message); };
const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
const permitted = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';

function invalidate() {
  revision += 1;
  for (const cancel of [...cancelledWaits]) cancel();
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = async () => {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(LOCK_NAME, work);
    }
    return work();
  };
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

// Waiting for an activating worker must not prevent logout forever. Unlike
// subscribe()/upsert(), abandoning this wait cannot create a push endpoint.
async function waitForRegistration(expectedRevision: number) {
  if (expectedRevision !== revision) return CANCELLED;
  let cancel!: () => void;
  const cancelled = new Promise<typeof CANCELLED>(resolve => { cancel = () => resolve(CANCELLED); });
  cancelledWaits.add(cancel);
  try {
    return await Promise.race([registerWorker(), cancelled]);
  } finally {
    cancelledWaits.delete(cancel);
  }
}

function registerWorker(): Promise<ServiceWorkerRegistration> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      cachedRegistration = registration;
      const active = registration.active ? registration : await navigator.serviceWorker.ready;
      cachedRegistration = active;
      return active;
    })().catch(error => {
      registrationPromise = null;
      throw error;
    });
  }
  return registrationPromise;
}

async function existingRegistration() {
  if (!supported()) return null;
  return await navigator.serviceWorker.getRegistration() ?? cachedRegistration;
}

async function sessionUserId() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session?.user.id ?? null;
}

async function verifiedUserId() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user?.id ?? null;
}

async function removeRow(endpoint: string, userId: string) {
  const { error } = await supabase.from('push_subscriptions')
    .delete().eq('user_id', userId).eq('endpoint', endpoint);
  if (error) throw error;
}

async function revokeBrowser(registration: ServiceWorkerRegistration, subscription: PushSubscription | null) {
  try {
    if (subscription) {
      const removed = await subscription.unsubscribe();
      createdOwners.delete(subscription.endpoint);
      if (!removed) {
        const remaining = await registration.pushManager.getSubscription();
        if (remaining?.endpoint === subscription.endpoint) throw new Error('Push subscription remains active');
      }
    }
  } finally {
    try {
      const notifications = await registration.getNotifications?.();
      notifications?.forEach(notification => notification.close());
    } catch { log('Could not close previously displayed notifications'); }
  }
}

// Row deletion and browser revocation are independent: a database failure
// must never leave this browser subscribed on an authentication boundary.
async function cleanup(
  registration: ServiceWorkerRegistration | null,
  ownerId: string | null,
  isCurrent: () => boolean = () => true
) {
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!isCurrent()) return;
  try { await revokeBrowser(registration, subscription); }
  catch { log('Browser push subscription cleanup failed'); }
  if (subscription && ownerId) {
    try { await removeRow(subscription.endpoint, ownerId); }
    catch { log('Stored push subscription cleanup failed'); }
  }
}

function schedule() {
  if (scheduled !== null) clearTimeout(scheduled);
  // Supabase auth callbacks must return before any further auth/DB calls.
  scheduled = setTimeout(() => {
    scheduled = null;
    void syncCurrentPushSubscription().catch(() => log('Push subscription synchronization failed'));
  }, 0);
}

function observeUser(userId: string | null) {
  if (logout || desiredUserId === userId) return;
  desiredUserId = userId;
  invalidate();
  schedule();
}

function ensureObserver() {
  if (observer) return;
  const generation = ++observerGeneration;
  observer = supabase.auth.onAuthStateChange((_event, session) => {
    observeUser(session?.user.id ?? null);
  }).data.subscription;
  const initialRevision = revision;
  initialization = sessionUserId().then(userId => {
    if (generation === observerGeneration && initialRevision === revision) observeUser(userId);
  }).catch(() => {
    if (generation === observerGeneration && initialRevision === revision) observeUser(null);
  });
}

export function startPushSubscriptionLifecycle(listener?: Log): () => void {
  users += 1;
  if (listener) logs.add(listener);
  ensureObserver();
  // Keep the app's offline/local-notification worker available even before
  // permission is granted. Auth reconciliation owns all push mutations.
  if (supported()) void registerWorker().catch(() => log('Service Worker registration failed'));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (listener) logs.delete(listener);
    if (users === 0) {
      observer?.unsubscribe();
      observer = null;
      observerGeneration += 1;
      initialization = null;
      if (scheduled !== null) clearTimeout(scheduled);
      scheduled = null;
    }
  };
}

export async function syncCurrentPushSubscription(listener?: Log): Promise<PushSubscriptionSyncResult> {
  if (!supported()) return { status: 'unsupported' };
  if (initialization) await initialization;
  if (logout) return { status: 'cancelled' };
  const userId = await sessionUserId();
  if (desiredUserId === undefined) desiredUserId = userId;
  if (desiredUserId !== userId) return { status: 'cancelled' };
  const expectedRevision = revision;
  const isCurrent = () => revision === expectedRevision && desiredUserId === userId && !logout;
  const report = listener ?? log;

  return enqueue(async () => {
    // A queued SIGNED_OUT job may run after another tab has signed in as B.
    // Recheck the actual session inside the origin-wide lock before cleanup.
    if (!isCurrent()) return { status: 'cancelled' };
    const lockedUserId = await sessionUserId();
    if (!isCurrent() || lockedUserId !== userId) return { status: 'cancelled' };
    if (!userId) {
      const registration = await existingRegistration();
      if (!isCurrent()) return { status: 'cancelled' };
      await cleanup(registration, null, isCurrent);
      return { status: 'missing_user' };
    }
    if (!permitted()) return { status: 'unsupported' };

    let registration: ServiceWorkerRegistration | null = null;
    try {
      const ready = await waitForRegistration(expectedRevision);
      if (ready === CANCELLED || !isCurrent()) return { status: 'cancelled' };
      registration = ready;
      const existing = await registration.pushManager.getSubscription();
      if (!isCurrent()) return { status: 'cancelled' };
      let rotatedOwner = false;
      if (existing && createdOwners.get(existing.endpoint) !== userId) {
        const { data, error } = await supabase.from('push_subscriptions')
          .select('user_id').eq('user_id', userId).eq('endpoint', existing.endpoint).maybeSingle();
        if (!isCurrent()) return { status: 'cancelled' };
        if (error || data?.user_id !== userId) {
          try { await revokeBrowser(registration, existing); }
          catch (error) { return { status: 'unsubscribe_failed', error }; }
          rotatedOwner = true;
          if (error) return { status: 'ownership_failed', error };
        }
      }
      if (!isCurrent()) return { status: 'cancelled' };

      const result = await syncPushSubscription({
        registration,
        vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
        getCurrentUserId: verifiedUserId,
        isCurrent,
        log: report,
        removeStoredSubscription: ({ endpoint, userId: owner }) => removeRow(endpoint, owner),
        persistSubscription: async subscription => {
          if (!isCurrent() || await verifiedUserId() !== userId || !isCurrent()) {
            throw new Error('Push subscription owner changed');
          }
          createdOwners.set(subscription.endpoint, userId);
          const { error } = await supabase.from('push_subscriptions').upsert({
            user_id: userId,
            endpoint: subscription.endpoint,
            keys: subscription.toJSON().keys,
          }, { onConflict: 'endpoint' });
          if (error) throw error;
        },
      });
      return rotatedOwner && result.status === 'subscribed_new' ? { status: 'rotated' } : result;
    } catch (error) {
      return { status: isCurrent() ? 'subscribe_failed' : 'cancelled', error };
    } finally {
      if (registration && !isCurrent()) {
        // subscribe/upsert are intentionally awaited before releasing the
        // lock: their late completion is revoked before B can subscribe.
        const current = await sessionUserId().catch(() => null);
        await cleanup(registration, current === userId ? userId : null);
      }
    }
  });
}

export function signOutWithPushCleanup(): Promise<SignOutResult> {
  if (logout) return logout;
  const owner = sessionUserId().catch(() => null);
  desiredUserId = null;
  invalidate();
  if (scheduled !== null) clearTimeout(scheduled);
  scheduled = null;
  logout = enqueue(async () => {
    const ownerId = await owner;
    try {
      const current = await sessionUserId();
      if (current !== ownerId) return { error: null };
      await cleanup(await existingRegistration(), ownerId);
    } catch { log('Push cleanup was unavailable during logout'); }
    // Even failed cleanup can finish after another account signs in. Keep
    // this check outside its catch, and fail safely if auth cannot be read.
    if (await sessionUserId() !== ownerId) return { error: null };
    return supabase.auth.signOut();
  }).finally(() => {
    logout = null;
    // A different account may have signed in while this logout was queued.
    void sessionUserId().then(observeUser).catch(() => observeUser(null));
  });
  return logout;
}

export function __resetPushSubscriptionLifecycleForTests() {
  observer?.unsubscribe();
  observer = null;
  observerGeneration += 1;
  users = 0;
  initialization = null;
  if (scheduled !== null) clearTimeout(scheduled);
  scheduled = null;
  invalidate();
  desiredUserId = undefined;
  registrationPromise = null;
  cachedRegistration = null;
  logout = null;
  queue = Promise.resolve();
  logs.clear();
  createdOwners.clear();
}
