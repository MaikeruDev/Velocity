# Plan 009 — Online, anbieter-unabhängig: Replays, Determinismus, Verifier, Bestenliste

**Stand:** 2026-11-06 · **Status:** **Supabase umgesetzt** (§13): Discord-Login, Postgres-Bestenliste mit RLS, Storage-Ghosts,
Edge Function `submit-run` mit demselben Verifier — deployt. **Offen für den Betreiber:** Discord im Dashboard aktivieren
und den echten Login einmal durchspielen (§14). Firebase (§7, §9) ist **verworfen** (Nutzerentscheidung), bleibt nur als
Entwurf stehen. Vorbereitung vom 01.10. (Replay-Format, deterministische Physik, Verifier + CLI, Mock) unverändert gültig.

## 1. Ziel

Bestenlisten pro Level, gegen die man wirklich antreten kann: jeder Lauf ins Ziel wird als **Replay** (Eingaben je
Physik-Tick) aufgenommen, eingereicht, auf dem Server **nachgespielt** und nur mit der nachgerechneten Zeit gewertet.
Aus jedem Replay lässt sich der **Ghost** ableiten ("gegen Weltrekord / Rang N / eigene Bestzeit fahren"). Das Spiel
spricht nur ein Interface (`OnlineService`); Firebase (Auth anonym/Google, Firestore, Storage, Cloud Functions) oder
Supabase steckt man später dahinter, ohne Spiel und Menü anzufassen.

Nicht-Ziele jetzt: Multiplayer, Echtzeit-Ghosts anderer, Accounts mit Passwort, Moderations-UI.

## 2. Architektur

```
Game.onTick ── InputQuantizer ──► PlayerMovement.tick (quantisierte Eingabe, live!)
      │              └──► ReplayRecorder.record (Bits, Yaw-q, Pitch-q)
      └── runTick ──► Respawn/Checkpoint/Ziel ──► Recorder-Marken, Keyframes
Ziel ─► ReplayRecorder.finish ─► packReplay (binär + deflate-raw) ─► OnlineService.submitRun
                                                           │
                         Mock: verifyReplay lokal ◄────────┤──► Firebase: Cloud Function `submitRun`
                                                           │        (dieselbe verify.ts, Node)
Bestenliste (Menü) ◄── getLeaderboard ──┘     Ghost ◄── getGhost(runId) ─► unpack ─► verify ─► replayToGhost
```

| Datei | Rolle |
|---|---|
| `src/player/detMath.ts` | `dsin/dcos/datan2/dhypot`: fdlibm- bzw. V8-Ports nur aus + − × ÷ √ — bitgleich in jeder Engine |
| `src/engine/replay/format.ts` | Typen, Quantisierung (`InputQuantizer`, `inputFromQuantized`), `replayConfig`, Versionen |
| `src/engine/replay/codec.ts` | Binärformat, Delta/RLE, Container + `CompressionStream('deflate-raw')`, Base64 |
| `src/engine/replay/hash.ts` | `levelHash` (kompilierte Ebenen als Float64-Bits, Trigger, Spawn, killY), `configHash` |
| `src/engine/replay/recorder.ts` | `ReplayRecorder` — Puffer einmal angelegt, Tick-Pfad allokationsfrei |
| `src/engine/replay/runSim.ts` | `RunSimulator` (Game-Tick-Semantik ohne Spiel: Respawns, Checkpoints, Ziel), `placeFeet` (mit Game geteilt) |
| `src/engine/replay/verify.ts` | `verifyReplay` → `{valid, time, reason, detail, splits, endPos}`, `replayToGhost` |
| `src/engine/replay/botRun.ts` | `BotRun`/`recordBotRun`: RouteFollower als Replay (Tests, Mock-Rivalen) |
| `src/online/types.ts` | `OnlineService`, Bestenlisten-/Profil-Typen, `OnlineError`, `sanitizeName` |
| `src/online/LocalMockService.ts` | localStorage-Backend mit echtem Verifier, Latenz/Ausfall simulierbar, Bot-Rivalen |
| `src/online/SupabaseService.ts`, `supabaseApi.ts` | Supabase-Backend (§13): Discord-Login, RPC-Bestenliste, Storage-Ghosts, Edge Function |
| `src/online/submitVerifier.ts` | Server-Prüfung einer Einreichung (Größe, Entpacken mit Deckel, assisted, `verifyReplay`) |
| `src/online/pendingSubmit.ts` | Lauf über den Login-Redirect retten (sessionStorage) |
| `src/online/index.ts` | `onlineBackend()` (`?online=` > `VITE_ONLINE` > supabase wenn konfiguriert > mock), Fabrik (async) |
| `supabase/` | Migrationen (Schema, RLS, RPCs, Buckets), Edge Function `submit-run` (Handler + Verifier-Bundle) |
| `tools/replay/verify.ts` | CLI `npx tsx tools/replay/verify.ts <replay>` bzw. `--bot <level>` |
| `tools/replay/online-check.ts` | Playwright (Port 5701): Lauf → Einreichen → Bestenliste → Ghost; Chromium ⇄ Node |

