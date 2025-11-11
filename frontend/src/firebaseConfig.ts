import { initializeApp, getApps, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getFunctions, type Functions } from 'firebase/functions';
import { getFirestore, type Firestore } from 'firebase/firestore';

const projectId = 'blarkly-89e82';

const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY ?? '',
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN ?? 'blarkly-89e82.firebaseapp.com',
  projectId,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET ?? 'blarkly-89e82.appspot.com',
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: process.env.REACT_APP_FIREBASE_APP_ID ?? '',
};

const app: FirebaseApp = getApps()[0] ?? initializeApp(firebaseConfig);
const db: Firestore = getFirestore(app);
const functions: Functions = getFunctions(app, 'us-east4');

export { app, db, functions };
