import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

import {
  DEFAULT_FOMOPOMO_SETTINGS,
  persistSettings as persistSettingsSnapshot,
  readSettingsSnapshot,
  subscribeSettings,
  type FomopomoSettings,
  type Preset as SettingsPreset,
  writeSettingsSnapshot,
} from './settingsStore';

export type Preset = SettingsPreset;
export type Settings = FomopomoSettings;

export const useSettings = (_settingsUpdated: number) => {
  void _settingsUpdated;

  const settings = useSyncExternalStore(
    subscribeSettings,
    readSettingsSnapshot,
    () => DEFAULT_FOMOPOMO_SETTINGS
  );

  const setSettings = useCallback((value: SetStateAction<Settings>) => {
    const currentSettings = readSettingsSnapshot();
    const nextSettings =
      typeof value === 'function'
        ? (value as (previousValue: Settings) => Settings)(currentSettings)
        : value;

    writeSettingsSnapshot(nextSettings);
  }, []);

  const persistSettings = useCallback(async (newSettings: Settings) => {
    return persistSettingsSnapshot(newSettings);
  }, []);

  return { settings, setSettings, persistSettings };
};
