const PLAYER_NAME_STORAGE_KEY = 'playerName';
const PLAYER_DISPLAY_NAME_STORAGE_KEY = 'playerDisplayName';

export const readStoredName = (): string => {
  try {
    return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

export const readStoredDisplayName = (): string => {
  try {
    return localStorage.getItem(PLAYER_DISPLAY_NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

export const persistName = (value: string): void => {
  try {
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, value);
  } catch {
    // ignore
  }
};

export const persistDisplayName = (value: string): void => {
  try {
    localStorage.setItem(PLAYER_DISPLAY_NAME_STORAGE_KEY, value);
  } catch {
    // ignore
  }
};

