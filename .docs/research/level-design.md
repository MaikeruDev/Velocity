# Level-Design: 01 GRUNDKURS und 02 SCHLEIFE

Level sind Movement-Spielplätze, keine Content-Masse. Jeder Abschnitt fragt
genau eine Fähigkeit ab und verlangt eine bestimmte Geschwindigkeit. Die
Geometrie wird aus diesen Zahlen **berechnet** (`tools/levels/level*.ts`) und
danach mit **echter Physik geprüft** (`npm run levels:check`). Ballistik allein
hat sich als zu optimistisch erwiesen: Rampbugs an Hüllenfugen, Stirnflächen an
Surf-Übergängen und Reibung auf Plattformen sieht man nur in der Simulation.

**Alle Plan-Tempi kommen aus `VELOCITY_DEFAULT`** — gemessen, nicht
hartkodiert: Hop-Rhythmen aus `physics.SpeedCurve` (Strafe-Bots auf flachem
Boden), Pflicht-Tempi aus dem Menschenmodell `SpeedCurve.hand(3°)`, das
untere Tempo-Band der Surf-Kette aus `physics.measureSurfSpeeds` (Surfer, 3°-Hand
und Surf-Raster aus dem Stand). Nach jedem Movement-Tuning: `npm run
levels:build && npm run levels:check` — die Level ziehen mit.

## Retuning auf Cap 24 + Kanten-Bevels (26.09.)

Mit `airSpeedCap` 24 statt 17 sind Spieler ~1.3× so schnell (perfekter Bot Hop
5/10/20 ≈ 584/787/1084 u/s), und die Spreizung wächst: die 3°-Hand sättigt bei
~560 u/s, die 2°-Hand bei ~800, der perfekte Strafer läuft weiter. Die Level
wurden deshalb nicht einfach skaliert, sondern auf ein **Band** ausgelegt:

- **Pflichtweg für die 3°-Hand** (Gelegenheitsspieler, CS2-Parität): jeder
  Abschnitt ist mit ihr schaffbar — im Check als Info-Zeile, Scheitern wäre eine
  Warnung; `tests/movement.test.ts` hält beide Level fest.
- **Überschießen darf nicht frustrieren**: Wo Schnelle landen, ist Fläche —
  tiefere Plattformen statt größerer Lücken, Präzisionsinseln durch Wände mit
  Absprungzone ersetzt, Todesstreifen hinter Absprungblöcken geschlossen.
- Die Kanten-Bevels (compileLevel) machen Hüllenfugen exakt: Surf-Ketten laufen
  Stoß an Stoß, die Knick-Überlappungen sind entfernt. Dafür ist jeder Grat mit
  < 45° Achsgefälle begehbar (wie in Source) — wer auf dem First landet, hat
  Bodenkontakt.

## Nach dem E2E-Review (27.09.)

