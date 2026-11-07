# VELOCITY — Projektkontext

> Single Source of Truth. `CLAUDE.md` ist nur ein Zeiger hierher.
> **Vor jeder Movement-Arbeit `.docs/rules/movement.md` lesen.** Das ist verbindlich.
> **Vor jeder Grafik-Arbeit `.docs/rules/look.md` lesen.**

---

## 1. Was das hier ist

Ein browserbasierter First-Person-3D-Plattformer. Optik: gepixelte PS2-Ära
(Low-Res-Render-Target, Dithering, Vertex-Licht, Fog). Gameplay: das
Bewegungsgefühl von CS2/Source — Bodenreibung, Air-Strafing, Bunnyhop,
Surfen auf steilen Rampen — als Parcours statt Shooter.

Die einzige Erfolgsmetrik: **Fühlt sich das Movement geil an?**
Grafik, Content, Story sind zweitrangig. Wenn eine Entscheidung zwischen
"sieht besser aus" und "fühlt sich besser an" wählen lässt: immer fühlen.

Bewusst **nicht** in dieser Version: Walljump, Wallrun, Double-Jump, Waffen,
Stamina-/Landestrafe (würde Bhop töten), Multiplayer; seit Plan 007 außerdem Trail, Musik-Packs,
Jump-Pads/Boosts/Ringe. **Online (Plan 009, Supabase umgesetzt 06.11.):** jeder Lauf wird als Replay aufgenommen, in der
Supabase Edge Function `submit-run` mit DEMSELBEN Verifier nachgespielt und nur mit der nachgerechneten Zeit gerankt;
Bestenliste und "gegen Ghost fahren" im Menü. **Login nur per Discord**; ohne Login voll spielbar (lokale Bestzeiten,
Ghosts, Bestenliste lesen) — nur Einreichen braucht den Login. Mock (`?online=mock`) bleibt für Tests/Offline.

**v2 (Plan 007, umgesetzt 29.09.):** Das Movement soll **Spaß machen, arcadig, smooth und befriedigend** sein,
nicht 1:1 CS. Arcade-Pass: Lande-Gnade (8 Ticks), deterministische Hang-Landung (mit gestundetem Bergauf-
Verlust), Anfänger-Cap 40, Kanten-Assist (Lip-Step 5 u + Tempo-Gedächtnis), **Rutschen** (Sprint + C) und
**Luftlenkung mit W** (Default an) — im CS2-Preset alles aus, bitgleich zum Source-Port (movement.md §1). Vier
Level: 01 GRUNDKURS, 02 SCHLEIFE, **03 BRANDUNG — Halt die Linie.** (reine Surf-Map mit Gabel Koralle/Türkis),
**04 TURM — Tempo ist Höhe.** (Wendel mit Crouch-Kanten, Surf-Abfahrt). **Trainingsmodus** aus acht Lektions-
Maps T1–T8 (Grundlagen: Erste Schritte, Auto-Hop, Air-Strafe, Speed; Fortgeschritten: Kurven, Crouch-Jump,
Surf halten, Surf-Speed): Stufen mit Aufgaben, StrafeJudge-Urteil je Hop, Tore, Vorführung per **H**, Sterne
(★ Pflicht, ★★ Bonus, ★★★ Meister — Meister gibt nur Sterne), kein Tod, kein Timer, keine Bestzeit.

**Viewmodel: ja — eine Cartoon-Hand** (Nutzerwunsch 2026-09-28, vorher "kein Viewmodel";
seit Plan 006 ein echtes Low-Poly-3D-Viewmodel im Stil der Referenzen unter `hand screens/`):
weißer Handschuh mit weicher Grau-Schattierung, dicke dunkle Kontur, pummelige Finger, Stulpe
mit schwarzem Band, unten rechts im 16:9-Safe-Frame. Sie spiegelt das Movement (Sprung, Landung,
Sway, Surf, Tempo), nie umgekehrt; abschaltbar ("Hand anzeigen"), Bewegung hängt an `motionFx`.
Kosmetik (Plan 005/006/007, 14 Freischaltungen): Handschuhe Neon (L1-Gold), Skelett (L2-Gold), Gold (Gold in
L1–L4), Roboter (Training T1–T8 bestanden), **Katzenpfote** (VELOCITY in L1–L4, Cartoon-Stil); Gegenstände
Fidget-Spinner (Training T1–T4), Münze (Bronze in L1–L4), Jo-Jo (L1-Silber), Sturmfeuerzeug (L2-Silber),
Kendama (L3-Silber), **Handy mit Selfie im Ziel** (L4-Silber, Polaroid im Ergebnis), Sammelkarte
(L1-VELOCITY), Energy-Drink-Dose (L2-VELOCITY), Butterfly-Messer (beide VELOCITY). Mit Gegenstand macht die
Hand Tricks, je schneller, desto wilder; beim Surfen hat jeder Gegenstand einen Surf-Zustand.

Sprache: Doku und Kommentare Deutsch, Bezeichner Englisch. Spielbegriffe
bleiben englisch (Bhop, Strafe, Surf, Speed, Checkpoint).

---

## 2. Stack & Befehle

| Bereich | Wahl |
|---|---|
| Build | Vite 8 · TypeScript 5.9 strict · ES2022 |
| 3D | three.js 0.186 — nur Rendering, **keine** Physik-Libs |
| Audio | Web Audio API, 100 % prozedural, keine Audiodateien |
| Tests | Vitest (Physik, headless) · Playwright (Screenshots, Audio-Offline-Check) |
| Dev-UI | lil-gui (Tuning-Panel, nur mit F1) |

