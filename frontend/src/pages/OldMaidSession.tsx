import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import type { Card } from '../api/highlow';
import {
  drawOldMaid,
  joinOldMaidSession,
  OldMaidPlayer,
  OldMaidSession,
  type OldMaidStatus,
  reportOldMaidPresence,
  startOldMaidGame,
  subscribeToOldMaidSession,
  sendOldMaidEmojiEffect,
  subscribeToOldMaidEmojiEffects,
  shuffleOldMaidHand,
} from '../api/oldmaid';
import { usePresence } from '../hooks/usePresence';
import GameNav from '../components/GameNav';
import OldMaidTable from '../components/OldMaidTable';
import { EMOJI_OPTIONS_OLDMAID, type OldMaidEmojiEffectKey } from '../constants/emoji';
import { readStoredDisplayName, readStoredName } from '../utils/playerName';

const DRAW_REVEAL_DELAY_MS = 800;
const DRAW_RESULT_DISPLAY_MS = 2800;
const DEFENSE_REVEAL_DELAY_MS = 600;
const DEFENSE_RESULT_DISPLAY_MS = 2400;
const CLIENT_SHUFFLE_LOCK_MS = 5200;

type TheftReveal = {
  cardLabel: string;
  by?: string;
  visible: boolean;
  targetId?: string;
  phase: 'preview' | 'show';
};

