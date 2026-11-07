# Plan 011 — Steam-Vorbereitung: Controller, Electron-Hülle, Desktop-Login, Steamworks-Gerüst

**Stand:** 2026-11-07 · **Status:** in Arbeit — Phase 0–4 umgesetzt (S0–S4) und Review-Fix-Runde abgeschlossen (A1–A10,
B1–B5, C1–C8 + Nachbefunde; siehe §9), offen: Bundle-Upload, Spieler-Abnahme, echter Discord-Login/Steam-Client, Phase 5. Ursprünglich geplant (Planner). Kern dieser Iteration: **Phase 1 (Controller)** und **Phase 2
(Electron-Hülle Windows)**. Phasen 3–5 sind kürzer und dürfen in eine Folge-Iteration rutschen. Der Spieler war beim
Planen nicht erreichbar: Entscheidungen unten sind begründet getroffen, echte Spieler-Entscheidungen stehen in §8 und
blockieren nichts.

## 1. Problem aus Spielersicht

- **"Mit dem Controller kann ich gar nicht spielen."** Das Spiel kennt nur Maus und Tastatur (`engine/Input.ts`,
  `InputState.ts`). Auf Steam (und erst recht auf dem Steam Deck) erwartet man, dass ein Pad vom Boot bis ins Ziel reicht:
  Menü, Spiel, Pause, Ergebnis, Bestenliste, Einstellungen.
- **"Strafen mit dem Stick fühlt sich zäh an"**, sobald es Controller gibt, aus zwei Gründen, die schon im Code stehen:
  (a) Der Luftgewinn hängt am vollen `wishspeed` (`accelspd = accel · wishspeed · dt`, movement.md §2). Ein halb
  ausgelenkter Stick hätte `wishspeed = runSpeed · |stick|` (`PlayerMovement.computeWish`) und würde Gewinn still
  verschenken. (b) Strafen heißt Blick und Seite synchron drehen. Ein Stick hat eine Höchst-Drehrate. Bei niedrigem
  Tempo braucht der perfekte Strafe viel mehr Grad pro Sekunde als bei hohem. Ist die Rate zu klein, wird der Anfang
  einer Hop-Kette zur Qual.
- **"Im Browser-Tab fühlt es sich nicht wie ein Spiel an."** Strg+W schließt den Tab (nur im Vollbild per Keyboard Lock
  abgefangen), Vollbild und Ton brauchen eine Geste, es gibt kein "Beenden". Steam braucht ein ausführbares Programm.
