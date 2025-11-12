import type { GameSession } from '../types';

const RANK_SUCCESS: Record<number, number> = {
  1: 1.0,
  2: 0.917,
  3: 0.833,
  4: 0.75,
  5: 0.667,
  6: 0.583,
  7: 0.5,
  8: 0.583,
  9: 0.667,
  10: 0.75,
  11: 0.833,
  12: 0.917,
  13: 1.0,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const getRankProbability = (rank: number | undefined): number => {
  if (!rank || rank < 1 || rank > 13) {
    return 0.5;
  }
  return RANK_SUCCESS[rank] ?? 0.5;
};

const cumulativeBinomial = (trials: number, successProb: number, maxFailures: number): number => {
  if (trials <= 0) {
    return 1;
  }
  if (successProb <= 0) {
    return maxFailures >= trials ? 1 : 0;
  }
  if (successProb >= 1) {
    return 1;
  }

  const cappedFailures = Math.min(Math.max(maxFailures, 0), trials);
  const failureProb = 1 - successProb;
  let combination = 1;
  let cumulative = 0;

  for (let failures = 0; failures <= cappedFailures; failures += 1) {
    const successCount = trials - failures;
    const term =
      combination *
      Math.pow(successProb, successCount) *
      Math.pow(failureProb, failures);
    cumulative += term;
    if (failures === cappedFailures) {
      break;
    }
    combination = (combination * (trials - failures)) / (failures + 1);
  }

  return clamp(cumulative, 0, 1);
};

const averageSuccessProbability = (session: GameSession): number => {
  const openPiles = session.piles.filter((pile) => pile.isFaceUp);
  if (!openPiles.length) {
    return 0;
  }
  const total = openPiles.reduce((sum, pile) => {
    const topCard = pile.cards[pile.cards.length - 1];
    return sum + getRankProbability(topCard?.rank);
  }, 0);
  return total / openPiles.length;
};

export const calculateWinOdds = (session: GameSession | null | undefined): number => {
  if (!session) {
    return 0;
  }

  const remainingCards = session.deck.length;
  if (remainingCards <= 0) {
    return 100;
  }

  const openPiles = session.piles.filter((pile) => pile.isFaceUp);
  if (!openPiles.length) {
    return 0;
  }

  const allowedFailures = Math.max(openPiles.length - 1, 0);
  const successProb = averageSuccessProbability(session);

  if (allowedFailures >= remainingCards) {
    return 100;
  }

  const probability = cumulativeBinomial(remainingCards, successProb, allowedFailures);
  return Math.round(probability * 100);
};
