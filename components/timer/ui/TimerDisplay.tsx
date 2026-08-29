import { Preset } from '../hooks/useSettings';
import { TimerMode } from '../hooks/useTimerLogic';
import { getThemeColors } from './ThemeBackground';

// Helper to format time
const formatTime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const formatPresetDuration = (minutes: number) => `${minutes}분`;

interface TimerDisplayProps {
  timerMode: TimerMode;
  timeLeft: number;
  isRunning: boolean;
  isSaving: boolean;
  cycleCount: number;
  longBreakInterval: number;
  presets: Preset[];
  showSaveButton: boolean;
  showResetButton: boolean;
  onToggleTimer: () => void;
  onResetTimer: () => void;
  onSaveTimer: () => void;
  onChangeMode: (mode: TimerMode) => void;
  onPresetClick: (minutes: number) => void;
  
  // Task UI Props
  selectedTaskId: string | null;
  selectedTaskTitle: string;
  onOpenTaskSidebar: () => void;
  onClearTask: (e: React.MouseEvent) => void;
}

export const TimerDisplay = ({
  timerMode,
  timeLeft,
  isRunning,
  isSaving,
  cycleCount,
  longBreakInterval,
  presets,
  showSaveButton,
  showResetButton,
  onToggleTimer,
  onResetTimer,
  onSaveTimer,
  onChangeMode,
  onPresetClick,
  selectedTaskId,
  selectedTaskTitle,
  onOpenTaskSidebar,
  onClearTask,
}: TimerDisplayProps) => {
  const themeColors = getThemeColors('timer', timerMode);
  
  const modeBtnBase = 'px-2 py-2 sm:px-5 sm:py-2 rounded-full text-xs sm:text-sm font-bold border-2 transition-all whitespace-nowrap flex-1 sm:flex-none';
  const modeBtnInactive = 'text-gray-400 border-transparent hover:bg-black/5 dark:hover:bg-white/5';

  return (
    <div className="text-center animate-fade-in w-full">
      <div className="flex justify-center gap-1 sm:gap-2 mb-6 w-full">
        <button
          onClick={() => onChangeMode('focus')}
          className={`${modeBtnBase} ${timerMode === 'focus' ? themeColors.modeBtnActive : modeBtnInactive}`}
        >
          뽀모도로
        </button>
        <button
          onClick={() => onChangeMode('shortBreak')}
          className={`${modeBtnBase} ${timerMode === 'shortBreak' ? themeColors.modeBtnActive : modeBtnInactive}`}
        >
          짧은 휴식
        </button>
        <button
          onClick={() => onChangeMode('longBreak')}
          className={`${modeBtnBase} ${timerMode === 'longBreak' ? themeColors.modeBtnActive : modeBtnInactive}`}
        >
          긴 휴식
        </button>
      </div>

      {/* Selected Task Display */}
      <div className="w-full max-w-xs mx-auto relative z-20 flex justify-center transition-all duration-300 mb-6 min-h-[24px]">
        <div
          onClick={onOpenTaskSidebar}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border border-rose-100 dark:border-rose-900/50 animate-fade-in cursor-pointer hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-colors"
        >
          <span className="text-sm font-medium max-w-[200px] truncate">
            {selectedTaskId ? selectedTaskTitle : '작업 지정 없음'}
          </span>
          {selectedTaskId && (
            <button
              onClick={onClearTask}
              className="p-0.5 hover:bg-rose-200 dark:hover:bg-rose-800 rounded-full transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className={`text-7xl sm:text-8xl font-bold mb-4 font-mono tracking-tighter transition-colors ${themeColors.textMain}`}>
        {formatTime(timeLeft)}
      </div>

      <div className="flex flex-wrap gap-2 justify-center mb-6">
        {presets && presets.map((preset) => (
          <button
            key={preset.id}
            onClick={() => onPresetClick(preset.minutes)}
            aria-label={`${preset.label} ${formatPresetDuration(preset.minutes)}`}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-white dark:bg-slate-700 text-gray-600 dark:text-gray-300 shadow-sm border border-gray-200 dark:border-slate-600 hover:border-rose-300 dark:hover:border-rose-500 hover:text-rose-500 transition-all active:scale-95 whitespace-nowrap"
          >
            <span className="flex items-center gap-1.5 sm:gap-2">
              <span>{preset.label}</span>
              <span className="text-xs font-bold text-gray-500 dark:text-gray-400">
                {formatPresetDuration(preset.minutes)}
              </span>
            </span>
          </button>
        ))}
      </div>

      {timerMode === 'focus' && (
        <div className="text-sm font-bold text-gray-400 dark:text-gray-500 mb-6 opacity-90 tracking-wider">
          사이클 {cycleCount} / {longBreakInterval}
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-4">
        <button
          onClick={onToggleTimer}
          className={`px-10 py-4 rounded-2xl font-bold text-lg text-white transition-all active:scale-95 shadow-lg ${themeColors.btnMain} dark:shadow-none min-w-[140px]`}
        >
          {isRunning ? '일시정지' : '시작'}
        </button>

        {showSaveButton && (
          <button
            onClick={onSaveTimer}
            disabled={isSaving}
            className="px-5 py-4 rounded-2xl font-bold text-white bg-gray-800 hover:bg-black disabled:opacity-60 disabled:cursor-not-allowed transition-all shadow-sm whitespace-nowrap"
          >
            저장
          </button>
        )}

        {showResetButton && (
          <button
            onClick={onResetTimer}
            className="p-4 rounded-2xl bg-white dark:bg-slate-700 text-gray-400 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-600 transition-all animate-fade-in shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};
