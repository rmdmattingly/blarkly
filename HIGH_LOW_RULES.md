# High/Low – Blarkly Rulebook

## Overview
High/Low is a cooperative game where all human players face “the deck.” Everyone shares a single 52‑card deck (Aces are low = 1). The deck wins if every pile gets flipped face‑down before the deck runs out. The players win if at least one pile stays face‑up through the final card.

## Setup
1. Shuffle the full deck using Fisher–Yates.
2. Deal the first **9 cards** face‑up into a **3×3 grid** (rows of 3). These become the starting top cards for nine piles (P1…P9) and remain laid out visually in that grid.
3. Each player chooses a pile to play on during their turn. Multiple players may target the same pile across different turns.
4. The remaining 43 cards stay face‑down in the draw stack.

## Turn Structure
1. **Active player selection** – play proceeds round‑robin among the list of connected players (skip inactive / offline).
2. **Choose pile** – the active player chooses any currently face‑up pile.
3. **Declare guess** – before seeing the next card, the player guesses whether the upcoming card will be **higher** or **lower** than the selected pile’s top card.  
   - Aces = 1, Kings = 13.  
   - Ties do **not** resolve immediately (see “Tie Handling” below).
4. **Reveal card** – draw the top card from the deck.
5. **Resolve guess**
   - **Correct guess** → place the revealed card face‑up onto the chosen pile. That card is now the new reference for the pile. The pile remains “open” (face‑up).
   - **Incorrect guess** → place the revealed card onto the pile, then flip the entire pile face‑down (“locked”). That pile can no longer be used for the rest of the game.
6. **Advance turn** – move to the next eligible player. Skip anyone who is inactive or offline.

## Tie Handling
If the revealed card has the **same rank** as the pile’s top card, the guess neither succeeds nor fails yet:
- Leave the new card on the pile **face‑up**.
- Draw additional cards, one at a time, **without letting the player change their guess**, until a non‑matching rank appears.
- Once a different rank appears, resolve the original guess against that card. (All intermediate ties stay in the pile.)

## Winning and Losing
- **Players win** if at least one pile is still face‑up when the deck runs out of cards.
- **Deck wins** if every pile becomes face‑down (“locked”) before the deck is exhausted.
- **Stalemate** does not exist: ties are always broken by drawing further cards.

## Presence & Turn Rules (Implementation Notes)
- Each player has `isActive` (still in the game) and `isOnline` (currently connected). A player who disconnects stays in turn order but is skipped until they return. If all players are offline the game pauses but does not end.
- `playerLastSeen` is a map keyed by lowercase player name storing the server timestamp for their last heartbeat. Heartbeats that do not change `isOnline` are silent (to avoid log spam).
- The first nine piles along with their state (`isOpen`, top card, pile history) must be stored on the backend so every client sees identical state.

## Future UI/Logic Checklist
- Display all nine piles with their current top cards (or a flipped indicator).
- Let the active player select a pile before choosing higher/lower.
- Show the number of remaining cards plus which piles are still open.
- When a pile locks, visually flip it and mark it unavailable.
- End-of-game banner: “Players Win” if any piles remain face‑up when the deck empties, otherwise “Deck Wins.”

Keep this rulebook handy as the single source of truth for future backend and frontend work.***
