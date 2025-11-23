import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';

if (!admin.apps.length) {
  admin.initializeApp();
}

export * from './models/highlow';

const db = admin.firestore();
if (typeof (db as FirebaseFirestore.Firestore & { settings?: (options: object) => void }).settings === 'function') {
  (db as FirebaseFirestore.Firestore & { settings: (options: object) => void }).settings({
    ignoreUndefinedProperties: true,
  });
}
const serverTimestamp = admin.firestore.FieldValue.serverTimestamp;

const REGION = 'us-east4';
const GAMES_COLLECTION = 'games';
const HIGH_LOW_DOC = 'highlow';
const SESSIONS_SUBCOLLECTION = 'sessions';
const CURRENT_SESSION_ID = 'current';
const OLD_MAID_DOC = 'oldmaid';
const OLD_MAID_CURRENT_SESSION_ID = 'current';
const TURN_TIMEOUT_SECONDS = 180;
const STALE_PLAYER_SECONDS = 3 * 60;
const WAITING_ROOM_PLAYER_SECONDS = 5 * 60;
const IDLE_WARNING_BUFFER_SECONDS = 30;
const STALE_GAME_SECONDS = 60 * 60;
const STALLED_ACTIVE_OLD_MAID_SECONDS = 5 * 60;
const SHUFFLE_LOCK_TTL_MS = 5_000;

type FirestoreTimestamp = FirebaseFirestore.Timestamp;
type TimestampLike = FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;

export type GuessChoice = 'higher' | 'lower';

export interface Card {
  rank: number; // 0 (Joker) .. 13 (King); Aces are low
  suit: 'hearts' | 'diamonds' | 'clubs' | 'spades' | 'joker';
  label: string; // e.g., "A♠", "Q♥", "10♦", "🃏"
}

export interface Player {
  name: string; // always lowercase
  displayName?: string; // optional casing for UI
  isActive: boolean;
  isOnline: boolean;
}

type PlayerWrite = Player;

type PlayerLastSeenMap<TTimestamp> = Record<string, TTimestamp>;

export interface TablePile {
  id: string;
  row: number;
  column: number;
  cards: Card[];
  isFaceUp: boolean;
}

type GameOutcome = 'players' | 'deck' | null;

export interface GameSession {
  id: string;
  players: Player[];
  deck: Card[];
  piles: TablePile[];
  turnIndex: number;
  turnStartedAt: FirestoreTimestamp;
  status: 'waiting' | 'active' | 'complete';
  settings: { acesHigh: false };
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
  playerLastSeen: PlayerLastSeenMap<FirestoreTimestamp>;
  outcome: GameOutcome;
}

export interface GuessResult {
  correct: boolean;
  drawnCard: Card;
  drawnCards: Card[];
  pileId: string;
  pileFaceUp: boolean;
  nextPlayer: string | null;
  remainingCards: number;
  outcome: GameOutcome;
}

type GameSessionRecord = Omit<GameSession, 'id'>;
type GameSessionWrite = Omit<
  GameSessionRecord,
  'players' | 'createdAt' | 'updatedAt' | 'playerLastSeen' | 'turnStartedAt'
> & {
  players: PlayerWrite[];
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  playerLastSeen: PlayerLastSeenMap<TimestampLike>;
  turnStartedAt: TimestampLike;
};

interface OldMaidPairRecord {
  cards: Card[];
}

interface OldMaidPlayer {
  name: string;
  displayName?: string;
  hand: Card[];
  discards: OldMaidPairRecord[];
  isOnline: boolean;
  isSafe: boolean;
  idleWarning?: boolean;
}

type OldMaidPlayerWrite = OldMaidPlayer;

type OldMaidSessionStatus = 'waiting' | 'active' | 'complete';

interface OldMaidSessionRecord {
  status: OldMaidSessionStatus;
  players: OldMaidPlayerWrite[];
  turnIndex: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  loser?: string | null;
  playerLastSeen?: PlayerLastSeenMap<TimestampLike>;
  shuffleLock?: { player: string; expiresAt: FirebaseFirestore.Timestamp };
}

export interface GameLogEntry {
  timestamp: FirestoreTimestamp | TimestampLike;
  message: string;
  type: 'guess' | 'turn' | 'connect' | 'disconnect' | 'system';
  player?: string;
}

type LogQueueEntry = { message: string; type: GameLogEntry['type']; player?: string };
type JoinOrCreateTransactionResponse = {
  action: 'created' | 'reset' | 'reconnected' | 'joined';
  logs: LogQueueEntry[];
};
type GuessTransactionResponse =
  | { success: true; result: GuessResult; logs: LogQueueEntry[] }
  | { success: false; error: string; logs: LogQueueEntry[] };
type PresenceTransactionResponse =
  | { success: true; logs: LogQueueEntry[] }
  | { success: false; error: string; logs: LogQueueEntry[] };

const SUITS: Array<{ suit: Exclude<Card['suit'], 'joker'>; symbol: string }> = [
  { suit: 'hearts', symbol: '♥' },
  { suit: 'diamonds', symbol: '♦' },
  { suit: 'clubs', symbol: '♣' },
  { suit: 'spades', symbol: '♠' },
];

const JOKER_CARD: Card = {
  rank: 0,
  suit: 'joker',
  label: '🃏',
};

const RANK_LABELS: Record<number, string> = {
  1: 'A',
  11: 'J',
  12: 'Q',
  13: 'K',
};

const rankToLabel = (rank: number): string => {
  if (RANK_LABELS[rank]) {
    return RANK_LABELS[rank];
  }
  return rank.toString();
};

const GRID_ROWS = 3;
const GRID_COLUMNS = 3;
const TOTAL_PILES = GRID_ROWS * GRID_COLUMNS;

const HIGHLOW_EMOJI_EFFECTS = {
  thumbs_up: { label: 'Thumbs up', symbol: '👍' },
  high_five: { label: 'High five', symbol: '✋' },
  laughing: { label: 'Laughing', symbol: '😂' },
  crying: { label: 'Crying', symbol: '😭' },
  sweating: { label: 'Sweating', symbol: '😅' },
  uhoh: { label: 'Uh oh', symbol: '🫠' },
  higher: { label: 'Higher', symbol: '👆' },
  lower: { label: 'Lower', symbol: '👇' },
} as const;

const OLD_MAID_EMOJI_EFFECTS = {
  old_woman: { label: 'Old Maid', symbol: '👵' },
  laughing: { label: 'Laughing', symbol: '😂' },
  crying: { label: 'Crying', symbol: '😭' },
  sweating: { label: 'Sweating', symbol: '😅' },
  uhoh: { label: 'Uh oh', symbol: '🫠' },
  thinking: { label: 'Thinking', symbol: '🤔' },
  angry: { label: 'Angry', symbol: '😡' },
  shuffle: { label: 'Shuffled', symbol: '🔀' },
} as const;

type HighLowEmojiEffectKey = keyof typeof HIGHLOW_EMOJI_EFFECTS;
type OldMaidEmojiEffectKey = keyof typeof OLD_MAID_EMOJI_EFFECTS;
type EmojiEffectKey = HighLowEmojiEffectKey | OldMaidEmojiEffectKey;

const hasHighLowEmojiEffect = (key: string): key is HighLowEmojiEffectKey =>
  Object.prototype.hasOwnProperty.call(HIGHLOW_EMOJI_EFFECTS, key);

const hasOldMaidEmojiEffect = (key: string): key is OldMaidEmojiEffectKey =>
  Object.prototype.hasOwnProperty.call(OLD_MAID_EMOJI_EFFECTS, key);

type OldMaidShuffleResult =
  | { success: true; displayName: string }
  | { success: false; error: string };

interface EmojiEffectEntry {
  emoji: EmojiEffectKey;
  label: string;
  symbol: string;
  player: string;
  displayName?: string;
  timestamp: TimestampLike;
}

export const generateDeck = (): Card[] => {
  const cards: Card[] = [];
  for (const { suit, symbol } of SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      cards.push({
        rank,
        suit,
        label: `${rankToLabel(rank)}${symbol}`,
      });
    }
  }
  return cards;
};

export const shuffle = <T>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const createInitialPilesState = () => {
  const shuffled = shuffle(generateDeck());
  const initialCards = shuffled.slice(0, TOTAL_PILES);
  const remainingDeck = shuffled.slice(TOTAL_PILES);
  const piles: TablePile[] = initialCards.map((card, index) => ({
    id: `pile-${index}`,
    row: Math.floor(index / GRID_COLUMNS),
    column: index % GRID_COLUMNS,
    cards: [card],
    isFaceUp: true,
  }));
  return { deck: remainingDeck, piles };
};

