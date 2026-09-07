import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { splitIntervalAtStudyDayBoundary } from '@/lib/dateUtils';
import { getCurrentUserId } from '@/lib/userScopedStorage';
import toast from 'react-hot-toast';

type ProfileStatusUpdate = {
  status: 'studying' | 'paused' | 'online' | 'offline';
  current_task: string | null;
  last_active_at: string;
  study_start_time: string | null;
  timer_type: 'timer' | 'stopwatch';
  timer_mode: 'focus' | 'shortBreak' | 'longBreak';
  timer_duration: number;
  total_stopwatch_time?: number;
};

// Helper to generate UUID
const generateUUID = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// 'rejected': the server refused the batch permanently (payload conflict or
// validation failure). The draft is kept in the outbox in an explicit recovery
// state, in-memory session state is cleared, and callers must not auto-retry.
export type SaveRecordResult = 'saved' | 'failed' | 'skipped' | 'rejected';

// Durations under this are not savable ("10초 미만은 저장되지 않습니다"). The
// single source for every caller-side gate, so a policy change cannot leave a
// silent pre-gate passing durations the save itself will refuse.
export const MIN_SAVABLE_SECONDS = 10;

// One ordered slice of a save batch, as the recording RPC consumes it.
// ended_at is the interval end (the row's created_at on the server); the
// server derives the start as ended_at - duration.
type SessionSegment = {
  index: number;
  duration: number;
  ended_at: string;
};

// v1 outbox rows (pre-RPC clients) carried full study_sessions rows; drafts
// written before the session_batch_id migration held the batch id in group_id.
type LegacyPendingSessionRow = {
  mode: string;
  duration: number;
  user_id: string;
  task: string | null;
  task_id: string | null;
  created_at: string;
  session_batch_id?: string;
  group_id?: string;
};

type LegacyPendingSessionDraft = {
  sessionId: string;
  rows: LegacyPendingSessionRow[];
  failedAt: number;
};

// v2 outbox draft: exactly the RPC payload plus local-only bookkeeping.
// ownerId only gates which signed-in account may flush the draft — it is
// NEVER sent to the server (the RPC derives the owner from auth.uid()).
type PendingSessionDraftV2 = {
  version: 2;
  sessionId: string;
  ownerId: string;
  mode: string;
  task: string | null;
  taskId: string | null;
  segments: SessionSegment[];
  failedAt: number;
  // 'conflict': the server already holds this batch id with a different
  // payload. 'invalid': the server rejected the payload permanently.
  // Flagged drafts are kept for inspection but never auto-resent.
  state?: 'conflict' | 'invalid';
};

type PendingSessionDraft = PendingSessionDraftV2 | LegacyPendingSessionDraft;

// Durable outbox for failed saves: drafts survive reloads so a failed save
// never silently discards study time. Keyed by the stable per-session id.
const PENDING_SESSIONS_KEY = 'fomopomo_pending_sessions';

const readPendingSessions = (): Record<string, PendingSessionDraft> => {
  try {
    const raw = window.localStorage.getItem(PENDING_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    console.error('Failed to read pending sessions outbox', e);
    return {};
  }
};

const writePendingSessions = (drafts: Record<string, PendingSessionDraft>) => {
  try {
    window.localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(drafts));
  } catch (e) {
    console.error('Failed to write pending sessions outbox', e);
  }
};

const upsertPendingSession = (draft: PendingSessionDraftV2) => {
  const drafts = readPendingSessions();
  drafts[draft.sessionId] = draft;
  writePendingSessions(drafts);
};

const removePendingSession = (sessionId: string) => {
  const drafts = readPendingSessions();
  if (!(sessionId in drafts)) return;
  delete drafts[sessionId];
  writePendingSessions(drafts);
};

const isV2Draft = (draft: PendingSessionDraft): draft is PendingSessionDraftV2 =>
  (draft as PendingSessionDraftV2).version === 2;

