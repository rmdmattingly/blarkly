import { useEffect } from 'react';

import { reportPresence } from '../api/highlow';

const HEARTBEAT_INTERVAL_MS = 20_000;

export const usePresence = (playerName: string | null, enabled: boolean): void => {
  useEffect(() => {
    if (!playerName || !enabled) {
      return;
    }

    const sendPresence = (online: boolean) => {
      void reportPresence(playerName, online).catch((error) => {
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
  }, [playerName, enabled]);
};
