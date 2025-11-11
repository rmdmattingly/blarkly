import { useMemo } from 'react';
import type { GameSession } from '../types';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function useWinOdds(session: GameSession | null): number {
  return useMemo(() => {
    if (!session) {
      return 0;
    }

    const remainingCards = session.deck.length;
    const activePiles = session.players
      .filter((player) => player.isActive)
      .map((player) => ({
        cards: player.pile,
        topCard: player.pile[player.pile.length - 1] ?? null,
      }));

    if (remainingCards === 0) {
      return 100;
    }
    if (!activePiles.length) {
      return 0;
    }

    const topRanks = activePiles
      .map((pile) => pile.topCard?.rank)
      .filter((rank): rank is number => typeof rank === 'number');

    const avgDepth =
      activePiles.reduce((sum, pile) => sum + pile.cards.length, 0) /
      Math.max(activePiles.length, 1);

    const mean =
      topRanks.reduce((a, b) => a + b, 0) / Math.max(topRanks.length, 1);
    const stdDev =
      topRanks.length > 1
        ? Math.sqrt(
            topRanks
              .map((rank) => Math.pow(rank - mean, 2))
              .reduce((a, b) => a + b, 0) /
              (topRanks.length - 1)
          )
        : 0;

    const pileFactor = Math.pow(activePiles.length / 9, 1.8);
    const depthFactor = clamp(avgDepth / 6, 0, 1);
    const diversityFactor = clamp(stdDev / 4, 0, 1);
    const baseResilience =
      0.55 * pileFactor + 0.3 * depthFactor + 0.15 * diversityFactor;

    const fatigue = remainingCards / 52;
    const odds = 1 / (1 + Math.exp(4.5 * (fatigue - baseResilience - 0.25)));

    return Math.round(clamp(odds, 0, 1) * 100);
  }, [session]);
}