```bash
npm install
npm run dev            # http://localhost:5173
npm run typecheck
npm test               # Vitest: Kollision + Movement + Bots
npm run sim            # Movement-Sim: Bots vergleichen, Tuning-Report (-- --section arcade|stick | -- --preset cs2)
npm run levels:build   # tools/levels/*.ts → public/levels/*.json + index.json, Lektionen → public/levels/training/
                       #   (-- <id>|training|<Lektions-id>: nur diese Dateien, NIE index.json → danach ohne Filter bauen!)
                       #   Medaillen (Regel 10): Bronze 3°-Hand, Silber 2°-Hand (48 Seeds, safeRoute), Gold = max(1°-Hand × 1.05,
                       #   perfekt × 1.1), VELOCITY/Autor perfekt (49 Start-Jitter); je Modell der schnellere Median aus
                       #   RouteFollower und Surf-Referenz MIT DERSELBEN HAND (L3/L4); Staffel ≥ 4 % je Stufe (staggerMedals)
npm run levels:check   # Level + Lektionen validieren (statisch, Bot-Durchläufe, Raster, Design-Proben, Selbsttest; ~3 min)
                       #   (-- <id>|<datei>|training: auch Level außerhalb des Index; jedes Argument muss treffen)
npm run shot           # Hero-Shots aus dem echten Spiel + Ablauf-Checks (eigener Server, Port 5190, SHOT_PORT=…; -- --check nur Checks)
                       #   inkl. Kanten-Assist live (L1-Crouch-Kante, mit/ohne Assist) und Trainings-Tipp im Ergebnis ohne Medaille
npm run playtest       # Bot spielt L1–L4 + Sandbox in Echtzeit im Browser → shots/playtest/report.json (Port 5191, PLAYTEST_PORT=…)
node tools/training-shots.mjs [tN …]    # Trainingsmodus im Spiel: Lektionen, Vorführung, Tore, HUD (erzwungenes Layout 216/270/360 Zeilen,
                       #   Stufenwechsel, Neuling ohne Anlauf), Admin-Sterne → shots/training/ (Port 5348, TRAIN_PORT=…; TRAIN_LESSONS=<dir>)
npx tsx tools/levels/training/check.ts [tN]   # Bot-Matrix der Lektionen direkt aus den Buildern (turnwindow.ts: Judge-Schwellen neu erzeugen)
node tools/cosmetics/vm-hash.mjs check  # Viewmodel pixelgleich: 252 Kachel-Hashes gegen die Baseline (VMHASH_PORT=…; write|cmp)
npx tsx tools/cosmetics/envelope.ts [item]    # Bild-Hülle der Tricks (Exit 1 bei Verstoß, auch gegen ITEM_HULL)
npx tsx tools/cosmetics/event-probe.ts [--levels l1,… --seeds N]  # Trick-Takt je Gegenstand auf L1–L4 → shots/v2/kosmetik/
                       #   (Exit 1 bei Verstoß gegen Plan-007-Grenzen; ohne Filter laufen lassen, sonst schreibt sie nur die gewählten Items)
npx tsx tools/cosmetics/rope-hang.ts    # Schnur framerate-unabhängig (Pendel-Abweichung je Framerate, px)
npx tsx tools/cosmetics/unlock-ladder.ts [--seeds N]  # Freischalt-Leiter über Bot-Spielertypen mit den gebauten Medaillen (Default 48 = MEDAL_SEEDS)
node tools/alloc-probe.mjs [level] [s]  # Heap-Sampling im echten Spiel (Port 5199, ALLOC_PORT=…; --warmup 60 = Dauerbetrieb, fallen.md #65)
node tools/ghost-check.mjs [level]      # Ghost der Bestzeit: Bot gegen eigenen Ghost (Port 5232, GHOST_PORT=…)
npm run audio:check    # Musik offline rendern + spektral prüfen
node tools/viewmodel-shots.mjs [filter] # 3D-View-Hand im Spiel → shots/viewmodel/ (Port 5282, VM_PORT=…); filter: scenes|uw|hud|props|live|compare|menu|finish|skins|items|budget|snapshot|ingame|selfie
                       #   finish: Ergebnis ohne Handy (kein Foto) und mit Handy (HUD-Stempel FOTO, Polaroid finish-phone.png)
node tools/admin-shots.mjs              # Admin-Menü: Screenshots + Ablauf-Checks (Sperren überleben Neuladen, Medaille setzen, Ghost weg) → shots/admin/ (Port 5290, ADMIN_PORT=…)
node tools/viewmodel-sheet.mjs <spec.json> <out.png>  # Viewmodel-Kacheln ohne Spiel über dev/viewmodel.html (Posen, Griffe, festgehaltene Tricks; Port 5282, VMSHEET_PORT=…)
                       #   Zellen: view {yaw, pitch, dist, target} = Orbit-Kamera (Seiten-/Unteransicht), live.play = Trick frei bis `at`
node tools/hand-audit.mjs <out> rest|skins|tricks|knife|all [item …]   # Plan 008: Griff-Kontaktblätter (Spielbild + 6 Winkel, alle Skins) und
                       #   Zeitlupen-Blätter (trick <item> <trick> [s] [open]); Port 5500 (VMSHEET_PORT=…). Live: dev/viewmodel.html?live&item=knife&trick=open&speed=0.25
npx tsx tools/hand-contact.ts [item] [--glove g]      # Griff in Zahlen: Abstand je Handteil (Durchdringung/Kontakt/Schweben)
npx tsx tools/hand-grips.ts <item> [--from|--open|--to pose] [--mask 31] [--pos|--view …]  # Griff-Pose mit Finger-Kontakt backen
npx tsx tools/knife-tune.ts open|close [--iters N] [--seed s] [--probe p…]  # Butterfly: Handgelenk-Flick per Physik-Suche
node tools/trailer/takes.mjs [take …]   # Trailer-Footage deterministisch (Film-Modus, 1/60 s je Frame) → media/footage/frames/<take>/
node tools/trailer/cut.mjs [clip …]     #   (Port 5600, TRAILER_PORT=…); cut: Clips → media/footage/*.mp4 (1080p60, CRF 14), clips.json, contact.png
node tools/trailer/takes2.mjs [take …]  # 60-s-Trailer (Port 5601): Verfolger-Drohne chaseL1–4 (Ghost-Hologramm als Läufer, weicht
                       #   Surf-Rampen aus), Ego fpL1–4 (nur Speedometer), ghostL1, bulletL1 (Bullet-Time), flyL2/flyL4
node tools/trailer/music60.mjs          # 60-s-Musik aus der Engine (Port 5604): Cold Open gedämpft + Tape-Stop, main ab Takt 2
                       #   → media/audio/trailer60_music.wav, stems/sfx_wind_60.wav, cues60.json
node tools/trailer/edit60.mjs [--cut30] [--vertical]  # Schnitt direkt aus den Take-PNGs (Rampen/Standbild frame-genau)
                       #   → media/velocity_trailer_{60,30}s[_vertical].mp4, Kontaktblatt media/trailer60_check/
npx tsx tools/levels/medalProbe.ts      # Spiel-Uhr-Median mehrerer Bot-Modelle je Level (Grundlage der Medaillen)
npx tsx tools/replay/verify.ts <replay> | --bot <level> [--noise 1]   # Replay-Verifier (Plan 009) wie in der Cloud Function
npx tsx tools/replay/online-check.ts    # Playwright (Port 5701, ONLINE_PORT=…): Lauf → Einreichen → Bestenliste → Ghost,
                       #   Chromium ⇄ Node bitgleich, Offline-Fallback → shots/online/ (immer ?online=mock)
npx tsx tools/online/login-check.ts     # Playwright gegen das ECHTE Supabase (Port 5711, LOGIN_PORT=…): Login-Knopf, Bestenliste
                       #   öffentlich, Ergebnis ohne Login, Redirect zu Discord + Replay-Sicherung → shots/login/
node tools/online/build-function.mjs [--check]   # Verifier-Bundle der Edge Function (esbuild, 1 ESM-Datei mit Leveln)
SUPABASE_SECRET_KEY=… node tools/online/upload-bundle.mjs   # Bundle → privater Bucket function-assets, SHA in index.ts
                       #   pinnen; danach index.ts deployen (npx supabase functions deploy submit-run | MCP). Ablauf: Plan 009 §14
                       #   PowerShell: $env:SUPABASE_SECRET_KEY="…"; node tools/online/upload-bundle.mjs; Remove-Item Env:SUPABASE_SECRET_KEY
npx tsx tools/menu/shot.ts              # Menü-Labor (Plan 010): Screenshots je Hauptmenü-Stil + Konsolenfehler → shots/menu/<id>/
                       #   (Port 5720, MENU_PORT=…; MENU_STYLE=<id>[,<id>], MENU_SIZE=WxH[,WxH], MENU_WAIT=ms; immer ?online=mock)
npx tsx tools/pad/pad-check.ts          # Controller im Spiel nur mit Fake-Pad (__vel.pad): Start per A ohne Lock, Stick/Kamera/LB,
                       #   Blur/Start/Trennen pausiert, kein Blick-Drift hinter der Pause, Fake-Pad-Lauf = assistiert, Ton-Geste
                       #   per Taste/Klick unter emuliertem Autoplay → shots/pad/ (Port 5730, PAD_PORT=…; immer ?online=mock)
npx tsx tools/pad/menu-check.ts         # Menü nur mit Fake-Pad (echter Pfad InputManager → Menü): alle Screens erreichbar, Glyphen
                       #   Xbox/PS/Tastatur im nächsten Frame, Belegungs-Aufnahme, Web ohne Beenden → shots/pad/menu/
                       #   (Port 5731, PADMENU_PORT=…; PADMENU_SIZE=WxH[,…], PADMENU_STYLES=0 = nur ps2); dazu Review-Proben
                       #   (PADMENU_REVIEW=0 aus): Belegung ohne Pad gesperrt, Vollbild ohne Geste → Hinweis, Fokus nach Neuaufbau
npx tsx tools/menu/desktop-check.ts     # Menü mit Fake-Desktop-Bridge (Port 5722): "Login läuft" (Abbrechen per Esc/Pad A/B/Maus,
                       #   erneut öffnen, Frist), alle Stile ohne --dev ohne Admin → shots/menu/desktop/
npx tsx tools/menu/sound-check.ts       # Menü-Klänge (Port 5732): PS2 + Klassik, Pfeile/Enter/Esc → genau ein move/confirm/back,
                       #   wirkungsloses Esc still (src/ui/menuSound.ts → TechnoAudio.uiSound)
npm run build          # danach: grep -rE "electron|ipcRenderer|contextBridge|steamworks|require\(" dist/assets = 0 Treffer
                       #   (`velocityDesktop` steht zwangsläufig drin: detectPlatform liest die Bridge, fallen.md #314)
npm run desktop:dev    # Electron-Hülle (Plan 011) gegen den Vite-Dev-Server 5173, mit --dev (DevTools)
npm run desktop:start  # Electron gegen die gebaute dist/ (app://velocity); vorher npm run build
npm run desktop:build  # build + tsc -p electron + electron-builder --win dir → release/win-unpacked/VELOCITY.exe, danach
                       #   tools/desktop/check-build.mjs (kein steam_appid.txt, steam_api64.dll neben der exe, Binding entpackt)
npx tsx tools/desktop/smoke.ts [--no-exe]   # Desktop-Smoke (Playwright _electron + exe per CDP): Sicherheit, Kürzel (echte
                       #   OS-Tasten nur nach PID-Prüfung des Vordergrundfensters), Strg-Ducken, Lock + Esc, Anzeigemodus, Alt+Enter/
                       #   F11, Spiegel (Local Storage gelöscht → eingespielt), kein Admin/__vel ohne --dev, Beenden per Fake-Pad,
                       #   Determinismus L1–L4 ⇄ Node; D: Minimieren ohne Playwright (rohes CDP, Visibility/Drosselung/Blocker),
                       #   E: Fehler-Injektion --fault=… (nur Dev-Binary); exe: --dev/--query wirkungslos → shots/desktop/
                       #   (öffnet echte Fenster; vorher npm run build bzw. desktop:build; Hang-Fall dauert bis ~50 s)
npx tsx tools/desktop/authSmoke.ts      # Desktop-Login (Plan 011 §3.1): echtes Electron + Live-Supabase, --dev --auth-no-browser
                       #   (kein System-Browser, keine OS-Tasten): Empfänger/state/Allowlist, Tresor (DPAPI), Login-Knopf →
                       #   simulierter Abbruch bei Discord → Toast im Menü → shots/desktop/auth-report.json (vorher npm run build)
npx tsx tools/desktop/steam-check.ts [--no-exe]   # Steamworks-Gerüst (Plan 011 Phase 4) NUR mit Fake (--steam immer mit
                       #   --steam-fake, VELOCITY_STEAM entfernt — nie "Spielt Spacewar" auf dem echten Konto): ohne Flag nichts,
                       #   "Steam läuft nicht" = 1 Log + caps aus, Presence Menü/L2/Ghost/Training, Overlay → Pause, Achievements
                       #   unter CDP/--dev aus, exe: Fake ohne --dev gesperrt → shots/desktop/steam/ (vorher npm run build)
```

> Electron-Falle (Node < 22.12): `npm install` meldet Erfolg, aber das Electron-Binary fehlt (install.js lädt
> ESM per require). Dann `cd node_modules/electron && node --experimental-require-module install.js`.