- **"Login geht am Desktop nicht."** Der Discord-Login per Supabase ist ein Seiten-Redirect (`SupabaseService.signIn`,
  fallen.md #208). In einer Desktop-Hülle gibt es dafür keine Seite, auf die man zurückspringen kann.

## 2. Entscheidungen (mit Begründung)

### 2.1 Vom Lead vorgegeben
- **Electron statt Tauri.** Tauri rendert mit dem System-WebView: WebView2 (Chromium) unter Windows, aber WebKitGTK unter
  Linux/Steam Deck und WKWebView unter macOS. Die Bitgleichheit von Physik und Replays haben wir nur in Chromium ⇄ Node
  gemessen (fallen.md #203, `tools/replay/online-check.ts`). `detMath` macht die Physik zwar engine-unabhängig, aber
  Pointer-Lock-Raw (`unadjustedMovement`), Keyboard Lock, `CompressionStream('deflate-raw')` und das Gamepad-Mapping
  wären auf WebKit neue, ungetestete Pfade. Electron liefert auf jeder Plattform dasselbe Chromium wie unsere
  Playwright-Tests, und `steamworks.js` (napi-rs, ABI-stabil) ist für Electron gebaut, inklusive Overlay-Hilfe. Den
  Nachteil (rund 150 MB Download, mehr RAM) nehmen wir für ein Steam-Spiel hin.
- **Die Web-Version bleibt unverändert.** Alles Desktop-Spezifische liegt hinter `src/platform/`, mit dem Web als
  Default. Im Web-Bundle steckt **kein** Electron-/Node-Code: Der Renderer redet nur über ein schmales, per
  `contextBridge` freigegebenes Objekt `window.velocityDesktop` (nur Typen in `src/platform/bridgeTypes.ts`). Fehlt das
  Objekt, ist die Plattform `web`.
- **Steamworks nur mit Test-App-ID 480**, optional hinter einem Flag. Ohne Steam (oder wenn Steam nicht läuft) startet
  das Spiel normal.

### 2.2 Eigene Entscheidungen
1. **Stick wird für die Physik digitalisiert (−1/0/+1 je Achse). Replay-Format, `PHYSICS_VERSION`, Verifier und
   Bestenliste bleiben unverändert.** `InputQuantizer` kennt für forward/side nur Bits (`replay/format.ts`
   BTN_FORWARD…BTN_RIGHT). Analoges forward/side bräuchte ein neues Replay-Format, eine neue Physik-Version und damit
   neue, leere Tafeln. Außerdem verschenkt Teilauslenkung Luftgewinn (§1a). Digital heißt: volles `wishspeed`, Pad und
   Tastatur gleichberechtigt auf derselben Bestenliste. Der Verlust ist "langsam gehen", und das braucht dieses Spiel
   nicht. Die Abbildung ist **winkelbasiert, 8 Richtungen** (keine Schwelle je Achse). Ein nach links gedrückter Stick
   mit etwas Hochanteil bleibt reines A. Mit Strafe-Assist zählt W in der Luft ohnehin nicht (movement.md §5), am Boden
   aber schon.
2. **Kamera-Stick = Drehraten-Steuerung pro Frame, ohne Glättung.** Rate = `maxRate · curve(|stick|)` nach radialer
   Deadzone. Angewandt wird sie in `InputState.beginFrame()` mit der echten Framezeit, verteilt über den bestehenden
   Subtick-Yaw (AGENTS §3.3). Danach wird sie wie die Maus quantisiert. Keine Glättung, kein Tiefpass. Die Antwortkurve
   ist bei einem Ratengerät Pflicht und keine "Mausbeschleunigung": Der Mauspfad (`look(dx, dy)`) bleibt bitgleich
   unangetastet. Ein optionaler **Dreh-Boost** am Rand (Rate steigt, solange der Stick außen gehalten wird) kommt nur,
   wenn die Sim ihn belegt (Schritt 1.2). movement.md §3 bekommt dazu einen Satz.
3. **Pad-Tasten sind Pseudo-Codes im selben held-Set wie Maustasten** (`PadA`, `PadB`, …, `PadLT`, `PadRT`, `PadUp` …,
   Index = Gamepad Standard Mapping). Flanken, Tipp-Klammer (latch), Auto-Hop und Sprungpuffer gelten so ohne
   Sonderfall. Trigger sind digital mit Hysterese (an ≥ 0.6, aus ≤ 0.4).
4. **Pad-Einstellungen in einem eigenen Speicher** (`velocity.pad.v1`, `src/engine/pad/padSettings.ts`), **nicht** in
   `GameSettings`/`KeyBinds`. Der Grund ist die Verifier-Bundle-Falle (fallen.md #210, #214). Gemessen: `Ghost.ts`
   importiert `defaultStorage` aus `Settings.ts`. Darüber hängen `settingsTypes.ts`, `InputState.ts`
   (`isBindableCode`), `render/types.ts` und `online/types.ts` im Modulgraphen der Edge Function. **Jede** Textänderung
   dort macht das Bundle "veraltet". Deshalb gibt es außerdem **Schritt 0**: den Graphen einmal entkoppeln, dann ist die
   Falle für diese ganze Iteration weg.
5. **Pad-Default-Belegung "Bumper-Sprung":** Sprung = **LB + A**, Ducken = **RB + B**, Sprint = L3 (Auto-Sprint ist
   Default), Checkpoint (F) = Y, Vorführung (H) = X, Neustart (R) = View/Select **0.4 s halten**, Pause = Start/Menu.
   Grund: Wer A drückt, nimmt den Daumen vom Kamera-Stick. Für Bhop + Strafe muss der Sprung auf einer Schultertaste
   liegen. A bleibt für Einsteiger mitbelegt. Neustart wird gehalten, weil ein versehentlicher Druck sonst den Lauf
   kostet. Alles umbelegbar, dazu ein Preset "Klassisch" (Sprung A, Ducken B).
6. **Spielen mit Pad braucht keinen Pointer Lock.** Ein Gamepad-Druck ist laut HTML-Spec keine User-Aktivierung, also
   kann er weder Pointer Lock noch Web-Vollbild noch den AudioContext freischalten. Game bekommt einen
   **Steuer-Modus** `'mouse' | 'pad'`. Ein Start per Pad läuft ohne Lock (wie das bestehende `lockless`, aber mit echter
   Eingabe). Fokus- und Sichtbarkeitsverlust pausieren. Ein Mausklick ins Spiel wechselt zurück auf Maus und fordert den
   Lock an. Ton im Web ohne Geste: Hinweis "Für Ton einmal klicken". Am Desktop entfällt das komplett
   (`autoplayPolicy: 'no-user-gesture-required'`, Vollbild über das Hauptprozess-Fenster).
7. **Eingabegerät = zuletzt benutztes**, mit `InputDevice` = `'keyboard' | 'xbox' | 'playstation' | 'generic'`.
   Erkennung über `Gamepad.id` (Vendor 054c = Sony, 045e = Microsoft, Rest generic, mit Xbox-Beschriftung). Die
   Einstellung "Tasten-Symbole: Automatisch/Xbox/PlayStation" schlägt die Erkennung, denn unter Steam Input sieht der
   Browser oft ein emuliertes Xbox-Pad. PS-Bestätigen = Kreuz (westliche Konvention).
8. **Menü-Navigation: zwei Wege, ein Eingang.** Pad-Richtungen werden zu neuen `InputAction`s `navUp/navDown/navLeft/
   navRight` (+ `tabPrev/tabNext` für LB/RB). A wird zu `confirm`, B/Start zu `pause` (= zurück), aber nur im
   Menü-Kontext. Der ps2-Stil hat schon eine eigene räumliche Navigation (`ps2/index.ts` `onKey` → `navigate(dx, dy)`,
   Pfeile/WASD). Er bekommt die Pad-Richtungen über eine neue optionale Methode `FrontDoor.onNavigate?(dx, dy): boolean`
   im Vertrag. Bestands-Screens aus `Menu.ts` (Einstellungen, Steuerung, Pause, Ergebnis, Labor, Admin) sind heute
   Maus/Tab-Fokus. Für sie baut der Plan eine **generische räumliche Fokus-Navigation** `ui/padNav.ts` (fokussierbare
   Elemente, Richtungs-Kegel, Slider links/rechts = Wert, sichtbarer Fokus im Look). Sie greift auch für Front Doors
   ohne `onNavigate`.
9. **Desktop lädt dieselbe `dist/` wie Vercel**, über ein eigenes Protokoll `app://velocity/` (`protocol.handle`, als
   `standard` + `secure` registriert). Gründe: stabile Origin (localStorage bleibt über Updates gleich), Secure Context
   (die Gamepad API verlangt ihn), `fetch` der Level-JSON geht (unter `file://` nicht), CSP als Antwort-Header. Ein
   Build, Plattform-Erkennung zur Laufzeit. Desktop testet so exakt den Web-Build.
10. **Speicherstände: localStorage bleibt Single Source of Truth.** Electron legt ihn je Origin unter `userData` ab.
    Steam Cloud kann LevelDB nicht sauber synchronisieren, deshalb ein **Spiegel** (Schritt 2.7): Die
    `velocity.*`-Schlüssel werden entprellt als `userData/save/save.json` geschrieben und bei leerem localStorage beim
    Start zurückgelesen. Das reicht später für Steam Auto-Cloud. Eine Migration vom Web-Stand gibt es nicht (andere
    Origin). Optional "Export/Import" als JSON, das ist aber nicht Teil dieser Iteration.
11. **Desktop-Login = System-Browser + Loopback + PKCE** (RFC 8252 §7.3). Ein eingebettetes Login-Fenster ist verworfen
    (Nutzer sehen keine echte Adressleiste, Passwort-Manager/2FA, Anbieter blocken es). Ein Custom-Protocol-Deep-Link
    ist verworfen (Registry-Eintrag je Installation, Zweitinstanz-Logik, wackelt bei mehreren Steam-Bibliotheken).
    Details in Phase 3.
12. **Kein Auto-Update** (Steam macht das). electron-builder nur mit Target `dir` (`win-unpacked` = Steam-Depot), kein
    NSIS, kein `electron-updater`.
13. **Admin (F8) und Dev-Parameter (`?online=`, `?level=`, `?menu=`) sind am Desktop nur mit `--dev` aktiv.** Sonst
    würde das Admin-Menü (Alles freischalten, Medaille setzen) Achievements entwerten. Achievements kommen außerdem nur
    aus **Live-Ereignissen** (`finish` mit Medaille, `lessonStage` mit Sternen), nie aus gespeicherten Bestzeiten.
14. **Kein Feature außerhalb der Vision:** kein Aim-Assist, keine Strafe-Automatik für Pads, keine Analog-Physik.
    Pad-Spieler bekommen dieselben Hilfen wie Tastatur-Spieler (Smart-Auto-Hop, Strafe-Assist, Lande-Gnade).

## 3. Vertragsänderungen (AGENTS.md §3.4, alle im selben Zug nachziehen)

| Vertrag | Änderung | Phase |
|---|---|---|
| `src/engine/storage.ts` (**neu**) | `StorageLike`, `defaultStorage` (aus Settings.ts verschoben, dort re-exportiert) | 0 |
| `src/engine/pad/types.ts` (**neu**) | `PadButtonCode`, `PadBinds`, `PadSettings`, `DEFAULT_PAD_SETTINGS`, `InputDevice`, `GlyphStyle`, `PromptAction` | 1 |
| `src/engine/InputState.ts` | `InputAction` + `navUp`/`navDown`/`navLeft`/`navRight`/`tabPrev`/`tabNext`; `setPadMove(fwd, side)`, `setLookRate(yawRate, pitchRate)` (rad/s, in `beginFrame` mit frameDt integriert), Pad-Codes im held-Set | 1 |
| `src/engine/Input.ts` (InputManager) | `device`, `onDevice(cb)`, `promptLabel(a)`, `setMenuContext(on)`, `configurePad(s)` | 1 |
| `src/ui/menuLab/types.ts` | `FrontDoorContext.input: FrontDoorInput {device, glyph(a): FrontDoorGlyph}`, `ctx.quit: (() => void) \| null`; `FrontDoor.onNavigate?(dx, dy): boolean`; Update bei Gerätewechsel | 1 / 2 |
| `src/ui/types.ts` | `MenuEvents.quit`; Settings-Screen-Abschnitt "Controller" (kein neuer MenuScreen) | 1 / 2 |
| `src/platform/types.ts` (**neu**) | `PlatformApi {kind, caps, quit(), window, openExternal, auth?, steam?, saveMirror?}` | 2–4 |
| `src/platform/bridgeTypes.ts` (**neu**) | Typ des `window.velocityDesktop`-Bridges (nur Typen, von preload und Renderer importiert) | 2 |
| `src/online/SupabaseService.ts` (`SupabaseServiceOptions`) | `externalLogin?: (authUrl) => Promise<string /* code */>` (Desktop); `OnlineService` **unverändert** — **umgesetzt als** `externalLogin?: ExternalLogin` (= `platform.auth` ohne Tresor: `begin()` → Rücksprung-URL, `openExternal(url)` → Code, `cancel()`), weil der Port erst beim Start feststeht und VOR der Auth-URL bekannt sein muss | 3 |
| `src/online/supabaseApi.ts` (`SupabaseApi`) | + `discordAuthUrl(redirectTo)` → `{url, flowId}`, `exchangeCode(code, flowId)` → `SessionInfo`; `createSupabaseApi(url, key, {vault?})`, `vaultStorage`, `sessionStorageKey` | 3 |
| `GameSettings`, `KeyBinds`, `replay/format`, `PHYSICS_VERSION`, `online/types.ts` | **unverändert** (bewusst, §2.2.1/§2.2.4) | — |

## 4. Phasen und Schritte

Jeder Schritt nennt Dateien, Vertrag und **woran man merkt, dass es besser ist**. "Grün" heißt immer: `npm run
typecheck` 0, `npm test` grün. Bei Eingabe-/Physik-Nähe zusätzlich: `npm run sim` **zeilengleich** zu main.

### Phase 0 — Verifier-Bundle entkoppeln (klein, zuerst, seriell)

**0.1 `StorageLike`/`defaultStorage` nach `src/engine/storage.ts`.** `Ghost.ts` importiert von dort, `Settings.ts`
re-exportiert (keine Nutzer brechen). Dann `node tools/online/build-function.mjs` → Bundle neu,
`upload-bundle.mjs` (braucht `SUPABASE_SECRET_KEY`), `index.ts` deployen (Plan 009 §14.4).
- Vertrag: neu `engine/storage.ts`.
- **Messung:** Im neuen Bundle tauchen `CapsLock`, `sanitizeSettings`, `menuStyle`, `lowLatency` und `sanitizeName` nicht
  mehr auf (`grep -c`). Probe: eine Kommentar-/Textänderung in `InputState.ts`, `settingsTypes.ts` und `online/types.ts`,
  dann `build-function.mjs --check`. Das Bundle bleibt **bytegleich** (`cmp`). `PHYSICS_VERSION` und Level-Hashes sind
  gleich wie im GET der Live-Function.
- Fehlt der Secret-Key: Die Live-Function bleibt auf dem alten Pin kompatibel (nur Umbenennungen, fallen.md #210). Dann
  ist `tests/submitFunction` bis zum Upload rot. Das wird im Bericht gemeldet und **ist der einzige erlaubte rote Test**.

**Umgesetzt (2026-11-06):** `src/engine/storage.ts` neu, `Ghost.ts` importiert von dort, `Settings.ts` re-exportiert
(`StorageLike`, `defaultStorage`). Modulgraph des Bundles (Metafile) vorher: zusätzlich `Settings.ts`,
`settingsTypes.ts`, `InputState.ts` (335 B toter Code im Bundle: `KeyW`…, `confirm`, `pause`), `render/types.ts`,
`online/types.ts`. Nachher: keins davon, neu nur `storage.ts` (0 B). Bundle 697 483 → 697 148 B, sonst nur
Minifier-Umbenennungen (Diff per `tr ';,' '\n\n'`). Probe (Textänderung in `InputState.ts`, `settingsTypes.ts`,
`online/types.ts`, neu gebaut): **bytegleich** (`cmp`). Physik/Level unverändert → Live-Function bleibt auf altem Pin
kompatibel.

#### Ausstehend: Upload (Spieler, braucht Secret-Key)
- Eingechecktes `verifier.bundle.js` ist bereits neu gebaut: **SHA-256
  `f2d0493193d540506759f7e9ce787ff304a3e69ddf100c6a315112c065a6ad71`** (alt/live:
  `e02d9814f19ac2a22dce8f0aa38252252c277958da370c316358988391dd0e51`).
- `index.ts` pinnt bewusst noch den alten SHA → `tests/submitFunction` ("index.ts pinnt genau dieses Bundle") ist bis
  zum Upload rot; alles andere grün.
- Schritte (PowerShell, Windows-Terminal): 1) `$env:SUPABASE_SECRET_KEY="sb_secret_…"; node tools/online/upload-bundle.mjs;
  Remove-Item Env:SUPABASE_SECRET_KEY` (lädt
  `function-assets/submit-run/verifier-f2d04931….js` hoch und setzt `BUNDLE_SHA256` in `index.ts`). 2) `index.ts`
  deployen (`npx supabase functions deploy submit-run` oder MCP `deploy_edge_function`). 3) GET der Function: `bundle`
  = `f2d049319…`, `PHYSICS_VERSION`/Level-Hashes wie vorher. 4) `npx vitest run tests/submitFunction.test.ts` grün.

### Phase 1 — Controller (Kern)

**1.1 Stick-Kurve als reine Funktion + Defaults** — `src/engine/pad/stickCurve.ts` (DOM-frei), `tests/pad.test.ts`.
`radialDeadzone(x, y, inner, outer)`, `lookRate(x, y, s, heldEdgeTime) → {yaw, pitch}` (rad/s, mit optionalem Boost),
`digitizeMove(x, y, inner, diagonalBand) → {fwd, side}` (8 Sektoren; `diagonalBand` = Winkelbreite der Diagonalen,
Default 30°).
- **Messung (Vitest):** Deadzone ist stetig (kein Sprung an `inner`), Ausgabe 0 für |s| < inner, 1 ab outer. Die Kurve
  ist monoton. `digitizeMove` gibt für einen 20° neben links liegenden Stick reines `side = −1`, für 45° die Diagonale.
  Ohne Allokation (Rückgabe in ein übergebenes Objekt).

**1.2 Sim-Beleg: Stick-Strafen** (movement.md §7) — `tools/sim.ts` (neue `--section stick`), `tools/sim/scenarios.ts`,
`player/bots/StickHand.ts` (Bot, der Yaw nur über `lookRate` mit Rauschen auf der Stick-Auslenkung dreht),
`.docs/research/movement-tuning.md` (Abschnitt "Controller").
- Läufe: StrafeBot sync 1 mit `maxTurnRate` ∈ {180, 240, 300, 360, 450, 540, ∞} °/s → Tempo nach 5/10/20 Hops, Zeit
  bis 500 u/s, L1-Slalom-Zeit. StickHand mit Kurve (linear / ^1.6 / ^2.2) × Boost (aus / +50 % nach 0.15 s) × Rauschen
  (0 / 3 % / 6 % Auslenkung).