const compareCards = (previous: Card, next: Card): number => {
  if (next.rank > previous.rank) {
    return 1;
  }
  if (next.rank < previous.rank) {
    return -1;
  }
  return 0;
};

const evaluateGuess = (guess: GuessChoice, previous: Card, next: Card): boolean => {
  const comparison = compareCards(previous, next);
  if (comparison === 0) {
    return true;
  }
  return guess === 'higher' ? comparison > 0 : comparison < 0;
};

const normalizePlayerList = (players?: Player[] | PlayerWrite[]) => {
  let changed = false;
  const normalized = (players ?? []).map((player) => {
    const trimmed = (player.name ?? '').trim();
    const normalizedName = trimmed.toLowerCase();
    const displayName =
      (typeof player.displayName === 'string' && player.displayName.trim()) || trimmed || normalizedName;
    if (
      normalizedName !== player.name ||
      displayName !== (player.displayName ?? '') ||
      typeof player.isActive !== 'boolean' ||
      typeof player.isOnline !== 'boolean'
    ) {
      changed = true;
    }
    return {
      name: normalizedName,
      displayName,
      isActive: typeof player.isActive === 'boolean' ? player.isActive : true,
      isOnline: typeof player.isOnline === 'boolean' ? player.isOnline : true,
    };
  });
  return { players: normalized, changed };
};

const findPlayerIndex = (players: PlayerWrite[], playerName: string): number => {
  return players.findIndex((player) => player.name === playerName);
};

const findNextEligibleIndex = (
  players: PlayerWrite[],
  currentIndex: number,
  options?: { requireOnline?: boolean; seed?: number }
): number | null => {
  const requireOnline = options?.requireOnline ?? false;
  if (!players.length) {
    return null;
  }
  if (typeof options?.seed === 'number') {
    const seededIndex = options.seed % players.length;
    const player = players[seededIndex];
    if (player?.isActive && (!requireOnline || player.isOnline)) {
      return seededIndex;
    }
  }
  for (let offset = 1; offset <= players.length; offset += 1) {
    const candidate = (currentIndex + offset) % players.length;
    const player = players[candidate];
    if (!player) {
      continue;
    }
    const onlineOk = requireOnline ? player.isOnline : true;
    if (player.isActive && onlineOk) {
      return candidate;
    }
  }
  return null;
};

const ensureTurnIndex = (
  players: PlayerWrite[],
  preferredIndex: number | undefined,
  options?: { requireOnline?: boolean }
): number | null => {
  if (!players.length) {
    return null;
  }
  const normalizedIndex = typeof preferredIndex === 'number' ? preferredIndex % players.length : 0;
  if (normalizedIndex >= 0 && normalizedIndex < players.length) {
    const player = players[normalizedIndex];
    if (player?.isActive && (!options?.requireOnline || player.isOnline)) {
      return normalizedIndex;
    }
  }
  return findNextEligibleIndex(players, normalizedIndex, options);
};

const pruneStaleHighLowPlayers = (
  players: PlayerWrite[],
  lastSeenMap: PlayerLastSeenMap<TimestampLike> | undefined,
  nowSeconds: number
): { filtered: PlayerWrite[]; removed: string[] } => {
  if (!players.length) {
    return { filtered: [], removed: [] };
  }
  const filtered: PlayerWrite[] = [];
  const removed: string[] = [];
  players.forEach((player) => {
    const lastSeenSeconds = resolveLastSeenSeconds(lastSeenMap?.[player.name]);
    if (lastSeenSeconds == null) {
      removed.push(player.name);
      return;
    }
    const secondsAgo = nowSeconds - lastSeenSeconds;
    if (secondsAgo > STALE_PLAYER_SECONDS) {
      removed.push(player.name);
      return;
    }
    const updatedPlayer = { ...player, isOnline: secondsAgo <= STALE_PLAYER_SECONDS };
    filtered.push(updatedPlayer);
  });
  return { filtered, removed };
};

const prunePlayersInTransaction = (
  sessionRef: FirebaseFirestore.DocumentReference,
  transaction: FirebaseFirestore.Transaction,
  sessionData: GameSessionRecord,
  players: PlayerWrite[]
): { players: PlayerWrite[]; removed: string[] } => {
  const nowSeconds = admin.firestore.Timestamp.now().seconds;
  const { filtered, removed } = pruneStaleHighLowPlayers(players, sessionData.playerLastSeen, nowSeconds);
  if (removed.length) {
    const updatedLastSeen = { ...(sessionData.playerLastSeen ?? {}) };
    removed.forEach((name) => {
      delete updatedLastSeen[name];
    });
    transaction.update(sessionRef, {
      players: filtered,
      playerLastSeen: updatedLastSeen,
      updatedAt: serverTimestamp(),
    });
    sessionData.playerLastSeen = updatedLastSeen;
  }
  return { players: filtered, removed };
};

const prunePlayersWithoutTransaction = async (
  sessionRef: FirebaseFirestore.DocumentReference,
  sessionData: GameSessionRecord,
  players: PlayerWrite[]
): Promise<{ players: PlayerWrite[]; removed: string[] }> => {
  const nowSeconds = admin.firestore.Timestamp.now().seconds;
  const { filtered, removed } = pruneStaleHighLowPlayers(players, sessionData.playerLastSeen, nowSeconds);
  if (removed.length) {
    const updatedLastSeen = { ...(sessionData.playerLastSeen ?? {}) };
    removed.forEach((name) => {
      delete updatedLastSeen[name];
    });
    await sessionRef.update({
      players: filtered,
      playerLastSeen: updatedLastSeen,
      updatedAt: serverTimestamp(),
    });
    sessionData.playerLastSeen = updatedLastSeen;
  }
  return { players: filtered, removed };
};

const refreshHighLowIfIdle = (
  sessionRef: FirebaseFirestore.DocumentReference,
  transaction: FirebaseFirestore.Transaction,
  sessionData: GameSessionRecord
) => {
  const nowTimestamp = admin.firestore.Timestamp.now();
  const updatedAtSeconds = getTimestampSeconds(sessionData.updatedAt as TimestampLike);
  if (updatedAtSeconds && nowTimestamp.seconds - updatedAtSeconds <= STALE_GAME_SECONDS) {
    return;
  }
  const { deck, piles } = createInitialPilesState();
  transaction.update(sessionRef, {
    players: [],
    playerLastSeen: {},
    deck,
    piles,
    turnIndex: 0,
    turnStartedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    status: 'waiting',
    outcome: null,
  });
  sessionData.players = [];
  sessionData.playerLastSeen = {};
  sessionData.deck = deck;
  sessionData.piles = piles;
  sessionData.turnIndex = 0;
  sessionData.turnStartedAt = nowTimestamp;
  sessionData.updatedAt = nowTimestamp;
  sessionData.status = 'waiting';
  sessionData.outcome = null;
};

const refreshOldMaidIfIdle = (
  sessionRef: FirebaseFirestore.DocumentReference,
  transaction: FirebaseFirestore.Transaction,
  sessionData: OldMaidSessionRecord
) => {
  const nowTimestamp = admin.firestore.Timestamp.now();
  const updatedAt = sessionData.updatedAt as TimestampLike | FirebaseFirestore.Timestamp | undefined;
  const updatedAtSeconds = getTimestampSeconds(updatedAt);
  const staleThreshold =
    sessionData.status === 'active' ? STALLED_ACTIVE_OLD_MAID_SECONDS : STALE_GAME_SECONDS;
  if (updatedAtSeconds && nowTimestamp.seconds - updatedAtSeconds <= staleThreshold) {
    return;
  }
  transaction.update(sessionRef, {
    status: 'waiting',
    players: [],
    turnIndex: 0,
    updatedAt: serverTimestamp(),
    loser: null,
    playerLastSeen: {},
  });
  sessionData.status = 'waiting';
  sessionData.players = [];
  sessionData.turnIndex = 0;
  sessionData.updatedAt = nowTimestamp;
  sessionData.loser = null;
  sessionData.playerLastSeen = {};
};