// Upgrades a draft to the v2 shape without losing information. Returns null
// when the stored value is unrecognizable — callers must then KEEP the draft
// untouched (a conversion failure must never silently discard study time).
const toDraftV2 = (
  sessionId: string,
  draft: PendingSessionDraft
): PendingSessionDraftV2 | null => {
  if (isV2Draft(draft)) {
    if (
      typeof draft.ownerId !== 'string' ||
      typeof draft.mode !== 'string' ||
      !Array.isArray(draft.segments) ||
      draft.segments.length === 0
    ) {
      return null;
    }
    return draft;
  }

  const rows = draft?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (typeof first?.user_id !== 'string' || typeof first?.mode !== 'string') {
    return null;
  }
  // A v1 draft was one save, so every row shares owner/mode/task metadata.
  const uniform = rows.every(
    (row) =>
      row &&
      row.user_id === first.user_id &&
      row.mode === first.mode &&
      typeof row.duration === 'number' &&
      typeof row.created_at === 'string'
  );
  if (!uniform) return null;

  return {
    version: 2,
    sessionId,
    ownerId: first.user_id,
    mode: first.mode,
    task: first.task ?? null,
    taskId: first.task_id ?? null,
    segments: rows.map((row, index) => ({
      index,
      duration: row.duration,
      ended_at: row.created_at,
    })),
    failedAt: draft.failedAt ?? Date.now(),
  };
};

// Drops every draft that belongs to `userId`. Called after an account reset or
// deletion so mount-time recovery cannot re-send data the server just erased.
export const clearPendingSessionsForUser = (userId: string) => {
  const drafts = readPendingSessions();
  let changed = false;
  for (const [sessionId, draft] of Object.entries(drafts)) {
    const owned = isV2Draft(draft)
      ? draft.ownerId === userId
      : draft?.rows?.some((row) => row.user_id === userId);
    if (owned) {
      delete drafts[sessionId];
      changed = true;
    }
  }
  if (changed) writePendingSessions(drafts);
};

// Session ids currently being sent, shared across hook instances so a
// StrictMode double-mount cannot fire two RPC calls for the same draft.
// (The server-side idempotency contract still covers cross-tab races.)
const recoveringSessionIds = new Set<string>();

const callRecordBatchRpc = async (draft: {
  sessionId: string;
  ownerId: string;
  mode: string;
  task: string | null;
  taskId: string | null;
  segments: SessionSegment[];
}, isCurrent: () => boolean = () => true) => {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (
    !session || session.user.id !== draft.ownerId ||
    getCurrentUserId() !== draft.ownerId || !isCurrent()
  ) return null;

  // Bind this request to the draft owner's token. The shared client's auth
  // can change before its lazy request starts or retries; it must never
  // pick up the next account's credentials for this record.
  return supabase.rpc('record_study_session_batch', {
    p_batch_id: draft.sessionId,
    p_mode: draft.mode,
    p_task: draft.task,
    p_task_id: draft.taskId,
    p_segments: draft.segments,
  }).setHeader('Authorization', `Bearer ${session.access_token}`);
};

// SQLSTATEs the recording RPC raises for inputs that can never succeed.
// Anything else (missing code, PostgREST/network failures) is retryable.
const PERMANENT_RPC_SQLSTATES = new Set([
  '22007',
  '22008',
  '22023',
  '22P02',
  '23502',
  '23514',
  '42501',
]);

type RpcFailureKind = 'conflict' | 'permanent' | 'retryable';

const classifyRpcError = (error: { code?: string; message?: string } | null): RpcFailureKind => {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === '23505' || message.includes('study_session_batch_conflict')) {
    return 'conflict';
  }
  if (PERMANENT_RPC_SQLSTATES.has(code)) return 'permanent';
  return 'retryable';
};

const sumSegmentSeconds = (segments: SessionSegment[]) =>
  segments.reduce((sum, segment) => sum + segment.duration, 0);

