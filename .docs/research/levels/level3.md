# 03 BRANDUNG — "Halt die Linie."

Plan 007, Phase 2, Strang `level3`. Builder `tools/levels/level3.ts`, Proben `tools/levels/probes/level3.ts`,
Tests `tests/level3.test.ts`, JSON `public/levels/level3.json` (`npm run levels:build -- level3`, schreibt nie
index.json). Vorlage: Prototyp `tools/critique/v2/level3/level3.ts` (DEFAULT_L3, Entwurf und Messungen in
`shots/v2/level3/`). Alle Zahlen gegen die **finale Phase-1-Physik** (Cap 40, Lande-Gnade, Hang-Landung mit
gestundetem Verlust, Kanten-Assist, Rutschen, Luftlenkung an, Rampbug-Fix).

**Stand 28.09. (nach Review):** `levels:check -- level3` **0 Fehler / 1 Warnung** — die Warnung ist die neue
Medaillen-Stichprobe: Bronze 25.8 s steht auf einer glücklichen 8-Seed-Stichprobe (unten "Medaillen"; die Messung
gehört build.ts, Phase 3). **Par 26 s**, Medaillen **25.8 / 24.8 / 19.1 / VELOCITY 18.3 / Autor 17.36 s** (über
48 Seeds gemessen wären Bronze/Silber 27.3 / 25.1, Par 28). Beide Linien: jeder Bot (sync 1.0/0.8, Hand 1°/2°/3°,
Seeds 1–8) im Ziel, 0 Tode; Hand 2°–5° über 48 Seeds ebenfalls 0 Tode. Keine Pads, keine Boosts — Tempo kommt
aus Höhe und Linie. `prepLessons` ['t7', 't8'] (Menü "Empfohlen: T7/T8"; der Index-Eintrag entsteht erst im
vollen Build, Phase 3).

## Idee

Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Eine Brandungswelle aus Rampen: gerader
Einstieg (W1, volles Profil), eine große **180°-Steilkurve** (die Kehre), in der sich die Linie gabelt, dann
eine breite Gerade (R1, Z), der Finale-Kicker und ein Flug von 1.5 s auf den Strand.

Die Gabel ist die Kehre selbst: zwei Halbrampen Rücken an Rücken mit gemeinsamem Grat und gemeinsamen Drops.
- **KORALLE innen** (`route`, linke Flanke): die konkave Flanke trägt um die Kurve, die Linie liegt bei ~R−160,
  kurz — aber schmal (384 u Profil, 93 u Flanke unter der Linie) und ohne Netz: wer absinkt, fällt ins
  Kurveninnere.
- **TÜRKIS außen** (`safeRoute`, rechte Flanke): konvex (man muss drücken), Linie ~R+200, lang. Darunter ein
  Auffang-Band mit Außenbande: wer nicht drückt, rutscht aufs Band und hüpft darauf bis R1 weiter.
  Langsamer, in der Kehre nie tot.

**Was die Gabel entscheidet (gemessen, Abschnitt "Risiko der Innenbahn"):** Für jeden, der die Kurve HÄLT, ist
Koralle schneller und genauso todesfrei — das verlangt die Plan-Abnahme selbst (Hand 1–3° auf route 0 Tode,
Quote ≤ 0.90). Das Risiko trifft Aussetzer (A/D zwischendurch los) und Nicht-Drücker (nur W): innen sterben sie,
außen nicht. Eine ZEIT-Entscheidung ist die Gabel damit für kein Bot-Modell — Türkis ist die Netzbahn für
Einsteiger, keine Alternative für Könner. Das ist eine Plan-Frage an den Lead (Offene Punkte).

Eine schnelle Surf-Linie spart **Weg**, nicht Höhe (Prototyp: Sprung über eine Welle war 0.5 s langsamer als
durch, `shots/v2/level3/sweepWelle.txt`). Innen/außen spart ~1100 u auf 180° (Linie innen ≈ 5781 u, außen ≈
6912 u).