> Windows-Falle: Falls Vite/Vitest mit *"Cannot find native binding"* abbricht,
> fehlt `@rolldown/binding-win32-x64-msvc` (npm-Bug #4828). Ist in
> `optionalDependencies` gepinnt; notfalls `npm i` erneut. Siehe `.docs/learnings/`.

---

## 3. Architektur

```
src/
  main.ts            Einstieg: DOM, Renderer, Audio, Game zusammenstecken
  engine/            Game-Loop (fixed timestep 128 Hz + Interpolation), Input
                     (Pointer Lock, Raw-Maus, Mausrad-Jump), Settings, Events, Game
  engine/pad/        Controller (Plan 011, DOM-frei): PadInput (Polling, Flanken, Menü-/Spiel-Kontext, Belegungs-Aufnahme),
                     stickCurve (Deadzone, Drehrate, 8 Richtungen), padSettings (velocity.pad.v1), prompts, types
  world/             Level-Format, Brush-Kompilierung (konvexe Hüllen), Box-Traces
  player/            PlayerMovement (Source-pmove-Port), CameraRig, Bots
  audio/             Prozeduraler Techno: Sequencer, Instrumente, Mixer, SFX
  render/            PS2-Pipeline: Low-Res-Target, Materials (Vertex-Licht, Fog,
                     Affine, Snap), Post (Dither, Quantisierung, CA), Himmel, Trims,
                     Viewmodel (render/viewmodel: 3D-Hand + Gegenstände, Plan 006)
  ui/                HUD (Bitmap-Font im Low-Res-Raster), View-Hand-Logik (ui/hand: Bewegung,
                     Posen, Tricks — DOM-/three-frei), Menüs (HTML), Tuning-Panel
  engine/replay/     Replays (Plan 009): Quantisierung, Binärformat, Recorder, RunSimulator, Verifier, Ghost aus Replay
  online/            OnlineService (anbieter-unabhängig), LocalMockService, SupabaseService (+ supabaseApi: supabase-js-
                     Adapter, dynamisch geladen), submitVerifier (Server-Prüfung), pendingSubmit (Lauf über den Login retten)
  platform/          Plattform-Schicht (Plan 011): platform() → web (Default) | desktop (Bridge window.velocityDesktop,
                     nur Typen in bridgeTypes.ts), saveMirror (velocity.* → userData/save/save.json); Steam (Phase 4,
                     Desktop-Chunk): steam (Rich Presence, Overlay → Pause), achievements (Live-Ereignisse → IDs,
                     velocity.achv.v1, 480-Test-Tabelle), live (Game-Hook-Typen, isCleanFinish)
electron/            Desktop-Hülle (Plan 011, eigenes tsconfig, Node-Typen nur hier): main, preload.cts (sandboxed, CJS),
                     protocol (app://velocity → dist/, CSP), policy (reine Regeln: isDevRun, Kürzel, Faults, IPC), window
                     (Anzeigemodus, Alt+Enter/F11, Drosselung), power (Bildschirm wach), recovery (Renderer-Ausfälle), save
                     (atomar, Generationen, Retry), modules + moduleRunner (Hook-Liste Login/Steam, gemeinsames Zeitlimit),
                     auth + session + authModule (Loopback-Login, verschlüsselte Sitzung),
                     steam + steamFake (Steamworks hinter --steam, init(480) nach dem ersten Bild)
                     → kompiliert nach out/electron/, electron-builder.yml → release/
supabase/            migrations/*.sql (Schema, RLS, Funktionen, Buckets — so auch eingespielt), functions/submit-run/
                     (index.ts Handler + verifier.bundle.js, generiert)
public/levels/       Level-JSON (generiert aus tools/levels/)
tools/               Sim, Level-Build/-Check, Playwright-Harnesses
tests/               Vitest
```

### 3.1 Einheiten: Source-Units, Y oben
Alles — Physik, Level, Rendering — rechnet in Source-Units (1 u ≈ 1 Zoll).
Keine Umrechnung irgendwo. Wer aus CS kommt, erkennt 250 u/s, 57 u Sprunghöhe,
800 u/s² Gravitation wieder; der Speedometer zeigt u/s wie auf KZ-/Bhop-Servern.
Einzige Abweichung von Hammer: **Y ist oben** (three.js), nicht Z.

### 3.2 Kollision wie Quake/Source, nicht wie ein Physik-Engine
Die Welt besteht aus konvexen **Brushes** (Box, Wedge, Prisma, Hülle; optional
um Y gedreht). `compileLevel` baut daraus Ebenen (+ achsparallele Bevels) und
sichtbare Flächen. Der Spieler ist eine **achsparallele Box** (32×72, geduckt
32×54), die per `traceBox` durch die Welt geschoben wird
(`CM_TraceThroughBrush`-Port). Dadurch entstehen Source-Eigenheiten von selbst:
Surfen auf Flächen mit `normal.y < 0.7`, Stufen bis 18 u, Kanten-Verhalten.

Kein Rigidbody, kein Kapsel-Collider, keine Physik-Library. Jede Abweichung von
Source-Semantik ist eine bewusste, dokumentierte Entscheidung (siehe rules/movement.md).

### 3.3 Fixed Timestep 128 Hz, Blick nicht
Physik tickt fest mit `MovementConfig.tickRate` (128). Gerendert wird mit
Interpolation zwischen den letzten zwei Ticks. Der **Blick** (Maus) wird dagegen
sofort pro Frame angewandt — niemals interpoliert, niemals geglättet, niemals
verzögert. Für die Physik wird der Yaw nach **Tick-Zeit** auf die Ticks verteilt
(Subtick-Yaw): `FixedLoop` ruft `onFrameStart` in jedem Frame (auch ohne Tick,
dort sampelt `InputManager.beginFrame()` den Blick) und gibt jedem Tick seinen
Zeitpunkt u im Frame-Intervall. Nach Index verteilt schwankte der Yaw-Schritt bei
144 Hz um bis zu 1.78× und kostete 6–14 % Strafe-Gewinn (fallen.md #45).

### 3.4 Verträge zwischen Modulen
Die Module sprechen nur über diese Typen miteinander:

| Vertrag | Datei |
|---|---|
| Level-JSON | `src/world/level/LevelFormat.ts` |
| Kompiliertes Level, Brushes, Traces | `src/world/level/compileLevel.ts`, `src/world/collision/types.ts` |
| Movement-Konstanten | `src/player/MovementConfig.ts` |
| Tick-Eingabe, Spieler-Snapshot, Movement-Events | `src/player/types.ts` |
| Spiel-Events | `src/engine/events.ts` |
| Trainingsmodus (Session, Urteile, Fortschritt) | `src/engine/trainingTypes.ts` |
| Einstellungen | `src/engine/settingsTypes.ts` |
| Replay-Format, Online-Dienst | `src/engine/replay/format.ts`, `src/online/types.ts` (+ `profileTypes.ts`, `adminTypes.ts`) |
| Online-Datenbank (Tabellen, RPCs), Edge-Function-Antwort | `supabase/migrations/*.sql`, `src/online/supabaseTypes.ts`, `src/online/supabaseApi.ts` (`SubmitResponse`, `AdminDeleteResponse`) |
| Audio-API | `src/audio/types.ts` |
| Renderer-API | `src/render/types.ts` |
| Hauptmenü-Stile (Front Doors) | `src/ui/menuLab/types.ts` |
| Plattform (web/desktop), Desktop-Bridge | `src/platform/types.ts`, `src/platform/bridgeTypes.ts` (Kanäle: `electron/policy.ts` `IPC` ⇄ `electron/preload.cts`; Module: `electron/modules.ts`, Steam `STEAM_IPC` in `electron/steam.ts`) |
| Live-Ereignisse für Achievements (Game → Plattform) | `src/platform/live.ts` (`LiveProgress`, `isCleanFinish`) |
| Controller (Pad-Codes, Belegung, Einstellungen, Gerät, Prompts) | `src/engine/pad/types.ts` (+ `InputState`/`InputManager`-API unten) |
| Speicher-Zugriff (Ghost/Stores, verifier-frei) | `src/engine/storage.ts` |

Änderungen an einem Vertrag: im selben Zug alle Nutzer anpassen und hier notieren.

Integration (Plan 002): `RendererApi.aspect`, `AudioApi.dispose()`, `RunEvent`
'levelLoaded' mit `subtitle?`. Doku ergänzt zu `beat()` (Objekt wird wiederverwendet),
'checkpoint'.split (Laufzeit − Bestzeit-Split, null ohne Referenz) und `jump.sync`.

Level-Retuning (Level-Strang, 26.09.): `LevelFormat.RouteNode` hat die Flags
`surf`, `air` und `precision` (statt Notiz-Präfixen); `jump` heißt "an diesem Knoten
abspringen, Flug bis zum nächsten Knoten"; `LevelIndexEntry.file` ist relativ zu
index.json.

E2E-Review-Fixes (27.09.): `RunEvent` 'respawn' hat den Grund 'manual' (Taste F,
zurück zum letzten Checkpoint, Timer läuft weiter; Typ `RespawnReason`), dazu die
`InputAction` 'respawn'. Engine intern: `FixedLoopOptions.onTick` bekommt
`frameFraction`, neu `onFrameStart`; `InputState`/`InputManager.beginFrame()`.

Game-Feel Runde 1 (Plan 003, 27.09.) — alle Nutzer nachgezogen:
- **MovementConfig**: `airSpeedCapLow`/`airSpeedCapFadeFrom`/`airSpeedCapFadeTo`
  (VELOCITY 32/350/700 → Cap 32 bis 350 u/s, linear auf 24 bei 700; CS2 0 = aus),
  einzige Formel `airSpeedCapAt(cfg, speed)`, nur in freier Luft (Surf-Flanke = Basis-Cap);
  `strafeAssist` (VELOCITY true, CS2 false); `autoHopSpeedShare`/`autoHopGroundTime`
  (Smart-Auto-Hop, VELOCITY 0.97/0.2, CS2 0 = Autobhop sofort). Spielerwahl schlägt
  Preset: `movementConfigFor` übernimmt `autoHop` UND `strafeAssist` aus den Settings.
- **player/types**: `PlayerSnapshot.surfNormal` (kopiert, nie interpoliert);
  `MovementEvent` land `jumpQueued` (= `PlayerMovement.jumpWillQueue`, dieselbe
  Bedingung wie der Smart-Hop in checkJump). `jumpQueued=false` heißt NICHT "kein
  perfekter Hop" — ein frischer Druck im Folgetick ist ebenfalls perfekt (fallen.md #54).
- **LevelFormat**: `BrushCommon.visible?` (false = unsichtbarer Clip; mit `collide:false`
  ein Fehler), `BrushCommon.underTrim?` (zweites Leuchtband an der Unterkante),
  MaterialId `duck` (Crouch-Wand ↑C), `light` (selbstleuchtend im Tint), `marking`;
  `LevelFile.medals?: LevelMedals {bronze, silver, gold, author}` (s, RunState-Uhr,
  streng fallend), `parTime = ceil(bronze)`. `LevelIndexEntry.medals?` (Kopie aus
  build.ts, damit die Titel-Liste Medaillen ohne Level-Laden zeigt).
  `compileLevel.LevelBrush` hat `visible`/`underTrim`.
- **Renderer**: `RenderFx.landPos?/landTime?/landPower?` (Landewelle; Game setzt sie bei
  'jump' mit perfect && sync > 0.8, Stärke sync × clamp(gain/30)) und `speedTier?` 0..3
  (500/750/1000 u/s, Game mit 60 u/s Hysterese). `RenderSettings.lowLatency?`
  (desynchronized, NUR im Konstruktor gelesen → main.ts übergibt die gespeicherten
  Settings; Menü: "wirkt nach Neuladen") und `speedLines?` 0..1.
  `RendererApi.setGhost(pos | null, yaw)` (kopiert pos). `effectiveLines()` (render/lowres)
  liefert die echte Zeilenzahl zur Pixelhöhe (Menü zeigt sie an).
- **Audio**: `MusicDrive.nearL?/nearR?` — seitlicher Abstand (u) zur Geometrie für den
  Vorbeizieh-Whoosh (Game: alle 2 Ticks zwei traceBox-Proben à 160 u quer zur
  Flugrichtung, ab 200 u/s; die Rampe, auf der man surft, zählt nicht). `active=false`
  nach 'finish' = Outro/Ergebnis-Zustand bis 'respawn' oder 'levelLoaded'.
  `audio.update(drive, frameDt)` einmal pro Frame NACH den Ticks, mit echter Framezeit
  (Sfx hält nicht angekündigte Landungen einen Tick zurück).
- **Einstellungen** (`settingsTypes`): `autoSprint`, `strafeAssist`, `motionFx`,
  `showKeys`, `showHints`, `fullscreenOnStart`, `ghost` (Ghost der Bestzeit, Default an),
  `keybinds` (`BindAction`, `KeyBinds`, `DEFAULT_KEYBINDS`, `MAX_BINDS_PER_ACTION`;
  Maus-Pseudo-Codes 'Mouse1'…'Mouse5' nach CS-Zählung). Alte Stände laden über
  `sanitizeSettings` mit Defaults für neue Felder.
- **UI** (`ui/types`): `HudData.showKeys`/`keys` (`HudKeys`, Ganzzahl-Felder als int32),
  `HudData.ghostDiff?`, `RawMouseStatus`, `FinishResult.medals?`.
- **Engine**: `InputNotice`, `InputManager.rawStatus`, `configure(binds, autoSprint)`,
  `enterFullscreen` (erst nach dem Lock-Versuch derselben Geste, fallen.md #58).
  `engine/Ghost.ts` (Aufnahme 32 Hz ab 'runStart', Kompression, localStorage
  `velocity.ghost.v1.<level>` < 40 KB, Level-Signatur). CameraRig (kein Vertrag, aber
  von Game/Tools genutzt): `CameraRigSettings.motionFx?`, `CameraView.surfNormal`,
  `rig.setMovement(cfg)` (Game ruft es bei jeder Config-Änderung), `rig.fxState`.
- **Debug-Handle**: `state().hints`, `hudLayout()`, `ghost(t?)`, `setNearProbe(on)`, `near()`.

Fix-Runde nach der Prüfung (27.09.) — alle Nutzer nachgezogen:
- **MovementConfig**: `autoHopLandShare`/`autoHopLandAirTime` (VELOCITY 0.75/0.25 s, CS2 0): Strafer
  (A/D) springen im ersten Bodentick nach echter Luftphase schon ab 0.75 × Wunschtempo;
  `heldHopReady` = checkJump = `land.jumpQueued`. TuningPanel und Sim kennen beide Felder.
- **ui/types**: `HudData.ghostOverHud?` (Game projiziert den Ghost; liegt er hinter dem
  Speedometer-Block, blendet das HUD den Block auf 30 %). `Hud.speedBlockTop()/speedBlockBottom()`
  (ohne Tupel, Frame-Pfad). HUD: Gain-Popups erst ab |3| u/s, Kette erst ab 100 u/s, bei aktivem
  Ghost kein großes Split-Popup (die GHOST-Zeile trägt den Abstand).
- **Bots** (kein Vertrag, aber von Tools/Tests genutzt): `NaiveBotOptions.press` ('hold' Default,
  'spam'); `StrafeControllerOptions.steerPriority`, `RouteFollowerOptions.steerPriority` (Default an);
  RouteFollower hakt über-flogene Knoten ab, wenn man tiefer auf dem Folgeabschnitt landet.
- **Debug-Handle**: `useBot(kind, { aimNoiseDeg, press })`, `ghost().overHud`.
- **Settings**: Preset-Wechsel ohne ausdrücklichen `strafeAssist` setzt ihn auf den Preset-Wert (CS2: aus) — in `SettingsStore.update` (Menü und F1-Panel); alter Stand ohne Feld lädt mit dem Wert seines Presets (Runde 2).

View-Hand (Plan 004, 28.09.) — alle Nutzer nachgezogen:
- **Einstellungen**: `GameSettings.showHand` (Default an; alter Stand ohne Feld lädt mit an,
  `sanitizeSettings`). Menü "Kamera und HUD" → "Hand anzeigen". Die Hand bewegt sich × `motionFx`
  (0 = statische Pose, Posen wechseln weiter).
- **HUD** (kein Vertrag): `Hud.underlay` (`HudUnderlay.draw(ctx, w, h)`) wird vor allen HUD-Elementen
  gezeichnet, nur sichtbar und nicht pausiert. `ui/ViewHand` (Cache + Zeichnen), `ui/viewHandAnim`
  (Animator, DOM-frei), `ui/viewHandSprite` (Posen + Rasterizer, DOM-frei).
- **Debug-Handle**: `hand()` (Pose, Auslenkung, Bildschirm-Rechteck), `forceHandPose(pose | null)`.

VELOCITY-Medaille + Kosmetik (Plan 005, 28.09.) — alle Nutzer nachgezogen:
- **LevelFormat**: `LevelMedals.velocity` (Pflicht; sync 1.0 × 1.05), Reihenfolge
  bronze > silver > gold > velocity ≥ author (build.ts, Validator, `parseMedals`, Tests).
  `author` ist keine Medaille mehr (nur "Entwickler-Zeit" im Ergebnis). Index ohne `velocity`
  = keine Medaillen (index.json kommt immer aus levels:build).
- **Einstellungen**: `GameSettings.glove` (`GloveId` 'classic' | 'neon'), `heldItem`
  (`HeldItemId` 'none' | 'can'); Migration über `sanitizeSettings` (Default Standard/Nichts).
  Gesperrte Wahl bleibt gespeichert, wirkt aber erst mit Freischaltung.
- **Freischaltungen** (neu, `engine/Unlocks.ts`): `UnlockStore` (localStorage
  `velocity.unlocks.v1`, `{v: 1, unlocked}`), aus Bestzeiten abgeleitet (`deriveUnlocks`,
  `sync` bei Start und Ziel). `GameDeps.unlocks`, `Menu(root, settings, best, unlocks)`,
  `DebugDeps.unlocks`.
- **UI** (`ui/types`): `HudData.nextMedal?` ({id, limit}, nur bei Levelstart/Ziel neu),
  `FinishResult.unlocked?` (Anzeigenamen), `MenuScreen` 'cosmetics'. `ui/medals`:
  `MedalId` velocity/gold/silver/bronze, `MEDAL_COLORS`, `medalAtLeast`.
- **HUD/Hand** (kein Vertrag): `ui/safeFrame` (Rand-Elemente im zentrierten 16:9-Rahmen),
  `ui/canSprite` (Dosen-Rasterizer), `ui/canTricks` (Trick-Animator), Posen `hold`/`point`,
  `ViewHand.setGlove/setItem/drawAt`, `ViewHandAnimator.holding`/`.can`.
- **Debug-Handle**: `unlockAll()`, `resetUnlocks()`, `unlocks()`, `canTrick(name, at?)`;
  `hand()` liefert zusätzlich `glove`, `item`, `rastered`, `can`.

3D-Viewmodel (Plan 006, 28.09.) — alle Nutzer nachgezogen:
- **Renderer** (`render/types`): `RenderFx.viewModel?: ViewModelFrame` (nach der Welt ins selbe
  Low-Res-Target, Tiefe geleert, eigene Kamera vFOV 54°; nur gelesen), `RendererApi.prewarmViewModel(item, glove)`
  (Shader/Texturen außerhalb des Frame-Pfads). Neu im Vertrag: `ViewModelFrame` + `createViewModelFrame()`,
  `VM_JOINT`/`VM_JOINT_COUNT` (23 Gelenkwinkel), `VM_ARM_BASE` (Grundhaltung des Unterarms, UI rechnet
  daraus Bildrichtungen im Handraum), `ViewModelGlove`, `ViewModelItem`. `RenderStats.viewModelCalls`.
- **Einstellungen**: `HeldItemId` = 'none' | 'card' | 'can' | 'knife' (Migration über `sanitizeSettings`).
- **Freischaltungen** (`engine/Unlocks`): `UnlockId` + 'item.card' | 'item.knife'; `UnlockDef.requires`
  (Liste {levelId, medal}, alle nötig) statt levelId/medal; Neon = L1-Gold. Speicherformat v2 im selben Key;
  v1 wird migriert (Neon → + Karte, Neon + Dose → + Messer) und neu geschrieben. `unlockPatch(id)`.
- **HUD** (kein Vertrag): `Hud.underlay`/`HudUnderlay` entfernt (nur die Sprite-Hand nutzte es).
  Alte Sprite-Dateien (`ui/ViewHand`, `viewHandAnim`, `viewHandSprite`, `canSprite`, `canTricks`) gelöscht;
  neu `ui/hand/*` (ViewHand, handMotion, poses, propTricks, canTricks, cardTricks, knifeTricks, rot, anim)
  und `render/viewmodel/*` (ViewModel, ViewModelPreview, vmGeometry, vmMaterials, vmTextures).
- **Debug-Handle**: `forceTrick(name, at?)` ersetzt `canTrick`; `forceHandPose` mit den neuen Posennamen;
  `hand()` liefert {pose, trick, trickTime, canOpen, cardVisible, knifeOpen, frame{x,y,z,roll,pitch,yaw}, …}.

Admin-Menü (Nutzerwunsch 28.09.) — alle Nutzer nachgezogen:
- **Bedienung**: Titel → System-Panel → unauffälliger Knopf "Admin", oder **F8** in Titel/Pause
  (F8/Esc wieder zurück, aus der Pause zurück in die Pause). Kein Passwort. Inhalt: "Alles
  freischalten"/"Alles sperren", Schalter je Freischaltung, je Level Medaille setzen
  (keine/Bronze/Silber/Gold/VELOCITY → Bestzeit knapp unter der Grenze, `ui/medals.adminTimeFor`)
  und "Bestzeit löschen" (samt Ghost). Admin-Freischaltungen gelten wie echte.
- **Freischaltungen** (`engine/Unlocks`): Format v3 im selben Key, `{v: 3, unlocked, locked}`.
  Ableitung (`sync`) fügt nur hinzu und überspringt `locked` (von Hand gesperrt); v1/v2 werden
  migriert (locked leer) und neu geschrieben. Neu: `set(id, on)`, `isLocked(id)`,
  `grantEarnedFor(levelId, levels, best)` (Medaille setzen hebt die Sperre für Freischaltungen
  DIESES Levels auf; ein echter Lauf nicht). `reset()` sperrt jetzt dauerhaft (auch `__vel.resetUnlocks`).
- **BestTimes** (`engine/Settings`): `set(levelId, time)` (hart, ohne Splits).
- **UI** (`ui/types`): `MenuScreen` 'admin', `MenuEvents.adminBest {levelId}` (Game löscht den
  Ghost des Levels inkl. Cache, zieht Bestzeit/Nächstes Ziel im laufenden Level nach).
  `Menu.showAdmin()`. Kosmetik-Menü markiert die wirksame Wahl (gesperrt → Standard/Nichts).

Plan 007 Verträge (Phase 0, 28.09.) — alle Nutzer nachgezogen, **verhaltensneutral**: die Physik
liest keines der neuen Felder (Phase 1), Level ohne Lektion kompilieren bitgleich, neue Skins/
Gegenstände zeichnen als classic/none. Abschluss (Leiter, Doku) in Phase 3.
- **MovementConfig**: Hauptschalter (VELOCITY / CS2) `landGraceTime` 0.0625/0, `slopeLandGain` 1/0,
  `surfSeamFix` true/false, `ledgeStep` 5/0, `ledgeMemory` 0.2/0, `slideMinSpeed` 280/0 (0 = kein
  Rutschen), `airControl` 1.6/0 (rad/s). Nebenwerte in beiden Presets gleich (nur Startpunkt fürs Panel):
  `slideExitSpeed` 160, `slideFriction` 0.3, `slideDecel` 80, `slideBoost` 50, `slideBoostCap` 380,
  `slideBoostMinGround` 0.25, `slideBoostCooldown` 2, `slideSteerRate` 1.4, `slideSlopeGravity` 1,
  `slideEyeTime` 0.06, `airControlHigh` 0.8, `airControlFadeFrom`/`To` 350/700, `airControlSurfGrace` 0.5.
  `airSpeedCapLow` bleibt 32 (40 setzt Phase 1). TuningPanel: Gruppen "Arcade (Plan 007)" und
  "Rutschen", Schalter "Rampbug-Fix"; Luftlenkung ↔ Einstellung synchron (an = > 0).
- **player/types**: `PlayerSnapshot.sliding` (diskret, Interpolation nimmt den neueren; bis Phase 1
  immer false). `MovementEvent` 'jump' + `clean` (perfect ODER in der Lande-Gnade; Phase 0 = perfect).
  Neu: `slideStart {speed, boost}`, `slideEnd {speed}`, `ledge {kind: 'step'|'vault', speed, dy}`.
- **LevelFormat**: `LevelFile.safeRoute?` (sichere Linie einer Gabel; Bronze/Silber dort gemessen),
  `prepLessons?` (+ `LevelIndexEntry.prepLessons?`), `training?: TrainingDef` (nie mit medals/parTime).
  Typen `TrainingDef`, `StageDef`, `StageTipDef`, `TaskDef` (reach, hopChain, goodHops, speed, surfHold,
  surfSpeed, crouchLand, course, event — `event` ist ein `GameEventType`), `DemoDef` (hand | route),
  `TrainingZoneDef`, `GateDef`, `HopSide`, `StageRank`, `TrainingGroup`, `TrainingIndexEntry`
  (`public/levels/training/index.json`).
- **compileLevel**: `CompiledLevel.gates: CompiledGate[]` ({id, brush, bounds, tint: string|null};
  brush.index = brushes.length + i; **nicht** in `world`, Reihenfolge = Index für Render/Kollision),
  `CompiledLevel.zones: ReadonlyMap<string, Box3>`. Doppelte Tor-/Zonen-ids werfen.
  `BrushWorld`: `clipBoxToBrush` exportiert (für die GatedWorld in Phase 2).
- **events**: RunEvent `lessonHop {verdict, gain, counted, count, goal}`, `lessonStage {index, total,
  rank, lessonDone}`, `gate {id, open}`.
- **engine/trainingTypes** (neu): `VERDICTS`/`Verdict` (good, wOnly, noSide, noMouse, against, wHeld,
  tooFast, late, tooSlow, weak), `LessonStars`, `TrainingSpawn`, `TurnBand`, `TrainingSessionApi`
  (tick(dt, prev, cur, cmd, hullH, out), onEvent, update, respawnPoint, skipStage, restartLesson,
  turnBand; hud, gateOpen, suspended, done, stars, completedStageIds), `TrainingProgressView`.
- **Einstellungen**: `GloveId` + gold/robot/skeleton/cat, `HeldItemId` + yoyo/spinner/coin/lighter/
  kendama/phone, `GameSettings.airControl` (Default an; fehlt → folgt dem gespeicherten Preset wie
  strafeAssist), `BindAction` + 'demo' (Default `['KeyH']`; kollidiert H mit einer alten Belegung,
  bleibt demo leer). `movementConfigFor`: airControl aus → 0, an → Preset-Wert. `SettingsStore.update`:
  Preset-Wechsel ohne ausdrücklichen Wert setzt airControl auf den Preset (CS2 aus). Menü "Movement":
  Schalter "Luftlenkung mit W" (die Tasten-Zeile für 'demo' baut training-ui).
- **InputState**: `InputAction` + 'demo' (Druck auf einen `KeyBinds.demo`-Code, kein gehaltener Knopf);
  Game ignoriert sie bis Phase 2.
- **Freischaltungen** (`engine/Unlocks`): 14 `UnlockId` (Tabelle Plan 007 §7, UNLOCKS in Leiter-
  Reihenfolge), `UnlockRequirement` = `MedalRequirement {kind:'medal', levelId, medal}` |
  `TrainingRequirement {kind:'training', group:'basics'|'all', minStars:1|3}` (ohne Lektionen nie
  erfüllt), `requirementMet`, `deriveUnlocks(levels, best, training?)`, `sync(levels, best, training?)`,
  `grantEarnedFor` nur für Medaillen dieses Levels. **`PENDING_UNLOCKS`**: die 10 neuen wurden bis Phase 3
  NICHT abgeleitet (sonst bekäme L1-Silber ein unsichtbares Jo-Jo angelegt) — **in Phase 3 entfernt**, die
  Ableitung vergibt alle 14. Speicherformat v3 unverändert.
- **Renderer** (`render/types`): `ViewModelGlove`/`ViewModelItem` wie GloveId/HeldItemId (unbekannte
  zeichnen als classic/none), `VM_RIG` (Finger-/Daumenmaße, aus ViewModel.ts verschoben; Konvention im
  Kommentar), `VM_STRING_POINTS` = 9, `VM_PARAM` (Kanäle je Gegenstand), `VM_PHONE_MODE`.
  `ViewModelFrame` + `subPos`, `subRot`, `subSpin`, `subVisible`, `stringPts` (27), `stringCount`,
  `propParam` (4), `skinFx` — alle neutral 0. `RendererApi.snapshot(w, h)`, `selfie(w, h, vm)`
  (Phase 0: null), `RenderFx.gateOpen?`; `setLevel` baut Tore ab Phase 2.
- **UI** (`ui/types`): `HudData.lesson?: LessonHud | null` (`LessonHud`), `HudKeys.turnBand?`,
  `MenuScreen` + 'training' | 'lessonDone' (Menü: Stub → Titel), `LessonResult`, `MenuEvents` + demo,
  skipStage, `FinishResult.photo?`.
- **Audio**: `MusicDrive.sliding?`.
- **Tests**: `tests/contracts.test.ts` (neu), Plan-007-Blöcke in settings/cosmetics.

Plan 007 Abschluss (Phase 1–3, 29.09.) — alle Nutzer nachgezogen, tsc 0, Vitest grün:
- **Physik** (movement.md §1/§4/§5): Arcade-Pass A1–A8 aktiv, `airSpeedCapLow` 40. Abweichungen vom Plantext:
  Hang-Landung mit **gestundetem Bergauf-Verlust** (`slopeDebt`, gegen die Hügel-Pumpe), kein Lip-Step, solange
  der Rest-Aufstieg die Kante um ≥ 2 u überragt (`LEDGE_RISE_CLEAR`), **Weiterrutschen** über Mulden
  (`slideCarry`), Wand-Tasche (Luft-Move zwischen fast parallelen Wänden → senkrecht weiterfallen).
  `PlayerSnapshot.sliding`/'slideStart' werden erst NACH der Lande-Gnade gemeldet (Physik rutscht ab dem ersten
  Bodentick); ein Sprung aus der Rutsche sendet [jump, slideEnd]; Weiterrutschen ein zweites slideStart{boost:false}.
- **Kamera** (kein Vertrag): `rig.onTick()` je Physik-Tick vor den Events, `CameraView.sliding`/`.tickAlpha`,
  `cameraViewFromSnapshot(…, tickAlpha)`, `fxState.slideRumble`/`.ledgeOffset`. `jitWarmup` wärmt Rutschen und
  Luftlenkung mit vor (jeder dritte Block).
- **LevelFormat**: `EnvironmentDef.moon?` (Phase 3: Himmelsscheibe als Mond in sunColor, ohne Outrun-Streifen;
  L3), Doku `StageTipDef` ('land' mit `after` ist ein Zustand). `LevelIndexEntry.prepLessons` steht im Index
  (L3 T7/T8, L4 T6/T7/T8) und erscheint in der Levelliste als "Empfohlen: T7/T8", solange eine davon keinen Stern hat.
- **Freischaltungen**: `PENDING_UNLOCKS` entfernt; die Freischaltung liest die Medaillen aus index.json (Test:
  Index = Level-Datei). `TrainingProgress.setStars(id, stages, 0..3)` (Admin, auch senken; 0 = zurücksetzen),
  `MenuTraining.setStars(id, stars)`. Admin-Menü: Sterne je Lektion (keine/★/★★/★★★), "Alle ★★★", "Alle
  zurücksetzen"; Zurücksetzen nimmt keine Freischaltung weg.
- **Ziel-Foto (I3)**: Game löst im Ziel mit Handy aus (`ViewHand.takeShutter()` jeden Frame des Ausrollens, 0.76 s
  nach dem Ziel; `takeShutterNow()` wenn das Ergebnis früher kommt; ein alter Auslöser wird im Ziel verworfen),
  `RendererApi.selfie(96, 54, hand.selfieFrame())` NACH dem render() des Frames → `FinishResult.photo`.
  `Hud.showPhoto()` (Stempel "FOTO", `HUD_RECTS` + 'photo'). Menü: Polaroid im Ergebnis (`.vel-polaroid`, Foto ×3,
  Zeit + Medaille). Ohne Handy kein Foto.
- **Training (engine, kein Vertrag außer trainingTypes)**: `Training.ts` — `TrainingSession(level, cfg, {world})`
  (+ `tip`, `setConfig`, `demoPassed`, `stage`, `jumpTo`), `createDemo(demo, level, cfg, world, spawn)` (hand →
  BeginnerHand, Surf-Route → `SurfHand`, sonst RouteFollower mit Duck-Vorausschau), `demoStyle`,
  `lessonMovementConfig()` (Lektionen laufen mit VELOCITY + allen Hilfen, nicht mit der Spieler-Config), `hullIn`,
  Konstanten (`STUCK_AFTER`, `CHAIN_MIN_SPEED`, `MISS_TEXT`, …). `strafeJudge.ts` — `StrafeJudge`
  (`HopReport.wall/.loss`: Wand-Kontakt ab dem Absprung-Tick, Gewinn bis zum letzten Luft-Tick), `goodGainAt`,
  `tooFastRate`, `turnBandAt` (Prestrafe-Band 150–300), `VERDICT_TEXT`. `TrainingProgress.ts` — localStorage
  `velocity.training.v1` {v:1, lessons:{id:{stages, stars, at}}}, `starsFor`, `parseTrainingProgress`.
  `player/bots/BeginnerHand.ts` — `BeginnerHand`, `HAND_MODELS`, `SurfHand`. `world/collision/GatedWorld.ts` —
  `GatedWorld(base, gates)` (setOpen/isOpen/closeAll/indexOf; ohne geschlossenes Tor bitgleich zur BrushWorld).
- **Training (UI)**: `Game` baut eine lokale `LessonSession` (TrainingSessionApi + tip/setConfig/demoPassed),
  Stufe aus `LessonHud.stageIndex`; übersprungene Stufen gehen NICHT als 'lessonStage' auf den Bus (Zähler);
  Vorführung endet am Ziel ("SO GEHT'S!", 1 s) oder nach 0.5 s Stillstand; Urteile nur in Stufen mit Strafe-
  Aufgabe (`hudLogic.stageJudges`). `Hud`: `judge`, `demoGoal`, `setLessonStages(ranks)`, `verdictSerial`/
  `verdictDrawn`, `HudSprite`, `rect(name)`. `hudLogic`: `CENTER_BAND_*`, `lessonCardLayout`, `turnBarLength`,
  `stageSteps`, `hudScale`. `Coach(cfg)` (Config Pflicht), `JUDGE_MAX_SPEED`. `InputManager.anyKeyDown()`,
  `GameDeps.training?`, Menü `MenuTraining`, `LessonPauseInfo`, `setTraining/showTraining/showLessonDone/
  setDemoKey`, `Sfx.lessonNote`, `render/gateVisuals` (Vorhang, Screen-Door-Auflösen).
- **Kosmetik** (kein Vertrag): Registries `ITEM_REGISTRY`, `SKIN_REGISTRY`, `PROP_FACTORIES`; `ScalarUniform`;
  `LitOptions.tabby` (+ `markTabby`, Attribut `aTabby`); Pose `cradle` (Index 15 in HAND_POSES); `rot.axisAngleQ`,
  `fromEulerXYZV`, `mulT`, `toAxisAngleQ`; `Rope` (`setTaut`, `length`/`segLen` als Getter, `advance(0)` setzt die
  Anker), `RopeDrive`; `PropTricks` (Ziel bricht ab, `XFADE` 0.25 s, `onFinish(best)`, `onInterrupt()`);
  `ViewHand.takeShutter/takeShutterNow/selfieFrame`, `PhoneTricks.shootNow`; `RenderStats.viewModelTriangles`;
  Schnur-Schlagschatten (+1 Draw Call). `createViewModelFrame` legt Kommazahl-Felder mit Double-Startwert an.
- **Level-Werkzeug** (kein Vertrag): `physics.withRoute`, `resumeIndex` mit Höhe, `jitterMedian`/`jitterBranches`
  (49 Starts), `build.MEDAL_SEEDS` (48); Proben `probes/level3.ts` (Gabel, Aussetzer-Risiko, Medaillen-Stichprobe),
  `probes/level4.ts` (`bandeEscape`, `duckMarkJumps`, …), `designProbes.ringBoardEscape` (L2, mit
  `level2.level2RingBoard()`).
- **Debug-Handle**: `training()`, `trainingSkip()`, `trainingReset()`, `demo({on, play})`, `lessons()`,
  `benchHud(n)`, `benchLesson(n)`, `frameCost()` (+ `lessonTickMs`), `snapshot(w?, h?)`, `renderStats()`;
  `hudLayout()` + `verdictSerial`/`verdictDrawn`/`judge`, `rects.photo`; `state().lesson`, `state().photo`
  ({w, h, mean} des Ziel-Fotos), `state().finish` ohne Canvas; `hand()` + skin, skinFx, sub, stringCount, param,
  sliding, tricks.

Plan 007 Review-Fixrunden + Integration (Phase 2/3, 29.09.) — alle Nutzer nachgezogen, tsc 0, Vitest 610/610:
- **LevelFormat**: `DemoDef` route + `style?: 'walk' | 'hold'` (W laufen bzw. W + Leertaste gehalten, Blick auf den
  nächsten Knoten, ohne Strafen). Ohne style entscheidet `Training.createDemo`: Surf-Knoten → SurfHand, Lektion mit
  `hud.turnBand` → RouteFollower, sonst **'jump'** (W + Sprint, Sprung an `jump`-, C in der Luft an `crouch`-Knoten,
  Ducken vor Decken) — Showkeys zeigen nie A/D, wo die Stufe kein Strafen lehrt. `demoStyle()` liefert auch 'jump'.
- **Medaillen** (Werkzeug, kein Vertrag): `build.LevelEntry.reference?: () => physics.MedalReference` (+ `ReferenceRuns`,
  `medianOf` exportiert, `build.MEDAL_SEEDS` 48): je Medaille zählt der schnellere Median aus RouteFollower und Referenz.
  L3 `probes/level3.level3Reference` (Grundtechnik vom Brett Koralle, bester Blickversatz −3…+1°, 16 `REFERENCE_SEEDS`;
  nur Gold/VELOCITY/Autor), L4 `probes/level4.level4Reference` (Hybrid: Hand klettert als RouteFollower, surft ab dem
  ersten Boden-/Flankenkontakt nach CP4 mit der Grundtechnik; alle Medaillen). validate-levels (Par gegen 3°-Hand)
  und unlock-ladder rechnen genauso (fallen.md #163). Wächter: L3 `medalsVsHuman` (Warnung, wenn die Grundtechnik den
  Autor um > 3 % unterbietet oder Türkis VELOCITY schafft), L4 `surfMedal` (Test "Medaillen-Wächter").
  **Medaillen-Runde (01.10.)** — ein Modell für alle Stufen (level-design.md Regel 10, Plan 007 §10), alle Nutzer
  (build, validate-levels, unlock-ladder, `probes/level3.medalSample`) nachgezogen: `MedalReference.runs(…, seeds,
  opts?: ReferenceOptions)` mit `{ cfg?, look?: SurfLook }` ('lesson' = Blick 0° für Bronze, 'best' sonst) statt `cfg`
  an 6. Stelle; `physics.surfSigma(model)` (Hand = aimNoiseDeg, perfekt `PERFECT_SURF_SIGMA` 0.5°); L3-Referenz für
  JEDES Modell (route = Koralle, safeRoute = Türkis, `bestLook`, `REFERENCE_FINISH` 0.8); L4 `hybridRace(…, riderSigma)`
  (exportiert, Surfer = `HumanSurfer` aus probes/level3); `build.MEDAL_MIN_STEP` 1.04, `MEDAL_MAX_STEP` 1.2,
  `staggerMedals`, `medalSteps`; validate-levels prüft die Staffel (Fehler < 4 %, Warnung Bronze→Silber/Silber→Gold
  > 20 %) und Par gegen den perfekten Bot mit Referenz.
- **Training (engine)**: `StrafeJudge` urteilt die Technik vor dem Gewinn (ohne A/D bzw. Maus gegen die Taste nie
  'good'), misst Surf-Abschnitte nicht, `BAND_LO` 60 °/s. `TrainingSession`: Urteils-/Erklär-Tipps nur, wenn
  `turnBand() ≠ null`; in Strafe-Lektionen zählen speed (ohne ground) und course nur mit A/D (≥ 25 % des Luftabschnitts,
  Tipp `MISS_TEXT[5]`); nach einer Vorführung werden `count`, `lastSide` UND `best` wiederhergestellt; `enter()` setzt die
  Tipp-Sperre zurück. `BeginnerHand.HAND_MODELS` + `nurWSchnell`/`gegenSchnell`, `SurfHandOptions.biasDeg`
  (+ = in die Rampe, nur an der Flanke). `jitWarmup` wärmt `StrafeJudge` vor.
- **Training (UI)**: Lektionen erzwingen Auto-Sprint (`input.configure(binds, autoSprint || session)`). `Coach`: `HintId`
  + 'noStrafe' (`HINT_IDS`, `NO_STRAFE_HOPS` 6, `NO_STRAFE_MAX_SPEED` 400; einmal je Sitzung, bewusste Abweichung vom
  Entwurf, fallen.md #176), `state().hints.noStrafe`. `Hud.setMovement(m: HudMovement)` (TrendMovement + `strafeAssist`;
  W blinkt rot nur ohne Assist), `dropCoachNotice()` (auch bei 'lessonStage'), `cardState()`/`HudCardState`,
  `hudLayout().card`; Geschafft-Blitz mit voller Pip-Reihe der erledigten Stufe; nach den Pflichtstufen "[H] ZEIGEN"
  links, "[ENTER] ERGEBNIS" rechts; in Stufen mit Urteil "ANLAUF MIT W" am Gain-Popup für Absprünge unter
  `strafeJudge.MIN_TAKEOFF`; Drehbalken in Lektionen 3 px mit "MAUS". menu.css `@media (max-height: 800px)`.
- **Kosmetik** (kein Vertrag): `PropTricks.onLesson(done)` — Stufe/Lektion brechen wie das Ziel am Frame-Ende ab
  (Priorität Ziel > Lektion > Stufe; ViewHand schickt dafür kein Checkpoint-Event mehr); `PropControl.flourishes`;
  Einlagen im Surf-Zustand `beatU` (0..1, 1 = keine), `beatBegin()`/`beatEnd()`, `lateness`, `BEAT_FIRST` 1.05 s,
  `BEAT_EVERY` 2.4 s, `BEAT_T` 0.62 s (Auslöser Kehre = surfSide wechselt, Tempo-Meilenstein); `rotateCam`/`camTurn`;
  `vmGeometry` `Ring.fur`/`TubeOptions.fur`; jedes Katzen-Teil trägt `aClaw`/`aTabby`. `event-probe` Exit 1.
- **Level-Werkzeug**: `designProbes.slalomIslands()` (Inselzahl `level1.SL_N`), dichte Slalom-/Ausfahrt-Raster
  (`EXIT_EDGE_STEP` 2.5 u/s), `expertIslands` mit Zielzeit des perfekten Bots über START_JITTERS; L3-Proben `rampAxis`,
  `HumanSurfer`/`humanCtx`/`humanRun` (Mensch-Band, 584 Läufe), `bankGlide`; L4-Proben `dropIn` → {spawn, approach},
  `descentAxis`, `duckMarkJumps` (zweistufiges Absprungband), `lanePath`, `surfMedal`. Lektions-Werkzeug:
  `check.runDemo` → `sideTicks`/`maxSpeed`, `demoTeachesStage`/`DEMO_PLAIN_MAX`, `probes.DIAGNOSES[].strict`.

Hand-Overhaul Schritt 1 (Plan 008, 01.10.) — alle Nutzer nachgezogen, tsc 0, Vitest 651/651:
- **Renderer** (`render/types`): neu `VM_KNIFE` (Butterfly-Maße: Griffe, zwei Stifte im Abstand `pinGap` am Klingen-Tang,
  Klinge) und `VM_PARAM.knife = { latch }` (Riegel 0..1). `items/knife` baut Tang und Riegel (Klinge, Spitze, Tang in einer
  Geometrie; Gruppen `knifeBlade`/`knifeBite` benannt für Werkzeuge). `ViewModel.debugOrbit` (nur Dev-Viewer: Orbit-Kamera).
- **UI** (kein Vertrag): `PropOut.jointAdd` (Gelenk-Versatz auf die Pose: Handgelenk-Flick, Finger-Kontakt; × motionFx, im
  Abbruch-Überblenden), neue Posen `spin`, `balisong`, `lighter`, `ken`, `flick`, `yoyo`, `roll` (hinten angehängt; geändert:
  `grip`, `pinch`, `crack`, `phone`, `phoneTap`). Fundament `ui/hand/{curves,secondary,rigid,chain,knifeRig,handShape,
  propShape,propShapes,fingerContact}.ts` (API: `.docs/plans/008`). Haltelagen neu: Dose, Karte, Spinner, Münze, Feuerzeug,
  Kendama (Ken 1.5×, Kugel r 2.5), Handy (×1.45), Messer (Kniff am Safe-Handle-Ende, Physik statt Zeitleiste).
- **Tests/Werkzeuge**: `tests/handFoundation.test.ts`; `tools/lib/{handContact,handLive}.ts`; vm-hash-Baseline bewusst neu.

Trailer-Footage (01.10.) — kein Vertrag, verhaltensneutral: **Debug-Handle** `film({on, bpm?, hud?, yawTau?})` (rAF-Loop
aus, Spielzeit nur per `advanceFrame(dt)`; Kick der Trims aus simulierter BPM-Uhr; hud false = ohne HUD/Hand; yawTau =
Kamera-Yaw nur im Bild tiefpassen), `advanceFrame(dt)`, `filmCamera({x,y,z,yawDeg,pitchDeg,rollDeg?} | null)`,
`setSettings(patch)`; `BotOptions.band` (route/strafe, Hysterese), strafe reicht auch `maxTurnRate` durch.
Game: `setFilmMode`, `filmFrame`, `setFilmCamera`, Typ `FilmCamera`.
60-s-Trailer (07.11.), ebenfalls verhaltensneutral: `film({…, avatar?, minimalHud?})` — avatar = Ghost-Hologramm auf
der Spielerposition (nur mit Film-Kamera; Nah-Ausblendung dann 20–60 statt 56–180 u, `RendererApi.setGhostNearFade?`),
minimalHud = nur Speedometer/Gain-Popups/Ziel-Banner (`Hud.filmMinimal`); `VelState.surfNormal` (Verfolger-Kamera).

Online/Replays (Plan 009, 01.10.) — alle Nutzer nachgezogen, tsc 0, Vitest grün, `npm run sim` zeilengleich:
- **Physik**: `player/detMath.ts` (`dsin/dcos/datan2/dhypot`, fdlibm-/V8-Ports aus IEEE-Grundoperationen) ersetzt
  `Math.sin/cos/atan2/hypot` in PlayerMovement, `compileLevel` (rotY) und `convexHull` — in Node bitgleich zu `Math.*`,
  in Chromium/Firefox/Safari dieselben Bits (Node und Chrome rechnen `Math.sin` verschieden, fallen.md #203).
  **Game füttert die Physik mit quantisierten Eingaben** (`replay/format.InputQuantizer`: Tasten-Bits, Yaw ganzzahlig in
  1/65536 Umdrehung ungewickelt); Bots/Sim/Werkzeuge in Node bleiben unquantisiert. `PHYSICS_VERSION` (replay/format) bei
  jeder Physik-Code-Änderung erhöhen.
- **Neu** `engine/replay/*` (format, codec, hash, recorder, runSim, verify, botRun) und `online/*` (types, LocalMockService,
  FirebaseService, index). `replay/runSim.placeFeet` ist das Absetzen am Spawn für Game UND Verifier.
- **Einstellungen**: `GameSettings.playerName` ('' = automatischer Name; `sanitizeSettings` über `online/types.sanitizeName`).
- **UI** (`ui/types`): `OnlineStatus`, `FinishResult.online?`, `MenuEvents.raceGhost {levelId, runId|null, label}`,
  `MenuScreen` 'leaderboard'. Menü: `MenuOnline`, `setOnline`, `showLeaderboard(levelId?)`, `setOnlineStatus`; Titel-Knopf
  "Bestenliste", Ergebnis mit Status-Zeile + Knopf, Einstellungen → "Online" (Spielername).
- **Engine**: `GameDeps.online?: OnlineService | null` (main.ts: `?online=off|mock|firebase` bzw. `VITE_ONLINE`, Default
  mock), `Game.startGhostRace`, `showLeaderboard`, `onlineInfo()`, `levelById`. Aufnahme ungültig bei Config-Wechsel,
  F1-Tuning, Debug-Teleport/-Geschwindigkeit; Bot/Override → `assisted`.
- **Debug-Handle**: `online()`, `leaderboard(levelId)`, `showLeaderboard(levelId)`, `raceGhost(levelId, runId, label?)`,
  `verifyReplay(b64)`.

Online mit Supabase + Discord-Login (Plan 009 §13, 06.11.) — tsc 0, Vitest grün, Edge Function deployt:
- **`online/types`**: `OnlineBackend` = `'mock' | 'supabase' | 'off'` ('firebase' verworfen, FirebaseService gelöscht).
  `PlayerIdentity.provider` `'discord' | 'local'`, neu `avatarUrl`. `OnlineService` neu: `loginRequired`, `auth()` →
  `PlayerIdentity | null` (stellt nur wieder her, NIE ein Redirect), `signIn()` (Supabase: OAuth-Redirect, verlässt die
  Seite), `signOut()`, `onIdentityChange(cb)`; `submitRun` wirft `OnlineError('auth')` ohne Login. `SubmitResult.improved`,
  `LeaderboardEntry.avatarUrl`, `OnlineErrorCode` + `'rate' | 'banned'`.
- **`online/index`**: `onlineBackend(query, env?)` — `?online=` schlägt `VITE_ONLINE`, sonst supabase wenn
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`, sonst mock. `createOnlineService` ist **async** (SDK-Chunk dynamisch).
- **Tafel** = (level_id, level_hash, physics_version): Level-Retuning/Physik-Patch ergibt eine neue, leere Bestenliste.
  Server-Zeit = round(time·1000) ms.
- **UI** (`ui/types`): `OnlineStatus.state` + `'login'`. `MenuOnline` + `loginRequired`, `myAvatar()`, `signIn()`,
  `signOut()`; `Menu.refreshOnline()`. Konto-Zeile (Titel/System, Einstellungen/Online), Login-Knopf in Ergebnis und
  Bestenliste, Avatare (16 px, pixelig) in der Bestenliste.
- **Engine**: `Game.login()` sichert einen nicht eingereichten Lauf in sessionStorage (`online/pendingSubmit`) und
  meldet an; nach der Rückkehr reicht `resumeLoginRun` ihn genau einmal ein (Meldung als Toast).
- **Codec**: `unpackReplay(bytes, { maxBodyBytes })` — Deckel gegen Deflate-Bomben (Server).
- **Server**: `src/online/submitVerifier.ts` (`SubmissionVerifier`: Größe, Entpacken, `assisted` → abgelehnt, Level aus dem
  Bundle, `verifyReplay`). Nach JEDER Änderung an Physik/Leveln/Replay/Verifier: Bundle bauen, hochladen, index.ts
  deployen — `tests/submitFunction.test.ts` schlägt sonst fehl (Bundle veraltet / SHA nicht gepinnt).

Profil + Entwickler-Werkzeuge (Plan 009 §15, 06.11.): Backend und Client-Schicht sind fertig, die UI fehlt noch. tsc 0,
Vitest grün, Function `admin` deployt.
- **`online/profileTypes`** (neu): `PlayerProfile` jetzt `{uid, name, avatarUrl, dev, memberSince, runs, worldRecords,
  bests: ProfileBest[]}`, `ProfileBest {levelId, time, rank, total, runId, date}`. `getProfile(uid?)` liest fremde Profile
  ohne Login; gebannt oder unbekannt → `'notFound'`. Ränge gelten nur für die aktuellen Tafeln.
- **`online/adminTypes`** (neu): `AdminService` (`listRuns`, `listPlayers`, `setBan`, `renamePlayer`, `deleteRun`, `auditLog`),
  `AdminPage<T> {items, total}`, `AdminRun`, `AdminPlayer`, `AdminDeleteResult`, `AdminAuditEntry`. `OnlineService.admin:
  AdminService | null` ist nur bei `identity.dev` gesetzt; der Server prüft trotzdem jeden Aufruf (`role = 'dev'`).
  Beide Dateien sind re-exportiert aus `online/index`, **nicht** aus `types.ts` (Bundle-Graph, fallen.md #210).
- **`online/index`**: `OnlineDeps.levelIds`, `mockDev`. `SupabaseServiceOptions.levelIds`, `adminTimeoutMs`;
  `MockOptions.dev` (`?mockdev`, lokale Moderation). **Engine**: `Game.levelIds()`.
- **Adapter** `supabaseApi`: `playerProfile` statt `runCount`, `admin*`. SQLSTATE 22023 → `'invalid'`, P0002 →
  `'notFound'`, HTTP 404 → `'notFound'`.
- **Server**: RPCs `get_player_profile` (INVOKER, öffentlich), `admin_list_runs`, `admin_list_players`, `admin_set_ban`,
  `admin_rename_player`, `admin_audit_log` (DEFINER + Dev-Prüfung, nur authenticated), `admin_delete_run` (nur
  service_role) mit Edge Function `admin` (`deleteRun`, löscht das Replay über die Storage-API). Protokoll in
  `private.admin_audit`. Gebannte Profile sind öffentlich unsichtbar (RLS).

Menü-Labor (Plan 010, 06.11.) — alle Nutzer nachgezogen:
- **Einstellungen**: `GameSettings.menuStyle` (`MenuStyleId` 'classic' | 'ps2' | 'hub' | 'rave' | 'arcade', `MENU_STYLE_IDS`,
  Default classic; `sanitizeSettings`: fehlt/unbekannt → base). `?menu=<id>` = Sitzungs-Override (`Menu.setStyleOverride`).
  Achtung: Settings.ts liegt im Verifier-Bundle (movementConfigFor) — Änderungen machen es veraltet (Plan 010 §6).
- **UI** (`ui/types`): `MenuScreen` + 'lab' (Menü-Labor) | 'profile' (Spielerprofil, seit Runde 4 echt). Menü: `showLab()`, `showProfile()`,
  `setAudio(MenuAudio)` (main.ts), `menuStyle`; Root-Klasse `vel-style--<id>` auf allen Screens, `data-door="ready"` sobald
  eine Front Door steht.
- **Neu** `src/ui/menuLab/types.ts` (Vertrag FrontDoor/FrontDoorContext), `registry.ts` (lazy je Stil), `beatClock.ts`
  (Takt, Ersatz-Uhr 132 BPM ohne AudioContext), Stile in `src/ui/menuLab/<id>/`. Regeln für Stile: `.docs/plans/010-menu-lab.md`.

Menü-Labor Runde 4 (Plan 010 §7, 06.11.) — alle Nutzer nachgezogen (classic/hub/rave/arcade ignorieren die neuen Felder):
- **Front-Door-Vertrag** (`menuLab/types.ts`): `FrontDoorLevel.theme` (`FrontDoorLevelTheme`: trim, trimAlt, skyTop/Horizon/
  Bottom, sun, moon; null bis Game die Level-Dateien gelesen hat), `FrontDoorTraining.lessons/groups/demoKey`
  (`FrontDoorLesson.group`, `FrontDoorLessonGroup`), `FrontDoorCosmetics.gloves/items` (`FrontDoorCosmetic`), `ctx.request`
  (`FrontDoorRequest {view, levelId?, uid?}`), Aufrufe `board(levelId)` → `FrontDoorBoard`, `raceGhost`, `getProfile(uid?)`,
  `admin()`, `equip(kind, id)`, `mountHandPreview(canvas, label)`, `openProfile(uid?)`. `MenuStyleInfo.views?`
  (`FrontDoorView[]`): Stile, die Training/Bestenliste/Kosmetik/Profil/Moderation selbst bauen — Menu.ts delegiert dann vom
  Titel bzw. nach einer Lektion aus an die Front Door (aus Ergebnis/Pause bleiben die Bestands-Screens). ps2 hat alle fünf.
- **Menu.ts**: `MenuOnline.profile(uid?)`, `MenuOnline.admin()`; `showProfile(uid?)` (klassischer Profil-Screen statt
  Platzhalter, Esc → zurück zur Bestenliste), `showModeration()`, `setLevelThemes(map)`; Namen in der klassischen
  Bestenliste öffnen das Profil. Reine Abbildungen in `menuLab/doorData.ts` (`doorBoard`, `doorBoardEntry`, `levelTheme`).
- **Game.ts**: liest nach dem Index die Level-Dateien im Hintergrund (nur `environment`, kein Kompilieren) →
  `menu.setLevelThemes`; Provider `profile`/`admin` an die Online-Schicht.
- **Tests**: `tests/frontDoorContract.test.ts` (Abbildungen, Themes aller Level, Registry-Ansichten, Profil + Moderation
  gegen den Mock).

Steam-Vorbereitung (Plan 011, 06.11.) — S0/S1a/S1b/S1c/S2a/S2b integriert, alle Nutzer nachgezogen. `GameSettings`,
`KeyBinds`, Replay-Format, `PHYSICS_VERSION`, `online/types` **unverändert**; Verifier-Bundle hängt nicht mehr an
Settings/InputState/online-types (`engine/storage.ts`, Bundle-SHA `f2d04931…`, Upload offen):
- **Pad-Vertrag** (`engine/pad/types`): `PadButtonCode` (Standard-Mapping, Xbox-Namen, `PadHome` nie belegbar), `PadBinds`,
  `PAD_PRESETS` bumper/classic, `PadSettings` (yawRate/pitchRate °/s, invertY, Deadzones, curve, boost, moveDeadzone,
  diagonalBand, glyphs, binds), `PAD_LIMITS`, `InputDevice`, `GlyphStyle`, `PromptAction`, `PAD_RESTART_HOLD` 0.4 s,
  `PAD_CAPTURE_TIMEOUT` 5 s, `PAD_CAPTURE_CANCEL_HOLD` 0.6 s. Store `PadSettingsStore` (`velocity.pad.v1`, `sanitizePadSettings`).
- **InputState**: `InputAction` + `navUp/navDown/navLeft/navRight/tabPrev/tabNext` (nur Menü-Kontext), `setPadMove(fwd, side)`
  (digital, ODER mit WASD), `setLookRate(yaw, pitch)` (rad/s, in `beginFrame(frameDt)` integriert, dann quantisiert wie die
  Maus), Pad-Codes im held-Set. `FixedLoop.onFrameStart(frameDt)`.
- **InputManager**: `constructor(target, getSettings, platform?)`, `device`, `usingPad`, `onDevice(cb)`, `promptLabel(a)`,
  `setMenuContext(on)`, `configurePad(s)`, `pad` (PadInput: `sticks`, `output`, `connected`, `capture`), **`capturePadButton(cb,
  timeout?)` → stop** bzw. `nextPadButton(timeout?)` → Promise (nächster Knopf auch A/B; null = Abbruch: B halten, Start, Esc,
  Zeit, Pad weg, Blur), `desktop`, `platformFullscreen`. Am Desktop: Strg duckt immer, keine beforeunload-Wache,
  `toggleFullscreen`/`enterFullscreen` → `platform.window.setMode`.
- **Menu**: `setPad(store, MenuPadDevice {connected, sticks, captureButton})`, `setInputDevice(d)` (Game verdrahtet beides:
  `input.onDevice` → `applyPrompts` + `menu.setInputDevice`; kein Dev-Haken `__velMenu` mehr), `setPlatform(p)` (main.ts),
  `adminAllowed` (Web immer, Desktop nur `--dev`: Admin-Knopf/F8/`showAdmin`). Desktop: "Anzeigemodus" statt "Vollbild beim
  Start", Beenden zweistufig im Classic-Titel und in der Pause. `ui/padNav` (räumlicher Fokus, Klasse `is-padfocus`).
- **UI** (`ui/types`): `MenuEvents.quit` (main.ts: `mirror.flush()` + `platform.quit()`).
- **Front-Door-Vertrag** (`menuLab/types`): `ctx.input: FrontDoorInput {family, pad, glyphs(p)}`, `ctx.platform` 'web' | 'desktop',
  `ctx.adminMenu`, `ctx.quit: (() => void) | null` (null = kein Beenden-Eintrag); `FrontDoor.onNavigate?(dx, dy)`,
  `onTab?(dir)`, `onInput?()`. ps2: System-Panel mit "Beenden" (zweistufig) nur am Desktop, Admin nur mit `adminMenu`; hub
  blendet Admin ebenso aus, rave/arcade/stubDoor zeigen den Knopf seit Review B5 ebenfalls nur mit `adminMenu`.
- **Plattform-Schicht** (`src/platform`): `platform()` → web (Default) | desktop (Bridge `window.velocityDesktop`),
  `PlatformApi {kind, caps, dev, versions, quit, window, openExternal, saveMirror}`. main.ts: `installSaveMirror(…)` VOR
  `new SettingsStore`, Dev-Parameter (`?online/level/menu/debug/mockdev/lockless`) am Desktop nur mit `--dev`.
- **Debug-Handle**: `__vel.pad(patch | null)`, `__vel.input()` (+ `ctrlCrouch`, `locked`, `rawInput`).
- **Desktop-Login (S3, Plan 011 §3.1)** — `OnlineService` und `online/types` **unverändert** (Bundle-SHA bleibt `f2d04931…`):
  `PlatformApi.auth: PlatformAuth | null` (Web null) = Bridge-Feld `velocityDesktop.auth` (`DesktopAuthBridge {begin,
  openExternal, cancel, session: DesktopSessionVault}`, Ergebnisse `DesktopAuthBegin`/`DesktopAuthResult`/`DesktopAuthFailure`
  mit `DesktopAuthError`, Kanäle `AUTH_IPC` in electron/auth.ts). `SupabaseServiceOptions.externalLogin?: ExternalLogin`
  (`signIn()` am Desktop: Loopback statt Redirect, löst nach dem Code-Tausch auf); `SupabaseApi` + `discordAuthUrl`,
  `exchangeCode`; `createSupabaseApi(url, key, {vault?})` (Sitzungsschlüssel → `safeStorage`, Verifier bleiben in
  localStorage); `OnlineDeps.desktopAuth` (main.ts: `plat.auth`). Electron-Modul `authModule` in `modules.ts`; Schalter
  `--auth-no-browser` nur mit `--dev` (Smoke). Web: `platform.openExternal` ohne `noopener`-Feature (lieferte immer false).
- **Steamworks-Gerüst (S4, Plan 011 Phase 4)** — steamworks.js **0.4.0** exakt in `dependencies` (electron-builder packt nur
  Produktions-Abhängigkeiten; Vite bündelt es nie). `PlatformApi.steam: PlatformSteam | null` (`ready()` →
  `PlatformSteamSession {appId, achievements, unlockAchievement, setPresence, onOverlay}` | null), `caps.steam` erst nach init
  true. Bridge-Feld `velocityDesktop.steam?` (`DesktopSteamBridge`, `DesktopSteamStatus`, `SpacewarAchievement`; Kanäle
  `STEAM_IPC` in electron/steam.ts) nur mit `--steam`/`VELOCITY_STEAM=1` und ladbarem Binding. **Modul-Hooks** (`modules.ts`):
  `beforeReady?()` (vor app.ready, nur erste Instanz), `windowReady?(win)` (erstes Bild — Steam-init läuft erst hier),
  `ctx.handleSync`, setup höchstens `MODULE_SETUP_TIMEOUT_MS` (3 s) abgewartet, dispose/beforeReady/windowReady mit try/catch
  (seit Review C6 über `electron/moduleRunner.ts`, siehe unten).
  **Game** (`platform/live.ts`): `onLiveProgress` (finish mit `isCleanFinish` = Aufnahme gültig + kein Bot, live geschaffte
  Lektionsstufen, angenommener Supabase-Lauf; Lektion unsauber bei Bot/Override/Teleport/Config-Patch), `ghostRace`.
  Achievements (`platform/achievements.ts`, `velocity.achv.v1`) nur aus diesen Ereignissen, nie aus Admin/Bestzeiten; komplett
  aus mit `--dev` oder Debug-Zugang (`--remote-debugging-port`, `--inspect`). Fake nur mit `--dev --steam --steam-fake[=fail]`.

Plan 011 Review-Fix-Runde (07.11., Stränge pad-core/menu-ui/desktop + Abschluss) — Replay-Format, `PHYSICS_VERSION`,
`GameSettings`, `OnlineService`-Signaturen **unverändert**; Bundle-SHA bleibt `f2d04931…`:
- **Pad-Kurve** (`engine/pad/stickCurve`): `LookCurveParams.pitchSnap` (Default 0.2 in `DEFAULT_LOOK_CURVE`): axiale
  Deadzone nur für Pitch (Vertikalanteil |y|/|Stick| stetig nachskaliert, kein Zeitfilter); Boost wirkt nur auf Yaw.
  `edgeClock(clock, mag, dt)`: Boost-Uhr mit Hysterese (läuft ab `STICK_EDGE` 0.95, steht zwischen `STICK_EDGE_OFF` 0.85
  und 0.95, fällt darunter auf 0) — PadInput und die Sim-Hand (`tools/sim/StickHand.ts`) nutzen dieselbe Funktion.
  `digitizeMove(…, out, prev)`: Zustand = voriges Ergebnis, Winkel-Hysterese `MOVE_ANGLE_HOLD` ±3.5°, Betrag 0.3 an /
  0.2 aus (`MOVE_MAG_HOLD`). Zustand nur in PadInput, nie im Replay.
- **PadInput**: hält im Menü-/Pause-/Lade-Kontext, bei Aufnahme, `releaseAll` und Pad-Verlust Bewegung + Blickrate an
  (`setPadMove(0,0)`, `setLookRate(0,0)`, Boost-Uhr 0). `idleSeconds` (Aktivität nur auf der Flanke: Knopfdruck oder Stick
  über 0.5). Aufnahme-Frist läuft in `poll()` auch ohne Pad. Verlust des aktiven Pads lässt los und pausiert (im Spiel,
  wenn es benutzt war; auch mit zweitem Pad); ein anderes Pad übernimmt frühestens im nächsten Poll, dort schon gehaltene Knöpfe zählen erst nach dem Loslassen (nur
  wenn beim Verlust ein zweites Pad da war = Steam-Input-Spiegel; ohne Pad wird der Merker gelöscht). Pads mit
  `mapping !== 'standard'` werden ignoriert.
- **Belegung** (`engine/pad/types`): `sprint` (mit Auto-Sprint "Langsamer") in **beiden** Presets auf `PadLT`, L3 frei.
  Gespeicherte Belegungen werden nicht migriert.
- **Game**: `syncPadContext()` (Kontext = `menu.visible || !ticking`) in `onFrameStart` VOR dem Poll und nach den Aktionen.
  Im Pad-Modus schaltet der erste Klick ins Spiel nur den Ton frei (kein Lock, Pad-Modus bleibt), solange der Ton fehlt;
  danach wie früher Maus + Lock. Tasten schalten den Ton ebenfalls frei. `setFakePad(≠null)` und jeder Tick mit Fake-Pad
  markieren den Lauf assistiert. `runTampered` (F1-Config, Debug-Teleport/-Tempo, `configTampered(cfg, settings)` = Config ≠
  `movementConfigFor(settings)` außerhalb von Lektionen): **nur am Desktop** speichert `finishRun` dann weder Bestzeit
  noch Medaille noch Freischaltung ("Lauf nicht gewertet"). Ungültig aus anderen Gründen (zu lang, Respawns, Auto-Hop
  umgeschaltet) zählt lokal weiter; Web unverändert.
- **InputManager**: `devTools` (Web immer, Desktop nur `platform.dev`; F1-Tuning wirkt nur damit), `fakePadActive`. Maus im
  Lock schaltet erst nach 0.25 s Pad-Ruhe auf Tastatur (Tasten/Klicks sofort).
- **Menu**: Pad-Belegungsfelder ohne Pad gesperrt + Hinweis (role=status); alle Vollbild-Wege über
  `Menu.requestFullscreen` (Web ohne Nutzeraktivierung → Hinweis "Vollbild braucht einen Klick oder eine Taste"). Desktop-
  Login: modaler Hinweis **"Login läuft"** (`.vel-login-wait`, Knöpfe `.vel-login-again` = dieselbe Auth-URL erneut,
  `.vel-login-cancel` = `platform.auth.cancel()`; Esc/Pad B brechen ab, Screen darunter inert, Leertaste/Enter nur auf
  Knöpfen im Hinweis). Tastenhilfe nennt F1 nur mit Dev-Werkzeugen. Anzeigemodus folgt `platform.window.onModeChange`.
  `ui/padNav`: `refocusIndex` — nach Teil-Neuaufbau Rückfall auf den nächsten Index, erstes A zeigt nur den Fokus.
- **Online** (`online/types`, nur Doku erweitert): `signIn()` am Desktop löst bei Abbruch (`'cancelled'`, auch schon aus
  `begin()`) ohne Fehler auf; `onIdentityChange(null)` meldet jedes Login-Ende ohne Anmeldung (Abbruch/Frist/Fehler).
  `LoopbackLogin.cancel()` zählt auch, wenn es ankommt, während `begin()` noch bindet.
- **Plattform-Schicht**: `devToolsAllowed(p)` (Web immer, Desktop nur `dev`) — `window.__vel` und Dev-Parameter am
  Desktop nur damit. `PlatformWindow.onModeChange(cb)` (Bridge `window.onModeChange?`, Kanal `IPC.windowMode`
  `vel:window:mode`). Speicher-Spiegel: `saveMirror.onFlushRequest?(cb)` (Kanal `IPC.saveFlush`, Windows-Abmeldung),
  Renderer plant nach Fehlschlag neu (Backoff bis `SAVE_RETRY_MAX_MS` 60 s) und vergleicht nur mit dem bestätigten Stand;
  `flush()` → boolean.
- **Electron**: `isDevRun(argv, app.isPackaged)` = `!packaged && --dev` — im Paket sind `--dev`, `--query`, `--fault`,
  Steam-Fake und DevTools wirkungslos. `before-input-event`: Alt+Enter/F11 schalten den Anzeigemodus (gespeichert, Seite
  sieht die Taste nicht, keyUp mitgeschluckt; `isDisplayModeToggle`). Drosselung nur minimiert/versteckt (Page Visibility
  wirkt). `DisplaySleepGuard` (`power.ts`): Bildschirm wach nur im Vordergrund. `recovery.ts`: Startfehler → Dialog +
  `app.exit(1)`; Absturz/Hänger/Ladefehler einmal neu laden, zweiter Fehler in 5 min → Dialog; Fenster spätestens nach
  10 s sichtbar; `--fault=start|setup|crash-once|crash|load-once|load|noshow|hang` nur im Dev-Modus. `save.ts`:
  Generationszähler, tmp + fsync + rename, Retry bei EPERM/EBUSY/EACCES, `flushPendingSync` bei will-quit/Fehler-Ende/
  session-end. `moduleRunner.ts`: setups parallel unter EINEM Zeitlimit, windowReady/dispose genau einmal; Sync-Kanäle
  eines gescheiterten Moduls antworten null. `beforeReady(info: DesktopStartInfo {dev, syncChannels?})`.

### 3.5 Musik folgt dem Movement
Der Techno-Track (132 BPM) ist aus Oszillatoren und Rauschen gebaut. Er bekommt
pro Frame einen `MusicDrive` (Speed, Hop-Chain, Strafe-Sync, Surfen) und
entscheidet selbst über Layer (quantisiert auf Taktgrenzen) und kontinuierliche
Parameter (Filter, Resonanz, Sends). Stillstand = minimaler Loop, voller Flow =
alles offen. Umgekehrt liefert die Audio-Engine die Kick-Hüllkurve an den
Renderer, damit die Neon-Trims im Takt pulsieren.

### 3.6 Debug-Handle
Im Browser hängt `window.__vel` am Spiel (State lesen, teleportieren, Config
setzen, Eingaben injizieren, Ticks deterministisch vorspulen). Playwright-Tools
nutzen ausschließlich dieses Handle. Am Desktop gibt es es nur im Dev-Modus
(unverpackt mit `--dev`, `devToolsAllowed`); Werkzeuge für Paket/ohne `--dev`
warten auf das Menü (`data-door="ready"`, `.vel-menu[data-screen="title"]`) und
ersetzen `navigator.getGamepads` für das Fake-Pad.

---

## 4. Konventionen

- **Kein `any`**, kein `as unknown as`. Konstanten laufen typsicher über `MovementConfig`.
- Physik-Code ist DOM-frei und three-Render-frei (nur `Vector3`/`Box3` aus three) —
  er muss in Node (Vitest, Sim) laufen.
- Scratch-Vektoren statt Allokation im Tick-Pfad.
- Neue Erkenntnis, die Zeit gekostet hat → `.docs/learnings/fallen.md`. Parallele Stränge schreiben nach
  `.docs/learnings/inbox/<strang>.md`; die Integration führt sie in fallen.md zusammen und leert die Inbox.
- Größere Vorhaben → Plan in `.docs/plans/NNN-name.md` (Problem, Entscheidungen, Status).
- Subagenten (`.claude/agents/`): **planner** plant, **implementer** baut,
  **reviewer** prüft adversarial, **debugger** jagt Ursachen. Siehe dort.

---

## 5. Stand

Siehe `.docs/plans/` — der jüngste Plan mit Status "in Arbeit" ist der aktuelle.