## 3. Replay-Format

**Quantisierung (Physik läuft auch live damit):** Tasten als Bits (W, S, A, D, Sprung gehalten, Sprung gedrückt,
Ducken, Sprint — forward/side sind nur −1/0/+1), **Yaw ganzzahlig in 1/65536 Umdrehung, ungewickelt** (die Physik sieht
exakt `q · 2π/65536`; gewickelt wäre `sin(x + 2πk)` nicht bitgleich zu `sin(x)`, und Coach/Training/Showkeys brauchen
den stetigen Blick), Pitch in 1/16384 von 90° (Physik liest ihn nicht). Die Kamera bleibt roh (Blick pro Frame, nie
quantisiert, rules/movement.md §3). **Gefühl:** Fehler ≤ 0.0028° je Tick = 1/16 Maus-Count bei CS-Sens 2, 0.2 % des
Strafe-Fensters bei 1000 u/s; Test: perfekter Strafe-Bot nach 20 Hops < 0.1 % Unterschied; `npm run sim` zeilengleich
(die Sim füttert die Bots unquantisiert — Quantisierung sitzt in Game, nicht in PlayerMovement).

**Kopf:** Spiel- und Physik-Version (`PHYSICS_VERSION` bei jeder Physik-Code-Änderung erhöhen!), Level-ID, Level-Hash,
Config-Hash, Tickrate, physikrelevante Einstellungen (Preset, Auto-Hop, Strafe-Assist, Luftlenkung), `assisted`
(Bot/Override), Tickzahl, behauptete Werte (Start-Tick, Ziel-Tick, Zeit f64, Checkpoint-Ticks, Endposition f32).
**Ereignisse:** manueller Respawn (Taste F) vor Tick k — Absturz/Kill-Respawns rechnet der Verifier selbst; ein Tod/F
vor CP 1 startet in Game eine **neue Aufnahme** (wie RunState: neuer Versuch). **Keyframes:** Füße als f32 alle 128 Ticks
(Desync-Diagnose: der Verifier meldet den ersten abweichenden Tick).

**Kodierung:** Container `VRP`+Version+Flags, Rumpf: Strings/Zahlen als Varint, Tasten als Lauflängen, Yaw als ZWEITE
Differenzen mit Null-Lauflängen (Maus pro Frame gesampelt, nach Tick-Zeit linear verteilt → innerhalb eines Frames 0),
Pitch erste Differenzen, Keyframes roh; dann `deflate-raw` über `CompressionStream` (Browser **und** Node ≥ 18 — kein
zlib-Sonderweg nötig). Größen (gepackt):

| Lauf | Zeit | Ticks | Rumpf | gepackt | je 60 s |
|---|---|---|---|---|---|
| L1 Bot 0° | 18.9 s | 2589 | 2.8 KB | 1.7 KB | 5.5 KB |
| L1 Bot 1° | 20.1 s | 2745 | 4.8 KB | 4.0 KB | 12 KB |
| L2 Bot 1° | 16.6 s | 2250 | 4.3 KB | 3.4 KB | 12 KB |
| L3 Bot 1° | 17.9 s | 2404 | 5.3 KB | 3.8 KB | 13 KB |
| L4 Bot 2° | 29.7 s | 3905 | 8.0 KB | 6.4 KB | 13 KB |
| synth. Mensch (Maus 144 Hz, Zufallsweg, Strafe-Wechsel) | 60 s | 7680 | 22.7 KB | **11.7 KB** | 11.7 KB |

Ziel < 40 KB / 60 s: erfüllt mit Faktor 3. Speicher im Spiel: Puffer für 20 min einmal angelegt (~0.9 MB).

## 4. Determinismus — Befund und Entscheidung

**Messung (01.10.):** Node 22.11 (V8 12.4) gegen Chromium 153 (Playwright), 465 000 Eingaben je Funktion, Hash über die
Bits: `sin, cos, atan2, tan, exp` **verschieden**, `hypot, sqrt` gleich. "Beides ist V8" stimmt also nicht (Chromium
rechnet sin/cos mittlerweile anders als die fdlibm-Fassung in Node) — fallen.md #203. Die Physik nutzt sin/cos (wishdir,
Rutsch-/Luftlenkung), atan2 (Lenken), hypot (überall), compileLevel cos/sin (gedrehte Brushes), convexHull atan2.

**Gegenprobe:** dieselben vier Node-Bot-Replays mit `Math.*` im Chromium nachgespielt → alle **desync** (L3 schon nach
3 s, 0.05–0.9 u Abweichung am Keyframe); mit den Ports **bitgleich** (Zeit, Splits, Endposition).

