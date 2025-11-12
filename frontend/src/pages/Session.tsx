import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import type { SVGProps } from 'react';
import { useParams, Link } from 'react-router-dom';

import type {
  Card,
  GameSession,
  GameStatus,
  Player,
  GuessChoice,
  GuessResult,
  GameLogEntry,
  TablePile,
  EmojiEffectEntry,
  EmojiEffectKey,
} from '../api/highlow';
import {
  subscribeToCurrentSession,
  makeGuess,
  startNewHighLowSession,
  subscribeToGameLog,
  resolveTurnHang,
  sendEmojiEffect,
  subscribeToEmojiEffects,
  cleanupHighLowPlayers,
} from '../api/highlow';
import { usePresence } from '../hooks/usePresence';
import { useWinOdds } from '../hooks/useWinOdds';
import GameNav from '../components/GameNav';
import { readStoredDisplayName, readStoredName } from '../utils/playerName';

const TURN_TIMEOUT_MS = 3 * 60 * 1000;
const EMOJI_SUPPRESSION_MS = 4000;

interface GuessSummary {
  playerName: string;
  displayName: string;
  guess: GuessChoice;
  result: GuessResult;
  previousCard?: Card;
  pileId: string;
  pileLabel: string;
}

const PLACEHOLDER_PILES: TablePile[] = Array.from({ length: 9 }).map((_, index) => ({
  id: `placeholder-${index}`,
  row: Math.floor(index / 3),
  column: index % 3,
  cards: [] as Card[],
  isFaceUp: false,
}));

const EMOJI_OPTIONS: Array<{ id: EmojiEffectKey; label: string; symbol: string }> = [
  { id: 'thumbs_up', label: 'Thumbs up', symbol: '👍' },
  { id: 'laughing', label: 'Laughing', symbol: '😂' },
  { id: 'crying', label: 'Crying', symbol: '😭' },
  { id: 'sweating', label: 'Sweating', symbol: '😅' },
  { id: 'uhoh', label: 'Uh oh', symbol: '🫠' },
  { id: 'thinking', label: 'Thinking', symbol: '🤔' },
  { id: 'angry', label: 'Angry', symbol: '😡' },
  { id: 'high_five', label: 'High five', symbol: '✋' },
];

