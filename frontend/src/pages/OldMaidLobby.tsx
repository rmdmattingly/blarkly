import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import GameNav from '../components/GameNav';
import { joinOldMaidSession } from '../api/oldmaid';
import { readStoredDisplayName, readStoredName } from '../utils/playerName';

const GAME_IN_PROGRESS_MESSAGE =
  'Another Old Maid round is in progress. Please wait for it to finish — we will retry automatically.';
const RETRY_DELAY_MS = 5000;

const isGameInProgressError = (error: unknown): boolean => {
  if (!error) {
    return false;
  }
  const message = typeof (error as Error)?.message === 'string' ? (error as Error).message : '';
  const details = (error as { details?: unknown })?.details;
  const code = typeof (error as { code?: string })?.code === 'string' ? (error as { code?: string }).code : '';
  if (typeof details === 'string' && details.includes('game_in_progress')) {
    return true;
  }
  if (message.includes('game_in_progress')) {
    return true;
  }
  return code === 'functions/failed-precondition' && message.includes('game');
};

const OldMaidLobby = () => {
  const navigate = useNavigate();
  const storedName = readStoredName();
  const storedDisplayName = readStoredDisplayName();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [waitingForGame, setWaitingForGame] = useState(false);
  const retryTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!storedName) {
      navigate('/');
      return;
    }
    let active = true;

    const clearRetryTimer = () => {
      if (retryTimeoutRef.current) {
        window.clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };

    const attemptJoin = () => {
      if (!active) {
        return;
      }
      setJoining(true);
      joinOldMaidSession(storedName, storedDisplayName || storedName)
        .then((sessionId) => {
          if (!active) {
            return;
          }
          clearRetryTimer();
          setWaitingForGame(false);
          setError(null);
          navigate(`/old-maid/session/${sessionId}`);
        })
        .catch((err) => {
          console.error('Failed to join Old Maid session', err);
          if (!active) {
            return;
          }
          if (isGameInProgressError(err)) {
            setWaitingForGame(true);
            setJoining(false);
            setError(null);
            clearRetryTimer();
            retryTimeoutRef.current = window.setTimeout(() => {
              attemptJoin();
            }, RETRY_DELAY_MS);
            return;
          }
          clearRetryTimer();
          setWaitingForGame(false);
          setError('Unable to join the Old Maid table right now.');
          setJoining(false);
        });
    };

    attemptJoin();

    return () => {
      active = false;
      clearRetryTimer();
    };
  }, [storedName, storedDisplayName, navigate]);

  return (
    <div className="Home">
      <GameNav />
      <div className="Home-card">
        <h1>Old Maid Lobby</h1>
        {storedName ? (
          <p>Connecting as {storedDisplayName || storedName}…</p>
        ) : (
          <p>Please set your name first.</p>
        )}
        {joining && !error && !waitingForGame ? <p className="Home-note">Joining shared table…</p> : null}
        {waitingForGame ? (
          <p className="Home-note" role="status">
            {GAME_IN_PROGRESS_MESSAGE}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="Home-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default OldMaidLobby;
