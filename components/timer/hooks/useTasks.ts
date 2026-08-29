import {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';
import { supabase } from '@/lib/supabase';
import { format, startOfWeek, endOfWeek } from 'date-fns';
import {
  materializeSubtaskForToday,
  toggleSubtaskCompletion,
  type LongTermSubtaskItem,
  type LongTermTaskItem,
  type LongTermTaskRow,
} from '@/lib/longTermTasks';
import {
  GUEST_OWNER,
  getScopedStorageKey,
  getStorageOwner,
  readOwnedJson,
} from '@/lib/userScopedStorage';

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskKind = 'daily' | 'weekly' | 'monthly';

export type TaskItem = {
  id: string;
  title: string;
  status: TaskStatus;
  durationSeconds: number;
  kind: TaskKind;
  sourceSubtaskId?: string | null;
  parentTitle?: string;
};

export type { LongTermSubtaskItem, LongTermTaskItem } from '@/lib/longTermTasks';

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  source_subtask_id?: string | null;
};

type SessionDurationRow = {
  task_id: string | null;
  duration: number | null;
};

const TABLE_BY_KIND: Record<TaskKind, string> = {
  daily: 'tasks',
  weekly: 'weekly_plans',
  monthly: 'monthly_plans',
};

export const TASK_STATE_KEY = 'fomopomo_task_state';

export type SavedTaskState = {
  taskId?: string | null;
  taskTitle?: string;
};

