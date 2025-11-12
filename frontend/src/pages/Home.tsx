import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';

import GameNav from '../components/GameNav';
import { cleanupHighLowPlayers } from '../api/highlow';
import { cleanupOldMaidPlayers } from '../api/oldmaid';
import { db } from '../firebaseConfig';
import { persistDisplayName, persistName, readStoredDisplayName, readStoredName } from '../utils/playerName';

const Home = () => {
  const storedName = readStoredName();
  const storedDisplayName = readStoredDisplayName();
  const initialDisplayName = storedDisplayName || storedName || '';
  const initialSaved = Boolean(storedName);
  const [playerName, setPlayerName] = useState<string>(initialDisplayName);
  const [displayName, setDisplayName] = useState<string>(initialDisplayName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(initialSaved);
  const [onlineCounts, setOnlineCounts] = useState<{ highlow: number | null; oldmaid: number | null }>({
    highlow: null,
    oldmaid: null,
  });

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = playerName.trim();
    if (!trimmed) {
      setError('Please enter a player name.');
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (!normalized) {
      setError('Please enter a player name.');
      return;
    }
    setSaving(true);
    setError(null);
    persistName(normalized);
    persistDisplayName(trimmed);
    setDisplayName(trimmed);
    setSaved(true);
    setTimeout(() => setSaving(false), 100);
  };

  const handleChangeName = () => {
    setSaved(false);
    setError(null);
    setSaving(false);
    setPlayerName(displayName);
  };

  useEffect(() => {
    if (!saved) {
      return undefined;
    }
    let canceled = false;
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        await cleanupHighLowPlayers();
      } catch {
        // ignore
      }
      if (canceled) {
        return;
      }
      const highlowRef = doc(db, 'games', 'highlow', 'sessions', 'current');
      unsubscribe = onSnapshot(
        highlowRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            setOnlineCounts((prev) => ({ ...prev, highlow: 0 }));
            return;
          }
          const data = snapshot.data() as { players?: Array<{ isOnline?: boolean }> };
          const list = Array.isArray(data.players) ? data.players : [];
          const online = list.filter((player) => player?.isOnline).length;
          setOnlineCounts((prev) => ({ ...prev, highlow: online }));
        },
        () => {
          setOnlineCounts((prev) => ({ ...prev, highlow: 0 }));
        }
      );
    })();
    return () => {
      canceled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [saved]);

  useEffect(() => {
    if (!saved) {
      return undefined;
    }
    let canceled = false;
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        await cleanupOldMaidPlayers();
      } catch {
        // ignore
      }
      if (canceled) {
        return;
      }
      const oldMaidRef = doc(db, 'games', 'oldmaid', 'sessions', 'current');
      unsubscribe = onSnapshot(
        oldMaidRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            setOnlineCounts((prev) => ({ ...prev, oldmaid: 0 }));
            return;
          }
          const data = snapshot.data() as { players?: Array<{ isOnline?: boolean }> };
          const list = Array.isArray(data.players) ? data.players : [];
          const online = list.filter((player) => player?.isOnline).length;
          setOnlineCounts((prev) => ({ ...prev, oldmaid: online }));
        },
        () => {
          setOnlineCounts((prev) => ({ ...prev, oldmaid: 0 }));
        }
      );
    })();
    return () => {
      canceled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [saved]);

  return (
    <div className="Home">
      <GameNav />
      {saved ? (
        <div className="Home-card">
          <h1>Welcome, {displayName || 'friend'}!</h1>
          <p>Choose a game below to jump back into the action.</p>
          <button type="button" className="Home-link Home-link--secondary" onClick={handleChangeName}>
            Change Name
          </button>
        </div>
      ) : (
        <div className="Home-card">
          <h1>Welcome to Blarkly</h1>
          <p>Start by choosing a display name. You can change it any time.</p>
          <form onSubmit={handleSave} className="Home-form">
            <label htmlFor="homePlayerName">Player Name</label>
            <input
              id="homePlayerName"
              type="text"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="e.g. Zola"
              disabled={saving}
              required
            />
            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save Name'}
            </button>
          </form>
          {error ? (
            <p role="alert" className="Home-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
      {saved ? (
        <div className="Home-grid">
          <section className="Home-card">
            <h1>High/Low</h1>
            <p>Take turns guessing whether the next card is higher or lower. Keep at least one pile alive to beat the deck.</p>
            <p className="Home-status">
              {onlineCounts.highlow == null ? 'Checking players…' : `${onlineCounts.highlow} online`}
            </p>
            <Link className="Home-link" to="/games/highlow">
              Enter High/Low
            </Link>
          </section>
          <section className="Home-card">
            <h1>Old Maid</h1>
            <p>Pair up cards, pass one to your neighbor, and avoid getting stuck with the Old Maid card.</p>
            <p className="Home-status">
              {onlineCounts.oldmaid == null ? 'Checking players…' : `${onlineCounts.oldmaid} online`}
            </p>
            <Link className="Home-link" to="/games/oldmaid">
              Enter Old Maid
            </Link>
          </section>
        </div>
      ) : (
        <p className="Home-note">Save your name to unlock the game selection.</p>
      )}
    </div>
  );
};

export default Home;
