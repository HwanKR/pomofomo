import { format } from 'date-fns';
import { supabase } from '@/lib/supabase';

export type LongTermSubtaskRow = {
  id: string;
  long_term_task_id: string;
  title: string;
  position: number | null;
  completed_at: string | null;
};

export type SubtaskRow = LongTermSubtaskRow;

export type LongTermSubtaskSelectRow = Pick<
  LongTermSubtaskRow,
  'id' | 'title' | 'position' | 'completed_at'
>;

export type LongTermSubtaskItem = Omit<
  LongTermSubtaskSelectRow,
  'position'
> & { position: number };

export type LongTermTaskRow = {
  id: string;
  title: string;
  position: number | null;
  long_term_subtasks: LongTermSubtaskSelectRow[] | null;
};

export type LongTermTaskItem = {
  id: string;
  title: string;
  position: number;
  subtasks: LongTermSubtaskItem[];
};

export type MaterializedTaskRow = {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  estimated_pomodoros: number | null;
  position: number | null;
  source_subtask_id: string | null;
};

type MaterializableSubtask = Pick<LongTermSubtaskItem, 'id' | 'title'>;
type CompletableSubtask = Pick<LongTermSubtaskItem, 'id' | 'completed_at'>;

const MATERIALIZED_TASK_SELECT =
  'id, title, status, estimated_pomodoros, position, source_subtask_id';

export async function materializeSubtaskForToday(
  userId: string,
  subtask: MaterializableSubtask
): Promise<MaterializedTaskRow | null> {
  // tasks.due_date follows the calendar date used by TaskList/useTasks, not
  // the 05:00 study-day boundary used for study-session reporting.
  const todayKey = format(new Date(), 'yyyy-MM-dd');

  const { data: lastTask, error: positionError } = await supabase
    .from('tasks')
    .select('position')
    .eq('user_id', userId)
    .eq('due_date', todayKey)
    .order('position', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (positionError) throw positionError;

  const lastPosition = lastTask
    ? ((lastTask.position as number | null) ?? 0)
    : -1;
  const position = lastPosition + 1;
  const { data, error } = await supabase
    .from('tasks')
    .upsert(
      {
        user_id: userId,
        title: subtask.title,
        due_date: todayKey,
        status: 'todo',
        position,
        source_subtask_id: subtask.id,
      },
      {
        onConflict: 'source_subtask_id,due_date',
        ignoreDuplicates: true,
      }
    )
    .select(MATERIALIZED_TASK_SELECT)
    .maybeSingle();

  if (error) throw error;
  if (data) return data as MaterializedTaskRow;

  // A zero-row upsert means another caller won the race or this subtask was
  // already materialized today. Read and return the unique winning row.
  const { data: existing, error: existingError } = await supabase
    .from('tasks')
    .select(MATERIALIZED_TASK_SELECT)
    .eq('source_subtask_id', subtask.id)
    .eq('due_date', todayKey)
    .maybeSingle();

  if (existingError) throw existingError;
  return (existing as MaterializedTaskRow | null) ?? null;
}

export async function toggleSubtaskCompletion(
  userId: string,
  subtask: CompletableSubtask,
  // Callers doing an optimistic update pass the exact value they rendered so
  // the stored state can never diverge from what the user saw.
  targetCompletedAt?: string | null
): Promise<void> {
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const completedAt =
    targetCompletedAt !== undefined
      ? targetCompletedAt
      : subtask.completed_at
        ? null
        : new Date().toISOString();
  const status = completedAt ? 'done' : 'todo';

  // The pool is the source of truth, so failure here must reach the caller.
  const { error } = await supabase
    .from('long_term_subtasks')
    .update({ completed_at: completedAt })
    .eq('id', subtask.id)
    .eq('user_id', userId);

  if (error) throw error;

  // A daily task may not exist. If it does, keep only today's materialized
  // instance in sync; past-day rows are historical records and stay intact.
  try {
    const { error: syncError } = await supabase
      .from('tasks')
      .update({ status })
      .eq('user_id', userId)
      .eq('source_subtask_id', subtask.id)
      .eq('due_date', todayKey)
      .neq('status', status);

    if (syncError) {
      console.error('Error syncing materialized task status:', syncError);
    }
  } catch (syncError) {
    console.error('Error syncing materialized task status:', syncError);
  }
}