Das Review hat mit Auto-Hop gespielt (Default) statt mit einem Absprungpunkt pro
Probe und fand Todesbänder, die die Design-Proben als "kein Todesstreifen"
meldeten (fallen.md #43). Umgebaut:

- **Todesbänder geschlossen** (Regel 7): Level 1 Auffangrampe + Block bündig an
  Terrasse 5, Kehre → Wende lückenlos; Level 2 Vorfeld Ring → E1, S1 unter E1.
  Die Proben laufen jetzt als Auto-Hop-Raster (Tempo × Versatz × zwei Startknoten).
- **Level 2 kürzer und mit Entscheidungen**: Ausfahrt im ersten Durchgang (vorher
  erzwang die Route 1.25 Runden), Innenbahn mit zwei Lücken, Anlaufbahn als
  Hop-Linie. Bot-Zeiten 26.9–42.0 s → 17.8–23.7 s.
- **Respawn in der Surf-Kette** auf Keil-Pads am Grat der Folgerampe (Regel 9).
- **Kill-Zonen** gestuft unter den Level-1-Terrassen, neben den Surf-Rampen, in
  der Ziel-Lücke von Level 2 (Regel 8): Falls von 1.3–1.6 s auf ≤ 1.1 s (Ausnahme:
  östlich an E1 vorbei, 1.4 s — darüber ist man noch rettbar).
- **Par gemessen** (Regel 10): Level 1 49 s, Level 2 25 s (vorher 50/60 fest).

## Game-Feel-Runde (Plan 003, 27.09.)

Ziel: kein Tod und kein Tempo-Reset ohne eigenen Fehler in den ersten 90 s, jede
Entscheidung sichtbar, Level 1 führt Surf ein, bevor Level 2 es verlangt. Zahlen
vorher → nachher (Kritik-Werkzeuge unter `tools/critique/*`, Physik-Stand 27.09.
mit Smart-Auto-Hop und tempoabhängigem Cap — S3 misst gegen die finale Physik neu).

- **Erstkontakt** (beide Level): flache Auffangmulden (40 u, Rampe bis an die
  Landekante, `lib.catchDip`) unter Lauf-Lücke 1–3 bzw. den zwei Anlauf-Lücken
  statt Kill-Zone. Neue Probe `firstContact` (270 Läufe: W, Leertaste ab
  0.2–1.5 s gehalten, ±96, mit/ohne Shift, Blick auf den nächsten Knoten).
  `spaceholder.ts`: L1 21 % → 100 %, L2 8 % → 100 % ohne Tod; eine Fehlphase
  kostet ≤ 0.30 s (L1) bzw. ≤ 0.34 s (L2).
- **Stair-Clip:** die L1-Treppe ist Optik (`collide:false`), darüber liegt ein
  unsichtbarer Keil (`visible:false`, neu in LevelFormat) mit der Neigung der Rampe.
  `ramp-phase.ts` Treppe mit 320 u/s: vorher 30/30 hängen (24 u/s), jetzt 30/30
  in 1.42 s oben mit 312–320 u/s; `ramp.ts` StrafeBot 550 u/s oben 525–638
  (vorher 185–290, Minimum unterwegs 0–48, jetzt ≥ 495); Knoten 9 (Absprung
  Hop-Reihe) ~600 u/s (vorher ~330). `crouchwall.ts`: ohne Ducken weiter 0/80.
- **Hop-Reihe mit Gräben:** unter jeder Lücke bis zur Crouch-Kante 48 u tiefe
  Gräben mit Rampe zur nächsten Plattform statt `kill-row`; Probe
  `grundkursExits` (Boden ≤ 50 u unter jeder Lücke). `novice.ts` Hand 5°: 127
  Tode in der Hop-Reihe → 0, 6/8 → 8/8 im Ziel. Abstände × 0.94 (H7 × 1.04): mit
  voller Flugweite landete der perfekte RouteFollower jedes Mal ~20 u zu kurz
  (Grabenhang, 0.72 statt 0.74 s Flug), der Rückstand wuchs bis H6 auf ~230 u und
  jeder Lauf stand bei 320 u/s an der Crouch-Kante; jetzt 816 u/s, Hand 3° 8/8.
- **Crouch-Kante** (mat `duck`, neu): leuchtendes "↑C" plus Chevrons nach oben
  statt Warnstreifen, dunkle Lippe, an der Kante nur der Trim. Aus dem Anlauf
  ~9 Low-Res-px hoch (270p), an der Kante ~25.
- **Slalom-Nasen:** vor jeder Insel eine 40°-Schräge (begehbar) statt senkrechter
  Stirn — wer langsamer als geplant ist, sprang mit Auto-Hop am Inselanfang ab und
  prallte ~20 u zu kurz gegen die Stirn (Hand 2° 4/8 → 7/8 im Ziel). Lenken bleibt
  Pflicht (`slalomNeedsSteering` unverändert grün).
- **Surf-Rutsche statt Terrassen** (Abschnitt 6/7 unten). Sync 1.0 max 886 →
  1076 u/s, Launch ~1000 u/s.
- **Könner-Inseln** neu als Innenbahn Pad 1 → Wende (unten 4b) — Ziel nicht erreicht.
- **Medaillen und Par mit Spiel-Uhr** (Regel 10). `LevelFile.medals` (neu).
- **Level 2:** Bande am Ring-Außenrand, Ausfahrt markiert (Gold-Sektor, Chevrons,
  Tor mit Stufen-Lichtern), Landestufen farbcodiert, heller, zweites Leuchtband an
  der Ring-Unterkante (`underTrim`, neu), Ziel-Torbalken aus der Launch-Bahn
  (Validator-Regel "Deko auf der Flugbahn").

## Polish-Runde 2 (Plan 003, 27.09.)

Vier offene Punkte aus der Prüfung von Runde 1; Zahlen vorher → nachher im Plan
("Runde 2 — Level"), Fallen in fallen.md #72–#75.

- **Level 2, erste Surf-Berührung (S0).** Vorher fiel man von E1 ~420 u tief auf die
  S1-Flanke und war ohne Surf-Technik nach ~3 s tot (novice.ts: 55–114 Tode in 300 s,
  alle an S1). Jetzt beginnt die Kette mit S0 im selben Profil (768 breit, 60°): unter E1
  mit dessen 10°, dahinter 672 u mit 4° ("flacher": Zeit zum Ausprobieren); S1 schließt
  Stoß an Stoß an, S2 bis Ziel liegen an alter Stelle (71 u höher). Unter S0 eine
  **geschlossene Grube**: Fläche 32 u unter dem Fuß (wie die L1-Rutsche), Streifen 96 u
  (West) / 192 u (Ost) neben den Füßen, Quergang 128 u vor der Südkappe, Bande 128 u, 256 u
  unter den S1-Anfang verlängert, keine Kill-Zone. **Rückweg:** Durchgang am Nordost-Ende
  der Ostbande → Fuß-Plattform → Rampe 34° hinauf → Absatz bündig neben dem Vorfeld; Chevrons
  in Vorfeld-Cyan zeigen hin. Neue Proben `s0Catch` (12 W-Halter ab CP2, Blick ±30° oder auf
  den Knoten, mit/ohne Leertaste: 12 s ohne Tod) und `s0BackWay` (Grube → Vorfeld zu Fuß,
  ≤ 6.7 s); Selbsttest +2 Fälle. sync 1.0 (Spiel-Uhr) 15.92 → 15.86 s.
  **Verworfen** (jeweils am Ausfahrt-Raster, 600 Geradeaus-Läufe, gescheitert): schmalere
  50°-S0 (Linie 93 u versetzt → Surf-Achse kippt 11°, 45 Tode); 50°-S0 mit Drop auf 60°-S1
  (Stufe ~95 u an der Linie, Streifer am S0-Ende fliegen am S1-Fuß vorbei); Übergangsstück
  50° → 60° (Knickfläche fällt in Fahrtrichtung weg); Fläche, die die Flanke schneidet (fängt
  haltbare tiefe Linien ab, 23–35 Tode); Drops 64/96/128 u und S0-Längen 544–800 (1–7 Tode,
  je nachdem, welche Geschwindigkeit eine Drop-Kante streift). Grün ist ein kleines Plateau
  (672 u × 3°/4°, 640 × 4°, 608 × 2°) — nach Physik-Tuning zuerst neu rastern.
  **Nicht erreicht:** novice.ts-Bots nehmen den Rückweg nicht; sie bleiben in der Grube
  stehen (STAU nach 44–52 s, 0–1 Tode) — sie zielen auf den Knoten auf der Flanke über sich.
- **Level 1, Crouch-Kante.** Absprungzone als Bodenmarkierung auf H7: dasselbe Pixel-Glyph ↑C
  wie an der Wand, gefüllt, Trim-Farbe, 80–280 u vor der Wand (Fenster bei 320–450 u/s:
  67–243 u), in Laufrichtung gestreckt (25 u je Glyph-Zeile, 16 u je Spalte, `lib.marking`).
  Wandglyphen 8 statt 12 Texel, ein Chevron statt zwei je Seite. Cyan-Anteil 35 u vor der
  Wand 19.2 → 13.2 %, 86 u davor 11.8 → 6.9 %.
- **Level 1, Vorbeizieh-Whoosh.** Sechs kollidierbare Finnen (24 × 128 u, Leuchtkopf als Deko)
  außen neben den Slalom-Inseln, 28 u neben der Inselkante: Proben mit Geometrie < 160 u
  (sync 1.0) 1.3 → 2.9 %, Slalom 0 → 19 von 295, nächster Vorbeiflug 123 u
  (`tools/levels/whoosh.ts`). Die Whoosh-Probe sieht nur Kollisions-Geometrie.
- **Level 2, Spawn.** ambientSky #3b2d80 → #5a4abc, Mond höher (sunDir.y 0.5) und heller
  (#bce2ff): unteres Bilddrittel Luma 0.182 → 0.226, Anteil Luma < 0.1 45.5 → 32.7 %.

## Level-Werkzeug für Plan 007 (level-tools, 28.09.)

Vorbau für L3 (Surf-Gabel), L4 (Turm) und die Lektionen, damit Phase 2 in getrennten Dateien arbeitet.
Alles gemessen gegen die Phase-0-Physik (eingefrorene Kopie, weil der Movement-Strang parallel umbaut):

- **lib.ts:** `SurfPath` (Kurven auf Gehrung, Halbrampen, Grat-Bande, `riderPos` für die achsparallele
  Hull), `dropFrom` (**Endtangente**: die Folgerampe übernimmt die Fahrtrichtung am Ende, nicht die des
  letzten Sehnenstücks — die L3-Kehre hat damit 180.000° statt 174.375°), `catchBand`, `surfPad`
  (Checkpoint an Pfaden, beliebiger yaw), `Helix` (Wendel, Bande mit `boardRisers`, an Achsen als Box),
  `railing`, `placeNodes` (Knoten per Hull-Trace), `surfCheckpoint` (gerade Ketten, Achse wählbar),
  `chainKillZones`, `finishAfterLaunch`, `killTiles`. **Nachweis:** Die Prototypen L3 und L4 lassen sich
  mit diesen Bausteinen byte-gleich nachbauen (alle vier JSONs inkl. gemessener minSpeed und Medaillen),
  L3 mit dem Prototyp-Modus `yawFrom: 'piece'`. L1/L2 bauen byte-gleich.
- **physics.ts:** `resumeIndex` prüft die Höhe (Knoten-y in [Trigger − 8, Trigger-Oberkante],
  `nodeInTrigger`); `SpeedCurve`-Cache über ALLE Config-Felder (`configKey`); `withRoute(level,
  'route' | 'safeRoute')`; `timedRun(…, jitter)`, `jitterMedian`, `START_JITTERS`.
  L4-Prototyp ohne Schatten-Knoten-Workaround: CP3-Wiedereinstieg vorher Knoten 12 (y 310, eine Etage
  tiefer), CP3→CP4 6/8 Modelle; jetzt Knoten 43 (y 1088), alle Abschnitte ab CP3 8/8.
- **build.ts:** Registry `LEVELS` (level1–level4, Stubs liefern null) und Lektionen
  (`tools/levels/training/index.ts`). `levels:build -- <id>` schreibt nur diese Datei, **nie index.json**.
- **validate-levels.ts:** Gabeln, Lektionen, Crouch-Kanten, Schatten-Knoten (Regeln 11–13 unten);
  `ValidateOptions.probes` für Proben außerhalb der id-Weiche; `levels:check -- level3` prüft auch eine
  Datei, die (noch) nicht im Index steht. Ohne safeRoute/training ist der Bericht zeilengleich zu vorher.
- **designProbes.ts:** level3/level4 rufen `probes/level3.ts`/`level4.ts` (Stubs); die Bausteine sind
  exportiert (`autoHopRaster`, `wHolder`, `dropToGround`, `band`, `LATERALS`, `groundTag`, …),
  `finaleReserve(…, yawDeg)` misst entlang einer beliebigen Flugrichtung, neu `helixBoard(Probe)`
  (Geradeaus-Hüpfer über eine Wendel: Tode, Abstürze > 150 u — auch noch im Fall —, Luft-Hänger).
- **Selbsttest 33/33** (vorher 25/25): Crouch-Kante < 64 u, Bande-Lücke und Schatten-Knoten an einer
  Turm-Attrappe, drei Lektions-Fehler; dazu Turm (mit Physik) und Lektion unverändert fehlerfrei.
  Nimmt man `nodeInTrigger` die Höhe, wird die saubere Turm-Attrappe rot.

## Physik-Grundlage (Source-Units, Default-Config)

| Größe | Wert |
|---|---|
| Luftzeit flach | 0.755 s (v0 = 301.99, g = 800) |
| Luftzeit bei Landung h tiefer | t = (v0 + √(v0² + 2gh)) / g → 64 u: 0.93 s, 128 u: 1.06 s, 192 u: 1.17 s |
| Crouch-Jump | Füße +18 u in der Luft → Kanten bis 75 u (normal 57); 64-u-Kante im Fenster 0.21…0.54 s (`ballistics.riseWindow`) |
| Lückenmaß | Flug = Absprungpunkt bis Landekante; die Hull (32 u) trägt je 16 u über die Kante |
| Reserve | Jede geplante Lücke hält ≥ 10 % Reserve bei `minSpeed` des Absprungknotens |
| Sprint-Kantensprung | 320 u/s × 0.755 s + 32 = 274 u flach; mit 10 % Reserve **252 u** — die Obergrenze jeder Ketten-Lücke |
| Überschieß-Band | `ballistics.OVERSHOOT` = 1.2 × Plan-Tempo (der perfekte Strafer liegt ≤ 1.2 × über dem 0.85-Band) |

Strafe-Kurven ab Sprint (320 u/s), Tempo nach Hop 1/2/4/6/10/15/20:

| Modell | 1 | 2 | 4 | 6 | 10 | 15 | 20 |
|---|---|---|---|---|---|---|---|
| perfekt (sync 1.0) | 397 | 462 | 570 | 661 | 812 | 968 | 1103 |
| sync 0.85 (unteres Plan-Band) | 365 | 419 | 500 | 556 | 679 | 798 | 913 |
| Hand 2° | 379 | 430 | 499 | 549 | 624 | 666 | 710 |
| Hand 3° | 364 | 402 | 442 | 464 | 513 | 506 | 529 |

### Designregeln

1. **Hop-Ketten laufen auf Rhythmus, geplant aus der Sim.** Plattformmitten
   liegen eine Sprungweite (`v · t`) auseinander; `v` = Mitte aus perfektem und
   0.85-Strafer. Die Plattformtiefe ist die Toleranz für "schneller/langsamer als
   geplant"; bei 1.2 × Plantempo hält jede Landung (Validator: Überschieß-Band).
   **Präzisionsziele** (Flag `precision`) sind vom Band ausgenommen — derzeit gibt
   es keine mehr: die Crouch-Kante hat jetzt für jedes Tempo eine Absprungzone,
   der Absprungblock fängt das ganze Band.
2. **Jede Ketten-Lücke ist per Stop-and-Go machbar** (≤ 252 u, Sprint von der
   Kante); wird der Rhythmus schneller, wachsen die **Plattformen**, nicht die
   Lücken (`ROW_GAP` = 236 u). Die erste Lücke nach einem Checkpoint ist klein.
   Wer langsam ist, läuft vor und springt an der Kante — der RouteFollower kann
   das jetzt auch (sync 0.7 schafft beide Level).
3. **Jeder Checkpoint geht aus dem Stand weiter** — geprüft mit Physik: ab jedem
   Checkpoint-Spawn fährt der RouteFollower mit fünf Modellen (sync 1.0/0.8 Pflicht,
   Hand 2°/3° und sync 0.7 Info) bis zum nächsten Checkpoint, bei Surf-Abschnitten
   zusätzlich ein Grundtechnik-Surfer. Spawns stehen mitten auf der Fläche (jede
   Hull-Ecke trägt — Validator-Warnung sonst).
4. **Keine Reibungsfallen an Speed-Stellen.** Begehbare Landeflächen direkt vor
   großen Sprüngen sind tief genug, dass man sie trifft und sofort weiterhüpft.
5. **Surf-Übergänge sind Drops.** Die Folgerampe beginnt 96 u *vor* dem Ende der
   vorigen, auf derselben Achse, 128 u tiefer: im Überlappungsstück liegt sie
   komplett unter der alten Flanke. Wer (in jeder Tiefe, mit jedem Tempo) vom
   Ende abfliegt, fällt auf ihre Flanke — nie gegen ihre Stirnseite.
6. **Surf-Ketten Stoß an Stoß.** Seit den Kanten-Bevels ist jede Fuge exakt
   (vorher Phantom-Keile, fallen.md #31); `lib.surfChain` baut ohne Überlappung
   und ohne konvexen Versatz (die ~20-u-Stufe kostete Tempo). Surf-Raster:
   0 Nahtstopps.
7. **Kein Todesband an Pflicht-Übergängen — auch mit Auto-Hop.** Auto-Hop ist
   Default: wer die Leertaste hält, springt dort ab, wo er zuletzt gelandet ist,
   je nach Hop-Phase bis zu einer Sprungweite vor der Kante. Über einer echten
   Lücke fällt dann *immer* irgendeine Phase vor die nächste Stirnwand (fallen.md
   #46). An Übergängen, die jeder nehmen muss, liegt deshalb unter der Lücke eine
   Auffangfläche (Level 1: Mulden unter Lauf 1–3, Gräben unter der Hop-Reihe,
   Auffangfläche unter der Rutsche; Level 2: Mulden unter dem Anlauf, Vorfeld
   zwischen Ring und E1, Bande am Ring) oder es gibt keine Lücke (Level 1: Kehre →
   Wende).
   Geprüft mit Auto-Hop-Raster (`designProbes`): ab dem vorigen Knoten und dem
   Absprungknoten, Sprint bis 1300/1500 u/s × seitlich ±96 u, Leertaste gehalten,
   ohne Strafen. Lücken *in* Prüfungen (Hop-Reihe, Kehre, Slalom, Ring-Innenbahn)
   bleiben Lücken — dort ist Timing die Aufgabe.
8. **Kill-Zonen 250–450 u unter jedem Abschnitt** statt Fall bis zum globalen
   killY: ein Fehler kostet ≤ ~1 s Fall. Gestuft, wo Abschnitte fallen (Level 1:
   neben der Rutschen-Bande in 512er-Stücken 300 u unter der Auffangfläche). Neben Surf-Rampen
   liegen Zonen 32 u außerhalb des Fußes und 64 u darunter, in Stücken ≤ 512 u mit
   lokaler Fußhöhe — wer dort ist, kommt nie zurück. Der Validator prüft ≥ 128 u
   Abstand zu jeder Fahrfläche darüber und dass kein Route-Knoten/Spawn drin liegt.
9. **Respawn-Pads in Surf-Ketten sitzen auf dem Grat der Folgerampe**, bündig ab
   dem Ende der vorigen, als Keil ohne senkrechte Stirn (wer hoch fährt, rollt
   darüber). Vom Pad nach vorn ablaufen = ~100 u Drop-In auf die Flanke, die man
   die ganze Zeit vor sich sieht. Luft-Trigger nur über dem Rampen-Grundriss und
   bis knapp über den Fuß: wer daneben oder darunter fällt, bekommt den
   Checkpoint nicht mehr.
10. **Par und Medaillen sind gemessen — mit der Spiel-Uhr** (`physics.timedRun`:
   RouteFollower + RunState, Timer ab Verlassen der Startzone, Tode inklusive,
   Respawn wie `Game.respawn`), Median über die Validator-Seeds: Bronze =
   3°-Hand × 1.05, Silber = 2°-Hand × 1.05, Gold = sync 1.0 × 1.10,
   **VELOCITY = sync 1.0 × 1.05** (Top-Medaille, 28.09.), author = sync 1.0
   (Entwickler-Zeit, keine Medaille mehr, nur Referenz im Ergebnis); Par = Bronze
   auf ganze Sekunden.
   *Warum × 1.05 für VELOCITY:* halber Weg zwischen Gold (+10 %) und Autor. Die
   naheliegende Alternative "beste 1°-Hand" taugt nicht als Maß — die Zielrausch-
   Bots streuen zu stark und verlieren bei Tempo die Kurve (fallen.md #70):
   `npx tsx tools/levels/medalProbe.ts` (Spiel-Uhr, Median Seeds 1–8) misst auf L1
   1°-Hand 25.8 s, 0.5°-Hand 26.7 s, sync 0.95 27.2 s — alle LANGSAMER als Gold
   (24.5). Auf L2 schlagen dieselben Modelle einzelne Male sogar die Autor-Zeit
   (1°-Hand 15.3 s in einem Seed), weil der RouteFollower dort nicht optimal fliegt.
   Ein Mensch korrigiert anders als diese Modelle; die Ideallinie + 5 % heißt: die
   Route sauber fliegen und ~1 s (L1) bzw. ~0.8 s (L2) Fehler erlaubt — schwerer als
   Gold, für sehr gute Spieler erreichbar. Werte: L1 **23.4 s**, L2 **16.7 s**.
   Build und Validator prüfen bronze > silver > gold > velocity ≥ author. Vorher maß build.ts ab Spawn
   (~1.3 s zu lasch) und nur Läufe ohne Tod. Gegenprobe: `novice.ts` (eigene
   RunState-Schleife) misst dieselben sync-1.0-Zeiten auf 0.02 s genau. Der
   Validator prüft bronze > silver > gold > author und warnt, wenn Par unter der
   3°-Hand (Spiel-Uhr) oder über 1.25 × davon liegt. Die VELOCITY-Medaille schaltet
   Kosmetik frei (Plan 005: L1 → Neon-Handschuh, L2 → Dose) — eine Änderung von
   `velocity` verschiebt also auch Freischaltungen (bereits verdiente bleiben).
   **Plan 007:** Gold/VELOCITY/Autor sind der Median über **49 Start-Jitter**
   (`physics.START_JITTERS`: Zellmitten eines 7 × 7-Rasters im Kasten ±16 u quer × ±1° Blick bis zum
   ersten Absprung; die Mitte ist der alte Einzellauf), Bronze/Silber werden auf `safeRoute` gemessen,
   falls vorhanden. Der perfekte Bot ist deterministisch, aber chaotisch. Plan 007 sah 5 Starts (Mitte +
   Ecken) vor — die Ecken sind keine faire Stichprobe (L1, Phase-0-Physik: alle vier im langsamen Zweig,
   Median 26.72 s; Repo-Physik: zwei zu zwei, 22.27 s). 49 statt 25:
   auf dem ruhigen L2 schwankte der Median über 5 × 5 / 7 × 7 / 9 × 9 um 0.19 s (16.01/16.20/16.15 s);
   Kosten ≈ 0.4 s je Level.
   **Der Median trägt nur, wenn der Bot EINEN Zweig fährt.** L1 zerfällt in zwei (Bonk an der
   Crouch-Kante: der langsame Zweig springt 16 u vor der Wand ab, 548 → 86 u/s, und verliert beim Neustart
   CP2 → CP3 rund 2.5 s). Phase-0-Physik, 7 × 7: 33/49 bei 21.9–23.9 s, 16/49 bei 25.9–30.7 s; Median
   über 5 × 5/7 × 7/9 × 9/11 × 11 = 23.16/23.02/22.61/22.88 s, das 25-%-Quantil stabil 22.24 — der alte
   Einzellauf (22.24) war also **kein** Glückstreffer. Repo-Physik (Movement in Arbeit): nur noch 12/49 im
   schnellen Zweig (21.7–22.3 s), Median 25.2 s stabil im **langsamen** Zweig, das 25-%-Quantil springt
   22.00 ↔ 24.51. Keine Kennzahl ist auf einem zweigeteilten Level belastbar — deshalb melden
   `physics.jitterBranches` (Lücke ≥ 4 % des Medians zwischen benachbarten Zeiten, je Seite ≥ 10 % der
   Starts; L2 und der L4-Prototyp: ein Zweig), build.ts (laute Warnung, am Ende wiederholt) und
   levels:check (Warnung, mit dem Abschnitt des größten Verlusts) den Zerfall. **Zu reparieren ist das
   Level**, nicht die Kennzahl. Mit 49 Starts (Phase-0-Physik) gegen den Einzellauf: L1 Gold/VELOCITY/Autor
   24.5/23.4/22.25 → **25.4/24.2/23.03 s** (zweigeteilt, Warnung), L2 17.5/16.7/15.86 → **17.9/17.1/16.2 s**;
   Bronze, Silber, Par gleich. Die committeten JSONs tragen noch die alten Werte — Phase 3 baut alle
   Medaillen neu.
11. **Gabeln haben eine sichere Linie** (`LevelFile.safeRoute`, Plan 007): gleicher Start und gleiches
   Ziel wie `route`. Der Validator prüft beide Linien (Berichtszeilen `[route]`/`[safeRoute]`): Surf-Raster,
   Surf-Übergang bei 320 u/s und Respawn-Surfer sind auf safeRoute Fehler, auf route Warnung (die schnelle
   Linie darf riskant sein); RouteFollower sync 1.0/0.8 sind auf beiden Pflicht. Bronze/Silber/Par kommen
   von der sicheren Linie, build.ts warnt, wenn der perfekte Bot auf safeRoute schon VELOCITY schafft.
   L3-Prototyp: nach der alten Regel 1 Fehler auf der schnellen Linie (inner1a, 1400 u/s), jetzt 0 Fehler.
12. **Crouch-Kanten ≥ 66 u** (Plan 007 A6). Ohne Ducken reicht es heute (Repo-Physik, `ledgeStep` 5) bis
   **≈ 63.8 u**: Sprung 57 + Auto-Hop-Landehöhe bis 1.75 u (der Boden-Trace fängt 2 u über dem Boden,
   von dort springt der nächste Hop) + Kanten-Assist 5. Die alte Regel "≥ 64 u (57 + 5 + 2)" vergaß die
   Landehöhe — eine 64-u-Kante hat 0.2–0.5 u Reserve, ein Tuning-Schritt kippt sie still. Der Validator
   prüft jeden Knoten mit `crouch` zweifach: physikalisch im Level (W + Leertaste gehalten, nie geduckt,
   Anlauf 16–400 u vor der Wand, Sprint bis 1.2 × Plan, Linie ±48 — **0 Erfolge** Pflicht, sonst Fehler)
   und gegen die Reichweite der Config (`noDuckReach`: Attrappe Boden + Wand, Bisektion auf 0.05 u) —
   **Reserve < 2 u ist eine Warnung**. Phase-0-Physik (ohne Kanten-Assist) reichte 58.7 u. L1 (64 u) hat
   in der Repo-Physik 0.5 u Reserve → Warnung; neue Kanten (L4) gleich auf ≥ 66 u.
13. **Gestapelte Level: Checkpoint-Trigger in der Höhe begrenzen.** Liegen Knoten einer anderen Etage im
   Trigger, setzt der Wiedereinstieg nach einem Respawn beim ersten Durchgang an — Bots, Spiel-Uhr und
   Proben fahren dann die falsche Etage ab. Der Validator meldet "Schatten-Knoten", wenn der
   Wiedereinstieg nicht zum Durchgang am Spawn gehört. Knoten unter einem Podest (untere Umdrehung) sind
   erlaubt, seit `resumeIndex` die Höhe prüft — der Workaround `dropShadowNodes` (L4-Prototyp) entfällt.

---

## 01 GRUNDKURS — "Lauf. Spring. Strafe."

Dämmerung, Magenta/Orange, Trims Cyan. Hinweg nach Norden in die tiefe
Sonne, 180°-Kehre, Rückweg nach Süden, Surf-Rutsche ins Ziel. **Par 37 s,
Medaillen 36.2 / 30.4 / 24.5 / VELOCITY 23.4 / Autor 22.25 s** (Stand 28.09.; vorher Par 39 s,
38.5 / 32.2 / 24.5 / 22.25) (Spiel-Uhr; RouteFollower ab Spawn, Median
Seeds 1–8: sync 1.0 25.1 s, sync 0.8 29.0 s, Hand 2° 33.6 s, Hand 3° 40.1 s).

```
  N (-Z) ↑            x ≈ −2400 (Rückweg)                    x = 0 (Hinweg)
                          23 ▪  22 ▪  21 ▪  20 ▪  19 ▪
                      24 ▪          ◇   ◇   ◇          ▪ 18      KEHRE 180°, R 1202, y 192
                         │       (Monolith)            │         ◇ Könner-Inseln
                      25 ═══ CP3 Wende (lückenlos)    ═══ 17     CP2 Kante (y 192)
                          ▯ S1                         ▓▓▓       64-u-Wand, "↑C" (mat duck)
                            ▯ S2                      □□□ 16     H7 bis an die Wand (y 128)
                          ▯ S3     SLALOM              ▭ 15      H6 (304 tief)
                            ▯ S4   Inseln ±112         ▫ 14      HOP-REIHE
                          ▯ S5     528 lang, 48 Lücke  ▫ 13      Lücken 126 → 228
                            ▯ S6                       ▫ 12
                         ╱╲ RUTSCHE 10°, 768 breit     ▫ 11      (Gräben unter der Reihe)
                        ║╱╲║ Bande, Auffangfläche      ▫ 10
                        ║╱╲║ 64 u unter dem Fuß        ═══ 9     CP1 Plateau (y 128)
                        ║╱╲║                           ▙▟        Treppe (Optik + Clip) | Rampe
                        ║ ╱╲ Kicker 3° / −8°           ■■        Lauf 3 (Lücke 144, Mulde)
                        ║    Flug ~1000 u/s            ■■        Lauf 2 (Lücke 128, Mulde)
                        ║                              ■■        Lauf 1 (Lücke 96, Mulde)
                         ▣▣▣ ZIEL (2048 tief, Prallwand) ▣▣      START (y 0), Blick Nord
```

| # | Abschnitt | Fähigkeit | Verlangt | Zweck |
|---|---|---|---|---|
| 0 | Start → Lauf 1–3 | Laufen, Springen an der Kante | 250 u/s, Lücken 96/128/144 | Erstkontakt: Sprünge, die jeder schafft. Vier Leucht-Chevrons (mat `marking`) vor dem Spawn. Unter jeder Lücke eine Mulde (40 u): wer mit gehaltener Leertaste zu früh abspringt, verliert ≤ 0.3 s statt zu sterben. |
| 1 | Treppe \| Rampe → Plateau | Stufen (16 u) hochlaufen, Rampe hochhüpfen | — | Stufen ≤ 18 u sind laufbar; über der Treppe liegt ein unsichtbarer Clip-Keil (Source "stair clip"), im Hop ist sie so gleichwertig zur Rampe. **CP1.** |
| 2 | Hop-Reihe H1–H6 | Bunnyhop-Kette, erste Strafes | Plan-Tempo 391 → 614; ab Plattformmitte 279/341/395/435/387 u/s | Lücken wachsen sichtbar (126 → 228), alle ≤ 236: Stop-and-Go mit Sprint klappt. H6 ist 304 tief, damit die Lücke zu H7 klein bleibt. |
| 3 | H7 → Crouch-Kante | Crouch-Hop an der 64-u-Wand | für **jedes** Tempo 320–778 u/s gibt es auf H7 eine Absprungzone ≥ 48 u | H7 reicht bis an die Wand. Zu früh/zu spät: man prallt ab und landet wieder auf H7 — kostet Tempo, nie das Leben. Früher lag hier eine Grube, aus der ohne neuen Anlauf kein Weg zurück auf die Kante führte (≥ 440 u/s nötig). Plan-Knoten in der Mitte des Fensters (trägt 479–778). Die Zone ist auf H7 markiert: ↑C-Glyph am Boden, 80–280 u vor der Wand, in Laufrichtung gestreckt. **CP2.** |
| 4 | Kehre (7 Pads, 180°) | Air-Strafe-Kurven, einseitiges Strafen | Sehnen = Sprungweiten des 0.85-Bands 624 → 781; Pad-Tiefe = Sehne − 120 | Prüft das Kurven-Strafen, nicht die Lückenweite (Lücken ~120 u). Der perfekte Strafer landet ≤ 1.2 × weiter hinten auf dem tiefen Pad, Langsame vorn. Die Wende (CP3) schließt lückenlos an das letzte Pad an: mit Lücke (215, auch 120 u) fiel jeder langsame Hop vorn vom letzten Pad vor die Wende. |
| 4b | Könner-Inseln (Innenbahn Pad 1 → Wende) | Präzision und enges Kurven-Strafen bei Speed | 5 Inseln 160², Sprünge à 490 u, geplant für 620 u/s mit Reserve (braucht 573) | Bézier-Bahn, beginnt in Laufrichtung an Pad 1 und endet in Slalom-Richtung an der Wende (eine gerade Sehne verlangt an Pad 1 ~80° Knick). Monolith ≥ 520 u neben der Bahn. **Ziel verfehlt:** Probe `expertIslands` — Hand 1° 3/6 durch, im Mittel 1.9 s langsamer, perfekter Bot gleich schnell. Gemessen außerdem: gerade Sehnen bis Pad 5/6/7 und Griff 0.1–0.4 — nie schneller als die Kehre; der RouteFollower bremst auf 160er-Inseln vor jeder Richtungsänderung. Mensch-Playtest entscheidet. |
| 5 | Wende → Slalom (6 Inseln) | A/D-Wechsel, Lenken in der Luft | Tempo frei (Plan 807) | Zwei Spalten (±112, 176 breit, 48 u Spaltenabstand > Hull). Jede Insel beginnt, wo die vorige endet, und ist so lang wie ein schräger Hop beim Plan-Tempo (528 u). Geprüft: 115 Geradeaus-Läufe (Versatz ±176, 469–968 u/s) scheitern alle. Außen neben jeder Insel eine kollidierbare Finne (Vorbeizieh-Whoosh, 28 u neben der Kante). **CP3.** |
| 6 | Surf-Rutsche | Erster Surf: in die Rampe drücken, Linie halten | jedes Tempo | Surf-Rampe wie S1 in Level 2 (768 breit, 60°-Flanken), beginnt unter der letzten Slalom-Insel (keine Stirnfläche), fällt 10° über 1900 u hinter der Insel. Ihr Fuß liegt 64 u über einer durchgehenden Auffangfläche (Sockel darunter, seitlich Bande 128 u hoch): wer W hält und abrutscht, hüpft auf ihr bergab ins Ziel — langsamer, nie tot. Probe `chuteCatch`: 250 Läufe ab der letzten Insel (320–1300 u/s, ±96; geradeaus ohne Surfen und W-Halter mit Blick auf den nächsten Knoten) alle im Ziel, langsamster W-Halter 5.2 s. Ohne Bande flog jeder dritte Geradeaus-Läufer seitlich herunter (Selbsttest). Länge gemessen (`tools/levels/sweepChute.ts`): 1600 u → Launch 926 u/s, 1900 u → 1004 u/s; ein 20°-Knick war langsamer (der Bot verliert an der konvexen Kante den Kontakt). Knotenlinie taucht von 240 auf 440 u unter den Grat. |
| 7 | Kicker → Flug → Ziel | Speed tragen | Launch unteres Band ~730 u/s | Kicker 256 u mit 3°, dann 256 u mit −8°: Abflug schräg nach oben, ~1.3 s Flug über 1000 u/s. Ziel 2048 tief mit Prallwand, flach und bündig an die Auffangfläche; der Ziel-Trigger ist niedrig (240 u): der Lauf endet mit der Landung, nicht über der Zielkante. |

Speed-Dramaturgie: 250 → 320 (Sprint) → ~600 (Rampe/Hop-Reihe) → 700–800 (Kehre) →
850+ (Slalom) → 1000+ (Rutsche, Flug ins Ziel).

Kill-Zonen: `kill-start` und `kill-row` (tief unter Mulden und Gräben),
`kill-curve`, `kill-slalom` (bis zum Beginn der Auffangfläche), `kill-chute-l/r*`
neben der Rutschen-Bande 300 u unter der Fläche; killY −1700.

---

## 02 SCHLEIFE — "Speed ist eine Entscheidung."

Nacht, Acid-Grün/Cyan/Violett, kalter Mond im Norden. Eine kurze Hop-Linie auf
einen überhöhten Bhop-Ring (Velodrom); die Ausfahrt ist schon im ersten
Durchgang offen und eine Linie mit Tempo-Stufen; danach eine Surf-Kette **ohne
einen einzigen Bodenkontakt** bis zum Launch ins Ziel — die erste Rampe (S0) hat
eine Auffanggrube mit Rückweg. **Par 22 s, Medaillen 21.4 / 18.7 / 17.5 / VELOCITY 16.7 / Autor 15.86 s**
(Spiel-Uhr; RouteFollower ab Spawn, Median Seeds 1–8: sync 1.0 17.2 s, sync 0.8 18.9 s,
Hand 2° 19.1 s, Hand 3° 21.7 s). Himmel, Fog und Licht heller (Spawn-Bild: Anteil unter
Luma 0.1 von 72.9 % über 45.5 % auf 32.7 %).

```
  N (-Z) ↑            x ≈ 1168 (Grat) · 1344 (Ausfahrt-Linie)
                         ▣▣▣▣ ZIEL (1000 u unter dem Grat) ▌Prallwand
                           :   Lücke abgeleitet (s. u.), darunter kill-gap
                          ╱╲ −8°   S4 Kicker: 10° → 25° → 12° → 4° → −8°
                          ╱╲ 25°   (Stoß an Stoß, Kanten-Bevels)
                     CP4 ◭╱╲ 10°   ← Luft-Trigger um den Drop, Keil-Pad auf dem Grat von S4
                          ╱╲  S3  1280 u, 10°
                     CP3 ◭╱╲ ─ Drop: Folgerampe beginnt 96 u vor dem Ende, 128 u tiefer
                          ╱╲  S2  1280 u, 10°      ← Stufe 3 (ab ~1040) landet hier
                          ╱╲ ─ Drop
                          ╱╲  S1  352 u, 10°       ← Stufe 2 (ab ~840) landet hier
                     ┆▒▒ ╱╲ ▒▒┆  S0  672 u, 4° (Stoß an Stoß); Grube 32 u unter dem Fuß,
                     ┆▒▒ ╱╲ ▒▒┆      Bande, Rückweg ┆ (34°) aufs Vorfeld  ← ab ~600 hier
                   CP2  ∩ ◿ E1 (10°-Insel, 256 × 384), S0 beginnt schon darunter
                         ▭▭ Vorfeld (y −40, 320 breit) — schließt die Lücke Ring → E1
          .--~~~~~~~~--. ↑ T0 (r 1456, φ ≈ 23°)
        .'  ¦        ¦ '.   Innenbahn-Lücken bei φ 292–304° und 326–338°
       /   RING R 1280     \    Außen-/Innenbahn à 256, 10° nach außen überhöht,
      |    ( Monolith )     |   64 Segmente, jedes 4. leuchtet grün,
       \                   /    gegen den Uhrzeigersinn
        '.     CP1 ▭     .'
  ▣▣ START ─ ▭ ─ ▭▭▭ → (y 160, zwei Lücken 144/176, Sprung auf den Ring)
```

| # | Abschnitt | Fähigkeit | Verlangt | Zweck |
|---|---|---|---|---|
| 0 | Start → Hop-Linie → Ring | Laufen, erste Hops, Absprung auf den Ring | 320 u/s | Zwei Lücken (144/176) statt 1512 u geradem Sprint (4.6 s ohne Entscheidung). Tangentialer Einstieg: man landet in Fahrtrichtung. **CP1** direkt hinter der Landung auf dem Ring. |
| 1 | Ring (Velodrom), erster Durchgang | Einseitiges Kurven-Strafen, Linienwahl | Plan 365 → 527 über ~0.4 Runden | Bande am Außenrand (80 u, offen am Anflug φ 225–270° und an der Ausfahrt φ 11–45°): wer W + Leertaste hält, lenkt in der Luft nicht und flog tangential vom Ring (`novice.ts` W+Space: 54 Tode, der erste nach 12 s → 0, CP2 nach < 30 s). Innenbahn ~1 s pro Runde kürzer, aber mit zwei getimten Lücken (~200 u); Außenbahn lückenlos. Die Ausfahrt T0 ist schon im ersten Durchgang offen — jede weitere Runde ist eine Entscheidung für Tempo (höhere Stufe). Vorher erzwang die Route 1.25 Runden (50–60 % der Levelzeit ohne Entscheidung). |
| 2 | Ausfahrt T0 → Vorfeld → E1 → Surf | Tempo tragen, Stufe wählen | jedes Tempo | Sichtbar: Außenbahn-Sektor φ 11–34° in Checkpoint-Gold ohne Bande, drei Gold-Chevrons Richtung T0, Lichtbogen darüber mit drei Stufen-Lichtern (mat `light`: unten Magenta = S1 ab ~600, Mitte Violett = S2 ab ~980, oben Weiß = direkt in CP3 ab ~1260); Landestufen in denselben Farben (Vorfeld Cyan, E1 Gold, S1 Magenta, S2 Violett). Vorfeld (y −40) zwischen Ringrand und E1: mit Auto-Hop fiel vorher je nach Phase jeder vierte bis sechste Geradeaus-Lauf (500–600 u/s) vor die 131 u hohe E1-Stirn. S0 beginnt unter E1 (First 24 u unter E1): wer westlich an E1 vorbeifällt, landet auf einer Flanke statt an der Südkappe. **CP2** auf E1 (Trigger 708 u hoch — Überflieger bekommen ihn auch). |
| 2b | S0 (Einstiegsrampe) | Erster Surf in L2 ohne Todesstrafe | aus dem Stand ab CP2 | Beginnt unter E1 (10°), dahinter 672 u mit 4°; Profil wie S1, S1 schließt Stoß an Stoß an. Darunter eine geschlossene Grube 32 u unter dem Fuß (Bande, Quergang vor der Südkappe, reicht 256 u unter S1) und ein Rückweg über eine 34°-Rampe aufs Vorfeld neben E1. Wer nicht surft, landet in der Grube statt im Void (Proben `s0Catch`, `s0BackWay`). |
| 3 | S1 → S2 → S3 | Surfen, Linie halten, Drops | aus dem Stand ab CP2 | Achsen fallen 10°: Speed aus Höhe. Drops ohne Stirnfläche (Regel 5). Rampen 768 breit (60°-Flanken, 665 u hoch): jede Tiefe zwischen Grat und Fuß trägt. |
| 4 | Drop S2 → S3, S3 → S4 | Checkpoint im Flug | — | **CP3/CP4** sind Luft-Trigger um den Übergang (nur über dem Rampen-Grundriss, unten bis knapp über den Fuß). Respawn auf einem Keil-Pad auf dem Grat der Folgerampe, bündig ab dem Ende der vorigen (Regel 9): nach vorn ablaufen = ~100 u Drop-In auf die sichtbare Ostflanke (vorher schwebte das Pad über der Flanke, verdeckte sie und der Drop-In fiel ~600 u blind). |
| 5 | S4 Surf-Kicker → Launch | Linie halten, steiler Fall, Abflug | aus dem Stand ab CP4 | Kein Bodenkontakt, kein Sprung-Timing, keine Reibungsfalle. Stücke Stoß an Stoß. |
| 6 | Launch → Ziel | Speed tragen | Lücke so, dass das untere Band am Launch (90 % des langsamsten gemessenen Abflugs) 10 % Reserve hat | 1000 u unter dem Grat, ~1.3 s Flug, 1700 u tiefe Zielplattform mit Prallwand: auch 1500+ u/s landen. |

### "Speed ist eine Entscheidung" — was sie wirklich ist

Die Ausfahrt ist *eine* Linie mit Stufen; wer eine Stufe verfehlt, landet auf
der darunterliegenden (Probe `exitTiers`: 600 Auto-Hop-Läufe ab dem letzten
Ring-Knoten und ab T0, 320–1500 u/s, seitlich ±96, alle bis CP3). Linien ab T0
(geradeaus, Auto-Hop, ohne Strafen; seit S0): Vorfeld → E1 → S0 ab 320, Vorfeld → S0
ab 600, Vorfeld → S1 ab 840, Vorfeld → S2 ab 1040, über S0–S2 hinweg in den
CP3-Trigger ab 1300 u/s.

Die Ausfahrt ist nach ~0.4 Runden offen. Eine volle Zusatzrunde kostet mehr Zeit,
als eine höhere Stufe spart — die Entscheidung ist deshalb nicht Zeit gegen
Zeit, sondern: *jetzt raus mit dem Tempo, das man hat*, oder eine Runde mehr für
den Flug über E1/S1 (und die Musik auf voller Energie). Wer auf Zeit fährt,
entscheidet stattdessen die Linie im ersten Durchgang: Innenbahn mit zwei Lücken
oder sichere Außenbahn.

### Die Ziel-Lücke ist abgeleitet

`measureSurfSpeeds` misst beim Bauen das Tempo an jedem Surf-Knoten: aus dem
Stand ab jedem Checkpoint (Grundtechnik-Surfer mit Blick 0°/+2°, die 3°-Hand,
die die Knotenlinie hält) und für jeden Einstieg des Surf-Rasters. `minSpeed`
der Surf-Knoten = 90 % des Langsamsten; die Lücke hinter dem Launch hat mit
diesem Tempo 10 % Reserve. Den langsamsten Abflug (~410 u/s) setzt der
Raster-Einstieg 50 u unter dem Grat mit bremsendem Blick: er drückt sich auf
den (mit Kanten-Bevels begehbaren) First und verliert durch Bodenreibung Tempo.
Folge: ~490 u statt früher 888 — das Finale ist ein Belohnungsflug, die
Tempo-Entscheidung fällt an der Ausfahrt. Wer die Lücke wieder größer will,
muss bewusst entscheiden, welche Einstiege zählen (fallen.md #42). Wer zu kurz
fliegt, stirbt knapp unter der Zielkante (`kill-gap`) statt 300 u tiefer.

---

## Route (Ideallinie für den RouteFollower-Bot)

`LevelFile.route` ist die Linie eines guten, nicht perfekten Spielers. Die
Bedeutung steckt in Flags (`LevelFormat.RouteNode`), nie in Notiztexten.

| Feld | Bedeutung |
|---|---|
| `pos` | Füße (Hull-Unterkante). Auf Gefälle so hoch, dass die Hull auf ihrer Bergkante ruht. |
| `jump` | An diesem Knoten abspringen; der Flug geht zum nächsten Knoten. In Ketten ist jeder Landepunkt zugleich Absprung (sofort weiterhüpfen). Trägt der Sprung von hier nicht, läuft der Bot weiter und springt an der Kante (Stop-and-Go). |
| `crouch` | Crouch-Jump (in der Luft ducken, Füße +18 u). |
| `minSpeed` | Planungstempo an diesem Knoten (horizontal). Der Validator prüft jede Lücke bei genau diesem Tempo mit 10 % Reserve und bei 1.2 × auf Überschießen. |
| `surf` | Knoten an einer Surf-Flanke (kein Boden). Surf-Abschnitte ergeben sich geometrisch: ein neuer beginnt nach einem Nicht-Surf-Knoten und an jedem Drop (die Fahrfläche unter der Linie springt um > 48 u, `physics.surfSectionStarts`). Der Bot hüpft direkt vom Boden auf die Flanke, wenn die Landung dort vorhergesagt ist. |
| `air` | Luftknoten ohne Boden (Abrollen, Launch, Überflug). |
| `precision` | Präzisionsziel: der Sprung *auf* diesen Knoten ist vom Überschieß-Band ausgenommen (zu schnell → bremsen ist dort gewollt). Derzeit ungenutzt. |
| `note` | Freitext für Reports und Vorschau. |

Surf-Knoten liegen in Level 2 **320 u** unter dem Grat an der Ostflanke — der
RouteFollower zählt einen Knoten nicht, wenn er mehr als 32 u darunter vorbeifährt.
Der Ziel-Knoten liegt geradeaus hinter dem Launch (der lange Flug braucht keine
Kurve; eine Kurve zur Plattformmitte kostete die Menschenmodelle die Landung).

## Werkzeuge

- `npm run levels:build` — baut alle Level der Registry (`build.ts` `LEVELS`: level1–level4, Stubs
  werden übersprungen), `index.json`, die Lektionen nach `training/` samt `training/index.json`, und gibt
  die Planungszahlen aus (misst dabei SpeedCurves und das Surf-Band). `-- level3` baut nur diese Datei,
  `-- training` nur die Lektionen, `-- <Lektions-id>` eine Lektion — mit Filter nie `index.json`.
- `npm run levels:check -- training` bzw. `-- <id>` — Lektionen bzw. ein Level, auch wenn es noch nicht
  im Index steht. Lektionen: Vertrag statisch (IDs, Referenzen, Titel ≤ 16, Texte ≤ 2 × 40, kein
  medals/parTime), Physik über `tools/levels/training/check.ts`.
- `npx tsx tools/levels/medalProbe.ts [id …]` — Spiel-Uhr-Mediane je Bot-Modell (beide Linien einer
  Gabel) und der sync-1.0-Median über die Start-Jitter.
- `npm run levels:check` — Validator (`tools/validate-levels.ts`), ~6 s:
  statisch (Kompilierung, Spawns mitten auf der Fläche, Trigger, Kill-Zonen,
  Z-Fighting, Deko, Route mit Reserve und Überschieß-Band) und Physik:
  **Abschnitt × Bot** (Start → CP1 … CPn → Ziel, jeweils aus dem Stand, mit sync
  1.0/0.8 als Pflicht, Hand 2°/3° und sync 0.7 als Info) plus Voll-Läufe über
  Seeds 1–8 (Quote; ab einem Ausfall Warnung für sync 0.8/Hand 3°),
  Grundtechnik-Surfer ab Surf-Checkpoints, Surf-Raster 6 Tempi (400–1400) ×
  6 Tiefen × 3 Blickfehler mit Nahtstopp-Erkennung, Design-Proben aus
  `tools/levels/designProbes.ts` (Erstkontakt, Grundkurs-Ausstiege, Slalom,
  Crouch-Kante, Rutsche, Könner-Inseln, Ausfahrt, S0-Grube, S0-Rückweg, Finale-Reserve),
  "Deko auf der Flugbahn" (Oberkörper+Kopf der Hull entlang von vier Bot-Bahnen gegen jede
  Deko), Medaillen-Reihenfolge, am Ende der Selbsttest (33 Fälle, ~22 s; gesamt ~26 s).
  `npm run levels:check -- level1` prüft nur ein Level (ohne Selbsttest).
- `npx tsx tools/levels/trace.ts <level> [cp] [sync] [abTick] [alleN] [zielfehlerGrad] [seed]`
  — Bot-Trace ab Start oder Checkpoint, auch mit Menschenmodell und beliebigem Seed.
- `CHUTE='[…]' npx tsx tools/levels/sweepChute.ts` — Rutschen-Varianten messen
  (Launch-Tempo, Höchsttempo, Zeit je Bot-Modell).
- `SHOOT_PORT=5193 node tools/levels/shoot.mjs level1:top level1:node:16 …`
  — Vorschau-Screenshots nach `shots/levels/` (Default-Port 5187).
- `npx tsx tools/levels/whoosh.ts [level] [sync] [seed]` — Vorbeizieh-Whoosh offline:
  dieselbe Probe wie Game.probeNear entlang eines Bot-Laufs, Treffer < 160 u je Abschnitt.

## Offene Punkte / Abhängigkeiten

- **Menschen statt Bots:** Alle Aussagen stammen aus Bots (inkl. Menschenmodell
  mit absolutem Zielfehler) und dem Grundtechnik-Surfer. Surf-Gefühl, das
  Ausfahrt-Stufen-Erlebnis und die neue Crouch-Kante sind nicht mit einem
  Menschen gespielt.
- **Finale Level 2** ist mit ~490 u Lücke leicht (s. o.). Bewusste Folge der
  Ableitung aus dem langsamsten Raster-Einstieg; ein Playtest soll zeigen, ob
  der Flug trotzdem trägt.
- **Ring:** Innenbahn-Lücken und die Ausfahrt im ersten Durchgang sind mit Bots
  geprüft, nicht mit Menschen. Ob die Innenlinie als Wahl gelesen wird (Trims an
  den Lückenkanten) und ob Zusatzrunden Spaß machen, muss ein Playtest zeigen.
- **Hohe Surf-Linien und Keil-Pads:** wer an S2/S3 dicht am Grat fährt, rollt am
  Übergang über das Keil-Pad (kurzer Bodenkontakt). Gewollt kleiner Preis für den
  sichtbaren Drop-In; Bots und Surf-Raster laufen ohne Stall durch.
- **Level 1, Hand 3° / sync 0.7:** über 20 Seeds 17/20 bzw. 16/20 im Ziel —
  Ausfälle in Hop-Reihe und Slalom, also in den Prüfungen selbst (Validator warnt).
- **Begehbare Grate:** Mit Kanten-Bevels kann man auf jedem Surf-First landen
  (Source-Verhalten). Das kostet Tempo (Reibung) und kann überraschen; die
  Kette ist so breit, dass die Linie weit vom Grat liegt.
- **Landungen auf Gefälle** (E1, Ring-Überhöhung, Rutschen-Auffangfläche) geben nur so viel
  Speed, wie PlayerMovement beim Landen an der Fläche clippt.
- **Physik noch in Bewegung (Plan 003):** Hop-Reihen-Abstände (× 0.94), Slalom-Plan
  (874 u/s) und die Rutschen-Länge sind gegen den Stand vom 27.09. gemessen. Nach dem
  finalen Movement-Tuning (S3): `levels:build`, `levels:check`, `sweepChute.ts`,
  `novice.ts` — und prüfen, ob der perfekte Bot die Crouch-Kante noch mit Tempo nimmt
  (sonst Author/Gold zu lasch).
- **Könner-Inseln** lohnen sich für Bots nicht (s. 4b); ob sie Menschen mit gutem
  Kurven-Strafen belohnen, zeigt erst ein Playtest.
