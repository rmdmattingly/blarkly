export interface ShuffleStateInput {
  pending: boolean;
  awaiting: boolean;
  serverLockUntil: number | null;
  clientLockUntil: number | null;
  now?: number;
}

export interface ShuffleStateOutput {
  locked: boolean;
}

export const deriveShuffleLock = ({ pending, awaiting, serverLockUntil, clientLockUntil, now = Date.now() }: ShuffleStateInput): ShuffleStateOutput => {
  const serverLocked = typeof serverLockUntil === 'number' && serverLockUntil > now;
  const clientLocked = typeof clientLockUntil === 'number' && clientLockUntil > now;
  return {
    locked: Boolean(pending || awaiting || serverLocked || clientLocked),
  };
};