- **Entscheidungskriterium (vor 1.3 festschreiben):** Default-`maxRate` = kleinste Rate, bei der StrafeBot sync 1 nach
  20 Hops **≥ 90 %** des Tempos ohne Ratenlimit erreicht **und** die Zeit bis 500 u/s ≤ 1.15× ist. Boost kommt nur
  rein, wenn er bei gleicher Feinzielbarkeit (Rate bei 30 % Auslenkung ≤ 25 °/s) dieses Kriterium mit kleinerer
  Grundrate erreicht. Zusätzlich `npx tsx tools/levels/medalProbe.ts` mit StickHand (16 Seeds): **Bronze in L1–L4 im
  Median erreichbar**. Das wird nur informativ notiert, Medaillen werden nicht neu getunt.
- `npm run sim` ohne `--section` bleibt zeilengleich (nur neue Sektion).

**Umgesetzt S1a (2026-11-06)** — `npm run sim -- --section stick` (`tools/sim/stick.ts`, Bot `tools/sim/StickHand.ts`
statt `player/bots/` — reines Messinstrument, `src/player/*` unangetastet), `src/engine/pad/stickCurve.ts`,
`tests/pad.test.ts` (6 grün). `npm run sim` ohne `--section` bytegleich zu HEAD (`cmp`). Referenz ohne Ratenlimit:
H20 1162 u/s, Zeit bis 500 u/s 1.05 s. Der Engpass ist der Anfang der Kette: bei 250 u/s dreht der perfekte Strafe die
Flugrichtung mit ~1170 °/s (Cap 40 ⟂ v), bei 1000 u/s nur noch ~180 °/s.

StrafeBot sync 1 mit hartem `maxTurnRate` (= linearer Stick ohne Rauschen):

| °/s | 90 | 120 | 150 | 180 | 240 | 300 | 360 | 450 | 540 | 630 | 720 | 900 | ∞ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| H20 (u/s) | 863 | 971 | 1046 | 1089 | 1126 | 1141 | 1149 | 1156 | 1158 | 1160 | 1161 | 1161 | 1162 |
| H20 / ∞ | 74.3 % | 83.6 % | **90.0 %** | 93.8 % | 97.0 % | 98.3 % | 99.0 % | 99.5 % | 99.7 % | 99.9 % | 99.9 % | 100 % | 100 % |
| t→500 / ∞ | 4.25× | 3.27× | 2.67× | 2.28× | 1.80× | 1.52× | 1.34× | 1.18× | **1.10×** | 1.04× | 1.02× | 1.01× | 1.00× |
| L1 RouteFollower (s) | – | – | – | – | 22.35 | 21.74 | 22.12 | 21.34 | 21.27 | 21.17 | 21.29 | 21.18 | 21.20 |

- **Nur die 90-%-Hürde (H20) ist billig:** schon 150 °/s. **Bindend ist t→500 ≤ 1.15×:** hart begrenzt erst ab 480 °/s
  (30er-Raster, StickHand linear ohne Rauschen), 540 in der Tabelle. Unter 240 °/s scheitert der RouteFollower in L1
  (informativ, kein Medaillen-Tuning).
- **StickHand, kleinste Grundrate mit Kriterium** (Rauschen 0 / 3 / 6 %, @30 % = °/s bei 30 % Auslenkung):
  ^2.4 ohne Boost 480 / 510 / 510 (@30 %: 27–28 → **nicht** feinzielbar); ^2.4 **+50 % Boost** 360 / **420** / 480
  (@30 %: 20 / 23 / 27); ^2.6 ohne Boost 480 / 510 / 510 (@30 %: 21–22); linear braucht ≥ 108 °/s bei 30 %.
  Boost senkt die Grundrate bei gleicher Feinzielbarkeit um ~90 °/s → **Boost kommt rein** (Plan-Regel erfüllt).
  +100 % Boost bringt bei 3 % Rauschen nichts mehr (360 statt 420) und kippt ohne Rauschen in einen Zickzack-Grenzzyklus
  (H20 545–591 u/s) → verworfen.
- **Bei den Defaults** (420 °/s, ^2.4, +50 %): H20 99.4 / 99.0 / 97.7 %, t→500 1.10× / 1.12× / 1.21× (Rauschen 0/3/6 %).
  6 % Rauschen verfehlt nur die Zeit-Hürde knapp. **Nach Review A3 (07.11., Boost-Uhr mit Hysterese):** H20 98.4 / 98.2 /
  97.3 %, t→500 1.10× / 1.10× / 1.13× — Kriterium hält bei allen drei Rauschstufen (research/movement-tuning.md).

**Defaults für S1b (`DEFAULT_LOOK_CURVE` in `stickCurve.ts`, in `PadSettings` übernehmen):**
`maxYawRate` **420 °/s** · Kurve `exponent` **2.4** · Boost **+50 %** nach **0.15 s** am Rand (Betrag ≥ 0.95 nach
Deadzone), Rampe 0.1 s → Spitze 630 °/s · Deadzone innen 0.12 / außen 0.95 · `maxPitchRate` 220 °/s (nicht vermessen).
**Einstellbereich Grundrate: 180–900 °/s** (darunter zäher Anlauf: t→500 ≥ 2.3×; darüber kein messbarer Gewinn: t→500 ≤ 1.01×).
**Änderung 2026-11-07 (Desktop-Playtest: „rechter Stick generell langsamer“):** Default **320 / 170 °/s** (Verhältnis
wie vorher). Gespeicherte, nie veränderte 420/220 migriert `PadSettingsStore` auf die neuen Werte. Stick-Sim bei 320:
H20 96.2 / 97.4 / 97.3 %, t→500 **1.19×** / 1.21× / 1.26× — das Tempo-Kriterium (≤ 1.15×) hält bewusst nicht mehr:
Gefühl schlägt Anlauf-Sekunden; wer schneller dreht, stellt Kamera X höher.
Zweite Runde am selben Tag („Y passt, X weiter runter“): **250 / 170 °/s**; 320/170 wird ebenfalls migriert.
Stick-Sim bei 250 nicht neu gemessen (Spieler testet selbst).
API: `radialDeadzone`, `lookRate(x, y, params, heldEdgeTime, out)` (rad/s, Vorzeichen wie Stick: x rechts +, y unten +;
Invertierung/Yaw-Vorzeichen macht `InputState`), `boostFactor`, `stickMagnitude`, `STICK_EDGE`,
`digitizeMove(x, y, inner, diagonalBand, out)`. Die Boost-Uhr (`heldEdgeTime`) führt der Aufrufer.
**Offen:** medalProbe mit StickHand (braucht StickHand im RouteFollower → `player/bots`, hier ausgespart); Frame- statt
Tick-Integration nicht modelliert; Abnahme per Gefühl (1.9).

