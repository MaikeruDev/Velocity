# Plan 010 — Menü-Labor: vier Hauptmenü-Stile zum Ausprobieren

**Stand:** 2026-11-06 · **Status:** vier Stile gebaut, **ps2 ist Default** (`DEFAULT_SETTINGS.menuStyle`). Runde 4 (§7):
Vertrag für native Stil-Ansichten (Training, Bestenliste, Kosmetik, Profil, Moderation), Profilseite, Dev-Moderation.

## 1. Ziel

Das Hauptmenü soll etwas Eigenes werden (möglicher Steam-Release). Statt eines Entwurfs entstehen **vier Stile**, die man im
**Menü-Labor** nebeneinander ausprobiert; der Nutzer entscheidet danach. `classic` (das bisherige Menü) bleibt Default.

| id | Name | Idee |
|---|---|---|
| `classic` | Klassik | bisheriger Titel, unverändert |
| `ps2` | PS2-Konsole | Boot-Sequenz, Memory-Card-Screen fürs Profil/Saves, rotierende 3D-Objekte als Menüpunkte |
| `hub` | Hub-Raum | diegetischer 3D-Raum: Neon-Schilder/Portale als Menüpunkte, Kamera fliegt zwischen Stationen (Level-Portale, Spind = Kosmetik, Trophäenwand = Bestenliste); eigenes kleines three.js-Canvas im Menü |
| `rave` | Rave-Flyer | riesige schräge Schrift, Club-Flyer, alles pulst im Techno-Takt, Menüpunkte als Tracklist |
| `arcade` | Arcade-Automat | INSERT COIN, Attract-Mode mit Highscore-Tabelle, CRT-Wölbung, Demo-Läufe-Vibe |

## 2. Entscheidungen

- **Eine Front Door ersetzt nur den Titel-Screen** (Hauptmenü + Levelauswahl). Einstellungen, Steuerung, Kosmetik, Training,
  Bestenliste, Admin, Pause, Ergebnis, Labor, Profil bleiben die Screens aus `Menu.ts`. Jeder Stil darf sie **per CSS**
  umfärben — nur unter `.vel-menu.vel-style--<id>` (die Klasse hängt immer am Menü-Root, auf allen Screens).
- **Vertrag** `src/ui/menuLab/types.ts` (SSOT, hier nicht wiederholt — lesen!): `FrontDoor { mount, update, unmount,
  onAction? }`, `FrontDoorFactory`, `FrontDoorContext` (alle Titel-Daten als Schnappschuss + stabile Rückrufe). Kein Stil
  importiert Menu-Interna.
- **Lazy**: `registry.ts` lädt `./<id>/index.ts` per `import()` erst, wenn der Stil gewählt ist (eigener Chunk, eigenes CSS).
- **Einstellung** `GameSettings.menuStyle: MenuStyleId` (Default `'classic'`, `sanitizeSettings` → unbekannt = vorheriger
  Wert). **`?menu=<id>`** überschreibt nur für die Sitzung (nicht gespeichert); "Ansehen" im Labor speichert und löst den
  Override.
- **Labor** (`MenuScreen 'lab'`): erreichbar vom klassischen Titel (kleiner Knopf neben "Admin"), aus jeder Front Door
  (`ctx.openLab()`, Pflicht!) und aus dem Admin-Menü (Knopf im Kopf). F8 → Admin → Menü-Labor geht immer.
- **Profil** (`MenuScreen 'profile'`): Platzhalter "Profil — kommt" (`ctx.openProfile()`), bis der Profil-Strang ihn baut.
- **Takt** `ctx.beat()`: echte Musik (AudioApi.beat()), sobald der AudioContext läuft; davor **Ersatz-Uhr 132 BPM** ab
  Seitenstart (deterministisch, kick 150-ms-Hüllkurve, energy 0.35, `live: false`). Musik startet erst mit einer Geste —
  `ctx.startMusic()` aus einem Klick entsperrt sie (läuft im Menü gedämpft wie im Pause-Menü).