const OldMaidSessionPage = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<OldMaidSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [playerName] = useState(() => readStoredName());
  const [drawLoading, setDrawLoading] = useState(false);
  const [logs, setLogs] = useState<Array<{ id: string; message: string; timestamp: number }>>([]);
  const previousSessionRef = useRef<OldMaidSession | null>(null);
  const [recentDraw, setRecentDraw] = useState<{ from?: string; cardLabel?: string; matched?: boolean; visible: boolean } | null>(null);
  const [offenseReveal, setOffenseReveal] = useState<{ card?: Card; matched?: boolean; phase: 'preview' | 'show' } | null>(null);
  const recentDrawTimerRef = useRef<number | null>(null);
  const drawRevealDelayRef = useRef<number | null>(null);
  const [recentTheft, setRecentTheft] = useState<TheftReveal | null>(null);
  const theftTimerRef = useRef<number | null>(null);
  const defenseRevealDelayRef = useRef<number | null>(null);
  const [targetHandSnapshot, setTargetHandSnapshot] = useState<Card[]>([]);
  const [pairFlash, setPairFlash] = useState<{ playerName: string; cards: Card[] } | null>(null);
  const pairTimerRef = useRef<number | null>(null);
  const [handOrder, setHandOrder] = useState<string[]>([]);
  const [lastDrawContext, setLastDrawContext] = useState<{ actor: string; target: string; targetId?: string } | null>(null);
  const [offenseCardSlots, setOffenseCardSlots] = useState<number | null>(null);
  const [offenseSelectionIndex, setOffenseSelectionIndex] = useState<number | null>(null);
  const [idleConfirming, setIdleConfirming] = useState(false);
  const [idleConfirmError, setIdleConfirmError] = useState<string | null>(null);
  const [startingGame, setStartingGame] = useState(false);
  const [finaleHoldActive, setFinaleHoldActive] = useState(false);
  const finaleHoldTimerRef = useRef<number | null>(null);
  const [emojiError, setEmojiError] = useState<string | null>(null);
  const reactionTimersRef = useRef<Record<string, number>>({});
  const [activeReactions, setActiveReactions] = useState<Record<string, { symbol: string; startedAt: number; duration: number }>>({});
  const shuffleAwaitSignatureRef = useRef<string | null>(null);
  const shuffleReleaseTimerRef = useRef<number | null>(null);
  const shuffleLockTimerRef = useRef<number | null>(null);
  const [shuffleLockedUntil, setShuffleLockedUntil] = useState<number | null>(null);
  const [shuffleError, setShuffleError] = useState<string | null>(null);
  const [shufflePending, setShufflePending] = useState(false);
  const rejoinInFlightRef = useRef(false);
  const storedDisplayNameRef = useRef<string | null>(readStoredDisplayName() ?? null);

  usePresence(playerName || null, Boolean(session), reportOldMaidPresence);

  const clearReactionEmoji = useCallback((player: string) => {
    setActiveReactions((prev) => {
      if (!(player in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[player];
      return next;
    });
  }, []);

  const scheduleReactionReset = useCallback(
    (player: string, duration: number) => {
      if (reactionTimersRef.current[player]) {
        window.clearTimeout(reactionTimersRef.current[player]);
      }
      const clamped = Math.max(duration, 0);
      if (clamped === 0) {
        clearReactionEmoji(player);
        return;
      }
      reactionTimersRef.current[player] = window.setTimeout(() => {
        clearReactionEmoji(player);
        delete reactionTimersRef.current[player];
      }, clamped);
    },
    [clearReactionEmoji]
  );

  const applyReactionEmoji = useCallback(
    (player: string, symbol: string, startedAt?: number, durationMs = 8000) => {
      const normalized = player?.trim().toLowerCase();
      if (!normalized || !symbol) {
        return;
      }
      const started = typeof startedAt === 'number' ? startedAt : Date.now();
      const elapsed = Math.max(0, Date.now() - started);
      const remaining = Math.max(durationMs - elapsed, 0);
      if (remaining <= 0) {
        clearReactionEmoji(normalized);
        return;
      }
      setActiveReactions((prev) => ({
        ...prev,
        [normalized]: { symbol, startedAt: started, duration: remaining },
      }));
      scheduleReactionReset(normalized, remaining);
    },
    [clearReactionEmoji, scheduleReactionReset]
  );

  useEffect(() => {
    if (!sessionId) {
      setError('Missing session id.');
      setLoading(false);
      return;
    }
    const unsubscribe = subscribeToOldMaidSession(
      (data) => {
        setSession(data);
        setLoading(false);
        setError(null);
      },
      (listenerError) => {
        setError(listenerError.message);
        setLoading(false);
      }
    );
    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    const unsubscribe = subscribeToOldMaidEmojiEffects((entry) => {
      const normalizedPlayer = entry.player?.trim().toLowerCase() ?? '';
      const symbol = entry.symbol ?? '✨';
      const startedAt = entry.timestamp?.toMillis?.() ?? Date.now();
      applyReactionEmoji(normalizedPlayer, symbol, startedAt);
    });
    return () => {
      unsubscribe();
      Object.values(reactionTimersRef.current).forEach((id) => window.clearTimeout(id));
      reactionTimersRef.current = {};
      setActiveReactions({});
    };
  }, [applyReactionEmoji]);

  const localPlayer = useMemo(() => {
    if (!session || !playerName) {
      return undefined;
    }
    return session.players.find((player) => player.name === playerName);
  }, [session, playerName]);

  const shouldAutoRejoin = useMemo(() => {
    if (!session || !playerName) {
      return false;
    }
    const isSeated = session.players.some((player) => player.name === playerName);
    const noGameInProgress = session.status !== 'active';
    return !isSeated && noGameInProgress;
  }, [session, playerName]);

  const handleAutoRejoin = useCallback(() => {
    if (!playerName || !shouldAutoRejoin || rejoinInFlightRef.current) {
      return;
    }
    rejoinInFlightRef.current = true;
    const displayName = storedDisplayNameRef.current ?? playerName;
    joinOldMaidSession(playerName, displayName)
      .catch((err) => {
        console.error('Auto-join Old Maid failed', err);
        setActionError('Rejoining failed. Tap Old Maid to retry.');
      })
      .finally(() => {
        rejoinInFlightRef.current = false;
      });
  }, [playerName, shouldAutoRejoin]);

  useEffect(() => {
    if (!shouldAutoRejoin) {
      return undefined;
    }
    const handlePointer = () => {
      handleAutoRejoin();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleAutoRejoin();
      }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [handleAutoRejoin, shouldAutoRejoin]);

  const appendLog = useCallback((message: string) => {
    setLogs((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        message,
        timestamp: Date.now(),
      };
      const next = [...prev, entry];
      return next.slice(-30);
    });
  }, []);

  const formatPlayerLabel = useCallback(
    (player?: OldMaidPlayer | null) => (player ? player.displayName ?? player.name : 'player'),
    []
  );

  const activePlayer = useMemo(() => {
    if (!session || !session.players.length) {
      return null;
    }
    return session.players[session.turnIndex] ?? null;
  }, [session]);

  const currentDrawTarget = useMemo(() => {
    if (!session || !session.players.length) {
      return null;
    }
    const players = session.players;
    for (let offset = 1; offset <= players.length; offset += 1) {
      const candidate = (session.turnIndex + offset) % players.length;
      if (players[candidate]?.hand.length) {
        return players[candidate];
      }
    }
    return null;
  }, [session]);

  const isOffense = Boolean(
    activePlayer && activePlayer.name === playerName && currentDrawTarget
  );
  const isDefense = Boolean(
    currentDrawTarget && currentDrawTarget.name === playerName && activePlayer && activePlayer.name !== playerName
  );
  const drawMode: 'offense' | 'defense' | null = recentTheft
    ? 'defense'
    : isOffense || Boolean(offenseReveal)
      ? 'offense'
      : isDefense
        ? 'defense'
        : null;
  const effectiveOffenseSlots = offenseCardSlots ?? (isOffense ? currentDrawTarget?.hand.length ?? 0 : 0);

  const rawHand = useMemo(() => localPlayer?.hand ?? [], [localPlayer?.hand]);
  const rawHandSignature = useMemo(
    () => rawHand.map((card) => `${card.suit}-${card.rank}`).join('|'),
    [rawHand]
  );

  const shuffleLocked = useMemo(
    () => shuffleLockedUntil !== null && shuffleLockedUntil > Date.now(),
    [shuffleLockedUntil]
  );

  useEffect(() => {
    const keys = rawHand.map((card, idx) => `${idx}-${card.label}`);
    setHandOrder((prev) => {
      if (!prev.length) {
        return keys;
      }
      const preserved = prev.filter((key) => keys.includes(key));
      const extras = keys.filter((key) => !preserved.includes(key));
      return [...preserved, ...extras];
    });
  }, [rawHand, rawHandSignature]);

  const orderedHand = useMemo(() => {
    const keyed = rawHand.map((card, idx) => ({ key: `${idx}-${card.label}`, card }));
    const byKey = new Map(keyed.map((entry) => [entry.key, entry.card]));
    const ordered = handOrder
      .map((key) => {
        const card = byKey.get(key);
        return card ? { key, card } : null;
      })
      .filter((entry): entry is { key: string; card: Card } => Boolean(entry));
    const extras = keyed.filter((entry) => !handOrder.includes(entry.key));
    return [...ordered, ...extras];
  }, [rawHand, handOrder]);

  const handlePromoteCard = useCallback((key: string) => {
    setHandOrder((prev) => {
      if (!prev.length) {
        return prev;
      }
      const next = prev.filter((entry) => entry !== key);
      next.push(key);
      return next;
    });
  }, []);

  const handleShuffleHand = useCallback(async () => {
    const lockActive = shuffleLockedUntil !== null && shuffleLockedUntil > Date.now();
    if (!playerName || shufflePending || lockActive) {
      return;
    }
    if (!orderedHand.length) {
      return;
    }
    setShufflePending(true);
    setShuffleError(null);
    shuffleAwaitSignatureRef.current = rawHandSignature;
    if (shuffleReleaseTimerRef.current) {
      window.clearTimeout(shuffleReleaseTimerRef.current);
    }
    try {
      const result = await shuffleOldMaidHand(playerName);
      if (result === 'ok') {
        applyReactionEmoji(playerName, '🔀', Date.now(), 2000);
        shuffleReleaseTimerRef.current = window.setTimeout(() => {
          shuffleAwaitSignatureRef.current = null;
          setShufflePending(false);
        }, 3000);
      } else {
        const lockExpires = Date.now() + CLIENT_SHUFFLE_LOCK_MS;
        setShuffleLockedUntil(lockExpires);
        if (shuffleLockTimerRef.current) {
          window.clearTimeout(shuffleLockTimerRef.current);
        }
        shuffleLockTimerRef.current = window.setTimeout(() => {
          setShuffleLockedUntil(null);
          shuffleLockTimerRef.current = null;
        }, CLIENT_SHUFFLE_LOCK_MS);
        shuffleAwaitSignatureRef.current = null;
        setShufflePending(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to shuffle right now';
      setShuffleError(message);
      shuffleAwaitSignatureRef.current = null;
      setShufflePending(false);
    }
  }, [applyReactionEmoji, orderedHand, playerName, rawHandSignature, shuffleLockedUntil, shufflePending]);

  const activeDrawerLabel = formatPlayerLabel(activePlayer ?? undefined);

  useEffect(() => {
    if (isOffense || offenseReveal) {
      return;
    }
    setOffenseCardSlots(null);
    setOffenseSelectionIndex(null);
  }, [isOffense, offenseReveal]);

  useEffect(() => {
    if (!localPlayer?.idleWarning) {
      setIdleConfirming(false);
      setIdleConfirmError(null);
    }
  }, [localPlayer?.idleWarning]);

  useEffect(() => {
    const isActiveDefense = isDefense || (recentTheft?.targetId === playerName && Boolean(recentTheft));
    if (isActiveDefense) {
      setTargetHandSnapshot(orderedHand.map((entry) => entry.card));
    } else if (!recentTheft) {
      setTargetHandSnapshot([]);
    }
  }, [isDefense, orderedHand, playerName, recentTheft]);

  useEffect(() => {
    if (!session) {
      setStartingGame(false);
      return;
    }
    if (session.status !== 'waiting') {
      setStartingGame(false);
    }
  }, [session, session?.status]);

  useEffect(() => {
    if (session?.status !== 'complete') {
      setFinaleHoldActive(false);
      if (finaleHoldTimerRef.current) {
        window.clearTimeout(finaleHoldTimerRef.current);
        finaleHoldTimerRef.current = null;
      }
      return;
    }
    if (!recentDraw && !offenseReveal) {
      setFinaleHoldActive(false);
      return;
    }
    setFinaleHoldActive(true);
    if (finaleHoldTimerRef.current) {
      window.clearTimeout(finaleHoldTimerRef.current);
    }
    finaleHoldTimerRef.current = window.setTimeout(() => {
      setFinaleHoldActive(false);
      finaleHoldTimerRef.current = null;
    }, DRAW_REVEAL_DELAY_MS + DRAW_RESULT_DISPLAY_MS);
  }, [session?.status, recentDraw, offenseReveal]);

  const handleStartGame = async () => {
    if (!playerName) {
      setActionError('Save a name before starting.');
      return;
    }
    try {
      setActionError(null);
      await startOldMaidGame(playerName);
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : 'Unable to start game';
      setActionError(message);
    }
  };

  const handleSendEmoji = async (emojiId: OldMaidEmojiEffectKey) => {
    if (!playerName) {
      setEmojiError('Join the table before sending reactions.');
      return;
    }
    const option = EMOJI_OPTIONS_OLDMAID.find((entry) => entry.id === emojiId);
    if (!option) {
      return;
    }
    setEmojiError(null);
    applyReactionEmoji(playerName, option.symbol);
    try {
      await sendOldMaidEmojiEffect(playerName, emojiId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send reaction';
      setEmojiError(message);
    }
  };

  const handleCardSelect = async (cardIndex: number) => {
    if (!playerName) {
      setActionError('Save a name before drawing.');
      return;
    }
    if (!isOffense) {
      return;
    }
    setDrawLoading(true);
    try {
      setActionError(null);
      const selectedCard = currentDrawTarget?.hand?.[cardIndex];
      const slotCount = currentDrawTarget?.hand?.length ?? null;
      setOffenseCardSlots(slotCount);
      setOffenseSelectionIndex(cardIndex);
      setOffenseReveal({ card: selectedCard, matched: undefined, phase: 'preview' });
      await drawOldMaid(playerName, cardIndex);
    } catch (drawError) {
      const message = drawError instanceof Error ? drawError.message : 'Unable to draw card';
      setActionError(message);
      setOffenseReveal(null);
      setLastDrawContext(null);
      setOffenseCardSlots(null);
      setOffenseSelectionIndex(null);
    } finally {
      setDrawLoading(false);
    }
  };

  const handleIdleConfirmation = async () => {
    if (!playerName || idleConfirming) {
      return;
    }
    setIdleConfirming(true);
    setIdleConfirmError(null);
    try {
      await reportOldMaidPresence(playerName, true);
    } catch (presenceError) {
      console.error('Failed to confirm Old Maid presence', presenceError);
      setIdleConfirmError('Unable to confirm right now. Please try again.');
      setIdleConfirming(false);
    }
  };

  useEffect(() => {
    if (!session) {
      previousSessionRef.current = null;
      setLogs([]);
      return;
    }
    if (shuffleAwaitSignatureRef.current && rawHandSignature !== shuffleAwaitSignatureRef.current) {
      shuffleAwaitSignatureRef.current = null;
      if (shuffleReleaseTimerRef.current) {
        window.clearTimeout(shuffleReleaseTimerRef.current);
        shuffleReleaseTimerRef.current = null;
      }
      setShufflePending(false);
      if (shuffleLockTimerRef.current) {
        window.clearTimeout(shuffleLockTimerRef.current);
        shuffleLockTimerRef.current = null;
      }
      setShuffleLockedUntil(null);
    }
    const prev = previousSessionRef.current;
    if (prev) {
      if (prev.status !== 'active' && session.status === 'active') {
        appendLog('Round started.'); 
      }
      if (prev.status === 'active' && session.status === 'complete') {
        const loserPlayer = session.loser ? session.players.find((player) => player.name === session.loser) : null;
        appendLog(`${formatPlayerLabel(loserPlayer)} is the Old Maid.`);
      }
      const newlyPaired = detectNewPairs(prev.players, session.players);
      if (newlyPaired) {
        setPairFlash(newlyPaired);
        if (pairTimerRef.current) {
          window.clearTimeout(pairTimerRef.current);
        }
        pairTimerRef.current = window.setTimeout(() => {
          setPairFlash(null);
        }, 2500);
      }

      if (prev.status === 'active' && session.status === 'active' && prev.turnIndex !== session.turnIndex) {
        const actor = prev.players[prev.turnIndex];
        const target = prev.players[(prev.turnIndex + 1) % prev.players.length];
        if (actor) {
          const updatedActor = session.players.find((player) => player.name === actor.name) ?? actor;
          const paired = (updatedActor.discards?.length ?? 0) > (actor.discards?.length ?? 0);
          const newlyDrawnCard = actor.name === playerName ? findNewCard(updatedActor.hand, actor.hand) : null;
          appendLog(
            `${formatPlayerLabel(actor)} drew from ${formatPlayerLabel(target)}${paired ? ' — pair made!' : ''}`
          );
          if (actor.name === playerName && target) {
            setRecentDraw({
              from: formatPlayerLabel(target),
              cardLabel: newlyDrawnCard?.label,
              matched: paired,
              visible: false,
            });
            setLastDrawContext({
              actor: formatPlayerLabel(actor),
              target: formatPlayerLabel(target),
              targetId: target.name,
            });
            setOffenseReveal({
              card: newlyDrawnCard ?? offenseReveal?.card,
              matched: paired,
              phase: 'preview',
            });
            if (drawRevealDelayRef.current) {
              window.clearTimeout(drawRevealDelayRef.current);
            }
            drawRevealDelayRef.current = window.setTimeout(() => {
              setRecentDraw((prevDraw) => (prevDraw ? { ...prevDraw, visible: true } : prevDraw));
              setOffenseReveal((prevReveal) => (prevReveal ? { ...prevReveal, phase: 'show' } : prevReveal));
            }, DRAW_REVEAL_DELAY_MS);
            if (recentDrawTimerRef.current) {
              window.clearTimeout(recentDrawTimerRef.current);
            }
            recentDrawTimerRef.current = window.setTimeout(() => {
              setRecentDraw(null);
              setOffenseReveal(null);
              setLastDrawContext(null);
              setOffenseCardSlots(null);
              setOffenseSelectionIndex(null);
            }, DRAW_REVEAL_DELAY_MS + DRAW_RESULT_DISPLAY_MS);
          } else if (target?.name === playerName && actor.name !== playerName) {
            const previousLocal = prev.players.find((player) => player.name === playerName);
            const currentLocal = session.players.find((player) => player.name === playerName);
            if (previousLocal && currentLocal) {
              const removedCard = findRemovedCard(previousLocal.hand, currentLocal.hand);
              if (removedCard?.label) {
                setTargetHandSnapshot(previousLocal.hand);
                setRecentTheft({
                  cardLabel: removedCard.label,
                  by: formatPlayerLabel(actor),
                  visible: false,
                  targetId: previousLocal.name,
                  phase: 'preview',
                });
                if (defenseRevealDelayRef.current) {
                  window.clearTimeout(defenseRevealDelayRef.current);
                }
                defenseRevealDelayRef.current = window.setTimeout(() => {
                  setRecentTheft((prevTheft) => (prevTheft ? { ...prevTheft, visible: true, phase: 'show' } : prevTheft));
                }, DEFENSE_REVEAL_DELAY_MS);
                if (theftTimerRef.current) {
                  window.clearTimeout(theftTimerRef.current);
                }
                theftTimerRef.current = window.setTimeout(() => {
                  setRecentTheft(null);
                  setTargetHandSnapshot([]);
                }, DEFENSE_REVEAL_DELAY_MS + DEFENSE_RESULT_DISPLAY_MS);
              }
            }
          }
        }
      }
    }
    previousSessionRef.current = session;
  }, [session, appendLog, formatPlayerLabel, playerName, offenseReveal, rawHandSignature]);

  useEffect(() => {
    return () => {
      if (recentDrawTimerRef.current) {
        window.clearTimeout(recentDrawTimerRef.current);
      }
      if (theftTimerRef.current) {
        window.clearTimeout(theftTimerRef.current);
      }
      if (pairTimerRef.current) {
        window.clearTimeout(pairTimerRef.current);
      }
      if (drawRevealDelayRef.current) {
        window.clearTimeout(drawRevealDelayRef.current);
      }
      if (defenseRevealDelayRef.current) {
        window.clearTimeout(defenseRevealDelayRef.current);
      }
      if (finaleHoldTimerRef.current) {
        window.clearTimeout(finaleHoldTimerRef.current);
      }
      if (shuffleReleaseTimerRef.current) {
        window.clearTimeout(shuffleReleaseTimerRef.current);
      }
      if (shuffleLockTimerRef.current) {
        window.clearTimeout(shuffleLockTimerRef.current);
      }
    };
  }, []);

  if (loading) {
    return <div className="Session">Connecting…</div>;
  }

  if (!session) {
    return (
      <div className="Session">
        <p>{error ?? 'Session unavailable.'}</p>
        <GameNav />
      </div>
    );
  }

  const loser = session.loser ? session.players.find((player) => player.name === session.loser) ?? null : null;

  const centerOverlay = finaleHoldActive
    ? null
    : deriveCenterOverlay(session.status, loser, playerName, handleStartGame, actionError, startingGame);
  return (
    <div className="Session-shell OldMaid-shell">
      <GameNav />
      {localPlayer?.idleWarning ? (
        <div className="Session-alert Session-alert--warning">
          <div>
            <p className="Session-alertTitle">Still there?</p>
            <p className="Session-alertMessage">We’re about to free up your seat. Tap the button below to stay at the table.</p>
            {idleConfirmError ? (
              <p role="alert" className="Session-alertError">
                {idleConfirmError}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="Session-alertBtn"
            onClick={handleIdleConfirmation}
            disabled={idleConfirming}
          >
            {idleConfirming ? 'Checking…' : "I'm still here"}
          </button>
        </div>
      ) : null}

      {localPlayer ? (
        <section className={`Session-card OldMaid-handPanel ${recentDraw ? 'is-active' : ''}`}>
          <div className="OldMaid-handHeader">
            <p className="OldMaid-handLabel">Your hand</p>
            <div className="OldMaid-handControls">
              <button
                type="button"
                className="OldMaid-shuffleBtn"
                onClick={handleShuffleHand}
                disabled={!orderedHand.length || shufflePending || shuffleLocked}
              >
                {shufflePending ? 'Shuffling…' : 'Shuffle'}
              </button>
              {shuffleError && drawMode !== 'defense' ? (
                <small className="OldMaid-inlineError">{shuffleError}</small>
              ) : null}
            </div>
          </div>
          <div className="OldMaid-handCards">
            {orderedHand.length ? (
              (() => {
                let highlightAvailable = recentDraw?.visible ? 1 : 0;
                const pairCardSet =
                  pairFlash && pairFlash.playerName === playerName
                    ? new Set(pairFlash.cards.map((card) => card.label))
                    : null;
                return orderedHand.map(({ key, card }) => {
                  const highlight = recentDraw?.visible && recentDraw.cardLabel === card.label && highlightAvailable > 0;
                  if (highlight) {
                    highlightAvailable -= 1;
                  }
                  const isJoker = card.label.includes('🃏');
                  const pairMatch = Boolean(pairCardSet?.has(card.label));
                  const stolen =
                    recentTheft?.visible && recentTheft.targetId === playerName && recentTheft.cardLabel === card.label;
                  const classes = [
                    'OldMaid-handCard',
                    'OldMaid-handCardButton',
                    highlight ? 'is-new' : '',
                    isJoker ? 'joker' : '',
                    pairMatch ? 'pair-match' : '',
                    stolen ? 'is-stolen' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <button key={key} type="button" className={classes} onClick={() => handlePromoteCard(key)}>
                      {card.label}
                    </button>
                  );
                });
              })()
            ) : (
              <p className="OldMaid-handEmpty">Safe! No cards remaining.</p>
            )}
          </div>
          <div className="Session-emojiTray" role="group" aria-label="Send emoji reactions">
            {EMOJI_OPTIONS_OLDMAID.map((option) => (
              <button
                key={option.id}
                type="button"
                className="Session-emojiButton"
                disabled={!playerName}
                onClick={() => handleSendEmoji(option.id)}
              >
                <span aria-hidden="true">{option.symbol}</span>
                <span className="sr-only">{option.label}</span>
              </button>
            ))}
          </div>
          {emojiError ? (
            <p role="alert" className="Session-error centered Session-emojiError">
              {emojiError}
            </p>
          ) : null}
        </section>
      ) : null}

      <OldMaidTable
        players={session.players}
        localPlayerName={playerName}
        currentTurnIndex={session.turnIndex}
        status={session.status}
        activeDrawer={activePlayer}
        drawTarget={currentDrawTarget}
        drawMode={drawMode}
        offenseCardCount={isOffense ? currentDrawTarget?.hand.length ?? 0 : 0}
        offenseSlots={effectiveOffenseSlots}
        offenseSelectionIndex={offenseSelectionIndex}
        offenseDisabled={drawLoading}
        onSelectCard={drawMode === 'offense' && isOffense ? handleCardSelect : undefined}
        offenseReveal={offenseReveal}
        defenseHand={targetHandSnapshot}
        defenseHighlight={recentTheft ? recentTheft.cardLabel : null}
        defenseActorName={recentTheft?.by ?? activeDrawerLabel}
        loserName={session.loser ?? null}
        pairFlash={pairFlash}
        recentDraw={recentDraw}
        recentTheft={recentTheft}
        offenseContext={offenseReveal ? lastDrawContext : null}
        centerOverlay={centerOverlay}
        reactionEmojis={activeReactions}
        onShuffleLocalHand={drawMode === 'defense' ? handleShuffleHand : undefined}
        shufflePending={shufflePending}
        shuffleError={drawMode === 'defense' ? shuffleError : null}
      />
      <section className="Session-card OldMaid-panel OldMaid-logPanel">
        <h2>Game Log</h2>
        <ul>
          {logs.map((entry) => (
            <li key={entry.id}>
              <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <p>{entry.message}</p>
            </li>
          ))}
        </ul>
        {actionError && session.status === 'active' ? (
          <p role="alert" className="Session-error centered">
            {actionError}
          </p>
        ) : null}
      </section>
    </div>
  );
};
export default OldMaidSessionPage;

const findNewCard = (nextHand: Card[], prevHand: Card[]): Card | null => {
  const counts = new Map<string, number>();
  prevHand.forEach((card) => {
    counts.set(card.label, (counts.get(card.label) ?? 0) + 1);
  });
  for (const card of nextHand) {
    const remaining = counts.get(card.label) ?? 0;
    if (remaining > 0) {
      counts.set(card.label, remaining - 1);
    } else {
      return card;
    }
  }
  return null;
};

const findRemovedCard = (prevHand: Card[], nextHand: Card[]): Card | null => {
  const counts = new Map<string, number>();
  nextHand.forEach((card) => {
    counts.set(card.label, (counts.get(card.label) ?? 0) + 1);
  });
  for (const card of prevHand) {
    const remaining = counts.get(card.label) ?? 0;
    if (remaining > 0) {
      counts.set(card.label, remaining - 1);
    } else {
      return card;
    }
  }
  return null;
};

const detectNewPairs = (
  prevPlayers: OldMaidPlayer[],
  nextPlayers: OldMaidPlayer[]
): { playerName: string; cards: Card[] } | null => {
  for (const player of nextPlayers) {
    const previous = prevPlayers.find((entry) => entry.name === player.name);
    const prevPairs = previous?.discards ?? [];
    const nextPairs = player.discards ?? [];
    if (nextPairs.length > prevPairs.length) {
      const newPair = nextPairs[nextPairs.length - 1];
      if (newPair?.cards?.length) {
        return {
          playerName: player.name,
          cards: newPair.cards,
        };
      }
    }
  }
  return null;
};

const deriveCenterOverlay = (
  status: OldMaidStatus,
  loser: OldMaidPlayer | null,
  playerName: string | null,
  handleStartGame: () => void,
  actionError: string | null,
  isStartingGame: boolean
) => {
  if (status === 'waiting') {
    return {
      title: 'Ready to start?',
      description: 'All online players will be seated.',
      actionLabel: isStartingGame ? 'Starting…' : 'Start New Game',
      actionDisabled: !playerName || isStartingGame,
      onAction: handleStartGame,
    };
  }
  if (status === 'complete') {
    return {
      title: loser ? `${loser.displayName ?? loser.name} is the Old Maid 👵` : 'Round complete',
      description: actionError ?? 'Start a rematch with the current roster.',
      actionLabel: isStartingGame ? 'Starting…' : 'Play Again',
      actionDisabled: !playerName || isStartingGame,
      onAction: handleStartGame,
    };
  }
  return null;
};