**1.3 Gamepad-Polling + Einspeisung** — neu `src/engine/pad/PadInput.ts` (pollt `navigator.getGamepads()` in
`beginFrame`, Flanken je Knopf, Trigger-Hysterese, Gerätetyp), `src/engine/pad/padSettings.ts` (Store
`velocity.pad.v1`, `sanitizePadSettings`), `src/engine/pad/types.ts`; Änderungen in `InputState.ts` (Pad-Codes,
`setPadMove`, `setLookRate`, nav-Aktionen) und `Input.ts` (PadInput besitzen, `device`, `promptLabel`,
`setMenuContext`, `gamepadconnected`/`disconnected`, Disconnect im Spiel → `pause`).
- Vertrag: siehe §3.
- **Messung:** `tests/input.test.ts` erweitert. Stick links 0.7 → `tickInput().side === -1`. LB-Druck zwischen zwei Ticks
  → `jumpPressed` genau einmal (latch wie Tastatur). Stick-Rate 1.0 über 1 s bei 60/144/240 Hz Frames → Gesamt-Yaw
  identisch ±1 YAW_UNIT, Schritt je Tick gleichmäßig (Muster `loop-subtick.test.ts`, fallen.md #45). Getrennt:
  Pad + Tastatur gleichzeitig ODER-verknüpft. **`replay.test.ts`, `online.test.ts` unverändert grün,
  `PHYSICS_VERSION` gleich.** Allokation: `node tools/alloc-probe.mjs level1 --warmup 60` mit Fake-Pad, src/-Anteil
  nicht höher als ohne Pad (±5 %).

**1.4 Steuer-Modus `'mouse' | 'pad'` in Game** — `src/engine/Game.ts` (Start/Weiter/Nochmal ohne Lock, wenn die Geste
vom Pad kam; Blur/Visibility → Pause auch ohne Lock; Klick ins Spiel → Maus-Modus + Lock; Cursor ausblenden im
Pad-Modus; `demoKey`-Label über `input.promptLabel('demo')`), `src/engine/debug.ts` (`__vel.pad({...})`: Fake-Pad
setzen, `__vel.input().device`).
- **Messung (Playwright, neu `tools/pad/pad-check.ts`, Port 5730, `PAD_PORT=…`, `?online=mock`):** Ein Fake-Gamepad
  per `addInitScript` (überschreibt `navigator.getGamepads`, Zustand per `page.evaluate` steuerbar) startet L1 aus dem
  ps2-Titel nur mit A. Ergebnis: `gameState 'playing'`, kein `pointerLockElement`, keine Konsolenfehler. Ein Skript-Lauf
  (Stick + LB + Kamera-Stick nach Route-Bot-Vorlage) erreicht das Ziel. Das aufgenommene Replay verifiziert in Node
  **bitgleich** (`verifyReplay`, wie online-check). Alt-Tab-Ersatz (`window.dispatchEvent(blur)`) pausiert.

**Umgesetzt S1b (1.3 + 1.4, 2026-11-06)** — neu `engine/pad/types.ts`, `padSettings.ts`, `PadInput.ts`, `prompts.ts`;
geändert `InputState.ts`, `Input.ts`, `Loop.ts`, `Game.ts`, `debug.ts`; Tests `tests/padInput.test.ts` (21) +
`tests/input.test.ts` (2 neu); `tools/pad/pad-check.ts` (15 Checks grün). `npm run sim` bytegleich zu HEAD (`cmp`),
Verifier-Bundle-SHA unverändert `f2d04931…`, `PHYSICS_VERSION`/Replay-Format unverändert.
- **API für S1c:** `InputAction` + `navUp/navDown/navLeft/navRight/tabPrev/tabNext` (nur Menü-Kontext; A = `confirm`,
  B/Start = `pause`, X = `demo`, Y = `respawn`, View 0.4 s halten = `restart`; Steuerkreuz/linker Stick > 0.5 = nav mit
  Wiederholung 0.35/0.12 s). `InputManager`: `device: InputDevice`, `usingPad`, `onDevice(cb) → unsub`,
  `promptLabel(a: PromptAction)` (Text, PS: × ○ □ △ L1 …), `setMenuContext(on)` (Game setzt es jeden Frame =
  `menu.visible`), `configurePad(s)`, `pad.sticks`/`pad.output` (Live-Anzeige). `Game.padSettings: PadSettingsStore`
  (`get/update/applyPreset('bumper'|'classic')/reset/subscribe`, `sanitizePadSettings`, `PAD_LIMITS`, `padPresetOf`),
  `Game.promptLabel(a)`, `Game.controlMode`. `__vel.pad(patch|null)`, `__vel.input()`.
- **Abweichungen:** `FixedLoop.onFrameStart(frameDt)` bekommt die (gekappte) Framezeit — der Kamera-Stick braucht sie in
  `beginFrame`. Der Boost wird nicht am Frame-Ende abgetastet, sondern **exakt über das Frame-Intervall gemittelt**
  (`PadInput.meanBoost`): sonst dreht 60 Hz bis ~3° anders als 240 Hz (Einsatz nach 0.15 s fällt auf eine Frame-Grenze).
  Zusätzliches Feld `PadSettings.moveDeadzone` (0.3, digitale Schwelle des Bewegungs-Sticks, getrennt von der
  Kamera-Deadzone). Steuerkreuz bewegt im Spiel zusätzlich (ODER mit dem Stick). Ein Druck, der ein Pad übernimmt,
  zählt (Chrome zeigt ein Pad erst nach dem ersten Druck). Beim Kontextwechsel gehaltene Knöpfe zählen erst nach dem
  Loslassen (A bestätigt → kein Sprung). Fake-Pad über `__vel.pad` statt `addInitScript`.
- **Offen:** pad-check fährt (noch) keinen Pad-Lauf bis ins Ziel im Browser — die Bitgleichheit Pad → Replay belegt
  Vitest in Node (L1 mit RouteFollower am Pad: `verifyReplay` gültig, Zeit gleich; 144 Hz mit echter Kurve + Boost:
  Nachspielen der Bits = Live-Bahn). `alloc-probe` mit Fake-Pad nicht gemessen (Pfad allokiert laut Durchsicht nicht;
  `navigator.getGamepads()` selbst allokiert nativ je Frame, nur bei verbundenem Pad). Hinweis "Für Ton einmal klicken"
  ist ein HUD-Notice-Text; PS-Symbole im HUD-Font kommen mit 1.6 (S1c).

**1.5 Menü-Navigation** — neu `src/ui/padNav.ts` (räumliche Fokus-Navigation für DOM-Screens), `src/ui/Menu.ts`
(`handleAction` nimmt `nav*`/`tab*`, sichtbarer Fokus-Rahmen; Slider/Schalter per links/rechts; Tasten-Belegungs-Dialog
nimmt auch Pad-Knöpfe auf), `src/ui/menu.css` (Fokus-Stil, harte Kante, look.md), `src/ui/menuLab/types.ts`
(`onNavigate`, `input`), `src/ui/menuLab/ps2/index.ts` + `views.ts` (`onNavigate` → bestehendes `navigate(dx, dy)`,
LB/RB = Tabs in Moderation/Bestenliste).
- So funktioniert es heute: ps2 hört selbst auf Pfeile/WASD (`onKey`), Enter/Esc kommen über `onAction`. Die Views
  (`views.ts`) navigieren über `SubView.navigate`. Bestands-Screens haben nur Pfeil hoch/runter in Titel/Training
  (`Menu.onKeyDown`, Z. 1101), sonst Tab/Maus.
- **Messung (pad-check):** Ablauf **nur mit Fake-Pad**: Boot überspringen → Disc wählen → starten → Pause (Start) →
  Einstellungen → Slider ändern → zurück → Weiter → Ziel → Ergebnis → Bestenliste (ps2-View) → Profil → Kosmetik
  (ausrüsten) → Training (Lektion starten) → Titel. Jeder Schritt prüft per DOM, dass der erwartete Screen/Fokus da ist.
  Screenshots → `shots/pad/`. Kein Element im Ablauf ist nur per Maus erreichbar (Zähler "unerreichbare fokussierbare
  Elemente je Screen" = 0, außer bewusst ausgenommene Admin-Knöpfe).

**1.6 Glyphen / Tasten-Hinweise** — `src/engine/pad/glyphs.ts` (Aktion × Gerät → Label/Symbol), Pixel-Symbole für Menü
(`src/ui/menuLab/ps2/dom.ts` `keycap` → Glyph, CSS-Pixel-Sprites ×/○/□/△ und A/B/X/Y in Gerätefarben), HUD
(`src/ui/glyphs.ts`: vier PS-Symbole im 5×7-Font; `Hud.ts`: "[H] ZEIGEN"/"[ENTER] ERGEBNIS" über `promptLabel`),
Coach-/Hinweis-Texte (`engine/Coach.ts`, `Game.ts` Crouch-Hinweis Z. 1724).
- **Messung:** pad-check-Screenshots je Gerät (keyboard / xbox / playstation) von ps2-Titel, Training-View, Pause,
  Lektions-HUD. Der Wechsel des Geräts (Taste ↔ Pad-Druck) schaltet die Prompts **im selben Frame + 1** um (DOM-Prüfung).
  `tests/frontDoorContract.test.ts` erweitert: Glyph für jede `PromptAction` × Gerät definiert. Kein Text im HUD läuft
  aus seinem Rechteck (`hudLayout()`-Rechtecke wie bisher).

**1.7 Controller-Einstellungen** — `src/ui/Menu.ts` (Abschnitt "Controller" in Einstellungen/Steuerung:
Kamera-Empfindlichkeit horizontal/vertikal, Y invertieren, Deadzone innen/außen, Kurve, Dreh-Boost (falls 1.2 ihn
belegt), Diagonal-Band, Tasten-Symbole, Belegung + Preset Bumper-Sprung/Klassisch, Test-Anzeige der Stick-Werte live).
Store aus 1.3.
- **Messung:** Vitest `sanitizePadSettings` (alter/kaputter Stand → Defaults, Werte geklemmt). pad-check: Empfindlichkeit
  ändern → `__vel` meldet neue `maxRate`, Lauf danach. **`tests/submitFunction` bleibt grün ohne Bundle-Upload**, weil
  nach Phase 0 weder `GameSettings` noch der Pad-Store im Graphen hängen.

**1.8 Texte mit Eingabe-Bezug (niedrigere Priorität, darf in Folge-Iteration)** — Bestandsaufnahme: "Maus", "A/D",
"Leertaste", "MAUS" stehen in Coach (7), Training (44), strafeJudge (33), Hud (24) und in Lektions-Texten
(`tools/levels/training/` → `public/levels/training/*.json`). Lösung über Platzhalter-Token (`{STRAFE}`, `{LOOK}`,
`{JUMP}`, `{CROUCH}`, analog zum vorhandenen `[H]`), aufgelöst über `promptLabel`. Lektionen neu bauen
(`levels:build -- training`, danach ohne Filter!).
- **Messung:** `node tools/training-shots.mjs` mit Gerät playstation zeigt keine Tastatur-Begriffe (Text-Grep über
  `__vel.training()`-Tipps = 0 Treffer). Lektions-Level-Hashes ändern sich nicht (Training ist nicht online).

**1.9 Movement-Abnahme** (Reviewer + Spieler) — `.docs/rules/movement.md` §3 bekommt den Satz zum Stick (Rate-Kurve
erlaubt, keine Glättung, Mauspfad unverändert). Reviewer prüft adversarial: Pad-Eingaben laufen durch den
`InputQuantizer`, keine neue Physik-Eingabe, Smart-Hop-Bedingung (`inSide !== 0`) mit digitalem Stick identisch.
**Spieler-Abnahme** (nicht blockierend): L1 mit Pad, "fühlt sich Strafen gut an?". Die Werte aus 1.2 sind nur der
Startpunkt.

### Phase 2 — Electron-Hülle Windows (Kern)

**2.1 Gerüst** — neu `electron/main.ts`, `electron/preload.cts` (sandboxed preload muss CommonJS sein),
`electron/protocol.ts` (`app://velocity/` → `dist/`, MIME, CSP-Header), `electron/tsconfig.json` (Node-Typen nur hier),
`electron-builder.yml`. `package.json`: devDeps `electron` (aktuelle stabile Hauptversion, **exakt gepinnt**; die
Chromium-Version wird hier im Plan notiert — **umgesetzt: electron 45.2.3 = Chromium 156.0.8078.80, Node 24.22.2;
electron-builder 26.18.0**), `electron-builder`. Scripts `desktop:dev` (Electron gegen Vite-Dev-Server
5173), `desktop:build` (`vite build` + `tsc -p electron` + `electron-builder --win dir`). Root-`tsconfig.json` schließt
`electron/` aus.
- Sicherheit: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
  `Menu.setApplicationMenu(null)` (entfernt Strg+W/Strg+R/Strg+Shift+I/Alt-Menü), `will-navigate` + `will-redirect`
  außerhalb `app://velocity` → blockiert, `setWindowOpenHandler` → `deny` (https-Allowlist Discord/Supabase →
  `shell.openExternal`), `setPermissionRequestHandler`: nur `pointerLock`, `fullscreen`, `keyboardLock`; DevTools nur
  mit `--dev`. CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:
  https://cdn.discordapp.com; connect-src 'self' https://<projekt>.supabase.co wss://<projekt>.supabase.co;
  font-src 'self'; worker-src 'self' blob:` (bei der Umsetzung gegen echte Verstöße prüfen, lil-gui/inline-Styles).
- **Messung (neu `tools/desktop/smoke.ts`, Playwright `_electron.launch`):** Fenster öffnet, `location.origin ===
  'app://velocity'`, 0 Konsolenfehler, 0 CSP-Verstöße (`securitypolicyviolation`-Zähler). `typeof require`,
  `typeof process` im Renderer `'undefined'`. `location.assign('https://example.com')` → URL unverändert. `window.open`
  → null. Die Levelliste lädt (index.json über das Protokoll). `win-unpacked/VELOCITY.exe` startet ohne Dev-Server.

**2.2 Plattform-Schicht** — neu `src/platform/types.ts`, `src/platform/index.ts` (`platform()`: `window.velocityDesktop`
vorhanden → desktop, sonst web), `src/platform/web.ts` (Default, alles no-op/`caps` aus), `src/platform/desktop.ts`
(dünner Adapter auf das Bridge-Objekt, **ohne** Electron-Import), `src/platform/bridgeTypes.ts`. `main.ts` reicht
`platform` an Game/Menu/InputManager.
- **Messung:** `npm run build` → `grep -rE "electron|ipcRenderer|contextBridge|steamworks|require\(" dist/assets` = 0
  Treffer (außer Strings in `bridgeTypes`-Kommentaren, die der Minifier entfernt). Bundle-Größe der Web-Assets ± 2 KB
  gegenüber main. Bestehende Web-Werkzeuge (`npx tsx tools/menu/shot.ts`, `tools/replay/online-check.ts`) grün.

**2.3 Fenster & Vollbild** — `electron/window.ts` (Modus Vollbild / randloses Vollbild / Fenster aus
`userData/desktop.json`, Fenstergröße merken, min. 1280×720), Bridge `window.setMode/getMode`. `Input.ts`:
`toggleFullscreen`/`enterFullscreen` delegieren am Desktop an die Plattform (keine Geste, kein Keyboard Lock nötig).
Menü: "Vollbild beim Start" wird am Desktop zu "Anzeigemodus".
- **Messung (smoke):** Moduswechsel per Bridge ändert `BrowserWindow.isFullScreen()`. Neustart übernimmt den Modus. Der
  Modus springt beim Start des Levels **nicht** um (kein `requestFullscreen` am Desktop).

**2.4 Tastatur & Pointer Lock in Electron** — `Input.ts`: am Desktop `setCtrlCrouch(true)` immer (kein Browser-Kürzel
mehr, Strg+W tut nichts). `beforeunload`-Wache **aus**, denn in Electron bricht `preventDefault` das Schließen still ab,
und das X würde nichts tun. Schließen mitten im Lauf regelt `main.ts` (`close` → sofort beenden, keine Rückfrage, der
Lauf ist ohnehin verloren wie beim Alt-F4 in jedem Spiel). Esc-im-Lock-Verhalten wie Chrome (fallen.md #9/#20) **messen**,
nicht annehmen. `unadjustedMovement` unter Windows prüfen.
- **Messung (smoke, echte Eingaben über `webContents.sendInputEvent`, nicht CDP — fallen.md #58: CDP-Tasten lösen keine
  Kürzel aus):** Strg+W, Strg+R, F5, Alt im Spiel → Fenster bleibt, kein Reload. Strg duckt im Fenster-Modus (`__vel`).
  Esc im Lock → genau eine Pause, Lock frei. Fenster-X → Prozess endet in < 1 s mit Code 0. `__vel.input().rawStatus`
  = `'active'`.

**2.5 "Beenden" nur am Desktop** — `ctx.quit` (null im Web) in `menuLab/types.ts`. ps2: Eintrag im System-Panel
(zweistufig "Wirklich beenden?"). Classic: Knopf im Titel. Pause: "Spiel beenden" unter "Zum Titel". Bridge `app.quit()`.
- **Messung:** Web-Screenshots (`tools/menu/shot.ts`) zeigen **keinen** Beenden-Eintrag (DOM-Prüfung). smoke: Beenden
  per Fake-Pad über das ps2-System-Panel → Exit-Code 0.

**2.6 Determinismus in Electron** — `tools/desktop/smoke.ts` (Teil "replay"): L1–L4 Bot-Lauf in Electron aufnehmen,
in Node verifizieren. Zusätzlich die detMath-Hash-Probe aus fallen.md #203 im Electron-Renderer.
- **Messung:** alle vier Replays `valid`, Zeit **bitgleich** zur Electron-Behauptung, detMath-Hash = Node-Hash. Die
  Chromium-Version von Electron wird notiert. Bei Abweichung: debugger-Agent, kein Toleranz-Fix.

**2.7 Speicher-Spiegel (niedrigere Priorität)** — `electron/save.ts` + Bridge `saveMirror.write(json)/read()`,
`src/platform/saveMirror.ts` (entprellt 2 s nach Änderung an `velocity.*`, beim Beenden synchron). Beim Start mit leerem
localStorage → Spiegel einspielen, **bevor** die Stores lesen (main.ts, vor `new SettingsStore`).
- **Messung (smoke):** Bestzeit setzen → Beenden → `Local Storage`-Ordner löschen → Start → Bestzeit, Freischaltungen,
  Pad-Einstellungen sind da. `save.json` < 200 KB mit Ghosts (Ghost-Schlüssel < 40 KB je Level).

**Umgesetzt S2b + serielle Integration (2026-11-06):**
- **Pad → Menü** (Lücke aus S1c): Game verdrahtet `menu.setPad(padSettings, {connected, sticks, captureButton})` und
  `menu.setInputDevice(input.device)`; `input.onDevice` → `applyPrompts()` + `menu.setInputDevice`. Dev-Haken `__velMenu`
  entfernt, `tools/pad/menu-check.ts` läuft nur über den echten Pfad (Fake-Pad, Playwright-Tastatur): "Tastatur → Kappen im
  nächsten Frame" grün.
- **Belegungs-Aufnahme:** `PadInput.capture` / `InputManager.capturePadButton(cb, timeout)` (+ `nextPadButton` als Promise).
  Nächster Knopf (auch A, Trigger), keine Menü-Aktionen während der Aufnahme; das öffnende A zählt erst nach dem Loslassen;
  B wird beim Loslassen gemeldet, B 0.6 s gehalten = Abbruch, Start = Abbruch, Esc = Abbruch, 5 s ohne Druck = Abbruch, Pad
  weg/Blur = Abbruch. Das Belegungsfeld nutzt das statt Durchschalten (Fallback entfernt). Vitest 5 neu, menu-check: RT
  belegt, B gehalten bricht ab.
- **2.2** main.ts: `platform()` → `installSaveMirror(plat.saveMirror, localStorage, window)` VOR `new SettingsStore`,
  `InputManager(…, plat)`, `menu.setPlatform(plat)`, `menu.on('quit')` → `mirror.flush()` + `plat.quit()`. Dev-Parameter
  (ganze Query: `?online/level/menu/debug/mockdev/lockless`) am Desktop nur mit `--dev`; Admin (Knopf, F8, `showAdmin`) ebenso.
  dist-Grep 0 Treffer (Adapter reicht `bridge.versions` durch, fallen.md #295).
- **2.3/2.4** Input.ts: Desktop → Strg duckt immer, keine beforeunload-Wache, `toggleFullscreen`/`enterFullscreen` über
  `platform.window`; Game ruft beim Levelstart am Desktop kein Vollbild (Modus springt nicht um). Menü: "Anzeigemodus
  Vollbild/Fenster" statt "Vollbild beim Start", Steuerung-Hinweis ohne Strg+W-Warnung.
- **2.5** `ctx.quit` (null im Web), `ctx.platform`, `ctx.adminMenu` im Front-Door-Vertrag, `MenuEvents.quit`. ps2: "Beenden" im
  System-Panel (zweistufig "Wirklich beenden?"), Admin nur mit `adminMenu`; Classic: "Beenden" im Titel, Pause: "Spiel beenden"
  (beide zweistufig, 3 s). hub blendet Admin aus; rave/arcade behalten den Knopf (tut am Desktop ohne `--dev` nichts).
- **Messung:** smoke 53/53 (neu: Plattform im Menü, Strg duckt im Fenster, Lock roh `active`, Levelstart ohne Moduswechsel,
  Esc im Lock per echter OS-Taste → genau eine Pause, Spiegel beim Schließen geschrieben, Local Storage gelöscht → 8/8 Schlüssel
  eingespielt, ohne `--dev` kein Admin/F8, Beenden per Fake-Pad → Exit 0 in ~170 ms). Web: menu-check (ps2: kein Beenden,
  Admin da), pad-check 15/15, shot grün.
- **Offen:** `alloc-probe` mit Fake-Pad, Pad-Lauf bis ins Ziel im Browser (S1b), 1.8 Texte, 1.9 Abnahme, Phase 2 nur Windows.

### Phase 3 — Online am Desktop (kurz)

**3.1 Loopback-Login** — `electron/auth.ts`: `http.createServer` auf `127.0.0.1`, fester Port aus einer kleinen Liste
(z. B. 47823–47825, alle in den Supabase-Redirect-URLs). Pfad `/auth/callback`, nimmt `?code=` entgegen, antwortet mit
einer kleinen Pixel-Seite "Login fertig — zurück zum Spiel", schließt sich nach 1 Callback oder 5 min. Renderer:
`supabaseApi.signInWithDiscord` mit `skipBrowserRedirect: true` → Auth-URL → `platform.auth.openExternal(url)` → Code per
IPC → `exchangeCodeForSession(code)`. Der PKCE-Verifier liegt wie bisher im supabase-Storage des Renderers. Geändert:
`SupabaseService.ts` (Option `externalLogin`), `supabaseApi.ts`. **`OnlineService` unverändert**: `signIn()` löst am
Desktop nach dem Tausch auf, `onIdentityChange` feuert. `pendingSubmit` ist harmlos (die Seite bleibt stehen).
- **Messung:** Vitest mit Fake-Adapter (Code → Session, Zeitüberschreitung → `OnlineError('network')`, zweiter Callback
  ignoriert, falscher `state` abgelehnt). Manuell (Betreiber, §8): echter Discord-Login aus `win-unpacked`, danach Lauf
  einreichen. Ohne eingetragene Redirect-URLs → lesbarer Fehler im Menü, Spiel läuft weiter.

**Umgesetzt S3 (3.1, 2026-11-06)** — neu `electron/auth.ts` (Empfänger + Pixel-Seite, reine Logik), `electron/session.ts`
(verschlüsselte Sitzung), `electron/authModule.ts` (Electron-Verdrahtung, eingetragen in `modules.ts`; `electron/main.ts`
unverändert), `tools/desktop/authSmoke.ts`, `tests/desktopAuth.test.ts`; geändert `SupabaseService.ts`, `supabaseApi.ts`,
`online/index.ts` (`OnlineDeps.desktopAuth`), `src/main.ts` (1 Zeile), `platform/{bridgeTypes,types,desktop,web}.ts`
(`auth`), `preload.cts` (Feld `auth`), `tests/supabaseService.test.ts`.
- **Ablauf:** `platform.auth.begin()` → Empfänger auf dem ersten freien Port 47823–47825 (jeder Listen-Fehler, auch EACCES
  für von Windows reservierte Bereiche → nächster) → Rücksprung `http://127.0.0.1:<port>/auth/callback?state=<128 Bit hex>`
  → `supabaseApi.discordAuthUrl` (`signInWithOAuth` + `skipBrowserRedirect`; Verifier + `flowId` im Renderer-Storage) →
  `platform.auth.openExternal(url)` nimmt NUR `https://<supabase>/auth/v1/authorize` mit `provider=discord` und `redirect_to`
  = genau dieser Adresse (danach zusätzlich `isExternalAllowed` → `shell.openExternal`) → wartet auf `?state&code` bzw.
  `?state&error`, 5 min ab dem letzten Öffnen → `exchangeCode(code, flowId)` → `onIdentityChange`, `signIn()` löst auf.
  Falscher/fehlender state, fremder Pfad, fremder Host-Kopf → 400/404 und weiter warten. Erster gültiger Rücksprung →
  Seite, Server zu (`closeAllConnections`: eine zweite Verbindung wird getrennt, bevor sie gelesen wird). Zweiter Klick
  während des Wartens → dieselbe URL erneut (gleicher Verifier/state), kein zweiter Versuch.
- **Pixel-Seite:** Titel als SVG-Pfad aus dem 5×7-HUD-Font (LOGIN FERTIG / ABGEBROCHEN / FEHLER), Dither-Raster,
  harter Versatz-Schatten; CSP `default-src 'none'; style-src 'sha256-…'`, keine Skripte/Fonts/Bilder, `no-store`,
  `no-referrer`; der Code steht nie in der Seite.
- **Redirect-URLs: keine Eintragung nötig.** GoTrue nimmt Loopback-IPs mit beliebigem Port/Pfad/Query ohne Allow-List an
  (`IsRedirectURLValid` → `ip.IsLoopback()`, RFC 8252). Live geprüft (06.11.) per simuliertem Abbruch
  (`/auth/v1/callback?error=access_denied`, kein Login, keine Konfiguration): Rücksprung samt eigenem `state` kam auf
  127.0.0.1:47823 und :47899 an, eine fremde Domain fiel auf die Site-URL zurück. Vorsorge-Einträge: §8.2.
- **Abweichungen:** (1) `externalLogin` = `{begin, openExternal, cancel}` statt `(authUrl) => code` — der Port steht erst
  beim Start fest und muss VOR der Auth-URL bekannt sein. (2) Zeitüberschreitung → `OnlineError('timeout')` statt
  `'network'` (den Code gibt es nicht; `online/types.ts` unverändert, Bundle-SHA `f2d04931…`). (3) "Redirect-URL nicht
  eingetragen" ist am Live-Projekt nicht herstellbar (s. o.). Kippt die Loopback-Regel, landet der Browser auf der
  Site-URL und nur die Zeitüberschreitung meldet es (Text nennt den Grund). Sofort lesbar: abgebrochen/abgelehnt (mit
  GoTrue-Grund), Ports belegt, Browser startet nicht, Bridge fehlt. Anzeige: Toast "Anmeldung fehlgeschlagen: …" aus
  `Game.login()`, Spiel läuft weiter.
- **Sitzung verschlüsselt (Review Phase 2):** Am Desktop bekommt supabase-js einen Storage-Adapter (`vaultStorage`), der
  GENAU `sb-<ref>-auth-token` an den Hauptprozess gibt (`safeStorage` async/DPAPI, `userData/auth/session.bin`, nur
  JSON-Objekte ≤ 64 K Zeichen, Schreiben in Reihe, tmp + rename). PKCE-Verifier und Flow-Index bleiben in localStorage.
  Ohne OS-Schlüsselspeicher lebt die Sitzung nur im Speicher, nie im Klartext. Web unverändert (keine `storage`-Option).
- **Messung:** Vitest neu `desktopAuth` 14 + `supabaseService` 7 (Code → Sitzung, Zeitüberschreitung, zweiter Callback,
  falscher state, Port belegt → nächster, Allowlist, Tresor-Routing/-Datei). Gegenprobe: state-, Host-, `redirect_to`-
  Prüfung aus → jeweils rot. `npx tsx tools/desktop/authSmoke.ts` (echtes Electron, Live-Supabase, `--dev
  --auth-no-browser`, keine OS-Tasten) **15/15**: Bridge, Empfänger, Tresor mit DPAPI (Datei ohne Klartext), Login-Knopf →
  echte supabase-js-URL passiert die Allowlist, zweiter Klick = gleiche URL, simulierter Abbruch → Seite "Abgebrochen" →
  Toast im Menü, Spiel im Titel, Verifier in localStorage, keine Sitzung in localStorage, 0 CSP-Verstöße/Fehler.
  dist-Grep 0, `build-function.mjs --check` grün.
- **Offen:** echter Discord-Login + Einreichen aus `win-unpacked` (Betreiber, §8.2); `tools/desktop/smoke.ts` weder
  erweitert noch gelaufen (S4 arbeitet parallel daran); kein "Login läuft …"/Abbrechen im Menü während der Wartezeit
  (Game/Menu nicht in S3); `shouldReEncrypt` von safeStorage unbeachtet (DPAPI rotiert nicht).

**3.2 Skizze Steam-Auth (nicht bauen)** — `getAuthTicketForWebApi('velocity')` (steamworks.js) → Edge Function
`steam-auth` prüft das Ticket über `ISteamUserAuth/AuthenticateUserTicket` (Publisher-Web-API-Key, Server-Secret) →
legt einen Supabase-User mit `provider = 'steam'` an bzw. verknüpft ihn und gibt eine Session aus (Admin-API,
Magic-Link-Token tauschen). Der Profil-Trigger bekommt Name/Avatar aus `ISteamUser/GetPlayerSummaries` (gleiche Regel
wie fallen.md #209: nie aus Nutzer-Metadaten). Voraussetzung: echte App-ID (§8). `PlayerIdentity.provider` bekäme
`'steam'`. Das ist eine Änderung an `online/types.ts`, nach Phase 0 ohne Bundle-Folgen.

### Phase 4 — Steamworks-Gerüst (kurz, optional, Flag)

**4.1 Laden hinter Flag** — `electron/steam.ts`: nur wenn `--steam` oder `VELOCITY_STEAM=1`. `require('steamworks.js')`
in try/catch, `init(480)`. Scheitert es (kein Steam, kein DLL), läuft das Spiel ohne Steam weiter: ein Log-Eintrag, sonst
nichts. electron-builder: `asarUnpack` für `steamworks.js/**/*.node`, `steam_api64.dll` neben die exe.
`steam_appid.txt` **nur** in `desktop:dev`, nie im Build (Prüfung im Build-Skript).
- **Messung (smoke):** ohne Steam-Client mit `--steam` → Start ok, `platform.caps.steam === false`. Mit laufendem Steam
  (manuell): `caps.steam === true`, Steam zeigt "Spielt Spacewar".

**4.2 Overlay** — `electronEnableSteamOverlay()` + nötige Chromium-Schalter (laut steamworks.js-Doku
`in-process-gpu`/`disable-direct-composition`, nur mit Steam-Flag). `GameOverlayActivated` → `pause`.
- **Messung:** Frametime-Median/P99 auf L2 mit/ohne die Schalter (`__vel.frameCost()`, 60 s), Abweichung ≤ 5 %, sonst
  Overlay vorerst aus und als Risiko notieren. Shift+Tab im Spiel → Pause-Menü.

**4.3 Achievements-Mapping** — `src/platform/achievements.ts` (DOM-frei, Vitest): Live-Ereignisse → Achievement-IDs.
Vorschlag: je Level `L{n}_BRONZE/GOLD/VELOCITY`, `TRAINING_BASICS` (T1–T4 ★), `TRAINING_ALL` (T1–T8 ★), `TRAINING_MASTER`
(alle ★★★), je Freischaltung aus `engine/Unlocks.ts` eine ID (14, aus `UnlockStore.subscribe` **nur nach einem echten
Ziel/Lektionsende**, nie nach Admin-Aktionen), `FIRST_SUBMIT` (verifizierter Online-Lauf). Mit App-ID 480 werden nur die
Spacewar-Test-IDs (`ACH_WIN_ONE_GAME` …) über eine Test-Tabelle angesprochen.
- **Messung:** Vitest: Admin-`set`/`grantEarnedFor` lösen nichts aus. Ein Ziel mit Gold in L1 löst `L1_BRONZE` + `L1_GOLD`
  genau einmal aus (idempotent über einen eigenen Merker `velocity.achv.v1`).

**4.4 Rich Presence** — Menü / "L2 SCHLEIFE" / "Training T3" / "Gegen Ghost". Bei 480 nur Key/Value
(`steam_display` braucht Lokalisierungs-Tokens im Steamworks-Backend → echte App-ID).

**Umgesetzt S4 (4.1–4.4, 2026-11-06)** — neu `electron/steam.ts` (+ `steamFake.ts`), `src/platform/achievements.ts`,
`src/platform/steam.ts`, `src/platform/live.ts`; Hooks in `electron/modules.ts`/`main.ts`/`preload.cts`, Verträge in
`bridgeTypes.ts`/`types.ts`/`desktop.ts`, minimale Game-Hooks (`onLiveProgress`, `ghostRace`), `tools/desktop/check-build.mjs`,
`tools/desktop/steam-check.ts`, Tests `tests/achievements.test.ts` (12) + `tests/steam.test.ts` (22).
- **4.1** steamworks.js **0.4.0** (neueste, 08/2024) exakt in `dependencies`: electron-builder packt nur Produktions-
  Abhängigkeiten, Vite bündelt nur Importe aus src/ (dist-Grep 0, kein Import im Renderer). Kein install-Skript (Prebuilds
  für win64/linux64/osx im Paket). Seine Abhängigkeit `@types/node: *` hält `files` aus dem asar heraus (Whitelist:
  package.json, index.js, win64-Binding + DLL; `asarUnpack` für beide, `extraFiles` = `steam_api64.dll` neben der exe).
  Ablauf: `--steam`/`VELOCITY_STEAM=1` → **vor app.ready** `require` in try/catch (nur das Binding, kein Client-Kontakt) +
  Overlay-Schalter; **init(480) erst nach dem ersten Bild** (`windowReady`, Review Phase 2: SteamAPI_Init ist synchron und
  darf das Erscheinen des Fensters nicht aufhalten). Der Renderer wartet über `steam.ready()` (Zeitlimit 15 s im
  Hauptprozess), `caps.steam` wird erst mit aktiver Sitzung true. Scheitert Laden oder init: genau ein Log-Eintrag, sonst
  nichts. `steam_appid.txt` schreibt nur `desktop:dev` mit `--steam` (beim Ende wieder weg, .gitignore); `desktop:build`
  prüft am Ende (check-build), dass sie weder in dist/, out/, release/ noch im asar liegt.
- **4.2** Overlay-Schalter (steamworks.js `electronEnableSteamOverlay`: in-process-gpu, disable-direct-composition,
  Neuzeichnen je Frame) nur mit Steam-Flag und ladbarem Binding — vor ready, also unabhängig vom späteren init.
  **GameOverlayActivated fehlt in steamworks.js 0.4.0** (Enum mit 10 Callbacks, auch nicht im nativen Binding). Registriert
  wird es nur, wenn das Binding es anbietet; der Pfad Ereignis → Bridge → `game.pause('menu')` ist mit dem Fake geprüft.
  **Mit 0.4.0 pausiert Shift+Tab das Spiel also NICHT** (Ausweg: steamworks.js-Build mit dem Callback, steamworks-rs hat ihn).
- **4.3** Achievements: 30 IDs (`L1–L4_BRONZE/GOLD/VELOCITY`, `TRAINING_BASICS/ALL/MASTER`, je Freischaltung `UNLOCK_*`,
  `FIRST_SUBMIT` nur mit Supabase-Annahme, nicht im Mock). **Abweichung:** statt `UnlockStore.subscribe` ein eigenes Buch
  (`velocity.achv.v1`: live bewiesene Medaille je Level, live geschaffte Stufen je Lektion, verdient, je App-ID zugestellt) —
  sonst flössen per Admin gesetzte Bestzeiten über Mehr-Level-Bedingungen (Münze, Katzenpfote) doch in Achievements ein.
  Quelle nur `Game.onLiveProgress`: Ziel mit `isCleanFinish` (Aufnahme gültig + kein Bot — F1-Tuning, Config im Lauf,
  Teleport zählen nicht), Lektionsstufen der Sitzung (unsauber bei Bot/Override/Teleport/Config-Patch), angenommener Lauf.
  Zugestellt wird nur im Moment eines Live-Ereignisses (Liegengebliebenes mit), idempotent je App-ID — der spätere Wechsel
  auf die echte App-ID stellt alles neu zu. App 480: Test-Tabelle `L1_BRONZE→ACH_WIN_ONE_GAME`, `L1_GOLD→ACH_WIN_100_GAMES`,
  `TRAINING_BASICS→ACH_TRAVEL_FAR_SINGLE`, `FIRST_SUBMIT→ACH_TRAVEL_FAR_ACCUM`; der Hauptprozess lehnt bei 480 alles andere
  ab. **Komplett aus** mit `--dev` oder Debug-Zugang (`--remote-debugging-port/-pipe`, `--inspect…`; Review Phase 2): kein
  Buch, kein activate. Keine Stats.
- **4.4** Rich Presence `status` = "Menü" / "L2 SCHLEIFE" / "Training T3" / "Gegen Ghost · L2 SCHLEIFE", dazu `mode`/`level`
  (für spätere `steam_display`-Tokens); 1-s-Prüfung, nur Geändertes; Schlüssel/Werte im Hauptprozess geprüft (≤ 255 Byte,
  keine Steuerzeichen).
- **Messung:** Vitest 34 neu grün (Admin `set`/`grantEarnedFor`/`unlockAll`/Medaille setzen/Sterne setzen → nichts; Gold in
  L1 → `L1_BRONZE` + `L1_GOLD` genau einmal, nach Neuladen nichts doppelt; ungültige Aufnahme zählt nicht). Gesamt 874/875
  (rot nur `submitFunction` "pinnt genau dieses Bundle", bekannt). `steam-check` 24/24 **nur mit Fake** (Steam-Client lief:
  kein Start ohne `--steam-fake`): ohne Flag nichts, "Steam läuft nicht" → 1 Log + inaktiv, Presence-Folge, Overlay →
  Pause, unter CDP/--dev Achievements aus, exe mit Fake ohne `--dev` gesperrt. Smoke 53/53, check-build ok, dist-Grep 0,
  Steam-Chunk 7 KB (Haupt-Bundle ohne Tabellen/Tracker), Verifier-Bundle bytegleich (`f2d04931…`).
- **Manuelle Betreiber-Prüfung (eigener Steam-Client, nicht automatisiert):** 1) `npm run desktop:dev -- --steam` bzw.
  `VELOCITY.exe --steam`: Freundesliste zeigt "Spielt Spacewar", Konsole `[velocity] Steam aktiv: App 480 …`. 2) Presence
  in "Spielinfo anzeigen" (Menü → L2 SCHLEIFE → Training → Gegen Ghost). 3) Achievements nur OHNE `--dev` und ohne
  Debug-Port (exe): L1 Bronze → Spacewar "Winner". 4) **4.2 Frametime**: L2, `__vel.frameCost()` 60 s mit/ohne `--steam`
  (Median/P99 ≤ 5 %, sonst Overlay aus + Risiko), Shift+Tab zeigt das Overlay (beim Start außerhalb von Steam ggf. nicht:
  init nach dem ersten Bild). Ohne Client: `--steam` → Start ok, ein Log-Eintrag, `caps.steam` false.

