import type { LeaderboardPage, LeaderboardRange, OnlineService, PlayerIdentity, PlayerProfile, SubmitResult } from './types';
import { OnlineError } from './types';

/**
 * PLATZHALTER (Plan 009 §7) — Firebase ist noch NICHT eingebunden, hier gibt es bewusst keinen
 * SDK-Import. Die Klasse erfüllt das Interface und scheitert mit OnlineError('unavailable'), damit
 * VITE_ONLINE=firebase schon jetzt sauber in den Offline-Fallback fällt. Das Mapping unten ist die
 * Bauanleitung; Datenmodell, Security Rules und Function-Ablauf stehen ausführlich im Plan.
 *
 * Einbau später (Reihenfolge):
 *  1. `npm i firebase` (modulare SDK v10+, tree-shakable), Konfig aus import.meta.env.VITE_FIREBASE_*.
 *  2. initializeApp → getAuth / getFirestore / getStorage / getFunctions (Region europe-west3).
 *  3. Methoden wie unten; Fehler auf OnlineErrorCode abbilden (unavailable/deadline-exceeded → offline/timeout,
 *     permission-denied → auth, not-found → notFound, sonst server).
 *
 * Mapping:
 *  auth(name)        signInAnonymously(auth) (einmalig, Firebase hält die Sitzung in IndexedDB); später
 *                    linkWithPopup(user, new GoogleAuthProvider()) → gleiche uid bleibt. Danach
 *                    setDoc(doc(db, 'players', uid), { name, createdAt: serverTimestamp() }, { merge: true }).
 *  setName(name)     updateDoc(players/{uid}, { name }) — Rules: nur eigenes Dokument, 2–16 Zeichen.
 *                    (Name in leaderboard-Einträgen denormalisiert → Function `onPlayerRename` zieht nach.)
 *  submitRun(bytes)  httpsCallable(functions, 'submitRun')({ replay: base64 }) — die Function
 *                    1. prüft Auth + Rate-Limit (players/{uid}.lastSubmit, ≤ 1 Lauf / 5 s),
 *                    2. entpackt (unpackReplay) und verifiziert (verifyReplay) gegen das Level aus dem
 *                       Function-Bundle (public/levels/*.json zur Deploy-Zeit, Hash = Level-Version),
 *                    3. schreibt das Replay nach Storage `replays/{levelId}/{runId}.vrp`,
 *                    4. schreibt runs/{runId} (verifizierte Zeit, uid, levelId, levelHash, physicsVersion, …),
 *                    5. aktualisiert in einer Transaktion leaderboards/{levelId}_{physicsVersion}/entries/{uid},
 *                       falls schneller, und liefert Rang (count() mit where time < t) zurück.
 *                    Clients dürfen weder runs noch entries schreiben (Rules: write false).
 *  getLeaderboard    top: query(collection(db, 'leaderboards', boardId, 'entries'), orderBy('time'), orderBy('date'), limit(n))
 *                    around: mein Eintrag lesen → getCountFromServer(where('time', '<', t)) = Rang − 1,
 *                    dann je ein Query endBefore/startAfter mit limitToLast(r)/limit(r).
 *  getGhost(runId)   getBytes(ref(storage, `replays/${levelId}/${runId}.vrp`)) — levelId steht in runs/{runId}
 *                    (ein getDoc), Storage-Rules: lesen für alle angemeldeten, schreiben niemand.
 *  getProfile(uid)   getDoc(players/{uid}) + Query entries where uid == x über die Boards (collectionGroup('entries')).
 */
export class FirebaseService implements OnlineService {
  readonly backend = 'firebase' as const;
  readonly identity: PlayerIdentity | null = null;

  private unavailable(): never {
    throw new OnlineError('unavailable', 'Firebase ist noch nicht eingebunden (Plan 009) — VITE_ONLINE=mock verwenden.');
  }

  async auth(_name?: string): Promise<PlayerIdentity> {
    return this.unavailable();
  }

  async setName(_name: string): Promise<PlayerIdentity> {
    return this.unavailable();
  }

  async submitRun(_replay: Uint8Array): Promise<SubmitResult> {
    return this.unavailable();
  }

  async getLeaderboard(_levelId: string, _range: LeaderboardRange): Promise<LeaderboardPage> {
    return this.unavailable();
  }

  async getGhost(_runId: string): Promise<Uint8Array> {
    return this.unavailable();
  }

  async getProfile(_uid?: string): Promise<PlayerProfile> {
    return this.unavailable();
  }
}