## 3. Dateien

```
src/ui/menuLab/
  types.ts        Vertrag (gemeinsam — NICHT ändern, Wünsche an den Integrator)
  registry.ts     Loader je Stil + Labor-Karten (Name, Beschreibung) — NICHT ändern
  beatClock.ts    Takt / Ersatz-Uhr — NICHT ändern
  assets.ts       Logo-URL (media/velocity_font.png) — NICHT ändern
  stubDoor.ts     Platzhalter (wird nach allen vier Stilen gelöscht)
  ps2/ hub/ rave/ arcade/
    index.ts      default export: FrontDoorFactory   ← hier baut der Stil-Agent
    <id>.css      eigenes CSS, alles unter .vel-menu.vel-style--<id>
    …             beliebig weitere Dateien im eigenen Ordner
```

Integration (schon da): `Menu.ts` (showTitle → Front Door, Klasse am Root, Labor, Profil, Tasten), `menu.css` (Abschnitt
"Menü-Labor"), `main.ts` (`menu.setAudio(audio)`, `?menu=`), `settingsTypes`/`Settings` (menuStyle), `ui/types`
(MenuScreen + `'lab' | 'profile'`), `tests/menuLab.test.ts`, `tools/menu/shot.ts`.

## 4. Regeln für Stil-Agenten

**Erlaubt:** nur `src/ui/menuLab/<id>/**`. Sonst nichts — kein `Menu.ts`, `menu.css`, `Game.ts`, `types.ts`, `registry.ts`,
`package.json` (keine neuen npm-Pakete), keine anderen Stil-Ordner. Brauchst du etwas im Vertrag: im Bericht melden, nicht
selbst ändern. Lernerfahrungen → `.docs/learnings/inbox/menu-<id>.md`.

**Muss:**
1. `index.ts` exportiert `default` eine `FrontDoorFactory`. Beim **Import** kein DOM/`window`/`document` anfassen (der
   Vitest-Test lädt jedes Modul in Node) — alles erst in `mount()`.
2. `unmount()` räumt ALLES ab: `window`-Listener, rAF, Timer, Audio-Knoten, WebGL (`renderer.dispose()`,
   `renderer.forceContextLoss()`, Geometrien/Materialien/Texturen). Die Front Door wird **bei jeder Rückkehr zum Titel neu
   gemountet** (aus Einstellungen, Bestenliste, Level …) — `ctx.entry === 'return'` → Intro überspringen/kürzen.
3. Jeder Menüpunkt des klassischen Titels muss erreichbar sein: Level wählen + starten, Training (inkl. Neuling-Angebot
   `training.newbie` + `training.recommended`), Bestenliste, Kosmetik, Einstellungen, Steuerung, Vollbild, Konto (Login nur
   wenn `account.loginRequired`; angemeldet Avatar/Name/DEV + Abmelden), Profil, Menü-Labor, (unauffällig) Admin.
4. **Pointer Lock** (die wichtigste Falle): `ctx.play(id)` / `ctx.playSelected()` **synchron im click-/keydown-Handler**
   bzw. in `onAction('confirm')` aufrufen — nie nach `await`, `setTimeout`, Animationsende. Das Menü verschwindet sofort
   (kein Outro). Startknöpfe mit `ctx.markLockButton(btn)` markieren (Menu.ts sperrt sie während `lock.pending`).
   `ctx.lock.error` sichtbar anzeigen (Text kommt fertig, z. B. "Die Maus konnte nicht gefangen werden …").