```
                   KEHRE 180° links, Grat-R 2000, 12°, 4 Viertel à 45° (Drop 64 je Viertel)
             .-~~~~~~~~~~~~~~~~~~~~~ ◆ CP2 (Pad auf dem Grat) ~~~~~~~~~~~~~~~~~~~-.
           /  KORALLE innen: Halbrampe 384 (Viertel 4: 576), Linie 240 u unter dem Grat \
          |   TÜRKIS außen: Halbrampe 768, Linie 320; Grat-Bande 128; Auffang-Band 320    |
          |                 32 u unter dem Fuß, Außenbande 448 (Clip + Leuchtbalken)       |
          |                        ▲ Leuchtturm (Kehrenmitte)                             |
    CP3 ◆ R1  1536 breit / 50°, Drop 256 (fängt beide Bahnen + das Band)   CP1 ◆  W1 1536 @10°
          Z   1536 / 50° @10°                                                  ▣ START, Blick Nord
          FINALE-Kicker 512@10° · 768@24° · 256@12° · 256@4° · 320@−8°
          ▼  Lücke 584 u, Flug 1.5 s
      ▣▣▣▣ STRAND 2048 × 2400 (Ziel), 1100 u unter dem Kicker, Prallwand
```

## Aufbau

| # | Abschnitt | Grat (u) | Tempo sync 1.0 | Aufgabe |
|---|---|---|---|---|
| 0 | Startbrett (Spawn 48 rechts vom Grat; Chevrons 152 u voraus: Koralle 22 u links, Türkis 58 u rechts vom Grat, ±12°) | +40 | 0 | Seite wählen; geradeaus ablaufen = Türkis |
| 1 | W1, volles Profil 768/60°, 1536 u, 10° | 0 → −271 | → ~510 | Grundtechnik |
| 2 | CP1: Drop 128 auf Viertel 1, Keil-Pad auf dem gemeinsamen Grat, Spawn rechts | −382 | | Respawn wählt die Seite |
| 3 | Kehre Viertel 1–2 (Knick 3.75°/Fuge, 12–13 Stücke je Viertel) | −382 → −1148 | → ~800 | Gabel |
| 4 | CP2: Drop Viertel 2 → 3, Pad auf dem Grat (Grat-Bande dort offen = Wechselfenster) | −1191 | | Respawn in der Kurvenmitte |
| 5 | Kehre Viertel 3–4, 256 u gerade Ausfahrt | −1191 → −1957 | → ~1000 | |
| 6 | CP3 + R1: Drop 256, 1536 breit / 50° (Mindest-Drop (tan60 − tan50)·384 = 207) | −2193 → −2463 | 900–1000 | Zusammenführung ohne V-Stufe |
| 7 | Z: Drop 128, 1536/50°, 10° | −2575 → −2845 | ~1000 | Tempo tragen |
| 8 | Finale-Kicker (wie L2 S4) | −2956 → −3416 | bis ~1060 | Launch |
| 9 | Strand: Lücke aus dem gemessenen unteren Band (423 u/s × Reserve), Prallwand | −4516 | Flug 1.5 s | Belohnungsflug |

Abschnittszeiten aus dem Stand (sync 1.0, Validator): Start → CP1 3.5 s · CP1 → CP2 5.7 / 6.8 s · CP2 → CP3
5.5 / 7.2 s · CP3 → Ziel 8.4 / 8.7 s (Koralle / Türkis).

## Messungen (Spiel-Uhr, `timedRun`)