const pruneOldMaidPlayers = (
  players: OldMaidPlayerWrite[],
  lastSeenMap: PlayerLastSeenMap<TimestampLike> | undefined,
  staleThresholdSeconds: number
): { filtered: OldMaidPlayerWrite[]; removed: string[]; changed: boolean } => {
  if (!players.length) {
    return { filtered: [], removed: [], changed: false };
  }
  const nowSeconds = admin.firestore.Timestamp.now().seconds;
  const filtered: OldMaidPlayerWrite[] = [];
  const removed: string[] = [];
  const warningThresholdSeconds = Math.max(10, staleThresholdSeconds - IDLE_WARNING_BUFFER_SECONDS);
  let changed = false;
  players.forEach((player) => {
    const lastSeenSeconds = resolveLastSeenSeconds(lastSeenMap?.[player.name]);
    if (lastSeenSeconds == null || nowSeconds - lastSeenSeconds > staleThresholdSeconds) {
      removed.push(player.name);
      return;
    }
    const idleElapsed = lastSeenSeconds == null ? null : nowSeconds - lastSeenSeconds;
    const shouldWarn =
      idleElapsed != null &&
      idleElapsed >= warningThresholdSeconds &&
      idleElapsed <= staleThresholdSeconds;
    const existingWarning = Boolean(player.idleWarning);
    if (existingWarning !== shouldWarn) {
      changed = true;
    }
    filtered.push(shouldWarn === existingWarning ? player : { ...player, idleWarning: shouldWarn });
  });
  return { filtered, removed, changed };
};

const pruneOldMaidPlayersInTransaction = (
  sessionRef: FirebaseFirestore.DocumentReference,
  transaction: FirebaseFirestore.Transaction,
  sessionData: OldMaidSessionRecord
) => {
  const staleThreshold =
    sessionData.status === 'waiting' ? WAITING_ROOM_PLAYER_SECONDS : STALE_PLAYER_SECONDS;
  const { filtered, removed, changed } = pruneOldMaidPlayers(
    sessionData.players ?? [],
    sessionData.playerLastSeen,
    staleThreshold
  );
  if (!removed.length && !changed) {
    return 0;
  }
  const updatedLastSeen = { ...(sessionData.playerLastSeen ?? {}) };
  if (removed.length) {
    removed.forEach((name) => {
      delete updatedLastSeen[name];
    });
  }
  const updates: Partial<OldMaidSessionRecord> & {
    players: OldMaidPlayerWrite[];
    playerLastSeen: PlayerLastSeenMap<TimestampLike>;
  } = {
    players: filtered,
    playerLastSeen: updatedLastSeen,
    updatedAt: serverTimestamp(),
  };

  if (sessionData.status === 'active') {
    if (filtered.length <= 1) {
      updates.status = 'complete';
      updates.loser = filtered[0]?.name ?? null;
      updates.turnIndex = 0;
      sessionData.status = 'complete';
      sessionData.loser = filtered[0]?.name ?? null;
      sessionData.turnIndex = 0;
    } else if (sessionData.turnIndex >= filtered.length) {
      updates.turnIndex = sessionData.turnIndex % filtered.length;
      sessionData.turnIndex = updates.turnIndex;
    }
  } else if (!filtered.length && sessionData.turnIndex !== 0) {
    updates.turnIndex = 0;
    sessionData.turnIndex = 0;
  }

  transaction.update(sessionRef, updates);
  sessionData.players = filtered;
  sessionData.playerLastSeen = updatedLastSeen;
  return removed.length;
};

const updatePlayersIfChanged = async (
  sessionRef: FirebaseFirestore.DocumentReference,
  players: Player[] | PlayerWrite[],
  transaction?: FirebaseFirestore.Transaction
): Promise<PlayerWrite[]> => {
  const { players: normalized, changed } = normalizePlayerList(players);
  if (changed) {
    const updatePayload = { players: normalized, updatedAt: serverTimestamp() };
    if (transaction) {
      transaction.update(sessionRef, updatePayload);
    } else {
      await sessionRef.set(updatePayload, { merge: true });
    }
  }
  return normalized;
};

const resolveLastSeenSeconds = (entry?: TimestampLike): number | null => {
  if (!entry) {
    return null;
  }
  if (entry instanceof admin.firestore.Timestamp) {
    return entry.seconds;
  }
  return null;
};

const getTimestampSeconds = (value?: TimestampLike | FirebaseFirestore.Timestamp): number | null => {
  if (!value) {
    return null;
  }
  if (value instanceof admin.firestore.Timestamp) {
    return value.seconds;
  }
  return null;
};

export const logGameEvent = async (
  message: string,
  type: GameLogEntry['type'],
  player?: string
) => {
  const logsCollection = db
    .collection(GAMES_COLLECTION)
    .doc(HIGH_LOW_DOC)
    .collection(SESSIONS_SUBCOLLECTION)
    .doc(CURRENT_SESSION_ID)
    .collection('logs');
  const entry: GameLogEntry = {
    message,
    type,
    player,
    timestamp: serverTimestamp(),
  };
  await logsCollection.add(entry);
  functions.logger.info(`[${type}] ${message}`);
};

const writeLogEntry = async (entry: LogQueueEntry) => {
  try {
    await logGameEvent(entry.message, entry.type, entry.player);
  } catch (error) {
    functions.logger.error('Failed to persist game log entry', { entry, error });
  }
};

const flushLogEntries = async (entries: LogQueueEntry[]) => {
  for (const entry of entries) {
    await writeLogEntry(entry);
  }
};

const buildOldMaidBaseSession = (): OldMaidSessionRecord => ({
  status: 'waiting',
  players: [],
  turnIndex: 0,
  createdAt: serverTimestamp(),
  updatedAt: serverTimestamp(),
  loser: null,
  playerLastSeen: {},
});

const buildOldMaidDeck = (): Card[] => {
  const withoutQueenOfClubs = generateDeck().filter(
    (card) => !(card.rank === 12 && card.suit === 'clubs')
  );
  return shuffle([...withoutQueenOfClubs, { ...JOKER_CARD }]);
};

const resolveOldMaidPairs = (hand: Card[]): { remaining: Card[]; pairs: OldMaidPairRecord[] } => {
  const normalCards: Card[] = [];
  const remaining: Card[] = [];
  const pairs: OldMaidPairRecord[] = [];

  hand.forEach((card) => {
    if (card.suit === 'joker') {
      remaining.push(card);
    } else {
      normalCards.push(card);
    }
  });

  const byRank = normalCards.reduce((map, card) => {
    const existing = map.get(card.rank) ?? [];
    existing.push(card);
    map.set(card.rank, existing);
    return map;
  }, new Map<number, Card[]>());

  byRank.forEach((cards) => {
    const stack = [...cards];
    while (stack.length >= 2) {
      pairs.push({ cards: [stack.pop() as Card, stack.pop() as Card] });
    }
    if (stack.length === 1) {
      remaining.push(stack.pop() as Card);
    }
  });

  return { remaining, pairs };
};

const findNextPlayerWithCards = (players: OldMaidPlayerWrite[], startIndex: number): number | null => {
  if (!players.length) {
    return null;
  }
  for (let offset = 1; offset <= players.length; offset += 1) {
    const candidate = (startIndex + offset) % players.length;
    if (players[candidate]?.hand.length) {
      return candidate;
    }
  }
  return null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_ERROR_TOKENS = ['aborted', 'deadline-exceeded', 'deadlineexceeded', 'unavailable'];
const isRetryableFirestoreError = (error: unknown): boolean => {
  const code = (error as { code?: string })?.code?.toString().toLowerCase();
  if (code && RETRYABLE_ERROR_TOKENS.includes(code)) {
    return true;
  }
  const message = (error as Error)?.message?.toLowerCase() ?? '';
  return RETRYABLE_ERROR_TOKENS.some((token) => message.includes(token));
};

const executeWithRetries = async <T>(
  operation: () => Promise<T>,
  label: string,
  maxAttempts = 5
): Promise<T> => {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;
      const retryable = isRetryableFirestoreError(error);
      functions.logger.warn(`${label} attempt ${attempt} failed`, {
        attempt,
        maxAttempts,
        retryable,
        errorMessage: (error as Error)?.message,
      });
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(attempt * 50);
    }
  }
  throw lastError;
};

const sessionsCollection = () =>
  db.collection(GAMES_COLLECTION).doc(HIGH_LOW_DOC).collection(SESSIONS_SUBCOLLECTION);

const effectsCollection = () =>
  sessionsCollection().doc(CURRENT_SESSION_ID).collection('effects');

const oldMaidEffectsCollection = () =>
  oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID).collection('effects');

const oldMaidSessionsCollection = () =>
  db.collection(GAMES_COLLECTION).doc(OLD_MAID_DOC).collection(SESSIONS_SUBCOLLECTION);

interface CreateSessionRequest {
  playerName: string;
  displayName?: string;
}

interface JoinSessionRequest {
  sessionId: string;
  playerName: string;
  displayName?: string;
}

interface ErrorResponse {
  error: 'invalid_session';
}

interface JoinOrCreateSessionRequest {
  playerName: string;
  displayName?: string;
}

interface MakeGuessRequest {
  playerName: string;
  guess: GuessChoice;
  pileId: string;
}