// Builds the RPC segment list for a save: closes the still-open interval at
// endTimeToUse, splits everything at study-day (05:00) boundaries, and falls
// back to one synthesized interval anchored at endTimeToUse when no usable
// interval remains.
const buildSessionSegments = (
  intervalsList: { start: number; end: number }[],
  currentStart: number | null,
  endTimeToUse: number,
  duration: number
): SessionSegment[] => {
  let sessionIntervals = [...intervalsList];
  if (currentStart) {
    sessionIntervals.push({ start: currentStart, end: endTimeToUse });
  }
  sessionIntervals = sessionIntervals.filter(i => i.start > 0 && i.end > 0);
  if (sessionIntervals.length === 0 && duration > 0 && duration < 24 * 60 * 60) {
    sessionIntervals.push({ start: endTimeToUse - duration * 1000, end: endTimeToUse });
  }

  const splitSegments = sessionIntervals
    .flatMap(interval => splitIntervalAtStudyDayBoundary(interval))
    .map(interval => ({
      duration: Math.round((interval.end - interval.start) / 1000),
      ended_at: new Date(interval.end).toISOString(),
    }))
    .filter(segment => segment.duration >= 10 && segment.duration < 24 * 60 * 60)
    .map((segment, index) => ({ index, ...segment }));

  return splitSegments.length > 0
    ? splitSegments
    : [{ index: 0, duration, ended_at: new Date(endTimeToUse).toISOString() }];
};

// One logical study record, captured atomically at creation time. The id,
// owner, and segments are frozen here so no later async work (auto-started
// sessions, account switches, retries, modal answers) can attach this
// record's save to another record's identity or content.
export type PendingStudyRecord = {
  sessionId: string;
  ownerId: string;
  mode: string;
  duration: number;
  forcedEndTime: number;
  segments: SessionSegment[];
};