**Entscheidung:** eigene deterministische Funktionen statt Toleranz. `detMath.ts` portiert fdlibm (sin/cos mit
Cody-Waite-Reduktion bis 2^19·π/2, atan2/atan FreeBSD-msun) und V8s Kahan-hypot — nur IEEE-Grundoperationen, die JS
überall exakt rundet (keine FMA-Kontraktion erlaubt). Damit rechnen auch Firefox/Safari bitgleich (dort nicht gemessen —
kein Firefox im Playwright-Cache; die Garantie folgt aus der Konstruktion, siehe offene Punkte). Weil die Ports in Node
**bitgleich zu `Math.*`** sind (Test über 400 000 Eingaben je Funktion + Sonderstellen), ändert sich in Node nichts:
`npm run sim` zeilengleich, alle Medaillen-/Level-Werkzeuge unverändert. Kosten: keine Allokation, Laufzeit im Rauschen.
Toleranz + Resync wurde verworfen: sie lädt zum Mogeln innerhalb der Toleranz ein und braucht den vollen Zustand.
Keyframes bleiben trotzdem im Format — sie zeigen, WO ein künftiger Desync (neuer Code ohne PHYSICS_VERSION-Bump,
exotische Engine) beginnt.

## 5. Verifier (`src/engine/replay/verify.ts`, Node-tauglich → Cloud Function)

Statisch: Physik-Version, Level-ID + Level-Hash, Config-Hash = `replayConfig(settings)` (Tuning-Panel-Läufe fallen
raus), Tickrate, Tickzahl 1…20 min, Ziel-Tick = letzter Tick, Keyframe-Anzahl, Eingaben möglich (kein W+S/A+D, Druck ⇒
gehalten, Pitch ≤ 90°, Yaw-Sprung ≤ 180°/Tick, Yaw ganzzahlig), Ereignisse sortiert. Dann Nachfahren mit
`RunSimulator` (gleiche Spawn-Logik `placeFeet` wie Game, RunState mit Triggern/Checkpoints/Ziel, Respawns bei
Absturz/Kill, F-Respawn nur ab CP 1), Keyframes bitgenau (f32), Ziel genau im letzten Tick, nachgerechnete Zeit =
(Ziel − Start) · dt = behauptete Zeit, Start-Tick, Checkpoint-Ticks und Endposition wie behauptet. Gewertet wird die
nachgerechnete Zeit. Dauer ~15–30 ms je 20–30-s-Lauf (Node).

Gründe (`reason`): `physics, level, config, tickrate, ticks, input, events, desync, early, noFinish, claim`.
Tests (`tests/replay.test.ts`): Bot-Replays L1–L4 gültig; Zeit −1 Tick → claim; Ticks gekürzt → noFinish; Ziel-Tick
falsch → ticks; Yaw ab Mitte gedreht / Tasten am Ende → desync/claim/noFinish; W+S → input; falsches Level/geändertes
killY → level; Settings ohne Hash → config; Physik-Version → physics; Keyframe → desync (mit Tick); Respawn vor CP 1 → events.

## 6. Anti-Cheat

Was das Replay-Verfahren **verhindert:** erfundene Zeiten, abgeschnittene/gestückelte Läufe, Teleport/Speedhack/Noclip
(jede Position folgt aus der Physik), veränderte Physik (Config-Hash, Tickrate, Physik-Version), anderes Level-Stand,
unmögliche Tastenkombinationen. Was es **nicht** verhindert: TAS/Bots (Eingaben, die ein Mensch so nicht schafft) und
Makros. Gegenmittel, gestaffelt:
1. `assisted`-Flag (Debug-Handle/Bot im Client) → Server lehnt ab (Mock: angenommen, als BOT markiert — für Tests).
   Ehrliches Flag; ein Betrüger setzt es nicht. Deshalb zusätzlich:
2. Heuristiken auf dem Server (Function, billig, auf dem nachgespielten Lauf): Anteil perfekter Hops (`jump.perfect`)
   über einer Schwelle, Strafe-Sync dauerhaft > 0.98, Yaw-Zittern ohne Rauschen (Bots drehen glatt in festen Raten),
   Tasten-Wechsel exakt im Gewinn-optimalen Tick. → nicht ablehnen, sondern `review: true` und aus der öffentlichen
   Top 10 halten, bis geprüft.
3. Rate-Limit je uid (≤ 1 Einreichung / 5 s, ≤ 200 / Tag), Replay-Größe ≤ 256 KB, Laufzeit der Function begrenzt.
4. Top-10-Läufe bleiben als Replay öffentlich (Ghost) — Community sieht TAS-Läufe.
5. Bestenliste je `physicsVersion` (Board-ID `level_v`), damit ein Physik-Patch alte Zeiten nicht verfälscht; alte
   Boards bleiben lesbar.

## 7. Firebase-Mapping (VERWORFEN — Supabase gewählt, §13)

**Auth:** `signInAnonymously` beim Start (Sitzung in IndexedDB); später "Mit Google verknüpfen" (`linkWithPopup`) —
uid bleibt, Läufe bleiben. Name im Profil.

