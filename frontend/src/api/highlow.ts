import { httpsCallable } from 'firebase/functions';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  type FirestoreError,
  type Timestamp,
} from 'firebase/firestore';

import { db, functions } from '../firebaseConfig';

export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';

export interface Card {
  rank: number; // 1 (Ace) .. 13 (King)
  suit: Suit;
  label: string; // e.g. "A♠"
}

export type GuessChoice = 'higher' | 'lower';

export interface GuessResult {
  correct: boolean;
  drawnCard: Card;
  nextPlayer: string | null;
  remainingCards: number;
}

export interface Player {
  name: string;
  displayName?: string;
  isActive: boolean;
  isOnline: boolean;
  pile: Card[];
}

export type GameStatus = 'waiting' | 'active' | 'complete';

export interface GameSession {
  id: string;
  players: Player[];
  deck: Card[];
  turnIndex: number;
  status: GameStatus;
  settings: { acesHigh: false };
  createdAt: Timestamp;
  updatedAt: Timestamp;
  playerLastSeen?: Record<string, Timestamp | undefined>;
}

interface GameSessionDoc extends Omit<GameSession, 'id'> {}

const CURRENT_SESSION_ID = 'current';
const joinOrCreateCallable = httpsCallable<
  { playerName: string; displayName?: string },
  { sessionId?: string; error?: string }
>(
  functions,
  'joinOrCreateHighLowSession'
);

const makeGuessCallable = httpsCallable<
  { playerName: string; guess: GuessChoice },
  { success?: boolean; result?: GuessResult; error?: string }
>(functions, 'makeGuess');

const reportPresenceCallable = httpsCallable<
  { playerName: string; isOnline: boolean },
  { success?: boolean; error?: string }
>(functions, 'reportPresence');

const startNewGameCallable = httpsCallable<{ playerName: string }, { success?: boolean; error?: string }>(
  functions,
  'startNewHighLowSession'
);

export async function joinOrCreateHighLowSession(
  playerName: string,
  displayName?: string
): Promise<string> {
  const trimmed = playerName.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const result = await joinOrCreateCallable({
    playerName: normalized,
    displayName: displayName?.trim() || undefined,
  });
  const payload = result.data;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid response from joinOrCreateHighLowSession');
  }

  const { sessionId, error } = payload as { sessionId?: string; error?: string };
  if (error) {
    throw new Error(error);
  }
  if (!sessionId) {
    throw new Error('Session id missing from response');
  }
  return sessionId;
}

export async function makeGuess(playerName: string, guess: GuessChoice): Promise<GuessResult> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const response = await makeGuessCallable({ playerName: normalized, guess });
  const payload = response.data;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid response from makeGuess');
  }
  const { success, result, error } = payload as {
    success?: boolean;
    result?: GuessResult;
    error?: string;
  };
  if (success === false && error) {
    throw new Error(error);
  }
  if (success !== true || !result) {
    throw new Error(error ?? 'makeGuess failed');
  }
  return result;
}

export async function reportPresence(playerName: string, isOnline: boolean): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  const payload = await reportPresenceCallable({ playerName: normalized, isOnline });
  const data = payload.data;
  if (data && typeof data === 'object' && 'success' in data && data.success === false && data.error) {
    throw new Error(data.error);
  }
}

export async function startNewHighLowSession(playerName: string): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const payload = await startNewGameCallable({ playerName: normalized });
  const data = payload.data;
  if (data && typeof data === 'object' && data.success === false && data.error) {
    throw new Error(data.error);
  }
}

export function subscribeToCurrentSession(
  onUpdate: (data: GameSession) => void,
  onError?: (error: FirestoreError | Error) => void
): () => void {
  const docRef = doc(db, 'games', 'highlow', 'sessions', CURRENT_SESSION_ID);
  return onSnapshot(
    docRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        const missingError = new Error('Session document does not exist');
        if (onError) {
          onError(missingError);
        } else {
          console.error(missingError);
        }
        return;
      }
      const data = snapshot.data() as GameSessionDoc;
      const session: GameSession = {
        id: snapshot.id,
        ...data,
      };
      console.log('High/Low session update', session);
      onUpdate(session);
    },
    (error) => {
      console.error('High/Low session listener error', error);
      if (onError) {
        onError(error);
      }
    }
  );
}

export const CURRENT_SESSION_PATH = ['games', 'highlow', 'sessions', CURRENT_SESSION_ID] as const;
export interface GameLogEntry {
  message: string;
  type: 'guess' | 'turn' | 'connect' | 'disconnect' | 'system';
  player?: string;
  timestamp?: Timestamp;
  id?: string;
}

export function subscribeToGameLog(onEntry: (entry: GameLogEntry) => void): () => void {
  const logsCollection = collection(db, 'games', 'highlow', 'sessions', 'current', 'logs');
  const logsQuery = query(logsCollection, orderBy('timestamp', 'asc'));
  return onSnapshot(logsQuery, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const data = change.doc.data() as GameLogEntry;
        onEntry({ ...data, id: change.doc.id });
      }
    });
  });
}
