export type EmojiEffectKey =
  | 'laughing'
  | 'crying'
  | 'sweating'
  | 'uhoh'
  | 'thinking'
  | 'angry'
  | 'old_woman';

export interface EmojiOption {
  id: EmojiEffectKey;
  label: string;
  symbol: string;
}

export interface EmojiEffectEntry {
  id?: string;
  emoji: EmojiEffectKey;
  label: string;
  symbol: string;
  player: string;
  displayName?: string;
  timestamp?: { toMillis?: () => number };
}

export const EMOJI_OPTIONS: EmojiOption[] = [
  { id: 'old_woman', label: 'Old Maid nod', symbol: '👵' },
  { id: 'laughing', label: 'Laughing', symbol: '😂' },
  { id: 'crying', label: 'Crying', symbol: '😭' },
  { id: 'sweating', label: 'Sweating', symbol: '😅' },
  { id: 'uhoh', label: 'Uh oh', symbol: '🫠' },
  { id: 'thinking', label: 'Thinking', symbol: '🤔' },
  { id: 'angry', label: 'Angry', symbol: '😡' },
];
