# 04 TURM — "Tempo ist Höhe."

Plan 007, Phase 2, Strang `level4`. Builder `tools/levels/level4.ts`, Proben `tools/levels/probes/level4.ts`,
Tests `tests/level4.test.ts`. Vorlage war der Prototyp `tools/critique/v2/level4` (Entwurf in
`shots/v2/level4/`). Alle Zahlen hier sind gegen die **finale Phase-1-Physik** gemessen: Cap 40,
Lande-Gnade, Hang-Landung mit gestundetem Verlust, Kanten-Assist, Rutschen, Luftlenkung an.

**Stand 28.09.:** `levels:check -- level4` **0 Fehler / 0 Warnungen**. **Par 34 s**, Medaillen
**33.7 / 31.2 / 29.6 / VELOCITY 28.2 / Autor 26.83 s**. Spiel-Uhr, Median der Seeds 1–8: sync 1.0 26.35 s,
Hand 1° 27.20 s, Hand 3° 32.08 s (× 1.22). Jeder Bot kommt ins Ziel, niemand stirbt (8 Modelle × 8 Seeds).
Keine Pads, keine Boosts.

## Idee

Ein Funkturm bei Nacht über einer Stadt. Außen am Turm windet sich eine breite Wendel (512 u, Bande außen)
1,5 Umdrehungen nach oben. Die Wendel ist eine überall befahrbare, steigende Spiralrampe, also ein
"Velodrom nach oben": Man hüpft ohne Pause bergauf und kurvt dabei immer in dieselbe Richtung. Wer schneller
ist, steigt schneller. Oben führt ein Steg mit Geländer hinaus ins Nichts, danach kommt das Sprungbrett und
eine Surf-Abfahrt mit vier Drops: Jetzt gilt umgekehrt **Höhe ist Tempo**. Der Launch liegt bei ~1030 u/s
(sync 1.0), im Raster bis 1837 u/s.

Im Aufstieg kann man nicht sterben: Innen steht der Kern, außen eine 80-u-Bande (höher als der Crouch-Jump
mit 75 u). Die Gräben haben Auffang-Mulden, und wer an einer Crouch-Kante abprallt, landet auf der eigenen
Terrasse. Kill-Zonen gibt es nur in der Abfahrt, dicht unter dem Rampenfuß; der Respawn an CP4 bzw. CP5 liegt
1–4 s entfernt.

## Aufbau

Koordinaten: Kern-Mitte (0, 0), Y oben. θ ist der Fahrwinkel ab dem Südpunkt gegen den Uhrzeigersinn
(Kern links), φ = 270° + θ wie bei `lib.Ring`. Die Planlinie (Route) liegt bei r 896, in E2 außen bei r 1000.

