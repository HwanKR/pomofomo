'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  GripVertical,
  Pencil,
  Plus,
  Target,
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
import { usePersistedState } from '@/hooks/usePersistedState';
import { supabase } from '@/lib/supabase';
import {
  toggleSubtaskCompletion,
  type LongTermSubtaskItem,
  type LongTermTaskItem,
  type LongTermTaskRow,
} from '@/lib/longTermTasks';
import { cn } from '@/lib/utils';

interface LongTermTasksProps {
  userId: string;
}

const TASK_SELECT = 'id, title, position';
const SUBTASK_SELECT = 'id, title, position, completed_at';

const normalizeTaskRows = (
  rows: LongTermTaskRow[] | null | undefined
): LongTermTaskItem[] =>
  (rows ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    position: row.position ?? 0,
    subtasks: (row.long_term_subtasks ?? [])
      .map((subtask) => ({ ...subtask, position: subtask.position ?? 0 }))
      .sort((a, b) => a.position - b.position),
  }));

export function computeReorderedSubtasks(
  subtasks: LongTermSubtaskItem[],
  activeId: string,
  overId: string
): LongTermSubtaskItem[] | null {
  if (activeId === overId) return null;

  const oldIndex = subtasks.findIndex((subtask) => subtask.id === activeId);
  const newIndex = subtasks.findIndex((subtask) => subtask.id === overId);
  if (oldIndex === -1 || newIndex === -1) return null;

  return arrayMove(subtasks, oldIndex, newIndex).map((subtask, index) => ({
    ...subtask,
    position: index,
  }));
}

