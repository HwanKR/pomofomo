import { supabase } from '@/lib/supabase';
import {
  GUEST_OWNER,
  getScopedStorageKey,
  getStorageOwner,
} from '@/lib/userScopedStorage';

export type Preset = {
  id: string;
  label: string;
  minutes: number;
};

export type FomopomoSettings = {
  pomoTime: number;
  shortBreak: number;
  longBreak: number;
  autoStartBreaks: boolean;
  autoStartPomos: boolean;
  longBreakInterval: number;
  volume: number;
  isMuted: boolean;
  taskPopupEnabled: boolean;
  seasonalEffectEnabled: boolean;
  tasks: string[];
  presets: Preset[];
};

type PartialFomopomoSettings = Partial<FomopomoSettings>;
type UserSettingsRecord = {
  settings?: PartialFomopomoSettings | null;
} | null;

export const SETTINGS_KEY = 'fomopomo_settings';

// Settings are stored per account: the legacy base key for guests, and
// `fomopomo_settings::<userId>` for authenticated users, so one account's
// local settings can never leak into another account on the same device.
export function getSettingsStorageKey(
  owner: string = getStorageOwner()
): string {
  return getScopedStorageKey(SETTINGS_KEY, owner);
}

export const SETTINGS_CHANGED_EVENT = 'settingsChanged';
export const DEFAULT_TASK_OPTIONS = ['국어', '수학', '영어'];
export const DEFAULT_FOMOPOMO_SETTINGS: FomopomoSettings = {
  pomoTime: 25,
  shortBreak: 5,
  longBreak: 15,
  autoStartBreaks: false,
  autoStartPomos: false,
  longBreakInterval: 4,
  volume: 50,
  isMuted: false,
  taskPopupEnabled: true,
  seasonalEffectEnabled: true,
  tasks: DEFAULT_TASK_OPTIONS,
  presets: [
    { id: '1', label: '집중', minutes: 25 },
    { id: '2', label: '집중', minutes: 50 },
    { id: '3', label: '집중', minutes: 90 },
  ],
};

let cachedOwner: string | null = null;
let cachedStorageKey: string | null = null;
let cachedRawSettings: string | null = null;
let cachedSettingsSnapshot: FomopomoSettings = DEFAULT_FOMOPOMO_SETTINGS;
let cachedSettingsParseFailed = false;
let cachedCorruptedRawSettings: string | null = null;

const cloneTasks = (tasks: string[]) => [...tasks];
const clonePresets = (presets: Preset[]) =>
  presets.map((preset) => ({ ...preset }));

// Bounds for the user-tunable numbers. Out-of-range values break the timer
// outright: pomoTime 0 completes the instant it starts (an alarm loop with
// auto-start on), longBreakInterval 0 makes `cycle % interval` NaN so the
// long break never arrives, and they can enter through a cleared input
// saved by an old client (Number('') === 0), corrupt localStorage, or a
// remote user_settings row written by anything.
const MAX_MINUTES = 999;
const MAX_LONG_BREAK_INTERVAL = 99;
const DEFAULT_PRESET_MINUTES = 25;

// Finite numbers are rounded and clamped into [min, max]; everything else
// (NaN, Infinity, strings, null, missing) recovers to the fallback.
const clampIntSetting = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

const getValidTasks = (
  tasks: string[] | null | undefined,
  fallback: string[]
): string[] => {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return cloneTasks(fallback);
  }

  return cloneTasks(tasks);
};

const getValidPresets = (
  presets: readonly (Preset | null | undefined)[] | null | undefined,
  fallback: Preset[]
): Preset[] => {
  if (!Array.isArray(presets) || presets.length === 0) {
    return clonePresets(fallback);
  }

  // Corrupt persisted data can hold null entries (JSON.stringify turns
  // undefined array slots into null); this runs inside useSyncExternalStore's
  // getSnapshot, so a throw here would crash the render. Drop them rather
  // than resurrect empty presets.
  const validPresets = presets.filter(
    (preset): preset is Preset => typeof preset === 'object' && preset !== null
  );
  if (validPresets.length === 0) {
    return clonePresets(fallback);
  }

  // Preset minutes feed setTimeLeft directly on click: same instant-complete
  // failure mode as pomoTime 0, same defense.
  return validPresets.map((preset) => ({
    ...preset,
    minutes: clampIntSetting(
      preset.minutes,
      DEFAULT_PRESET_MINUTES,
      1,
      MAX_MINUTES
    ),
  }));
};

