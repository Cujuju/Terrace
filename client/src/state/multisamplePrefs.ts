import { clearPersistedChoice, persistedChoice } from './persistedChoice.ts';

export type MultisampleSetting = '4x' | 'off';

export const MULTISAMPLE_SETTINGS: readonly MultisampleSetting[] = ['4x', 'off'];

export const DEFAULT_MULTISAMPLE_SETTING: MultisampleSetting = '4x';

const MULTISAMPLE_STORAGE_KEY = 'terrace.multisample.v1';

const [multisampleSetting, setMultisampleSettingSignal] = persistedChoice<MultisampleSetting>(
  MULTISAMPLE_STORAGE_KEY,
  MULTISAMPLE_SETTINGS,
  DEFAULT_MULTISAMPLE_SETTING,
);

export { multisampleSetting };

export const setMultisampleSetting = setMultisampleSettingSignal;

export function multisampleEnabled(setting: MultisampleSetting): boolean {
  return setting === '4x';
}

export function resetMultisamplePrefs(): void {
  setMultisampleSettingSignal(DEFAULT_MULTISAMPLE_SETTING);
  clearPersistedChoice(MULTISAMPLE_STORAGE_KEY);
}
