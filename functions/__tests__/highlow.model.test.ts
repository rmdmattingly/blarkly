import {
  generateDeck,
  shuffle,
  initSession,
  getOpenPiles,
  checkGamePhase,
  advanceTurn,
  resolveGuess,
} from '../src/models/highlow';

describe('High/Low model helpers', () => {
  it('generates a 52-card deck with 4 suits and 13 ranks', () => {
    const deck = generateDeck();
    expect(deck).toHaveLength(52);
    const suitCounts = deck.reduce<Record<string, number>>((acc, card) => {
      acc[card.suit] = (acc[card.suit] ?? 0) + 1;
      return acc;
    }, {});
    Object.values(suitCounts).forEach((count) => {
      expect(count).toBe(13);
    });
    const rankCounts = deck.reduce<Record<number, number>>((acc, card) => {
      acc[card.rank] = (acc[card.rank] ?? 0) + 1;
      return acc;
    }, {});
    for (let rank = 1; rank <= 13; rank += 1) {
      expect(rankCounts[rank]).toBe(4);
    }
  });

  it('initializes a session with 9 piles and players', () => {
    const session = initSession(['Ray', 'char', 'RAY']);
    expect(session.piles).toHaveLength(9);
    expect(getOpenPiles(session)).toHaveLength(9);
    expect(Object.keys(session.players)).toEqual(['ray', 'char']);
    expect(session.turnOrder).toEqual(['ray', 'char']);
    expect(session.deck.remaining.length).toBe(52 - 9);
    expect(session.phase).toBe('in-progress');
  });

  it('advances turn cyclically', () => {
    const session = initSession(['ray', 'char', 'duke']);
    expect(session.currentTurn).toBe(0);
    const next = advanceTurn(session);
    expect(next).toBe(1);
    const wrapped = advanceTurn({ ...session, currentTurn: 2 });
    expect(wrapped).toBe(0);
  });

  it('marks pile closed when guess incorrect and updates phase when all closed', () => {
    const session = initSession(['ray']);
    const pile = session.piles[0];
    const higherCard = { ...pile.cards[0], rank: pile.cards[0].rank + 1 };
    const lowerCard = { ...pile.cards[0], rank: Math.max(1, pile.cards[0].rank - 1) };
    const { pile: updated, outcome } = resolveGuess(
      pile,
      'lower',
      higherCard.rank > pile.cards[0].rank ? [higherCard] : [lowerCard]
    );
    expect(['correct', 'incorrect']).toContain(outcome);
    if (outcome === 'incorrect') {
      expect(updated.isOpen).toBe(false);
      const closedSession = {
        ...session,
        piles: session.piles.map((p, idx) => (idx === 0 ? updated : { ...p, isOpen: false })),
        deck: { ...session.deck, remaining: [] },
      };
      expect(checkGamePhase(closedSession)).toBe('deck-wins');
    }
  });

  it('returns players-win when deck empty but piles remain open', () => {
    const session = initSession(['ray']);
    const openSession = {
      ...session,
      deck: { ...session.deck, remaining: [] },
    };
    expect(checkGamePhase(openSession)).toBe('players-win');
  });

  it('shuffles deck without mutating original', () => {
    const deck = generateDeck();
    const shuffled = shuffle(deck);
    expect(deck).toHaveLength(52);
    expect(shuffled).toHaveLength(52);
    expect(deck).not.toBe(shuffled);
  });
});
