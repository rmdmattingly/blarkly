import { useEffect } from 'react';

import { reportPresence } from '../api/highlow';

type PresenceReporter = (playerName: string, isOnline: boolean) => Promise<void>;

const HEARTBEAT_INTERVAL_MS = 6_000;

export const usePresence = (
  playerName: string | null,
  enabled: boolean,
  reporter: PresenceReporter = reportPresence
): void => {
  useEffect(() => {
    if (!playerName || !enabled) {
      return;
    }

    const sendPresence = (online: boolean) => {
      void reporter(playerName, online).catch((error) => {
        console.error('Presence update failed', error);
      });
    };

    sendPresence(true);
    const intervalId = window.setInterval(() => sendPresence(true), HEARTBEAT_INTERVAL_MS);

    const handleBeforeUnload = () => {
      sendPresence(false);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.clearInterval(intervalId);
      sendPresence(false);
    };
  }, [playerName, enabled, reporter]);
};