| Abschnitt | θ (Grad) | Höhe (u) | Fähigkeit | Anmerkung |
|---|---|---|---|---|
| Anlauf | Süd, x −1500 → 0 | 0 | Einlaufen, erster Hop | Lücke 128 mit Mulde 40, Start-Chevrons |
| **E1 WENDEL** | 0–135 | 0 → 384 | bergauf hüpfen, einseitig kurven | Planlinie ~10° |
| P1 = **CP1** | 135–155 | 384 | — | flaches Podest |
| **E2 GRÄBEN** | 155–290 | 384 → 768 | Linienwahl | Teilung bei r 864: außen lückenlos mit Bande; innen (r 640–864) 25 % kürzer (r 752 gegen r 1000), drei Gräben 72 u tief mit Auffang-Mulde |
| P2 = **CP2** | 290–310 | 768 | — | |
| **E3 KANTEN** | 310–450 | 768 → 1088 | zwei Crouch-Kanten à **66 u** | Rampe +62 (310–335), Terrasse 25°, **K1 bei θ 360** (Südpunkt), Lippe ↑C 3°, Rampe +126 (363–425), Terrasse 25°, **K2 bei θ 450** (Ostpunkt) |
| P3 = **CP3** | 450–470 | 1088 | — | vorn 3° Lippe mit `duck`-Material |
| **E4 AUSLAUF** | 470–540 | 1088 → 1344 | Tempo holen | |
| STEG | ab Nordpunkt gerade nach Westen, 1100 u | 1344 → 1536 | Blick ins Nichts | unsichtbarer Clip + Geländer (Pfosten alle 96 u, Leucht-Handlauf auf 66–74 u) |
| KRONE = **CP4** | 200 u | 1536 | — | Trichter-Wände links und rechts des Bretts |
| Sprungbrett | 256 u, 10° abwärts | 1536 → 1491 | Drop-In | quer 48–288 u nördlich des Grats |
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
aussehen. Tonart G (L3 BRANDUNG ist in F; `music.root` liest heute niemand, Plan 007 §1).

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
4. **Sprungbrett quer 48–288 statt 32–320 u** nördlich des Grats. Der Prototyp warf am Südrand auf den Grat:
   Surfer mit Blick zur Rampe kletterten hinauf und hingen dort. Am Nordrand warf er tief an den Fuß. Drop-In
   bei 5 Versätzen × 4 Anläufen × 4 Blickfehlern: **80/80** gegen 77/80 (1 Tod, 2 Hänger am Grat; Prototyp-JSON
   und `board: [32, 320]` messen gleich).
5. **Wendel-Unterseite aufgehellt.** Vom Start aus war die Unterseite eine dunkle Scheibe (Umgebungslicht von
   unten × Fake-AO). Jetzt gibt es zwei Natrium-Lichtleisten je Wendel-Segment, und `ambientGround` ist
   angehoben. Jedes Leistenstück hängt so tief, dass seine Hüllbox die Fläche nicht schneidet: an steilen
   Stücken bis ~20 u, auf Podesten 1 u. Mittlere Luma im Band der Unterseite (Start-Blick wie game-01,
   HUD-freies Low-Res-Bild): Prototyp **11.28 → 27.64 (× 2.45)**.
6. **Grabensohlen ohne Trims.** Die Sohle steigt 26–33° von 72 u Tiefe bis bündig an die Landekante und ist
   verwunden. Im Prototyp bekam jede Dreiecksfuge ein Leuchtband, und quer durch die Grube lief ein rotes
   Zickzack. Jetzt ist die Sohle dunkles Metall ohne Trims. Die Absprungkante (Bahn davor) und die Kante der
   Außenbahn darüber tragen weiter ihre Trims (Shot 04 angesehen).
7. **Kein Schatten-Knoten-Workaround.** Podest-Trigger sind nur 160 u hoch, und `physics.resumeIndex` prüft die
   Höhe. `dropShadowNodes` ist entfallen.
8. Tonart G statt F. Die Knoten liegen per Hull-Trace auf der Fläche (`placeNodes`). Die Ziel-Lücke ergibt
   sich aus dem gemessenen Launch-Band (`finishAfterLaunch`): 504 u (Prototyp 496).

## Messungen

### Bots (Spiel-Uhr, Median Seeds 1–8; `levels:check`)

| Modell | CP1 | CP2 | CP3 | CP4 | CP5 | Ziel | Tode |
|---|---|---|---|---|---|---|---|
| sync 1.0 | 5.53 | 8.88 | 12.59 | 16.76 | 20.34 | **26.35** | 0 |
| sync 0.9 | 5.77 | 9.46 | 14.47 | 18.84 | 22.04 | 29.10 | 0 |
| sync 0.8 | 5.93 | 9.83 | 13.74 | 18.43 | 21.71 | 28.67 | 0 |
| sync 0.7 | 6.16 | 10.27 | 14.88 | 19.38 | 22.63 | 29.69 | 0 |
| Hand 1° | 5.61 | 9.13 | 12.66 | 16.89 | 20.53 | 27.20 | 0 |
| Hand 1.5° | 5.70 | 9.38 | 14.46 | 18.77 | 22.35 | 28.87 | 0 |
| Hand 2° | 5.80 | 9.66 | 14.66 | 19.02 | 22.43 | 29.70 | 0 |
| Hand 3° | 6.11 | 10.41 | 15.52 | 19.95 | 24.25 | **32.08** | 0 |