| Modell (Seeds 1–8) | KORALLE (route) | TÜRKIS (safeRoute) | Quote |
|---|---|---|---|
| sync 1.0 | 17.46 s | 19.25 s | 0.907 |
| sync 1.0, 49 Start-Jitter | 17.35 s (16.41–18.95, 49/49, ein Zweig) | 19.48 s (18.58–20.60, 49/49) | **0.891** (Soll ≤ 0.93) |
| sync 0.8 | 19.09 | 21.63 | |
| Hand 1° | 18.45 | 20.90 | |
| Hand 2° | 20.45 | 23.53 | |
| Hand 3° | 21.99 | 24.55 | **0.896** (Soll ≤ 0.90, knapp) |
| Hand 3°, 24 Seeds | 22.53 | 26.22 | **0.859** |

Jede Zeile: 8/8 im Ziel, 0 Tode. Die 8-Seed-Quote der 3°-Hand streut (Türkis 23.98–28.17 s); die Probe
misst deshalb über 24 Seeds und nennt die 8 Validator-Seeds mit. Über 48 Seeds (Review, bestätigt): Hand
2°/3°/4°/5° Koralle 21.22 / 22.71 / 24.10 / 26.27 s, Türkis 23.88 / 25.99 / 27.82 / 31.01 s, 48/48 im Ziel,
0 Tode auf beiden Linien.

