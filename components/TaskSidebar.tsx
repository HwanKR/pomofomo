'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, ChevronDown, Circle } from 'lucide-react';
import type {
  LongTermSubtaskItem,
  LongTermTaskItem,
  TaskItem,
} from '@/components/timer/hooks/useTasks';
import { formatDuration } from '@/lib/formatDuration';

interface TaskSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: TaskItem[];
  weeklyPlans?: TaskItem[];
  monthlyPlans?: TaskItem[];
  longTermTasks?: LongTermTaskItem[];
  onSelectTask: (task: TaskItem | null) => void;
  onToggleTask: (task: TaskItem) => void;
  // 첫 선택 시 챕터가 오늘 할 일로 구체화되므로, 실제로 선택된 tasks 행을
  // (실패 시 null을) resolve하는 promise를 돌려줘야 한다.
  onSelectSubtask: (subtask: LongTermSubtaskItem) => Promise<TaskItem | null>;
  onToggleSubtask: (subtask: LongTermSubtaskItem) => void;
  pendingToggleSubtaskIds?: ReadonlySet<string>;
  selectedTaskId: string | null;
}

type SectionColor = 'rose' | 'indigo' | 'purple' | 'emerald';

const SECTION_STYLES: Record<
  SectionColor,
  { selected: string; check: string; badge: string }
> = {
  rose: {
    selected:
      'border-rose-100 bg-rose-50 text-rose-600 dark:border-rose-900/50 dark:bg-rose-900/20 dark:text-rose-400',
    check: 'text-rose-500',
    badge:
      'bg-rose-50 text-rose-500 dark:bg-rose-900/30',
  },
  indigo: {
    selected:
      'border-indigo-100 bg-indigo-50 text-indigo-600 dark:border-indigo-900/50 dark:bg-indigo-900/20 dark:text-indigo-400',
    check: 'text-indigo-500',
    badge:
      'bg-indigo-50 text-indigo-500 dark:bg-indigo-900/30',
  },
  purple: {
    selected:
      'border-purple-100 bg-purple-50 text-purple-600 dark:border-purple-900/50 dark:bg-purple-900/20 dark:text-purple-400',
    check: 'text-purple-500',
    badge:
      'bg-purple-50 text-purple-500 dark:bg-purple-900/30',
  },
  emerald: {
    selected:
      'border-emerald-100 bg-emerald-50 text-emerald-600 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-400',
    check: 'text-emerald-500',
    badge:
      'bg-emerald-50 text-emerald-500 dark:bg-emerald-900/30',
  },
};

const EMPTY_SUBTASK_IDS: ReadonlySet<string> = new Set();

// 미완료를 위로, 완료를 아래로. sort는 stable이라 나머지 순서는 보존된다.
const partitionDoneLast = <T,>(items: T[], isDone: (item: T) => boolean) =>
  [...items].sort((a, b) => Number(isDone(a)) - Number(isDone(b)));

