import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { joinOrCreateHighLowSession } from '../api/highlow';

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

const persistName = (value: string): void => {
  try {
    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures (e.g., Safari private mode)
  }
};

const persistDisplayName = (value: string): void => {
  try {
    localStorage.setItem(PLAYER_DISPLAY_NAME_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures
  }
};

const Home = () => {
  const navigate = useNavigate();
  const [playerName, setPlayerName] = useState<string>(() => readStoredDisplayName() || readStoredName());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = playerName.trim();
    if (!trimmedName) {
      setError('Please enter a player name.');
      return;
    }
    const normalized = trimmedName.toLowerCase();
    if (!normalized) {
      setError('Please enter a player name.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const sessionId = await joinOrCreateHighLowSession(normalized, trimmedName);
      persistName(normalized);
      persistDisplayName(trimmedName);
      navigate(`/session/${sessionId}`);
    } catch (joinError) {
      console.error('Failed to join or create session', joinError);
      setError('Unable to join the shared session right now. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="Home">
      <div className="Home-card">
        <h1>Blarkly High/Low</h1>
        <p>Enter your name to hop into the shared High/Low table.</p>
        <form onSubmit={handleSubmit} className="Home-form">
          <label htmlFor="playerName">Player Name</label>
          <input
            id="playerName"
            name="playerName"
            type="text"
            value={playerName}
            onChange={(event) => setPlayerName(event.target.value)}
            placeholder="e.g. Ada"
            disabled={submitting}
            required
          />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Connecting…' : 'Join the Session'}
          </button>
        </form>
        {error ? (
          <p role="alert" className="Home-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default Home;