sync 0.7 (Info-Stufe) 7/8 je Linie, Seed 6 ohne Ziel: Der Bot hüpft vom Brett schräg auf die linke W1-Flanke
(214 → 23 u/s beim Aufsetzen), dreht um und treibt ~10 s mit 47 u/s RÜCKWÄRTS die Flanke entlang (z −332 → +13),
bis er über das offene Heck von W1 (z > 0) fällt (kill bei x −220, z −60). `timedRun` startet nach jedem Tod
mit demselben Seed, der Lauf wiederholt sich (12 bzw. 20 Tode, fallen.md #70). Ein Mensch dreht nach Sekunden
um; W1 nach hinten zu verlängern oder zu schließen änderte die Start-Kollision nur für dieses Info-Modell (aus
einer Clip-Wand würde Stau statt Tod) — nicht gemacht.

**Medaillen** (build.ts, Regel 10/11): Bronze = 3°-Hand Türkis × 1.05 = 25.8, Silber = 2°-Hand Türkis × 1.05 =
24.8, Gold/VELOCITY/Autor = sync 1.0 Koralle über 49 Start-Jitter × 1.1/1.05/1 = 19.1/18.3/17.36. Der perfekte
Bot braucht auf Türkis 19.25–19.48 s: **Gold (19.1) und VELOCITY (18.3) gibt es nur innen**. Freischaltung
L3-Silber = Kendama (Plan 007 §7).

**Bronze/Silber hängen an einer glücklichen Stichprobe** (Review-Befund, nachgemessen): build.ts nimmt den Median
der 8 Validator-Seeds. Auf Türkis ist er für die 3°-Hand 24.55 s, über 48 Seeds 25.99 s — ein Fall aufs Band
kostet 2–4 s, die Seeds 1–8 fallen seltener. Folge: die Hand, für die Bronze steht, schafft Bronze auf der
sicheren Linie nur in **21/48** Läufen (Silber mit der 2°-Hand 40/48; auf Koralle Bronze 47/48). Par 26 liegt
genau am 48-Seed-Median. Über 48 Seeds gemessen: **Bronze 27.3 / Silber 25.1 / Par 28** (Leiter dann 8 % statt
4 % Abstand). Die anderen Level zum Vergleich (Hand 3°, Median 8 → 48 Seeds, Bronze geschafft): L2 19.21 → 20.02
(39/48), L4 32.08 → 32.08 (45/48) — L3 ist der Ausreißer, weil Türkis zwei Zeit-Moden hat (Band ja/nein). Die
Probe "Medaillen-Stichprobe" warnt, solange die Medaillen-Hand ihre Medaille in weniger als der Hälfte von 24
Läufen schafft (heute Bronze 11/24). Die Korrektur gehört in build.ts (Bronze/Silber über ≥ 24 Seeds, Phase 3).

**Im echten Spiel** (Echtzeit, Route-Bot Seed 11, index.json nur per `page.route` ergänzt): Koralle sync 1.0
17.09 s, Türkis 19.70 s, sync 0.8 20.41 / 23.04 s, 0 Respawns, 60 fps, 0 Konsolenfehler.

## Proben (`probes/level3.ts`, laufen in `levels:check`)

| Probe | Soll | Ist |
|---|---|---|
| Innenvorteil (sync 1.0 über 49 Starts, Hand 3° über 24 Seeds) | ≤ 0.93 / ≤ 0.90 | 0.89 / 0.86 (8 Seeds 0.90) |
| Außenbahn fängt Nicht-Drücker: W-Halter ab CP1/CP2, Blick auf einen Türkis-Knoten ≥ 320 u voraus ±15/±30°/0° oder Flugrichtung, mit/ohne Leertaste | 24/24 am nächsten CP, 0 Tode | 24/24, langsamster 13.7 s |
| dieselben W-Halter mit Blick auf den **nächsten** Knoten | 0 Tode | 0/20 Tode, 1 Stau |
| Checkpoint-Pad ↔ beide Linien | ≥ 64 u | min 142 u (cp3pad ↔ Türkis) |
| Grundtechnik-Surfer (Blick 0°) aus dem Stand **auf der eigenen Bahn**, Tempo am nächsten CP | ≥ 700 u/s, beide Linien; ≥ 90 % der Luftticks über der Gabel auf der Sollseite des Grats | Koralle 842 (ab Knoten 6) / 907 (ab Knoten 32) / 774, Türkis 869/902/963; je 100 % auf der Bahn |
| Finale aus dem CP3-Respawn, beide Linien | ≥ 10 % Weitenreserve | ≥ 127 % |
| Risiko nur innen: Aussetzer-Modell (Hand 2°, A/D beim Surfen 0.5 s alle 2 s los), 16 Seeds | Koralle ≥ 25 % der Läufe mit Tod in der Kehre, Türkis keiner (sonst Warnung) | Koralle 6/16, Türkis 0/16 |
| Medaillen-Stichprobe: Bronze/Silber mit der Medaillen-Hand auf Türkis, 24 Seeds | ≥ 50 % schaffen sie (sonst Warnung) | Bronze 11/24 → **Warnung**, Silber 20/24 |

**Grundtechnik-Surfer auf der falschen Bahn (Review-Befund, behoben):** Die Checkpoint-Spawns liegen rechts vom
Grat (Türkis). Der SurfRider drückt in die Flanke, auf der er landet, und wechselt nie die Seite — die
[route]-Zeile maß ab CP1/CP2 in Wahrheit Türkis (0 % der Kehren-Luftticks links vom Grat; die alten
"Koralle"-Zahlen 902/863 waren Türkis-Fahrten mit der Koralle-Achse). Jetzt startet der Surfer einer Linie am
CP-Spawn, wenn der auf ihrer Seite liegt, sonst auf ihrem ersten Surf-Knoten nach dem Wiedereinstieg (Stand;
wer innen will, tritt links vom Pad). Die Seite kommt aus der Geometrie: Grat = Fugen der Außenbahn-Stücke
(Tags `outer<k><a–z>`), Seite = Vorzeichen des Querabstands; gezählt werden nur Luftticks über Brushes der Gabel
(Halbrampen beider Bahnen, Band), R1 ab CP3 nicht. Gegenprobe: mit dem alten Start meldet die Probe "fährt
falsche Bahn — CP1 0 %, CP2 0 %". Mit Blick +2° (Info) Koralle 505/763, Türkis 730/699 u/s.

**Stau statt Tod:** Auf dem Band liegt der nächste Türkis-Knoten oft direkt NEBEN einem an der Flanke (199 u
waagrecht, 382 u höher). Wer genau darauf blickt, drückt W senkrecht in die Flanke und kriecht mit 0.1–0.3
u/s (fallen.md #73). Blickmodelle im Vergleich (24 Läufe): nächster Knoten 23/24, 120 u voraus 23/24, 200 u
22/24, 320 u 24/24 — alle Fehlschläge Stau, **nie Tod**. Wer schaut, wohin er will, hüpft weiter.

Außerdem aus dem Validator (Pflicht auf safeRoute): Surf-Raster jeder Abschnitt 100 % (w1 108/108, outer1a
90/90, outer2b 108/108, outer3b 90/90, outer4b 108/108, r1/z/finalea 108/108), 0 Nahtstopps, Respawn-Surfer
CP1–3 im Ziel. Auf route ebenfalls 100 % (inner1a 36/36, inner3a 36/36). Kill-Kacheln (49) mindestens 250 u
unter jeder Fahrfläche (Soll ≥ 128). Kehre 180.000° (Tangente Viertel 4 und R1 gegen W1). Der Respawn-Surfer
des Validators auf route (`physics.respawnSurf`, fremder Pfad) startet ebenfalls am CP-Spawn und fährt damit
ab CP1/CP2 Türkis — für die Koralle-Zahl gilt die Probe oben.

## Risiko der Innenbahn (Review-Befund "keine echte Entscheidung")

Die Hand-Modelle (Zielrauschen, Dauerdruck in die Rampe) fallen von keiner der beiden Flanken: über 48 Seeds
Hand 2°–5° 0 Tode, Koralle immer schneller. Menschen setzen aus — das Aussetzer-Modell (`probes/level3.lapseRun`:
RouteFollower Hand 2°, beim Surfen A/D periodisch los, Phase je Seed; Tode kosten Zeit wie im Spiel) über 48 Seeds:

| Aussetzer | KORALLE: Läufe mit Tod in der Kehre, Median | TÜRKIS: in der Kehre, Median, im Ziel |
|---|---|---|
| keine | 0/48, 21.22 s | 0/48, 23.88 s, 48/48 |
| 0.25 s alle 2 s | 0/48, 22.11 s | 0/48, 25.80 s, 48/48 |
| 0.4 s alle 2 s | 5/48 (10 %), 24.80 s | 0/48, 30.27 s, 48/48 |
| 0.4 s alle 2 s, Hand 3° | 10/48 (21 %), 27.50 s | 0/48, 32.98 s, 46/48 |
| 0.5 s alle 2 s | 22/48 (46 %), 27.17 s | 0/48, 40.34 s, 32/48 |
| 0.6 s alle 2.5 s | 26/48 (54 %), 29.52 s | 0/48, 39.55 s, 29/48 |

- **Das Risiko ist echt und nur innen:** Türkis-Tode gibt es nur vor CP1 und nach CP3 (W1, R1 — gemeinsame
  Rampen). Die 16-Seed-Zahl des Reviews (0.4 s: 4/16 = 25 %) sind über 48 Seeds nur 10 %; die Probe nimmt deshalb
  0.5 s (46 %, 16 Seeds 6/16) und verlangt ≥ 25 % innen, 0 außen. Gegenproben: Innenbahn breit (576/768) 0/16 →
  Warnung; Außenbahn ohne Band 6/16 Türkis-Tode → Warnung.
- **Aber Koralle bleibt auch für Aussetzer schneller.** Ein Tod kostet ab dem nahen CP nur ~4 s (0.4 s: Median
  28.44 mit gegen 24.76 s ohne Tod), jeder Aussetzer auf der KONVEXEN Außenflanke kostet dagegen Tempo — man
  rutscht ab und klettert zurück (0.4 s: das Modell erreicht das Band in 8/8 Läufen gar nicht und verliert trotzdem
  ~6 s). Türkis-Läufe ohne Ziel (0.5 s: 16/48) sind Bot-Stau auf dem Band (6/16 stehen dort ~11 s, fallen.md #73),
  keine Tode; W-Halter kommen vom Band weiter (Probe oben).
- **Enger machen dreht das nicht** (Varianten, Layout ohne Messung, Aussetzer 0.4 s über 16 Seeds, Hände 24 Seeds):

| Innenbahn | Aussetzer 0.4 s: Tod / Median | Hände 1–5° | Quoten jit / H3 |
|---|---|---|---|
| 384 / Linie 240 (Stand) | 4/16, 24.09 s | 0 Tode | 0.891 / 0.859 |
| 352 | 3/16, 24.82 s | 0 Tode | 0.891 / 0.848 |
| 336 | 6/16, 24.37 s | 0 Tode | 0.890 / 0.858 |
| 320 | 9/16, 24.39 s | Hand 5° 1 Tod | 0.884 / 0.824 |
| Linie 300 | 10/16, 24.92 s | 0 Tode | 0.899 / 0.846 |
| 320 / Linie 200 | 7/16, 26.32 s | Hände sterben, Jitter 32/49 ohne Ziel | – |

  Mehr Tode, aber der Koralle-Median für Aussetzer bleibt bei ~24–25 s gegen 29.7 s außen. Die Innenbahn ist
  deshalb NICHT verengt: 93 u Flanke unter der Linie sind für Menschen schon schmal, und die Bots belegen keinen
  Nutzen. Hebel für eine echte Zeit-Entscheidung wären der Todes-Preis innen (CP2 liegt mitten in der Kehre)
  oder ein billigeres Netz außen (Band als flache Surf-Rampe) — beides gegen die heutige Plan-Abnahme (3 CPs,
  Auffang-Band), also Lead-Frage.

## Gegenüber dem Prototyp (gemessen, Varianten-Skripte im Scratchpad des Strangs)

- **Endtangente** (`dropFrom` 'tangent'): Kehre 180° statt 174.4°.
- **Finale-Linie 200 u unter dem Grat** (Knoten ab 300 u, Launch-Knoten ebenfalls 200) statt 320: das war
  der Gate-Befund "safeRoute sync 1.0 0/8, Stall vor Knoten 70" mit Cap 40. Heute mit 320: 0 F im Validator,
  aber 3/49 (Koralle) und 4/49 (Türkis) Jitter-Starts ohne Ziel (Bot-Stall nach CP3) und sync 1.0 +0.8 s;
  mit 200: 49/49.
- **Innenbahn, Viertel 4 (Ausfahrt)**: Profil 576 statt 384, Linie gleitet von 240 auf 360 u unter dem Grat
  (tiefer = kleinerer Fall auf R1). Ohne das lohnt die Innenbahn der 3°-Hand nicht: Quote 0.955 (8 Seeds) /
  0.899 (24 Seeds) → 0.896 / 0.859. Plateau (Sweeps des ersten Strang-Durchgangs, mit dieser Physik
  reproduziert): Profil 576–768 × Linie 280–400 → sync-1.0-Quote 0.885–0.916, Hand 3° über 24 Seeds 0.847–0.867,
  über 8 Seeds 0.896–0.925 (die 8-Seed-Zahl streut; gewählt ist 576/360).
- **Grat-Bande**: Inset 18/16/14/12 u je Viertel statt abwechselnd 12/14 — jede Folge-Bande liegt zurückgesetzt,
  es gibt keine Kerbe, an der ein Fahrer entlang der Bande hängen bliebe (Begründung aus dem Builder, nicht
  einzeln nachgemessen).
- **Außenbande als Leuchtbalken** (Look-Pass, unten).
- **R1/Z nicht gekürzt** (Review-Befund "tote Zeit nach CP3", Designoption). Gemessen (Layout, sync 1.0 über 8
  Seeds, Hand 3° über 24 Seeds; Anteil CP3 → Ziel am Median-Lauf):

| R1 / Z | Koralle sync 1.0 | Türkis sync 1.0 | Hand 3° Koralle / Türkis | Quoten jit / H3 |
|---|---|---|---|---|
| 1536 / 1536 @10° (Stand) | 17.46 s, 39 % | 19.25 s, 33 % | 42 % / 33 % | 0.891 / 0.859 |
| 1024 / 1024 @10° | 16.48 s, 35 % | 18.61 s, 31 % | 34 % / 32 % | 0.888 / 0.860 |
| 1024 / 1024 @15° (gleiche Höhe) | 16.95 s, 37 % | 18.53 s, 31 % | 33 % / 32 % | 0.907 / 0.880 |

  Kürzen spart ~1 s, der Anteil nach CP3 sinkt nur von 39 auf 35 %: Finale-Kicker und 1.5-s-Flug bleiben der
  größte Teil, und die sind die Belohnung. Eine echte Entscheidung nach CP3 (Z als S-Kurve, Kaskade) ist ein neuer
  Abschnitt mit eigener Raster-Validierung — Playtest-/Lead-Frage, nicht Teil der Review-Fixes.

## Look: Mondflut

- Himmel #03141c → #0f5a66, Fog #0a3a48 (1800–8000), **Mondlicht #d6fff5**, Ambient #3f8fa0/#06222a, Trims
  Koralle #ff7a45 / Sand #ffd166 (Gegenfarbe zur türkisen Welt; L1 Cyan, L2 Acid), Void-Gitter bei −13000.
- **Mond im Südosten** (`sunDir` [0.84, 0.48, 1]: 40° links der Finale-Achse, 20° hoch). Vorher [−0.3, 0.3, 1]
  (17° voraus): im Finale stand die Scheibe genau hinter Tacho und SURF-Label (Review-Befund). Der Review-Vorschlag
  Südwest ([−0.55, 0.42, 1], nachgeschärft auf [−0.84, 0.48, 1]) räumt das Finale, aber am Kehren-Ausgang (Blick
  SW, Koralle t 9.0 s) stand sie wieder hinter der Zahl. Im Osten liegt keine Blickrichtung der Strecke (W1 Nord,
  Kehre N → W → S): Scheibe groß links oben im Finale und über dem Strand, nie hinter dem HUD (Shots
  `shots/level3/rv-route-east`, `rv-safe-east`). Die Koralle-Flanke in Viertel 1–2 liegt damit im Schatten
  (dunkles Marine mit Koralle-Trims, lesbar).
- **Start-Chevrons** 152 u voraus, nah an der Blickachse (Koralle 22 u links, Türkis 58 u rechts vom Grat,
  Arm 40): vorher lagen sie unter der Tastenanzeige (unten links) und der Hand (unten rechts, beide Default an).
  Shot `shots/level3/rv-safe/00-start.png`: beide frei in der unteren Bildmitte. Spitze 13 u hinter der
  Brettkante (Validator: "Bodenmarkierungen 4, alle liegen auf").
- **Außenbande**: die 448-u-Bande kollidiert unverändert, ist aber ein unsichtbarer Clip. Sichtbar sind ein
  schlanker **Leuchtbalken** (12 × 12 u, `light`, Sand) an ihrer Oberkante — der echten Grenze — und dunkle
  Pfosten an jeder zweiten Fuge, beide ganz in der Clip-Hülle (nichts in der Flugbahn, keine koplanaren
  Flächen). Als Vollwand versperrte sie auf Türkis den Blick aus der Kehre. Kollision und Physik bitgleich
  (alle Bot-Zeiten, Raster und Jitter-Mediane identisch vor/nach).
- **Kehren-Leuchtturm** in der Kehrenmitte: dunkler Schaft, drei Koralle-Leuchtringe, Laterne in Mondfarbe,
  auf Höhe der Einfahrt (links auf Augenhöhe, am Kehrenende 1600 u darüber). Die fünf fernen Türme sind
  ebenfalls Leuchttürme (Laternen Türkis/Koralle/Sand).
- Brandungs-Tore über R1, Z und Finale, sechs Strandbojen im Wechsel Koralle/Sand (3 + 3; vorher alle Sand —
  die Parität hing an u, und alle u-Werte waren gerade).
- **Offen (fremder Pfad):** die Mondscheibe rendert gelb, nicht #d6fff5 — `sky.ts` setzt die Scheibe fest
  "warm" (Blau × 0.55, unten Pink aus Horizont + trimColorAlt). Aus Level-Daten nicht erreichbar.

**Frame-Zeit** (Chromium/ANGLE ohne VSync und Frame-Limit, Route-Bot, 3 × 14 s je Level im Wechsel, nach den
Review-Fixes): L2 Ø 0.82 ms, L3 Ø 0.76 ms (**× 0.93**, Soll ≤ 1.10); JS im rAF-Callback 0.74 / 0.69 ms. Szene 12
Draw Calls, 174 238 Level-Dreiecke (L2: 11 / 110 964). 396 Brushes (259 kollidierend, 137 Deko). Echtzeit mit
VSync: Koralle sync 1.0 17.09 s, Türkis 19.70 s, sync 0.8 20.41 / 23.04 s, 0 Respawns, 60 fps (min 60),
0 Konsolenfehler.

## Tests (`tests/level3.test.ts`, 8 Tests, < 1 s)

Name/Licht/prepLessons · Medaillen streng fallend, Par · beide Linien Start → CP1 → CP2 → CP3 → Ziel · die Gabel
(jeder Surf-Knoten über der Kehre liegt auf dem Stück seiner Bahn — Koralle `inner…`, Türkis `outer…` — und auf
ihrer Seite des GRATS, je Viertel ≥ 3 Knoten; heute 14/13/13/15 je Linie, kleinster Querabstand 155 / 200 u.
Vorher Abstand zu einem festen Kreismittelpunkt mit Schwelle R 2000 — der Grat zieht sich aber auf ~1790 zu,
eine Türkis-Linie 100 u unter dem Grat wäre durchgefallen) · Außenbande Clip + Balken · Kehre 180° ·
Layout = JSON-Kollision · perfekter Bot beide Linien.

## Offene Punkte

- **Medaillen (build.ts, Phase 3):** Bronze/Silber über ≥ 24 Seeds messen (besser 48). Für L3 ergäbe das Bronze
  27.3 / Silber 25.1 / Par 28 (heute 25.8 / 24.8 / 26; Bronze schafft die 3°-Hand auf Türkis in 21/48). Bis dahin
  warnt `levels:check -- level3` (Medaillen-Stichprobe).
- **Gabel als Zeit-Entscheidung (Lead):** Mit der Plan-Abnahme (Hand 1–3° innen 0 Tode, Quote ≤ 0.90) ist
  Koralle für jeden, der die Kurve hält, die bessere Wahl; Türkis ist die Netzbahn (Aussetzer und Nicht-Drücker
  sterben innen, außen nicht). Soll die Gabel auch für Könner eine Abwägung sein, braucht es einen höheren
  Todes-Preis innen (z. B. CP2 ans Kehrenende) oder ein Netz außen, das weniger Zeit kostet — beides ändert die
  Plan-Abnahme.
- `tests/levels.test.ts` "die Registry kennt level1–level4 …" ruft `buildLevel3()` — das misst (zwei Durchgänge
  `measureSurfSpeeds` mit SURF_GRID, ~13.4 s; der Test insgesamt 13.8 s) und überschreitet das Vitest-
  Standardlimit 5 s. Schon ein Durchgang kostet > 5 s, ein schlankerer erster Durchgang löst es also nicht. Der
  Test gehört nicht diesem Strang; Vorschlag: eigenes Timeout (60 s) für diesen Test.
- Mondscheibe rendert gelb (s. o.) — `sky.ts`, Integration/Look.
- Tote Zeit nach CP3 (35–39 %): S-Kurve oder Kaskade auf Z wäre eine Design-Erweiterung (Playtest).
