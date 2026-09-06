'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  Check,
  CheckCircle2,
  Circle,
  GripVertical,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import ConfirmModal from '@/components/ConfirmModal';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

interface Task {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  estimated_pomodoros: number;
  duration?: number;
  position: number;
  source_subtask_id: string | null;
  parentTitle?: string;
}

interface PinnedTask {
  id: string;
  title: string;
  position: number;
}

type TaskRow = {
  id: string;
  title: string;
  status: Task['status'];
  estimated_pomodoros: number | null;
  position: number | null;
  source_subtask_id: string | null;
};

type SubtaskParentRow = {
  id: string;
  long_term_tasks: { title: string } | { title: string }[] | null;
};

type PinnedTaskRow = {
  id: string;
  title: string;
  position: number | null;
};

type SessionDurationRow = {
  task_id: string | null;
  duration: number | null;
};

const formatDuration = (seconds: number) => {
  if (!seconds) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const normalizeTaskRows = (rows: TaskRow[] | null | undefined): Task[] =>
  (rows ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    estimated_pomodoros: row.estimated_pomodoros ?? 0,
    position: row.position ?? 0,
    source_subtask_id: row.source_subtask_id ?? null,
  }));

const normalizePinnedTaskRows = (
  rows: PinnedTaskRow[] | null | undefined
): PinnedTask[] =>
  (rows ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    position: row.position ?? 0,
  }));

interface SortableTaskItemProps {
  task: Task;
  toggleTaskStatus: (task: Task) => void;
  deleteTask: (id: string) => void;
  updateTask: (id: string, title: string) => void;
  pinTask: (task: Task) => void;
  isPinned: boolean;
}

