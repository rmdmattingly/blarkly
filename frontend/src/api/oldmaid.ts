import { httpsCallable } from 'firebase/functions';
import { collection, doc, limit, onSnapshot, orderBy, query, type FirestoreError } from 'firebase/firestore';

import { db, functions } from '../firebaseConfig';
import type { Card } from './highlow';
import type { EmojiEffectEntry, EmojiEffectKey } from '../constants/emoji';

export interface OldMaidPlayer {
  name: string;
  displayName?: string;
  hand: Card[];
  discards: Array<{ cards: Card[] }>;
  isOnline: boolean;
  isSafe: boolean;
  idleWarning?: boolean;
}

export type OldMaidStatus = 'waiting' | 'active' | 'complete';

export interface OldMaidSession {
  id: string;
  status: OldMaidStatus;
  players: OldMaidPlayer[];
  turnIndex: number;
  createdAt?: unknown;
  updatedAt?: unknown;
  loser?: string | null;
  shuffleLock?: { player: string; expiresAt?: { toMillis?: () => number } | number };
}

const CURRENT_SESSION_ID = 'current';

const joinCallable = httpsCallable<
  { playerName: string; displayName?: string },
  { sessionId?: string }
>(functions, 'joinOrCreateOldMaidSession');

const startCallable = httpsCallable<{ playerName: string }, { success?: boolean; error?: string }>(
  functions,
  'startOldMaidSession'
);

const drawCallable = httpsCallable<{ playerName: string; cardPosition?: number }, { success?: boolean; error?: string }>(
  functions,
  'drawOldMaidCard'
);

const presenceCallable = httpsCallable<{ playerName: string; isOnline: boolean }, void>(
  functions,
  'reportOldMaidPresence'
);

const cleanupCallable = httpsCallable<Record<string, never>, { removed?: number }>(
  functions,
  'cleanupOldMaidPlayers'
);

const sendEmojiEffectCallable = httpsCallable<
  { playerName: string; emoji: EmojiEffectKey },
  { success?: boolean; error?: string }
>(functions, 'sendOldMaidEmojiEffect');

const shuffleHandCallable = httpsCallable<
  { playerName: string },
  { success?: boolean; error?: string }
>(functions, 'shuffleOldMaidHand');

export async function joinOldMaidSession(playerName: string, displayName?: string): Promise<string> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const response = await joinCallable({ playerName: normalized, displayName: displayName?.trim() || undefined });
  const data = response.data as { sessionId?: string };
  if (!data?.sessionId) {
    throw new Error('Unable to join Old Maid session');
  }
  return data.sessionId;
}

export async function startOldMaidGame(playerName: string): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const response = await startCallable({ playerName: normalized });
  const data = response.data as { success?: boolean; error?: string };
  if (data?.success === false || data?.error) {
    throw new Error(data.error ?? 'Unable to start Old Maid game');
  }
}

export async function drawOldMaid(playerName: string, cardPosition?: number): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const payload: { playerName: string; cardPosition?: number } = { playerName: normalized };
  if (typeof cardPosition === 'number' && Number.isFinite(cardPosition) && cardPosition >= 0) {
    payload.cardPosition = Math.floor(cardPosition);
  }
  const response = await drawCallable(payload);
  const data = response.data as { success?: boolean; error?: string };
  if (data?.success === false || data?.error) {
    throw new Error(data.error ?? 'Unable to draw card');
  }
}

export async function reportOldMaidPresence(playerName: string, isOnline: boolean): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  await presenceCallable({ playerName: normalized, isOnline });
}

export async function cleanupOldMaidPlayers(): Promise<number> {
  const response = await cleanupCallable({});
  const data = response.data as { removed?: number };
  return data?.removed ?? 0;
}

export async function sendOldMaidEmojiEffect(playerName: string, emoji: EmojiEffectKey): Promise<void> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const response = await sendEmojiEffectCallable({ playerName: normalized, emoji });
  const payload = response.data;
  if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) {
    const error = (payload as { error?: string }).error ?? 'Failed to send emoji effect';
    throw new Error(error);
  }
}

export async function shuffleOldMaidHand(playerName: string): Promise<'ok' | 'locked'> {
  const normalized = playerName.trim().toLowerCase();
  if (!normalized) {
    throw new Error('playerName is required');
  }
  const response = await shuffleHandCallable({ playerName: normalized });
  const payload = response.data;
  if (payload && typeof payload === 'object' && 'success' in payload && payload.success === false) {
    if ((payload as { error?: string }).error === 'shuffle_locked') {
      return 'locked';
    }
    const error = (payload as { error?: string }).error ?? 'Unable to shuffle hand';
    throw new Error(error);
  }
  return 'ok';
}

export function subscribeToOldMaidSession(
  onUpdate: (session: OldMaidSession) => void,
  onError?: (error: FirestoreError | Error) => void
): () => void {
  const docRef = doc(db, 'games', 'oldmaid', 'sessions', CURRENT_SESSION_ID);
  return onSnapshot(
    docRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        const missingError = new Error('Old Maid session not found');
        if (onError) {
          onError(missingError);
        } else {
          console.error(missingError);
        }
        return;
      }
      const data = snapshot.data() as OldMaidSession;
      onUpdate({ ...data, id: snapshot.id });
    },
    (error) => {
      console.error('Old Maid session listener failed', error);
      if (onError) {
        onError(error);
      }
    }
  );
}

export function subscribeToOldMaidEmojiEffects(
  onEntry: (entry: EmojiEffectEntry) => void,
  options?: { onReady?: () => void }
): () => void {
  const effectsRef = collection(db, 'games', 'oldmaid', 'sessions', CURRENT_SESSION_ID, 'effects');
  const effectsQuery = query(effectsRef, orderBy('timestamp', 'desc'), limit(30));
  let initialBatchPending = true;

  return onSnapshot(effectsQuery, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        const data = change.doc.data() as EmojiEffectEntry;
        onEntry({ ...data, id: change.doc.id });
      }
    });

    if (initialBatchPending) {
      initialBatchPending = false;
      options?.onReady?.();
    }
  });
}