**Firestore:**
```
players/{uid}                 { name, createdAt, runs, lastSubmit, banned? }          Client: nur eigenes, nur name
runs/{runId}                  { uid, levelId, boardId, time, ticks, physicsVersion, levelHash, configHash,
                                settings, assisted, review, createdAt, replayPath, size }  Client: lesen, nie schreiben
leaderboards/{boardId}        { levelId, physicsVersion, levelHash, count }            boardId = `${levelId}_v${physicsVersion}`
leaderboards/{boardId}/entries/{uid}
                              { uid, name, time, runId, date, review }                 bester Lauf je Spieler; Index (time asc, date asc)
```
**Storage:** `replays/{levelId}/{runId}.vrp` (Bytes von `packReplay`, application/octet-stream).

**Security Rules (Skizze):**
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /players/{uid} {
      allow read: if request.auth != null;
      allow create, update: if request.auth.uid == uid
        && request.resource.data.keys().hasOnly(['name', 'createdAt'])
        && request.resource.data.name is string && request.resource.data.name.size() <= 16;
    }
    match /runs/{runId} { allow read: if request.auth != null; allow write: if false; }
    match /leaderboards/{board}/{document=**} { allow read: if true; allow write: if false; }
  }
}
service firebase.storage {
  match /b/{bucket}/o {
    match /replays/{level}/{file} { allow read: if request.auth != null; allow write: if false; }
  }
}
```
Geschrieben wird nur von der Function (Admin-SDK umgeht die Rules).

**Cloud Function `submitRun` (callable, Node 20, europe-west3):**
1. `context.auth` vorhanden, nicht gebannt; Rate-Limit über `players/{uid}.lastSubmit` (Transaktion).
2. Base64 → Bytes (≤ 256 KB) → `unpackReplay` (dieselbe `codec.ts`; Node hat `CompressionStream`).
3. Level aus dem Function-Bundle (`public/levels/*.json` zur Deploy-Zeit kopiert, `compileLevel`), `verifyReplay`.
   Ungültig → `{status:'rejected', reason}` (kein Schreiben außer Zähler).
4. Heuristiken (§6.2) → `review`.
5. Storage schreiben, `runs/{runId}` anlegen; Transaktion auf `entries/{uid}`: nur wenn schneller (oder neu) ersetzen.
6. Rang = `count(entries where time < t) + 1` (Aggregation-Query), total = `count()`. Antwort = `SubmitResult`.
Weitere Functions: `onPlayerRename` (Name in `entries` nachziehen), geplant `recheckBoard` (nach Level-Änderung: alte
Läufe gegen neuen Hash prüfen → neues Board). Kosten: ein Lauf = 1 Function-Aufruf (~50 ms CPU), 3–4 Schreibzugriffe,
~5–15 KB Storage.

**Client-Seite** (`FirebaseService.ts` enthält das Mapping je Methode als Kommentar): top = `orderBy('time')
.orderBy('date').limit(10)`; around = eigener Eintrag + `getCountFromServer(where('time','<',t))` + je ein Query
`endBefore/startAfter` mit `limitToLast(r)/limit(r)`; Ghost = `getDoc(runs/{id})` → `getBytes(storage ref)`.

## 8. Supabase-Alternative (kurz; umgesetzt mit Abweichungen in §13 — Login nur Discord, keine anonyme Anmeldung)

Auth: anonyme Anmeldung (`signInAnonymously`) + OAuth Google. Postgres-Tabellen `players`, `runs`, `entries`
(Primärschlüssel (board_id, uid), Index (board_id, time, date)), Row Level Security wie oben (Client nur lesen +
eigener Name). Storage-Bucket `replays`. Verifikation als **Edge Function** (Deno — hat `CompressionStream`, unsere
`src/engine/replay` + `src/world` + `src/player` laufen dort, nur three `Vector3/Box3` muss mitgebündelt werden). Rang
per `select count(*) where time < $t` oder Fensterfunktion `rank() over (order by time)`; "um mich herum" per
`row_number()`. Vorteil: SQL für Bestenlisten (Rang, Ausschnitte) ist natürlicher als Firestore-Counts; Nachteil:
Edge-Function-Limits (CPU 2 s) reichen, aber keine eingebaute Callable-Auth-Prüfung wie bei Firebase — JWT selbst prüfen.

## 9. Was der Nutzer für Firebase vorbereiten muss (VERWORFEN — gilt nicht mehr, siehe §14)

1. Firebase-Projekt anlegen (Konsole), **Blaze-Tarif** (Cloud Functions brauchen ihn; Budget-Alarm setzen).
2. Authentication aktivieren: Anbieter **Anonym** und **Google** (autorisierte Domains: lokale Dev-Domain + Hosting).
3. Firestore (Native, Region `europe-west3`), Storage-Bucket (gleiche Region).
4. Web-App registrieren → Konfig-Werte als `VITE_FIREBASE_API_KEY`, `…_AUTH_DOMAIN`, `…_PROJECT_ID`,
   `…_STORAGE_BUCKET`, `…_APP_ID` in `.env.local` (nicht committen); `VITE_ONLINE=firebase`.
5. Firebase CLI (`npm i -g firebase-tools`, `firebase login`), App Check (reCAPTCHA Enterprise) erwägen.
6. Danach (Implementierung): `npm i firebase` im Spiel, `functions/` mit `firebase-admin` + `firebase-functions`,
   Build-Schritt kopiert `public/levels` und bündelt `src/engine/replay` + Abhängigkeiten in die Function.

## 10. Spiel-Integration (umgesetzt)

- Jeder Lauf (ohne Lektion) wird aufgenommen; ungültig machen ihn: Config-Wechsel im Lauf, F1-Tuning
  (Config ≠ `movementConfigFor(settings)`), Debug-Teleport/-Geschwindigkeit. Bot/Override → `assisted`.
- Ziel → automatisch einreichen (async), Statuszeile "ONLINE · Geprüft · Rang 3 von 12 · neue Online-Bestzeit" im
  Ergebnis (pending/accepted/rejected/skipped/offline/error), Knopf "Bestenliste".
- Bestenliste (Titel → "Bestenliste", Ergebnis → "Bestenliste"): Level-Reiter, Top 10 + "Um dich herum" (±3), Medaille
  je Zeit, BOT/DU-Marken, je Zeile "Ghost", "Gegen Weltrekord", "Gegen eigene Bestzeit". Pixel-Stil der Menüs.
- Gegen Ghost fahren: Level startet sofort (User-Geste → Pointer Lock), Replay lädt parallel, wird verifiziert und als
  Ghost nachgefahren (`replayToGhost`, gleiche 32-Hz-Aufnahme wie der eigene Ghost); HUD-Hinweis "GHOST: …", Abstand an
  Checkpoints. Gilt bis zurück ins Menü; sichtbar auch mit ausgeschaltetem Bestzeit-Ghost.
- Einstellungen → Online: "Spielername" (2–16 Zeichen, leer = SPIELER-xxxx), Backend-Hinweis.
- Offline (`?online=off`, Firebase ohne SDK, Netzfehler): Spiel unverändert, Status "Offline — nicht eingereicht",
  Bestenliste "Offline".
- Verträge: `settingsTypes.GameSettings.playerName`; `ui/types`: `OnlineStatus`, `FinishResult.online`,
  `MenuEvents.raceGhost`, `MenuScreen` 'leaderboard'; `Menu.setOnline/showLeaderboard/setOnlineStatus`, `MenuOnline`;
  `GameDeps.online`; Debug-Handle `online()`, `leaderboard()`, `showLeaderboard()`, `raceGhost()`, `verifyReplay()`.

## 11. Verifikation

`npx tsc --noEmit` 0 · `npx vitest run` (neu: `detMath`, `replay`, `online`) · `npm run sim` zeilengleich zum Stand
vorher · `SHOT_PORT=5700 npm run shot` · `npx tsx tools/replay/online-check.ts` (Port 5701): Lauf → Einreichen (Rang)
→ Chromium-Replay in Node gültig mit gleicher Zeit/Endposition → Node-Replays L1–L4 im Chromium bitgleich →
Bestenliste mit eigenem Eintrag → Ghost eines Rivalen geladen und mitgefahren (Screenshot, HUD-Abstand) → Offline.

## 12. Offene Punkte

- Firefox/Safari nicht gemessen (nur Chromium im Playwright-Cache). Erwartung bitgleich (nur IEEE-Grundoperationen);
  erster Schritt nach Firebase: `npx playwright install firefox webkit` und online-check auf allen drei Engines.
- `PHYSICS_VERSION` ist Handarbeit — ein Test, der einen festen Referenz-Replay (Datei) gegen den Code prüft und bei
  Abweichung "Version erhöhen?" meldet, wäre der Wächter (bewusst noch nicht: Level-Retunings ändern den Hash ohnehin).
- Level-Retuning entwertet alte Replays (Level-Hash). Boards je Level-Hash trennen oder Recheck-Function (§7).
- Heuristiken gegen TAS (§6.2) nur skizziert.
- Mock-Rivalen werden im Browser beim ersten Öffnen einer Bestenliste gefahren (~0.3 s je Level, in Häppchen) — im echten
  Backend entfallen sie.
- Replays enthalten nur die Physik-Eingaben, keine Kamera-Effekte/Kosmetik — Replay-*Wiedergabe* als Film (mit Hand,
  HUD) wäre ein eigener Schritt (Ghost reicht für "gegen jemanden fahren").

## 13. Supabase umgesetzt (06.11.)

Nutzerentscheidung: **Supabase**, Login **ausschließlich per Discord** (Supabase Auth OAuth, PKCE). Ohne Login bleibt das
Spiel voll spielbar (lokale Bestzeiten/Ghosts, Bestenliste lesen, fremde Ghosts fahren); nur Einreichen braucht den Login.
Projekt `didmtxnjtalbqppmmpvq`, Function-URL `https://didmtxnjtalbqppmmpvq.supabase.co/functions/v1/submit-run`.

### 13.1 Datenbank (`supabase/migrations/*.sql`, per MCP eingespielt — Dateinamen = Remote-Versionen)

| Objekt | Inhalt | Zugriff |
|---|---|---|
| `public.profiles` | id (= auth.users.id), display_name (2–16, Regex wie `sanitizeName`), discord_name, avatar_url (nur `cdn.discordapp.com`), is_banned, created/updated_at | SELECT **spaltengenau** (id, display_name, avatar_url, created_at) für anon+authenticated; UPDATE nur `display_name`, nur eigene Zeile, nicht gebannt (USING + WITH CHECK) |
| `private.handle_auth_user` | Trigger auf auth.users (insert + update von raw_user/app_meta_data): Profil aus Discord-Metadaten (custom_claims.global_name → full_name → name), bereinigt; display_name nach dem Anlegen nie aus Metadaten überschrieben; **nur Discord-Konten** (raw_app_meta_data) bekommen ein Profil | SECURITY DEFINER, `search_path=''`, Schema `private` (nicht exponiert), EXECUTE niemandem |
| `public.runs` | jeder angenommene Lauf: level_id, level_hash, physics_version, time_ms, ticks, splits (ms), replay_path (nur bei PB), replay_bytes, settings | SELECT öffentlich; **keine** Schreib-Grants/-Policies für Clients |
| `public.best_runs` | PK (user_id, level_id, level_hash, physics_version), run_id, time_ms, achieved_at, hidden (Bann) | SELECT öffentlich; nur die Function schreibt |
| `private.submit_counters` | Rate-Limit je Nutzer, feste Fenster (20/min, 500/Tag) | nur service_role |
| `claim_submit_slot(user, per_min, per_day)` | Ban-Check + Rate-Limit atomar (Advisory-Lock) → ok/banned/noprofile/minute/day | EXECUTE nur service_role (PUBLIC/anon/authenticated revoked) |
| `record_verified_run(…)` | runs-Insert, best_runs-Upsert **nur bei Verbesserung**, Rang/Total/personal_best/improved | EXECUTE nur service_role |
| `get_leaderboard(level, hash, physics, limit, offset)`, `get_rank_around(level, hash, physics, user, radius)` | row_number über (time_ms, achieved_at, user_id) — Gleichstand: wer zuerst da war; `total` in jeder Zeile | SQL, STABLE, SECURITY INVOKER, `search_path=''`, EXECUTE anon+authenticated |
| Bann | `profiles.is_banned = true` (Dashboard/service_role) → Trigger blendet best_runs aus (hidden), Einreichen → 403; Entbannen blendet wieder ein | — |
| Bucket `replays` | öffentlich lesbar (Ghosts ohne Login), 256 KB, application/octet-stream, **keine** Policies → niemand listet/schreibt außer service_role | — |
| Bucket `function-assets` | privat, Verifier-Bundle inhaltsadressiert (`submit-run/verifier-<sha256>.js`) | nur service_role |

Abweichung vom Auftrag: der Tafel-Schlüssel enthält zusätzlich `physics_version` (sonst stünden Zeiten verschiedener Physik
in einer Liste; die RPCs haben dafür `p_physics`). Grants: Supabase vergibt per Default-Privileg ALLES auf neue
public-Tabellen und EXECUTE an PUBLIC — überall zurückgenommen und explizit neu vergeben (fallen.md #204).

Advisors (06.11.): Sicherheit ohne Warnung; nur INFO "RLS ohne Policy" auf `private.submit_counters` = gewollt (nicht
exponiertes Schema, nur service_role, RLS als Tiefenschutz). Performance nur INFO "unused index" (Tabellen leer;
`best_runs_board_idx` trägt die Bestenliste, `runs_user_created_idx` FK + Profil-Zähler, `best_runs_run_idx` den FK).

Geprüft per SQL in einer Transaktion (Rollback): anon `select *`/`is_banned`/`discord_name` auf profiles → verweigert;
Insert in runs/best_runs, Aufruf von claim/record → verweigert; eigenen Namen ändern → 1 Zeile, fremden → 0 Zeilen,
is_banned/avatar_url ändern → verweigert, `x<script>` → Check-Verletzung; Metadaten-Update ändert display_name nicht,
fremde Avatar-Hosts landen nicht im Profil; E-Mail-Konto bekommt kein Profil → claim `noprofile`; Rate-Limit greift
(Limit 2 → ok, minute, minute); Rang/PB/improved über 4 Einreichungen korrekt.

### 13.2 Edge Function `submit-run` (`supabase/functions/submit-run/index.ts`, verify_jwt = true)

POST Replay-Bytes (oder JSON `{replay: base64}`) → `auth.getUser(jwt)` (anon-Key-JWT/anonyme Nutzer → 401) →
`claim_submit_slot` (403 banned/noprofile, 429) → Bundle-Verifier (`SubmissionVerifier`: ≤ 256 KB, entpackt ≤ 4 MB,
`assisted` → abgelehnt, Level aus dem Bundle, `verifyReplay`) → bei PB Replay nach `replays/<level>/<run>.vrp` →
`record_verified_run` → `{valid, runId, time, timeMs, rank, total, personalBest, improved, previousMs, …}`; ungültig → 200
`{valid:false, reason, detail}`. GET = Diagnose (Level-Hashes des Servers, Ladezeiten). OPTIONS = CORS.

**Bundle:** `node tools/online/build-function.mjs` → `verifier.bundle.js` (esbuild, ESM, platform neutral, 681 KB: 610 KB
Level-JSON, Rest Physik/Verifier; `three` auf Vector3/Box3 reduziert, sonst +250 KB). Weil die MCP-Deploy-Schnittstelle
Dateien als Text überträgt, liegt das Bundle im privaten Bucket `function-assets` und wird beim Kaltstart geladen;
ausgeführt nur bei passendem SHA-256 (in index.ts gepinnt; `data:`-Import, Fallback `new Function`). Der erste Upload lief
ohne Secret-Key über eine 1-Objekt-INSERT-Policy für genau diesen Pfad, die sofort danach gelöscht wurde (0 Policies auf
storage.objects). Künftig: `tools/online/upload-bundle.mjs` mit Secret-Key.

**Gemessen (06.11.):** Kaltstart GET 0.53 s gesamt (Bundle laden + prüfen 200 ms, alle 4 Level kompilieren 104 ms), warm
0.11 s. Level-Hashes in Deno = Node = Chromium (fb752c70…, 21041713…, 2c04f3ab…, 4a08804d…). curl: ohne JWT 401
(Gateway), anon-Key ohne Nutzer 401 (Handler), kaputtes JWT 401, OPTIONS 200 mit CORS-Kopf, anon-Upload in `replays`
abgewiesen, `function-assets` öffentlich nicht erreichbar, RPC `get_leaderboard` öffentlich `[]`.

### 13.3 Client

`SupabaseService` über den Adapter `supabaseApi` (supabase-js 2.119.0, eigener dynamisch geladener Chunk, 57 KB gzip):
`auth()` stellt nur wieder her (supabase-js tauscht `?code=` nach dem Redirect und räumt die URL), `signIn()` =
`signInWithOAuth('discord', redirectTo: Origin + Pfad, scopes 'identify')`, `setName` = profiles-Update, `submitRun` =
`functions.invoke('submit-run', Blob)`, `getLeaderboard` = RPCs (Tafel aus dem lokal kompilierten Level), `getGhost` =
runs.replay_path → öffentliche URL; das Spiel verifiziert das Ghost-Replay wie beim Mock selbst. Auswahl: `?online=` >
`VITE_ONLINE` > supabase (wenn `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`) > mock.

**Login-Fluss:** Ziel ohne Login → Status `login` ("Melde dich mit Discord an, um deine Zeit einzureichen" + Knopf). Knopf
→ `Game.login()` sichert das gepackte Replay in sessionStorage (`velocity.online.pending.v1`, 30 min) → Pointer Lock aus →
Redirect. Zurück: Sitzung wiederhergestellt → `resumeLoginRun` reicht den Lauf genau einmal ein, Ergebnis als Toast.
Konto-Zeile im Titel (System) und in Einstellungen → Online: Avatar (16 px, Nearest-Neighbor) + Name + "Abmelden".
Bestenliste mit Discord-Namen/Avataren und DU-Markierung, ohne Login mit Hinweis + Knopf. Ein laufender Lauf fragt beim
Login aus der Pause "Seite verlassen?" (Leave-Guard) — gewollt.

**Tests:** `tests/supabaseService.test.ts` (Service gegen Adapter-Attrappe, Replay-Sicherung), `tests/submitFunction.test.ts`
(Bundle = Node-Verifier für Bot-Replays L1–L4: gültig, bitgleiche Zeit/Splits, Hashes; Bundle aktuell + SHA gepinnt;
assisted, Größe, kaputt, geschönte Zeit, Deflate-Bombe), `tools/online/login-check.ts` (Playwright gegen das echte
Projekt, 13 Prüfungen inkl. abgefangenem Discord-Redirect mit PKCE und untergeschobener Sitzung für die Angemeldet-Ansicht).

## 14. Für den Betreiber

### 14.1 Discord Developer Portal

1. <https://discord.com/developers/applications> → **New Application** → Name z. B. `VELOCITY` → Create.
2. Links **OAuth2** → **Client ID** kopieren; **Client Secret** → *Reset Secret* → kopieren (wird nur einmal gezeigt).
3. **OAuth2 → Redirects** → *Add Redirect* → `https://didmtxnjtalbqppmmpvq.supabase.co/auth/v1/callback` → **Save Changes**.
   Nur diese eine URL — Discord schickt zu Supabase zurück, Supabase dann zum Spiel.

### 14.2 Supabase Dashboard (Projekt didmtxnjtalbqppmmpvq)

1. **Authentication → Sign In / Providers → Discord** → *Enable* → Client ID + Client Secret einfügen → **Save**. Die dort
   angezeigte Callback-URL muss `https://didmtxnjtalbqppmmpvq.supabase.co/auth/v1/callback` sein (= 14.1.3).
2. **Authentication → URL Configuration**: *Site URL* `http://localhost:5173`; *Redirect URLs* → *Add URL*
   `http://localhost:5173/**`. Später die echte Domain zusätzlich (`https://<domain>/**`), sonst landet der Login nach dem
   Deploy auf localhost.
3. **Empfohlen:** Authentication → Providers → **Email** ausschalten (das Spiel nutzt ihn nicht; E-Mail-Konten bekämen
   ohnehin kein Profil und dürften nicht einreichen — Migration `online_profiles_discord_only`). **Anonymous Sign-Ins** aus
   lassen (Default).
4. Vor Ende 2026 schaltet Supabase die Legacy-Keys ab: dann in `.env.local` `VITE_SUPABASE_ANON_KEY` durch den Publishable
   Key (`sb_publishable_…`, Settings → API Keys) ersetzen. Die Function nutzt bereits `SUPABASE_SECRET_KEYS` (Fallback
   Legacy). Den Secret-Key nie in `.env.local`/`VITE_*` legen — alles mit `VITE_` landet im Browser.

### 14.3 Echten Login testen

1. `npm run dev` → <http://localhost:5173> → Titel: **Mit Discord anmelden** → Discord fragt nach Freigabe (Name/Avatar) →
   zurück im Titel: Avatar + Discord-Name + *Abmelden*. Supabase → Table Editor → `profiles`: eine Zeile.
2. Abmelden, ein Level ins Ziel fahren → Ergebnis zeigt Hinweis + Knopf → anmelden → nach der Rückkehr Toast
   „01 GRUNDKURS: Geprüft · Rang 1 von 1 · neue Online-Bestzeit“. Bestenliste: Eintrag mit DU, Avatar, Ghost-Knopf.
3. Angemeldet einen langsameren Lauf → „Online-Bestzeit bleibt“; `runs` +1, `best_runs` unverändert; Storage
   `replays/level1/` enthält nur PB-Replays.
4. Server-Sicht: Dashboard → Edge Functions → submit-run → Logs („Rang x/y (… ms Prüfung)“ bzw. „abgelehnt <Grund>“).
   Bot-/Override-Läufe (Debug-Handle) werden als *assisted* abgelehnt — zum Testen selbst fahren.
5. Name ändern: Einstellungen → Online → Spielername → Bestenliste zeigt den neuen Namen.
6. Automatisch (ohne Discord): `npx tsx tools/online/login-check.ts` prüft alles bis zum Redirect.

### 14.4 Nach Änderungen an Physik, Leveln oder Verifier

`node tools/online/build-function.mjs` → `SUPABASE_SECRET_KEY=sb_secret_… node tools/online/upload-bundle.mjs` (lädt hoch,
pinnt den SHA in index.ts) → index.ts deployen (`npx supabase login`, dann
`npx supabase functions deploy submit-run --project-ref didmtxnjtalbqppmmpvq`, oder MCP `deploy_edge_function` mit
verify_jwt an). `npx vitest run` meldet ein veraltetes oder nicht gepinntes Bundle. Neuer Level-Hash = neue, leere Tafel;
alte Läufe bleiben in `runs`.

### 14.5 Offen

- Heuristiken gegen TAS (§6.2) weiter nur skizziert; `assisted` lehnt nur ehrlich markierte Bot-Läufe ab.
- Moderation: Bann per Dashboard (`profiles.is_banned`), keine Moderations-UI. Gelöschte Nutzer: Zeilen per FK-Cascade weg,
  Storage-Objekte bleiben (Aufräum-Job bei Bedarf).
- Altes Bundle-Objekt `submit-run/verifier-2efdc930….js` im privaten Bucket ist unbenutzt (darf gelöscht werden).
- Kein echter Login-Durchlauf möglich ohne Discord-Konto im Dashboard — §14.3 ist der Abnahmetest.

### 14.x Entwickler-Rolle (2026-11-06)

`profiles.role` (`'player'` | `'dev'`, Migration `online_profiles_role`) ist öffentlich lesbar, aber für Clients
nicht schreibbar (UPDATE-Grant nur auf `display_name`). `get_leaderboard`/`get_rank_around` liefern sie mit; das
Menü zeigt Entwickler mit Neon-Stufen-Effekt + Glitch + DEV-Abzeichen (`playerName()` in `src/ui/Menu.ts`,
`.vel-name-dev` in `menu.css`). Vergeben nur im SQL-Editor bzw. per MCP — nie in einer Migration mit fester ID:

    update public.profiles set role = 'dev' where id = '<auth.users.id>';

Vergeben an: Maikeru (Betreiber).
