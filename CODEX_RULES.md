# CODEX_RULES.md

## Purpose
This file defines conventions and guardrails for **Codex** when generating, refactoring, or extending code for **Blarkly**, a Firebase-based multiplayer card game.

---

## 1) Project Overview

**Blarkly** is a lightweight, real-time multiplayer web app for family card games (starting with **High/Low**).

- **Frontend:** React + TypeScript (Firebase Hosting)
- **Backend:** Firebase Cloud Functions (TypeScript)
- **Database:** Firestore (**region: `us-east4`**)
- **Domain:** `blarkly.com`
- **Scale:** A few concurrent users — prioritize **simplicity over optimization**.

**Gameplay (High/Low):**
- Aces are **always low** (`Ace = 1`).
- There is only **one shared session per game** at:
  - `games/highlow/sessions/current`

---

## 2) Codex Behavior Rules

### 2.1 Function Types & CORS
- **Default to callable functions**: use `functions.region("us-east4").https.onCall(...)`.
- Frontend must call via the Firebase SDK:
  ```ts
  import { getFunctions, httpsCallable } from "firebase/functions";
  const functions = getFunctions(app, "us-east4");
  const joinOrCreate = httpsCallable(functions, "joinOrCreateHighLowSession");
  const res = await joinOrCreate({ playerName });
  ```
- Do **not** call callables with `fetch()` or hardcoded URLs.
- Only use `https.onRequest` for explicit REST-style endpoints; if you do, add CORS yourself (e.g., `cors({ origin: true })`).

### 2.2 Changing Function Types
- **Never change a deployed function’s type in place.** Firebase forbids switching `onCall` ↔ `onRequest` with the same name.
- If a type change is required, **use a new function name** (or delete the old function explicitly before redeploying).

### 2.3 Region & Project
- **Region:** `us-east4` for **all** Functions and Firestore.
- **Project ID:** `blarkly-89e82`.
- Do **not** reintroduce `us-central1`, `demo`, or any placeholder domains/IDs.

### 2.4 Deployment
- Always build before deploy:
  ```bash
  cd functions && npm run build && cd ..
  cd frontend && npm run build && cd ..
  firebase deploy --only functions,hosting
  ```
- Cloud Functions (v2) deployments require **Blaze plan** and these APIs enabled:
  - Cloud Functions API
  - Cloud Build API
  - Artifact Registry API

### 2.5 Firestore
- Database path for the single shared session: `games/highlow/sessions/current`.
- **Statuses:** `"waiting" | "active" | "complete"`.
- Use server timestamps for audit fields:
  - `createdAt`, `updatedAt` = `admin.firestore.FieldValue.serverTimestamp()`.

### 2.6 Game Model (High/Low)
- **Card:** `rank: 1..13` (1 = Ace), `suit: "hearts" | "diamonds" | "clubs" | "spades"`, `label: string` (e.g., `"A♠"`).
- **Player:** `{ name: string; isActive: boolean; pile: Card[] }`.
- **GameSession:** `{ id: string; players: Player[]; deck: Card[]; turnIndex: number; status: "waiting" | "active" | "complete"; settings: { acesHigh: false }; createdAt; updatedAt }`.
- **Deck:** 52 cards; Aces low; use Fisher–Yates shuffle.

### 2.7 Coding Style
- TypeScript **strict** mode; avoid `any`.
- Pure helpers (`generateDeck`, `shuffle`, etc.).
- Use `async/await` with `try/catch` around Firestore calls.
- Log with `functions.logger.info()` and `.error()`.
- Keep frontend light; push validation and game logic to backend.

### 2.8 Security & Simplicity
- Development rules may be relaxed (open reads/writes), but log mutations.
- No sensitive data; player name only.
- Prefer correctness and clarity over micro-optimizations.

### 2.9 File/Module Organization
- Shared types may live in `functions/src/types.ts` and be mirrored in the frontend (or generated via a build step).
- Functions source: `functions/src/index.ts` (or split by domain as the project grows).
- Frontend API layer: `frontend/src/api/highlow.ts` — the only place that touches Firebase SDK in the UI layer.

### 2.10 Prompting Convention
- Start prompts with: “**Follow CODEX_RULES.md**.”
- Include exact file paths to create/modify.
- Include inputs/outputs shapes for functions.
- State the region (`us-east4`) explicitly when adding new Functions or Firestore resources.

---

## 3) Quick Reference

**Callable template**
```ts
export const myCallable = functions
  .region("us-east4")
  .https.onCall(async (data, context) => {
    try {
      // logic
      return { ok: true };
    } catch (err) {
      functions.logger.error("myCallable failed", err);
      return { error: (err as Error).message };
    }
  });
```

**Request-style template (when needed)**
```ts
import * as cors from "cors";
const corsHandler = cors({ origin: true });

export const myHttp = functions
  .region("us-east4")
  .https.onRequest((req, res) => {
    corsHandler(req, res, async () => {
      if (req.method === "OPTIONS") return res.status(204).send("");
      // logic
      res.json({ ok: true });
    });
  });
```

**Frontend callable usage**
```ts
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "../firebaseConfig";

const functions = getFunctions(app, "us-east4");
const joinOrCreate = httpsCallable(functions, "joinOrCreateHighLowSession");

export async function joinOrCreateHighLowSession(playerName: string): Promise<string> {
  const result = await joinOrCreate({ playerName });
  const data = result.data as { sessionId?: string; error?: string };
  if (data?.error) throw new Error(data.error);
  return data.sessionId!;
}
```

---

## 4) Future Extensions
- Additional games adopt the same pattern: `games/{game}/sessions/current`.
- Document input/output schemas (JSDoc) on each callable.
- Revisit security rules before public release; add Auth if needed.

---

## 5) TL;DR
- Use **callables** + `httpsCallable()`.
- Region **`us-east4`**, project **`blarkly-89e82`**.
- One session doc: `games/highlow/sessions/current`.
- Aces low. Keep it simple. Build before deploy.
