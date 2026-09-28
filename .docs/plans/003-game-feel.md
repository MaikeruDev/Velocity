# Plan 003 — Game-Feel-Polish (Runde 1)

**Stand:** 2026-09-27 · **Status:** in Arbeit

## Problem

Nach der Integration ist das Spiel technisch sauber, aber "generisch-gut".
Sechs Kritiker (Hände/Latenz, Movement-Kurven, Kamera, Audio, Look,
Level/Onboarding) haben es per Bots, Sim und Playwright gespielt und gemessen.
Die drei großen Befunde:

1. **Die ersten 90 Sekunden sabotieren Neulinge.** Auto-Hop mit gehaltener
   Taste gibt nie Bodenkontakt: W+Leertaste aus dem Stand kriecht mit 24 u/s,
   nach jedem Wand-Bonk "Mondhüpfen". Todesbänder an den ersten Lücken,
   Crouch-Kante und Surf ohne Erklärung.
2. **Skill wird nicht gespiegelt.** FOV-Kick unter 500 u/s tot, perfekter Hop
   auf der Kamera unsichtbar, Musik belohnt absolute Speed statt Flow,
   Belohnungs-SFX in L3/L4 maskiert, Speedometer verdeckt den Landepunkt.
3. **Der Aha-Moment beim Strafen kommt zu spät.** Gehaltenes W frisst zwei
   Drittel des Gewinns, 5°-Hände sind nach 20 Hops langsamer als Sprint.

## Entscheidungen

- **Smart-Auto-Hop** (bewusste Source-Abweichung): gehaltene Taste springt am
  Boden erst mit Anlauf (≥ 0.95 × Boden-Wunschtempo, oder ≥ 0.2 s Boden, oder
  keine Bewegungstaste). Frischer Druck, Puffer, Mausrad springen sofort.
  Skill-Decke unverändert.
- **Tempoabhängiger Luft-Cap 32 → 24** zwischen 350 und 700 u/s: die ersten
  Strafes zahlen sich sofort aus, die Decke steigt um ≤ 5 %. CS2-Preset aus.
- **Strafe-Assist** (Setting, Default an): in der Luft zählt W nicht, solange
  A/D gedrückt ist. Surf-Verhalten darf nicht schlechter werden.
- **Auto-Sprint** (Default an), Shift = langsamer (250).
- Kamera erzählt Tempo (FOV log-Kurve) und Skill (Perfekt-Hop-Pop, Sync-Surge,
  Surf-Lean); Blick bleibt 1:1, keine Rotation auf der Zielachse durch Shake.
- Musik feiert Flow (Energie-Formel mit Chain-Anteil), Surf ist ein
  musikalischer Breakdown mit Drop, Ziel/Bestzeit sind ein Outro.
- Onboarding: Hinweise im Moment (Crouch, Surf, Strafe), Showkeys-Strafe-
  Spiegel, Auffangmulden statt Tod an den ersten Lücken, Level 1 endet mit
  einer verzeihenden Surf-Rutsche.
- Wiederspielwert: Medaillen und **Ghost der Bestzeit**.

Verworfen (mit Grund im Kritik-Report): Air-Step gegen Treppen-Bonks
(löscht die Crouch-Mechanik), dritte Boden-Geschwindigkeit "Gehen",
desynchronized-Canvas als Default, großer Look-Umbau zu Set-Pieces.

## Stränge

