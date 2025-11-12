export type SuitSymbol = '♠' | '♥' | '♦' | '♣';

export interface Card {
  suit: SuitSymbol;
  rank: number; // 1..13 (Ace low)
}

export interface Deck {
  remaining: Card[];
  discard?: Card[];
}

export interface Pile {
  id: number;
  cards: Card[];
  isOpen: boolean;
}

export interface Player {
  name: string;
  isOnline: boolean;
  isActive: boolean;
  lastSeen?: string;
}

export type GuessType = 'higher' | 'lower';

export interface TurnRecord {
  turnNumber: number;
  playerName: string;
  pileId: number;
  guess: GuessType;
  revealed: Card[];
  outcome: 'correct' | 'incorrect';
  timestamp: string;
}

export type GamePhase = 'waiting' | 'in-progress' | 'players-win' | 'deck-wins';

export interface HighLowSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  deck: Deck;
  piles: Pile[];
  players: Record<string, Player>;
  turnOrder: string[];
  currentTurn: number;
  history: TurnRecord[];
  phase: GamePhase;
}

const SUITS: SuitSymbol[] = ['♠', '♥', '♦', '♣'];
const RANKS: number[] = Array.from({ length: 13 }, (_, idx) => idx + 1);
const DEFAULT_PILE_COUNT = 9;

export const generateDeck = (): Card[] => {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ suit, rank });
    }
  }
  return cards;
};

export const shuffle = (deck: Card[]): Card[] => {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

export const drawCard = (deck: Deck): [Card | null, Deck] => {
  if (!deck.remaining.length) {
    return [null, deck];
  }
  const [card, ...rest] = deck.remaining;
  return [
    card,
    {
      remaining: rest,
      discard: deck.discard,
    },
  ];
};

export const getOpenPiles = (session: HighLowSession): Pile[] => {
  return session.piles.filter((pile) => pile.isOpen);
};

const compareCards = (a: Card | undefined, b: Card | undefined): number => {
  if (!a || !b) {
    return 0;
  }
  if (a.rank === b.rank) {
    return 0;
  }
  return a.rank > b.rank ? 1 : -1;
};

export const resolveGuess = (
  pile: Pile,
  guess: GuessType,
  drawnCards: Card[]
): { pile: Pile; outcome: 'correct' | 'incorrect' } => {
  const updatedPile: Pile = {
    ...pile,
    cards: [...pile.cards, ...drawnCards],
  };

  if (!drawnCards.length || pile.cards.length === 0) {
    return { pile: updatedPile, outcome: 'correct' };
  }

  const baseline = pile.cards[pile.cards.length - 1];
  const resolutionCard = drawnCards[drawnCards.length - 1];
  const comparison = compareCards(baseline, resolutionCard);

  if (comparison === 0) {
    return { pile: updatedPile, outcome: 'correct' };
  }

  const isCorrect =
    (guess === 'higher' && resolutionCard.rank > baseline.rank) ||
    (guess === 'lower' && resolutionCard.rank < baseline.rank);

  if (!isCorrect) {
    updatedPile.isOpen = false;
  }

  return {
    pile: updatedPile,
    outcome: isCorrect ? 'correct' : 'incorrect',
  };
};

export const checkGamePhase = (session: HighLowSession): GamePhase => {
  const anyOpen = session.piles.some((pile) => pile.isOpen);
  if (!anyOpen) {
    return 'deck-wins';
  }
  if (session.deck.remaining.length === 0) {
    return 'players-win';
  }
  return session.phase === 'waiting' ? 'in-progress' : session.phase;
};

export const advanceTurn = (session: HighLowSession): number => {
  if (!session.turnOrder.length) {
    return 0;
  }
  return (session.currentTurn + 1) % session.turnOrder.length;
};

export const initSession = (playerNames: string[]): HighLowSession => {
  const timestamp = new Date().toISOString();
  const normalizedPlayers = Array.from(
    new Set(
      playerNames
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0)
    )
  );

  const shuffled = shuffle(generateDeck());
  const dealt = shuffled.slice(0, DEFAULT_PILE_COUNT);
  const remaining = shuffled.slice(DEFAULT_PILE_COUNT);

  const piles: Pile[] = Array.from({ length: DEFAULT_PILE_COUNT }).map((_, idx) => {
    const card = dealt[idx];
    return {
      id: idx,
      cards: card ? [card] : [],
      isOpen: Boolean(card),
    };
  });

  const players: Record<string, Player> = {};
  normalizedPlayers.forEach((name) => {
    players[name] = {
      name,
      isOnline: true,
      isActive: true,
      lastSeen: timestamp,
    };
  });

  return {
    id: 'session',
    createdAt: timestamp,
    updatedAt: timestamp,
    deck: {
      remaining,
      discard: [],
    },
    piles,
    players,
    turnOrder: normalizedPlayers,
    currentTurn: 0,
    history: [],
    phase: normalizedPlayers.length ? 'in-progress' : 'waiting',
  };
};