const formatKoreanDuration = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}초`;
  if (seconds === 0) return `${minutes}분`;
  return `${minutes}분 ${seconds}초`;
};

interface UseStudySessionProps {
  isLoggedIn: boolean;
  onRecordSaved: () => void;
  selectedTaskTitle: string;
}

export const useStudySession = ({
  isLoggedIn,
  onRecordSaved,
  selectedTaskTitle,
}: UseStudySessionProps) => {
  const ownerId = isLoggedIn ? getCurrentUserId() : null;
  const [isSaving, setIsSaving] = useState(false);
  const [intervals, setIntervals] = useState<{ start: number; end: number }[]>([]);
  // Ref-based lock to prevent duplicate saves (sync check, unlike useState)
  const isSavingRef = useRef(false);
  const currentIntervalStartRef = useRef<number | null>(null);

  const updateStatus = useCallback(async (status: 'studying' | 'paused' | 'online' | 'offline', task?: string, startTime?: string, elapsedTime?: number, timerType: 'timer' | 'stopwatch' = 'stopwatch', timerMode: 'focus' | 'shortBreak' | 'longBreak' = 'focus', timerDuration: number = 0) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const taskTitle = task !== undefined ? task : selectedTaskTitle;

      // Check privacy setting
      const { data } = await supabase.from('profiles').select('is_task_public').eq('id', user.id).single();
      const isPublic = data?.is_task_public ?? true;

      const updateData: ProfileStatusUpdate = {
        status,
        current_task: isPublic ? taskTitle : null,
        last_active_at: new Date().toISOString(),
        study_start_time: startTime || null,
        timer_type: timerType,
        timer_mode: timerMode,
        timer_duration: timerDuration,
      };

      if (elapsedTime !== undefined) {
        updateData.total_stopwatch_time = elapsedTime;
      }

      await supabase.from('profiles').update(updateData).eq('id', user.id);
    } catch (e) {
      console.error('Failed to update status', e);
    }
  }, [selectedTaskTitle]);

  // Creates one logical study record SYNCHRONOUSLY: freezes the segments from
  // the live interval state, consumes that state, and parks the record as an
  // unlabeled outbox draft — all before anything async can run. From this
  // moment the record can survive a refresh (mount recovery finishes it), an
  // auto-started next session cannot corrupt its segments, and its batch id
  // can never be confused with another record's. Returns null when no
  // authenticated owner can be resolved (the caller should treat it as a
  // login-required save).
  //
  // contentOverride builds the record from explicitly supplied intervals
  // instead of the live state (which is then left untouched) — used when a
  // restore finds a timer that completed while the tab was closed, whose
  // content exists only in the persisted snapshot. Its optional sessionId
  // makes the batch id deterministic: two tabs (or repeated mounts after a
  // failed settle-write) completing the SAME expired snapshot then collide on
  // one batch id and the server's idempotency dedupes them.
  const createPendingRecord = useCallback(
    (
      recordMode: string,
      duration: number,
      forcedEndTime?: number,
      contentOverride?: {
        intervals: { start: number; end: number }[];
        currentStart: number | null;
        sessionId?: string;
      }
    ): PendingStudyRecord | null => {
      const ownerId = getCurrentUserId();
      if (!ownerId) return null;

      const endTime = forcedEndTime || Date.now();
      const sourceIntervals = contentOverride ? contentOverride.intervals : intervals;
      const sourceStart = contentOverride ? contentOverride.currentStart : currentIntervalStartRef.current;
      const record: PendingStudyRecord = {
        sessionId: contentOverride?.sessionId ?? generateUUID(),
        ownerId,
        mode: recordMode,
        duration,
        forcedEndTime: endTime,
        segments: buildSessionSegments(sourceIntervals, sourceStart, endTime, duration),
      };

      if (!contentOverride) {
        // Content ownership moves to the record atomically: the live interval
        // state belongs to the NEXT session from here on.
        setIntervals([]);
        currentIntervalStartRef.current = null;
      }

      // Shield the parked draft from this tab's own recovery passes (the
      // effect re-runs on auth transitions) while the record is still live
      // here — e.g. waiting in the task popup. A reload clears the shield,
      // which is exactly when recovery SHOULD take over.
      recoveringSessionIds.add(record.sessionId);

      upsertPendingSession({
        version: 2,
        sessionId: record.sessionId,
        ownerId,
        mode: record.mode,
        task: null,
        taskId: null,
        segments: record.segments,
        failedAt: Date.now(),
      });

      return record;
    },
    [intervals]
  );

  // Saves a created record, attaching the given label. Retries call this again
  // with the SAME record (closures carry it), so the batch id and segments are
  // byte-identical across attempts and the server's idempotency contract can
  // always prove a duplicate.
  const savePendingRecord = useCallback(
    async (record: PendingStudyRecord, taskText = '', taskId: string | null = null): Promise<SaveRecordResult> => {
      // Prevent duplicate saves using ref (synchronous check). The record
      // stays shielded: the in-flight save's own terminal handling owns it.
      if (isSavingRef.current) {
        console.log('[savePendingRecord] Already saving, ignoring duplicate request');
        return 'skipped';
      }

      if (!isLoggedIn || getCurrentUserId() !== record.ownerId) {
        // The account is gone or changed since the record was created. This
        // tab relinquishes the record: unshield it so recovery can flush the
        // parked draft once its owner signs back in.
        recoveringSessionIds.delete(record.sessionId);
        toast.error('로그인이 필요한 기능입니다.');
        return 'skipped';
      }

      isSavingRef.current = true;
      setIsSaving(true);
      const toastId = toast.loading('기록 저장 중...', {
        style: {
          borderRadius: '10px',
          background: '#333',
          color: '#fff',
          fontSize: '14px',
        },
      });

      const payload = {
        mode: record.mode,
        task: taskText.trim() || null,
        taskId,
        segments: record.segments,
      };

      try {
        const response = await callRecordBatchRpc({ sessionId: record.sessionId, ownerId: record.ownerId, ...payload });
        if (!response) {
          recoveringSessionIds.delete(record.sessionId);
          toast.dismiss(toastId);
          return 'skipped';
        }
        const { data, error } = response;

        if (!error) {
          // 'saved' and 'already_processed' are both durable success: the
          // batch exists on the server exactly once.
          removePendingSession(record.sessionId);
          recoveringSessionIds.delete(record.sessionId);
          const savedSeconds =
            typeof data?.total_seconds === 'number'
              ? data.total_seconds
              : sumSegmentSeconds(payload.segments);
          toast.success(`${formatKoreanDuration(savedSeconds)} 기록 저장 완료!`, { id: toastId });
          onRecordSaved();
          return 'saved';
        }

        const kind = classifyRpcError(error);

        if (kind === 'conflict' && payload.task !== null) {
          // The batch id already exists with different content. Records are
          // parked unlabeled at creation and batch ids are per-record UUIDs,
          // so the writer is another tab's mount recovery committing the
          // unlabeled twin: the study time is on the server exactly once —
          // only the label could not be attached.
          removePendingSession(record.sessionId);
          recoveringSessionIds.delete(record.sessionId);
          toast.success('기록은 이미 저장되어 있어요. 방금 고른 작업 이름은 반영되지 않았을 수 있어요.', {
            id: toastId,
            duration: 6000,
          });
          onRecordSaved();
          return 'saved';
        }

        if (kind === 'retryable') {
          // Refresh the draft with the label so a post-refresh recovery saves
          // it fully, not just unlabeled.
          upsertPendingSession({
            version: 2,
            sessionId: record.sessionId,
            ownerId: record.ownerId,
            ...payload,
            failedAt: Date.now(),
          });
          toast.error(
            `저장 실패: ${error.message}\n기록은 임시 보관 중이니 다시 시도해주세요.`,
            { id: toastId, duration: 5000 }
          );
          return 'failed';
        }

        // Terminal server verdicts. Keep the draft in an explicit recovery
        // state (never auto-resent) for inspection.
        upsertPendingSession({
          version: 2,
          sessionId: record.sessionId,
          ownerId: record.ownerId,
          ...payload,
          failedAt: Date.now(),
          state: kind === 'conflict' ? 'conflict' : 'invalid',
        });
        recoveringSessionIds.delete(record.sessionId);
        toast.error(
          kind === 'conflict'
            ? '이 세션은 이미 다른 내용으로 저장되어 있어요. 최근 활동에서 저장된 기록을 확인해주세요.'
            : `기록이 서버 검증에서 거부되었습니다: ${error.message}`,
          { id: toastId, duration: 6000 }
        );
        return 'rejected';
      } catch (error) {
        // Unexpected transport failure: same handling as a retryable error.
        console.error(error);
        upsertPendingSession({
          version: 2,
          sessionId: record.sessionId,
          ownerId: record.ownerId,
          ...payload,
          failedAt: Date.now(),
        });
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        toast.error(`저장 실패: ${errorMessage}\n기록은 임시 보관 중이니 다시 시도해주세요.`, { id: toastId, duration: 5000 });
        return 'failed';
      } finally {
        // 'failed' keeps the record shielded: this tab's retry toast still
        // owns it, and a reload clears the shield for mount recovery.
        isSavingRef.current = false;
        setIsSaving(false);
      }
    },
    [onRecordSaved, isLoggedIn]
  );

  // Recover drafts orphaned by a reload: a save that failed and never got its
  // in-page retry would otherwise sit in the outbox forever. Recovery sends
  // the exact same RPC with the same batch id, so the server's idempotency
  // contract — not a client-side existence check — decides whether anything
  // is inserted. Concurrent tabs recovering the same draft therefore cannot
  // duplicate it.
  const onRecordSavedRef = useRef(onRecordSaved);
  onRecordSavedRef.current = onRecordSaved;

  useEffect(() => {
    if (!ownerId || typeof window === 'undefined') return;
    let cancelled = false;
    const isCurrent = () => !cancelled && getCurrentUserId() === ownerId;

    const recoverOrphanedDrafts = async () => {
      const drafts = readPendingSessions();
      if (Object.keys(drafts).length === 0) return;

      let recoveredSeconds = 0;
      for (const [sessionId, rawDraft] of Object.entries(drafts)) {
        if (!isCurrent()) break;
        // Skip drafts owned by an in-flight interactive save or another
        // recovery pass (savePendingRecord registers its record id here).
        if (recoveringSessionIds.has(sessionId)) {
          continue;
        }

        const draft = rawDraft ? toDraftV2(sessionId, rawDraft) : null;
        if (!draft) {
          // Never silently discard a draft we cannot convert — keep it so the
          // study time stays inspectable/recoverable.
          console.error('Unrecognized pending session draft; leaving it untouched', sessionId);
          continue;
        }
        // Drafts from another account stay put until that account signs in.
        if (draft.ownerId !== ownerId) continue;
        // Flagged drafts are terminal: the server already gave its verdict.
        if (draft.state) continue;

        let claimed = false;
        try {
          const response = await callRecordBatchRpc(draft, () => {
            if (!isCurrent() || recoveringSessionIds.has(sessionId)) return false;
            // Claim after session lookup so a cancelled StrictMode setup
            // cannot block the replacement effect without ever sending.
            recoveringSessionIds.add(sessionId);
            claimed = true;
            return true;
          });
          if (!response) {
            if (!isCurrent()) break;
            continue;
          }
          const { data, error } = response;
          if (!error) {
            // 'already_processed' proves the original attempt landed; only a
            // fresh 'saved' contributes to the recovered-time toast.
            removePendingSession(sessionId);
            if (data?.status === 'saved') {
              recoveredSeconds +=
                typeof data?.total_seconds === 'number'
                  ? data.total_seconds
                  : sumSegmentSeconds(draft.segments);
            }
          } else {
            const kind = classifyRpcError(error);
            if (kind === 'retryable') {
              // Keep the draft for the next mount (upgraded to v2 in place).
              upsertPendingSession(draft);
            } else if (kind === 'conflict' && draft.task === null && isV2Draft(rawDraft)) {
              // The batch already exists with different content. v2 batch ids
              // are per-record UUIDs and unlabeled v2 drafts are the parked
              // twins of interactive saves, so the committed version is this
              // record answered WITH a label: content is on the server
              // exactly once — drop the unlabeled twin. (Legacy v1 drafts
              // carry no such guarantee and stay flagged instead.)
              removePendingSession(sessionId);
            } else {
              upsertPendingSession({
                ...draft,
                state: kind === 'conflict' ? 'conflict' : 'invalid',
              });
              console.error('Pending session draft rejected by the server', sessionId, error);
            }
          }
        } catch (e) {
          // Transport failure: keep the draft for the next mount.
          console.error('Failed to recover pending session draft', e);
        } finally {
          if (claimed) recoveringSessionIds.delete(sessionId);
        }
      }

      if (isCurrent() && recoveredSeconds > 0) {
        toast.success(`보관 중이던 ${formatKoreanDuration(recoveredSeconds)} 기록을 저장했습니다!`);
        onRecordSavedRef.current();
      }
    };

    recoverOrphanedDrafts();
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  // Set online on mount / offline on unmount
  useEffect(() => {
    const setOnline = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('profiles').update({
          status: 'online',
          last_active_at: new Date().toISOString(),
        }).eq('id', user.id)
          // Do not overwrite the source device's running state or the
          // timestamp anchoring its paused study time before hydration reads it.
          .in('status', ['online', 'offline'])
          .is('study_start_time', null)
          .eq('total_stopwatch_time', 0);
      }
    };
    setOnline();

    const handleUnload = () => {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
      const projectId = supabaseUrl.split('//')[1]?.split('.')[0];
      const currentSessionString = projectId
        ? localStorage.getItem(`sb-${projectId}-auth-token`)
        : null;

      if (currentSessionString) {
        try {
          const session = JSON.parse(currentSessionString);
          if (session?.access_token && session?.user?.id) {
            const blob = new Blob([JSON.stringify({
              status: 'offline',
              user_id: session.user.id,
              access_token: session.access_token
            })], { type: 'application/json' });

            navigator.sendBeacon('/api/status', blob);
          }
        } catch (e) {
          console.error('Error parsing session for beacon', e);
        }
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    }
  }, []);


  return {
    isSaving,
    intervals,
    setIntervals,
    currentIntervalStartRef,
    updateStatus,
    createPendingRecord,
    savePendingRecord,
    checkActiveSession: useCallback(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;

        const { data } = await supabase
          .from('profiles')
          .select('status, study_start_time, total_stopwatch_time, timer_type, timer_mode, timer_duration, last_active_at')
          .eq('id', user.id)
          .single();

        return data;
      } catch (e) {
        console.error('Failed to check active session', e);
        return null;
      }
    }, []),
  };
};