movement · camera · audio · levels · render · ui-input (parallel, disjunkte
Dateien), danach eine Hand für Game.ts-Verdrahtung, Ghost, Whoosh,
Neuvalidierung der Level, Doku — dann Gesamtverifikation mit den
Kritiker-Werkzeugen (tools/critique/*).

## Ergebnis Runde 1 (27.09.)

Sechs Stränge parallel, danach eine Hand für Verdrahtung, Ghost, Whoosh, Neuvalidierung,
Allokationen und Doku. Alle Zahlen gemessen (echte Engine, Bots, Playwright im echten
Spiel); Details in den Strang-Reports und `.docs/research/movement-tuning.md`.
Offen bleibt die eigentliche Erfolgsmessung: **S6 Mensch-Playtest**.

**Einstieg (Movement, Level)**

| Messung | vorher | nachher |
|---|---|---|
| W + Leertaste gehalten aus dem Stand, 2 s (Smart-Auto-Hop, Anteil 0.97 statt 0.95) | 48 u, 24 u/s | 470 u, 245 u/s (Sprint 606 u, 315 u/s) |
| Treppe hoch mit Leertaste gehalten (30 Phasen) | 0/30 oben | 30/30, 312–320 u/s |
| Leertaste gegen Wand bei Tempo 0 | Mondhüpfen (0.008 s) | erster Sprung nach 0.203 s |
| Leertaste-Halter ohne Tod bis CP1 (L1 / L2, 310 Läufe) | 21 % / 8 % | 100 % / 100 % |
| Hand 5° Tode in der Hop-Reihe (L1, 8 Seeds) | 127 | 0 |
| W+A in der Luft, Schwung 90°/s, H3 / H10 (Strafe-Assist) | 350 / 419 u/s | 426 / 632 u/s |
| 5°-Hand nach 20 Hops (tempoabhängiger Cap) | 329 u/s | 410 u/s |
| Perfekter Bot H20 (Decke) | 1084 u/s | 1134 u/s (+4.6 %) |
| Perfekter Bot an der Crouch-Kante L1 | 320 u/s | 793 u/s |

**Skill-Spiegel (Kamera, Audio, Render, HUD)**

| Messung | vorher | nachher |
|---|---|---|
| FOV-Abfall nach dem ersten Sprung (L1) | −1.16° | 0° |
| Dip bei perfekten Hops (L1, max) | 9.07 u | 0.12 u |
| Roll-Vorzeichen = Kurvenrichtung (L1 / L2) | 88 / 83 % | 99 / 94 % |
| Yaw-Versatz durch Screenshake bei 1400 u/s | 0.37° | 0 |
| Musik: L3 erreicht (l1mid) / Layer-Flaps | 27.6 s / 1 | 22.8 s / 0 |
| Belohnungs-SFX in L4 (Terzbänder ≥ 8 dB, Sprung-Whoomp) | 0 | 7 |
| Rez-Blips am 32tel-Raster (Median) | 28 ms | 0.17 ms |
| Speedometer über dem Landepunkt (Entscheidungsfenster) | 25–30 % | 0 % |
| Tipp-Treffer 3 ms (C / D in der Luft) | 6/30, 5/30 | 30/30, 30/30 |
| Speed-Streifen 800 u/s, Außenring | 0.77 Stufen | 4.9 Stufen |

**Verdrahtung und neue Features (diese Hand)**

- Verdrahtet: `strafeAssist` (Settings ↔ TuningPanel ↔ MovementConfig), `motionFx`, `rig.setMovement`,
  `surfNormal` in copySnap, Landewelle und Tempostufe (mit 60 u/s Hysterese) an den Renderer,
  `lowLatency` (main.ts übergibt die gespeicherten Settings, Menü-Schalter mit Neulade-Hinweis),
  Speed-Streifen-Regler, echte Zeilenzahl im Grafik-Menü (1280×720: 270 → 240 Zeilen),
  Medaillen in Titel-Liste (aus index.json) und Ergebnis ("Nächstes Ziel: GOLD 24.50 (−1.31)").
- **Ghost der Bestzeit**: 32 Hz ab Verlassen der Startzone, komprimiert (2. Differenzen, Varint,
  Base64) — L1 3.9 KB, L2 2.8 KB (Grenze 40 KB). `tools/ghost-check.mjs`: identischer Bot-Lauf
  deckt sich auf dem Raster auf 0.001 u, HUD "GHOST ±x.xx" an jedem CP; Ziel-Abstand = Laufzeit −
  Ghost-Zeit (L1 4.875 s, L2 1.172 s, exakt). Ohne Bestzeit kein Ghost. Einstellung "Ghost der Bestzeit".
- **Vorbeizieh-Whoosh**: alle 2 Ticks zwei traceBox-Proben à 160 u, eigene Surf-Rampe ausgeblendet.
  Frame-Callback Ø 0.598 → 0.621 ms (+0.023 ms, Grenze 0.2). Level 2: 23 % der Proben mit
  Geometrie < 160 u (Ring-Bande, fremde Rampen); Level 1 nur an der Rutsche (1 %) — die Säulen
  stehen > 400 u neben der Linie.
- **Allokationen** (alloc-probe, gesamt / src/, KiB/s): Level 2 ohne Bot nach 2.5 s 725 / 355 →
  613 / 268 (JIT-Vorwärmen im Titel, 16 ms); Dauerbetrieb (60 s) 249 / 42 → 244 / 36. Level 1 mit
  Bot 1491 / 1019 → 1370 / 929. Die alten Referenzwerte waren JIT-Anlauf (fallen.md #65); was im
  Dauerbetrieb bleibt, sind three.js-Uniform-Aufrufe (~108 KiB/s).
- **Level gegen die finale Physik**: Neubau byte-gleich zum Stand des Level-Strangs (Medaillen
  L1 38.5/32.2/24.5/22.25, L2 20.8/18.8/17.6/15.92 s). levels:check: alle Bots 8/8 in beiden
  Leveln, Überschieß-Band 1.2× hält, 1 Warnung (Könner-Inseln). Hand 2° L1 über 20 Seeds 19/20
  (Movement-Strang hatte gegen einen älteren Level-Stand 13/20).

**Bewusst nicht erreicht**: Trim-Welle +60 % Luma (Decke +39 %, erreicht +33 %, #56),
Default-Lautheit beginner −18.9 LUFS (Ziel ≥ −17; Aufnahme stammt vom alten Movement),
Könner-Inseln lohnen sich für Bots nicht (L12), L2 unteres Bilddrittel am Spawn dunkler (L10).

### Fixes nach der unabhängigen Prüfung (27.09.)

Der Prüfer fand drei Regressionen, gegen die kein Strang-Werkzeug prüfte, und sieben kleinere
Punkte. Alle selbst nachgemessen, Zahlen vorher → nachher:

| Befund | Messung | vorher | nachher |
|---|---|---|---|
| Smart-Hop bremste Strafer mit NUR gehaltener Taste (Auto-Sprint, Schwelle 310) | 6°-Hand H20 ab 320 (8 Seeds, heldhands.ts) · wartende Landungen | 313 u/s · 69/160 (1575 Bodenticks) | **351** u/s (frisch 357) · 3/160 (75) |
| | 5°-Hand H20 · 6°-Hand ab 250 | 401 · 309 | 410 · 351 |
| | W+Space gehalten 2 s · Treppe/Rampe · Halter bis CP1 | 470 u/245 · min 312 · 310/310 | unverändert |
| L1-Slalom tötete gute Hände | L1 im Ziel von 20 Seeds: sync 0.95 / 0.9 / Hand 1° / 1.5° / 2° (goodhands.ts; vorher = Prüfer-Stand) | 20 / 18 / 16 / 16 / 19 | 19 / 18 / **20 / 19** / 19 |
| | dasselbe über 50 Seeds (ohne → mit Lenk-Vorrang, beide mit Knoten-Abhaken) | 49 / 47 / 46 / 46 / 44 | 48 / 47 / 50 / 49 / 49 |
| | Respawn aus dem Stand ab CP2 / CP3, 5 Modelle × 30 Seeds (ohne → mit Lenk-Vorrang, cp3stand.ts) | 131 / 133 von 150 | 144 / 140 von 150 |
| HUD-Mitte überladen | Split-Popup bei Ghost · Gain-Popup "+0" · Ghost unter den Ziffern | doppelt · jeder Hop · verdeckt | nur GHOST-Zeile · erst ab 3 u/s · Block auf 30 % (L1: 9 % der Lauf-Frames gegen den Ghost) |

- **Smart-Hop**: `autoHopLandShare` 0.75 / `autoHopLandAirTime` 0.25 s — mit A/D gedrückt reicht
  im ersten Bodentick nach echter Luftphase 0.75 × Wunschtempo (240 mit Sprint). Reines W bleibt
  bei 0.97: ohne diese Einschränkung hopste der W-Halter nach einem Treppen-Teilanprall dauerhaft
  mit 241 statt 312 u/s (ramp-phase.ts). Belege in movement-tuning.md "M1b", Vitest neu.
- **Slalom**: Ursache war das Bot-Modell, nicht (nur) die Geometrie. Bei 900 u/s ist das
  Gewinnfenster ±1.5°; Zielrauschen vor dem Fenster erzeugt weder Gewinn noch Drehung, die Hand
  flog geradeaus an die Inselflanke (fallen.md #70). Der RouteFollower lenkt jetzt mit Vorrang
  (Fehler nach vorn → Dreh-Seite gespiegelt) und hakt einen Knoten ab, wenn er ihn überfliegt und
  tiefer auf dem Folgeabschnitt landet (4 von 11 Toden waren Umkehren von der Rutsche zur letzten
  Insel). levels:check prüft sync 0.9, Hand 1° und 1.5° mit. Level-Geometrie unverändert
  (Neubau byte-gleich bis auf gemessene Werte): Medaillen L1 36.2/30.4/24.5/22.25 s (Par 37),
  L2 21.2/18.6/17.6/15.92 s (Par 22). Eine Auffangfläche unter dem Slalom wurde verworfen: jede
  Variante, die späte Ankünfte an der Inselflanke fängt, macht auch die gerade Linie ohne Lenken
  befahrbar (slalomNeedsSteering). Rest-Risiko ~1–2 Tode pro 50 Läufe je Modell — S6 prüfen.
- **HUD**: bei aktivem Ghost keine große Split-Zahl mehr (GHOST-Zeile trägt sie), Gain-Popups erst
  ab |3| u/s, Kette erst ab 100 u/s, Speedometer-Block blendet auf 30 %, solange der projizierte
  Ghost dahinter liegt (`HudData.ghostOverHud`). Screenshots: shots/verify1/hudghost/.
- **Kleinere**: NaiveBot hält die Taste wirklich (5 s: 1057 u / 247 u/s statt 169 u / 32 u/s),
  `useBot` kennt `aimNoiseDeg`/`press`; Ergebnis "Nächstes Ziel: GOLD 24.50 (noch 0.21 s)"
  statt "(−0.21)"; Preset CS2 schaltet den Strafe-Assist aus, Menütext nennt Half-Sideways;
  Kritiker-Werkzeuge repariert bzw. aus verify1 übernommen (blips.ts, sfxmask.mjs, look/measure.mjs,
  kamera/lib+record+analyze.mjs, air.ts "nur W", ground.ts Duck-Walk, traceRoute mit Level-ID,
  novice.ts Seed je Respawn); derive.mjs/gain.mjs als veraltet markiert.
- **Offen gelassen** (Geschmack, braucht S6): FOV bis ~122° horizontal bei > 1000 u/s; L10 unteres
  Bilddrittel am Spawn; Trim-Fläche direkt vor der Crouch-Wand; Könner-Inseln (L12) weiter 0–2/6.

Suite nach den Fixes: tsc 0, vitest 250/250, build ok, levels:check 0 Fehler / 2 Warnungen (Könner-
Inseln; neu: sync 0.9 7/8 — ein Slalom-Tod, s. o.), audio:check 76/76, playtest L1 22.24 s / L2
15.80 s / 60 fps, shot 38/38.

## Runde 2 — Kamera/Einstellungen (27.09.)

**FOV-Obergrenze.** Die Gesamtkappe (Speed + Pop + Surge, 4:3-Grad) sitzt jetzt mit dem Knie
genau auf dem Speed-Kick bei 800 u/s (10.07°) und sättigt per tanh auf **11°** (vorher Knie 15,
Kappe 17). Horizontal bei 16:9, Default-FOV 90:

| u/s | nur Speed vorher → nachher | Speed + voller Surge vorher → nachher |
|---|---|---|
| 300 | 107.8 → 107.8° | 110.1 → 110.1° |
| 500 | 111.9 → 111.9° | 114.3 → 114.3° |
| 800 | 115.7 → 115.7° | 118.0 → 116.5° |
| 1000 | 117.5 → 116.5° | 119.7 → 116.5° |
| ≥ 1400 | 120.1 → 116.5° | 121.9 → **116.5°** (vFOV 90.8 → 84.6°) |

Die Vorgabe "≤ ~112°" ist mit "Log-Kurve 300–800 unverändert" nicht vereinbar: 112° sind nur
5.8° Kick, die Kurve hat 6° schon bei 500 u/s (fallen.md #71). Entschieden für die Kurve; ein
Wechsel auf 112° ist eine Konstante (`FOV_TOTAL_CAP` 5.8), drückt aber alles ab ~480 u/s flach.
Preis der 11°: der Sync-Surge ist bei 800 u/s nur noch 0.9° sichtbar (vorher 2.5°), ab ~1000 u/s
gar nicht — dort trägt der Pop/HUD/Audio das Skill-Signal. Der Surge-Test im Band 250–600 ist
unverändert grün.

**Strafe-Assist.** Die Regel "Preset-Wechsel setzt den Assist auf den Preset-Wert" wanderte aus dem
Menü in `SettingsStore.update` (greift so auch im F1-Panel); ein ausdrücklicher Wert im selben
Update gewinnt, derselbe Preset ändert nichts. Alte Stände ohne Feld laden mit dem Wert ihres
Presets (CS2 → aus). Kein "explizit gesetzt"-Merker: bei zwei Presets mit gegensätzlichem Default
ist "Abweichung behalten" gleich "Default des neuen Presets", und der Preset-Klick ist selbst die
Wahl des Spielers. Menütext: "W zählt in der Luft nicht, solange A/D gehalten wird — für
Half-Sideways ausschalten."

**Tests.** camera +4 (Kappe/Stetigkeit, fovKick 0 bit-genau bei 1800 u/s, headBob 0 und motionFx 0
einzeln), settings +3. Suite: tsc 0, vitest 257/257, sim läuft, shot 38/38 (Port 5254).

## Runde 2 — Level (27.09.)

Vier offene Wow-Lücken aus der Prüfung von Runde 1. Alle Zahlen gemessen; Details und verworfene
Varianten in `.docs/research/level-design.md` ("Polish-Runde 2") und fallen.md #72–#75.

**1. Level 2: verzeihende erste Surf-Berührung (S0).** Vorher fiel man von E1 ~420 u tief auf die
665 u hohe S1-Flanke; wer nicht in die Rampe drückt, war nach ~3 s tot. Jetzt beginnt die Kette mit
S0: gleiches Profil wie S1 (768 breit, 60°), unter E1 mit dessen 10°, dahinter 672 u mit nur 4°
Gefälle; darunter eine geschlossene Grube (Fläche 32 u unter dem Fuß, Bande, Quergang vor der
Südkappe, 256 u unter den S1-Anfang verlängert, keine Kill-Zone) und ein Rückweg: Durchgang in der
Ostbande → Rampe 34° → Absatz neben dem Vorfeld, gleich neben E1; Chevrons zeigen hin. S1 schließt
Stoß an Stoß an, S2 bis Ziel liegen an alter Stelle (71 u höher: S0 fällt flacher).

| Messung | vorher | nachher |
|---|---|---|
| novice.ts L2, Tode in 300 s (W / W+Space / Walk-then-Space / Edge / Edge+Crouch) | 93 / 93 / 114 / 64 / 55 (Σ 419) | 0 / 1 / 0 / 0 / 0 (Σ 1) — **alle STAU** nach 44–52 s in der Grube, s. u. |
| Neue Probe `s0Catch`: 12 W-Halter ab CP2 (Blick ±30° / auf Knoten, ± Leertaste), 12 s | tot nach ~3 s | 12/12 ohne Tod |
| Neue Probe `s0BackWay`: Grube → Vorfeld zu Fuß (W / W + Leertaste) | — | begehbar, ≤ 6.7 s |
| sync 1.0, Spiel-Uhr (Autor-Medaille, Median 8 Seeds) | 15.92 s | 15.86 s |
| sync 1.0 im Browser (playtest) | 15.80 s | 15.85 s |
| Medaillen L2 (Bronze/Silber/Gold/Autor), Par | 21.2/18.6/17.6/15.92, 22 | 21.4/18.7/17.5/15.86, 22 |
| levels:check L2: alle 8 Bot-Modelle, Ausfahrt-Raster, Surf-Raster | 8/8, 0/600, 0 Nahtstopps | 8/8, 0/600, 0 Nahtstopps (Selbsttest 22 → 24 Fälle) |

Die Novizen-Zeile ist ehrlich zu lesen: Die Bots sterben nicht mehr, weil sie in der Grube stehen
bleiben — sie zielen stur auf den nächsten Knoten auf der Flanke über sich (fallen.md #73) und
nehmen den Rückweg nicht; der W-Halter "schwebt" an der flachen S0-Flanke. Ein Mensch hat den
Rückweg (Probe grün) oder F. Ob er ihn findet, zeigt erst S6; aus der Grube ist der Durchgang erst
nah lesbar. Das Ausfahrt-Raster (600 Geradeaus-Läufe) war das härteste Kriterium: jede neue Kante in
der Landezone ließ 1–45 Läufe abprallen; grün ist nur ein kleines Plateau aus Länge × Gefälle von S0.

**2. Level 1: Crouch-Kante.** Die Absprungzone liegt jetzt als Bodenmarkierung auf H7: dasselbe
Pixel-Glyph ↑C wie an der Wand, gefüllt, in Trim-Farbe, 80–280 u vor der Wand, in Laufrichtung
gestreckt (aus dem Anlauf liest es sich als ↑C, nicht als Striche). Die Wandglyphen sind kleiner
(8 statt 12 Texel, ein Chevron statt zwei je Seite: −56 % leuchtende Texel).

| Anteil flaches Cyan im Bild (1920×1080, 270 Zeilen) | vorher | nachher |
|---|---|---|
| 35 u vor der Wand | 19.2 % | 13.2 % |
| 86 u vor der Wand | 11.8 % | 6.9 % |
| auf H7, 265 u vor der Wand (Markierung im Blick) | — | 11.3 % |
| Anlauf, 765 u vor der Wand | 1.3 % | 1.3 % |

Rest direkt an der Wand ist das Kanten-Trim (~8 % bei 35 u, Augenhöhe genau auf der Kante) — das
bleibt, es ist die Lesbarkeit der Kante. Probe `crouchWindow` unverändert grün.

**3. Level 2: Spawn heller.** ambientSky #3b2d80 → #5a4abc, Mond etwas höher (sunDir.y 0.35 → 0.5),
Mondlicht heller (#bce2ff). Trims sind emissiv und bleiben.

| Spawn L2 (look/measure.mjs dark, Low-Res-Grab) | vorher | nachher |
|---|---|---|
| Luma unteres Bilddrittel (y > 70 %) | 0.182 (Screenshot 0.171) | **0.226** (Screenshot 0.224) |
| Anteil Luma < 0.1 | 45.5 % | **32.7 %** |
| mittlere Luma | 0.144 | 0.163 |
| Trim (hellste 4 %) / Fläche (Median), Bildband 50–80 % | 7.1 | 5.0 |

**4. Level 1: Vorbeizieh-Whoosh.** Die Whoosh-Probe sieht nur Kollisions-Geometrie (Deko mit
`collide:false` ist stumm, fallen.md #74). Neu: sechs kollidierbare Finnen (24 × 128 u, Leuchtkopf
als Deko) außen neben den Slalom-Inseln, 28 u neben der Inselkante, mittig in der Länge.

| `npx tsx tools/levels/whoosh.ts level1` (Proben mit Geometrie < 160 u) | vorher | nachher |
|---|---|---|
| sync 1.0, ganzer Lauf | 1.3 % (nur Rutsche) | 2.9 % |
| sync 1.0, Slalom | 0/295 | 19/295, nächster Vorbeiflug 123 u |
| sync 0.8, ganzer Lauf | 0.9 % | 3.1 % |

Hop-Reihe und Kehre bekommen keine: ihre Plattformen sind ±128 u breit, ein Pylon < 160 u neben der
Linie stünde in der Landezone. `slalomNeedsSteering` (115 Geradeaus-Läufe) und die Rutschen-Probe
unverändert grün; L2 zum Vergleich 20.6 → 21.6 %.

Suite: tsc 0, vitest 257/257, levels:build + levels:check 0 Fehler / 2 Warnungen (beide L1 wie vorher:
Könner-Inseln, sync 0.9 7/8), shot 38/38 (Port 5250), playtest L1 22.24 s / L2 15.85 s / 60 fps,
0 Konsolenfehler (Port 5251).