### Phase 5 — Steam-Polish (Liste, nach Phase 1/2)

| # | Punkt | Dateien | Messung |
|---|---|---|---|
| 5.1 | Auflösungsskalierung: vorhanden als `RenderSettings.pixelHeight` (224–448). Neu nur "Fenster-Auflösung" am Desktop | `electron/window.ts`, Menu | Screenshots 1280×800 / 1920×1080 / 2560×1440, `effectiveLines()` wie erwartet |
| 5.2 | VSync/FPS-Cap: Desktop-Schalter `disable-gpu-vsync` + `disable-frame-rate-limit` (nur beim Start, `desktop.json`, "wirkt nach Neustart"); FPS-Cap 60/120/144/unbegrenzt im rAF (Frames auslassen, Physik bleibt 128 Hz) | `electron/main.ts`, `engine/Loop.ts`, Menu | Frametime-Histogramm je Cap, Subtick-Test bei 300 fps grün |
| 5.3 | Erststart-Flow: Sprache entfällt (DE), Anzeigemodus, Eingabegerät erkannt → Glyphen, Angebot Training T1 (`training.newbie` existiert) | ps2 Front Door | pad-check: Erststart nur mit Pad bis T1 |
| 5.4 | Pause bei Fokusverlust: Fenster-Blur, Overlay, Pad getrennt, Minimieren | Game.ts, Input.ts | smoke: je Auslöser genau eine Pause, Timer steht |
| 5.5 | **Steam Deck**: 1280×800, nur Pad, Texteingabe (Spielername) über `showFloatingGamepadTextInput` (Steam) bzw. optional (Auto-Name reicht) | ps2, Menu, platform/steam | **pad-check bei `MENU_SIZE=1280x800`: kompletter Ablauf aus 1.5 nur mit Pad, kein Element abgeschnitten (fit.ts), Mindest-Schrift 16 px (Silkscreen-Raster)**; später echtes Gerät (Proton) |
| 5.6 | Vibration (optional, Default aus): kurzer Puls bei perfektem Hop/Landung, × `motionFx` (movement.md §6: Gefühl, nie Physik) | Game.ts, PadInput | Ereignis-Zählung im Test, aus = 0 Aufrufe |
| 5.7 | Linux/macOS-Build (electron-builder `linux dir`/AppImage, mac nur mit Apple-Konto §8) | electron-builder.yml | Start auf Linux-VM, Deck nativ vs. Proton vergleichen |