interface ReportPresenceRequest {
  playerName: string;
  isOnline: boolean;
}

interface ResolveTurnRequest {
  playerName: string;
}

interface StartNewGameRequest {
  playerName: string;
}

const buildFreshSessionDocument = (playerName: string, displayName: string): GameSessionWrite => {
  const timestamp = serverTimestamp();
  const { deck, piles } = createInitialPilesState();
  return {
    players: [
      {
        name: playerName,
        displayName,
        isActive: true,
        isOnline: true,
      },
    ],
    deck,
    piles,
    turnIndex: 0,
    turnStartedAt: timestamp,
    status: 'waiting',
    settings: { acesHigh: false },
    playerLastSeen: {
      [playerName]: timestamp,
    },
    outcome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

export const createHighLowSession = functions
  .region(REGION)
  .https.onCall(async (data: CreateSessionRequest): Promise<{ sessionId: string }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();
    const displayName =
      typeof data?.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim()
        : rawName.trim() || playerName;

    functions.logger.info('Normalized player name for createHighLowSession', {
      provided: rawName,
      normalized: playerName,
    });

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    try {
      const sessionRef = await sessionsCollection().add(
        buildFreshSessionDocument(playerName, displayName)
      );

      functions.logger.info('Created High/Low session', { sessionId: sessionRef.id });

      return { sessionId: sessionRef.id };
    } catch (error) {
      functions.logger.error('Failed to create High/Low session', error);
      throw new functions.https.HttpsError('internal', 'Unable to create session');
    }
  });

export const joinHighLowSession = functions
  .region(REGION)
  .https.onCall(
    async (data: JoinSessionRequest): Promise<{ sessionId: string } | ErrorResponse> => {
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
      if (!sessionId) {
        throw new functions.https.HttpsError('invalid-argument', 'sessionId is required');
      }

      const rawPlayerName = typeof data?.playerName === 'string' ? data.playerName : '';
      const playerName = rawPlayerName.trim().toLowerCase();
      const displayName =
        typeof data?.displayName === 'string' && data.displayName.trim()
          ? data.displayName.trim()
          : rawPlayerName.trim() || playerName;

      functions.logger.info('Normalized player name for joinHighLowSession', {
        provided: rawPlayerName,
        normalized: playerName,
      });

      if (!playerName) {
        throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
      }

      const sessionRef = sessionsCollection().doc(sessionId.trim());

      try {
        const snap = await sessionRef.get();

        if (!snap.exists) {
          functions.logger.info('Join attempt: session not found', { sessionId });
          return { error: 'invalid_session' };
        }

        const sessionData = snap.data() as GameSessionRecord;
        let players = await updatePlayersIfChanged(sessionRef, sessionData.players);
        ({ players } = await prunePlayersWithoutTransaction(sessionRef, sessionData, players));

        if (sessionData.status !== 'waiting') {
          functions.logger.info('Join attempt: session not joinable', {
            sessionId,
            status: sessionData.status,
          });
          return { error: 'invalid_session' };
        }

        const now = serverTimestamp();
        const existingIndex = findPlayerIndex(players, playerName);

        if (existingIndex >= 0) {
          players[existingIndex].displayName = displayName;
          players[existingIndex].isOnline = true;
          await sessionRef.update({
            players,
            updatedAt: now,
            [`playerLastSeen.${playerName}`]: now,
          });
          await writeLogEntry({
            message: `${displayName} is already part of the session and came back online.`,
            type: 'connect',
            player: playerName,
          });
          functions.logger.info('Player already in session; refreshed presence', { sessionId, playerName });
          return { sessionId };
        }

        players.push({
          name: playerName,
          displayName,
          isActive: false,
          isOnline: true,
        });

        await sessionRef.update({
          players,
          updatedAt: now,
          [`playerLastSeen.${playerName}`]: now,
        });

        await writeLogEntry({
          message: `${displayName} joined the session.`,
          type: 'connect',
          player: playerName,
        });
        functions.logger.info('Player joined session', { sessionId, playerName });

        return { sessionId };
      } catch (error) {
        functions.logger.error('Failed to join High/Low session', { sessionId, error });
        throw new functions.https.HttpsError('internal', 'Unable to join session');
      }
    }
  );

export const joinOrCreateHighLowSession = functions
  .region(REGION)
  .https.onCall(async (data: JoinOrCreateSessionRequest): Promise<{ sessionId: string }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();
    const displayName =
      typeof data?.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim()
        : rawName.trim() || playerName;

    functions.logger.info('Normalized player name for joinOrCreateHighLowSession', {
      provided: rawName,
      normalized: playerName,
    });

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);

    try {
      const response = await executeWithRetries(
        () =>
          db.runTransaction<JoinOrCreateTransactionResponse>(async (transaction) => {
            const logs: LogQueueEntry[] = [];
            const snap = await transaction.get(sessionRef);
            if (!snap.exists) {
              transaction.set(sessionRef, buildFreshSessionDocument(playerName, displayName));
              logs.push({
                message: `New player ${displayName} created the session.`,
                type: 'system',
                player: playerName,
              });
              return { action: 'created' as const, logs };
            }

            const sessionData = snap.data() as GameSessionRecord;
            refreshHighLowIfIdle(sessionRef, transaction, sessionData);
            const now = serverTimestamp();

            if (!Array.isArray(sessionData.piles) || sessionData.piles.length !== TOTAL_PILES) {
              transaction.set(sessionRef, buildFreshSessionDocument(playerName, displayName));
              logs.push({
                message: `Session upgraded to the latest High/Low layout by ${displayName}. Waiting for players to join.`,
                type: 'system',
                player: playerName,
              });
              return { action: 'reset' as const, logs };
            }

            if (sessionData.status === 'complete') {
              transaction.set(sessionRef, buildFreshSessionDocument(playerName, displayName));
              logs.push({
                message: `Session reset by ${displayName}. Waiting for players to join.`,
                type: 'system',
                player: playerName,
              });
              return { action: 'reset' as const, logs };
            }

            let players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
            ({ players } = prunePlayersInTransaction(sessionRef, transaction, sessionData, players));
            const existingIndex = findPlayerIndex(players, playerName);

            if (existingIndex >= 0) {
              players[existingIndex].displayName = displayName;
              players[existingIndex].isOnline = true;
              transaction.update(sessionRef, {
                players,
                turnStartedAt: sessionData.turnStartedAt ?? now,
                updatedAt: now,
                [`playerLastSeen.${playerName}`]: now,
              });
              logs.push({
                message: `${displayName} came online.`,
                type: 'connect',
                player: playerName,
              });
              return { action: 'reconnected' as const, logs };
            }

            players.push({
              name: playerName,
              displayName,
              isActive: true,
              isOnline: true,
            });

            let turnIndex =
              ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: true }) ?? null;
            if (turnIndex === null) {
              const firstOnline = players.findIndex((player) => player.isActive && player.isOnline);
              turnIndex = firstOnline >= 0 ? firstOnline : 0;
            }

            transaction.update(sessionRef, {
              players,
              turnIndex,
              turnStartedAt: sessionData.turnStartedAt ?? now,
              updatedAt: now,
              [`playerLastSeen.${playerName}`]: now,
            });

            logs.push({
              message: `${displayName} joined the session.`,
              type: 'connect',
              player: playerName,
            });

            return { action: 'joined' as const, logs };
          }),
        'joinOrCreateHighLowSession.transaction'
      );

      await flushLogEntries(response.logs);

      functions.logger.info('joinOrCreateHighLowSession resolved', {
        sessionId: CURRENT_SESSION_ID,
        playerName,
        action: response.action,
      });

      return { sessionId: CURRENT_SESSION_ID };
    } catch (error) {
      const errorInfo =
        error instanceof Error
          ? { message: error.message, stack: error.stack, code: (error as { code?: string }).code }
          : { error };
      functions.logger.error('Failed to join or create shared session', errorInfo);
      throw new functions.https.HttpsError('internal', 'Unable to join shared session');
    }
  });

