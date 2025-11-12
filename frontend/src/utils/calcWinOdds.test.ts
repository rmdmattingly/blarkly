import type { Card, GameSession, TablePile } from '../api/highlow';
import { calculateWinOdds } from './calcWinOdds';

const mockCard = (rank: number = 5): Card => ({
  rank,
  suit: 'hearts',
  label: `${rank}♥`,
});

const buildPile = (id: number, options: { faceUp?: boolean; depth?: number; topRank?: number } = {}): TablePile => {
  const { faceUp = true, depth = 1, topRank = 5 } = options;
  return {
    id: `pile-${id}`,
    row: Math.floor(id / 3),
    column: id % 3,
    isFaceUp: faceUp,
    cards: Array.from({ length: Math.max(depth, 1) }, () => mockCard(topRank)),
  };
};

const buildSession = (config: {
  deckSize: number;
  activePileCount: number;
  inactivePileCount?: number;
  depth?: number;
  topRank?: number;
}): GameSession => {
  const { deckSize, activePileCount, inactivePileCount = 0, depth = 1, topRank = 5 } = config;
  const piles: TablePile[] = [];
  for (let i = 0; i < activePileCount; i += 1) {
    piles.push(buildPile(i, { faceUp: true, depth, topRank }));
  }
  for (let i = 0; i < inactivePileCount; i += 1) {
    piles.push(buildPile(activePileCount + i, { faceUp: false, depth }));
  }

  return {
    id: 'current',
    players: [
      { name: 'alice', isActive: true, isOnline: true },
      { name: 'deck', isActive: false, isOnline: false },
    ],
    deck: Array.from({ length: deckSize }, (_, index) => mockCard((index % 13) + 1)),
    piles,
    turnIndex: 0,
    status: 'active',
    settings: { acesHigh: false },
    createdAt: {} as never,
    updatedAt: {} as never,
  };
};

describe('calculateWinOdds', () => {
  it('returns 0 when session is missing', () => {
    expect(calculateWinOdds(null)).toBe(0);
  });

  it('returns 100 when deck is empty', () => {
    const session = buildSession({ deckSize: 0, activePileCount: 3 });
    expect(calculateWinOdds(session)).toBe(100);
  });

  it('returns 0 when no piles remain face up', () => {
    const session = buildSession({ deckSize: 20, activePileCount: 0, inactivePileCount: 5 });
    expect(calculateWinOdds(session)).toBe(0);
  });

  it('returns higher odds when many piles remain compared to a single pile', () => {
    const thin = buildSession({ deckSize: 12, activePileCount: 1, inactivePileCount: 8, topRank: 2 });
    const strong = buildSession({ deckSize: 12, activePileCount: 6, inactivePileCount: 3, topRank: 2 });
    const thinOdds = calculateWinOdds(thin);
    const strongOdds = calculateWinOdds(strong);
    expect(thinOdds).toBeLessThan(strongOdds);
    expect(strongOdds).toBeGreaterThan(60);
  });

  it('improves odds when top cards are favorable ranks', () => {
    const tough = buildSession({ deckSize: 20, activePileCount: 4, topRank: 7 });
    const easy = buildSession({ deckSize: 20, activePileCount: 4, topRank: 2 });
    expect(calculateWinOdds(easy)).toBeGreaterThan(calculateWinOdds(tough));
  });

  it('approaches 100 when deck is thin and many piles are open', () => {
    const session = buildSession({ deckSize: 4, activePileCount: 6, topRank: 2 });
    expect(calculateWinOdds(session)).toBeGreaterThan(85);
  });
});