5. **Tasten:** Enter/Esc/R kommen NUR über `onAction('confirm' | 'back' | 'restart')` (InputManager → Menu.handleAction,
   im nächsten Frame; gilt noch als Geste). Nicht selbst auf Enter/Escape lauschen (sonst doppelt). Pfeile/WASD/Space o. Ä.:
   eigener `window`-keydown-Listener (in `unmount` entfernen); Eingabefelder (`e.target` input/select) ignorieren. F8 (Admin),
   F1 (Tuning), M (Ton) gehören dem Spiel. Enter/Space auf einem **fokussierten Button** lösen nur dessen click aus (kein
   'confirm'). Buttons nicht automatisch fokussieren (eine Leertaste aus dem Spiel würde sie auslösen).
6. `ctx.select(i)` meldet die Auswahl (bleibt über Screens erhalten); es kommt KEIN update() darauf — selbst neu zeichnen.
7. `ctx.reducedMotion` respektieren (kein Dauer-Pulsieren, keine Kamerafahrten).
8. `ctx.beat()` liefert ein wiederverwendetes Objekt: im rAF lesen, nicht speichern; im rAF nicht allozieren.

**Look** (`.docs/rules/look.md` gilt): PS2-Ära, harte Kanten, kein weicher Blur/Glow, kein Antialiasing für eigene
Canvases (`antialias: false`, Low-Res + `image-rendering: pixelated`, ganzzahlig skalieren). **Schriften:** geladen sind nur
**Silkscreen** 400/700 (`var(--font-head)`, Überschriften/Kürzel; **nur bei Vielfachen von 8 px scharf**: 8/16/24/32/…)
und **Pixelify Sans** 400/700 (`var(--font-body)`, Fließtext; Ligaturen sind am Root aus). Andere Schriften gibt es nicht
(keine neuen Pakete). Farben am Root: `--cyan --magenta --gold --gain --loss --text --dim --ink --panel --panel-2 --line`.
Logo-Bild: `ctx.assets.logoUrl` (2172×724 PNG, transparent; ~1 MB, nur geladen, wenn benutzt).

**Root-Deko:** `.vel-menu` hat einen Verlaufs-Hintergrund und `::after`-Scanlines über allem. Wer das nicht will:
`.vel-menu.vel-style--<id>[data-screen='title'] { background: none }` bzw. `…::after { display: none }` im eigenen CSS.
Hinter dem Menü rendert das Spiel weiter die langsam drehende Level-1-Kulisse (eigenes WebGL). Ein eigenes three.js-Canvas
(hub/ps2) kommt dazu — klein halten (Low-Res), deckend zeichnen, wenn die Kulisse nicht durchscheinen soll.

**Front-Door-Container:** `root` = `div.vel-frontdoor.vel-frontdoor--<id>` (position:absolute; inset:0; overflow:hidden),
leer, schon im DOM. Klassen der Bestands-Screens (`.vel-btn`, `.vel-panel`, `.vel-h1` …) darf man mitbenutzen.

## 5. Prüfen

```bash
MENU_STYLE=<id> MENU_PORT=<eigener Port> npx tsx tools/menu/shot.ts
#   → shots/menu/<id>/01-title, 02-title-later (nach MENU_WAIT ms, Default 1500), 03-arrow-down, 04-hover, 05-lab,
#     06-pause, 07-settings (Bestands-Screens im Stil), 08-title-return (entry 'return'); Pfade werden ausgegeben.
#   Exit 1 bei Konsolen-/Seitenfehlern, fehlender Root-Klasse, nicht gemounteter Front Door.
#   MENU_SIZE=1280x720,1920x1080 für mehrere Größen (Präfix im Dateinamen). Läuft mit ?online=mock (kein Netz).
#   Eigenen Port nehmen (z. B. ps2 5721, hub 5722, rave 5723, arcade 5724), die vier laufen parallel.
npx tsc --noEmit          # 0 Fehler in deinen Dateien
npx vitest run tests/menuLab.test.ts   # lädt dein Modul in Node
```

Im Browser: `npm run dev` → `http://localhost:5173/?menu=<id>` (oder Menü-Labor → "Ansehen").

## 6. Offen