## 5. Subagenten und Parallelisierung

Alle Umsetzungen: **implementer**. Abschluss jeder Phase: **reviewer** (adversarial; Phase 1 mit Fokus Determinismus +
Movement, Phase 2 mit Fokus Sicherheit). Desync oder Lock-Merkwürdigkeiten: **debugger**.

| Strang | Schritte | Besitzt (exklusiv) | Abhängig von | parallel zu |
|---|---|---|---|---|
| **S0** Bundle | 0.1 | `engine/storage.ts`, `Ghost.ts`, `Settings.ts` (nur Import), `supabase/functions/submit-run/*` | — | — (zuerst, ~1 h) |
| **S1a** Sim | 1.1, 1.2 | `engine/pad/stickCurve.ts`, `tools/sim*`, `player/bots/StickHand.ts`, `movement-tuning.md`, `tests/pad.test.ts` | S0 | S1b (API von 1.1 steht hier im Plan), S2a |
| **S1b** Eingabe-Kern | 1.3, 1.4 | `engine/pad/*` (außer stickCurve), `InputState.ts`, `Input.ts`, `Game.ts`, `debug.ts`, `tools/pad/pad-check.ts`, `tests/input.test.ts` | S0; Defaults aus S1a vor Merge | S1a, S2a |
| **S1c** Menü/Glyphen | 1.5, 1.6, 1.7 (1.8 optional) | `ui/padNav.ts`, `Menu.ts`, `menu.css`, `menuLab/types.ts`, `menuLab/ps2/*`, `Hud.ts`, `ui/glyphs.ts`, `Coach.ts`, `tests/frontDoorContract.test.ts` | Aktions-/Glyph-API aus §3 (codiert dagegen), Merge nach S1b | S2a |
| **S2a** Electron | 2.1, 2.2 (ohne main.ts-Verdrahtung), 2.3 (main-Seite), 2.6, 2.7 | `electron/**`, `electron-builder.yml`, `package.json`, `src/platform/**`, `tools/desktop/*` | — | S1a, S1b, S1c |
| **S2b** Integration Desktop | 2.2 (`main.ts`), 2.3/2.4 (Input.ts), 2.5 (Menu/ps2/types) | `main.ts` + die kleinen Hooks in `Input.ts`, `Menu.ts`, `ps2/index.ts`, `menuLab/types.ts` | S1b + S1c + S2a gemergt | — (seriell) |
| **S3** Login | 3.1 | `electron/auth.ts`, `SupabaseService.ts`, `supabaseApi.ts`, `tests/supabaseService.test.ts` | S2a (Bridge) | S4 |
| **S4** Steam | 4.1–4.4 | `electron/steam.ts`, `src/platform/achievements.ts`, `src/platform/steam.ts` | S2a | S3 (beide fügen in `electron/main.ts`/`preload.cts` je eine Registrierung ein, die S2a als Hook-Liste `electron/modules.ts` vorbereitet) |
| **S5** Polish | 5.x | je Zeile | S2b | teilweise (5.2 Loop vs. 5.5 ps2) |