export const useTasks = (isLoggedIn: boolean) => {
  const taskOwner = isLoggedIn ? getStorageOwner() : GUEST_OWNER;
  const [dbTasks, setDbTasks] = useState<TaskItem[]>([]);
  const [weeklyPlans, setWeeklyPlans] = useState<TaskItem[]>([]);
  const [monthlyPlans, setMonthlyPlans] = useState<TaskItem[]>([]);
  const [longTermTasks, setLongTermTasks] = useState<LongTermTaskItem[]>([]);
  const [selectedTask, setSelectedTask] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isTasksLoaded, setIsTasksLoaded] = useState(false);
  const fetchGenerationRef = useRef(0);
  const currentOwnerRef = useRef(taskOwner);
  const restoredTaskStateOwnerRef = useRef<string | null>(null);
  const pendingSubtaskIdsRef = useRef<Set<string>>(new Set());
  const [pendingSubtaskIds, setPendingSubtaskIds] = useState<Set<string>>(
    () => new Set()
  );

  // Invalidate and clear in a layout effect so an owner transition is applied
  // before paint and before a pending response can commit the previous owner's
  // data. Tracking the owner (not only the login boolean) also covers A -> B.
  useLayoutEffect(() => {
    if (currentOwnerRef.current === taskOwner) return;

    currentOwnerRef.current = taskOwner;
    fetchGenerationRef.current += 1;
    restoredTaskStateOwnerRef.current = null;
    pendingSubtaskIdsRef.current.clear();
    setDbTasks([]);
    setWeeklyPlans([]);
    setMonthlyPlans([]);
    setLongTermTasks([]);
    setSelectedTask('');
    setSelectedTaskId(null);
    setIsTasksLoaded(false);
    setPendingSubtaskIds(new Set());
  }, [taskOwner]);

  const applyRestoredTaskState = useCallback(
    (taskId: string | null, taskTitle: string) => {
      setSelectedTaskId(taskId);
      setSelectedTask(taskTitle);
    },
    []
  );

  const fetchDbTasks = useCallback(async () => {
    const fetchOwner = taskOwner;
    if (
      !isLoggedIn ||
      fetchOwner === GUEST_OWNER ||
      currentOwnerRef.current !== fetchOwner
    ) {
      return;
    }

    const fetchGeneration = ++fetchGenerationRef.current;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || user.id !== fetchOwner) return;

      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const currentMonth = now.getMonth() + 1; // 1-12
      const currentYear = now.getFullYear();
      const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday start
      const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

      // Daily tasks (완료 항목도 표시하므로 status 필터 없음)
      const { data: tasksData } = await supabase
        .from('tasks')
        .select('id, title, status, source_subtask_id')
        .eq('user_id', user.id)
        .eq('due_date', today);

      // Weekly plans - filter by current week
      const { data: weeklyData } = await supabase
        .from('weekly_plans')
        .select('id, title, status')
        .eq('user_id', user.id)
        .gte('start_date', format(weekStart, 'yyyy-MM-dd'))
        .lte('end_date', format(weekEnd, 'yyyy-MM-dd'));

      // Monthly plans - filter by current month and year
      const { data: monthlyData } = await supabase
        .from('monthly_plans')
        .select('id, title, status')
        .eq('user_id', user.id)
        .eq('month', currentMonth)
        .eq('year', currentYear);

      const { data: longTermData, error: longTermError } = await supabase
        .from('long_term_tasks')
        .select(
          'id, title, position, long_term_subtasks(id, title, position, completed_at)'
        )
        .eq('user_id', user.id)
        .is('archived_at', null)
        .order('position', { ascending: true });

      const taskRows = (tasksData ?? []) as TaskRow[];
      const weeklyRows = (weeklyData ?? []) as TaskRow[];
      const monthlyRows = (monthlyData ?? []) as TaskRow[];
      const longTermRows = (longTermData ?? []) as LongTermTaskRow[];
      const longTermItems: LongTermTaskItem[] = longTermRows.map((task) => ({
        id: task.id,
        title: task.title,
        position: task.position ?? 0,
        subtasks: (task.long_term_subtasks ?? [])
          .map((subtask) => ({
            ...subtask,
            position: subtask.position ?? 0,
          }))
          .sort((left, right) => left.position - right.position),
      }));

      if (longTermError) {
        console.error('Error fetching long-term tasks:', longTermError);
      }

      const parentTitleBySubtaskId = new Map<string, string>();
      for (const longTermTask of longTermItems) {
        for (const subtask of longTermTask.subtasks) {
          parentTitleBySubtaskId.set(subtask.id, longTermTask.title);
        }
      }

      // 작업별 누적 공부 시간. RLS로 보이는 타인 세션(그룹/친구 조회 허용분)이
      // 합산되지 않도록 본인 세션으로 한정한다. 실패해도 목록은 0으로 표시한다.
      const allIds = [...taskRows, ...weeklyRows, ...monthlyRows].map(
        (row) => row.id
      );
      const durationByTaskId = new Map<string, number>();
      if (allIds.length > 0) {
        const { data: sessions, error: sessionsError } = await supabase
          .from('study_sessions')
          .select('task_id, duration')
          .eq('user_id', user.id)
          .in('task_id', allIds);

        if (sessionsError) {
          console.error('Error fetching task durations:', sessionsError);
        } else {
          for (const row of (sessions ?? []) as SessionDurationRow[]) {
            if (!row.task_id) continue;
            durationByTaskId.set(
              row.task_id,
              (durationByTaskId.get(row.task_id) ?? 0) + (row.duration ?? 0)
            );
          }
        }
      }

      const toItem = (kind: TaskKind) => (row: TaskRow): TaskItem => {
        const sourceSubtaskId = row.source_subtask_id ?? null;
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          durationSeconds: durationByTaskId.get(row.id) ?? 0,
          kind,
          ...(kind === 'daily'
            ? {
                sourceSubtaskId,
                parentTitle: sourceSubtaskId
                  ? parentTitleBySubtaskId.get(sourceSubtaskId)
                  : undefined,
              }
            : {}),
        };
      };

      if (
        fetchGeneration !== fetchGenerationRef.current ||
        currentOwnerRef.current !== fetchOwner
      ) {
        return;
      }

      setDbTasks(taskRows.map(toItem('daily')));
      setWeeklyPlans(weeklyRows.map(toItem('weekly')));
      setMonthlyPlans(monthlyRows.map(toItem('monthly')));
      setLongTermTasks(longTermItems);

      setIsTasksLoaded(true);
    } catch (error) {
      if (
        fetchGeneration === fetchGenerationRef.current &&
        currentOwnerRef.current === fetchOwner
      ) {
        console.error('Error fetching tasks:', error);
      }
    }
  }, [isLoggedIn, taskOwner]);

  // Restore task state from localStorage after tasks are loaded
  // to validate that the saved task still exists in current period
  useEffect(() => {
    if (!isTasksLoaded) return;

    try {
      // Tasks only load while authenticated, so hydrate strictly from the
      // current owner's namespaced key (never another account's or a guest's).
      const owner = taskOwner;
      if (owner === GUEST_OWNER) return;
      if (restoredTaskStateOwnerRef.current === owner) return;
      restoredTaskStateOwnerRef.current = owner;

      const savedTaskState = readOwnedJson<SavedTaskState>(
        TASK_STATE_KEY,
        owner
      );
      if (savedTaskState) {
        const { taskId, taskTitle } = savedTaskState;
        if (taskId) {
          // Validate that the saved task exists in current data
          const taskExists =
            dbTasks.some(t => t.id === taskId) ||
            weeklyPlans.some(t => t.id === taskId) ||
            monthlyPlans.some(t => t.id === taskId);

          if (taskExists) {
            queueMicrotask(() => {
              if (currentOwnerRef.current === owner) {
                applyRestoredTaskState(taskId, taskTitle || '');
              }
            });
          } else {
            // Clear invalid task from localStorage
            localStorage.removeItem(getScopedStorageKey(TASK_STATE_KEY, owner));
            queueMicrotask(() => {
              if (currentOwnerRef.current === owner) {
                applyRestoredTaskState(null, '');
              }
            });
          }
        }
      }
    } catch (error) {
      console.error('Error restoring task state:', error);
    }
  }, [
    applyRestoredTaskState,
    isTasksLoaded,
    dbTasks,
    weeklyPlans,
    monthlyPlans,
    taskOwner,
  ]);

  // Initial fetch and focus/mount listeners
  useEffect(() => {
    const initialFetch = setTimeout(() => {
      void fetchDbTasks();
    }, 0);

    const onFocus = () => {
      void fetchDbTasks();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearTimeout(initialFetch);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchDbTasks]);

  // Restore validation: Ensure selected task still exists or keep it anyway?
  // Original logic didn't strictly validate existence on restore, simplified here.

  const toggleTaskStatus = useCallback(
    async (item: TaskItem) => {
      const nextStatus: TaskStatus = item.status === 'done' ? 'todo' : 'done';
      const applyStatus = (list: TaskItem[]) =>
        list.map((task) =>
          task.id === item.id ? { ...task, status: nextStatus } : task
        );
      fetchGenerationRef.current += 1;
      if (item.kind === 'daily') {
        setDbTasks(applyStatus);
        if (item.sourceSubtaskId) {
          const completedAt =
            nextStatus === 'done' ? new Date().toISOString() : null;
          setLongTermTasks((currentTasks) =>
            currentTasks.map((task) => ({
              ...task,
              subtasks: task.subtasks.map((subtask) =>
                subtask.id === item.sourceSubtaskId
                  ? { ...subtask, completed_at: completedAt }
                  : subtask
              ),
            }))
          );
        }
      } else if (item.kind === 'weekly') setWeeklyPlans(applyStatus);
      else setMonthlyPlans(applyStatus);

      const { error } = await supabase
        .from(TABLE_BY_KIND[item.kind])
        .update({ status: nextStatus })
        .eq('id', item.id);

      if (error) {
        console.error('Error updating task status:', error);
        void fetchDbTasks();
      }
    },
    [fetchDbTasks]
  );

  const selectSubtaskForTimer = useCallback(
    async (subtask: LongTermSubtaskItem): Promise<TaskItem | null> => {
      const existingTask = dbTasks.find(
        (task) => task.sourceSubtaskId === subtask.id
      );

      if (existingTask) {
        setSelectedTask(existingTask.title);
        setSelectedTaskId(existingTask.id);
        return existingTask;
      }

      try {
        const selectionOwner = taskOwner;
        if (
          selectionOwner === GUEST_OWNER ||
          currentOwnerRef.current !== selectionOwner
        ) {
          return null;
        }

        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || user.id !== selectionOwner) return null;

        const materialized = await materializeSubtaskForToday(user.id, subtask);
        if (
          !materialized ||
          currentOwnerRef.current !== selectionOwner
        ) {
          return null;
        }

        const task: TaskItem = {
          id: materialized.id,
          title: materialized.title,
          status: materialized.status,
          durationSeconds: 0,
          kind: 'daily',
          sourceSubtaskId: materialized.source_subtask_id ?? subtask.id,
          parentTitle: longTermTasks.find((longTermTask) =>
            longTermTask.subtasks.some((item) => item.id === subtask.id)
          )?.title,
        };

        setDbTasks((currentTasks) =>
          currentTasks.some((currentTask) => currentTask.id === task.id)
            ? currentTasks
            : [...currentTasks, task]
        );
        setSelectedTask(task.title);
        setSelectedTaskId(task.id);
        void fetchDbTasks();
        return task;
      } catch (error) {
        console.error('Error materializing long-term subtask:', error);
        return null;
      }
    },
    [dbTasks, fetchDbTasks, longTermTasks, taskOwner]
  );

  const toggleSubtask = useCallback(
    async (subtask: LongTermSubtaskItem): Promise<void> => {
      const subtaskId = subtask.id;
      const toggleOwner = taskOwner;
      if (
        toggleOwner === GUEST_OWNER ||
        currentOwnerRef.current !== toggleOwner ||
        pendingSubtaskIdsRef.current.has(subtaskId)
      ) {
        return;
      }

      pendingSubtaskIdsRef.current.add(subtaskId);
      setPendingSubtaskIds(new Set(pendingSubtaskIdsRef.current));

      const completedAt = subtask.completed_at ? null : new Date().toISOString();
      const nextStatus: TaskStatus = completedAt ? 'done' : 'todo';

      fetchGenerationRef.current += 1;
      setLongTermTasks((currentTasks) =>
        currentTasks.map((task) => ({
          ...task,
          subtasks: task.subtasks.map((currentSubtask) =>
            currentSubtask.id === subtask.id
              ? { ...currentSubtask, completed_at: completedAt }
              : currentSubtask
          ),
        }))
      );
      setDbTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.sourceSubtaskId === subtask.id
            ? { ...task, status: nextStatus }
            : task
        )
      );

      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (
          !user ||
          user.id !== toggleOwner ||
          currentOwnerRef.current !== toggleOwner
        ) {
          throw new Error('Authenticated owner changed');
        }

        await toggleSubtaskCompletion(user.id, subtask, completedAt);
      } catch (error) {
        console.error('Error toggling long-term subtask:', error);
        if (currentOwnerRef.current === toggleOwner) {
          void fetchDbTasks();
        }
      } finally {
        if (currentOwnerRef.current === toggleOwner) {
          pendingSubtaskIdsRef.current.delete(subtaskId);
          setPendingSubtaskIds(new Set(pendingSubtaskIdsRef.current));
        }
      }
    },
    [fetchDbTasks, taskOwner]
  );

  const getSelectedTaskTitle = useCallback(() => {
    const task =
      dbTasks.find((t) => t.id === selectedTaskId) ||
      weeklyPlans.find((t) => t.id === selectedTaskId) ||
      monthlyPlans.find((t) => t.id === selectedTaskId);
    return task?.title || '';
  }, [dbTasks, weeklyPlans, monthlyPlans, selectedTaskId]);

  return {
    dbTasks,
    weeklyPlans,
    monthlyPlans,
    longTermTasks,
    selectedTask,
    selectedTaskId,
    setSelectedTask,
    setSelectedTaskId,
    getSelectedTaskTitle,
    fetchDbTasks,
    toggleTaskStatus,
    selectSubtaskForTimer,
    toggleSubtask,
    pendingSubtaskIds,
  };
};