export const makeGuess = functions
  .region(REGION)
  .https.onCall(
    async (
      data: MakeGuessRequest
    ): Promise<{ success: true; result: GuessResult } | { success: false; error: string }> => {
      const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
      const guess = data?.guess;
      const pileId = typeof data?.pileId === 'string' ? data.pileId.trim() : '';

      if (guess !== 'higher' && guess !== 'lower') {
        throw new functions.https.HttpsError('invalid-argument', 'guess must be "higher" or "lower"');
      }
      if (!pileId) {
        throw new functions.https.HttpsError('invalid-argument', 'pileId is required');
      }

      const playerName = rawName.trim().toLowerCase();

      functions.logger.info('Normalized player name for makeGuess', {
        provided: rawName,
        normalized: playerName,
      });

      if (!playerName) {
        throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
      }

      const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);

      try {
        const response = await db.runTransaction<GuessTransactionResponse>(async (transaction) => {
          const logQueue: LogQueueEntry[] = [];
          const snap = await transaction.get(sessionRef);

          if (!snap.exists) {
            return { success: false, error: 'session_not_found', logs: logQueue } as const;
          }

            const sessionData = snap.data() as GameSessionRecord;
            refreshHighLowIfIdle(sessionRef, transaction, sessionData);

          if (sessionData.status === 'complete') {
            return { success: false, error: 'session_complete', logs: logQueue } as const;
          }

          let players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
          ({ players } = prunePlayersInTransaction(sessionRef, transaction, sessionData, players));

          if (!players.length) {
            return { success: false, error: 'no_players', logs: logQueue } as const;
          }

          const firstOnline = players.findIndex((player) => player.isActive && player.isOnline);
          let currentIndex =
            ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: true }) ?? null;
          if (currentIndex === null) {
            currentIndex =
              firstOnline >= 0
                ? firstOnline
                : ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: false });
          }

          if (currentIndex === null) {
            return { success: false, error: 'no_active_players', logs: logQueue } as const;
          }

          const currentPlayer = players[currentIndex];

          if (currentPlayer.name.toLowerCase() !== playerName.toLowerCase()) {
            return { success: false, error: 'not_your_turn', logs: logQueue } as const;
          }

          if (!currentPlayer.isActive) {
            return { success: false, error: 'player_inactive', logs: logQueue } as const;
          }

          if (!currentPlayer.isOnline) {
            return { success: false, error: 'player_offline', logs: logQueue } as const;
          }

          if (!Array.isArray(sessionData.piles) || !sessionData.piles.length) {
            return { success: false, error: 'no_piles', logs: logQueue } as const;
          }

          const piles = sessionData.piles.map((pile) => ({
            ...pile,
            cards: [...(pile.cards ?? [])],
          }));

          const pileIndex = piles.findIndex((pile) => pile.id === pileId);

          if (pileIndex === -1) {
            return { success: false, error: 'invalid_pile', logs: logQueue } as const;
          }

          const targetPile = piles[pileIndex];

          if (!targetPile.isFaceUp) {
            return { success: false, error: 'pile_locked', logs: logQueue } as const;
          }

          if (!targetPile.cards.length) {
            return { success: false, error: 'pile_empty', logs: logQueue } as const;
          }

          let deckState = [...sessionData.deck];

          if (!deckState.length) {
            return { success: false, error: 'deck_empty', logs: logQueue } as const;
          }

          const drawnCards: Card[] = [];
          let guessResolved = false;
          let correctGuess = true;
          let referenceCard = targetPile.cards[targetPile.cards.length - 1];

          while (!guessResolved) {
            if (!deckState.length) {
              break;
            }
            const [card, ...rest] = deckState;
            deckState = rest;
            drawnCards.push(card);

            const previousTop = referenceCard;
            targetPile.cards.push(card);
            referenceCard = card;

            const comparison = compareCards(previousTop, card);
            if (comparison === 0) {
              continue;
            }

            correctGuess = evaluateGuess(guess, previousTop, card);
            if (!correctGuess) {
              targetPile.isFaceUp = false;
            }
            guessResolved = true;
          }

          if (!guessResolved) {
            correctGuess = true;
          }

          let status: GameSessionRecord['status'] =
            sessionData.status === 'waiting' ? 'active' : sessionData.status;
          let outcome: GameOutcome = sessionData.outcome ?? null;

          const openPiles = piles.filter((pile) => pile.isFaceUp).length;
          const deckEmpty = deckState.length === 0;

          if (!guessResolved && deckEmpty) {
            if (openPiles > 0) {
              status = 'complete';
              outcome = 'players';
            } else {
              status = 'complete';
              outcome = 'deck';
            }
          } else {
            if (openPiles === 0) {
              status = 'complete';
              outcome = 'deck';
            } else if (deckEmpty) {
              status = 'complete';
              outcome = 'players';
            }
          }

          const nextIndex =
            findNextEligibleIndex(players, currentIndex, { requireOnline: true }) ?? currentIndex;

          const nextPlayerName = status === 'complete' ? null : players[nextIndex]?.name ?? null;

          const nextTurnTimestamp =
            status === 'complete'
              ? sessionData.turnStartedAt ?? serverTimestamp()
              : serverTimestamp();

          transaction.update(sessionRef, {
            players,
            piles,
            deck: deckState,
            turnIndex: nextIndex,
            status,
            outcome,
            turnStartedAt: nextTurnTimestamp,
            updatedAt: serverTimestamp(),
          });

          const displayName =
            currentPlayer.displayName && currentPlayer.displayName.trim()
              ? currentPlayer.displayName
              : currentPlayer.name;

          const pileLabel = `Pile ${pileIndex + 1}`;
          const finalCard =
            drawnCards[drawnCards.length - 1] ?? targetPile.cards[targetPile.cards.length - 1];

          logQueue.push({
            message: `${displayName} guessed ${guess} on ${pileLabel} and drew ${finalCard?.label ?? '—'} — ${
              correctGuess ? 'correct' : 'incorrect'
            }!`,
            type: 'guess',
            player: currentPlayer.name,
          });

          if (!targetPile.isFaceUp) {
            logQueue.push({
              message: `${pileLabel} locked for the rest of this game.`,
              type: 'system',
              player: currentPlayer.name,
            });
          }

          if (nextPlayerName && nextPlayerName !== currentPlayer.name) {
            const nextPlayer = players[nextIndex];
            logQueue.push({
              message: `Turn advanced to ${nextPlayer.displayName ?? nextPlayer.name}.`,
              type: 'turn',
              player: nextPlayer.name,
            });
          }

          if (status === 'complete' && outcome) {
            logQueue.push({
              message: outcome === 'players' ? 'Players defeated the deck!' : 'The deck wins this round.',
              type: 'system',
            });
          }

          functions.logger.info('makeGuess resolved', {
            playerName,
            pileId,
            guess,
            correctGuess,
            remainingCards: deckState.length,
            nextPlayer: nextPlayerName,
            status,
            outcome,
          });

          const result: GuessResult = {
            correct: correctGuess,
            drawnCard: finalCard,
            drawnCards,
            pileId: targetPile.id,
            pileFaceUp: targetPile.isFaceUp,
            nextPlayer: nextPlayerName,
            remainingCards: deckState.length,
            outcome: status === 'complete' ? outcome : null,
          };

          return { success: true, result, logs: logQueue } as const;
        });

        await flushLogEntries(response.logs);

        if (response.success) {
          return { success: true, result: response.result };
        }

        return { success: false, error: response.error };
      } catch (error) {
        functions.logger.error('Failed to resolve guess', { error });
        throw new functions.https.HttpsError('internal', 'Unable to process guess');
      }
    }
  );

