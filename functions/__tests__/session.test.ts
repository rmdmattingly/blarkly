jest.mock('firebase-admin');

import * as admin from 'firebase-admin';
import functionsTest from 'firebase-functions-test';
import * as backend from '../src/index';

const projectId = 'demo-test';

const fft = functionsTest({ projectId });
const wrapCallable = (fn: any) => fft.wrap(fn);
const db = admin.firestore();

const sessionRef = () =>
  db.collection('games').doc('highlow').collection('sessions').doc('current');

const resetStore = () => {
  const testingApi = (admin as any).__testing;
  if (testingApi?.reset) {
    testingApi.reset();
  }
};

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  for (const app of admin.apps) {
    if (app) {
      await app.delete();
    }
  }
  fft.cleanup();
});

describe('joinOrCreateHighLowSession', () => {
  test('creates session for first player', async () => {
    const callable = wrapCallable(backend.joinOrCreateHighLowSession);
    const response = await callable({ playerName: 'Ada' });

    expect(response.sessionId).toBe('current');

    const snapshot = await sessionRef().get();
    expect(snapshot.exists).toBe(true);
    expect(snapshot.data()?.players?.[0]?.name).toBe('ada');
  });

  test('deduplicates player on reconnect', async () => {
    const callable = wrapCallable(backend.joinOrCreateHighLowSession);

    await callable({ playerName: 'Ada' });
    const response = await callable({ playerName: 'ADA' });

    expect(response.sessionId).toBe('current');

    const snapshot = await sessionRef().get();
    const data = snapshot.data();
    expect(data?.players?.length).toBe(1);
    expect(data?.players?.[0]?.name).toBe('ada');
  });

  test('does not fail when logging throws', async () => {
    const callable = wrapCallable(backend.joinOrCreateHighLowSession);
    const logSpy = jest
      .spyOn(backend, 'logGameEvent')
      .mockRejectedValue(new Error('log failed'));

    await expect(callable({ playerName: 'ada' })).resolves.toEqual({ sessionId: 'current' });
    expect(logSpy).toHaveBeenCalled();
  });

  test('retries when transaction is aborted', async () => {
    const callable = wrapCallable(backend.joinOrCreateHighLowSession);
    const dbInstance: any = admin.firestore();
    const originalRunTransaction = dbInstance.runTransaction.bind(dbInstance);
    let attempts = 0;

    const runTransactionSpy = jest
      .spyOn(dbInstance, 'runTransaction')
      .mockImplementation(async (handler: any) => {
        attempts += 1;
        if (attempts < 3) {
          const error: any = new Error('Transaction aborted');
          error.code = 'aborted';
          throw error;
        }
        return originalRunTransaction(handler);
      });

    const response = await callable({ playerName: 'ada' });

    expect(response.sessionId).toBe('current');
    expect(attempts).toBe(3);
    runTransactionSpy.mockRestore();
  });

  test('stores presence timestamps in playerLastSeen map only', async () => {
    const callable = wrapCallable(backend.joinOrCreateHighLowSession);
    await callable({ playerName: 'Ada' });

    const snapshot = await sessionRef().get();
    const data = snapshot.data() as any;

    expect(data?.players?.[0]?.lastSeen).toBeUndefined();
    expect(data?.playerLastSeen?.ada).toBeDefined();
  });
});
