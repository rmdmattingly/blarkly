import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import GameNav from '../components/GameNav';
import { joinOrCreateHighLowSession } from '../api/highlow';
import { readStoredDisplayName, readStoredName } from '../utils/playerName';

const HighLowLobby = () => {
  const navigate = useNavigate();
  const storedName = readStoredName();
  const storedDisplayName = readStoredDisplayName();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!storedName) {
      navigate('/');
      return;
    }
    let active = true;
    setJoining(true);
    joinOrCreateHighLowSession(storedName, storedDisplayName || storedName)
      .then((sessionId) => {
        if (active) {
          navigate(`/session/${sessionId}`);
        }
      })
      .catch((err) => {
        console.error('Failed to join High/Low', err);
        if (active) {
          setError('Unable to join the shared session right now. Please try again.');
          setJoining(false);
        }
      });
    return () => {
      active = false;
    };
  }, [storedName, storedDisplayName, navigate]);

  return (
    <div className="Home">
      <GameNav />
      <div className="Home-card">
        <h1>High/Low Lobby</h1>
        {storedName ? (
          <p>Connecting as {storedDisplayName || storedName}…</p>
        ) : (
          <p>Please set your name first.</p>
        )}
        {joining && !error ? <p className="Home-note">Joining shared session…</p> : null}
        {error ? (
          <p role="alert" className="Home-error">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export default HighLowLobby;