function SortableTaskItem({
  task,
  toggleTaskStatus,
  deleteTask,
  updateTask,
  pinTask,
  isPinned,
}: SortableTaskItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
    opacity: isDragging ? 0.5 : 1,
  };

  const handleSave = () => {
    if (editedTitle.trim() && editedTitle !== task.title) {
      updateTask(task.id, editedTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditedTitle(task.title);
    setIsEditing(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSave();
    } else if (event.key === 'Escape') {
      handleCancel();
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-transparent bg-gray-50 p-4 transition-all hover:border-gray-200 dark:bg-gray-900/50 dark:hover:border-gray-700',
        isDragging &&
          'border-rose-200 bg-white shadow-lg dark:border-rose-900 dark:bg-gray-800'
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-300 hover:text-gray-500 active:cursor-grabbing"
      >
        <GripVertical className="h-5 w-5" />
      </div>

      <button
        onClick={() => toggleTaskStatus(task)}
        className={cn(
          'flex-shrink-0 transition-colors',
          task.status === 'done'
            ? 'text-rose-500'
            : 'text-gray-300 hover:text-gray-400'
        )}
      >
        {task.status === 'done' ? (
          <CheckCircle2 className="h-6 w-6" />
        ) : (
          <Circle className="h-6 w-6" />
        )}
      </button>

      {isEditing ? (
        <div className="flex flex-1 items-center gap-2">
          <input
            type="text"
            value={editedTitle}
            onChange={(event) => setEditedTitle(event.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            autoFocus
          />
          <button
            onClick={handleSave}
            className="rounded-lg p-1.5 text-green-500 transition-colors hover:bg-green-50 dark:hover:bg-green-900/30"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={handleCancel}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <button
            onClick={() => pinTask(task)}
            className={cn(
              'flex-shrink-0 transition-colors',
              isPinned
                ? 'text-amber-500 hover:text-amber-600'
                : 'text-gray-400 hover:text-amber-500'
            )}
            title={isPinned ? '작업 고정 해제' : '작업 고정'}
          >
            <Pin className={cn('h-4 w-4', isPinned && 'fill-current')} />
          </button>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate font-medium transition-all',
                task.status === 'done'
                  ? 'text-gray-400 line-through'
                  : 'text-gray-700 dark:text-gray-200'
              )}
            >
              {task.title}
            </span>
            {task.parentTitle ? (
              <span className="block truncate text-xs font-normal text-gray-400 dark:text-gray-500">
                {task.parentTitle}
              </span>
            ) : null}
          </span>
        </span>
      )}

      {task.duration ? (
        <span className="whitespace-nowrap rounded-md bg-rose-50 px-2 py-1 text-xs font-bold text-rose-500 dark:bg-rose-900/30">
          {formatDuration(task.duration)}
        </span>
      ) : null}

      {!isEditing && (
        <button
          onClick={() => setIsEditing(true)}
          className="p-2 text-gray-400 transition-all hover:text-rose-500 opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}

      <button
        onClick={() => deleteTask(task.id)}
        className="p-2 text-gray-400 transition-all hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

interface TaskListProps {
  selectedDate: Date;
  userId: string;
}

export default function TaskList({ selectedDate, userId }: TaskListProps) {
  const selectedDateKey = format(selectedDate, 'yyyy-MM-dd');

  // A new owner/date gets fresh UI state, including drafts and confirmations.
  // Returning to an earlier key still creates a new request lifetime.
  return (
    <ScopedTaskList
      key={`${userId}:${selectedDateKey}`}
      selectedDateKey={selectedDateKey}
      userId={userId}
    />
  );
}

const createRequestScope = () => ({
  active: true,
  taskRequest: 0,
  taskReadPending: false,
  pinnedRequest: 0,
  mutations: 0,
  refreshTasks: false,
  refreshPinned: false,
});

function ScopedTaskList({ selectedDateKey, userId }: {
  selectedDateKey: string;
  userId: string;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [pinnedTasks, setPinnedTasks] = useState<PinnedTask[]>([]);
  const scopeRef = useRef<ReturnType<typeof createRequestScope> | null>(null);

  useLayoutEffect(() => {
    const scope = createRequestScope();
    scopeRef.current = scope;
    // Use a new object on every setup: StrictMode cleanup must permanently
    // invalidate the work started by its previous setup.
    return () => { scope.active = false; };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchPinnedTasks = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope?.active) return;
    if (scope.mutations > 0) {
      scope.refreshPinned = true;
      return;
    }
    const request = ++scope.pinnedRequest;
    const isCurrent = () => scope.active && request === scope.pinnedRequest;
    if (!userId) {
      setPinnedTasks([]);
      return;
    }

    const { data, error } = await supabase
      .from('pinned_tasks')
      .select('id, title, position')
      .eq('user_id', userId)
      .order('position', { ascending: true });

    if (!isCurrent()) return;
    if (error) {
      console.error('Error fetching pinned tasks:', error);
      return;
    }

    setPinnedTasks(normalizePinnedTaskRows(data as PinnedTaskRow[]));
  }, [userId]);

  const fetchTasks = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope?.active) return;
    if (scope.mutations > 0) {
      scope.refreshTasks = true;
      return;
    }
    const request = ++scope.taskRequest;
    const isCurrent = () => scope.active && request === scope.taskRequest;
    if (!userId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    scope.taskReadPending = true;
    setLoading(true);

    const { data: pinnedData, error: pinnedError } = await supabase
      .from('pinned_tasks')
      .select('id, title, position')
      .eq('user_id', userId)
      .order('position', { ascending: true });

    if (!isCurrent()) return;
    if (pinnedError) {
      console.error('Error fetching pinned tasks for task list:', pinnedError);
    }

    const pinnedRows = normalizePinnedTaskRows(pinnedData as PinnedTaskRow[]);

    const { data: taskData, error: taskError } = await supabase
      .from('tasks')
      .select(
        'id, title, status, estimated_pomodoros, position, source_subtask_id'
      )
      .eq('user_id', userId)
      .eq('due_date', selectedDateKey)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });

    if (!isCurrent()) return;
    if (taskError) {
      console.error('Error fetching tasks:', taskError);
      scope.taskReadPending = false;
      setLoading(false);
      return;
    }

    let taskRows = normalizeTaskRows(taskData as TaskRow[]);
    const todayKey = format(new Date(), 'yyyy-MM-dd');
    const existingTitles = new Set(taskRows.map((task) => task.title));
    const pinnedToCreate = pinnedRows.filter(
      (pinnedTask) => !existingTitles.has(pinnedTask.title)
    );

    if (selectedDateKey >= todayKey && pinnedToCreate.length > 0) {
      const maxPosition =
        taskRows.length > 0
          ? Math.max(...taskRows.map((task) => task.position))
          : -1;

      const newTaskPayload = pinnedToCreate.map((pinnedTask, index) => ({
        user_id: userId,
        title: pinnedTask.title,
        due_date: selectedDateKey,
        status: 'todo' as const,
        position: maxPosition + 1 + index,
      }));

      const { data: insertedTasks, error: insertError } = await supabase
        .from('tasks')
        .insert(newTaskPayload)
        .select(
          'id, title, status, estimated_pomodoros, position, source_subtask_id'
        );

      if (!isCurrent()) return;
      if (insertError) {
        console.error('Error auto-creating pinned tasks:', insertError);
      } else {
        taskRows = [
          ...taskRows,
          ...normalizeTaskRows(insertedTasks as TaskRow[]),
        ];
      }
    }

    const sourceSubtaskIds = [
      ...new Set(
        taskRows.flatMap((task) =>
          task.source_subtask_id ? [task.source_subtask_id] : []
        )
      ),
    ];

    if (sourceSubtaskIds.length > 0) {
      const { data: parentData, error: parentError } = await supabase
        .from('long_term_subtasks')
        .select('id, long_term_tasks(title)')
        .in('id', sourceSubtaskIds);

      if (!isCurrent()) return;
      if (parentError) {
        console.error('Error fetching long-term task titles:', parentError);
      } else {
        const parentTitleBySubtaskId = new Map<string, string>();
        for (const row of (parentData ?? []) as SubtaskParentRow[]) {
          const relation = Array.isArray(row.long_term_tasks)
            ? row.long_term_tasks[0]
            : row.long_term_tasks;
          if (relation?.title) {
            parentTitleBySubtaskId.set(row.id, relation.title);
          }
        }

        taskRows = taskRows.map((task) => ({
          ...task,
          parentTitle: task.source_subtask_id
            ? parentTitleBySubtaskId.get(task.source_subtask_id)
            : undefined,
        }));
      }
    }

    const taskIds = taskRows.map((task) => task.id);
    const durationByTaskId = new Map<string, number>();

    if (taskIds.length > 0) {
      // RLS로 보이는 타인 세션(그룹/친구 조회 허용분)이 합산되지 않도록
      // 본인 세션으로 한정한다.
      const { data: sessions, error: sessionsError } = await supabase
        .from('study_sessions')
        .select('task_id, duration')
        .eq('user_id', userId)
        .in('task_id', taskIds);

      if (!isCurrent()) return;
      if (sessionsError) {
        console.error('Error fetching task study durations:', sessionsError);
      } else {
        (sessions as SessionDurationRow[] | null | undefined)?.forEach((row) => {
          if (!row.task_id) return;
          durationByTaskId.set(
            row.task_id,
            (durationByTaskId.get(row.task_id) ?? 0) + (row.duration ?? 0)
          );
        });
      }
    }

    scope.taskReadPending = false;
    setTasks(
      taskRows.map((task) => ({
        ...task,
        duration: durationByTaskId.get(task.id) ?? 0,
      }))
    );
    setLoading(false);
  }, [selectedDateKey, userId]);

  const beginMutation = (changesPins = false) => {
    const scope = scopeRef.current;
    if (!scope?.active) return null;
    // Reads already in flight cannot overwrite local changes. Realtime
    // refreshes during writes are deferred until all current writes settle.
    scope.taskRequest += 1;
    scope.refreshTasks ||= scope.taskReadPending;
    scope.taskReadPending = false;
    if (changesPins) {
      scope.pinnedRequest += 1;
      scope.refreshPinned = true;
    }
    scope.mutations += 1;
    setLoading(false);
    return scope;
  };

  const finishMutation = (scope: ReturnType<typeof createRequestScope>) => {
    if (!scope.active) return;
    scope.mutations -= 1;
    if (scope.mutations > 0) return;
    if (scope.refreshTasks) {
      scope.refreshTasks = false;
      void fetchTasks();
    }
    if (scope.refreshPinned) {
      scope.refreshPinned = false;
      void fetchPinnedTasks();
    }
  };

  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope?.active) return;
    const initialFetch = setTimeout(() => {
      if (!scope.active) return;
      void fetchTasks();
      void fetchPinnedTasks();
    }, 0);

    if (!userId) return () => clearTimeout(initialFetch);

    const taskChannel = supabase
      .channel('task-list-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          if (!scope.active) return;
          void fetchTasks();
        }
      )
      .subscribe();

    const sessionChannel = supabase
      .channel('task-list-session-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'study_sessions',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          if (!scope.active) return;
          void fetchTasks();
        }
      )
      .subscribe();

    return () => {
      clearTimeout(initialFetch);
      supabase.removeChannel(taskChannel);
      supabase.removeChannel(sessionChannel);
    };
  }, [fetchPinnedTasks, fetchTasks, userId]);

  const pinTaskFromTask = async (task: Task) => {
    if (!userId) return;
    const scope = beginMutation(true);
    if (!scope) return;

    try {
      const existingPinned = pinnedTasks.find(
        (pinnedTask) => pinnedTask.title === task.title
      );

      if (existingPinned) {
        const { error } = await supabase
          .from('pinned_tasks')
          .delete()
          .eq('id', existingPinned.id);

        if (!scope.active) return;
        if (error) throw error;

        setPinnedTasks((currentPinnedTasks) =>
          currentPinnedTasks.filter(
            (pinnedTask) => pinnedTask.id !== existingPinned.id
          )
        );
        return;
      }

      const maxPosition =
        pinnedTasks.length > 0
          ? Math.max(...pinnedTasks.map((pinnedTask) => pinnedTask.position))
          : -1;

      const { data, error } = await supabase
        .from('pinned_tasks')
        .insert({
          user_id: userId,
          title: task.title,
          position: maxPosition + 1,
        })
        .select('id, title, position')
        .single();

      if (!scope.active) return;
      if (error) throw error;

      const createdPinnedTask = normalizePinnedTaskRows([data as PinnedTaskRow])[0];
      setPinnedTasks((currentPinnedTasks) => [
        ...currentPinnedTasks,
        createdPinnedTask,
      ]);
    } catch (error) {
      if (scope.active) console.error('Error changing pinned task:', error);
    } finally {
      finishMutation(scope);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const oldIndex = tasks.findIndex((task) => task.id === active.id);
    const newIndex = tasks.findIndex((task) => task.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;
    const scope = beginMutation();
    if (!scope) return;

    const reorderedTasks = arrayMove(tasks, oldIndex, newIndex).map(
      (task, index) => ({
        ...task,
        position: index,
      })
    );

    setTasks(reorderedTasks);

    try {
      const results = await Promise.all(
        reorderedTasks.map((task) =>
          supabase.from('tasks').update({ position: task.position }).eq('id', task.id)
        )
      );
      if (!scope.active) return;
      const error = results.find((result) => result.error)?.error;
      if (error) throw error;
    } catch (error) {
      if (!scope.active) return;
      console.error('Error reordering tasks:', error);
      scope.refreshTasks = true;
    } finally {
      finishMutation(scope);
    }
  };

  const addTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newTaskTitle.trim()) return;
    if (!userId) {
      alert('작업을 추가하려면 로그인해주세요.');
      return;
    }
    const scope = beginMutation();
    if (!scope) return;

    const maxPosition =
      tasks.length > 0 ? Math.max(...tasks.map((task) => task.position)) : -1;

    try {
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          user_id: userId,
          title: newTaskTitle.trim(),
          due_date: selectedDateKey,
          status: 'todo',
          position: maxPosition + 1,
        })
        .select(
          'id, title, status, estimated_pomodoros, position, source_subtask_id'
        )
        .single();

      if (!scope.active) return;
      if (error) throw error;

      const createdTask = normalizeTaskRows([data as TaskRow])[0];
      setTasks((currentTasks) => [...currentTasks, { ...createdTask, duration: 0 }]);
      setNewTaskTitle('');
      setIsAdding(false);
    } catch (error) {
      if (scope.active) console.error('Error adding task:', error);
    } finally {
      finishMutation(scope);
    }
  };

  const toggleTaskStatus = async (task: Task) => {
    const scope = beginMutation();
    if (!scope) return;
    const nextStatus = task.status === 'done' ? 'todo' : 'done';
    setTasks((currentTasks) =>
      currentTasks.map((currentTask) =>
        currentTask.id === task.id
          ? { ...currentTask, status: nextStatus }
          : currentTask
      )
    );

    try {
      const { error } = await supabase
        .from('tasks')
        .update({ status: nextStatus })
        .eq('id', task.id);
      if (!scope.active) return;
      if (error) throw error;
    } catch (error) {
      if (!scope.active) return;
      console.error('Error updating task:', error);
      scope.refreshTasks = true;
    } finally {
      finishMutation(scope);
    }
  };

  const updateTask = async (taskId: string, title: string) => {
    const scope = beginMutation();
    if (!scope) return;
    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === taskId ? { ...task, title } : task
      )
    );

    try {
      const { error } = await supabase
        .from('tasks')
        .update({ title })
        .eq('id', taskId);
      if (!scope.active) return;
      if (error) throw error;
    } catch (error) {
      if (!scope.active) return;
      console.error('Error updating task:', error);
      scope.refreshTasks = true;
    } finally {
      finishMutation(scope);
    }
  };

  const confirmDelete = async () => {
    if (!deletingTaskId) return;
    const scope = beginMutation();
    if (!scope) return;

    const taskId = deletingTaskId;
    setTasks((currentTasks) =>
      currentTasks.filter((task) => task.id !== taskId)
    );

    try {
      const { error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', taskId);
      if (!scope.active) return;
      if (error) throw error;
    } catch (error) {
      if (!scope.active) return;
      console.error('Error deleting task:', error);
      scope.refreshTasks = true;
    } finally {
      finishMutation(scope);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-[300px] flex-1 space-y-3 overflow-y-auto">
        {loading && tasks.length === 0 ? (
          <div className="py-10 text-center text-gray-400">작업을 불러오는 중...</div>
        ) : tasks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-10 text-gray-400">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <span className="text-2xl">-</span>
            </div>
            <p>오늘은 작업이 없어요.</p>
            <button
              onClick={() => setIsAdding(true)}
              className="mt-4 text-sm font-medium text-rose-500 hover:text-rose-600"
            >
              + 첫 작업 추가하기
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={tasks.map((task) => task.id)}
              strategy={verticalListSortingStrategy}
            >
              {tasks.map((task) => (
                <SortableTaskItem
                  key={task.id}
                  task={task}
                  toggleTaskStatus={toggleTaskStatus}
                  deleteTask={(taskId) => setDeletingTaskId(taskId)}
                  updateTask={updateTask}
                  pinTask={pinTaskFromTask}
                  isPinned={pinnedTasks.some(
                    (pinnedTask) => pinnedTask.title === task.title
                  )}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      <div className="mt-6 border-t border-gray-100 pt-6 dark:border-gray-700">
        {isAdding ? (
          <form onSubmit={addTask} className="flex flex-col gap-3">
            <input
              type="text"
              value={newTaskTitle}
              onChange={(event) => setNewTaskTitle(event.target.value)}
              placeholder="작업 제목을 입력하세요"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-rose-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                className="rounded-xl px-4 py-2 text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                취소
              </button>
              <button
                type="submit"
                disabled={!newTaskTitle.trim()}
                className="rounded-xl bg-rose-500 px-6 py-2 font-bold text-white transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                추가
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-4 font-medium text-gray-400 transition-all hover:border-gray-300 hover:text-gray-600 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:text-gray-300"
          >
            <Plus className="h-5 w-5" />
            작업 추가
          </button>
        )}
      </div>

      <ConfirmModal
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={confirmDelete}
        title="작업 삭제"
        message="이 작업을 삭제할까요? 이 작업은 되돌릴 수 없습니다."
        confirmText="삭제"
        cancelText="취소"
        isDangerous={true}
      />
    </div>
  );
}
