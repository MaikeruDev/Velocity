# 04 TURM — "Tempo ist Höhe."

Plan 007, Phase 2, Strang `level4`. Builder `tools/levels/level4.ts`, Proben `tools/levels/probes/level4.ts`,
Tests `tests/level4.test.ts`. Vorlage war der Prototyp `tools/critique/v2/level4` (Entwurf in
`shots/v2/level4/`). Alle Zahlen hier sind gegen die **finale Phase-1-Physik** gemessen: Cap 40,
Lande-Gnade, Hang-Landung mit gestundetem Verlust, Kanten-Assist, Rutschen, Luftlenkung an.

**Stand 29.09., dritte Runde (nach der Integration):** `levels:build -- level4` → **Par 29 s**, Medaillen
**28.7 / 27.3 / 26.2 / VELOCITY 25.0 / Autor 23.76 s** — unverändert gegenüber der Integration (Route und Aufstieg
außen unberührt; index.json stimmt weiter mit der Level-Datei überein). `build.ts` misst jede Medaille als schnelleren
Median aus RouteFollower und L4-Hybrid (`level4Reference`: klettert als RouteFollower, surft ab dem ersten Kontakt nach
CP4 mit der Grundtechnik). Spiel-Uhr, Median der Seeds 1–8: sync 1.0 **25.22 s**, Hand 1° 26.29 s, Hand 3° 30.97 s
(× 1.23). Jeder Bot kommt ins Ziel, niemand stirbt (8 Modelle × 8 Seeds). `levels:check -- level4`: **0 Fehler,
0 Warnungen** (~20 s). `vitest tests/level4.test.ts`: **21/21** (~5 s).
Keine Pads, keine Boosts. Empfohlene Lektionen `prepLessons: ['t6', 't7', 't8']` (Crouch-Jump, Surfen).

Dritte Runde (29.09.), Details unter "Dritte Runde":
- **Innenbahn entschärft:** Gräben 24 statt 72 u tief. W + Leertaste innen schneller bis ~550 u/s, darüber höchstens
  +0.19 s (vorher ab 450 u/s eine Falle, bis +1.33 s). Neue Probe/Test `laneChoice` mit Gegenprobe am alten Graben.
- **Crouch-Kanten-Lotterie:** in der Geometrie nicht behebbar (Terrassen-Sweep 25–50°: 71–88/240 teure Anpraller).
  Der Hebel ist das Kanten-Gedächtnis (Physik, fremder Pfad): `ledgeMemory` 0.45 statt 0.2 s → 11/240, 0.6 s → 3/240.
- Medaillen-Wächter grün (Integration); Diagnose, wo der RouteFollower in der Abfahrt verliert (für die Medaillen-Phase).
- Tests: Innenbahn als Wahl + Rettung, Anfänger W + Leertaste + Ducken bis CP4.

Erste Review-Runde (28.09.): Clip über der 80-u-Bande + Kill-Ring, ↑C-Marke vor den Crouch-Kanten, Innenbahn in
"Vorsichts-Linie" umbenannt. Zweite Review-Runde (29.09.), Details unter "Zweite Review-Runde":
- Kein Route-Knoten mehr auf dem Sprungbrett (der Bot bremste dort per S): alle Bots ~1.1 s schneller, Medaillen neu.
- Neuer Medaillen-Wächter (Probe + Test): rot, bis der Medaillen-Bot wie ein Grundtechnik-Surfer surft.
- Absprungband statt ↑C-Glyph: durchgehend = immer richtig (250–950 u/s), Streifen davor = erst ab 450 u/s.
- Warnstreifen vor den Gräben der Innenbahn; eine echte Risiko-Wahl ist dort nicht gelungen (Plan-Frage).
- Sprungbrett 32 u nach Süden (16–256), Drop-In-Probe mit Anlauf vom Steg und Kursfehler.
- K2-Kosten per Gabelung gemessen: 0.46 s (nicht 1.8 s).

## Idee

Ein Funkturm bei Nacht über einer Stadt. Außen am Turm windet sich eine breite Wendel (512 u, Bande außen)
1,5 Umdrehungen nach oben. Die Wendel ist eine überall befahrbare, steigende Spiralrampe, also ein
"Velodrom nach oben": Man hüpft ohne Pause bergauf und kurvt dabei immer in dieselbe Richtung. Wer schneller
ist, steigt schneller. Oben führt ein Steg mit Geländer hinaus ins Nichts, danach kommt das Sprungbrett und
eine Surf-Abfahrt mit vier Drops: Jetzt gilt umgekehrt **Höhe ist Tempo**. Launch: Medaillen-Bot 1010 u/s,
Grundtechnik-Surfer (Blick entlang der Achse) ~1200–1500 u/s, im Surf-Raster bis 1837 u/s.

Im Aufstieg kann man nicht sterben. Innen steht der Kern. Außen steht die sichtbare 80-u-Bande, darüber ein
unsichtbarer Clip bis 256 u über der Bahn. Sein Dach ist nach innen geneigt (n.y 0.62): Stehen oder ein
Lip-Step darauf geht nicht, wer darauf fällt, rutscht auf die Bahn. An Steg und Krone steht derselbe Clip mit
sichtbarem Geländer. Probe `bandeEscape` über 3360 Läufe: 0 kommen hinaus, 0 stehen auf der Bande. Die Füße
kommen an der Bande höchstens 161 u über die Bahn, also bleiben 95 u bis zur Clip-Oberkante.
Die Gräben haben Auffang-Mulden, und wer an einer Crouch-Kante abprallt, landet auf der eigenen Terrasse. Außen
um die Wendel und neben Steg/Krone liegt ein Kill-Ring als Rückfallebene. Mit Clip erreicht ihn niemand. Die
Variante ohne Clip ließe 1040/1680 Läufe hinaus; die sterben dort nach im Median 1,0 s statt nach 2,9 s freiem
Fall. Sonst gibt es Kill-Zonen nur in der Abfahrt, dicht unter dem Rampenfuß. Der Respawn an CP4 bzw. CP5
liegt 1–4 s entfernt.

## Aufbau

Koordinaten: Kern-Mitte (0, 0), Y oben. θ ist der Fahrwinkel ab dem Südpunkt gegen den Uhrzeigersinn
(Kern links), φ = 270° + θ wie bei `lib.Ring`. Die Planlinie (Route) liegt bei r 896, in E2 außen bei r 1000.