const Session = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<GameSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guessError, setGuessError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [isGuessing, setIsGuessing] = useState(false);
  const [lastGuess, setLastGuess] = useState<GuessSummary | null>(null);
  const [selectedPileId, setSelectedPileId] = useState<string | null>(null);
  const [guessBanner, setGuessBanner] = useState<{ status: 'correct' | 'wrong'; message: string } | null>(null);
  const [latestCard, setLatestCard] = useState<{ card: Card; correct: boolean; pileId: string } | null>(null);
  const [turnNotice, setTurnNotice] = useState<string | null>(null);
  const [localPlayerName] = useState<string>(() => readStoredName());
  const [localDisplayName] = useState<string>(() => readStoredDisplayName());
  const previousSessionRef = useRef<GameSession | null>(null);
  const [logEntries, setLogEntries] = useState<GameLogEntry[]>([]);
  const logRef = useRef<HTMLUListElement | null>(null);
  const logStartRef = useRef<number>(Date.now());
  const emojiReadyRef = useRef<boolean>(false);
  const emojiSeenRef = useRef<Set<string>>(new Set());
  const bannerTimerRef = useRef<number | null>(null);
  const winOdds = useWinOdds(session);
  const [oddsHistory, setOddsHistory] = useState<Array<{ value: number; timestamp: number }>>([]);
  const [emojiError, setEmojiError] = useState<string | null>(null);
  const [emojiStream, setEmojiStream] = useState<EmojiBubble[]>([]);
  const emojiTimersRef = useRef<Record<string, number>>({});
  const pendingEmojiRef = useRef<Map<
    string,
    { player: string; symbol: string; createdAt: number }
  >>(new Map());

  const removeEmojiBubble = useCallback((id: string) => {
    setEmojiStream((prev) => prev.filter((entry) => entry.id !== id));
    const timerId = emojiTimersRef.current[id];
    if (timerId) {
      window.clearTimeout(timerId);
      delete emojiTimersRef.current[id];
    }
    pendingEmojiRef.current.delete(id);
  }, []);

  const clearPendingForEffect = useCallback((player: string, symbol: string) => {
    const normalizedPlayer = player?.trim().toLowerCase();
    if (!normalizedPlayer) {
      return;
    }
    const now = Date.now();
    for (const [id, info] of pendingEmojiRef.current.entries()) {
      if (info.player === normalizedPlayer && info.symbol === symbol && now - info.createdAt <= 4000) {
        pendingEmojiRef.current.delete(id);
        removeEmojiBubble(id);
        break;
      }
    }
  }, [removeEmojiBubble]);
  const appendEmojiEffect = useCallback(
    (effect: EmojiBubble, duration = 2600) => {
      setEmojiStream((prev) => {
        const next = [...prev, effect];
        return next.slice(-8);
      });
      const timeoutId = window.setTimeout(() => {
        setEmojiStream((current) => current.filter((entry) => entry.id !== effect.id));
        delete emojiTimersRef.current[effect.id];
        pendingEmojiRef.current.delete(effect.id);
      }, duration);
      emojiTimersRef.current[effect.id] = timeoutId;
    },
    []
  );

  usePresence(localPlayerName || null, Boolean(session));

  useEffect(() => {
    if (!localPlayerName) {
      return;
    }
    let canceled = false;
    const runCleanup = () =>
      cleanupHighLowPlayers().catch((cleanupError) => {
        if (!canceled) {
          console.warn('High/Low cleanup failed', cleanupError);
        }
      });
    runCleanup();
    const intervalId = window.setInterval(runCleanup, 30_000);
    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [localPlayerName]);
  const formatPlayerLabel = useCallback((player?: Player) => player?.displayName ?? player?.name ?? '—', []);
  const localPlayerNameNormalized = localPlayerName?.trim().toLowerCase() ?? '';
  const piles = useMemo(() => {
    return session?.piles ?? [];
  }, [session]);

  const sortedPiles = useMemo(() => {
    return [...piles].sort((a, b) => a.row - b.row || a.column - b.column);
  }, [piles]);

  const renderPiles = sortedPiles.length ? sortedPiles : PLACEHOLDER_PILES;

  const pileLabelLookup = useMemo(() => {
    const map = new Map<string, string>();
    renderPiles.forEach((pile, index) => {
      map.set(pile.id, `Pile ${index + 1}`);
    });
    return map;
  }, [renderPiles]);

  const describePile = (pile?: TablePile | null): string => {
    if (!pile) {
      return 'Pile';
    }
    return pileLabelLookup.get(pile.id) ?? 'Pile';
  };

  const pileRows = useMemo(() => {
    const rows: TablePile[][] = [];
    renderPiles.forEach((pile) => {
      if (!rows[pile.row]) {
        rows[pile.row] = [];
      }
      rows[pile.row].push(pile);
    });
    return rows;
  }, [renderPiles]);

  useEffect(() => {
    if (!sessionId) {
      setError('Missing session id.');
      setIsLoading(false);
      return;
    }

    if (sessionId !== 'current') {
      setError('This demo only supports the shared "current" session.');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const unsubscribe = subscribeToCurrentSession(
      (data) => {
        setSession(data);
        setError(null);
        setIsLoading(false);
      },
      (listenerError) => {
        setError(listenerError.message);
        setIsLoading(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    const unsubscribe = subscribeToGameLog((entry) => {
      setLogEntries((prev) => [...prev, entry]);
      if (entry.type === 'guess') {
        const entryTime = entry.timestamp?.toMillis?.() ?? Date.now();
        if (entryTime < logStartRef.current) {
          return;
        }
        const outcome = entry.message.toLowerCase().includes('incorrect') ? 'wrong' : 'correct';
        setGuessBanner({ status: outcome, message: entry.message });
        if (bannerTimerRef.current) {
          window.clearTimeout(bannerTimerRef.current);
        }
        bannerTimerRef.current = window.setTimeout(() => setGuessBanner(null), 2200);
      }
    });
    return () => {
      unsubscribe();
      setLogEntries([]);
      if (bannerTimerRef.current) {
        window.clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    emojiReadyRef.current = false;
    emojiSeenRef.current = new Set();

    const unsubscribe = subscribeToEmojiEffects((entry: EmojiEffectEntry) => {
      const resolvedId = entry.id ?? `${entry.player}-${entry.timestamp?.toMillis?.() ?? Date.now()}`;
      if (!emojiReadyRef.current) {
        emojiSeenRef.current.add(resolvedId);
        return;
      }
      if (emojiSeenRef.current.has(resolvedId)) {
        return;
      }
      emojiSeenRef.current.add(resolvedId);

      const normalizedEntryPlayer = entry.player?.trim().toLowerCase() ?? '';
      if (localPlayerNameNormalized && normalizedEntryPlayer === localPlayerNameNormalized) {
        return;
      }

      const displayName =
        entry.displayName && entry.displayName.trim() ? entry.displayName : entry.player;
      const symbol = entry.symbol ?? '✨';
      const label = entry.label ?? 'Reaction';

      clearPendingForEffect(entry.player, symbol);

      appendEmojiEffect({
        id: resolvedId,
        emoji: symbol,
        label,
        player: displayName ?? 'Player',
      });
    });

    const readyTimer = window.setTimeout(() => {
      emojiReadyRef.current = true;
    }, EMOJI_SUPPRESSION_MS);

    return () => {
      window.clearTimeout(readyTimer);
      unsubscribe();
      Object.values(emojiTimersRef.current).forEach((timerId) => window.clearTimeout(timerId));
      emojiTimersRef.current = {};
      setEmojiStream([]);
    };
  }, [appendEmojiEffect, clearPendingForEffect, localPlayerNameNormalized]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logEntries]);

  useEffect(() => {
    if (session?.status === 'waiting' && session.players.length === 0) {
      setLogEntries([]);
      setLatestCard(null);
      setGuessBanner(null);
      setEmojiStream([]);
      emojiSeenRef.current.clear();
      pendingEmojiRef.current.clear();
    }
  }, [session?.status, session?.players.length]);

  const lastStatusRef = useRef<GameStatus | null>(null);
  useEffect(() => {
    if (!session) {
      lastStatusRef.current = null;
      return;
    }
    if (
      lastStatusRef.current &&
      lastStatusRef.current !== session.status &&
      session.status === 'waiting'
    ) {
      setOddsHistory([]);
    }
    lastStatusRef.current = session.status;
  }, [session]);
  useEffect(() => {
    if (!session) {
      return;
    }
    setOddsHistory((prev) => {
      if (prev.length && prev[prev.length - 1].value === winOdds) {
        return prev;
      }
      const next = [...prev, { value: winOdds, timestamp: Date.now() }];
      return next.slice(-60);
    });
  }, [winOdds, session?.status, session]);

  useEffect(() => {
    if (!session) {
      previousSessionRef.current = null;
      return;
    }
    const previous = previousSessionRef.current;
    if (previous) {
      const prevPlayer = previous.players[previous.turnIndex];
      const nextPlayer = session.players[session.turnIndex];
      if (
        prevPlayer &&
        nextPlayer &&
        prevPlayer.name !== nextPlayer.name &&
        prevPlayer.isOnline === false
      ) {
        setTurnNotice(
          `${formatPlayerLabel(prevPlayer)} went offline; advancing turn to ${formatPlayerLabel(nextPlayer)}.`
        );
      }

      const prevPileMap = new Map(previous.piles.map((pile) => [pile.id, pile]));
      for (const pile of session.piles) {
        const prevPile = prevPileMap.get(pile.id);
        if (!prevPile) {
          continue;
        }
        const cardChanged = pile.cards.length !== prevPile.cards.length;
        const faceChange = pile.isFaceUp !== prevPile.isFaceUp;
        if (cardChanged || faceChange) {
          const topCard = pile.cards[pile.cards.length - 1];
          if (topCard) {
            setLatestCard({
              card: topCard,
              correct: pile.isFaceUp,
              pileId: pile.id,
            });
          }
          break;
        }
      }
    }
    previousSessionRef.current = session;
  }, [session, formatPlayerLabel]);

  const lastResolveRef = useRef<number>(0);

useEffect(() => {
  if (!session || !selectedPileId) {
    return;
  }
  const pile = piles.find((entry) => entry.id === selectedPileId);
  if (!pile || !pile.isFaceUp) {
    setSelectedPileId(null);
  }
}, [session, selectedPileId, piles]);

  useEffect(() => {
    if (!lastGuess) {
      return;
    }
    const { result } = lastGuess;
    setLatestCard({ card: result.drawnCard, correct: result.correct, pileId: result.pileId });
  }, [lastGuess]);

  useEffect(() => {
    if (!latestCard) {
      return;
    }
    const timer = window.setTimeout(() => setLatestCard(null), 1200);
    return () => window.clearTimeout(timer);
  }, [latestCard]);

  const activePlayer: Player | undefined = useMemo(() => {
    if (!session) {
      return undefined;
    }
    return session.players[session.turnIndex];
  }, [session]);

  const getCardColorClass = (card?: Card | null): string => {
    if (!card) {
      return '';
    }
    return card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : 'black';
  };

  const selectedPile = useMemo(() => {
    if (!selectedPileId) {
      return null;
    }
    return sortedPiles.find((pile) => pile.id === selectedPileId) ?? null;
  }, [selectedPileId, sortedPiles]);

  const selectedPileTop = selectedPile
    ? selectedPile.cards[selectedPile.cards.length - 1] ?? null
    : null;

  const localPlayerRecord = useMemo(() => {
    if (!session || !localPlayerName) {
      return undefined;
    }
    return session.players.find((player) => player.name === localPlayerName);
  }, [session, localPlayerName]);

  const isLocalPlayersTurn = useMemo(() => {
    if (!session || !localPlayerName) {
      return false;
    }
    const current = session.players[session.turnIndex];
    if (!current) {
      return false;
    }
    return current.name.toLowerCase() === localPlayerName.toLowerCase();
  }, [session, localPlayerName]);

  useEffect(() => {
    if (!session || !localPlayerName) {
      return;
    }
    const activeEntry = session.players[session.turnIndex];
    if (!activeEntry) {
      return;
    }
    const hasOnline = session.players.some((player) => player.isActive && player.isOnline);
    if (!hasOnline) {
      return;
    }
    if (!localPlayerRecord?.isOnline) {
      return;
    }
    const turnStartMillis = session.turnStartedAt?.toMillis?.() ?? 0;
    const timedOut = turnStartMillis && Date.now() - turnStartMillis > TURN_TIMEOUT_MS;
    if (activeEntry.isOnline && activeEntry.isActive && !timedOut) {
      return;
    }
    const now = Date.now();
    if (now - lastResolveRef.current < 5000) {
      return;
    }
    lastResolveRef.current = now;
    resolveTurnHang(localPlayerName).catch((error) => {
      console.warn('resolveTurnHang failed', error);
    });
  }, [session, localPlayerName, localPlayerRecord]);

  const sessionAllowsGuess =
    !!session &&
    session.status !== 'complete' &&
    session.deck.length > 0 &&
    piles.some((pile) => pile.isFaceUp);

  const guessButtonsDisabled = !sessionAllowsGuess || !isLocalPlayersTurn || isGuessing || !selectedPile;

  useEffect(() => {
    if (!isLocalPlayersTurn || !sessionAllowsGuess) {
      return;
    }
    if (selectedPile && selectedPile.isFaceUp) {
      return;
    }
    const fallback = sortedPiles.find((pile) => pile.isFaceUp);
    if (fallback) {
      setSelectedPileId(fallback.id);
    }
  }, [isLocalPlayersTurn, sessionAllowsGuess, selectedPile, sortedPiles]);

  const handleSelectPile = (pile: TablePile) => {
    if (!pile.isFaceUp || session?.status === 'complete') {
      return;
    }
    setSelectedPileId(pile.id);
  };

  const handleSendEmoji = async (emojiId: EmojiEffectKey) => {
    if (!localPlayerName) {
      setEmojiError('Join the session before sending reactions.');
      return;
    }
    const option = EMOJI_OPTIONS.find((entry) => entry.id === emojiId);
    if (!option) {
      return;
    }
    setEmojiError(null);
    const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    appendEmojiEffect({
      id: tempId,
      emoji: option.symbol,
      label: option.label,
      player: localDisplayName || localPlayerName || 'You',
    }, 2000);
    pendingEmojiRef.current.set(tempId, {
      player: localPlayerName.toLowerCase(),
      symbol: option.symbol,
      createdAt: Date.now(),
    });
    try {
      await sendEmojiEffect(localPlayerName, emojiId);
    } catch (emojiErr) {
      const message = emojiErr instanceof Error ? emojiErr.message : 'Unable to send reaction';
      setEmojiError(message);
      pendingEmojiRef.current.delete(tempId);
      removeEmojiBubble(tempId);
    }
  };

  const handleGuess = async (choice: GuessChoice) => {
    if (!session || !localPlayerName) {
      return;
    }
    if (!selectedPile) {
      setGuessError('Select a face-up pile before guessing.');
      return;
    }
    setGuessError(null);
    setIsGuessing(true);
    try {
      const latestPileState = piles.find((pile) => pile.id === selectedPile.id) ?? selectedPile;
      const previousCard = latestPileState.cards[latestPileState.cards.length - 1];
      const result = await makeGuess(localPlayerName, choice, latestPileState.id);
      setLastGuess({
        playerName: localPlayerName,
        displayName: localDisplayName || localPlayerName,
        guess: choice,
        result,
        previousCard,
        pileId: latestPileState.id,
        pileLabel: describePile(latestPileState),
      });
    } catch (guessErr) {
      const message = guessErr instanceof Error ? guessErr.message : 'Unable to submit guess';
      setGuessError(message);
    } finally {
      setIsGuessing(false);
    }
  };

  const handleStartNewGame = async () => {
    if (!localPlayerName) {
      setResetError('Please rejoin with a player name first.');
      return;
    }
    setResetError(null);
    setIsResetting(true);
    try {
      await startNewHighLowSession(localPlayerName);
    } catch (resetErr) {
      const message = resetErr instanceof Error ? resetErr.message : 'Unable to start a new game';
      setResetError(message);
    } finally {
      setIsResetting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="Session">
        <p>Connecting…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="Session">
        <p role="alert">{error}</p>
        <Link to="/">Return home</Link>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="Session">
        <p>No session data available.</p>
        <Link to="/">Return home</Link>
      </div>
    );
  }

  const sessionComplete = session.status === 'complete';
  const hasRealPiles = piles.length > 0;
  const remaining = session.deck.length;
  const openPiles = piles.filter((pile) => pile.isFaceUp).length;
  const totalPiles = piles.length || 9;
  const winnerMessage = sessionComplete
    ? session.outcome === 'players'
      ? 'Players win! The deck ran out before every pile flipped.'
      : session.outcome === 'deck'
        ? 'Deck wins — every pile locked.'
        : 'Great game!'
    : 'Great game!';
  let oddsLabel = 'Even';
  if (winOdds <= 45) {
    oddsLabel = 'Deck Favored';
  } else if (winOdds >= 65) {
    oddsLabel = 'Players Favored';
  }
  const emojiButtonsDisabled = !localPlayerName;

  const logSection = (
    <section className="Session-card Session-logCard">
      <div className="Session-cardHeader">
        <h2>Game Log</h2>
      </div>
      <ul ref={logRef}>
        {logEntries.map((entry, index) => (
          <li key={entry.id ?? `${entry.timestamp?.toMillis?.() ?? Date.now()}-${index}`} className={`log-${entry.type}`}>
            <span className="Session-logTime">
              {entry.timestamp?.toDate ? entry.timestamp.toDate().toLocaleTimeString() : '--:--:--'}
            </span>
            <span>{entry.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className={`Session-shell ${sessionComplete ? 'is-complete' : ''}`}>
      <GameNav />
      {guessBanner ? <div className={`Session-banner ${guessBanner.status}`}>{guessBanner.message}</div> : null}
      {emojiStream.length ? <EmojiStream effects={emojiStream} /> : null}

      <div className="Session-gridLayout">
        <div className="Session-mainColumn">
          <section className="Session-card Session-pilesCard">
            <div className="Session-cardHeader">
              <div>
                <h2>Piles</h2>
                <p>{openPiles} face-up • {Math.max(totalPiles - openPiles, 0)} locked</p>
              </div>
              <div className="Session-boardStats">
                <IconShuffle />
                <span>{remaining} cards left</span>
              </div>
            </div>
            <div className="Session-pileGridWrapper">
              <div className="Session-pileGrid">
                {pileRows.map((row, rowIndex) => (
                  <div className="Session-pileRow" key={`row-${rowIndex}`}>
                    {row.map((pile) => {
                      const topCard = pile.cards[pile.cards.length - 1];
                      const isSelected = selectedPileId === pile.id;
                      const isRecent = latestCard?.pileId === pile.id;
                      const cardLabel = topCard?.label ?? '—';
                      const footprint = pile.isFaceUp
                        ? `${pile.cards.length} cards`
                        : `Locked · ${pile.cards.length} cards`;
                      const recentBubble =
                        latestCard && latestCard.pileId === pile.id
                          ? latestCard.correct
                            ? 'Nice call!'
                            : 'Missed it'
                          : null;
                      return (
                        <button
                          key={pile.id}
                          type="button"
                          className={`Session-pile ${pile.isFaceUp ? 'face-up' : 'face-down'}${
                            isSelected ? ' selected' : ''
                          }${isRecent ? ' recent' : ''}`}
                          onClick={() => handleSelectPile(pile)}
                          disabled={!pile.isFaceUp || sessionComplete || !isLocalPlayersTurn}
                        >
                          <span className="Session-pileLabel">{describePile(pile)}</span>
                          <strong className={`Session-pileCard ${getCardColorClass(topCard)}`}>{cardLabel}</strong>
                          <span className="Session-pileCount">{footprint}</span>
                          {recentBubble ? (
                            <span
                              className={`Session-pileBubble ${latestCard?.correct ? 'success' : 'miss'}`}
                            >
                              {recentBubble}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              {sessionComplete ? (
                <div className="Session-pileOverlay">
                  <p>{winnerMessage}</p>
                  <button type="button" className="Session-overlayBtn" onClick={handleStartNewGame} disabled={isResetting}>
                    {isResetting ? 'Resetting…' : 'Start New Game'}
                  </button>
                  {resetError ? (
                    <p role="alert" className="Session-error centered">
                      {resetError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="Session-actionRow">
              <div className="Session-pileActions">
                <button
                  type="button"
                  className="Session-actionBtn higher"
                  onClick={() => handleGuess('higher')}
                  disabled={guessButtonsDisabled}
                >
                  <span aria-hidden="true">▲</span>
                </button>
                <button
                  type="button"
                  className="Session-actionBtn lower"
                  onClick={() => handleGuess('lower')}
                  disabled={guessButtonsDisabled}
                >
                  <span aria-hidden="true">▼</span>
                </button>
              </div>
              <div className="Session-emojiTray" role="group" aria-label="Send emoji reactions">
                {EMOJI_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="Session-emojiButton"
                    onClick={() => handleSendEmoji(option.id)}
                    disabled={emojiButtonsDisabled}
                  >
                    <span aria-hidden="true">{option.symbol}</span>
                    <span className="sr-only">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="Session-oddsInline">
              <span>Players vs Deck:</span>
              <strong className={winOdds <= 45 ? 'odds-red' : winOdds >= 65 ? 'odds-green' : 'odds-yellow'}>
                {winOdds}% ({oddsLabel})
              </strong>
            </div>
            {emojiError ? (
              <p role="alert" className="Session-error centered Session-emojiError">
                {emojiError}
              </p>
            ) : null}
            {guessError ? (
              <p role="alert" className="Session-error centered">{guessError}</p>
            ) : null}
            {lastGuess ? (
              <div className="Session-summary">
                <p>
                  {`${lastGuess.displayName} guessed ${lastGuess.guess} on ${lastGuess.pileLabel} — ${
                    lastGuess.result.correct ? 'Correct!' : 'Incorrect!'
                  }`}
                </p>
                <p>Cards remaining: {lastGuess.result.remainingCards}</p>
              </div>
            ) : null}
            {turnNotice ? <p className="Session-notice">{turnNotice}</p> : null}
            <p className="Session-pileHint">
              {sessionComplete
                ? 'Game complete. Start a new session when you’re ready.'
                : !hasRealPiles
                  ? 'Initializing piles… start a new game if this persists.'
                  : selectedPile
                    ? `Selected ${describePile(selectedPile)} (top card ${selectedPileTop?.label ?? '—'}).`
                    : 'Select any face-up pile to make your next guess.'}
            </p>
          </section>

        </div>

        <div className="Session-sideColumn">
          <section className="Session-card Session-playersCard">
            <div className="Session-cardHeader">
              <h2>Players</h2>
            </div>
            <ul>
              {session.players.map((player) => (
                <li key={player.name} className={player.isActive ? 'active' : 'inactive'}>
                  <div>
                    <strong>{formatPlayerLabel(player)}</strong>
                    {player.name === activePlayer?.name ? <span className="Session-pill">Turn</span> : null}
                  </div>
                  <span className={player.isOnline ? 'Session-status--online' : 'Session-status--offline'}>
                    {player.isOnline ? 'Online' : 'Offline'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="Session-card Session-oddsHistory">
            <div className="Session-cardHeader">
              <h2>Odds Timeline</h2>
              <span>{winOdds}% now</span>
            </div>
            <OddsChart history={oddsHistory} />
          </section>

        </div>
      </div>

      {logSection}
    </div>
  );
};

export default Session;

interface EmojiBubble {
  id: string;
  emoji: string;
  label: string;
  player: string;
}

const EmojiStream = ({ effects }: { effects: EmojiBubble[] }) => (
  <div className="Session-effectsStream" aria-live="polite">
    {effects.map((effect) => (
      <div key={effect.id} className="Session-effectBubble">
        <span className="Session-effectEmoji" aria-hidden="true">
          {effect.emoji}
        </span>
        <div className="Session-effectText">
          <strong>{effect.player}</strong>
          <span>{effect.label}</span>
        </div>
      </div>
    ))}
  </div>
);

type IconProps = SVGProps<SVGSVGElement>;

const iconDefaults = {
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const IconShuffle = (props: IconProps) => (
  <svg viewBox="0 0 24 24" {...iconDefaults} {...props}>
    <path d="M16 3h5v5" />
    <path d="M4 20 20 4" />
    <path d="M4 4h5" />
    <path d="M20 20V15" />
    <path d="M9 20H4v-5" />
  </svg>
);

interface OddsChartProps {
  history: Array<{ value: number; timestamp: number }>;
}

const OddsChart = ({ history }: OddsChartProps) => {
  if (!history.length) {
    return <p className="Session-oddsEmpty">Waiting for draws…</p>;
  }

  const points = history.map((entry) => ({
    x: entry.timestamp,
    y: entry.value,
  }));
  const width = 260;
  const height = 110;
  const minX = points[0].x;
  const maxX = points[points.length - 1].x || minX + 1;

  const scaleX = (value: number) => ((value - minX) / (maxX - minX || 1)) * width;
  const scaleY = (value: number) => height - (value / 100) * height;

  const colorForValue = (value: number) => {
    if (value < 25) return '#dc2626';
    if (value < 65) return '#facc15';
    return '#22c55e';
  };

  const segments: Array<{ d: string; color: string }> = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const d = `M${scaleX(prev.x).toFixed(1)} ${scaleY(prev.y).toFixed(1)} L${scaleX(curr.x).toFixed(1)} ${scaleY(curr.y).toFixed(1)}`;
    const avgValue = (prev.y + curr.y) / 2;
    segments.push({ d, color: colorForValue(avgValue) });
  }

  const lastPoint = points[points.length - 1];
  const ticks = [0, 25, 50, 75, 100];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="Session-oddsChart" role="img" aria-label="Odds timeline chart">
      {ticks.map((tick) => {
        const y = scaleY(tick);
        return (
          <g key={tick}>
            <line x1="0" y1={y} x2={width} y2={y} stroke="#e5e7eb" strokeWidth={tick === 50 ? 1.2 : 0.5} strokeDasharray={tick === 50 ? '4 4' : '2 4'} />
            <text x="0" y={y - 2} className="Session-oddsAxisLabel" aria-hidden="true">
              {tick}%
            </text>
          </g>
        );
      })}
      {segments.map((segment, index) => (
        <path key={`seg-${segment.color}-${index}`} d={segment.d} fill="none" stroke={segment.color} strokeWidth="2.5" strokeLinecap="round" />
      ))}
      <circle cx={scaleX(lastPoint.x)} cy={scaleY(lastPoint.y)} r="3.5" fill={colorForValue(lastPoint.y)} />
      <line x1="0" y1={height} x2={width} y2={height} stroke="#cbd5f5" strokeWidth="1" />
    </svg>
  );
};