Prototyp (alte Physik): sync 1.0 26.91 s, Hand 3° 32.59 s. Perfekter Bot über 49 Start-Jitter: Median
26.82 s (26.23–29.84), **ein Zweig** (keine Zweig-Warnung). Abschnitte (Median / min / max): S→1
5.53/5.53/5.54, 1→2 3.34/3.33/4.31, 2→3 3.71/3.53/5.59, 3→4 4.18/4.14/4.86, 4→5 3.57/2.70/4.23,
5→Z 6.33/5.98/7.43.

Tempo an Schlüsselstellen (u/s, Median Seeds 1–8, `runRoute`):

| Modell | CP1 | CP2 | K1 | K2 | CP3 | Krone | Launch |
|---|---|---|---|---|---|---|---|
| sync 1.0 | 779 | 818 | 853 | 925 | 403 | 749 | **1032** |
| sync 0.8 | 693 | 793 | 820 | 606 | 391 | 629 | 925 |
| Hand 1° | 752 | 847 | 868 | 907 | 404 | 719 | 927 |
| Hand 3° | 627 | 644 | 628 | 551 | 556 | 600 | 833 |

Surf-Raster: abf1a→CP5 90/90, abf2→CP5 108/108, abf3→Ziel 90/90, abf4→Ziel 108/108, abf5a→Ziel 108/108,
jeweils 0 Nahtstopps. Grundtechnik-Surfer aus dem Stand: an CP4 692/605 u/s, an CP5 1180/729 u/s (Blick 0°/2°).
Knappste Sprung-Reserve 13 % (Launch → Ziel). Finale aus dem CP5-Respawn: Weitenreserve 96 % bei Blick +2°.

### Design-Proben (`probes/level4.ts`, laufen in `levels:check`)

- **Bande** (`helixBoard`, θ 10–530 × r 700/900/1100 × 320/600/900 u/s × Blick 0/±25°): 702
  Geradeaus-Hüpfer, 0 Tode, 0 Abstürze > 150 u (auch keiner, der am Ende noch fällt), 0 Luft-Hänger
  > 0,25 s. Größter Höhenverlust 14 u.
- **Crouch-Kanten** (Crouch-Hüpfer mit gehaltener Leertaste, 250–900 u/s × 5 Radien × 4 Phasen): **198/200**
  in ≤ 4 s oben (bei 250 u/s je 19/20, sonst 20/20; Ø 1,25–3,0 s). **Ohne Ducken 0/200.** 0 Tode.
- **Innenbahn**: 25 % kürzer. 40 Geradeaus-Hüpfer ohne Tod (1,57 Grabenlandungen pro Lauf). Rettung aus dem
  Graben Ø 1,10 s, max 1,84 s (Graben 1, aus dem Stand).
- **Anfänger** (Blick auf den nächsten Knoten, 150 s mit Respawn):
  - W: CP1 10,2 s, CP2 18,9 s, 0 Tode, danach Stau an K1.
  - W+Leertaste: CP1 11,0 s, CP2 19,8 s, 0 Tode, Stau an K1. Der Coach zeigt dort nach 2 Anprallern den
    Crouch-Hinweis (Test).
  - W+Leertaste+Ducken: CP1 11,1 s, CP2 19,8 s, CP3 28,9 s, **CP4 36,7 s, 0 Tode bis CP4**. Danach 1 Tod und
    Stau in der Abfahrt, weil die Surf-Technik fehlt. Das ist gewollt: L4 kommt nach L1-Rutsche, L2 und L3.