export function normalizeSettings(
  rawSettings: PartialFomopomoSettings | null | undefined
): FomopomoSettings {
  const raw = rawSettings as
    | (PartialFomopomoSettings & { snowEnabled?: boolean })
    | null
    | undefined;

  return {
    ...DEFAULT_FOMOPOMO_SETTINGS,
    ...rawSettings,
    pomoTime: clampIntSetting(
      rawSettings?.pomoTime,
      DEFAULT_FOMOPOMO_SETTINGS.pomoTime,
      1,
      MAX_MINUTES
    ),
    shortBreak: clampIntSetting(
      rawSettings?.shortBreak,
      DEFAULT_FOMOPOMO_SETTINGS.shortBreak,
      1,
      MAX_MINUTES
    ),
    longBreak: clampIntSetting(
      rawSettings?.longBreak,
      DEFAULT_FOMOPOMO_SETTINGS.longBreak,
      1,
      MAX_MINUTES
    ),
    longBreakInterval: clampIntSetting(
      rawSettings?.longBreakInterval,
      DEFAULT_FOMOPOMO_SETTINGS.longBreakInterval,
      1,
      MAX_LONG_BREAK_INTERVAL
    ),
    volume: clampIntSetting(
      rawSettings?.volume,
      DEFAULT_FOMOPOMO_SETTINGS.volume,
      0,
      100
    ),
    taskPopupEnabled:
      raw?.taskPopupEnabled ?? DEFAULT_FOMOPOMO_SETTINGS.taskPopupEnabled,
    seasonalEffectEnabled:
      raw?.seasonalEffectEnabled ??
      raw?.snowEnabled ??
      DEFAULT_FOMOPOMO_SETTINGS.seasonalEffectEnabled,
    tasks: getValidTasks(rawSettings?.tasks, DEFAULT_FOMOPOMO_SETTINGS.tasks),
    presets: getValidPresets(
      rawSettings?.presets,
      DEFAULT_FOMOPOMO_SETTINGS.presets
    ),
  };
}

type StoredSettingsPayload = PartialFomopomoSettings & {
  ownerUserId?: unknown;
};

type ParsedStoredSettings = {
  settings: PartialFomopomoSettings;
  ownerStamp: unknown;
};

function parseStoredSettings(
  serializedSettings: string | null
): ParsedStoredSettings | null {
  if (!serializedSettings) {
    return null;
  }

  try {
    const { ownerUserId, ...settings } = JSON.parse(
      serializedSettings
    ) as StoredSettingsPayload;
    return { settings, ownerStamp: ownerUserId };
  } catch (error) {
    console.error('Failed to parse settings', error);
    return null;
  }
}

function readStoredSettingsRaw(owner: string) {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(getSettingsStorageKey(owner));
}

function cacheSettingsSnapshot(
  owner: string,
  storageKey: string,
  rawSettings: string | null,
  snapshot: FomopomoSettings,
  parseFailed: boolean
) {
  cachedOwner = owner;
  cachedStorageKey = storageKey;
  cachedRawSettings = rawSettings;
  cachedSettingsSnapshot = snapshot;
  cachedSettingsParseFailed = parseFailed;
  cachedCorruptedRawSettings = parseFailed ? rawSettings : null;
}

export function readSettingsSnapshot(): FomopomoSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_FOMOPOMO_SETTINGS;
  }

  const owner = getStorageOwner();
  const storageKey = getSettingsStorageKey(owner);
  const savedSettings = readStoredSettingsRaw(owner);

  if (
    owner === cachedOwner &&
    storageKey === cachedStorageKey &&
    savedSettings === cachedRawSettings &&
    (!cachedSettingsParseFailed || savedSettings === cachedCorruptedRawSettings)
  ) {
    return cachedSettingsSnapshot;
  }

  if (savedSettings === null) {
    cacheSettingsSnapshot(
      owner,
      storageKey,
      null,
      DEFAULT_FOMOPOMO_SETTINGS,
      false
    );
    return cachedSettingsSnapshot;
  }

  const parsedSettings = parseStoredSettings(savedSettings);
  if (!parsedSettings) {
    cacheSettingsSnapshot(
      owner,
      storageKey,
      savedSettings,
      DEFAULT_FOMOPOMO_SETTINGS,
      true
    );
    return cachedSettingsSnapshot;
  }

  // Validate the ownerUserId stamp: settings stamped for another owner are
  // dropped, and unstamped data is only trusted in the legacy guest namespace.
  const { settings, ownerStamp } = parsedSettings;
  if (
    (ownerStamp !== undefined && ownerStamp !== owner) ||
    (ownerStamp === undefined && owner !== GUEST_OWNER)
  ) {
    window.localStorage.removeItem(storageKey);
    cacheSettingsSnapshot(
      owner,
      storageKey,
      null,
      DEFAULT_FOMOPOMO_SETTINGS,
      false
    );
    return cachedSettingsSnapshot;
  }

  cacheSettingsSnapshot(
    owner,
    storageKey,
    savedSettings,
    normalizeSettings(settings),
    false
  );
  return cachedSettingsSnapshot;
}