| Abschnitt | θ (Grad) | Höhe (u) | Fähigkeit | Anmerkung |
|---|---|---|---|---|
| Anlauf | Süd, x −1500 → 0 | 0 | Einlaufen, erster Hop | Lücke 128 mit Mulde 40, Start-Chevrons |
| **E1 WENDEL** | 0–135 | 0 → 384 | bergauf hüpfen, einseitig kurven | Planlinie ~10°; außen Bande 80 u + Clip bis 256 u (ganze Wendel) |
| P1 = **CP1** | 135–155 | 384 | — | flaches Podest |
| **E2 GRÄBEN** | 155–290 | 384 → 768 | Linienwahl nach Tempo | Teilung bei r 864: außen lückenlos mit Bande (Tempo-Bahn); innen (r 640–864) gefahren 25 % kürzer, steiler, drei Gräben **24 u** tief mit Auffang-Mulde, **Bernstein-Warnstreifen** vor jedem Graben — schneller bis ~550 u/s, darüber höchstens +0.19 s |
| P2 = **CP2** | 290–310 | 768 | — | |
| **E3 KANTEN** | 310–450 | 768 → 1088 | zwei Crouch-Kanten à **66 u** | Rampe +62 (310–335), Terrasse 25° mit **Absprungband**, **K1 bei θ 360** (Südpunkt), Lippe ↑C 3°, Rampe +126 (363–425), Terrasse 25° mit Absprungband, **K2 bei θ 450** (Ostpunkt) |
| P3 = **CP3** | 450–470 | 1088 | — | vorn 3° Lippe mit `duck`-Material |
| **E4 AUSLAUF** | 470–540 | 1088 → 1344 | Tempo holen | |
| STEG | ab Nordpunkt gerade nach Westen, 1100 u | 1344 → 1536 | Blick ins Nichts | unsichtbarer Clip bis 256 u (Dach nach innen) + Geländer (Pfosten alle 96 u, Leucht-Handlauf auf 66–74 u) |
| KRONE = **CP4** | 200 u | 1536 | — | Clip wie am Steg; Trichter-Wände links und rechts des Bretts |
| Sprungbrett | 256 u, 10° abwärts | 1536 → 1491 | Drop-In | quer **16–256 u** nördlich des Grats |
| ABFAHRT | nach Westen | 1512 → Launch | Surf, Linie halten, Drops | d1 850 u @10°, Drop 128, d2 1152 @10°, Drop (**CP5**: Luft-Trigger, Kiel-Pad auf d3), d3 1152 @14°, Drop, d4 1024 @16°, Drop, Kicker 384 @16 / 768 @25 / 256 @12 / 256 @4 / 320 @−8 |
| ZIEL | hinter dem Launch | −1372 | Belohnungsflug | Lücke 504 u (gemessenes Launch-Band, ≥ 10 % Reserve), 1900 tief, Prallwand |

```
                                 N  (θ 180 / 540)
  ◄──── ABFAHRT nach Westen ──── SPRUNGBRETT ◄ KRONE(CP4) ◄◄◄◄ STEG 1100 u ◄◄◄◄ ●  E4 endet (y 1344)
  ZIEL ▣ ~~~ ~~~ ◭CP5 ~~~ ~~~ ~~~                                   .-''''''''''-.
                                                          .'  E2 ═  ═  ═   '.      θ 135–155 NO: P1 = CP1 (y 384)
                                                         /   Innenbahn mit    \
                                                        ;    3 Gräben          ;
                  W (θ 270)  P2 = CP2 (θ 290–310) ────► |     ( KERN r 640 )   | ◄── O (θ 90 / 450):
                  y 768                                 ;                      ;     K2 → P3 = CP3 (y 1088),
                                                         \                    /      E4 ↑ nach Norden
                                                          '.  E3 →   E1 →   .'
                                                            '-..........-'
   START ▭ (x −1500…−1180) ══ Lücke 128 + Mulde ════════════► ●  S (θ 0 / 360): Wendelfuß y 0 · K1 bei θ 360 (y 830 → 896)
```

