import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';

if (!admin.apps.length) {
  admin.initializeApp();
}

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

type FirestoreTimestamp = FirebaseFirestore.Timestamp;
type TimestampLike = FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;

export type GuessChoice = 'higher' | 'lower';

export interface Card {
  rank: number; // 1 (Ace) .. 13 (King); Aces are low
  suit: 'hearts' | 'diamonds' | 'clubs' | 'spades';
  label: string; // e.g., "A♠", "Q♥", "10♦"
}

export interface Player {
  name: string; // always lowercase
  displayName?: string; // optional casing for UI
  isActive: boolean;
  isOnline: boolean;
  pile: Card[];
}

type PlayerWrite = Player;

type PlayerLastSeenMap<TTimestamp> = Record<string, TTimestamp>;

export interface GameSession {
  id: string;
  players: Player[];
  deck: Card[];
  turnIndex: number;
  status: 'waiting' | 'active' | 'complete';
  settings: { acesHigh: false };
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
  playerLastSeen: PlayerLastSeenMap<FirestoreTimestamp>;
}

export interface GuessResult {
  correct: boolean;
  drawnCard: Card;
  nextPlayer: string | null;
  remainingCards: number;
}

type GameSessionRecord = Omit<GameSession, 'id'>;
type GameSessionWrite = Omit<GameSessionRecord, 'players' | 'createdAt' | 'updatedAt' | 'playerLastSeen'> & {
  players: PlayerWrite[];
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  playerLastSeen: PlayerLastSeenMap<TimestampLike>;
};

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

const SUITS: Array<{ suit: Card['suit']; symbol: string }> = [
  { suit: 'hearts', symbol: '♥' },
  { suit: 'diamonds', symbol: '♦' },
  { suit: 'clubs', symbol: '♣' },
  { suit: 'spades', symbol: '♠' },
];

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
      pile: Array.isArray(player.pile) ? [...player.pile] : [],
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
  options?: { requireOnline?: boolean }
): number | null => {
  const requireOnline = options?.requireOnline ?? false;
  if (!players.length) {
    return null;
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
}

interface ReportPresenceRequest {
  playerName: string;
  isOnline: boolean;
}

interface StartNewGameRequest {
  playerName: string;
}

const buildFreshSessionDocument = (playerName: string, displayName: string): GameSessionWrite => {
  const timestamp = serverTimestamp();
  return {
    players: [
      {
        name: playerName,
        displayName,
        isActive: true,
        isOnline: true,
        pile: [],
      },
    ],
    deck: shuffle(generateDeck()),
    turnIndex: 0,
    status: 'waiting',
    settings: { acesHigh: false },
    playerLastSeen: {
      [playerName]: timestamp,
    },
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
        const players = await updatePlayersIfChanged(sessionRef, sessionData.players);

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
          pile: [],
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
            const now = serverTimestamp();

            if (sessionData.status === 'complete') {
              transaction.set(sessionRef, buildFreshSessionDocument(playerName, displayName));
              logs.push({
                message: `Session reset by ${displayName}. Waiting for players to join.`,
                type: 'system',
                player: playerName,
              });
              return { action: 'reset' as const, logs };
            }

            const players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
            const existingIndex = findPlayerIndex(players, playerName);

            if (existingIndex >= 0) {
              players[existingIndex].displayName = displayName;
              players[existingIndex].isOnline = true;
              transaction.update(sessionRef, {
                players,
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
              pile: [],
            });

            const turnIndex =
              ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: false }) ?? 0;

            transaction.update(sessionRef, {
              players,
              turnIndex,
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

      if (guess !== 'higher' && guess !== 'lower') {
        throw new functions.https.HttpsError('invalid-argument', 'guess must be "higher" or "lower"');
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

          if (sessionData.status === 'complete') {
            return { success: false, error: 'session_complete', logs: logQueue } as const;
          }

          const players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);

          if (!players.length) {
            return { success: false, error: 'no_players', logs: logQueue } as const;
          }

          if (!sessionData.deck.length) {
            return { success: false, error: 'deck_empty', logs: logQueue } as const;
          }

          let currentIndex =
            ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: true }) ??
            ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: false });

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

          const [drawnCard, ...remainingDeck] = sessionData.deck;

          if (!drawnCard) {
            return { success: false, error: 'deck_empty', logs: logQueue } as const;
          }

          let correct = true;
          const previousCard = currentPlayer.pile[currentPlayer.pile.length - 1];

          if (previousCard) {
            correct = evaluateGuess(guess, previousCard, drawnCard);
          }

          currentPlayer.pile = [...currentPlayer.pile, drawnCard];

          let status: GameSessionRecord['status'] =
            sessionData.status === 'waiting' ? 'active' : sessionData.status;

          if (!correct && currentPlayer.isActive) {
            currentPlayer.isActive = false;
          }

          const nextIndex =
            findNextEligibleIndex(players, currentIndex, { requireOnline: false }) ?? currentIndex;

          const anyActive = players.some((player) => player.isActive);
          const deckEmpty = remainingDeck.length === 0;
          if (!anyActive || deckEmpty) {
            status = 'complete';
          }

          const nextPlayerName = status === 'complete' ? null : players[nextIndex]?.name ?? null;

          transaction.update(sessionRef, {
            players,
            deck: remainingDeck,
            turnIndex: nextIndex,
            status,
            updatedAt: serverTimestamp(),
          });

          const result: GuessResult = {
            correct,
            drawnCard,
            nextPlayer: nextPlayerName,
            remainingCards: remainingDeck.length,
          };

          const displayName =
            currentPlayer.displayName && currentPlayer.displayName.trim()
              ? currentPlayer.displayName
              : currentPlayer.name;
          const outcome = correct ? 'correct' : 'incorrect';

          logQueue.push({
            message: `${displayName} guessed ${guess} and drew ${drawnCard.label} — ${outcome}!`,
            type: 'guess',
            player: currentPlayer.name,
          });

          if (nextPlayerName && nextPlayerName !== currentPlayer.name) {
            const nextPlayer = players[nextIndex];
            logQueue.push({
              message: `Turn advanced to ${nextPlayer.displayName ?? nextPlayer.name}.`,
              type: 'turn',
              player: nextPlayer.name,
            });
          }

          functions.logger.info('makeGuess resolved', {
            playerName,
            guess,
            correct,
            remainingCards: remainingDeck.length,
            nextPlayer: nextPlayerName,
            status,
          });

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
          const players = await updatePlayersIfChanged(sessionRef, sessionData.players, transaction);
          const targetIndex = findPlayerIndex(players, playerName);

          if (targetIndex === -1) {
            return { success: false, error: 'player_not_found', logs } as const;
          }

          const now = serverTimestamp();
          players[targetIndex].isOnline = isOnline;

          let turnIndex =
            ensureTurnIndex(players, sessionData.turnIndex ?? 0, { requireOnline: false }) ?? 0;

          if (!isOnline && turnIndex === targetIndex) {
            const nextOnline = findNextEligibleIndex(players, turnIndex, { requireOnline: true });
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

          transaction.update(sessionRef, {
            players,
            turnIndex,
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

          const now = serverTimestamp();
          transaction.set(sessionRef, {
            status: 'waiting',
            deck: shuffle(generateDeck()),
            players: [],
            turnIndex: 0,
            createdAt: now,
            updatedAt: now,
            settings: { acesHigh: false },
            playerLastSeen: {},
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
