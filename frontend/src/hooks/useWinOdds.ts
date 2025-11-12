import { useMemo } from 'react';
import type { GameSession } from '../types';
import { calculateWinOdds } from '../utils/calcWinOdds';

export function useWinOdds(session: GameSession | null): number {
  return useMemo(() => calculateWinOdds(session), [session]);
}
