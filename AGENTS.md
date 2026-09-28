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
Stamina-/Landestrafe (würde Bhop töten), Multiplayer.

**Viewmodel: ja — eine Cartoon-Hand** (Nutzerwunsch 2026-09-28, vorher "kein Viewmodel";
seit Plan 006 ein echtes Low-Poly-3D-Viewmodel im Stil der Referenzen unter `hand screens/`):
weißer Handschuh mit weicher Grau-Schattierung, dicke dunkle Kontur, pummelige Finger, Stulpe
mit schwarzem Band, unten rechts im 16:9-Safe-Frame. Sie spiegelt das Movement (Sprung, Landung,
Sway, Surf, Tempo), nie umgekehrt; abschaltbar ("Hand anzeigen"), Bewegung hängt an `motionFx`.
Kosmetik (Plan 005/006): Neon-Handschuh (L1-Gold), Sammelkarte (L1-VELOCITY), Energy-Drink-Dose
(L2-VELOCITY), Butterfly-Messer (beide VELOCITY) — mit Gegenstand macht die Hand Tricks, je
schneller, desto wilder.

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
npm run sim            # Movement-Sim: Bots vergleichen, Tuning-Report
npm run levels:build   # tools/levels/*.ts → public/levels/*.json (Par gemessen: 3°-Hand × 1.05)
npm run levels:check   # Level validieren (Kompilierung, Spawn, Sprung-Reichweiten, Bot-Durchläufe über 8 Seeds, Auto-Hop-Raster)
npm run shot           # Hero-Shots aus dem echten Spiel + Ablauf-Checks (eigener Server, Port 5190, SHOT_PORT=…)
npm run playtest       # Bot spielt jedes Level in Echtzeit im Browser → shots/playtest/report.json (Port 5191, PLAYTEST_PORT=…)
node tools/alloc-probe.mjs [level] [s]  # Heap-Sampling im echten Spiel (Port 5199, ALLOC_PORT=…; --warmup 60 = Dauerbetrieb, fallen.md #65)
node tools/ghost-check.mjs [level]      # Ghost der Bestzeit: Bot gegen eigenen Ghost (Port 5232, GHOST_PORT=…)
npm run audio:check    # Musik offline rendern + spektral prüfen
node tools/viewmodel-shots.mjs [filter] # 3D-View-Hand im Spiel: Szenen, Ultrawide, HUD, Trick-Phasen je Gegenstand, Live-Läufe, Referenzvergleich, Menü, Ergebnis → shots/viewmodel/ (Port 5282, VM_PORT=…)
node tools/admin-shots.mjs              # Admin-Menü: Screenshots + Ablauf-Checks (Sperren überleben Neuladen, Medaille setzen, Ghost weg) → shots/admin/ (Port 5290, ADMIN_PORT=…)
node tools/viewmodel-sheet.mjs <spec.json> <out.png>  # Viewmodel-Kacheln ohne Spiel über dev/viewmodel.html (Posen, Griffe, festgehaltene Tricks; Port 5282, VMSHEET_PORT=…)
npx tsx tools/levels/medalProbe.ts      # Spiel-Uhr-Median mehrerer Bot-Modelle je Level (Grundlage der Medaillen)
npm run build
```

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
  world/             Level-Format, Brush-Kompilierung (konvexe Hüllen), Box-Traces
  player/            PlayerMovement (Source-pmove-Port), CameraRig, Bots
  audio/             Prozeduraler Techno: Sequencer, Instrumente, Mixer, SFX
  render/            PS2-Pipeline: Low-Res-Target, Materials (Vertex-Licht, Fog,
                     Affine, Snap), Post (Dither, Quantisierung, CA), Himmel, Trims,
                     Viewmodel (render/viewmodel: 3D-Hand + Gegenstände, Plan 006)
  ui/                HUD (Bitmap-Font im Low-Res-Raster), View-Hand-Logik (ui/hand: Bewegung,
                     Posen, Tricks — DOM-/three-frei), Menüs (HTML), Tuning-Panel
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
| Einstellungen | `src/engine/settingsTypes.ts` |
| Audio-API | `src/audio/types.ts` |
| Renderer-API | `src/render/types.ts` |

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
nutzen ausschließlich dieses Handle.

---

## 4. Konventionen

- **Kein `any`**, kein `as unknown as`. Konstanten laufen typsicher über `MovementConfig`.
- Physik-Code ist DOM-frei und three-Render-frei (nur `Vector3`/`Box3` aus three) —
  er muss in Node (Vitest, Sim) laufen.
- Scratch-Vektoren statt Allokation im Tick-Pfad.
- Neue Erkenntnis, die Zeit gekostet hat → `.docs/learnings/`.
- Größere Vorhaben → Plan in `.docs/plans/NNN-name.md` (Problem, Entscheidungen, Status).
- Subagenten (`.claude/agents/`): **planner** plant, **implementer** baut,
  **reviewer** prüft adversarial, **debugger** jagt Ursachen. Siehe dort.

---

## 5. Stand

Siehe `.docs/plans/` — der jüngste Plan mit Status "in Arbeit" ist der aktuelle.