- **Drop-In**: 80/80 Grundtechnik-Surfer vom Sprungbrett an CP5 (Ø 3,4 s). Der Trichter lässt 8/8 Anläufe
  aufs Brett gleiten.
- **Tempo**: sync 1.0 26,35 s, Hand 3° 32,08 s (× 1,22), Launch 1032 u/s.

### Crouch-Kanten: wo das Tempo bleibt

Mit gehaltener Leertaste entscheidet die Landephase, wo man abspringt. Das Fenster für einen Crouch-Sprung
von der Terrasse ist bei 900 u/s etwa 190–450 u vor der Wand breit, der Hop davor ist aber ~420 u lang (bergauf).
Ein Teil der Anläufe prallt deshalb ab und steigt von der Terrasse neu auf (Abnahme "≥ 95 % oben in 4 s"
ist erfüllt):

- Crouch-Probe: 9–13 Anpraller pro 20 Läufe je Tempo.
- Perfekter Bot (49 Starts): prallt **an K2 in 49/49** Läufen ab (932 → ~110 u/s) und an K1 in 7/49.
- Die anderen Bots: Hand 3° an K1 6/8 und an K2 1/8; sync 0.8 an K1 4/8 und an K2 6/8.

Beim Bot sieht das so aus (Tick-Spur, Start-Jitter 24): Er setzt ~490 u vor K2 am Rampenende auf, 10 u unter
der Terrasse, und springt sofort geduckt ab. Der Scheitel liegt bei y 1087, 1 u unter der Kante. An der Wand
ist er schon auf 1078,5 gefallen, und für den 5-u-Lip-Step ist das zu tief. Eine längere Terrasse (30–40°)
verschiebt nur die Phase: K2 dann in 45–49/49 Läufen.
**Kosten:** Ist K2 nur 40 u hoch (also ohne Ducken zu schaffen), braucht der perfekte Bot im Median 25,01 statt
26,82 s. Wer K2 sauber nimmt, spart also bis ~1,8 s. Die Medaillen (Gold/VELOCITY/Autor) enthalten den
Anprall, und ein Mensch mit gutem Timing schlägt sie entsprechend leichter. Das ist bewusst so: Hier lohnt
Präzision. Phase 3 und der Mensch-Playtest (S6) sollen es trotzdem ansehen.

### Innenbahn: Abkürzung für Langsame, nicht für Schnelle

Abschnitt CP1→CP2 (s, Median Seeds 1–8):

| Route | sync 1.0 | sync 0.8 | Hand 1° | Hand 2° | Hand 3° |
|---|---|---|---|---|---|
| außen (gebaut) | **3.34** | **3.77** | **3.52** | **3.93** | 4.45 |
| innen, Bot entscheidet | 3.47 | 4.10 | 4.80 | 4.06 | 4.51 |
| innen mit Absprungknoten | 4.94 | 4.31 | 4.78 | 4.07 | **4.45** |

W+Leertaste-Hüpfer ohne Strafen (Blick tangential, Zeit bis P2, Median über 8 Phasen) — dieselbe Technik auf
beiden Linien:

| Linie | 320 u/s | 500 u/s | 700 u/s | 900 u/s |
|---|---|---|---|---|
| außen r 1000 | 7.16 | 4.59 | 3.28 | 2.81 |
| außen r 900 | 6.45 | **4.13** | **2.96** | **2.73** |
| innen r 752 | **5.39** | 4.36 | 4.35 | 2.87 |
| innen r 752, ohne Gräben | 5.38 | 3.45 | 2.73 | 2.77 |