**Laufen gleichzeitig ohne Dateikonflikt:** S1a ∥ S1b ∥ S2a (nach S0). S1c beginnt gegen die in §3 festgelegte API und
merged nach S1b. S3 ∥ S4 nach S2a. `Game.ts` gehört in Phase 1 **nur** S1b. `Menu.ts`/ps2 gehören **nur** S1c. S2b fasst
beide erst an, wenn sie gemergt sind. Gemeinsame Ports: pad-check 5730, desktop-smoke ohne Port (Electron lädt `app://`),
`desktop:dev` 5173. Lernerfahrungen in `.docs/learnings/inbox/<strang>.md`.

## 6. Verifikation gesamt (Definition of Done dieser Iteration)

1. `npm run typecheck` 0, `npm test` grün inklusive `submitFunction` (nach S0-Upload), `npm run sim` zeilengleich,
   `npm run sim -- --section stick` mit Bericht in movement-tuning.md.
2. `npx tsx tools/replay/online-check.ts`, `npx tsx tools/menu/shot.ts` (ps2, classic) unverändert grün. Web-`dist/`
   ohne Electron-Code (Grep 2.2).
3. `npx tsx tools/pad/pad-check.ts` (auch bei 1280×800): kompletter Ablauf nur mit Pad, Pad-Replay in Node bitgleich.
4. `npx tsx tools/desktop/smoke.ts`: Sicherheit, Kürzel, Beenden, Speicher, Determinismus L1–L4.
5. `win-unpacked` startet auf einem sauberen Windows ohne Node/Dev-Server.
6. AGENTS.md §2 (neue Befehle), §3 (Baum: `electron/`, `src/platform/`, `src/engine/pad/`), §3.4 (Verträge aus §3) und
   movement.md §3 (Stick-Satz) nachgezogen.

## 7. Risiken

- **Stick-Strafen bei niedrigem Tempo** braucht hohe Drehraten. Fällt der Sim-Befund (1.2) schlecht aus, bleibt nur
  Boost/Kurve, kein Physik-Eingriff. Pad-Spieler könnten an Gold/VELOCITY scheitern. Das ist akzeptiert und
  dokumentiert, Medaillen werden nicht für Pads umgebaut. Gyro (Steam Input → Maus) ist der übliche Ausweg und läuft
  ohne Code über den Mauspfad.
- **Bundle-Upload braucht `SUPABASE_SECRET_KEY`** (S0). Ohne ihn bleibt ein Test rot, bis der Betreiber hochlädt.
- **Steam-Overlay in Electron** braucht GPU-Schalter, die Frametime/VSync verändern können (4.2 misst das).
- **Steam Deck/Proton:** Electron unter Proton ist meist ok, aber nicht garantiert. Eine native Linux-Build ist der
  Plan B (5.7).
- **Electron-Chromium ≠ Playwright-Chromium** (Versionsdrift). detMath sollte das abdecken, 2.6 belegt es je
  Electron-Update. Bei jedem Electron-Bump 2.6 erneut.
- **Gamepad-Erkennung unter Steam Input** liefert oft ein emuliertes Xbox-Pad. Glyphen dann über die Einstellung bzw.
  später über die Steam-Input-API.
- **Pad ohne Geste im Web:** kein Ton und kein Vollbild bis zum ersten Klick/Tastendruck. Ein Hinweis ist eingeplant,
  am Desktop ist es gelöst.