function TaskSection({
  title,
  items,
  color,
  selectedTaskId,
  onSelectTask,
  onToggleTask,
}: {
  title: string;
  items: TaskItem[];
  color: SectionColor;
  selectedTaskId: string | null;
  onSelectTask: (task: TaskItem) => void;
  onToggleTask: (task: TaskItem) => void;
}) {
  if (items.length === 0) return null;

  const styles = SECTION_STYLES[color];

  return (
    <div className="space-y-2">
      <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-gray-400">
        {title}
      </h3>
      {partitionDoneLast(items, (task) => task.status === 'done').map((task) => {
        const isDone = task.status === 'done';
        const durationLabel = formatDuration(task.durationSeconds);
        return (
          <div
            key={task.id}
            className={`flex w-full items-center rounded-xl border pr-2 transition-all ${
              selectedTaskId === task.id
                ? styles.selected
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-slate-800/50'
            }`}
          >
            <button
              onClick={() => onToggleTask(task)}
              aria-label={isDone ? '완료 해제' : '완료로 표시'}
              className={`flex-shrink-0 p-2 pl-3 transition-colors ${
                isDone ? styles.check : 'text-gray-300 hover:text-gray-400'
              }`}
            >
              {isDone ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <Circle className="h-5 w-5" />
              )}
            </button>
            <button
              onClick={() => onSelectTask(task)}
              className={`min-w-0 flex-1 py-3 pl-1 pr-2 text-left text-sm font-medium ${
                isDone
                  ? 'text-gray-400 line-through dark:text-gray-500'
                  : selectedTaskId === task.id
                    ? ''
                    : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              <span className="block truncate">{task.title}</span>
              {task.parentTitle && (
                <span className="block truncate text-xs font-normal text-gray-400 dark:text-gray-500">
                  {task.parentTitle}
                </span>
              )}
            </button>
            {durationLabel && (
              <span
                className={`flex-shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold ${styles.badge}`}
              >
                {durationLabel}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function LongTermTaskSection({
  items,
  materializedSubtaskIds,
  pendingSubtaskId,
  pendingToggleSubtaskIds,
  onSelectSubtask,
  onToggleSubtask,
}: {
  items: LongTermTaskItem[];
  materializedSubtaskIds: Set<string>;
  pendingSubtaskId: string | null;
  pendingToggleSubtaskIds: ReadonlySet<string>;
  onSelectSubtask: (subtask: LongTermSubtaskItem) => void;
  onToggleSubtask: (subtask: LongTermSubtaskItem) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (items.length === 0) return null;

  const styles = SECTION_STYLES.emerald;

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      <h3 className="px-1 text-xs font-bold uppercase tracking-wider text-gray-400">
        장기 과제
      </h3>
      {items.map((task) => {
        const isExpanded = expandedIds.has(task.id);
        const hasSubtasks = task.subtasks.length > 0;
        const doneCount = task.subtasks.filter(
          (subtask) => subtask.completed_at !== null
        ).length;
        if (!hasSubtasks) {
          // 펼칠 내용이 없으면 디스클로저 대신 정적 행 + 빈 상태 문구를 보여준다.
          return (
            <div
              key={task.id}
              className="flex w-full items-center rounded-xl border border-transparent pr-2"
            >
              <span className="min-w-0 flex-1 py-3 pl-3 pr-2 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                <span className="block truncate">{task.title}</span>
              </span>
              <span className="flex-shrink-0 whitespace-nowrap px-2 py-1 text-xs font-normal text-gray-400 dark:text-gray-500">
                세부 할 일 없음
              </span>
            </div>
          );
        }
        return (
          <div key={task.id} className="space-y-2">
            <button
              onClick={() => toggleExpanded(task.id)}
              aria-expanded={isExpanded}
              className="flex w-full items-center rounded-xl border border-transparent pr-2 transition-all hover:bg-gray-50 dark:hover:bg-slate-800/50"
            >
              <span className="min-w-0 flex-1 py-3 pl-3 pr-2 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                <span className="block truncate">{task.title}</span>
              </span>
              <span
                className={`flex-shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold ${styles.badge}`}
              >
                {`완료 ${doneCount}/${task.subtasks.length}`}
              </span>
              <ChevronDown
                className={`ml-1 h-4 w-4 flex-shrink-0 text-gray-400 transition-transform ${
                  isExpanded ? 'rotate-180' : ''
                }`}
              />
            </button>
            {isExpanded && (
              <div className="ml-2 space-y-2">
                {partitionDoneLast(
                  task.subtasks,
                  (subtask) => subtask.completed_at !== null
                ).map((subtask) => {
                  const isDone = subtask.completed_at !== null;
                  const isPending = subtask.id === pendingSubtaskId;
                  const isTogglePending = pendingToggleSubtaskIds.has(
                    subtask.id
                  );
                  return (
                    <div
                      key={subtask.id}
                      className="flex w-full items-center rounded-xl border border-transparent pr-2 transition-all hover:bg-gray-50 dark:hover:bg-slate-800/50"
                    >
                      <button
                        onClick={() => onToggleSubtask(subtask)}
                        disabled={isTogglePending}
                        aria-busy={isTogglePending}
                        aria-label={isDone ? '완료 해제' : '완료로 표시'}
                        className={`flex-shrink-0 p-2 pl-3 transition-colors disabled:cursor-wait disabled:opacity-60 ${
                          isDone
                            ? styles.check
                            : 'text-gray-300 hover:text-gray-400'
                        }`}
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-5 w-5" />
                        ) : (
                          <Circle className="h-5 w-5" />
                        )}
                      </button>
                      {isDone ? (
                        <span className="min-w-0 flex-1 py-3 pl-1 pr-2 text-left text-sm font-medium text-gray-400 line-through dark:text-gray-500">
                          <span className="block truncate">{subtask.title}</span>
                        </span>
                      ) : (
                        <button
                          onClick={() => onSelectSubtask(subtask)}
                          disabled={isPending}
                          aria-busy={isPending}
                          className="min-w-0 flex-1 py-3 pl-1 pr-2 text-left text-sm font-medium text-gray-700 disabled:opacity-60 dark:text-gray-300"
                        >
                          <span className="block truncate">{subtask.title}</span>
                        </button>
                      )}
                      {materializedSubtaskIds.has(subtask.id) && (
                        <span
                          className={`flex-shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold ${SECTION_STYLES.rose.badge}`}
                        >
                          오늘
                        </span>
                      )}
                      {isPending && (
                        <span
                          aria-hidden
                          className="ml-1 h-4 w-4 flex-shrink-0 animate-spin rounded-full border-b-2 border-emerald-500"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function TaskSidebar({
  isOpen,
  onClose,
  tasks,
  weeklyPlans = [],
  monthlyPlans = [],
  longTermTasks = [],
  onSelectTask,
  onToggleTask,
  onSelectSubtask,
  onToggleSubtask,
  pendingToggleSubtaskIds = EMPTY_SUBTASK_IDS,
  selectedTaskId,
}: TaskSidebarProps) {
  const [pendingSubtaskId, setPendingSubtaskId] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectAndClose = (task: TaskItem | null) => {
    onSelectTask(task);
    onClose();
  };

  // 구체화가 끝나 tasks 행이 실제로 선택된 뒤에만 드로어를 닫는다.
  // 실패하면 드로어를 열어둔 채 에러 토스트를 띄운다.
  const selectSubtaskAndClose = async (subtask: LongTermSubtaskItem) => {
    if (pendingSubtaskId !== null) return;
    setPendingSubtaskId(subtask.id);
    try {
      let selected: TaskItem | null = null;
      try {
        selected = await onSelectSubtask(subtask);
      } catch (error) {
        console.error('Error selecting long-term subtask:', error);
      }
      if (selected) onClose();
      else toast.error('챕터를 오늘 할 일로 가져오지 못했어요. 다시 시도해주세요.');
    } finally {
      setPendingSubtaskId(null);
    }
  };

  // 오늘 이미 구체화된 챕터에 '오늘' 칩을 달기 위한 lookup.
  const materializedSubtaskIds = new Set(
    tasks.flatMap((task) => (task.sourceSubtaskId ? [task.sourceSubtaskId] : []))
  );

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="fixed right-0 top-0 z-50 h-full w-80 bg-white shadow-2xl transition-transform duration-300 ease-in-out dark:bg-gray-900">
        <div className="flex h-full flex-col p-6">
          <div className="mb-8 flex items-center justify-between">
            <h2 className="text-xl font-bold text-gray-800 dark:text-white">
              Task list
            </h2>
            <button
              onClick={onClose}
              className="rounded-full p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="h-6 w-6 text-gray-500"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto">
            <button
              onClick={() => selectAndClose(null)}
              className={`w-full rounded-xl px-4 py-3 text-left text-sm font-medium transition-all ${
                selectedTaskId === null
                  ? 'bg-gray-100 text-gray-900 ring-2 ring-gray-200 dark:bg-gray-800 dark:text-white dark:ring-gray-700'
                  : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800/50'
              }`}
            >
              Start without a task
            </button>

            <TaskSection
              title="Today"
              items={tasks}
              color="rose"
              selectedTaskId={selectedTaskId}
              onSelectTask={selectAndClose}
              onToggleTask={onToggleTask}
            />
            <TaskSection
              title="This week"
              items={weeklyPlans}
              color="indigo"
              selectedTaskId={selectedTaskId}
              onSelectTask={selectAndClose}
              onToggleTask={onToggleTask}
            />
            <TaskSection
              title="This month"
              items={monthlyPlans}
              color="purple"
              selectedTaskId={selectedTaskId}
              onSelectTask={selectAndClose}
              onToggleTask={onToggleTask}
            />
            <LongTermTaskSection
              items={longTermTasks}
              materializedSubtaskIds={materializedSubtaskIds}
              pendingSubtaskId={pendingSubtaskId}
              pendingToggleSubtaskIds={pendingToggleSubtaskIds}
              onSelectSubtask={(subtask) => {
                void selectSubtaskAndClose(subtask);
              }}
              onToggleSubtask={onToggleSubtask}
            />
          </div>
        </div>
      </div>
    </>
  );
}