type WriteSettingsSnapshotOptions = {
  allowCorruptedWrite?: boolean;
};

export function writeSettingsSnapshot(
  settings: FomopomoSettings,
  options: WriteSettingsSnapshotOptions = {}
): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const owner = getStorageOwner();
  const storageKey = getSettingsStorageKey(owner);
  const normalizedSettings = normalizeSettings(settings);
  const currentRawSettings = readStoredSettingsRaw(owner);

  if (
    owner !== cachedOwner ||
    storageKey !== cachedStorageKey ||
    currentRawSettings !== cachedRawSettings
  ) {
    readSettingsSnapshot();
  }

  const refreshedRawSettings = readStoredSettingsRaw(owner);
  const isCorruptedStorage =
    owner === cachedOwner &&
    storageKey === cachedStorageKey &&
    cachedSettingsParseFailed &&
    refreshedRawSettings !== null &&
    refreshedRawSettings === cachedCorruptedRawSettings;

  if (isCorruptedStorage && !options.allowCorruptedWrite) {
    cacheSettingsSnapshot(
      owner,
      storageKey,
      refreshedRawSettings,
      normalizedSettings,
      true
    );
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
    return false;
  }

  const payload: StoredSettingsPayload =
    owner === GUEST_OWNER
      ? normalizedSettings
      : { ...normalizedSettings, ownerUserId: owner };
  const serializedSettings = JSON.stringify(payload);

  try {
    window.localStorage.setItem(storageKey, serializedSettings);
  } catch (error) {
    console.error('Failed to persist settings locally', error);
    return false;
  }

  cacheSettingsSnapshot(
    owner,
    storageKey,
    serializedSettings,
    normalizedSettings,
    false
  );
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  return true;
}

export function restoreSettingsSnapshot(settings: FomopomoSettings): boolean {
  return writeSettingsSnapshot(settings, { allowCorruptedWrite: true });
}

export function resetSettingsSnapshot(): boolean {
  return restoreSettingsSnapshot(DEFAULT_FOMOPOMO_SETTINGS);
}

export function subscribeSettings(onStoreChange: () => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === getSettingsStorageKey()) {
      onStoreChange();
    }
  };
  const handleSettingsChange = () => onStoreChange();

  window.addEventListener('storage', handleStorageChange);
  window.addEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChange);

  return () => {
    window.removeEventListener('storage', handleStorageChange);
    window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSettingsChange);
  };
}

async function getAuthenticatedUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user?.id ?? null;
}

async function fetchRemoteSettings(userId: string) {
  const { data, error } = (await supabase
    .from('user_settings')
    .select('settings')
    .eq('user_id', userId)
    .single()) as { data: UserSettingsRecord; error?: { code?: string } | null };

  if (error && error.code !== 'PGRST116') {
    console.error('Failed to load settings', error);
  }

  return data?.settings ?? null;
}

export async function loadPersistedSettings(): Promise<FomopomoSettings> {
  try {
    const userId = await getAuthenticatedUserId();

    if (userId) {
      const remoteSettings = await fetchRemoteSettings(userId);
      if (remoteSettings) {
        const normalizedSettings = normalizeSettings(remoteSettings);
        restoreSettingsSnapshot(normalizedSettings);
        return normalizedSettings;
      }
    }
  } catch (error) {
    console.error('Failed to load settings', error);
  }

  return readSettingsSnapshot();
}

export async function loadTaskOptions(): Promise<string[]> {
  try {
    const userId = await getAuthenticatedUserId();

    if (userId) {
      const remoteSettings = await fetchRemoteSettings(userId);
      if (
        Array.isArray(remoteSettings?.tasks) &&
        remoteSettings.tasks.length > 0
      ) {
        return cloneTasks(remoteSettings.tasks);
      }
    }
  } catch (error) {
    console.error('Failed to load task options', error);
  }

  return getValidTasks(readSettingsSnapshot().tasks, DEFAULT_TASK_OPTIONS);
}

export async function persistSettings(settings: FomopomoSettings) {
  const normalizedSettings = normalizeSettings(settings);
  const wroteSnapshot = writeSettingsSnapshot(normalizedSettings);

  if (!wroteSnapshot) {
    return false;
  }

  try {
    const userId = await getAuthenticatedUserId();

    if (!userId) {
      return true;
    }

    const { error } = await supabase.from('user_settings').upsert({
      user_id: userId,
      settings: normalizedSettings,
    });

    if (error) {
      console.error('Failed to persist settings', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to persist settings', error);
    return false;
  }
}
