import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';

import type { Card, GameSession, Player, GuessChoice, GuessResult, GameLogEntry } from '../api/highlow';
import {
  subscribeToCurrentSession,
  makeGuess,
  startNewHighLowSession,
  subscribeToGameLog,
} from '../api/highlow';
import { usePresence } from '../hooks/usePresence';
import { useWinOdds } from '../hooks/useWinOdds';

const PLAYER_NAME_STORAGE_KEY = 'playerName';
const PLAYER_DISPLAY_NAME_STORAGE_KEY = 'playerDisplayName';

const readStoredName = (): string => {
  try {
    return localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

const readStoredDisplayName = (): string => {
  try {
    return localStorage.getItem(PLAYER_DISPLAY_NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
};

interface GuessSummary {
  playerName: string;
  displayName: string;
  guess: GuessChoice;
  result: GuessResult;
  previousCard?: Card;
}

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
  const [guessBanner, setGuessBanner] = useState<{ status: 'correct' | 'wrong'; message: string } | null>(null);
  const [latestCard, setLatestCard] = useState<{ card: Card; correct: boolean } | null>(null);
  const [turnNotice, setTurnNotice] = useState<string | null>(null);
  const [localPlayerName] = useState<string>(() => readStoredName());
  const [localDisplayName] = useState<string>(() => readStoredDisplayName());
  const previousSessionRef = useRef<GameSession | null>(null);
  const [logEntries, setLogEntries] = useState<GameLogEntry[]>([]);
  const logRef = useRef<HTMLUListElement | null>(null);
  const winOdds = useWinOdds(session);

  usePresence(localPlayerName || null, Boolean(session));
  const formatPlayerLabel = (player?: Player) => player?.displayName ?? player?.name ?? '—';

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
    });
    return () => {
      unsubscribe();
      setLogEntries([]);
    };
  }, []);

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
    }
  }, [session?.status, session?.players.length]);

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
    }
    previousSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!lastGuess) {
      return;
    }
    const { displayName, guess, result, previousCard } = lastGuess;
    const prevLabel = previousCard ? previousCard.label : 'the starting card';
    const status = result.correct ? 'correct' : 'wrong';
    const comparison =
      previousCard && previousCard.label
        ? `${result.drawnCard.label} (${guess === 'higher' ? 'vs higher than' : 'vs lower than'} ${prevLabel})`
        : result.drawnCard.label;
    setGuessBanner({
      status,
      message: `${status === 'correct' ? '✅' : '❌'} ${displayName} guessed ${guess} and drew ${comparison}`,
    });
    setLatestCard({ card: result.drawnCard, correct: result.correct });
    const timer = window.setTimeout(() => setGuessBanner(null), 2200);
    return () => window.clearTimeout(timer);
  }, [lastGuess]);

  const activePlayer: Player | undefined = useMemo(() => {
    if (!session) {
      return undefined;
    }
    return session.players[session.turnIndex];
  }, [session]);

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

  const sessionAllowsGuess =
    !!session &&
    (session.status === 'active' ||
      (session.status === 'waiting' && session.players[session.turnIndex]?.pile.length === 0));

  const guessButtonsDisabled = !sessionAllowsGuess || !isLocalPlayersTurn || isGuessing;

  const appendCardOptimistically = (drawnCard: Card) => {
    setSession((prev) => {
      if (!prev) {
        return prev;
      }
      const nextPlayers = prev.players.map((player) => {
        if (player.name.toLowerCase() !== localPlayerName.toLowerCase()) {
          return player;
        }
        const hasCard = player.pile.some(
          (card) => card.rank === drawnCard.rank && card.suit === drawnCard.suit
        );
        if (hasCard) {
          return player;
        }
        return {
          ...player,
          pile: [...player.pile, drawnCard],
        };
      });
      return { ...prev, players: nextPlayers };
    });
  };

  const handleGuess = async (choice: GuessChoice) => {
    if (!session || !localPlayerName) {
      return;
    }
    setGuessError(null);
    setIsGuessing(true);
    try {
      const currentPlayerRecord = session.players[session.turnIndex];
      const previousCard = currentPlayerRecord?.pile[currentPlayerRecord.pile.length - 1];
      const result = await makeGuess(localPlayerName, choice);
      setLastGuess({
        playerName: localPlayerName,
        displayName: localDisplayName || localPlayerName,
        guess: choice,
        result,
        previousCard,
      });
      appendCardOptimistically(result.drawnCard);
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
  const sessionWinner =
    session.players.reduce<Player | null>((leader, player) => {
      if (!leader || player.pile.length > leader.pile.length) {
        return player;
      }
      return leader;
    }, null) ?? null;
  const winnerMessage = sessionWinner
    ? `${formatPlayerLabel(sessionWinner)} wins with ${sessionWinner.pile.length} cards!`
    : 'Great game!';

  const remaining = session.deck.length;
  const openPiles = session.players.filter((player) => player.isActive).length;
  let oddsLabel = 'Even';
  if (winOdds <= 45) {
    oddsLabel = 'Deck Favored';
  } else if (winOdds >= 65) {
    oddsLabel = 'Players Favored';
  }

  return (
    <div className={`Session ${sessionComplete ? 'fade-complete' : ''}`}>
      {guessBanner ? <div className={`guess-banner ${guessBanner.status}`}>{guessBanner.message}</div> : null}
      <header className="Session-header">
        <div>
          <h1>Shared Session</h1>
          <p>Status: {session.status}</p>
        </div>
        <div>
          <p>Turn #{session.turnIndex + 1}</p>
          <p>Current player: {formatPlayerLabel(activePlayer)}</p>
        </div>
      </header>

      <section className="Session-controls">
        <h2>Take a Guess</h2>
        <p>
          {isLocalPlayersTurn
            ? 'It’s your turn—choose higher or lower.'
            : sessionAllowsGuess
              ? `${formatPlayerLabel(activePlayer)} is thinking…`
              : 'Waiting for the round to start.'}
        </p>
        <div className="Session-actions">
          <button type="button" onClick={() => handleGuess('higher')} disabled={guessButtonsDisabled}>
            {isGuessing ? 'Guessing…' : 'Guess Higher'}
          </button>
          <button type="button" onClick={() => handleGuess('lower')} disabled={guessButtonsDisabled}>
            {isGuessing ? 'Guessing…' : 'Guess Lower'}
          </button>
        </div>
        {guessError ? (
          <p role="alert" className="Session-error">
            {guessError}
          </p>
        ) : null}
        {lastGuess ? (
          <div className="Session-summary">
            {(() => {
              const nextPlayerDetails =
                (lastGuess.result.nextPlayer &&
                  session.players.find((player) => player.name === lastGuess.result.nextPlayer)) ||
                undefined;
              return (
                <>
                  <p>
                    {`${lastGuess.displayName} guessed ${lastGuess.guess} — drew ${lastGuess.result.drawnCard.label} — ${
                      lastGuess.result.correct ? 'Correct!' : 'Incorrect!'
                    }`}
                  </p>
                  <p>Cards remaining: {lastGuess.result.remainingCards}</p>
                  {lastGuess.result.nextPlayer ? (
                    <p>Next player: {formatPlayerLabel(nextPlayerDetails)}</p>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : null}
        {turnNotice ? <p className="Session-notice">{turnNotice}</p> : null}
        {latestCard ? (
          <div className="card-reveal">
            <div className={`card-inner ${latestCard.correct ? 'correct' : 'wrong'}`}>
              {latestCard.card.label}
            </div>
            <p>{latestCard.correct ? 'Nice call!' : 'Better luck next draw.'}</p>
          </div>
        ) : null}
      </section>

      {session.status === 'complete' ? (
        <section className="Session-complete">
          <h2>🎉 Game Over</h2>
          <p>{winnerMessage}</p>
          <button type="button" onClick={handleStartNewGame} disabled={isResetting}>
            {isResetting ? 'Resetting…' : 'Start New Game'}
          </button>
          {resetError ? (
            <p role="alert" className="Session-error">
              {resetError}
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <h2>Players</h2>
        <ul className="Session-playerList">
          {session.players.map((player) => (
            <li
              key={player.name}
              className={`Session-player ${player.isActive ? 'active' : 'inactive'}${
                player.name === session.players[session.turnIndex]?.name ? ' turn' : ''
              }`}
            >
              <div className="Session-playerHeader">
                <strong>{formatPlayerLabel(player)}</strong>
                {player.isActive ? <span className="Session-pill">Active</span> : null}
              </div>
              <div className="Session-playerMeta">
                <span
                  className={
                    player.isOnline
                      ? 'Session-status Session-status--online'
                      : 'Session-status Session-status--offline'
                  }
                >
                  <span
                    className={
                      player.isOnline
                        ? 'Session-statusDot Session-statusDot--online'
                        : 'Session-statusDot Session-statusDot--offline'
                    }
                  />
                  {player.isOnline ? 'Online' : 'Offline'}
                </span>
                <span>Cards in pile: {player.pile.length}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Deck Snapshot</h2>
        <p>Total cards: {session.deck.length}</p>
      </section>

      <section className="win-odds">
        <p>🂠 {remaining} cards remaining</p>
        <p>🪣 {openPiles} piles open</p>
        <p>
          Players’ Odds vs Deck:{' '}
          <span
            className={
              winOdds <= 45 ? 'odds-red' : winOdds >= 65 ? 'odds-green' : 'odds-yellow'
            }
          >
            {winOdds}% ({oddsLabel})
          </span>
        </p>
      </section>

      <section className="Session-log">
        <h2>Game Log</h2>
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
    </div>
  );
};

export default Session;