- **`beforeunload` in Electron** (Fenster schließt nicht) und **App-Menü-Kürzel** (Strg+W schließt das Fenster) sind
  echte Fallen. 2.4 misst beides.

## 8. Offene Spieler-Fragen (blockieren nichts)

1. **Steam-Partner-Konto + App-ID (100 $ Steam Direct Fee, Steuer-/Bankdaten).** Bis dahin nur App-ID 480. Davon hängen
   ab: echte Achievements, Rich-Presence-Texte, Store-Seite, Steam-Auth (3.2), Steam Cloud.
2. **Supabase-Redirect-URLs für den Desktop-Login** — **derzeit NICHT nötig** (S3, live geprüft 06.11.): Supabase Auth
   nimmt Loopback-IPs (`127.0.0.1`, jeder Port/Pfad) nach RFC 8252 ohne Eintrag an. **Nötig erst, wenn die Site-URL nicht
   mehr auf 127.0.0.1/localhost zeigt** (z. B. auf die öffentliche Web-Adresse umgestellt) oder Supabase die
   Loopback-Regel ändert:
   Dashboard → Authentication → URL Configuration → *Redirect URLs* → *Add URL*, genau diese drei (der Rücksprung trägt
   `?state=…`, Supabase vergleicht inklusive Query — daher `/**`, eine exakte `/auth/callback`-Adresse würde NICHT passen):
   `http://127.0.0.1:47823/**` · `http://127.0.0.1:47824/**` · `http://127.0.0.1:47825/**`.
   Fehlen sie dann, landet der Browser nach dem Login auf der Site-URL statt auf "Login fertig"; im Spiel bleibt "Login
   läuft" stehen (Abbrechen geht jederzeit), nach 5 min kommt "Keine Rückmeldung aus dem Browser …".
   **Abnahme (Betreiber):** `npm run desktop:build` → `release/win-unpacked/VELOCITY.exe` → Titel/System "Mit Discord
   anmelden" → Browser → Discord freigeben → Seite "LOGIN FERTIG" → im Spiel Avatar + Name; danach einen Lauf einreichen
   (Toast "Geprüft · Rang …"); Spiel beenden, neu starten → weiter angemeldet (Sitzung aus `userData/auth/session.bin`).
3. **Bundle-Upload (Betreiber, braucht `SUPABASE_SECRET_KEY`)** — in PowerShell im Projektordner:
   `$env:SUPABASE_SECRET_KEY="sb_secret_…"; node tools/online/upload-bundle.mjs; Remove-Item Env:SUPABASE_SECRET_KEY`
   (lädt `verifier-f2d04931….js` hoch und pinnt den SHA in `supabase/functions/submit-run/index.ts`), danach
   `npx supabase functions deploy submit-run` (oder MCP `deploy_edge_function`), GET der Function zeigt `bundle` =
   `f2d049319…`, dann `npx vitest run tests/submitFunction.test.ts` grün. Bis dahin ist genau dieser eine Test rot.
4. **Code-Signing-Zertifikat** (Geld, ~200–400 $/Jahr) nur nötig für Verteilung außerhalb von Steam (itch.io,
   Direktdownload, SmartScreen). Für Steam nicht nötig, vorerst nein.
5. **macOS-Build** braucht ein Apple-Developer-Konto (99 $/Jahr) + Notarisierung. Vorerst nur Windows (+ Linux später).
6. **Steam-Deck-Ziel:** "Verified" anstreben (heißt u. a. On-Screen-Keyboard, Glyphen, 1280×800-Lesbarkeit) oder
   "Playable" reichen lassen? Der Plan baut auf Verified-Niveau hin.
7. **Pad-Default-Belegung** (Bumper-Sprung, seit Review A9 Sprint/"Langsamer" auf **LT** statt L3) und Stick-Werte
   (Pitch-Snap 0.2, Boost-Hysterese 0.85/0.95): Abnahme durch Spielgefühl (1.9).
8. Preis / kostenlos und ob die Web-Version neben Steam weiter frei spielbar bleibt. Technisch geht beides, betrifft
   aber Store-Positionierung und Bestenliste (eine gemeinsame Tafel für Web und Steam ist der aktuelle Stand).

## 9. Status

| Phase | Stand |
|---|---|
| 0 Bundle entkoppeln | umgesetzt (06.11.); **Upload offen** (Secret-Key, Betreiber, §8.3) → `tests/submitFunction` "pinnt genau dieses Bundle" bis dahin rot |
| 1 Controller | 1.1–1.7 umgesetzt (S1a/S1b/S1c, Integration 06.11.), Review A1–A10 + N1–N3 behoben (07.11.); offen 1.8 (Texte), 1.9 (Abnahme) |
| 2 Electron Windows | umgesetzt (S2a + S2b 06.11.): 2.1–2.7; Review C1–C8 + N1 behoben (07.11.); `tools/desktop/smoke.ts` 83/83 |
| 3 Desktop-Login | 3.1 umgesetzt (S3 06.11.): Loopback-Login + verschlüsselte Sitzung; Review B4 ("Login läuft" + Abbrechen) + Nachbefunde (07.11.); `tools/desktop/authSmoke.ts` 15/15; offen: echter Discord-Login aus `win-unpacked` (§8.2); 3.2 nur Skizze |
| 4 Steamworks-Gerüst | umgesetzt S4 (06.11.): 4.1–4.4 hinter `--steam`, nur mit Fake geprüft (steam-check 24/24); offen: Betreiber-Prüfung mit echtem Client (Spacewar, Presence, Frametime 4.2), GameOverlayActivated fehlt in steamworks.js 0.4.0 |
| 5 Polish | offen |

### Review-Fix-Runde (2026-11-07)

Adversariales Review von e6ec5ee in drei Strängen (pad-core, menu-ui, desktop: Fix → Review → ggf. Reparatur), danach
serieller Abschluss. Replay-Format, `PHYSICS_VERSION`, `GameSettings`, Bundle (`f2d04931…`) unverändert; `npm run sim`
bitgleich zum Stand vor Plan 011 (c1de206). Verträge: AGENTS.md §3.4 "Plan 011 Review-Fix-Runde".

**Umgesetzt pad-core (A1–A10, Nachbefunde N1–N3):**
- A1 Kein Blick-Drift hinter Pause/Laden: PadInput hält im Menü-Kontext Bewegung + Blickrate an; Game synchronisiert den
  Kontext vor dem Poll (pad-check: 0.00° nach 1 s Pause, vorher 85°).
- A2 Pitch-Snap 0.2 (axiale Deadzone nur für Pitch), Boost nur auf Yaw: Strafe mit 5–8° Schräglage nickt nicht mehr.
- A3 Hysterese: Boost-Uhr `edgeClock` (0.95 an / 0.85 aus), `digitizeMove` ±3.5° und Betrag 0.3/0.2. Stick-Sim bei den
  Defaults jetzt H20 98.4 / 98.2 / 97.3 %, t→500 1.10× / 1.10× / 1.13× (Kriterium hält auch bei 6 % Rauschen).
- A4 Pad-Aktivität nur auf der Flanke, Maus im Lock übernimmt erst nach 0.25 s Pad-Ruhe (kein Geräte-Flattern).
- A5 Aufnahme-Frist läuft ohne Pad. A6 Fake-Pad-Läufe sind assistiert. A7/N1 Pad-Modus: der Ton-Klick beendet den
  Pad-Modus nicht, danach bringt ein Klick Maus + Lock zurück; Taste schaltet Ton frei.
- A8/N2 Pad-Verlust pausiert immer; Steam-Input-Spiegel bestätigt nicht von selbst; dasselbe Pad zurück zählt sofort;
  Nicht-Standard-Mapping ignoriert. A9 Sprint/"Langsamer" auf LT, L3 frei.
- A10/N3 F1-Tuning nur mit Dev-Werkzeugen; am Desktop wertet `finishRun` manipulierte Läufe (`runTampered`) lokal nicht.

**Umgesetzt menu-ui (B1–B5) + Abschluss:**
- B1 Pad-Belegung ohne Pad gesperrt + Hinweis. B2 Vollbild ohne Geste → Hinweis statt stillem Fehlschlag.
- B3 Pad-Fokus nach Teil-Neuaufbau auf den nächsten Index, erstes A zeigt nur.
- B4 Desktop-Login: modaler Hinweis "Login läuft" (Browser erneut öffnen / Abbrechen per Esc, Pad B, Maus);
  SupabaseService löst Abbruch ohne Fehler auf, meldet jedes Login-Ende ohne Anmeldung.
- B5 rave/arcade/hub/stubDoor zeigen Admin nur mit `adminMenu`.
- Abschluss: Leertaste/Enter unter "Login läuft" wirken nur auf Knöpfe im Hinweis (arcade klickte sonst das inerte LOGIN
  darunter, desktop-check rot→grün); Abbruch während `begin()` noch bindet geht nicht mehr verloren (Vitest rot→grün);
  Tastenhilfe nennt F1 nur mit Dev-Werkzeugen.

**Umgesetzt desktop (C1–C8) + Abschluss:**
- C1 `--dev` nur unverpackt (`isDevRun`); `window.__vel` am Desktop nur im Dev-Modus; exe ignoriert `--dev/--query/--fault`.
- C2 Drosselung minimiert/versteckt → Page Visibility wirkt (Spiel pausiert, 0 rAF/s). C3 Bildschirm wach nur im Vordergrund.
- C4 Start-/Renderer-Fehler: einmal neu laden, sonst Dialog + Exit 1; Hänger-Erholung wartet auf das eigene
  `render-process-gone`; Fenster spätestens nach 10 s sichtbar.
- C5 Speicher-Spiegel: Generationen, fsync + rename, Retry, `flushPendingSync` bei Beenden/session-end, Renderer plant neu.
- C6 Modul-setups parallel unter einem Zeitlimit; C7 Alt+Enter/F11 im Hauptprozess; C8 kein `as unknown as`.
- Abschluss (Review N1): Moduswechsel per Kürzel erreicht den Renderer (`vel:window:mode` → `PlatformWindow.onModeChange`),
  die offene Einstellung "Anzeigemodus" zeigt sofort den richtigen Modus (Smoke + Vitest).

**Verifikation Abschluss (07.11.):** siehe Bericht des Abschluss-Laufs; Kurzfassung: tsc 0/0, Vitest 931/932 (nur
submitFunction-Pin rot), sim bitgleich zu c1de206, stick-Kriterium hält, shot 41/41, Menü-Labor OK, pad-check 26/26,
menu-check 1280×800 + 1920×1080 OK, online-check OK, dist-Grep 0 (Plan-Muster), Bundle `f2d04931…`, desktop:build ok,
smoke 83/83, authSmoke 15/15, steam-check 24/24 (nur Fake).

**Offen nach der Runde:** Bundle-Upload (§8.3); echter Discord-Login und echter Steam-Client (Betreiber); 1.8/1.9;
`finishRun`-Desktop-Zweig ohne End-to-End-Test (nur `configTampered` + Recorder-Semantik getestet); gespeicherte
Pad-Belegungen mit L3 werden nicht migriert (unkritisch, solange Plan 011 nicht ausgeliefert ist).