export const reportPresence = functions
  .region(REGION)
  .https.onCall(
    async (
      data: ReportPresenceRequest
    ): Promise<{ success: true } | { success: false; error: string }> => {
      const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
      const playerName = rawName.trim().toLowerCase();
      const isOnline = Boolean(data?.isOnline);

      functions.logger.info('Normalized player name for reportPresence', {
        provided: rawName,
        normalized: playerName,
      });

      if (!playerName) {
        throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
      }

      const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);

      try {
        const result = await db.runTransaction<PresenceTransactionResponse>(async (transaction) => {
          const logs: LogQueueEntry[] = [];
          const snap = await transaction.get(sessionRef);

          if (!snap.exists) {
            return { success: false, error: 'session_not_found', logs } as const;
          }

          const sessionData = snap.data() as GameSessionRecord;
          refreshHighLowIfIdle(sessionRef, transaction, sessionData);
          refreshHighLowIfIdle(sessionRef, transaction, sessionData);
          let players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
          ({ players } = prunePlayersInTransaction(sessionRef, transaction, sessionData, players));
          const targetIndex = findPlayerIndex(players, playerName);

          if (targetIndex === -1) {
            return { success: false, error: 'player_not_found', logs } as const;
          }

          const now = serverTimestamp();
          const previouslyOnline = players[targetIndex].isOnline;

          if (previouslyOnline === isOnline) {
            transaction.update(sessionRef, {
              updatedAt: now,
              [`playerLastSeen.${playerName}`]: now,
            });
            return { success: true, logs } as const;
          }

          players[targetIndex].isOnline = isOnline;

          const previousTurnIndex = sessionData.turnIndex ?? 0;
          const firstOnlineIndex = players.findIndex((player) => player.isActive && player.isOnline);
          let turnIndex =
            ensureTurnIndex(players, previousTurnIndex, { requireOnline: true }) ?? null;
          if (turnIndex === null && firstOnlineIndex >= 0) {
            turnIndex = firstOnlineIndex;
          }
          if (turnIndex === null) {
            turnIndex = ensureTurnIndex(players, previousTurnIndex, { requireOnline: false }) ?? 0;
          }

          if (!isOnline && turnIndex === targetIndex) {
            const nextOnline = findNextEligibleIndex(players, turnIndex, {
              requireOnline: true,
              seed: targetIndex,
            });
            if (nextOnline !== null) {
              turnIndex = nextOnline;
              const nextPlayer = players[nextOnline];
              logs.push({
                message: `${
                  players[targetIndex].displayName ?? players[targetIndex].name
                } went offline; advancing turn to ${nextPlayer.displayName ?? nextPlayer.name}.`,
                type: 'turn',
                player: nextPlayer.name,
              });
            } else {
              logs.push({
                message: `${
                  players[targetIndex].displayName ?? players[targetIndex].name
                } went offline. Waiting for reconnection.`,
                type: 'disconnect',
                player: players[targetIndex].name,
              });
            }
          } else if (isOnline) {
            logs.push({
              message: `${players[targetIndex].displayName ?? players[targetIndex].name} came online.`,
              type: 'connect',
              player: players[targetIndex].name,
            });
            const corrected = ensureTurnIndex(players, turnIndex, { requireOnline: true });
            if (corrected !== null) {
              turnIndex = corrected;
            }
          }

          const turnStartUpdate = turnIndex !== previousTurnIndex ? now : sessionData.turnStartedAt ?? now;

          transaction.update(sessionRef, {
            players,
            turnIndex,
            turnStartedAt: turnStartUpdate,
            updatedAt: now,
            [`playerLastSeen.${playerName}`]: now,
          });

          return { success: true, logs } as const;
        });

        await flushLogEntries(result.logs);

        if (result.success) {
          return { success: true };
        }

        return { success: false, error: result.error };
      } catch (error) {
        functions.logger.error('Failed to update presence', { playerName, error });
        throw new functions.https.HttpsError('internal', 'Unable to report presence');
      }
    }
  );

export const resolveTurnHang = functions
  .region(REGION)
  .https.onCall(
    async (
      data: ResolveTurnRequest
    ): Promise<{ resolved: boolean; forfeited?: string | null; forfeitedLabel?: string | null }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);

    try {
      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { resolved: false } as const;
        }
        const sessionData = snap.data() as GameSessionRecord;
        if (sessionData.status === 'complete') {
          return { resolved: false } as const;
        }
        let players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
        ({ players } = prunePlayersInTransaction(sessionRef, transaction, sessionData, players));
        if (!players.length) {
          return { resolved: false } as const;
        }
        const preferredIndex =
          typeof sessionData.turnIndex === 'number' ? sessionData.turnIndex : 0;
        const hasEligibleOnline = players.some((player) => player.isActive && player.isOnline);
        let currentIndex: number | null =
          ensureTurnIndex(players, preferredIndex, { requireOnline: true }) ?? null;
        if (currentIndex === null && !hasEligibleOnline) {
          currentIndex =
            ensureTurnIndex(players, preferredIndex, { requireOnline: false }) ?? null;
        }

        if (currentIndex === null) {
          return { resolved: false } as const;
        }

        const currentPlayer = players[currentIndex];
        const turnStartedAt = sessionData.turnStartedAt as FirebaseFirestore.Timestamp | undefined;
        const nowTimestamp = admin.firestore.Timestamp.now();
        const timedOut =
          Boolean(turnStartedAt) &&
          nowTimestamp.seconds - (turnStartedAt as FirebaseFirestore.Timestamp).seconds > TURN_TIMEOUT_SECONDS;

        const shouldAdvance =
          !currentPlayer?.isActive || !currentPlayer.isOnline || timedOut;

        if (!shouldAdvance) {
          return { resolved: false } as const;
        }

        if (!hasEligibleOnline) {
          return { resolved: false } as const;
        }

        const nextOnline = findNextEligibleIndex(players, currentIndex, { requireOnline: true });

        if (nextOnline === null || nextOnline === currentIndex) {
          return { resolved: false } as const;
        }

        const now = serverTimestamp();
        transaction.update(sessionRef, {
          turnIndex: nextOnline,
          turnStartedAt: now,
          updatedAt: now,
        });

        return {
          resolved: true,
          forfeited: timedOut ? currentPlayer?.name ?? null : null,
          forfeitedLabel: timedOut
            ? currentPlayer?.displayName ?? currentPlayer?.name ?? null
            : null,
        } as const;
      });

      if (result.resolved) {
        if (result.forfeited) {
          await logGameEvent(
            `${result.forfeitedLabel ?? result.forfeited} forfeited their turn due to inactivity.`,
            'turn',
            result.forfeited
          );
        }
        functions.logger.info('resolveTurnHang advanced turn', {
          triggeredBy: playerName,
          forfeited: result.forfeited,
        });
      }

      return result;
    } catch (error) {
      functions.logger.error('Failed to resolve hanging turn', { error });
      throw new functions.https.HttpsError('internal', 'Unable to resolve turn state');
    }
  });

export const startNewHighLowSession = functions
  .region(REGION)
  .https.onCall(
    async (
      data: StartNewGameRequest
    ): Promise<{ success: true } | { success: false; error: string }> => {
      const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
      const playerName = rawName.trim().toLowerCase();

      functions.logger.info('Normalized player name for startNewHighLowSession', {
        provided: rawName,
        normalized: playerName,
      });

      if (!playerName) {
        throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
      }

      const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);
      const archiveCollection = db
        .collection(GAMES_COLLECTION)
        .doc(HIGH_LOW_DOC)
        .collection('archivedSessions');

      try {
        const result = await db.runTransaction(async (transaction) => {
          const snap = await transaction.get(sessionRef);
          if (!snap.exists) {
            return { success: false, error: 'session_not_found' } as const;
          }

          const sessionData = snap.data() as GameSessionRecord;
          if (sessionData.status !== 'complete') {
            return { success: false, error: 'game_not_complete' } as const;
          }

          const archiveDocRef = archiveCollection.doc(Date.now().toString());
          transaction.set(archiveDocRef, sessionData);

          let players = await updatePlayersIfChanged(sessionRef, sessionData.players ?? [], transaction);
          ({ players } = prunePlayersInTransaction(sessionRef, transaction, sessionData, players));

          const now = serverTimestamp();
          const { deck, piles } = createInitialPilesState();
          const preservedPlayers = players.map((player) => ({
            name: player.name,
            displayName: player.displayName,
            isActive: true,
            isOnline: player.isOnline ?? true,
          }));

          const refreshedLastSeen: PlayerLastSeenMap<TimestampLike> = preservedPlayers.reduce(
            (acc, player) => {
              acc[player.name] = now;
              return acc;
            },
            {} as PlayerLastSeenMap<TimestampLike>
          );

          transaction.set(sessionRef, {
            status: 'waiting',
            deck,
            piles,
            players: preservedPlayers,
            turnIndex: 0,
            turnStartedAt: now,
            createdAt: now,
            updatedAt: now,
            settings: { acesHigh: false },
            playerLastSeen: refreshedLastSeen,
            outcome: null,
          });

          return { success: true } as const;
        });

        if (result.success) {
          functions.logger.info('New High/Low game started', { startedBy: playerName });
        }

        return result;
      } catch (error) {
        functions.logger.error('Failed to start new High/Low session', { error });
        throw new functions.https.HttpsError('internal', 'Unable to start new game');
      }
    }
  );

export const cleanupHighLowPlayers = functions
  .region(REGION)
  .https.onCall(async (): Promise<{ removed: number }> => {
    const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);
    try {
      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { removed: 0 };
        }
        const sessionData = snap.data() as GameSessionRecord;
        refreshHighLowIfIdle(sessionRef, transaction, sessionData);
        const players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
        if (!players.length) {
          return { removed: 0 };
        }
        const nowSeconds = admin.firestore.Timestamp.now().seconds;
        const { filtered, removed } = pruneStaleHighLowPlayers(
          players,
          sessionData.playerLastSeen,
          nowSeconds
        );
        if (!removed.length) {
          return { removed: 0 };
        }
        const nextTurn =
          ensureTurnIndex(filtered, sessionData.turnIndex ?? 0, { requireOnline: true }) ??
          ensureTurnIndex(filtered, sessionData.turnIndex ?? 0, { requireOnline: false }) ??
          0;
        const updatedLastSeen = { ...(sessionData.playerLastSeen ?? {}) };
        removed.forEach((name) => {
          delete updatedLastSeen[name];
        });
        transaction.update(sessionRef, {
          players: filtered,
          playerLastSeen: updatedLastSeen,
          turnIndex: nextTurn,
          updatedAt: serverTimestamp(),
        });
        return { removed: removed.length };
      });
      return result;
    } catch (error) {
      functions.logger.error('Failed to cleanup High/Low players', { error });
      throw new functions.https.HttpsError('internal', 'Unable to cleanup High/Low session');
    }
  });

