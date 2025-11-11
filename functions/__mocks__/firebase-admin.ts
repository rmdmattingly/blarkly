type AnyObject = Record<string, any>;

const randomId = () => Math.random().toString(36).slice(2, 10);

class FakeDocumentSnapshot {
  constructor(private readonly docPath: string, private readonly store: FakeFirestore) {}

  get exists(): boolean {
    return this.store.has(this.docPath);
  }

  data(): AnyObject | undefined {
    return this.store.get(this.docPath);
  }
}

class FakeDocumentReference {
  constructor(private readonly store: FakeFirestore, public readonly path: string) {}

  async get(): Promise<FakeDocumentSnapshot> {
    return new FakeDocumentSnapshot(this.path, this.store);
  }

  async set(data: AnyObject, options?: { merge?: boolean }): Promise<void> {
    if (options?.merge) {
      const existing = this.store.get(this.path) ?? {};
      this.store.set(this.path, { ...existing, ...clone(data) });
    } else {
      this.store.set(this.path, clone(data));
    }
  }

  async update(data: AnyObject): Promise<void> {
    if (!this.store.has(this.path)) {
      throw new Error('not-found');
    }
    const existing = this.store.get(this.path) ?? {};
    this.store.set(this.path, { ...existing, ...clone(data) });
  }

  async delete(): Promise<void> {
    this.store.delete(this.path);
  }

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.store, `${this.path}/${name}`);
  }

  async listCollections(): Promise<FakeCollectionReference[]> {
    return this.store
      .listSubcollections(this.path)
      .map((sub) => new FakeCollectionReference(this.store, `${this.path}/${sub}`));
  }
}

class FakeCollectionReference {
  constructor(private readonly store: FakeFirestore, public readonly path: string) {}

  doc(id?: string): FakeDocumentReference {
    const docId = id ?? randomId();
    return new FakeDocumentReference(this.store, `${this.path}/${docId}`);
  }

  async add(data: AnyObject): Promise<FakeDocumentReference> {
    const docRef = this.doc();
    await docRef.set(data);
    return docRef;
  }

  async listDocuments(): Promise<FakeDocumentReference[]> {
    return this.store
      .listDocumentIds(this.path)
      .map((id) => new FakeDocumentReference(this.store, `${this.path}/${id}`));
  }
}

class FakeTransaction {
  private readonly mutations: Array<() => Promise<void>> = [];

  async get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    return ref.get();
  }

  set(ref: FakeDocumentReference, data: AnyObject, options?: { merge?: boolean }): void {
    this.mutations.push(() => ref.set(data, options));
  }

  update(ref: FakeDocumentReference, data: AnyObject): void {
    this.mutations.push(() => ref.update(data));
  }

  async commit(): Promise<void> {
    for (const mutation of this.mutations) {
      await mutation();
    }
    this.mutations.length = 0;
  }
}

class FakeFirestore {
  private readonly store = new Map<string, AnyObject>();
  private settingsOptions: AnyObject | undefined;

  collection(path: string): FakeCollectionReference {
    return new FakeCollectionReference(this, path);
  }

  doc(path: string): FakeDocumentReference {
    return new FakeDocumentReference(this, path);
  }

  settings(options: AnyObject): void {
    this.settingsOptions = { ...(this.settingsOptions ?? {}), ...options };
  }

  async runTransaction<T>(updateFunction: (transaction: FakeTransaction) => Promise<T>): Promise<T> {
    const transaction = new FakeTransaction();
    const result = await updateFunction(transaction);
    await transaction.commit();
    return result;
  }

  set(path: string, data: AnyObject): void {
    this.store.set(path, clone(data));
  }

  get(path: string): AnyObject | undefined {
    const value = this.store.get(path);
    return value ? clone(value) : undefined;
  }

  has(path: string): boolean {
    return this.store.has(path);
  }

  delete(path: string): void {
    this.store.delete(path);
  }

  listDocumentIds(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    const ids = new Set<string>();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const remainder = key.slice(prefix.length);
        const [docId] = remainder.split('/');
        if (docId) {
          ids.add(docId);
        }
      }
    }
    return [...ids];
  }

  listSubcollections(docPath: string): string[] {
    const prefix = `${docPath}/`;
    const subcollections = new Set<string>();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        const remainder = key.slice(prefix.length);
        const [maybeCollection] = remainder.split('/');
        if (maybeCollection) {
          subcollections.add(maybeCollection);
        }
      }
    }
    return [...subcollections];
  }

  reset(): void {
    this.store.clear();
  }

  dump(): Record<string, AnyObject> {
    const result: Record<string, AnyObject> = {};
    for (const [key, value] of this.store.entries()) {
      result[key] = clone(value);
    }
    return result;
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const firestoreInstance = new FakeFirestore();
const apps: Array<{ delete: () => Promise<void> }> = [];

const initializeApp = () => {
  const app = {
    async delete() {
      const index = apps.indexOf(app);
      if (index >= 0) {
        apps.splice(index, 1);
      }
    },
  };
  apps.push(app);
  return app;
};

const firestore = () => firestoreInstance;

Object.assign(firestore, {
  FieldValue: {
    serverTimestamp: () => new Date(),
  },
  Timestamp: class {},
});

const credential = {
  applicationDefault: () => ({}),
};

module.exports = {
  apps,
  initializeApp,
  firestore,
  credential,
  __testing: {
    reset: () => firestoreInstance.reset(),
    dump: () => firestoreInstance.dump(),
  },
};