- Nach den vier Stilen: Nutzer wählt; Stubs + `stubDoor.ts` löschen; ggf. Gewinner als Default.
- ~~Profil-Screen~~ erledigt (Runde 4): classic = Bestands-Screen `showProfile(uid?)`, ps2 = eigene Ansicht.
- hub/rave/arcade könnten die neuen Daten (`board`, `lessons`, `gloves/items`, `theme`) ebenfalls nutzen; `views` leer
  lassen = Bestands-Screens wie bisher.
- `GameSettings` ist im Verifier-Bundle (über `Settings.movementConfigFor`): jede Änderung an `Settings.ts`/`settingsTypes.ts`
  verschiebt Minifier-Namen → `tests/submitFunction` meldet "Bundle veraltet" → Bundle bauen/hochladen/deployen (Plan 009 §14).

## 7. Runde 4: native Stil-Ansichten, Profil, Moderation (06.11.)

**Delegation.** `MenuStyleInfo.views` (registry.ts) sagt, welche Bestands-Screens ein Stil selbst baut. Ruft man
`showTraining` / `showLeaderboard` / `showCosmetics` / `showProfile(uid?)` / `showModeration` vom Titel aus auf (Training auch
nach einer Lektion, Profil von überall), zeigt Menu.ts stattdessen die Front Door mit `ctx.request = {view, levelId?, uid?}`
(einmal zugestellt, `entry: 'return'`). Aus Ergebnis/Pause bleiben die Bestands-Screens, damit "Zurück" dorthin führt.

**Neue Daten/Aufrufe** (Vertrag, `types.ts`): `FrontDoorLevel.theme`, `FrontDoorTraining.lessons/groups/demoKey`,
`FrontDoorCosmetics.gloves/items`, `ctx.board(levelId)`, `raceGhost(levelId, runId | null, label)` (synchron in der Geste,
Knopf mit `markLockButton`), `getProfile(uid?)`, `admin()` (nur Devs, sonst null), `equip(kind, id)`,
`mountHandPreview(canvas, label)` (Rückgabe = stoppen, Pflicht in `unmount`), `openProfile(uid?)`. Fehler von `board`/
`getProfile` sind `OnlineError` (`code`, lesbare `message`).

**ps2** (`ps2/views.ts`): Training (Lektionen als Slots mit Pylon, Sterne, Start), Bestenliste (Strecken als Discs links,
Top 10 + "um dich herum", Name → Profil, Ghost je Zeile, Weltrekord/Eigene Bestzeit, Login-Hinweis), Kosmetik (3D-Hand-
Vorschau 2×/3×/4× + Inventar, Enter rüstet aus), Profil (Memory-Card-Ansicht, je Level Disc, Zeit, Rang `#3 / 41`,
Medaille, Ghost, Liste; eigenes ohne Login = Discord-Hinweis + lokale Zeiten), Moderation (System → Moderation, nur Devs:
Läufe / Spieler / Protokoll, Filter, "Mehr laden", Löschen und Sperren zweistufig mit Pflicht-Begründung, Umbenennen). Auf
fremden Profilen sieht ein Dev einen Moderations-Block. Weltrekord je Disc in Disc-Auswahl und Memory Card. Discs in den
Level-Farben (Trim aus der Level-Datei).

**Fit-Zoom der übrigen Bestands-Screens** (`ps2/fit.ts`): je Screen die größte Stufe aus 1 / 1.5 / 2, bei der Inhalt und
Breite passen (sonst 1, scrollt dann wie classic), Rest-Platz zu 40 % nach oben. Gemessen bei Screenwechsel, Größe,
Inhaltsänderung (MutationObserver + ResizeObserver, ein rAF); meldet sich ab, wenn der Root den Stil verliert.

**Prüfen:** Abläufe `?online=mock&mockdev` (Bann → Eintrag weg, Löschen → Bestzeit wandert, Umbenennen, Protokoll) per
Playwright; Vertrag in `tests/frontDoorContract.test.ts`.