**Look (Funkturm-Palette):** Himmel #050814 → #2a4a7a, Fog #1c2640 1800–8200 u, Mond #cfe0ff. Trims in
Flugwarn-Rot #ff3848, Zweitfarbe Eisblau #8fe3ff. `ambientGround` #94462a (Natriumlicht der Stadt von unten,
gegenüber dem Prototyp #7a3a20 angehoben). Dazu `underTrim` auf allen Wendel-Stücken und rote bzw. eisblaue
Lichter auf der Bande alle 40°. Am Kern-Dach sitzen 8 Flugwarnlichter, darüber ein Mast mit roter Krone. In
der Ferne stehen Stadt-Türme, am Ziel ein Torbogen. Unter der Wendel laufen zwei Natrium-Lichtleisten
(r 760/1024) als Spirale. Sie sind bewusst nicht in Trim-Farbe: Sie dürfen nicht wie begehbare Kanten
aussehen. Bodenmarken: Absprungband Eisblau (#8fe3ff durchgehend, #3f7fa0 Streifen), Warnstreifen Bernstein
(#ffb347). Tonart G (L3 BRANDUNG ist in F; `music.root` liest heute niemand, Plan 007 §1).

## Was sich gegenüber dem Prototyp geändert hat (und warum)

Jede Änderung ist gemessen. Die Varianten lassen sich über `buildLevel4(options)` nachbauen (Mess-Optionen
in `Level4Options`, der Default ist das gebaute Level).

1. **Crouch-Kanten 64 → 66 u.** Ohne Ducken reicht es aus der Auto-Hop-Landung bis ≈ 63.8 u
   (level-design Regel 12). Mit 64 u meldete der Validator 0,4 u Reserve (2 Warnungen). Die E3-Rampen sind
   dafür je 2 u flacher (+62 / +126), P3 bleibt auf 1088.
2. **Wendel-Fläche radial geteilt (r 864 und 1008).** Vier Ecken eines Wendel-Segments sind nicht koplanar,
   `Helix` zerlegt sie in zwei Dreiecke mit der Steigung der Innen- bzw. Außenkante: 14,3° und 8,1° im
   Wechsel. Mit der deterministischen Hang-Landung wird jede steile Bergauf-Landung ab ~650 u/s zum
   Rampslide, und das Tempo ist weg. Mit schmalen Ringen liegt die Planlinie auf 9–10,6°. Gemessen über
   25 Start-Jitter: perfekter Bot 28.78 → **26.89 s**. Pro Abschnitt: Start→CP1 6.08 → 5.53, CP1→CP2
   3.92 → 3.34, CP2→CP3 4.84 → 3.72 s. Ohne Teilung liegt die Skill-Spreizung Hand 3° / sync 1.0 nur bei
   1.14, also unter der Abnahme von 1.15. Kosten: 896 → 1390 Brushes.
3. **Trichter statt Zinnen an der Krone.** Die geraden Zinnen des Prototyps stoppten jeden, der seitlich
   versetzt anlief. Probe `funnel` auf dem Prototyp-JSON mit der finalen Physik: 8/8 Anläufe neben dem Brett
   bleiben an der Zinne stehen. Jetzt laufen Schrägwände (120 u) von der Bande zum Brettrand, und 8/8 gleiten
   aufs Brett. Mit einer 8-u-Schräge (≈ Zinne) bleiben 5/8 stehen.
4. **Sprungbrett quer 16–256 u** nördlich des Grats (Prototyp 32–320, erster Build 48–288). 48–288 hielt vom
   CP4-Spawn 80/80, der Prototyp 77/80. Mit Anlauf vom Steg (Review-Runde 2) trafen Surfer mit Kurs nach Norden die
   Flanke zu tief: 144/150 → mit 16–256 **148/150**, Spawn weiter 80/80, Trichter 8/8. Siehe "Drop-In".
5. **Wendel-Unterseite aufgehellt.** Vom Start aus war die Unterseite eine dunkle Scheibe (Umgebungslicht von
   unten × Fake-AO). Jetzt gibt es zwei Natrium-Lichtleisten je Wendel-Segment, und `ambientGround` ist
   angehoben. Jedes Leistenstück hängt so tief, dass seine Hüllbox die Fläche nicht schneidet: an steilen
   Stücken bis ~20 u, auf Podesten 1 u. Mittlere Luma im Band der Unterseite (Start-Blick wie game-01,
   HUD-freies Low-Res-Bild, beide im selben Lauf nach dem letzten Build): Prototyp **11.28 → 27.74 (× 2.46)**.
6. **Grabensohlen ohne Trims.** Die Sohle steigt von der Grabentiefe (damals 72 u, 26–33°; seit der dritten Runde
   24 u, ~18°) bis bündig an die Landekante und ist verwunden. Im Prototyp bekam jede Dreiecksfuge ein Leuchtband, und quer durch die Grube lief ein rotes
   Zickzack. Jetzt ist die Sohle dunkles Metall ohne Trims. Die Absprungkante (Bahn davor) und die Kante der
   Außenbahn darüber tragen weiter ihre Trims.
7. **Kein Schatten-Knoten-Workaround.** Podest-Trigger sind nur 160 u hoch, und `physics.resumeIndex` prüft die
   Höhe. `dropShadowNodes` ist entfallen.
8. Tonart G statt F. Die Knoten liegen per Hull-Trace auf der Fläche (`placeNodes`). Die Ziel-Lücke ergibt
   sich aus dem gemessenen Launch-Band (`finishAfterLaunch`): 504 u (Prototyp 496).

### Erste Review-Runde (28.09.)

9. **Clip über der Bande, Kill-Ring dahinter.** Die 80-u-Bande (Prototyp und erster Build) hielt nicht:
   Crouch-Jump + Kanten-Assist reichen selbst bis 80 u, am Hang trifft die AABB-Hull die Bande mit der Talecke,
   bergab kommt der Höhenverlust des Hangs dazu. Altes JSON (Reviewer-Probe, 5472 Läufe): Crouch-Hop bergauf
   267/912 hinaus, bergab Crouch-Hop 747/912; am Steg 99/504 über den 80-u-Clip, danach bis 8 s freier Fall.
   Jetzt: unsichtbarer Clip auf jedem Bandenstück bis 256 u über der Bahn (`CLIP_H`), Dach 40 u nach innen
   (n.y 0.62), Steg/Krone mit derselben Hülle; Kill-Ring 64 u außerhalb der Bande und 150 u unter der tiefsten Bahn
   je 15°-Stück (`safeKill` prüft beim Bau den Abstand zu jeder Etage). Reviewer-Probe neu: 0/5472 hinaus; eigene
   Probe `bandeEscape`: 3360 Läufe, 0 hinaus, 0 oben. Sichtbar ändert sich nichts.
10. **Absprungmarke vor den Crouch-Kanten** (in der zweiten Runde ersetzt, siehe 15).
11. **`prepLessons: ['t6', 't7', 't8']`.** K1/K2 verlangen den Crouch-Jump (W- und W+Leertaste-Anfänger stauen
    an K1), die Abfahrt verlangt Surfen.
12. **Proben/Tests:** `helixBoard` auch 45°/65° schräg nach außen; `bandeEscape` (Fehler, mit Gegenprobe ohne Clip im
    Test); teurer Anprall an den Crouch-Kanten (Warnung ab 40 %).

### Zweite Review-Runde (29.09.)

13. **Kein Knoten auf dem Sprungbrett.** Der Knoten "Absprung" (128 u auf dem Brett) war kein Surf-Knoten; der Bot
    sprang auf der Krone ab und bremste 4 Ticks per S, um dort zu landen (745 → 436 u/s), danach flog er ~2 s ohne
    Surf-Kontakt. Ohne den Knoten: alle Bots ~1.1 s schneller (sync 1.0 26.35 → 25.22 s, Hand 3° 32.08 → 30.97 s),
    Medaillen −1.1 bis −1.3 s. Krone (v 0) → erster Surf-Knoten (v ≈ 3 nördlich des Grats) läuft ohnehin über das Brett.
    CP4 setzt jetzt direkt mit dem ersten Surf-Knoten fort (Test "gestapelt").
14. **Medaillen-Wächter** (Probe `surfMedal`, Test): siehe "Medaillen und Abfahrt". Rot.
15. **Absprungband statt ↑C-Glyph.** Der Glyph lag Hull-Front 32–238 u vor der Wand und galt erst ab 450 u/s: bei
    250 u/s prallte ab, wer ab 161 u vor der Wand sprang — genau die Langsamen, die die Marke brauchen
    (Wiederholer nach einem Anprall, Neulinge ~320 u/s, Respawn an CP2). Jetzt, parallel zur Wand:
    - **durchgehendes Band Hull-Front 32–104 u** (`TAKEOFF_NEAR`, Eisblau): sauber bei jedem Tempo von 250 bis 950 u/s;
    - **drei Streifen 112–208 u** (`TAKEOFF_FAR`, dunkleres Eisblau): sauber ab 450 u/s.

    Semantik wie T6 ("am Band springen"). Das ↑C steht weiter an der Wand. Im Spiel angesehen: aus 600 u eine helle Linie
    vor der ↑C-Wand, aus 350 u Streifen → Band → Wand (liest sich wie ein Absprungbalken).
16. **Warnstreifen vor den Gräben** (Bernstein, schräg, 4 je Graben, nur Optik). Die Innenlinie las sich von CP1 aus
    als normale Innenkurve. Eine echte Risiko-Wahl ist mir nicht gelungen (siehe "Innenbahn").
17. **Drop-In-Probe** mit Anlauf vom Steg und Kursfehler, Achse der Abfahrt statt `routeAxis`; Brett 16–256 (siehe 4).
18. **Proben/Tests:** Absprungband ab 250 u/s (vorher erst ab 450), "≥ 20 % kürzer" aus dem gefahrenen Weg statt
    `1 − 752/1000`, Warnstreifen, Medaillen-Wächter.

### Dritte Runde (29.09., nach der Integration)

Geprüft am Stand nach Phase 3: die Befunde "Absprung-Knoten", "↑C-Marke ab 250 u/s", "Drop-In mit Anlauf" und die
Testlücken (a)–(c) der Review waren schon umgesetzt, der Medaillen-Befund durch die Integration (`level4Reference`,
Medaillen-Wächter grün: Autor 23.76 s gegen Hybrid 23.72 + 0.61 s).

19. **Innenbahn entschärft: Gräben 24 statt 72 u tief** (Breiten 16/18/20° unverändert). Auf dem 12°-Hang trifft man
    die Gräben fast immer (#166); die Tiefe bestimmt, was das kostet: die Sohle steigt von der Grabentiefe bündig zur
    Landekante, bei 72 u 26–33° steil — eine Landung darauf wirft hoch (800 → 517 u/s). Bei 24 u (~18°) nicht mehr.
    Tabelle unter "Innenbahn". Route, Medaillen und alle Bot-Zeiten unverändert (die Route läuft außen).
20. **Innenbahn als Wahl** (Probe + Test `laneChoice`): W + Leertaste innen muss bei 320 u/s ≥ 0.3 s schneller sein
    und darf bei keinem Tempo > 0.5 s langsamer sein (sonst Falle); Gegenprobe im Test: die alten 72-u-Gräben fallen durch.
21. **Rettung aus dem Graben** zählt jetzt ab "wieder auf Bahnhöhe hinter dem Graben", am Boden oder im Hop darüber.
    Das alte Kriterium "am Boden" maß die Hop-Phase mit: aus dem Stand landete ein Hop 0.5° vor tb + 1 auf der Bahn,
    gezählt wurde erst der nächste (1.45 → 2.05 s). Mit 24-u-Gräben alt max 2.02–2.05 s, neu Ø 0.79 / max 1.58 s
    (72 u: neu Ø 0.83 / max 1.55 s); ohne Graben aus dem Stand dieselbe Strecke 1.45–1.55 s.
22. **Crouch-Kanten-Lotterie** — geometrisch nicht behebbar, Hebel in der Physik (siehe "Crouch-Kanten"). Geometrie
    unverändert.
23. **Tests:** Innenbahn als Wahl + kein Tod + Rettung ≤ 2 s (mit Gegenprobe), Anfänger W + Leertaste + Ducken ohne
    Tod bis CP4 in ≤ 45 s. 21 Tests.

## Messungen

### Bots (Spiel-Uhr, Median Seeds 1–8)

| Modell | CP1 | CP2 | CP3 | CP4 | CP5 | Ziel | Tode |
|---|---|---|---|---|---|---|---|
| sync 1.0 | 5.53 | 8.88 | 12.59 | 16.76 | 19.38 | **25.22** | 0 |
| sync 0.9 | 5.77 | 9.46 | 14.47 | 18.84 | 21.62 | 28.23 | 0 |
| sync 0.8 | 5.93 | 9.83 | 13.74 | 18.43 | 21.10 | 27.80 | 0 |
| sync 0.7 | 6.16 | 10.27 | 14.88 | 19.38 | 22.42 | 29.34 | 0 |
| Hand 1° | 5.61 | 9.13 | 12.66 | 16.89 | 19.82 | 26.29 | 0 |
| Hand 1.5° | 5.70 | 9.38 | 14.46 | 18.77 | 21.67 | 28.28 | 0 |
| Hand 2° | 5.80 | 9.66 | 14.66 | 19.02 | 21.99 | 29.13 | 0 |
| Hand 3° | 6.11 | 10.41 | 15.52 | 19.95 | 23.52 | **30.97** | 0 |

Bis CP4 unverändert gegenüber der ersten Runde (Aufstieg nicht angefasst). Die Skill-Reihenfolge ist in E3 nicht
monoton (sync 0.9 langsamer als sync 0.8, Hand 1.5° langsamer als Hand 1°): Phasen-Lotterie an K1/K2, siehe
"Crouch-Kanten". Perfekter Bot über 49 Start-Jitter (build.ts): Median **25.72 s** (24.89–27.70), ein Zweig.
Prototyp (alte Physik): sync 1.0 26.91 s, Hand 3° 32.59 s.

Tempo an Schlüsselstellen (u/s, Median Seeds 1–8, `runRoute`):

| Modell | CP1 | CP2 | K1 | K2 | CP3 | Krone | Launch |
|---|---|---|---|---|---|---|---|
| sync 1.0 | 779 | 818 | 853 | 925 | 403 | 749 | **1010** |
| sync 0.8 | 693 | 793 | 820 | 606 | 391 | 629 | 934 |
| Hand 1° | 752 | 847 | 868 | 907 | 404 | 719 | 954 |
| Hand 3° | 627 | 644 | 628 | 551 | 556 | 600 | 839 |

Launch ist das Tempo des Route-Bots; ein Grundtechnik-Surfer (Blick 0° entlang der Achse) launcht ab dem CP4-Spawn
mit ~1510 u/s, in der Hybrid-Probe (ab CP4) im Median 1403 u/s.

Surf-Raster: abf1a→CP5 90/90, abf2→CP5 108/108, abf3→Ziel 90/90, abf4→Ziel 108/108, abf5a→Ziel 108/108,
jeweils 0 Nahtstopps. Grundtechnik-Surfer aus dem Stand: an CP4 767/681 u/s, an CP5 1180/729 u/s (Blick 0°/2°).
Knappste Sprung-Reserve 13 % (Launch → Ziel). Finale aus dem CP5-Respawn: Weitenreserve 96 % bei Blick +2°.

### Design-Proben (`probes/level4.ts`, laufen in `levels:check`)

- **Bande** (`helixBoard`, θ 10–530 × r 700/900/1100 × 320/600/900 u/s × Blick 0/±25/45/65°): 1170
  Geradeaus-Hüpfer, 0 Tode, 0 Abstürze > 150 u, 0 Luft-Hänger > 0,25 s. Größter Höhenverlust 0 u (mit 72-u-Gräben 14 u).
- **Bande/Clip nach außen** (`bandeEscape`, Wendel 15 θ × r 1020/1110, Steg/Krone u 150–1200 beidseitig; Hop,
  Crouch-Hop, Ducken gehalten; 0/30/60/80° zur Wand, bergauf/bergab; 0–900 u/s): 3360 Läufe, **0 hinaus, 0 auf der
  Bande**, Füße an der Bande höchstens 161 u über der Bahn (Clip bis 256).
- **Crouch-Kanten** (Crouch-Hüpfer mit gehaltener Leertaste, 250–900 u/s × 3 Radien × 8 Phasen über einen
  ganzen Hop): **240/240** in ≤ 4 s oben (Ø 1,4–2,8 s). **Ohne Ducken 0/240.** 0 Tode. Teurer Anprall (oben mit
  < 60 % Tempo) 6–9/24 je Kante und Tempo, also 25–38 %. Die Probe warnt über 40 % ab 550 u/s.
- **Absprungband** (`duckMarkJumps`, 5 Stellen über die Tiefe × 3 Radien über die Breite, Abstand senkrecht zur
  Wand): durchgehend **240/240** bei 250/320/400/450/550/700/850/950 u/s, Streifen **150/150** bei 450–950 u/s.
- **Innenbahn**: gefahren **25 % kürzer** (W+Leertaste 450 u/s: innen 1691 u gegen außen 2243 u). 40
  Geradeaus-Hüpfer ohne Tod (0,40 Grabenlandungen pro Lauf, mit 72-u-Gräben 1,57). Rettung aus dem Graben Ø 0,79 s,
  max 1,58 s (Kriterium seit der dritten Runde: wieder auf Bahnhöhe).
- **Innenbahn als Wahl** (`laneChoice`, W+Leertaste innen r 752 minus außen r 900 bis P2, 16 Phasen): 320 u/s
  −0,90 s, 450 −0,63, 550 −0,12, 650 +0,17, 800 +0,19, 950 +0,10 s. Warnung, wenn innen bei 320 u/s nicht ≥ 0,3 s
  schneller oder bei einem Tempo > 0,5 s langsamer ist.
- **Anfänger** (Blick auf den nächsten Knoten, mit Respawn):
  - W: CP1 10,2 s, CP2 18,9 s, 0 Tode, danach Stau an K1.
  - W+Leertaste: CP1 11,0 s, CP2 19,8 s, 0 Tode, Stau an K1. Der Coach zeigt dort den Crouch-Hinweis (Test).
  - W+Leertaste+Ducken: CP1 11,1 s, CP2 19,8 s, CP3 28,9 s, **CP4 36,7 s, 0 Tode bis CP4**. Danach 1 Tod in der
    Abfahrt, weil die Surf-Technik fehlt.
- **Drop-In**: Grundtechnik-Surfer an CP5 — ruhig am CP4-Spawn **80/80** (Ø 3,5 s), mit Anlauf vom Steg **148/150**.
  Trichter 8/8.
- **Tempo**: sync 1.0 25,22 s, Hand 3° 30,97 s (× 1,23), Launch (Bot) 1010 u/s.
- **Medaillen gegen Grundtechnik-Surfen** (`surfMedal`, 7 Start-Jitter): Medaillen-Bot 25,45 s, Hybrid 23,72 s,
  Autor 23,76 s ≤ 23,72 + 10 % der Abfahrt (0,61 s) — grün, seit `build.ts` die Hybrid-Referenz nimmt.

### Medaillen und Abfahrt (Review 29.09., kritisch)

Bis zur Integration maß `build.ts` Gold/VELOCITY/Autor mit dem perfekten RouteFollower (Median über 49 Start-Jitter).
Der surft die Abfahrt deutlich langsamer als ein Grundtechnik-Surfer (A/D in die Rampe, Blick entlang der Achse, in der
Luft keine Eingabe) — die Medaillen beschrieben den Bot, nicht das Level.

**Ursache** (gemessen mit einer instrumentierten Kopie des RouteFollowers im Scratch, Start am CP4-Spawn mit 745 u/s):
`RouteFollower.pushInto` drückt entlang −n_h der Flanke. Auf Rampen mit fallender Achse kippt die Flankennormale in
Fahrtrichtung (10°: n = (0.088 längs, 0.863 quer, 0.498 hoch)); −n_h zeigt dann ~10 % gegen die Fahrt, jeder Druck
bremst. Zeit ab CP4 bis zum Ziel: Bot 9.15 s (davon Druck in der Luft −457 u/s, Druck auf der Flanke −372 u/s); Bot mit
"nur quer zur Fahrt drücken" (Anteil gegen v_h entfernt) **5.32 s**; Grundtechnik-Surfer 6.13 s (Blick 0°), 5.73 s
(Blick −3°). Tiefere/flachere Surf-Knoten, weniger Knoten: 7.9–9.3 s — die Route kann das nicht reparieren.

**Stand nach der Integration** (Spiel-Uhr, Hybrid = RouteFollower bis zum ersten Boden-/Flankenkontakt nach CP4,
dann Surfer mit Blick 0° auf der exakten Achse; `build.ts` nimmt je Medaille den schnelleren Median):

| Modell | Route-Bot | Hybrid | Medaille (gebaut) |
|---|---|---|---|
| sync 1.0 (49 Jitter) | 25.72 | **23.76** | Gold 26.2 / VELOCITY 25.0 / Autor 23.76 |
| Hand 2° (48 Seeds) | 28.52 | **25.91** | Silber 27.3 |
| Hand 3° (48 Seeds) | 31.48 | **27.33** | Bronze 28.7 |

Der Medaillen-Wächter ist grün (Autor 23.76 gegen Hybrid 23.72 + 0.61 s). Die Medaillen-Logik selbst gehört der
nächsten Phase; für sie die Diagnose, **wo und warum der RouteFollower in der Abfahrt verliert** (3. Runde, gleicher
Lauf bis zur Übergabe, dann getrennt; 7 Start-Jitter, Scratch `fx4-l4/e3.ts`):

| ab Übergabe (sync 1.0) | Ziel | Flanken-Kontakt | Δv in Luftphasen | Launch |
|---|---|---|---|---|
| RouteFollower | 7.52–8.61 s (Median 8.41) | 4.7–5.3 s | −176 … −231 u/s | 995–1040 u/s |
| Grundtechnik-Surfer | 5.02–6.98 s (Median 6.13) | 1.3–2.8 s | +74 … +308 u/s | 1204–1524 u/s |

Beispiel Jitter 24 (Zeit ab Übergabe / Tempo): x −3600 (Ende d2) Bot 3.43 s / 791 u/s, Surfer 2.93 s / 813;
x −4600 (d3, 14°) 4.70 / 838 gegen 4.16 / 813; **x −5600 (d4, 16°) 5.98 / 737 gegen 5.15 / 1135**; x −6600 (Kicker 25°)
7.26 / 902 gegen 5.98 / 1425. Auf d4 und im Kicker verliert der Bot Tempo, während der Surfer beschleunigt. Ursachen
(`src/player/bots/RouteFollower.ts`):
- **Höhenregler auf die Knotenlinie** (`surf`: Surf-Knoten 320 u unter dem Grat + `SURF_LINE_LIFT`): er klebt tief an
  der Flanke und drückt, sobald er schneller sinkt als gewollt, per `pushInto` entlang −n_h. Auf fallender Achse
  (10–25°) zeigt −n_h 9–25 % gegen die Fahrt — jeder Druck bremst (10°: n = (0.088 längs, 0.863 quer, 0.498 hoch)).
- **Luft:** zwischen den Flanken strafet er zum nächsten Knoten (`ctl.air` mit `airHeading`) und drückt schon vor dem
  Aufsetzen in die vorhergesagte Flanke (`surfAhead`) — netto −176…−231 u/s. Der Surfer gibt in der Luft nichts ein
  und setzt höher auf der nächsten Flanke auf (Fallhöhe wird Tempo; Δv inkl. Aufsetz-Tick).
- "Nur quer zur Fahrt drücken" (siehe oben, 5.32 s) ließ den perfekten Bot auf L3 nicht mehr ins Ziel (#163) — ein
  Umbau des Bot-Surfens ist Arbeit über alle Level, kein Einzeiler.

Messfallen: `routeAxis` verbindet Surf-Knoten auf verschiedenen Tiefen und liegt bis ~8° neben der Rampe — der
"Blick 0°" des Surfers war dort ~1° von der Rampe weg und 0.3–1 s schneller (Review: 5.8–5.9 s). Die Proben nehmen
jetzt die Achse der Abfahrt (Steg-yaw). Übergabe an den Surfer beim ersten Boden-/Flankenkontakt: nur Boden reicht
nicht (in 3/7 Starts hüpft der Bot über die Krone), schon beim CP4-Eintritt übernimmt der Surfer den Lenkwinkel des
Bots (bis 9° nach Norden) und stirbt am Fuß der Nordflanke.

### Crouch-Kanten: wo das Tempo bleibt

**Mit gehaltener Leertaste ist jede Crouch-Kante ≥ 66 u eine Phasen-Lotterie.** Man springt dort ab, wo man
landet. Oben ist man nur bei Wandkontakt ≈ 0–0,56 s nach dem Absprung, und ein Hop dauert 0,755 s. Frühen
Kontakt gibt das Kanten-Gedächtnis zurück, späten (schon im Fallen) nicht. Deshalb prallen auch von einer
flachen Terrasse, die länger als ein Hop ist, **≥ 25 %** ab, egal wie schnell. Gebaut (Terrassen 25°, 391 u)
misst die Probe 25–38 %. Das widerspricht dem Plan-Leitprinzip "Momentum geht nie durch Tick-Phase verloren" und
kehrt die Skill-Reihenfolge in E3 um (sync 0.9 5.0 s gegen sync 0.8 3.9 s CP2→CP3). **Ein Ausweg in der
Geometrie existiert nicht** (dritte Runde, unten); der Hebel liegt im Kanten-Gedächtnis (Physik).

**Timing hilft, und das zeigt das Absprungband.** Crouch-Jump von der Terrasse, Raster 5 Radien × 8-u-Schritte der
Hull-Front vor der Wand, sauber = oben mit ≥ 90 % Tempo auf allen Radien:

| Tempo (u/s) | 200 | 250 | 320 | 400 | 450 | 550 | 700–950 |
|---|---|---|---|---|---|---|---|
| sauber bei Hull-Front (u) | 16–80 | 16–104 | 16–144 | 16–168 | 24–208 | 24–256 | 32–≥ 280 |

Das durchgehende Band (32–104 u) gilt für jedes Tempo ab 250 u/s, die Streifen (112–208 u) ab 450 u/s.

**Wer in die Marke rutscht, statt sofort zu springen**, kommt auch bei Tempo sauber hoch: Leertaste los, C halten
(Rutschen ab 280 u/s, Reibung 0.3·v + 80 statt Boden-Reibung), im Band springen (Sprung aus der Rutsche =
Crouch-Jump).

**Kosten des Anpralls — Gabelung statt Varianten-Vergleich.** Der perfekte Bot prallt an K2 in **49/49** Starts ab: er
landet ~475 u vor K2 (Hull-Front) mit ~930 u/s und springt sofort geduckt (Kontakt nach 0.52 s, zu spät). Gabelung
genau an dieser Landung, gleiche Geometrie: (A) Bot weiter — Anprall 932 → ~110 u/s, oben ~300 u/s; (B) Leertaste los +
C, rutschen, bei Hull-Front ≤ 90 u Crouch-Jump, oben übernimmt wieder der Bot — oben ~770 u/s.

| über 49 Starts (Median) | CP3 | Ziel |
|---|---|---|
| (A) Anprall | 12.60 s | 25.72 s |
| (B) Rutschen → Band | 12.14 s | 25.05 s |
| Differenz | **0.46 s** | 0.67 s |

Robust über die Absprungstelle 60/90/104 u (0.42/0.46/0.48 s bis CP3). Die frühere Zahl "K2 sauber spart ~1.8 s" kam
aus einer Variante mit K2 = 40 u (chaotisch; die Review-Variante K1 = K2 = 40 u war sogar 0.7 s langsamer als gebaut)
und ist ersetzt: **die Medaillen enthalten den K2-Anprall mit ~0.5 s**.

**Route-Knoten helfen dem Bot nicht:** Knoten ohne Sprung auf der Terrasse (200/300/400 u vor der Wand) und der
Crouch-Knoten bei 70–200 u (`terraceNode`, `crouchBack`): K2-Anprall weiter 13/13 (13 Jitter), mit dem Terrassen-
Knoten 200 u prallt der Bot zusätzlich an K1 ab (13/13, CP2→CP3 5.3 statt 3.7 s). Der RouteFollower passiert Knoten
in der Luft und springt dort ab, wo er landet; auch längere/kürzere Terrassen (18–36°) oder eine andere Rampenteilung
verschieben nur die Phase (K2 12–13/13).

**Dritte Runde: warum keine Geometrie hilft — und wo der Hebel liegt.** Die Hop-Phase bleibt im freien Flug erhalten,
mit gehaltener Leertaste ist jede Landung sofort der nächste Absprung: die letzte Absprungstelle vor der Wand ist über
eine ganze Hop-Länge verteilt. Geduckt sind die Füße nur 0.19–0.565 s nach dem Absprung über 61 u (66 − 5 Lip-Step), ein
geduckter Hop dauert 0.81 s → ≥ 30 % später Kontakt (wer erst an der Wand duckt: 25 %). Was die Geometrie dagegen tun kann:

| Ansatz | Ergebnis |
|---|---|
| Terrassen 25/30/35/40/45°, 40° mit Rampe +40, 50/45° (`crouchEdges`, 240 Läufe) | 81 (gebaut) / 77 / 74 / 83 / 88 / 71 / 78 teure Anpraller — bei 40–45° zusätzlich 2 Aufstiege ohne Ducken |
| Absprungfläche höher als die Terrasse (Stufe, Gefälle zur Wand) | verlängert das Fenster, aber ohne Ducken reicht es dann (63.5 u + Stufe > 66) — bricht die Crouch-Pflicht (gerechnet) |
| Stufe/Leiste am Wandfuß (Neu-Hop startet höher) | dieselbe Stufe trägt den Hop ohne Ducken hinauf (gerechnet) |
| Decke vor dem Band als Takt-Anker (kappt die Hops) | eng genug erst mit ~2 u Kopffreiheit (Hop 0.08 s → Sprung-/Landeton 13×/s, Kopf-Bonks), Deckenstirn = neuer Anprall — nicht gebaut |

**Der Hebel ist das Kanten-Gedächtnis** (`MovementConfig.ledgeMemory`, fremder Pfad): seine Ticks laufen nur in der
Luft. Ein später Anprall verbraucht die 0.2 s im Fallen bis zur Terrasse und im neuen Hop bis über die Kante (~0.19 s)
— das Tempo kommt nie zurück. Probe `crouchEdges` mit anderem `ledgeMemory` (nur Messung, Config im Scratch):

| ledgeMemory | 0.2 s (gebaut) | 0.3 s | 0.45 s | 0.6 s |
|---|---|---|---|---|
| teure Anpraller (240) | 81 | 55 | **11** | 3 |
| ohne Ducken oben | 0 | 0 | 0 | 0 |

Design-Proben L1–L4 mit 0.45 s: dieselben Befunde wie mit 0.2 s (L1 0/0, L2 0 F/1 W bekannte Kerbe, L3 0/0, L4 0/0);
mit 0.6 s holt der L4-Medaillen-Bot seinen K2-Anprall zurück, die gebauten Medaillen wären dann zu lasch. Nicht
gemessen: `npm run sim`, Movement-Tests, T6, Treppen-Doppelanprall (movement.md §5). Entscheidung beim Movement-Owner
bzw. Lead (movement.md §5 und movement-tuning.md mitziehen).

### Innenbahn: entschärft — eine Wahl nach Tempo

**Dritte Runde: Gräben 24 statt 72 u tief.** W+Leertaste-Hüpfer (Blick tangential, 16 Phasen), Zeit innen r 752 minus
außen r 900 bis P2 (Median; in Klammern: Läufe innen mit Grabenlandung):

| Grabentiefe | 320 | 450 | 550 | 650 | 800 | 950 u/s |
|---|---|---|---|---|---|---|
| 72 u (bis zur 2. Runde) | −0.81 (16) | +0.49 (16) | +0.80 (13) | +1.02 (15) | **+1.33** (12) | +0.20 (0) |
| 48 u | −0.89 | +0.13 | +0.61 | +0.76 | +0.32 | +0.15 |
| 40 u | −0.90 | +0.07 | +0.43 | +0.59 | +0.44 | +0.01 |
| 32 u | −0.90 | −0.32 | +0.15 | +0.45 | +0.26 | +0.06 |
| 28 u | −0.90 | −0.48 | +0.02 | +0.37 | +0.08 | +0.03 |
| **24 u (gebaut)** | **−0.90** (16) | **−0.63** (12) | **−0.12** (9) | **+0.17** (13) | **+0.19** (4) | **+0.10** (0) |
| 20 u | −0.90 | −0.63 | −0.20 | +0.28 | +0.03 | +0.02 |
| ohne Gräben | −0.90 | −0.63 | −0.52 | −0.29 | −0.08 | −0.03 |

Mit 24 u ist die Innenlinie für Neulinge (W+Leertaste 320–450 u/s) 0.6–0.9 s schneller, für Strafer (650–950 u/s)
höchstens 0.19 s langsamer — kürzer, aber steiler und holprig. Das ist eine ehrliche Wahl nach Tempo, keine Falle mehr
(vorher bis +1.33 s). Die Gräben liegen weiter in der Linie (Neuling 16/16 mit Grabenlandung), sie kosten nur wenig: die
Sohle steigt bei 24 u ~18° statt 26–33° und wirft nicht mehr hoch. Warnstreifen bleiben (holprig, nicht frei). Grabenbreite
16° statt 16/18/20°: praktisch gleich (+0.20 s max), gebaut bleiben die alten Breiten. Im Spiel angesehen (Port 5402,
`fx4-l4/shots/01–04`): Graben als flache Mulde mit roter Kante, Warnstreifen davor, 0 Konsolenfehler.

Bots mit Route über die Innenbahn (24 u, CP1→CP2, Median Seeds 1–8): innen, Bot entscheidet sync 1.0 4.02 / sync 0.8
3.95 / Hand 1° 4.54 / Hand 2° 3.98 / Hand 3° 4.34 s; mit Absprungknoten 4.14 / 4.04 / 4.31 / 4.16 / 4.35 s; außen (gebaut)
3.34 / 3.77 / 3.52 / 3.93 / 4.45 s. Der RouteFollower ist auf der Innenlinie kein gutes Modell (Stop-and-Go vor Gräben,
#132) — die Wahl misst `laneChoice` mit W+Leertaste.

**Bis zur zweiten Runde** (72-u-Gräben) — Abschnitt CP1→CP2 (s, Median Seeds 1–8, erste Runde):

| Route | sync 1.0 | sync 0.8 | Hand 1° | Hand 2° | Hand 3° |
|---|---|---|---|---|---|
| außen (gebaut) | **3.34** | **3.77** | **3.52** | **3.93** | 4.45 |
| innen, Bot entscheidet | 3.47 | 4.10 | 4.80 | 4.06 | 4.51 |
| innen mit Absprungknoten | 4.94 | 4.31 | 4.78 | 4.07 | **4.45** |

**Warum die Gräben fast immer treffen:** Auf dem 12°-Hang der Innenbahn ist ein Hop bei 450–900 u/s nur 230–263 u
lang (die Landung kommt auf dem steigenden Boden früher) und hebt sich bei 800 u/s nur ~10 u über den Hang. Die Gräben
sind 210–262 u breit — sauber drüber kommt nur ein schmales Phasenfenster. Knapp daneben trifft man die steigende
Sohle: sie wirft einen hoch und bremst (800 → 517 u/s).

**Varianten für eine echte Risiko-Wahl** (Ziel: sauber innen schneller, Grabenlandung teuer):

| Gräben | sauber (von 16) bei 550/650/800 u/s | sauber gegen außen | mit Graben gegen außen |
|---|---|---|---|
| 3 × 8°, Rampe, 48 u tief | 16/15/16 | −0.52/+0.18/+0.69 | –/+1.64/– |
| 5 × 8° im Hop-Takt, Rampe 48 u | 14/8/16 | −0.59/−0.32/+0.54 | +1.36/+1.42/– |
| 3 × 6°, Rampe 40 u | 16/16/16 | −0.52/−0.07/+0.67 | – |
| 3 × 8°, flache Grube 48 u | 12/7/10 | −0.65/−0.32/−0.26 | +2.55/+3.08/+3.65 |
| 3 × 12°, flache Grube 48 u | 9/4/3 | −0.71/−0.49/−0.40 | +3.24/+3.81/+3.41 |

Schmale Rampen-Gräben kosten auch saubere Läufe bei 800 u/s (Sohlen-Wurf); flache Gruben machen saubere Läufe
schneller, aber knapp daneben prallt man an der senkrechten Landekante ab (800 → 100 u/s, +2.5–4 s) — das ist
eine zweite Crouch-Kanten-Lotterie, keine Wahl. Zweite Runde: Geometrie blieb, dazu **Bernstein-Warnstreifen** auf der
Innenbahn vor jedem Graben (vier schräge Streifen, 10–56 u vor der Kante, nur Optik). Dritte Runde: statt Risiko-Wahl
(mit 72 u nicht erreichbar) eine **Wahl nach Tempo** über die Grabentiefe (oben).

### Drop-In

Probe `dropIn`, zwei Anläufe, Surfer ab dem Brettende:

| Brett (u nördl. des Grats) | ruhig am CP4-Spawn | Anlauf vom Steg (±160 quer, 400–800 u/s, Kurs ±8°, Blick 0/2°) |
|---|---|---|
| 48–288 (vorher) | 80/80 | 144/150 (6 Tode, alle Kurs −8° = nach Norden) |
| **16–256 (gebaut)** | **80/80** | **148/150** (2 Tode: 800 u/s, quer 0, Kurs −8°) |
| 24–216 / 16–200 | 80/80 | 147/150 / 150/150 |

Mit `routeAxis` als Surfer-Achse (so maß das Review) lag der alte Stand bei 137/150; mit der Achse der Abfahrt bei
144/150 (siehe "Messfallen" oben). Grat-Hänger (Spawn am Brettrand, Blick +5…+14° zur Rampe, 0–800 u/s): ab +8°
bleibt jeder Surfer stehen, **unabhängig von der Brettlage** (48–288, 24–216, 16–200, 32–320 gleich) — der Blick
bremst, nicht das Brett.

Dritte Runde, Hybrid (Hand klettert als RouteFollower, Surfer ab dem ersten Kontakt nach CP4), 32 Seeds je Modell: Hand 3°
1 Tod (Finale, CP5 → Ziel zu kurz), Hand 2° 1 Tod, Hand 1° 1 Tod — beide am Fuß der Nordflanke (x −2680…−2700,
z −1190…−1215), Übergabe mit Kurs **+7° bzw. +14° nach Norden** (Lenkwinkel des Bots, der Surfer lenkt in der Luft nicht),
also außerhalb des Probe-Bands ±8°. Kein Level-Befund; das Brett weiter nach Süden (16–200: Anlauf 150/150) bleibt die
Reserve, falls der Playtest Nord-Drift zeigt.

### Look und Leistung (echtes Spiel)

- **Shots der zweiten Runde** (Port 5342, Scratch `fx3-l4/shots/`): CP1 → E2 (Warnstreifen erkennbar), Innenbahn vor
  Graben 1 und 2, K1-Anlauf aus 600/350/180 u, K2-Anlauf aus 400/200 u (Streifen → Band → ↑C-Wand), Krone/Brett, Steg,
  Start, Übersicht. **0 Konsolenfehler.**
- **Frame-Zeit ohne 60-Hz-Deckel** nach der zweiten Runde (`--disable-gpu-vsync --disable-frame-rate-limit`, headless,
  Route-Bot sync 1.0, je 10 s, drei Runden abwechselnd, Port 5343): L4 Ø **0,57 / 0,55 / 0,61 ms** gegen L2 0,61 / 0,57 /
  0,65 ms (p95 0,8–1,0 ms beide), 0 Fehler. Szene L4 159 k Dreiecke / 14 Calls gegen L2 116 k / 13. Die Runde tauscht nur
  Markierungen: 20 neu (je Terrasse Band + 3 Streifen, 12 Warnstreifen), 18 Glyph-Rechtecke weg. Absolut schneller als in der ersten Runde
  (0,98 ms) — der Rechner streut, das Verhältnis zählt.
- Erste Runde (unverändert gültig): Luma der Unterseite Prototyp 11.28 → 27.74.

## Offen (Lead / Integration / Playtest S6)

- **Crouch-Kanten-Lotterie (Physik, fremder Pfad):** in der Geometrie nicht behebbar (siehe "Crouch-Kanten").
  `ledgeMemory` 0.2 → 0.45 s senkt die teuren Anpraller 81 → 11/240 bei gleichen Design-Proben L1–L4; vor einer
  Übernahme `npm run sim`, Movement-Tests, T6 und Treppen prüfen, movement.md §5/movement-tuning.md mitziehen, danach
  `levels:build` (die Medaillen enthalten heute den K2-Anprall des Bots, ~0.5 s). Coach-Hinweis nach einem teuren
  Anprall ("Leertaste los, am Band springen") wäre `src/engine/Coach.ts`.
- **Medaillen (nächste Phase):** `build.ts` nimmt min(Route-Bot, Hybrid) — die Diagnose, wo der RouteFollower in der
  Abfahrt verliert, steht unter "Medaillen und Abfahrt".
- **Innenbahn:** Plan 007 §3 "Gräben als Wahl" ist jetzt eine Wahl nach Tempo (Neuling innen, Strafer außen), keine
  Risiko-Wahl — Plan-Text anpassen oder im Playtest bestätigen.
- T6-Band (Hull-Mitte 100–180 u, gemessen in gerader Halle bei 320 u/s) und L4-Band (ab 250 u/s) haben dieselbe
  Semantik, aber andere Maße — Training-Strang prüfen, ob T6 den Hinweis "mit wenig Tempo näher an die Wand" braucht.
- Dritte Crouch-Kante (Plan 007 §4): nicht gebaut.
- Frame-Zeit auf echter bzw. schwacher GPU: L4 hat 1,7 × die Dreiecke von L2.

## Werkzeuge

```bash
npm run levels:build -- level4     # schreibt nur public/levels/level4.json (Medaillen über 49 Starts); danach voller Build für index.json
npm run levels:check -- level4     # Validator + Design-Proben (~20 s)
npx vitest run tests/level4.test.ts  # 21 Tests (~5 s)
```

`buildLevel4(options)` baut Mess-Varianten (`Level4Options`):
- `rings`, `seg`, `trenches`, `trenchDepth`, `trenchShape` ('ramp' | 'flat') (Wendel-Fläche und Gräben).
- `inner` ('jump' | 'free': E2-Route über die Innenlinie).
- `t1`/`t2`/`r0` (E3-Terrassen/Rampen), `vCrouch`/`crouchBack`, `terraceNode` (Knoten ohne Sprung vor jeder Kante).
- `d1`/`n1s`/`n1Depth`/`s2` (Abfahrt), `ridgeOff`/`funnelLen`/`board` (Krone).
- `underLights`/`underTint`/`ambientGround` (Look).
- `clipH` (80 = nur die sichtbare Bande wie vor dem Review), `killRing: false`.
- `measure: false` (ohne Surf-Messung, schnell, nur für Proben).

Die Proben lesen dieselben Maße über `level4Layout()`. Weicht das JSON vom Builder ab, meldet die Probe einen
Fehler, und der Test "JSON ist der aktuelle Build" schlägt fehl. Exportiert: `bandeEscape`, `crouchEdges`,
`duckMarkJumps` (+ `MARK_SPEEDS`/`MARK_SPEEDS_FAR`), `innerLane`/`lanePath`, `laneChoice` (+ `LANE_*`), `novice`,
`dropIn` (+ `DROP_APPROACH`, `descentAxis`), `funnel`, `tempo`, `surfMedal`, `level4Reference`; Builder:
`TAKEOFF_NEAR`/`TAKEOFF_FAR`, `TRENCH_DEPTH`.
