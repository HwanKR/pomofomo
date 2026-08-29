'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import toast from 'react-hot-toast';
import NotificationManager from './NotificationManager';
import ConfirmModal from './ConfirmModal';
import {
  DEFAULT_FOMOPOMO_SETTINGS,
  loadPersistedSettings,
  normalizeSettings,
  resetSettingsSnapshot,
  persistSettings as persistStoredSettings,
  type FomopomoSettings,
  type Preset,
} from './timer/hooks/settingsStore';
import { clearPendingSessionsForUser } from './timer/hooks/useStudySession';
import { getScopedStorageKey } from '@/lib/userScopedStorage';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
}

type ConflictPayload = {
  groups?: { name?: string | null }[];
  error?: string;
  message?: string;
};

// Form-side preset: minutes tolerates '' while the user is typing, exactly
// like the duration fields.
type PresetFormEntry = Omit<Preset, 'minutes'> & { minutes: number | '' };

export default function SettingsModal({
  isOpen,
  onClose,
  onSave,
}: SettingsModalProps) {
  const router = useRouter();
  // False until the load effect hydrates the form with the user's stored
  // settings. Every dismissal path saves, so persisting before hydration
  // would overwrite the stored settings with the untouched default form.
  const hydratedRef = useRef(false);
  // Duration fields tolerate '' while the user is typing (clearing a number
  // input would otherwise snap to 0); saving normalizes them back to numbers.
  const [pomoTime, setPomoTime] = useState<number | ''>(DEFAULT_FOMOPOMO_SETTINGS.pomoTime);
  const [shortBreak, setShortBreak] = useState<number | ''>(DEFAULT_FOMOPOMO_SETTINGS.shortBreak);
  const [longBreak, setLongBreak] = useState<number | ''>(DEFAULT_FOMOPOMO_SETTINGS.longBreak);
  const [autoStartBreaks, setAutoStartBreaks] = useState(
    DEFAULT_FOMOPOMO_SETTINGS.autoStartBreaks
  );
  const [autoStartPomos, setAutoStartPomos] = useState(
    DEFAULT_FOMOPOMO_SETTINGS.autoStartPomos
  );
  const [longBreakInterval, setLongBreakInterval] = useState<number | ''>(
    DEFAULT_FOMOPOMO_SETTINGS.longBreakInterval
  );
  const [volume, setVolume] = useState(DEFAULT_FOMOPOMO_SETTINGS.volume);
  const [isMuted, setIsMuted] = useState(DEFAULT_FOMOPOMO_SETTINGS.isMuted);
  const [taskPopupEnabled, setTaskPopupEnabled] = useState(
    DEFAULT_FOMOPOMO_SETTINGS.taskPopupEnabled
  );
  const [seasonalEffectEnabled, setSeasonalEffectEnabled] = useState(DEFAULT_FOMOPOMO_SETTINGS.seasonalEffectEnabled);
  const [tasks, setTasks] = useState<string[]>(DEFAULT_FOMOPOMO_SETTINGS.tasks);
  const [presets, setPresets] = useState<PresetFormEntry[]>(DEFAULT_FOMOPOMO_SETTINGS.presets);
  // The settings the form was last hydrated from (load, save, or reset).
  // Fields cleared at save time recover to these values — dismissing the
  // modal with an emptied field must restore what the user had, never
  // replace it with a global default.
  const [loadedSettings, setLoadedSettings] = useState<FomopomoSettings>(
    DEFAULT_FOMOPOMO_SETTINGS
  );
  const [isResetSettingsConfirmOpen, setIsResetSettingsConfirmOpen] = useState(false);
  const [isResetAccountConfirmOpen, setIsResetAccountConfirmOpen] = useState(false);
  const [isDeleteAccountConfirmOpen, setIsDeleteAccountConfirmOpen] = useState(false);

  const applySettingsToForm = useCallback((settings: FomopomoSettings) => {
    setLoadedSettings(settings);
    setPomoTime(settings.pomoTime);
    setShortBreak(settings.shortBreak);
    setLongBreak(settings.longBreak);
    setAutoStartBreaks(settings.autoStartBreaks);
    setAutoStartPomos(settings.autoStartPomos);
    setLongBreakInterval(settings.longBreakInterval);
    setVolume(settings.volume);
    setIsMuted(settings.isMuted);
    setTaskPopupEnabled(settings.taskPopupEnabled);
    setSeasonalEffectEnabled(settings.seasonalEffectEnabled);
    setTasks(settings.tasks);
    setPresets(settings.presets);
  }, []);

  // Normalizing here (not just inside persistSettings) keeps the UI honest:
  // handleSave writes these exact values back into the form, so what the
  // user sees is what got stored. Fields left cleared recover to the values
  // the form was hydrated with (a brand-new preset falls back to its
  // default); out-of-range numbers clamp.
  const buildSettingsFromForm = (): FomopomoSettings =>
    normalizeSettings({
      pomoTime: pomoTime === '' ? loadedSettings.pomoTime : pomoTime,
      shortBreak: shortBreak === '' ? loadedSettings.shortBreak : shortBreak,
      longBreak: longBreak === '' ? loadedSettings.longBreak : longBreak,
      autoStartBreaks,
      autoStartPomos,
      longBreakInterval:
        longBreakInterval === '' ? loadedSettings.longBreakInterval : longBreakInterval,
      volume,
      isMuted,
      taskPopupEnabled,
      seasonalEffectEnabled,
      tasks,
      presets: presets.map((preset) => ({
        ...preset,
        minutes:
          preset.minutes === ''
            ? loadedSettings.presets.find((p) => p.id === preset.id)?.minutes ??
              Number.NaN
            : preset.minutes,
      })),
    });

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // The cancellation flag keeps a slow load from clobbering the form after
    // the modal saved and closed — handleSave's write-back must stay the
    // last word on what the form (and the next open) shows.
    let cancelled = false;
    hydratedRef.current = false;
    const loadSettings = async () => {
      const persistedSettings = await loadPersistedSettings();
      if (!cancelled) {
        applySettingsToForm(persistedSettings);
        hydratedRef.current = true;
      }
    };

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [applySettingsToForm, isOpen]);

  const handleSave = async () => {
    if (!hydratedRef.current) {
      // The stored settings haven't reached the form yet — persisting now
      // would replace them with defaults. Dismiss without saving.
      onClose();
      return;
    }

    const settingsToSave = buildSettingsFromForm();
    // Reflect the normalized values in the form so the UI never disagrees
    // with what was stored (a cleared field shows its recovered default).
    applySettingsToForm(settingsToSave);
    const didPersist = await persistStoredSettings(settingsToSave);
    if (!didPersist) {
      toast.error('설정을 저장할 수 없습니다. 데이터를 복구하거나 초기화한 뒤 다시 시도해주세요.');
      return;
    }
    toast.success('설정이 저장되었습니다!');
    onSave();
    onClose();
  };

  const handleResetSettings = async () => {
    applySettingsToForm(DEFAULT_FOMOPOMO_SETTINGS);
    const didResetSnapshot = resetSettingsSnapshot();
    if (!didResetSnapshot) {
      toast.error('설정을 초기화할 수 없습니다.');
      return;
    }
    const didPersist = await persistStoredSettings(DEFAULT_FOMOPOMO_SETTINGS);
    if (!didPersist) {
      toast.error('설정을 기본값으로 저장할 수 없습니다. 다시 시도해주세요.');
      return;
    }
    toast.success('설정이 기본값으로 초기화되었습니다!');
    onSave();
    onClose();
  };

  const clearAccountLocalStorage = (userId?: string | null) => {
    [
      'fomopomo_settings',
      'fomopomo_pomoTime',
      'fomopomo_initialPomoTime',
      'fomopomo_stopwatchTime',
      'fomopomo_selectedTask',
      'fomopomo_selectedTaskId',
      'fomopomo_full_state',
      'fomopomo_task_state',
      'fomopomo_notification_dismissed',
      'fomopomo_changelog_last_viewed',
    ].forEach((key) => {
      localStorage.removeItem(key);
      // Authenticated state lives under user-scoped keys (`<base>::<uid>`).
      if (userId) {
        localStorage.removeItem(getScopedStorageKey(key, userId));
      }
    });
    // Drop the account's pending session drafts too, or outbox recovery would
    // re-insert study time the server-side reset/delete just erased.
    if (userId) {
      clearPendingSessionsForUser(userId);
    }
  };

  const getConflictMessage = (
    payload: ConflictPayload | null | undefined,
    actionLabel: string
  ) => {
    const groupNames = Array.isArray(payload?.groups)
      ? payload.groups
          .map((group) => group?.name)
          .filter((name: string | null | undefined): name is string =>
            typeof name === 'string' && name.length > 0
          )
      : [];

    if (groupNames.length > 0) {
      return `그룹장을 이양한 뒤에 ${actionLabel}할 수 있습니다.\n그룹: ${groupNames.join(', ')}`;
    }

    if (payload?.error === 'leader') {
      return `그룹장을 이양한 뒤에 ${actionLabel}할 수 있습니다.`;
    }

    if (typeof payload?.message === 'string' && payload.message.trim().length > 0) {
      return payload.message;
    }

    return null;
  };

  const handleResetAccount = async () => {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session?.user) {
      toast.error('로그인 상태가 아닙니다.');
      return;
    }

    const toastId = toast.loading('계정 초기화 중...');

    try {
      if (!session?.access_token) {
        toast.error('로그인 정보가 유효하지 않습니다.', { id: toastId });
        return;
      }

      const response = await fetch('/api/account-reset', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      const payload = (await response.json().catch(() => ({}))) as ConflictPayload;

      if (!response.ok) {
        if (response.status === 409) {
          const conflictMessage = getConflictMessage(payload, '초기화');
          if (conflictMessage) {
            toast.error(conflictMessage, { id: toastId, duration: 5000 });
            return;
          }
        }
        const errorMessage =
          (typeof payload?.message === 'string' && payload.message) ||
          (typeof payload?.error === 'string' && payload.error) ||
          '초기화 실패';
        toast.error(errorMessage, { id: toastId });
        return;
      }

      clearAccountLocalStorage(session.user.id);

      toast.success('계정 초기화 완료', { id: toastId });
      window.location.reload();
    } catch (e) {
      console.error('계정 초기화 오류:', e);
      toast.error('초기화 실패', { id: toastId });
    }
  };

  const handleDeleteAccount = async () => {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session?.user) {
      toast.error('로그인 상태가 아닙니다.');
      return;
    }

    const toastId = toast.loading('계정 삭제 중...');

    try {
      if (!session?.access_token) {
        toast.error('로그인 정보가 유효하지 않습니다.', { id: toastId });
        return;
      }

      const response = await fetch('/api/account-delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      const payload = (await response.json().catch(() => ({}))) as ConflictPayload;

      if (!response.ok) {
        if (response.status === 409) {
          const conflictMessage = getConflictMessage(payload, '탈퇴');
          if (conflictMessage) {
            toast.error(conflictMessage, { id: toastId, duration: 5000 });
            return;
          }
        }
        const errorMessage =
          (typeof payload?.message === 'string' && payload.message) ||
          (typeof payload?.error === 'string' && payload.error) ||
          '계정 삭제 실패';
        toast.error(errorMessage, { id: toastId });
        return;
      }

      clearAccountLocalStorage(session.user.id);

      toast.success('계정이 삭제되었습니다. 이용해 주셔서 감사합니다.', { id: toastId, duration: 3000 });

      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.error('로그아웃 실패:', error);
      }
      router.replace('/');
    } catch (e) {
      console.error('계정 삭제 오류:', e);
      toast.error('계정 삭제에 실패했습니다. 다시 시도해주세요.', { id: toastId });
    }
  };

  const addPreset = () => {
    if (presets.length >= 3) {
      toast.error('최대 3개까지만 가능합니다.');
      return;
    }
    setPresets([
      ...presets,
      { id: Date.now().toString(), label: '새 작업', minutes: 25 },
    ]);
  };

  const removePreset = (id: string) => {
    setPresets(presets.filter((p) => p.id !== id));
  };

  const addTask = () => {
    if (tasks.length >= 10) {
      toast.error('작업은 최대 10개까지만 저장할 수 있어요.');
      return;
    }
    setTasks([...tasks, '새 작업']);
  };

  const updateTask = (index: number, value: string) => {
    setTasks(tasks.map((task, i) => (i === index ? value : task)));
  };

  const removeTask = (index: number) => {
    setTasks(tasks.filter((_, i) => i !== index));
  };

  const updatePreset = (
    id: string,
    field: 'label' | 'minutes',
    value: string | number
  ) => {
    setPresets(
      presets.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  if (!isOpen) return null;

  const inputStyle =
    'w-full bg-gray-100 text-gray-700 p-2 rounded-lg font-medium focus:outline-none focus:ring-2 focus:ring-rose-200 transition-all text-sm';
  const toggleBase =
    'w-10 h-5 rounded-full relative transition-colors duration-200 ease-in-out cursor-pointer';
  const toggleDot =
    'absolute top-1 left-1 w-3 h-3 bg-white rounded-full shadow transform transition-transform duration-200 ease-in-out';

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-fade-in"
        onClick={handleSave}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-between items-center p-5 border-b border-gray-100">
            <h2 className="text-gray-500 font-bold tracking-widest text-sm flex items-center gap-2">
              ⚙️ 설정
            </h2>
            <button
              onClick={handleSave}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>

          <div className="p-6 overflow-y-auto space-y-8 scrollbar-hide">
            <section>
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-gray-400 text-xs font-bold flex items-center gap-2">
                  🗂️ 작업 목록
                </h3>
                <button
                  onClick={addTask}
                  className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded hover:bg-gray-200 transition-colors font-bold"
                >
                  + 추가
                </button>
              </div>
              <p className="text-[11px] text-gray-500 mb-2">
                여기서 정한 이름만 선택해서 저장되므로, Report에서 국어·수학처럼 일관된 항목으로 모아볼 수 있어요.
              </p>
              <div className="space-y-2">
                {tasks.map((task, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={task}
                      onChange={(e) => updateTask(index, e.target.value)}
                      className={`${inputStyle} flex-grow`}
                      placeholder="예: 국어"
                    />
                    <button
                      onClick={() => removeTask(index)}
                      className="text-gray-400 hover:text-red-500 p-2"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div className="text-[11px] text-gray-400">작업을 추가해주세요.</div>
                )}
              </div>
            </section>
            <hr className="border-gray-100" />
            <section>
              <div className="flex justify-between items-end mb-3">
                <h3 className="text-gray-400 text-xs font-bold flex items-center gap-2">
                  🔥 뽀모도로 프리셋 설정
                </h3>
                {presets.length < 3 && (
                  <button
                    onClick={addPreset}
                    className="text-xs bg-rose-100 text-rose-500 px-2 py-1 rounded hover:bg-rose-200 transition-colors font-bold"
                  >
                    + 추가
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {presets.map((preset) => (
                  <div key={preset.id} className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={preset.label}
                      onChange={(e) =>
                        updatePreset(preset.id, 'label', e.target.value)
                      }
                      className={`${inputStyle} flex-grow`}
                      placeholder="이름"
                    />
                    <input
                      type="number"
                      min={1}
                      value={preset.minutes}
                      onChange={(e) =>
                        updatePreset(
                          preset.id,
                          'minutes',
                          e.target.value === '' ? '' : Number(e.target.value)
                        )
                      }
                      className={`${inputStyle} w-20 text-center`}
                      placeholder="분"
                    />
                    <button
                      onClick={() => removePreset(preset.id)}
                      className="text-gray-400 hover:text-red-500 p-2"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
            </section>
            <hr className="border-gray-100" />
            <section>
              <h3 className="text-gray-400 text-xs font-bold mb-3">
                🕒 기본 시간 설정 (분)
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <span className="text-[10px] text-gray-400 mb-1 block">
                    집중
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={pomoTime}
                    onChange={(e) =>
                      setPomoTime(e.target.value === '' ? '' : Number(e.target.value))
                    }
                    className={inputStyle}
                  />
                </div>
                <div>
                  <span className="text-[10px] text-gray-400 mb-1 block">
                    짧은 휴식
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={shortBreak}
                    onChange={(e) =>
                      setShortBreak(e.target.value === '' ? '' : Number(e.target.value))
                    }
                    className={inputStyle}
                  />
                </div>
                <div>
                  <span className="text-[10px] text-gray-400 mb-1 block">
                    긴 휴식
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={longBreak}
                    onChange={(e) =>
                      setLongBreak(e.target.value === '' ? '' : Number(e.target.value))
                    }
                    className={inputStyle}
                  />
                </div>
              </div>
            </section>
            <section className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm font-medium">
                  휴식 자동 시작
                </span>
                <button
                  onClick={() => setAutoStartBreaks(!autoStartBreaks)}
                  className={`${toggleBase} ${autoStartBreaks ? 'bg-rose-400' : 'bg-gray-300'
                    }`}
                >
                  <span
                    className={`${toggleDot} ${autoStartBreaks ? 'translate-x-5' : 'translate-x-0'
                      }`}
                  ></span>
                </button>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-600 text-sm font-medium">
                  뽀모도로 자동 시작
                </span>
                <button
                  onClick={() => setAutoStartPomos(!autoStartPomos)}
                  className={`${toggleBase} ${autoStartPomos ? 'bg-rose-400' : 'bg-gray-300'
                    }`}
                >
                  <span
                    className={`${toggleDot} ${autoStartPomos ? 'translate-x-5' : 'translate-x-0'
                      }`}
                  ></span>
                </button>
              </div>
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-gray-600 text-sm font-medium">
                    저장 시 작업 메모 팝업
                  </span>
                  <p className="text-[11px] text-gray-400 mt-1">
                    작업 내용을 기록할지 물어보는 팝업입니다.
                  </p>
                </div>
                <button
                  onClick={() => setTaskPopupEnabled(!taskPopupEnabled)}
                  className={`${toggleBase} ${taskPopupEnabled ? 'bg-rose-400' : 'bg-gray-300'
                    }`}
                >
                  <span
                    className={`${toggleDot} ${taskPopupEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                  ></span>
                </button>
              </div>
              <div className="flex justify-between items-center pt-2">
                <span className="text-gray-600 text-sm font-medium">
                  긴 휴식 간격 (사이클)
                </span>
                <input
                  type="number"
                  min={1}
                  value={longBreakInterval}
                  onChange={(e) =>
                    setLongBreakInterval(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className="w-16 bg-gray-100 text-gray-700 p-1 rounded text-center font-bold focus:outline-none"
                />
              </div>
            </section>
            <hr className="border-gray-100" />

            {/* ✨ 소리 설정 (음소거 기능 추가) */}
            <section>
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-gray-400 text-xs font-bold">🔊 알림 소리</h3>

                {/* 음소거 토글 */}
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 text-xs font-bold">음소거</span>
                  <button
                    onClick={() => setIsMuted(!isMuted)}
                    className={`${toggleBase} w-8 h-4 ${isMuted ? 'bg-gray-600' : 'bg-gray-300'
                      }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow transform transition-transform duration-200 ${isMuted ? 'translate-x-4' : 'translate-x-0'
                        }`}
                    ></span>
                  </button>
                </div>
              </div>

              {/* 음소거면 슬라이더 비활성화 효과 */}
              <div
                className={`transition-opacity duration-200 ${isMuted ? 'opacity-40 pointer-events-none' : 'opacity-100'
                  }`}
              >
                <div className="flex justify-between mb-1">
                  <span className="text-gray-500 text-xs">볼륨</span>
                  <span className="text-gray-400 text-xs font-mono">
                    {volume}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-rose-400"
                />
              </div>
            </section>

            <hr className="border-gray-100" />
            <section>
              <h3 className="text-gray-400 text-xs font-bold mb-3 flex items-center gap-2">
                🔔 알림 설정
              </h3>
              <NotificationManager mode="inline" />
            </section>

            {/* 🌸 계절 효과 (관리자: 이 섹션 삭제 가능) */}
            <hr className="border-gray-100" />
            <section className="space-y-3">
              {/* 벚꽃 효과 토글 */}
              <div className="flex justify-between items-center">
                <div>
                  <span className="text-gray-600 text-sm font-medium flex items-center gap-2">
                    🌸 벚꽃 효과
                  </span>
                  <p className="text-[11px] text-gray-400 mt-1">
                    화면에 벚꽃이 흩날려요
                  </p>
                </div>
                <button
                  onClick={() => setSeasonalEffectEnabled(!seasonalEffectEnabled)}
                  className={`${toggleBase} ${seasonalEffectEnabled ? 'bg-pink-400' : 'bg-gray-300'
                    }`}
                >
                  <span
                    className={`${toggleDot} ${seasonalEffectEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                  ></span>
                </button>
              </div>

            </section>

            <hr className="border-gray-100" />
            <section>
              <h3 className="text-red-400 text-xs font-bold mb-3 flex items-center gap-2">
                ⚠️ 계정 설정
              </h3>
              <div className="flex flex-col gap-3">
                <div className="flex gap-3">
                  <button
                    onClick={() => setIsResetSettingsConfirmOpen(true)}
                    className="flex-1 py-3 bg-orange-50 text-orange-600 rounded-lg text-xs font-bold hover:bg-orange-100 transition-colors border border-orange-100 text-center"
                  >
                    ↻ 설정 초기화
                  </button>
                  <button
                    onClick={() => setIsResetAccountConfirmOpen(true)}
                    className="flex-1 py-3 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors border border-red-100 text-center"
                  >
                    🗑️ 계정 초기화
                  </button>
                </div>
                <button
                  onClick={() => setIsDeleteAccountConfirmOpen(true)}
                  className="w-full py-3 bg-red-600 text-white rounded-lg text-xs font-bold hover:bg-red-700 transition-colors text-center"
                >
                  ⚠️ 계정 탈퇴 (복구 불가)
                </button>
              </div>
            </section>

            {/* ☕ 후원 섹션 */}
            <hr className="border-gray-100" />
            <section>
              <h3 className="text-gray-400 text-xs font-bold mb-3 flex items-center gap-2">
                ☕ 후원
              </h3>
              <p className="text-xs text-gray-500 mb-3">
                서비스가 마음에 드셨다면, 커피 한 잔으로 응원해주세요!
              </p>
              <a
                href="/support"
                className="flex items-center justify-center gap-2 w-full py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-700 text-sm font-medium rounded-lg transition-colors border border-amber-200"
              >
                후원하기 →
              </a>
            </section>
          </div>
          <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end">
            <button
              onClick={handleSave}
              className="px-6 py-3 bg-gray-800 text-white font-bold rounded-xl hover:bg-gray-900 transition-colors shadow-lg text-sm"
            >
              저장하기
            </button>
          </div>
        </div>
      </div>
      <ConfirmModal
        isOpen={isResetSettingsConfirmOpen}
        onClose={() => setIsResetSettingsConfirmOpen(false)}
        onConfirm={handleResetSettings}
        title="설정 초기화"
        message="모든 설정이 기본값으로 돌아갑니다. 계속하시겠습니까?"
        confirmText="초기화"
        cancelText="취소"
        isDangerous={true}
      />
      <ConfirmModal
        isOpen={isResetAccountConfirmOpen}
        onClose={() => setIsResetAccountConfirmOpen(false)}
        onConfirm={handleResetAccount}
        title="계정 초기화"
        message={(
          <div className="space-y-3 text-sm">
            <p>다음 데이터가 모두 초기화됩니다.</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>공부 기록/시간</li>
              <li>친구/친구 요청</li>
              <li>가입된 그룹 (자동 탈퇴, 혼자만 있는 그룹은 삭제)</li>
              <li>할 일/주간·월간 플랜</li>
              <li>설정/알림</li>
            </ul>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              다른 멤버가 있는 그룹의 그룹장은 이양 후에 초기화할 수 있으며, 이 작업은 복구할 수 없습니다.
            </p>
          </div>
        )}
        confirmText="초기화"
        cancelText="취소"
        isDangerous={true}
      />
      <ConfirmModal
        isOpen={isDeleteAccountConfirmOpen}
        onClose={() => setIsDeleteAccountConfirmOpen(false)}
        onConfirm={handleDeleteAccount}
        title="계정 탈퇴"
        message={(
          <div className="space-y-3 text-sm">
            <p>다음 데이터가 영구적으로 삭제됩니다.</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>공부 기록/시간</li>
              <li>친구/친구 요청</li>
              <li>가입된 그룹 (자동 탈퇴, 혼자만 있는 그룹은 삭제)</li>
              <li>할 일/주간·월간 플랜</li>
              <li>설정/알림</li>
            </ul>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              다른 멤버가 있는 그룹의 그룹장은 이양 후에 탈퇴할 수 있습니다.
            </p>
            <p className="text-xs text-rose-500 font-semibold">
              이 작업은 복구할 수 없습니다.
            </p>
          </div>
        )}
        confirmText="탈퇴"
        cancelText="취소"
        isDangerous={true}
      />
    </>
  );
}