Die Bahn steigt auf beiden Linien gleich hoch, innen aber auf kürzerem Weg, also steiler. Langsame sparen
innen bis ~1 s. Ab ~500 u/s kosten die Grabenlandungen mehr, als der Weg spart. Für schnelle Strafer ist die
innere Linie schon ohne Gräben kaum schneller. Damit hat die Wahl keine dominante Option, sie hängt vom Tempo
ab: außen ist die Tempo-Bahn, innen die kurze, steile Bahn für Vorsichtige. Ob Menschen die Innenbahn so lesen
und nehmen, entscheidet der Playtest.
(Prototyp mit alter Physik: nur die 1°-Hand war innen schneller, um −0,56 s.) Eine zusätzliche Ring-Teilung
bei r 752 und schmalere oder weniger Gräben habe ich gemessen. Sie ändern das Bild nicht und verschieben die
Außenroute chaotisch (sync 1.0 3.34 → 3.77 s bei anderen Graben-Grenzen).

### Look und Leistung (echtes Spiel, `level4.json` per `page.route` untergeschoben)

- 0 Konsolenfehler, sowohl beim Prototyp als auch beim finalen Build. Angesehen habe ich Start/Unterseite,
  E1, E2-Gräben (vor und nach "Sohle ohne Trims"), beide E3-Kanten mit ↑C-Lippe, E4, Steg mit Geländer,
  Krone/Drop-In, Übersicht und Abfahrt.
- Frame-Zeit mit Route-Bot sync 1.0, je 12 s, zwei Runden abwechselnd (headless Chromium/ANGLE):
  - L4: Ø 16,64 / 16,66 ms, L2: Ø 16,66 / 16,64 ms. Beide hängen am 60-Hz-Takt.
  - Callback-Zeit je Frame (Tick + Render-Aufträge): L4 0,591 / 0,632 ms, L2 0,559 / 0,635 ms.
  - Szene L4: 159 k Dreiecke gegen 93 k bei L2 (1390 Brushes, 8057 Flächen), 12–14 Draw Calls.
  - Auf schwacher GPU ist das ungeprüft.

## Offen (Playtest S6 / Phase 3)

- Crouch-Kanten bei Tempo: Der Anprall kostet den perfekten Bot an K2 ~1,8 s. Prüfen, ob sich das für
  Menschen fair anfühlt und ob die Medaillen dadurch zu lasch sind.
- Innenbahn als Wahl: Lesen Menschen sie so, und lohnt sie sich?
- Dritte Crouch-Kante (Plan 007 §4): nicht gebaut. Nach dem Playtest entscheiden.
- Abfahrt für Nicht-Surfer tödlich: Der Respawn an CP4/CP5 ist nah, der Coach zeigt den Surf-Hinweis.
- Frame-Zeit auf echter bzw. schwacher GPU: L4 hat 1,7 × die Dreiecke von L2.
- index.json baut erst Phase 3 (`levels:build` ohne Filter), bis dahin fehlt L4 in der Titel-Liste.

## Werkzeuge

```bash
npm run levels:build -- level4     # schreibt nur public/levels/level4.json (Medaillen über 49 Starts)
npm run levels:check -- level4     # Validator + Design-Proben (~12 s)
npx vitest run tests/level4.test.ts  # JSON aktuell, Kanten, Etagen, Bande, Drop-In, Coach (~3 s)
```

`buildLevel4(options)` baut Mess-Varianten (`Level4Options`): `rings`, `seg`, `trenches`, `inner`
('jump' | 'free': E2-Route über die Innenlinie), `t1`/`t2`/`r0` (E3-Terrassen/Rampen), `vCrouch`/`crouchBack`,
`d1`/`n1s`/`n1Depth`/`s2` (Abfahrt), `ridgeOff`/`funnelLen`/`board` (Krone), `underLights`/`underTint`/
`ambientGround` (Look), `measure: false` (ohne Surf-Messung, schnell, nur für Proben). Die Proben lesen
dieselben Maße über `level4Layout()`. Weicht das JSON vom Builder ab, meldet die Probe einen Fehler und
der Test "JSON ist der aktuelle Build" schlägt fehl.