export const sendEmojiEffect = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string; emoji?: string }) => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const emojiKey = typeof data?.emoji === 'string' ? data.emoji.trim() : '';
    const playerName = rawName.trim().toLowerCase();

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    if (!emojiKey || !hasHighLowEmojiEffect(emojiKey)) {
      throw new functions.https.HttpsError('invalid-argument', 'emoji is invalid');
    }

    const sessionRef = sessionsCollection().doc(CURRENT_SESSION_ID);

    try {
      const snap = await sessionRef.get();
      if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Session not found');
      }

      const sessionData = snap.data() as GameSessionRecord;
      let players = await updatePlayersIfChanged(sessionRef, sessionData.players);
      ({ players } = await prunePlayersWithoutTransaction(sessionRef, sessionData, players));
      const playerRecord = players.find((player) => player.name === playerName);

      if (!playerRecord) {
        throw new functions.https.HttpsError('failed-precondition', 'player_not_in_session');
      }

      const effect = HIGHLOW_EMOJI_EFFECTS[emojiKey];
      const effectEntry: EmojiEffectEntry = {
        emoji: emojiKey,
        label: effect.label,
        symbol: effect.symbol,
        player: playerName,
        displayName:
          playerRecord.displayName && playerRecord.displayName.trim()
            ? playerRecord.displayName
            : playerRecord.name,
        timestamp: serverTimestamp(),
      };

      await effectsCollection().add(effectEntry);
      functions.logger.info('Emoji effect recorded', {
        emoji: emojiKey,
        playerName,
      });

      return { success: true };
    } catch (error) {
      functions.logger.error('Failed to send emoji effect', {
        error: error instanceof Error ? error.message : error,
        emoji: emojiKey,
        playerName,
      });
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError('internal', 'Failed to send emoji effect');
    }
  });

export const sendOldMaidEmojiEffect = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string; emoji?: string }) => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const emojiKey = typeof data?.emoji === 'string' ? data.emoji.trim() : '';
    const playerName = rawName.trim().toLowerCase();

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    if (!emojiKey || !hasOldMaidEmojiEffect(emojiKey)) {
      throw new functions.https.HttpsError('invalid-argument', 'emoji is invalid');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      const snap = await sessionRef.get();
      if (!snap.exists) {
        throw new functions.https.HttpsError('not-found', 'Session not found');
      }

      const sessionData = snap.data() as OldMaidSessionRecord;
      const playerRecord = sessionData.players.find((player) => player.name === playerName);

      if (!playerRecord) {
        throw new functions.https.HttpsError('failed-precondition', 'player_not_in_session');
      }

      const effect = OLD_MAID_EMOJI_EFFECTS[emojiKey];
      const effectEntry: EmojiEffectEntry = {
        emoji: emojiKey,
        label: effect.label,
        symbol: effect.symbol,
        player: playerName,
        displayName:
          playerRecord.displayName && playerRecord.displayName.trim()
            ? playerRecord.displayName
            : playerRecord.name,
        timestamp: serverTimestamp(),
      };

      await oldMaidEffectsCollection().add(effectEntry);
      functions.logger.info('Old Maid emoji effect recorded', {
        emoji: emojiKey,
        playerName,
      });

      return { success: true };
    } catch (error) {
      functions.logger.error('Failed to send Old Maid emoji effect', {
        error: error instanceof Error ? error.message : error,
        emoji: emojiKey,
        playerName,
      });
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError('internal', 'Failed to send emoji effect');
    }
  });

export const shuffleOldMaidHand = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string }): Promise<OldMaidShuffleResult> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      const result = await db.runTransaction<OldMaidShuffleResult>(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { success: false, error: 'session_missing' };
        }

        const sessionData = snap.data() as OldMaidSessionRecord;
        if (sessionData.status !== 'active') {
          return { success: false, error: 'not_active' };
        }

        pruneOldMaidPlayersInTransaction(sessionRef, transaction, sessionData);

        const now = admin.firestore.Timestamp.now();
        const lock = sessionData.shuffleLock;
        if (lock?.expiresAt && lock.expiresAt.toMillis() > now.toMillis()) {
          return { success: false, error: 'shuffle_locked' };
        }

        const lockExpiry = admin.firestore.Timestamp.fromMillis(now.toMillis() + SHUFFLE_LOCK_TTL_MS);

        const players = sessionData.players.map((player) => ({
          name: player.name,
          displayName: player.displayName,
          hand: [...player.hand],
          discards: player.discards.map((pair) => ({ cards: [...pair.cards] })),
          isOnline: player.isOnline,
          isSafe: player.isSafe,
          idleWarning: player.idleWarning ?? false,
        }));

        const index = players.findIndex((player) => player.name === playerName);
        if (index === -1) {
          return { success: false, error: 'not_in_game' };
        }

        if (players[index].hand.length < 2) {
          return { success: false, error: 'not_enough_cards' };
        }

        players[index].hand = shuffle([...players[index].hand]);

        transaction.update(sessionRef, {
          players,
          updatedAt: serverTimestamp(),
          [`playerLastSeen.${playerName}`]: serverTimestamp(),
          shuffleLock: { player: playerName, expiresAt: lockExpiry },
        });

        return {
          success: true,
          displayName: players[index].displayName?.trim() || players[index].name,
        };
      });

      if (!result.success) {
        if (result.error === 'not_in_game') {
          throw new functions.https.HttpsError('failed-precondition', 'player_not_in_session');
        }
        if (result.error === 'shuffle_locked') {
          return result;
        }
        return result;
      }

      const effectEntry: EmojiEffectEntry = {
        emoji: 'shuffle',
        label: OLD_MAID_EMOJI_EFFECTS.shuffle.label,
        symbol: OLD_MAID_EMOJI_EFFECTS.shuffle.symbol,
        player: playerName,
        displayName: result.displayName,
        timestamp: serverTimestamp(),
      };

      await oldMaidEffectsCollection().add(effectEntry);
      await sessionRef.update({ shuffleLock: admin.firestore.FieldValue.delete() });
      functions.logger.info('Old Maid hand shuffled', { playerName });
      return { success: true, displayName: result.displayName };
    } catch (error) {
      functions.logger.error('Failed to shuffle Old Maid hand', {
        error: error instanceof Error ? error.message : error,
        playerName,
      });
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError('internal', 'Unable to shuffle hand');
    }
  });

interface OldMaidJoinRequest {
  playerName?: string;
  displayName?: string;
}

const normalizeDisplayName = (raw?: string, fallback?: string): string | undefined => {
  if (!raw && !fallback) {
    return undefined;
  }
  const trimmed = raw?.trim();
  if (trimmed) {
    return trimmed;
  }
  return fallback;
};

export const joinOrCreateOldMaidSession = functions
  .region(REGION)
  .https.onCall(async (data: OldMaidJoinRequest): Promise<{ sessionId: string }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();
    const displayName = normalizeDisplayName(data?.displayName, rawName.trim());

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          transaction.set(sessionRef, buildOldMaidBaseSession());
        }
      });

      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        const session = (snap.data() as OldMaidSessionRecord) ?? buildOldMaidBaseSession();
        pruneOldMaidPlayersInTransaction(sessionRef, transaction, session);
        refreshOldMaidIfIdle(sessionRef, transaction, session);

        if (session.players.length === 0 && session.status !== 'waiting') {
          transaction.update(sessionRef, {
            status: 'waiting',
            turnIndex: 0,
            loser: null,
            updatedAt: serverTimestamp(),
          });
          session.status = 'waiting';
          session.turnIndex = 0;
          session.loser = null;
        }

        if (session.status === 'active') {
          const existingIndex = session.players.findIndex((player) => player.name === playerName);
          if (existingIndex === -1) {
            throw new functions.https.HttpsError('failed-precondition', 'game_in_progress');
          }
          session.players[existingIndex].displayName = displayName;
          session.players[existingIndex].isOnline = true;
          session.players[existingIndex].idleWarning = false;
          transaction.update(sessionRef, {
            players: session.players,
            updatedAt: serverTimestamp(),
            [`playerLastSeen.${playerName}`]: serverTimestamp(),
          });
          return;
        }

        const players = [...session.players];
        const existingIndex = players.findIndex((player) => player.name === playerName);
        if (existingIndex >= 0) {
          players[existingIndex].displayName = displayName;
          players[existingIndex].isOnline = true;
          players[existingIndex].idleWarning = false;
        } else {
          players.push({
            name: playerName,
            displayName,
            hand: [],
            discards: [],
            isOnline: true,
            isSafe: false,
            idleWarning: false,
          });
        }

        transaction.update(sessionRef, {
          players,
          status: 'waiting' as OldMaidSessionStatus,
          updatedAt: serverTimestamp(),
          loser: null,
          [`playerLastSeen.${playerName}`]: serverTimestamp(),
        });
      });

      return { sessionId: OLD_MAID_CURRENT_SESSION_ID };
    } catch (error) {
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      functions.logger.error('Failed to join Old Maid session', { error });
      throw new functions.https.HttpsError('internal', 'Unable to join Old Maid session');
    }
  });