export async function persistSubtaskPositions(
  subtasks: Array<Pick<LongTermSubtaskItem, 'id' | 'position'>>
): Promise<boolean> {
  try {
    const results = await Promise.all(
      subtasks.map((subtask) =>
        supabase
          .from('long_term_subtasks')
          .update({ position: subtask.position })
          .eq('id', subtask.id)
      )
    );

    const failed = results.find((result) => result.error);
    if (failed) {
      console.error('Error persisting subtask order:', failed.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error persisting subtask order:', error);
    return false;
  }
}

interface SortableSubtaskItemProps {
  subtask: LongTermSubtaskItem;
  isTogglePending: boolean;
  toggleSubtask: (subtask: LongTermSubtaskItem) => void;
  updateSubtask: (subtaskId: string, title: string) => void;
  deleteSubtask: (subtaskId: string) => void;
}

function SortableSubtaskItem({
  subtask,
  isTogglePending,
  toggleSubtask,
  updateSubtask,
  deleteSubtask,
}: SortableSubtaskItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(subtask.title);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: subtask.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
    opacity: isDragging ? 0.5 : 1,
  };

  const isCompleted = !!subtask.completed_at;

  const handleSave = () => {
    if (editedTitle.trim() && editedTitle.trim() !== subtask.title) {
      updateSubtask(subtask.id, editedTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditedTitle(subtask.title);
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
        'group flex items-center gap-2 rounded-lg border border-transparent bg-white p-2 transition-all hover:border-emerald-200 dark:bg-gray-900/50 dark:hover:border-emerald-800',
        isDragging &&
          'border-emerald-200 bg-white shadow-lg dark:border-emerald-900 dark:bg-gray-800'
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-300 hover:text-gray-500 active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </div>

      <button
        onClick={() => toggleSubtask(subtask)}
        disabled={isTogglePending}
        className={cn(
          'flex-shrink-0 transition-colors',
          isCompleted
            ? 'text-emerald-500'
            : 'text-gray-400 hover:text-emerald-400'
        )}
      >
        {isCompleted ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      {isEditing ? (
        <div className="flex flex-1 items-center gap-2">
          <input
            type="text"
            value={editedTitle}
            onChange={(event) => setEditedTitle(event.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            autoFocus
          />
          <button
            onClick={handleSave}
            className="rounded-lg p-1 text-green-500 transition-colors hover:bg-green-50 dark:hover:bg-green-900/30"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={handleCancel}
            className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <span
          className={cn(
            'flex-1 text-sm font-medium transition-all',
            isCompleted
              ? 'text-gray-400 line-through'
              : 'text-gray-700 dark:text-gray-200'
          )}
        >
          {subtask.title}
        </span>
      )}

      {!isEditing && subtask.completed_at ? (
        <span className="whitespace-nowrap text-xs text-gray-400">
          {format(new Date(subtask.completed_at), 'M월 d일')} 완료
        </span>
      ) : null}

      {!isEditing && (
        <button
          onClick={() => {
            // 실시간 갱신이나 실패 롤백으로 제목이 바뀌었을 수 있으므로
            // 편집을 열 때마다 현재 제목에서 초안을 다시 시작한다.
            setEditedTitle(subtask.title);
            setIsEditing(true);
          }}
          className="p-1.5 text-gray-400 transition-all hover:text-emerald-500 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}

      <button
        onClick={() => deleteSubtask(subtask.id)}
        className="p-1.5 text-gray-400 transition-all hover:text-red-500 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function LongTermTasks({ userId }: LongTermTasksProps) {
  const [tasks, setTasks] = useState<LongTermTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [isExpanded, setIsExpanded] = usePersistedState(
    'long_term_expanded',
    true
  );
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [deletingSubtaskId, setDeletingSubtaskId] = useState<string | null>(
    null
  );
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editedTitle, setEditedTitle] = useState('');
  const [addingSubtaskTaskId, setAddingSubtaskTaskId] = useState<string | null>(
    null
  );
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  // 요청 세대 번호. 늦게 도착한 이전 refetch 응답이 더 새로운 상태를
  // 덮어쓰지 못하도록 fetchTasks가 응답 적용 전에 최신 세대인지 확인한다.
  // 로컬 변경(생성·이름 변경·삭제·토글·정렬)을 커밋하는 쪽도 커밋 시점에
  // 세대를 올려 이미 진행 중이던 refetch를 무효화한다.
  const fetchEpochRef = useRef(0);
  // 세부 할 일별 완료 토글 직렬화: ref는 같은 틱의 재진입을 막고
  // state는 진행 중인 항목의 버튼을 비활성화한다.
  const pendingSubtaskIdsRef = useRef<Set<string>>(new Set());
  const [pendingSubtaskIds, setPendingSubtaskIds] = useState<Set<string>>(
    () => new Set()
  );

  // 소유자가 바뀌는 렌더에서 즉시 세대를 올리고 목록을 비워, 이전 사용자의
  // 진행 중 fetch가 새 사용자 화면에 낡은 데이터를 그리지 못하게 한다.
  const [ownerUserId, setOwnerUserId] = useState(userId);
  if (ownerUserId !== userId) {
    setOwnerUserId(userId);
    fetchEpochRef.current += 1;
    setTasks([]);
    setLoading(true);
  }

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchTasks = useCallback(async () => {
    const epoch = ++fetchEpochRef.current;

    if (!userId) {
      setTasks([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // v1은 보관되지 않은 장기 과제만 다룬다.
    const { data, error } = await supabase
      .from('long_term_tasks')
      .select(`${TASK_SELECT}, long_term_subtasks(${SUBTASK_SELECT})`)
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('position', { ascending: true });

    // 더 새로운 fetch나 로컬 변경 커밋이 세대를 올렸다면 이 응답은 이미 낡았다.
    if (epoch !== fetchEpochRef.current) return;

    if (error) {
      console.error('Error fetching long term tasks:', error);
      setLoading(false);
      return;
    }

    setTasks(normalizeTaskRows(data as LongTermTaskRow[]));
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    const initialFetch = setTimeout(() => {
      void fetchTasks();
    }, 0);

    const taskChannel = supabase
      .channel('long-term-task-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'long_term_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void fetchTasks();
        }
      )
      .subscribe();

    // 타이머 쪽 완료나 tasks.status 동기화 트리거가 갱신한 세부 할 일도
    // 플랜 화면에 즉시 반영되도록 별도 채널로 구독한다.
    const subtaskChannel = supabase
      .channel('long-term-subtask-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'long_term_subtasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void fetchTasks();
        }
      )
      .subscribe();

    return () => {
      clearTimeout(initialFetch);
      supabase.removeChannel(taskChannel);
      supabase.removeChannel(subtaskChannel);
    };
  }, [fetchTasks, userId]);

  const addTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newTaskTitle.trim()) return;
    if (!userId) {
      alert('장기 과제를 추가하려면 로그인해주세요.');
      return;
    }

    const maxPosition =
      tasks.length > 0 ? Math.max(...tasks.map((task) => task.position)) : -1;

    const { data, error } = await supabase
      .from('long_term_tasks')
      .insert({
        user_id: userId,
        title: newTaskTitle.trim(),
        position: maxPosition + 1,
      })
      .select(TASK_SELECT)
      .single();

    if (error) {
      console.error('Error adding long term task:', error);
      return;
    }

    const createdRow = data as Pick<
      LongTermTaskRow,
      'id' | 'title' | 'position'
    >;
    const createdTask = { ...createdRow, position: createdRow.position ?? 0 };
    // 진행 중인 이전 refetch가 방금 만든 과제를 지우지 못하게 세대를 올리고,
    // 실시간 refetch가 이미 반영했을 수 있으니 id 기준으로 업서트한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.some((task) => task.id === createdTask.id)
        ? currentTasks.map((task) =>
            task.id === createdTask.id ? { ...task, ...createdTask } : task
          )
        : [...currentTasks, { ...createdTask, subtasks: [] }]
    );
    setLoading(false);
    setNewTaskTitle('');
    setIsAdding(false);
  };

  const startEditing = (task: LongTermTaskItem) => {
    setEditingTaskId(task.id);
    setEditedTitle(task.title);
  };

  const cancelEditing = () => {
    setEditingTaskId(null);
    setEditedTitle('');
  };

  const updateTask = async () => {
    if (!editingTaskId || !editedTitle.trim()) {
      cancelEditing();
      return;
    }

    const nextTitle = editedTitle.trim();
    const originalTask = tasks.find((task) => task.id === editingTaskId);
    if (originalTask?.title === nextTitle) {
      cancelEditing();
      return;
    }

    const taskId = editingTaskId;
    // 이름 변경 전에 시작된 refetch가 커밋한 제목을 덮어쓰지 못하게 한다.
    // 세대가 오르면 그 refetch는 로딩도 못 끝내므로 여기서 로딩을 해제한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === taskId ? { ...task, title: nextTitle } : task
      )
    );
    setLoading(false);
    cancelEditing();

    const { error } = await supabase
      .from('long_term_tasks')
      .update({ title: nextTitle })
      .eq('id', taskId);

    if (error) {
      console.error('Error updating long term task:', error);
      void fetchTasks();
    }
  };

  const confirmDeleteTask = async () => {
    if (!deletingTaskId) return;

    const taskId = deletingTaskId;
    const { error } = await supabase
      .from('long_term_tasks')
      .delete()
      .eq('id', taskId);

    if (error) {
      console.error('Error deleting long term task:', error);
      return;
    }

    // 삭제 전에 시작된 refetch가 지운 과제를 되살리지 못하게 한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.filter((task) => task.id !== taskId)
    );
    setLoading(false);
  };

  const addSubtask = async (event: React.FormEvent, taskId: string) => {
    event.preventDefault();
    if (!newSubtaskTitle.trim()) return;
    if (!userId) {
      alert('세부 할 일을 추가하려면 로그인해주세요.');
      return;
    }

    const task = tasks.find((currentTask) => currentTask.id === taskId);
    if (!task) return;

    const maxPosition =
      task.subtasks.length > 0
        ? Math.max(...task.subtasks.map((subtask) => subtask.position))
        : -1;

    const { data, error } = await supabase
      .from('long_term_subtasks')
      .insert({
        user_id: userId,
        long_term_task_id: taskId,
        title: newSubtaskTitle.trim(),
        position: maxPosition + 1,
      })
      .select(SUBTASK_SELECT)
      .single();

    if (error) {
      console.error('Error adding long term subtask:', error);
      return;
    }

    const createdSubtask = data as LongTermSubtaskItem;
    // 과제 추가와 동일하게 세대를 올려 낡은 refetch를 무효화하고 업서트한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((currentTask) => {
        if (currentTask.id !== taskId) return currentTask;
        const exists = currentTask.subtasks.some(
          (subtask) => subtask.id === createdSubtask.id
        );
        return {
          ...currentTask,
          subtasks: exists
            ? currentTask.subtasks.map((subtask) =>
                subtask.id === createdSubtask.id
                  ? { ...subtask, ...createdSubtask }
                  : subtask
              )
            : [...currentTask.subtasks, createdSubtask],
        };
      })
    );
    setLoading(false);
    setNewSubtaskTitle('');
    setAddingSubtaskTaskId(null);
  };

  const toggleSubtask = async (subtask: LongTermSubtaskItem) => {
    const subtaskId = subtask.id;
    // 같은 세부 할 일의 토글은 직렬화한다. 진행 중이면 이후 클릭은 무시되고
    // (버튼도 비활성화됨) 완료 후의 새 렌더에서 다시 토글할 수 있다.
    if (pendingSubtaskIdsRef.current.has(subtaskId)) return;
    pendingSubtaskIdsRef.current.add(subtaskId);
    setPendingSubtaskIds(new Set(pendingSubtaskIdsRef.current));

    const previousCompletedAt = subtask.completed_at;
    const nextCompletedAt = previousCompletedAt
      ? null
      : new Date().toISOString();

    // 토글 전에 시작된 refetch가 낙관적 완료 상태를 덮어쓰지 못하게 한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((task) => ({
        ...task,
        subtasks: task.subtasks.map((currentSubtask) =>
          currentSubtask.id === subtaskId
            ? { ...currentSubtask, completed_at: nextCompletedAt }
            : currentSubtask
        ),
      }))
    );
    setLoading(false);

    try {
      // 헬퍼가 풀 갱신에 이어 오늘 구체화된 일일 작업도 함께 동기화한다.
      // 낙관적으로 그린 값과 저장되는 값이 어긋나지 않도록 목표 상태를
      // 그대로 넘긴다.
      await toggleSubtaskCompletion(
        userId,
        { id: subtaskId, completed_at: previousCompletedAt },
        nextCompletedAt
      );
    } catch (error) {
      console.error('Error toggling subtask completion:', error);
      // 우리가 그린 낙관적 값이 아직 남아 있을 때만 되돌린다. 그 사이
      // refetch나 다른 갱신이 상태를 차지했다면 롤백이 그것을 덮으면 안 된다.
      setTasks((currentTasks) =>
        currentTasks.map((task) => ({
          ...task,
          subtasks: task.subtasks.map((currentSubtask) =>
            currentSubtask.id === subtaskId &&
            currentSubtask.completed_at === nextCompletedAt
              ? { ...currentSubtask, completed_at: previousCompletedAt }
              : currentSubtask
          ),
        }))
      );
      void fetchTasks();
    } finally {
      pendingSubtaskIdsRef.current.delete(subtaskId);
      setPendingSubtaskIds(new Set(pendingSubtaskIdsRef.current));
    }
  };

  const updateSubtask = async (subtaskId: string, title: string) => {
    // 이름 변경 전에 시작된 refetch가 커밋한 제목을 덮어쓰지 못하게 한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((task) => ({
        ...task,
        subtasks: task.subtasks.map((subtask) =>
          subtask.id === subtaskId ? { ...subtask, title } : subtask
        ),
      }))
    );
    setLoading(false);

    const { error } = await supabase
      .from('long_term_subtasks')
      .update({ title })
      .eq('id', subtaskId);

    if (error) {
      console.error('Error updating long term subtask:', error);
      void fetchTasks();
    }
  };

  const confirmDeleteSubtask = async () => {
    if (!deletingSubtaskId) return;

    const subtaskId = deletingSubtaskId;
    const { error } = await supabase
      .from('long_term_subtasks')
      .delete()
      .eq('id', subtaskId);

    if (error) {
      console.error('Error deleting long term subtask:', error);
      return;
    }

    // 삭제 전에 시작된 refetch가 지운 세부 할 일을 되살리지 못하게 한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((task) => ({
        ...task,
        subtasks: task.subtasks.filter((subtask) => subtask.id !== subtaskId),
      }))
    );
    setLoading(false);
  };

  const handleSubtaskDragEnd = async (taskId: string, event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) return;

    const task = tasks.find((currentTask) => currentTask.id === taskId);
    if (!task) return;

    const reorderedSubtasks = computeReorderedSubtasks(
      task.subtasks,
      String(active.id),
      String(over.id)
    );
    if (!reorderedSubtasks) return;

    // 드롭 전에 시작된 refetch가 커밋한 순서를 덮어쓰지 못하게 한다.
    fetchEpochRef.current += 1;
    setTasks((currentTasks) =>
      currentTasks.map((currentTask) =>
        currentTask.id === taskId
          ? { ...currentTask, subtasks: reorderedSubtasks }
          : currentTask
      )
    );
    setLoading(false);

    // 위치 쓰기가 하나라도 실패하면 일부만 반영됐을 수 있으므로 서버
    // 순서를 다시 읽어 낙관적 순서를 되돌린다.
    const persisted = await persistSubtaskPositions(reorderedSubtasks);
    if (!persisted) {
      void fetchTasks();
    }
  };

  const handleEditKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      void updateTask();
    } else if (event.key === 'Escape') {
      cancelEditing();
    }
  };

  return (
    <div className="flex flex-col rounded-2xl border border-gray-100 bg-white p-6 shadow-sm transition-all duration-300 dark:border-gray-700 dark:bg-gray-800">
      <div
        className="mb-6 flex cursor-pointer items-center justify-between lg:cursor-default"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Target className="h-5 w-5 text-emerald-500" />
            장기 과제
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            세부 할 일을 만들어 두고 매일 골라서 진행하세요.
          </p>
        </div>
        <div className="text-gray-400 lg:hidden">
          {isExpanded ? (
            <ChevronUp className="h-5 w-5" />
          ) : (
            <ChevronDown className="h-5 w-5" />
          )}
        </div>
      </div>

      <div
        className={cn(
          'flex flex-1 flex-col transition-all duration-300',
          !isExpanded && 'hidden lg:flex'
        )}
      >
        <div className="custom-scrollbar min-h-[100px] max-h-[480px] flex-1 space-y-3 overflow-y-auto">
          {loading ? (
            <div className="py-6 text-center text-gray-400">불러오는 중...</div>
          ) : tasks.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center py-6 text-gray-400">
              <p className="text-sm">아직 장기 과제가 없어요.</p>
              {!isAdding && (
                <button
                  onClick={() => setIsAdding(true)}
                  className="mt-2 text-sm font-medium text-emerald-500 hover:text-emerald-600"
                >
                  + 과제 추가
                </button>
              )}
            </div>
          ) : (
            tasks.map((task) => {
              const totalCount = task.subtasks.length;
              const completedCount = task.subtasks.filter(
                (subtask) => subtask.completed_at
              ).length;
              const progressPercent =
                totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

              return (
                <div
                  key={task.id}
                  className="rounded-xl border border-transparent bg-emerald-50 p-3 transition-all hover:border-emerald-200 dark:bg-emerald-900/20 dark:hover:border-emerald-800"
                >
                  <div className="group flex items-center gap-3">
                    {editingTaskId === task.id ? (
                      <div className="flex flex-1 items-center gap-2">
                        <input
                          type="text"
                          value={editedTitle}
                          onChange={(event) =>
                            setEditedTitle(event.target.value)
                          }
                          onKeyDown={handleEditKeyDown}
                          className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                          autoFocus
                        />
                        <button
                          onClick={() => void updateTask()}
                          className="rounded-lg p-1 text-green-500 transition-colors hover:bg-green-50 dark:hover:bg-green-900/30"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          onClick={cancelEditing}
                          className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <span className="flex-1 text-sm font-bold text-gray-700 dark:text-gray-200">
                        {task.title}
                      </span>
                    )}

                    {totalCount > 0 && (
                      <span className="whitespace-nowrap rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300">
                        {`${completedCount}/${totalCount}`}
                      </span>
                    )}

                    {editingTaskId !== task.id && (
                      <button
                        onClick={() => startEditing(task)}
                        className="p-1.5 text-gray-400 transition-all hover:text-emerald-500 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}

                    <button
                      onClick={() => setDeletingTaskId(task.id)}
                      className="p-1.5 text-gray-400 transition-all hover:text-red-500 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {totalCount > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  )}

                  {totalCount > 0 && (
                    <div className="mt-3 space-y-2">
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event) =>
                          void handleSubtaskDragEnd(task.id, event)
                        }
                      >
                        <SortableContext
                          items={task.subtasks.map((subtask) => subtask.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          {task.subtasks.map((subtask) => (
                            <SortableSubtaskItem
                              key={subtask.id}
                              subtask={subtask}
                              isTogglePending={pendingSubtaskIds.has(
                                subtask.id
                              )}
                              toggleSubtask={(currentSubtask) =>
                                void toggleSubtask(currentSubtask)
                              }
                              updateSubtask={(subtaskId, title) =>
                                void updateSubtask(subtaskId, title)
                              }
                              deleteSubtask={(subtaskId) =>
                                setDeletingSubtaskId(subtaskId)
                              }
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    </div>
                  )}

                  <div className="mt-3">
                    {addingSubtaskTaskId === task.id ? (
                      <form
                        onSubmit={(event) => void addSubtask(event, task.id)}
                        className="flex flex-col gap-2"
                      >
                        <input
                          type="text"
                          value={newSubtaskTitle}
                          onChange={(event) =>
                            setNewSubtaskTitle(event.target.value)
                          }
                          placeholder="세부 할 일을 입력하세요"
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setAddingSubtaskTaskId(null)}
                            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                          >
                            취소
                          </button>
                          <button
                            type="submit"
                            disabled={!newSubtaskTitle.trim()}
                            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-bold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            추가
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button
                        onClick={() => {
                          setAddingSubtaskTaskId(task.id);
                          setNewSubtaskTitle('');
                        }}
                        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-emerald-200 py-2 text-xs font-medium text-gray-400 transition-all hover:border-emerald-300 hover:text-emerald-500 dark:border-emerald-800 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        세부 할 일 추가
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
          {isAdding ? (
            <form onSubmit={addTask} className="flex flex-col gap-3">
              <input
                type="text"
                value={newTaskTitle}
                onChange={(event) => setNewTaskTitle(event.target.value)}
                placeholder="장기 과제를 입력하세요 (예: 빅데이터분석기사)"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="rounded-lg px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  취소
                </button>
                <button
                  type="submit"
                  disabled={!newTaskTitle.trim()}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  추가
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-3 text-sm font-medium text-gray-400 transition-all hover:border-emerald-200 hover:text-emerald-500 dark:border-gray-700 dark:hover:border-emerald-800 dark:hover:text-emerald-400"
            >
              <Plus className="h-4 w-4" />
              장기 과제 추가
            </button>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={confirmDeleteTask}
        title="장기 과제 삭제"
        message="이 장기 과제를 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다."
        confirmText="삭제"
        cancelText="취소"
        isDangerous={true}
      />

      <ConfirmModal
        isOpen={!!deletingSubtaskId}
        onClose={() => setDeletingSubtaskId(null)}
        onConfirm={confirmDeleteSubtask}
        title="세부 할 일 삭제"
        message="이 세부 할 일을 삭제할까요? 이미 만들어진 일일 작업과 공부 기록은 남습니다."
        confirmText="삭제"
        cancelText="취소"
        isDangerous={true}
      />
    </div>
  );
}
