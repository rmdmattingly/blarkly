# Old Maid – Blarkly Rulebook

## Overview
Old Maid is a lighthearted elimination game where everyone races to shed pairs of matching cards. Players form pairs (same rank, any suits) from their hand and discard them to the table. One odd card remains in the deck after setup (the “Old Maid”). When the dust settles, the unlucky player holding that odd card loses, while everyone else shares the win.

## Deck & Setup
1. Start with a standard 52‑card deck, **remove one queen** (traditionally the Queen of Clubs), and add a single Joker card. The Joker is never part of a pair; whoever holds it at the end is the Old Maid.
2. Shuffle thoroughly using Fisher–Yates.
3. Deal the entire deck face‑down to all seated players, clockwise. Some players may receive one extra card—that’s expected.
4. Each player immediately reveals their hand, removes any pairs (same rank, e.g., A♣ + A♥), and places them face‑up in their personal discard pile. The suits don’t matter. Players should reshuffle their remaining cards and keep them hidden once the initial cleanup ends.

## Turn Structure
1. Seat players in a fixed circular order (index 0 → n‑1). The active player draws from the player on their **left** (i.e., the next index, wrapping around).
2. The target player fans their hand face‑down. The active player picks **exactly one card** at random (UI: tap-to-select).
3. The active player adds the drawn card to their hand, checks for any new pairs, and discards them immediately.
4. Play passes clockwise to the next seated player.

## Pairing Rules
- Only rank matters (3♣ pairs 3♦, etc.).
- Multiple cards of the same rank can form multiple pairs; leftovers stay in hand.
- Discarded pairs are visible to everyone for audit/debug purposes.

## Ending the Game
- When a player runs out of cards, they are “safe” and skip future turns.
- Play continues among players with cards until only one card remains in circulation.
- The player forced to hold the lone unpaired card (the Old Maid) is the loser; everyone else wins.

## Multiplayer/Realtime Constraints
- Because state is tightly coupled, **no mid-game joins** are allowed. A new player can only join when the session is in `waiting` status.
- Starting a new game should capture the set of currently online players, lock the table, and deal immediately.
- If a player disconnects mid-hand, the backend should keep their cards and auto-pass until they return. (Future enhancement: allow vote to boot.)

## Firestore Shape (initial proposal)
```
games/oldmaid/sessions/current
{
  status: 'waiting' | 'active' | 'complete',
  createdAt, updatedAt,
  deck: Card[],              // face-down draw deck (should be empty once dealing finishes)
  players: [
    {
      name: string,
      displayName?: string,
      hand: Card[],
      discards: Card[][],    // list of revealed pairs
      isOnline: boolean,
      isSafe: boolean,       // true once hand empty
    }
  ],
  turnIndex: number,
  oldMaidHolder?: string,    // winner/loser record at end
}
```

## UX Checklist
- Lobby lets users pick **High/Low** or **Old Maid** before joining.
- Old Maid board shows each player, card counts, and discard piles.
- Center panel highlights whose turn it is and lets them draw a card from the neighbor (tap/click interface).
- “Start New Game” button appears only when status=`waiting` and at least 2 players are online; once started it locks seating.
- Game over banner identifies the Old Maid holder (“Cassie drew the last card — Otto is the Old Maid!”) and offers a rematch with the same roster.

Keep this file synced with gameplay changes so frontend + backend stay aligned.
