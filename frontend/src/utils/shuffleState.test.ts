import { deriveShuffleLock } from './shuffleState';

describe('deriveShuffleLock', () => {
  it('locks when pending', () => {
    expect(deriveShuffleLock({ pending: true, awaiting: false, serverLockUntil: null, clientLockUntil: null, now: 0 }).locked).toBe(true);
  });

  it('locks when awaiting', () => {
    expect(deriveShuffleLock({ pending: false, awaiting: true, serverLockUntil: null, clientLockUntil: null, now: 0 }).locked).toBe(true);
  });

  it('locks when server lock is in future', () => {
    expect(deriveShuffleLock({ pending: false, awaiting: false, serverLockUntil: 10, clientLockUntil: null, now: 0 }).locked).toBe(true);
  });

  it('locks when client lock is in future', () => {
    expect(deriveShuffleLock({ pending: false, awaiting: false, serverLockUntil: null, clientLockUntil: 5, now: 0 }).locked).toBe(true);
  });

  it('unlocks when all signals are clear', () => {
    expect(deriveShuffleLock({ pending: false, awaiting: false, serverLockUntil: null, clientLockUntil: null, now: 0 }).locked).toBe(false);
  });
});