export const reportOldMaidPresence = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string; isOnline?: boolean }) => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();
    const isOnline = data?.isOnline !== false;

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return;
        }
        const session = snap.data() as OldMaidSessionRecord;
        refreshOldMaidIfIdle(sessionRef, transaction, session);
        pruneOldMaidPlayersInTransaction(sessionRef, transaction, session);
        const players = [...session.players];
        const index = players.findIndex((player) => player.name === playerName);
        if (index === -1) {
          return;
        }
        if (players[index].isOnline === isOnline) {
          return;
        }
        players[index].isOnline = isOnline;
        if (isOnline && players[index].idleWarning) {
          players[index].idleWarning = false;
        }

        const updates: Partial<OldMaidSessionRecord> & { players: OldMaidPlayerWrite[] } = {
          players,
          updatedAt: serverTimestamp(),
          [`playerLastSeen.${playerName}`]: serverTimestamp(),
        };

        if (!isOnline && session.status === 'active') {
          updates.status = 'complete';
          updates.loser = playerName;
        }

        transaction.update(sessionRef, updates);
      });
    } catch (error) {
      functions.logger.error('Failed to update Old Maid presence', { error });
      throw new functions.https.HttpsError('internal', 'Unable to update presence');
    }
  });

export const cleanupOldMaidPlayers = functions
  .region(REGION)
  .https.onCall(async (): Promise<{ removed: number }> => {
    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);
    try {
      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { removed: 0 };
        }
        const session = snap.data() as OldMaidSessionRecord;
        const removed = pruneOldMaidPlayersInTransaction(sessionRef, transaction, session);
        if (session.players.length === 0) {
          transaction.update(sessionRef, {
            turnIndex: 0,
          });
        }
        return { removed: removed ?? 0 };
      });
      return result;
    } catch (error) {
      functions.logger.error('Failed to cleanup Old Maid players', { error });
      throw new functions.https.HttpsError('internal', 'Unable to cleanup Old Maid session');
    }
  });

export const startOldMaidSession = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string }): Promise<{ success: true } | { success: false; error: string }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      const response = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { success: false, error: 'session_missing' } as const;
        }
        const session = snap.data() as OldMaidSessionRecord;
        refreshOldMaidIfIdle(sessionRef, transaction, session);
        pruneOldMaidPlayersInTransaction(sessionRef, transaction, session);

        if (session.status === 'active') {
          return { success: false, error: 'already_active' } as const;
        }

        const eligiblePlayers = session.players
          .filter((player) => player.isOnline)
          .map((player) => ({
            name: player.name,
            displayName: player.displayName,
            hand: [] as Card[],
            discards: [] as OldMaidPairRecord[],
            isOnline: true,
            isSafe: false,
            idleWarning: false,
          }));

        if (!eligiblePlayers.some((player) => player.name === playerName)) {
          return { success: false, error: 'must_be_online' } as const;
        }
        if (eligiblePlayers.length < 2) {
          return { success: false, error: 'need_two_players' } as const;
        }

        const deck = buildOldMaidDeck();
        deck.forEach((card, index) => {
          eligiblePlayers[index % eligiblePlayers.length].hand.push(card);
        });

        eligiblePlayers.forEach((player) => {
          const { remaining, pairs } = resolveOldMaidPairs(player.hand);
          player.hand = remaining;
          player.discards = pairs;
          player.isSafe = player.hand.length === 0;
        });

        const startIndex = eligiblePlayers.findIndex((player) => player.hand.length > 0);

        const playerLastSeen = eligiblePlayers.reduce((acc, player) => {
          acc[player.name] = serverTimestamp();
          return acc;
        }, {} as PlayerLastSeenMap<TimestampLike>);

        transaction.set(sessionRef, {
          status: 'active',
          players: eligiblePlayers,
          turnIndex: startIndex >= 0 ? startIndex : 0,
          updatedAt: serverTimestamp(),
          createdAt: session.createdAt ?? serverTimestamp(),
          loser: null,
          playerLastSeen,
        });

        return { success: true } as const;
      });

      return response;
    } catch (error) {
      functions.logger.error('Failed to start Old Maid session', { error });
      throw new functions.https.HttpsError('internal', 'Unable to start Old Maid game');
    }
  });

export const drawOldMaidCard = functions
  .region(REGION)
  .https.onCall(async (data: { playerName?: string; cardPosition?: number }): Promise<{ success: true } | { success: false; error: string }> => {
    const rawName = typeof data?.playerName === 'string' ? data.playerName : '';
    const playerName = rawName.trim().toLowerCase();
    const requestedPosition =
      typeof data?.cardPosition === 'number' && Number.isFinite(data.cardPosition)
        ? Math.max(0, Math.floor(data.cardPosition))
        : null;

    if (!playerName) {
      throw new functions.https.HttpsError('invalid-argument', 'playerName is required');
    }

    const sessionRef = oldMaidSessionsCollection().doc(OLD_MAID_CURRENT_SESSION_ID);

    try {
      const result = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(sessionRef);
        if (!snap.exists) {
          return { success: false, error: 'session_missing' } as const;
        }

        const session = snap.data() as OldMaidSessionRecord;
        if (session.status !== 'active') {
          return { success: false, error: 'not_active' } as const;
        }
        pruneOldMaidPlayersInTransaction(sessionRef, transaction, session);

        const players = session.players.map((player) => ({
          name: player.name,
          displayName: player.displayName,
          hand: [...player.hand],
          discards: player.discards.map((pair) => ({ cards: [...pair.cards] })),
          isOnline: player.isOnline,
          isSafe: player.isSafe,
          idleWarning: player.idleWarning ?? false,
        }));
        const currentIndex = players.findIndex((player) => player.name === playerName);
        if (currentIndex === -1) {
          return { success: false, error: 'not_in_game' } as const;
        }

        if (currentIndex !== session.turnIndex) {
          return { success: false, error: 'not_your_turn' } as const;
        }

        const targetIndex = findNextPlayerWithCards(players, currentIndex);
        if (targetIndex === null) {
          return { success: false, error: 'no_target' } as const;
        }

        const target = players[targetIndex];
        const active = players[currentIndex];

        if (!target.hand.length) {
          return { success: false, error: 'target_empty' } as const;
        }

        const drawIndex =
          requestedPosition !== null && requestedPosition < target.hand.length
            ? requestedPosition
            : Math.floor(Math.random() * target.hand.length);

        const [drawnCard] = target.hand.splice(drawIndex, 1);

        const updatedHand = [...active.hand, drawnCard];
        const { remaining, pairs } = resolveOldMaidPairs(updatedHand);
        active.hand = remaining;
        active.discards = [...active.discards, ...pairs];
        active.isSafe = active.hand.length === 0;
        target.isSafe = target.hand.length === 0;

        const playersWithCards = players.filter((player) => player.hand.length > 0);
        const loser = playersWithCards.length === 1 ? playersWithCards[0].name : null;
        const nextTurn = loser
          ? players.findIndex((player) => player.name === loser)
          : findNextPlayerWithCards(players, currentIndex) ?? currentIndex;

        transaction.update(sessionRef, {
          players,
          turnIndex: nextTurn,
          updatedAt: serverTimestamp(),
          status: loser ? ('complete' as OldMaidSessionStatus) : 'active',
          loser: loser ?? null,
          [`playerLastSeen.${playerName}`]: serverTimestamp(),
        });

        return { success: true } as const;
      });

      return result;
    } catch (error) {
      functions.logger.error('Failed to draw Old Maid card', { error });
      throw new functions.https.HttpsError('internal', 'Unable to draw card');
    }
  });
