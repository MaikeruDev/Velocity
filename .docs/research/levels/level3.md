# 03 BRANDUNG — "Halt die Linie."

Plan 007, Phase 2, Strang `level3`. Builder `tools/levels/level3.ts`, Proben `tools/levels/probes/level3.ts`,
Tests `tests/level3.test.ts`, JSON `public/levels/level3.json` (`npm run levels:build -- level3`, schreibt nie
index.json). Vorlage: Prototyp `tools/critique/v2/level3/level3.ts` (DEFAULT_L3, Entwurf und Messungen in
`shots/v2/level3/`). Alle Zahlen gegen die **finale Phase-1-Physik** (Cap 40, Lande-Gnade, Hang-Landung mit
gestundetem Verlust, Kanten-Assist, Rutschen, Luftlenkung an, Rampbug-Fix).

**Stand 29.09., Fix-Runde 2 (`levels:build -- level3`):** `levels:check -- level3` **0 Fehler / 0 Warnungen**. Par 28 s,
Medaillen **27.3 / 25.1 / 12.8 / VELOCITY 12.2 / Autor 11.6 s** — identisch zu Datei und index.json der Integration
(Gold/VELOCITY/Autor seit Phase 3 aus der Surf-Referenz `level3Reference`, Abschnitt "Medaillen"). Neu: das **Netz
der sicheren Seite beginnt am Brett** (Auffang-Band unter dem Türkis-Fuß von W1, CP1-Trigger quer darüber: W-Halter
ab dem Start 12/12 an CP1 statt 12/12 tot) und eine **Finale-Schürze** (Kicker samt Schürze 2048 breit: Türkis-
Grundtechnik vom Brett nach CP3 tot 4/216 statt 91/216). Beides bitgleich für alle Medaillen-Modelle (RouteFollower,
Hände über 48 Seeds, Referenz), Route/safeRoute unverändert. Mensch-Band (746 Läufe): 0 Pad-Kontakte, 0 Einbrüche,
0 Stau auf dem Band, 0 Tode auf Türkis in der Kehre, ab CP3 162/162 im Ziel. Echtzeit (Route-Bot, Seed 11) 17.09 s,
0 Konsolenfehler. **Offen (neu gefunden):** Koralle-Wähler, die vom Spawn schräg links um die Finne laufen, fallen am
Drop W1 → Viertel 1 ins Leere (33/168) — der Hebel `q1Skirt` ist gemessen, aber medaillenwirksam (Abschnitt "Fix-Runde 2").

*Stand 29.09. (Review Phase 3, erste Fix-Runde):* Pads über der Bande, Bande ohne Lippe, Mensch-Band; Medaillen damals
noch am RouteFollower (19.1 / 18.2 / 17.29). *Stand 29.09. (Phase 3):* 0 F / 0 W, Medaillen 27.3 / 25.1 / 19.1 / 18.3 /
17.36 s, Par 28 (Bronze/Silber über 48 Seeds). *Stand 28.09.:* 0 F / 1 W, Par 26, Medaillen 25.8 / 24.8 / 19.1 / 18.3 / 17.36 s.

## Idee

Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Eine Brandungswelle aus Rampen: gerader
Einstieg (W1, volles Profil), eine große **180°-Steilkurve** (die Kehre), in der sich die Linie gabelt, dann
eine breite Gerade (R1, Z), der Finale-Kicker und ein Flug von 1.5 s auf den Strand.

Die Gabel ist die Kehre selbst: zwei Halbrampen Rücken an Rücken mit gemeinsamem Grat und gemeinsamen Drops.
- **KORALLE innen** (`route`, linke Flanke): die konkave Flanke trägt um die Kurve, die Linie liegt bei ~R−160,
  kurz — aber schmal (384 u Profil, 93 u Flanke unter der Linie) und ohne Netz: wer absinkt, fällt ins
  Kurveninnere.
- **TÜRKIS außen** (`safeRoute`, rechte Flanke): konvex (man muss drücken), Linie ~R+200, lang. Darunter ein
  Auffang-Band mit Außenbande (seit Fix-Runde 2 schon unter W1, ab dem Brett): wer nicht drückt, rutscht aufs Band
  und hüpft darauf bis R1 weiter. Langsamer, bis CP3 nie tot.

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
             .-~~~~~~~~~~~~~ ◆ CP2 (Plattform über der Bande, Viertel 3) ~~~~~~~~~~~~-.
           /  KORALLE innen: Halbrampe 384 (Viertel 4: 576), Linie 240 u unter dem Grat \
          |   TÜRKIS außen: Halbrampe 768, Linie 320; Auffang-Band 320                     |
          |                 32 u unter dem Fuß, Außenbande 448 (Clip + Leuchtbalken)       |
          |   Grat-Bande 128 durchgehend vom Brett bis R1  ▲ Leuchtturm (Kehrenmitte)      |
    CP3 ◆ (Plattform, Viertel 4) R1  1536 / 50°, Drop 256              CP1 ◆  W1 1536 @10° + Finne + Band
          Z   1536 / 50° @10°                                                  ▣ START, Blick Nord
          FINALE-Kicker 512@10° · 768@24° · 256@12° · 256@4° · 320@−8°, Schürze bis 2048
          ▼  Lücke 584 u, Flug 1.5 s
      ▣▣▣▣ STRAND 2048 × 2400 (Ziel), 1100 u unter dem Kicker, Prallwand
```

## Aufbau

| # | Abschnitt | Grat (u) | Tempo sync 1.0 | Aufgabe |
|---|---|---|---|---|
| 0 | Startbrett (Spawn 48 rechts vom Grat; Chevrons ~170 u voraus: Koralle 30 u links, 25° nach links; Türkis 64 u rechts) | +40 | 0 | Seite wählen; geradeaus ablaufen = Türkis an der Finne entlang |
| 1 | W1, volles Profil 768/60°, 1536 u, 10°; Finne auf dem Grat ab 40 u hinter dem Brett (Koralle-Fläche 24, Türkis 20); **Auffang-Band unter dem Türkis-Fuß** (`outerCatch0`, wie in der Kehre: 32 u unter dem Fuß, 320 breit, Bande 448), endet 128 u über dem Band von Viertel 1 | 0 → −271 | → ~510 | Grundtechnik, Bahnen getrennt; Türkis mit Netz |
| 2 | CP1: Luft-Trigger am Drop 128 auf Viertel 1 (quer bis über das Band: −384…+768), Plattform über der Bande bei s 700–924 (Spawn s 812, 40 rechts) | −382 | | Respawn wählt die Seite |
| 3 | Kehre Viertel 1–2 (Knick 3.75°/Fuge, 12–13 Stücke je Viertel), Grat-Bande ab 0 | −382 → −1148 | → ~800 | Gabel |
| 4 | CP2: Luft-Trigger am Drop Viertel 2 → 3, Plattform über der Bande bei s 480–704 | −1191 | | Respawn in der Kurvenmitte |
| 5 | Kehre Viertel 3–4, 256 u gerade Ausfahrt; CP3-Plattform über der Bande von Viertel 4 bei s 1340–1564 | −1191 → −1957 | → ~1000 | |
| 6 | CP3-Trigger + R1: Drop 256, 1536 breit / 50° (Mindest-Drop (tan60 − tan50)·384 = 207) | −2193 → −2463 | 900–1000 | Zusammenführung ohne V-Stufe |
| 7 | Z: Drop 128, 1536/50°, 10° | −2575 → −2845 | ~1000 | Tempo tragen |
| 8 | Finale-Kicker (wie L2 S4), Profil 1536 + **Schürze bis 2048** (`finale-skirt`, Trapez je Stück in der Flankenebene) | −2956 → −3416 | bis ~1060 | Launch |
| 9 | Strand: Lücke aus dem gemessenen unteren Band (Launch-minSpeed route 496 / safeRoute 445 u/s, Plan 0.95 × das kleinere) × Reserve, Prallwand | −4516 | Flug 1.5 s | Belohnungsflug |

Abschnittszeiten aus dem Stand (sync 1.0, Validator, ab dem jeweiligen Spawn): Start → CP1 3.5 s · CP1 → CP2
5.0 / 6.4 s · CP2 → CP3 6.2 / 6.5 s · CP3 → Ziel 11.7 / 11.8 s (Koralle / Türkis; der CP3-Spawn liegt jetzt vor dem
Drop auf R1, CP1/CP2 hinter der Landezone — die Split-Zeiten eines Laufs ändern sich nicht, die Trigger blieben).

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

**Medaillen** (build.ts, Regel 10/11; Phase 3: Hände über 48 Seeds, Surf-Referenz): Bronze = 3°-Hand Türkis (Median
25.99 s) × 1.05 = 27.3, Silber = 2°-Hand Türkis (23.88 s) × 1.05 = 25.1, Gold/VELOCITY/Autor = der schnellere Median aus
RouteFollower sync 1.0 Koralle (49 Start-Jitter, 17.28 s) und `level3Reference` (Grundtechnik vom Brett Koralle x −160,
bester Blick −2.5°, 14/16 im Ziel, **11.59 s**) × 1.1/1.05/1 = **12.8 / 12.2 / 11.6**. Türkis-Grundtechnik bestenfalls
13.63 s (Mensch-Band, Blick −3°), der perfekte Bot 19.48 s: **Gold und VELOCITY gibt es nur innen**. Freischaltung
L3-Silber = Kendama (Plan 007 §7). Die Leiter hat damit eine Lücke Silber 25.1 → Gold 12.8 (Hände strafen an jedem
Drop, die Grundtechnik nicht) — Medaillen-Logik der nächsten Phase, siehe "Medaillen gegen die Grundtechnik".

**Bronze/Silber hängen an einer glücklichen Stichprobe** (Review-Befund, nachgemessen): build.ts nimmt den Median
der 8 Validator-Seeds. Auf Türkis ist er für die 3°-Hand 24.55 s, über 48 Seeds 25.99 s — ein Fall aufs Band
kostet 2–4 s, die Seeds 1–8 fallen seltener. Folge: die Hand, für die Bronze steht, schafft Bronze auf der
sicheren Linie nur in **21/48** Läufen (Silber mit der 2°-Hand 40/48; auf Koralle Bronze 47/48). Par 26 liegt
genau am 48-Seed-Median. Über 48 Seeds gemessen: **Bronze 27.3 / Silber 25.1 / Par 28** (Leiter dann 8 % statt
4 % Abstand). Die anderen Level zum Vergleich (Hand 3°, Median 8 → 48 Seeds, Bronze geschafft): L2 19.21 → 20.02
(39/48), L4 32.08 → 32.08 (45/48) — L3 ist der Ausreißer, weil Türkis zwei Zeit-Moden hat (Band ja/nein). Die
Probe "Medaillen-Stichprobe" warnt, solange die Medaillen-Hand ihre Medaille in weniger als der Hälfte von 24
Läufen schafft (damals Bronze 11/24). **Behoben in Phase 3:** build.ts misst Bronze/Silber über 48 Seeds
(`MEDAL_SEEDS`) — Bronze 27.3 / Silber 25.1 / Par 28, Stichprobe 22/24 bzw. 21/24, keine Warnung mehr.

**Im echten Spiel** (Echtzeit, Route-Bot Seed 11, index.json nur per `page.route` ergänzt): Koralle sync 1.0
17.09 s, Türkis 19.70 s, sync 0.8 20.41 / 23.04 s, 0 Respawns, 60 fps, 0 Konsolenfehler.

## Proben (`probes/level3.ts`, laufen in `levels:check`)

| Probe | Soll | Ist |
|---|---|---|
| Innenvorteil (sync 1.0 über 49 Starts, Hand 3° über 24 Seeds) | ≤ 0.93 / ≤ 0.90 | 0.89 / 0.86 (8 Seeds 0.90) |
| Außenbahn fängt Nicht-Drücker: W-Halter **ab dem Start** (Spawn rechts der Finne, W1-Band) und ab CP1/CP2, Blick auf einen Türkis-Knoten ±15/±30°/0° (+ Flugrichtung), mit/ohne Leertaste, **vier Blickmodelle** (erster Knoten ≥ 320/200/120/0 u voraus) | Modell 320: alle am nächsten CP; kein Tod in keinem Modell | 320: 36/36 (Start → CP1 3.7–4.4 s, einer 27.7 s) · 200: 26/30, 4 Stau · 120: 29/30, 1 Stau · 0: 27/30, 3 Stau · 0 Tode (vorher ab dem Start 0/12, 12 tot auf W1) |
| Checkpoint-Pad ↔ beide Linien | ≥ 64 u | min 361 u (vorher 142) |
| Grundtechnik-Surfer (Blick 0°) aus dem Stand **auf der eigenen Bahn**, Tempo am nächsten CP | ≥ 700 u/s, beide Linien; ≥ 90 % der Luftticks über der Gabel auf der Sollseite des Grats | Koralle 759 (ab Knoten 10) / 838 (ab Knoten 36) / 1240 (ab Knoten 56), Türkis 792/837/1017; je 100 % auf der Bahn |
| Finale aus dem CP3-Respawn, beide Linien | ≥ 10 % Weitenreserve | ≥ 55 % (Koralle +2°), sonst ≥ 128 % |
| Risiko nur innen: Aussetzer-Modell (Hand 2°, A/D beim Surfen 0.5 s alle 2 s los), 16 Seeds | Koralle ≥ 25 % der Läufe mit Tod in der Kehre, Türkis keiner (sonst Warnung) | Koralle 6/16, Türkis 0/16 |
| Medaillen-Stichprobe: Bronze/Silber mit der Medaillen-Hand auf Türkis, 24 Seeds | ≥ 50 % schaffen sie (sonst Warnung) | Bronze 22/24, Silber 21/24 |
| **Bande-Gleiter**: hüpfend/frei, 0.5/4/16 u vor der Außenbande, 400/900 u/s, über jede Fuge (W1 → Viertel 1 … 3 → 4) | ≤ 10 % Verlust (Fehler) | 48/48, größter Verlust 1.2 % (Phase 3: 11/36 Fehler, bis 8 u/s) |
| **Mensch-Band** (746 Läufe): Grundtechnik mit Blickversatz −3…+1°, Verzug 0/0.1/0.2 s, σ 1°, vom Brett (x −160/+48/+160), ab CP1/CP2 (Türkis geradeaus, Koralle 20° links vom Pad), **ab CP3 bis ins Ziel** (0/±20°), quer über W1 | 0 Pad-Kontakte, Luftticks ≥ 32 u neben jedem Pad, 0 Einbrüche > 30 %/Tick, 0 Stau auf dem Band, 0 Tode auf Türkis in der Kehre, ab CP3 alle im Ziel (Fehler); Türkis vom Brett nach CP3 tot > 10 % → Warnung; Grundtechnik unterbietet den Autor um > 3 % oder Türkis schafft VELOCITY → Warnung | 0/≥ 53 u/0/0/0, ab CP3 162/162 (≤ 8.7 s); Tode vom Brett je Abschnitt W1/CP1–2/CP2–3/nach CP3: Koralle 0/5/0/0, **Türkis 0/0/0/4** (vorher 91); Grundtechnik Koralle 11.56 s (−2.5°), Türkis 13.63 s (−3°) gegen Autor 11.6 / VELOCITY 12.2 — keine Warnung (Phase 3: 154 Pad-Kontakte, 300 Einbrüche, 186 Band-Stau) |
| Türkis vom Brett nach CP3 tot (aus dem Mensch-Band) | ≤ 10 % (sonst Warnung) | 4/216 (ohne Finale-Schürze 91/216) |
| Koralle-Einstieg schräg vom Spawn (24/28/32° × Blick −2.5…+1° × 2 Seeds) | Info (bekannte Falle, `q1Skirt`) | 9/30 im Ziel |

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
u/s (fallen.md #73). Die Probe fährt seit dem Review alle vier Blickmodelle und berichtet sie (vorher nur 320 u
als Abnahme, Review: "nachträglich gewählt"): 320 u 24/24, 200 u 18/20, 120 u 19/20, nächster Knoten 18/20 — alle
Fehlschläge Stau, **nie Tod** (Fehler, sobald einer stirbt). Wer schaut, wohin er will, hüpft weiter.

Außerdem aus dem Validator (Pflicht auf safeRoute): Surf-Raster jeder Abschnitt 100 % (w1 108/108, outer1a
90/90, outer2b 108/108, outer3b 90/90, outer4b 108/108, r1/z/finalea 108/108), 0 Nahtstopps, Respawn-Surfer
CP1–3 im Ziel. Auf route ebenfalls 100 % (inner1a 36/36, inner3a 36/36). Kill-Kacheln (49) mindestens 250 u
unter jeder Fahrfläche (Soll ≥ 128). Kehre 180.000° (Tangente Viertel 4 und R1 gegen W1). Der Respawn-Surfer
des Validators auf route (`physics.respawnSurf`, fremder Pfad) startet ebenfalls am CP-Spawn und fährt damit
ab CP1/CP2 Türkis — für die Koralle-Zahl gilt die Probe oben.

## Review Phase 3: Grundtechnik-Band, Pads, Bande (29.09.)

**Befund (Review):** Die Validierung fuhr nur Bots auf der Routen-Linie (240–320 u unter dem Grat). Menschen mit
Grundtechnik (Taste in die Rampe, Blick entlang, nicht strafen) fahren höher — genau dort lagen die Keil-Pads von
CP1/CP2 (am Drop auf dem Grat): 1114 → 80 u/s oder hinüber auf die andere Bahn. Die unsichtbare Außenbande hatte an
jeder Viertel-Fuge eine Lippe (die erste Bank des Folgeviertels begann 1.51 u VOR der Innenfläche der vorigen, 943 →
0 u/s). Und die Medaillen stehen nicht für die Technik, die sie verlangen sollen.

**Messmodell "Mensch"** (`probes/level3.HumanSurfer`, aus `rv2-l3/novice.ts`): physics.SurfRider mit Blickversatz
(Grad, + = in die Rampe), Blick-Verzug (Tiefpass τ auf den Soll-Yaw: in der Linkskurve drückt ein Verzug von 0.1–0.2 s
Koralle-Fahrer 3–6° in die Rampe) und AR(1)-Blickrauschen σ. Achse = **Richtung der Rampe** (`rampAxis`, aus den
Fugen-Querschnitten der Stücke), nicht die Route: die Koralle-Linie zieht von W1 (320 u tief) auf Viertel 1 (240 u)
~20° schräg über die Bahn — ein Fahrer an der Finne blickte dort 20° in die Rampe und bremste sich bis zum Stillstand
(Review-Skript `spawn`, x −48, Blick 0/+1°: Stau bei W1 s 1478; mit Rampenachse 45/45 im Ziel). Population im Scratchpad
(`l3c/pop2.ts`): 810 Brett-Läufe (x −192…+192 × Blick −3…+1° × Verzug 0/0.1/0.2 s × 3 Seeds), 140 Läufe quer über W1
(−340…+340 u × Blick −2…+1°) und 810 CP-Abgänge (CP1/CP2 × Türkis 0°/−20°, Koralle 15/25/35° × Blick × Verzug).

**Was sich änderte** (alles in `level3.ts`, lib unverändert):
- **Eine Bande vom Brett bis R1, ohne Lücke.** Neue Finne auf dem Grat von W1 (ab 40 u hinter dem Brett bis 8 u vor
  seinem Ende, Querschnitt der lib-Bande, 128 u), die Grat-Bande der Viertel 1 und 3 jetzt ab 0 (vorher Lücke 0–360
  für die Pads). Jede folgende Bande beginnt 2 u weiter innen, ihre Stirn liegt verdeckt hinter der vorigen — nirgends
  steht eine Stirn in der Bahn der Grat-Reiter. Ohne Finne fuhr, wer Grat-nah auf W1 startete, über den 128-u-Drop auf
  den Grat von Viertel 1, ins Pad oder an die Stirn der Bande bei s 387. Die Seite wählt man auf dem Brett.
- **Banden-Form Koralle-seitig** (`shapeRail`): Fläche 24/28/22/16/10 u links vom Grat (W1, Viertel 1–4; lib: inset + 4),
  an jedem Stückanfang 10 u zurückgesetzt (Sägezahn), Unterkante 12 u unter der Flanke (lib: 28 u unter dem Grat = 7–10 u
  ÜBER der Koralle-Flanke). Grund: wer an der Bande entlangfuhr, stand an jeder Gehrungsfuge still — Innenflanke + zwei
  Banden-Facetten im konkaven Knick sind drei Ebenen, Source nullt dann das Tempo (Surf-Raster inner1a: 735 → 3 u/s;
  Koralle-Fahrer mit Verzug 0.2 s grindeten mit 100–250 u/s die Bande entlang). Mit Rücksprung verlässt man eine
  Facette, bevor die nächste kommt; je Viertel liegt die Fläche ~6 u näher am Grat, damit die 3.75° gedrehte, 96 u
  früher beginnende Folge-Bande nie davor steht. In die Tasche unter der alten Unterkante geriet die Hull-Ecke schräg
  zur Achse (776 → 0 u/s).
- **Unsichtbare Clips** über der W1-Finne und der Bande von Viertel 1 bis s 640, Oberkante 248 u über dem Grat: auf die
  schräge Oberseite der Bande (60°, Surf-Fläche) flog, wer an der Brettkante absprang bzw. an der Finne entlang über den
  128-u-Drop abhob, und fuhr AUF ihr (29/567 Läufe in einer Zwischenstufe).
- **Checkpoint-Plattformen schweben über der Bande** (`padOver`): 224 × 144 u, 16 u dick, Unterkante 136 u über dem Grat
  am Anfang (Bande 128), dem Grat folgend; CP1 auf Viertel 1 bei s 700, CP2 auf Viertel 3 bei s 480 (hinter der
  Landezone der Drops), **CP3 auf Viertel 4 bei s 1340 vor dem Drop** (auf dem Grat von R1 landeten dort die Koralle-
  Fahrer vom hohen Innenrand: 57 Pad-Kontakte). Spawn 112 u hinter dem Anfang, 40 u rechts (Türkis). Die Luft-Trigger
  bleiben an den Drops (Splits unverändert) und reichen bis hinter den Spawn. Bandenreiter haben den Kopf ≤ 44 u über
  dem Grat; die Plattform liegt außer Reichweite.
- **Außenbande ohne Lippe** (`litBand`): erste Bank eines Folgeviertels an Fuge a 8 u nach außen (`bankLead`), alle
  anderen Bänke 6 u (`bankSaw`). Die Lippe war die erste Hälfte; die zweite fand erst der Gleiter-Sweep: im konkaven
  Knick zweier Bänke fing der Achsen-Bevel der nächsten Bank die Hull-Ecke ab, wo die Bande achsparallel läuft
  (Kehrenmitte x ≈ −2000, hüpfend −92 %).
- **Chevrons**: Koralle bei x −30 mit 25° nach links (wer ihr folgt, geht 13 u links an der Finnen-Stirn vorbei), Türkis
  bei x 64; Spawn unverändert x 48 (geradeaus = an der Finne entlang auf Türkis, 12 u Luft).

**Verworfene Zwischenstufen** (gemessen, gleiche Population, Rampenachse): Pad auf dem Grat hinter der Landezone
(s 480): 152 Pad-Kontakte, Koralle 106/243 im Ziel — wer an den Grat klettert, trifft jedes Pad auf dem Grat, und ohne
Pad landet er am Drop auf dem nackten Grat (begehbarer Bevel, #118) und fliegt über die ganze Türkis-Seite. Pad + Lücke
in der Bande: 150 Pad-Kontakte, die Stirn der wieder einsetzenden Bande stoppte (`outer3h-rail` 100×). Schwebende
Plattformen ohne W1-Finne: 25–27 cp1pad-Kontakte, 29 Fahrten auf der Bandenoberseite. CP1-Plattform auf W1: der
Koralle-Abgang dort landet außerhalb der schmalen Innenbahn von Viertel 1 (25°: 81/81 tot).

**Ergebnis** (gleiche Population, Rampenachse; vorher = Phase-3-JSON):

| | vorher | nachher |
|---|---|---|
| Brett (810): Pad-Kontakte / Einbrüche > 30 % / Stau | 392 / 590 / 406 | 0 / 2 (+16 Landung im Ziel) / 4 |
| Brett: Koralle im Ziel, Median | 215/405, 19.06 s | 371/405, 17.02 s |
| Brett: Türkis im Ziel, Median | 35/405 (360 Stau an der Lippe), 19.67 s | 238/405, 14.49 s |
| quer über W1 (140): Pad-Kontakte / Einbrüche | 28 / 7 | 0 / 0 |
| CP-Abgänge (810): Einbrüche (Bandenstirn hinter dem Pad) / Stau | 340 / 38 | 0 / 0 |
| Bande-Gleiter-Sweep (378: 3 Fugen × 7 Abstände × 9 Tempi × hüpfend/frei) | 93 über 10 % Verlust | 0, größter 1.4 % |
| Review-Skripte `rv2-l3/novice.ts`: cp2class / w1lat / chevron / lip | 20 Stopp + 36 über das Pad / 9 Pad / 5 Pad / min 8 u/s | 80/80 frei / 0 / 0 / 24/24 durch, min ≥ 399 u/s |

Reste, ehrlich: 2 Einbrüche in 810 Brett-Läufen — einer beim Abgleiten über den Fuß der schmalen Innenbahn (Tod
folgt, die Probe zählt ihn zum Absturz), einer bei Verzug 0.2 s: steiler Fall vom W1-Drop auf die Innenflanke neben
einer Banden-Fuge (783 → 0, fährt weiter, Ziel). Koralle-Abgänge von einer CP-Plattform mit ≥ 35° oder seitlich
(Taste A) fliegen über die schmale Innenbahn hinaus (35°: 162/162 tot; vorher CP1 81/81 ebenso) — 15° und 25° kommen an.
Der Validator (Mensch-Band, 584 Läufe) hat davon nichts im Stichprobenraster.

**Türkis nach CP3 (damals neu sichtbar, in Fix-Runde 2 behoben):** 167/405 Türkis-Brettläufe starben nach CP3 (Blick
−0.5…−3°: die Grundtechnik drückt ab ~1000 u/s nicht mehr in die Rampe, physics.SurfRider). Band-Fahrer kommen am
Westrand von R1 an (Band-Außenkante 704 u neben dem Grat von Viertel 4, R1 reicht 768 → 64 u bis zum Fuß) und rutschen
über R1/Z/Finale hinaus. `r1Lateral` 120 hätte `dropR1` ≥ ~350 gebraucht (neue Abfahrt, neue Medaillen) — gelöst mit der
Finale-Schürze, siehe unten.

## Fix-Runde 2 (29.09., nach der Integration)

Die Review-Befunde (Stand vor der ersten Fix-Runde) am aktuellen Stand nachgefahren, mit den Skripten des Reviews
(`rv2-l3/novice.ts`, Modi cp2class / w1lat / chevron / lip / spawn / wstart / band) gegen die gebaute JSON:

| Befund | Review | jetzt |
|---|---|---|
| CP2-Pad im Flugband (critical) | 20/80 Stopps, 36/80 über das Pad | 80/80 frei |
| CP1-Pad in der Geradeaus-Linie (major) | w1lat 9 Pad-Kontakte, chevron 3/4 | 0 / 0 (alle Querlagen −340…+340, beide Blicke) |
| Bandenlippe an den Viertel-Fugen (major) | W+Leertaste min 8 u/s (Q2→Q3) | min ≥ 399 (400 u/s) bzw. ≥ 897 u/s (900) an allen Fugen |
| Proben fahren nur die Route (major) | — | Mensch-Band (746 Läufe), Gleiter, W-Halter ab Start, Pad-Abstand der Luftticks |
| Medaillen am RouteFollower (major) | Grundtechnik 11.4–12.1 s < VELOCITY 18.3 | Integration: Referenz-Medaillen 12.8/12.2/11.6; `spawn` x −160: −3° 11.4–12.1 s (≈ VELOCITY/Autor), 0° 13.8–15.1 s |
| Netz erst ab CP1 (minor) | W-Halter ab Start 11/12 tot | **W1-Band**: 12/12 an CP1 (3.7–4.4 s, einer 27.7 s Stau-nah), 0 tot |

- `wstart`/`spawn` des Reviews mit routeAxis: Koralle x −48 Blick 0°/+1° steht bei W1 s 1478 an der Finne (3/8 bzw.
  8/8). Die Route-Achse zeigt dort 30° in die Rampe (W1-Knoten 320 u tief → Viertel 1 240 u, fallen.md #158); mit
  der Rampenachse (so blickt ein Mensch) fahren −20/−60/−100 alle durch. Mess-Artefakt, kein Leveldefekt.
- **W1-Band** (`L3Params.w1Catch`, Tag `outerCatch0`): `litBand` unter dem Türkis-Fuß von W1, endet 128 u über dem
  Band von Viertel 1 (dessen erste Bank jetzt ebenfalls um `bankLead` zurück). CP1-Trigger quer bis 768 (wie CP2):
  RunState zählt nur den nächsten Checkpoint — wer vom Band aus an CP1 vorbeiflöge, käme nie ins Ziel. Hinten an die
  Brush-Liste gehängt (vor den Kill-Kacheln): alle früheren Indizes bleiben, Route/safeRoute/minSpeed/Medaillen
  bitgleich. W-Halter ab dem Start bis CP3: 11.6–31.1 s, dort sterben sie an R1 (kein Netz auf der gemeinsamen
  Abfahrt) — der CP3-Respawn trägt die Grundtechnik (162/162 im Ziel).
- **Finale-Schürze** (`L3Params.finSkirt` 2048, `flankSkirt`): Trace eines Toten (Türkis x 48, −2.5°): mit 1253 u/s
  vom Band über R1 (Querlage 686 von 768), 0.12 s Kontakt am R1-Ende, 0.37 s auf Z, dann seitlich am Finale-Fuß
  vorbei (Querlage 764–826). Varianten (216 Türkis-Brettläufe, Tode nach CP3): Stand 91 · R1/Z 2048 91 · Finale 1792
  10 · **Finale 2048 3** · alles 2048 3. Das Finale als breiteres Profil gebaut verschob die 3°-Hand über 48 Seeds
  25.99 → 26.02 s (Bronze 27.3 → 27.4, index.json veraltet) — gleiche Flankenebene aus anderen Eckpunkten, chaotische
  Läufe (fallen.md #72). Als Schürze unter dem alten Fuß (Trapez je Stück, oberer Rand punktgleich mit dem Fuß,
  hinten angehängt) sind Referenz (16 Seeds × 9 Blicke), RouteFollower beider Linien, Hände (48 Seeds) und
  Launch-Band bitgleich. Rest: 4/216 fliegen unterhalb der Strandkante seitlich am Kicker vorbei und prallen an die
  Strandstirn (vorher ebenso tot); der Brückenbogen über dem Finale steht jetzt neben der Schürze.
- **Koralle-Einstieg (neu gefunden, offen, Medaillen-Neubau):** Gegenprobe zum Chevron-Befund mit dem Mensch-Modell
  (Rampenachse): wer vom Spawn (rechts der Finne) schräg links um die Finne läuft, landet auf W1 bei Querlage −260…−300.
  W1 trägt links bis 384 u vom Grat, die Innenbahn von Viertel 1 nur bis 192 — am Drop fällt er ins Leere, obwohl er
  die Taste in die Rampe hält. 280 Läufe (24/28/32/36/40° × Blick −2.5…+1° × Verzug 0/0.1 × 4 Seeds): 33 im Ziel
  (24° 15/56, 28° 18/56, 32° 0/56; 36°/40° = W+A fliegen schon auf W1 links hinaus, 0/112). Koralle-Chevron x −43/−17
  nachgelaufen: Blick ≤ −1° 0–2 von 4. Hebel `q1Skirt` (Schürze unter dem Fuß der Innenbahn in Viertel 1, auf die
  Bahnbreite verjüngt), gemessen: Länge 600 35/280 · 1000 70/280 · 1200 81 · 1400 103 · 1600 122 · 1900 135/280. Ab
  1200 trägt der Referenz-Blick −3° (11.27 statt 11.59 s, 11–15/16 im Ziel) → Gold/VELOCITY/Autor 12.4/11.9/11.3 statt
  12.8/12.2/11.6; bei 1000 bleiben die Medaillen (−3° nur 8/16, keine Mehrheit), aber der Validator meldet 5 Warnungen
  (Raster-Starts 90 u unter der Linie liegen jetzt auf der Schürze und fallen an der Verjüngung). Deshalb **aus**
  (Default [0, 0]) und für den Medaillen-Neubau aller Level vorgemerkt: dort `q1Skirt` [768, 1600–1900] setzen, neu
  bauen, Raster/Risiko-Probe ansehen (Aussetzer-Modell Koralle bei 1000: 5/16 statt 6/16 Tode in der Kehre, Soll ≥ 4).
  Die Probe "Koralle-Einstieg" berichtet es als Info (heute 9/30: 24° 4/10, 28° 5/10, 32° 0/10).
- Sicht (`l3f/shots`, 1280×720): das W1-Band liest sich wie die Kehren-Bänder (Boden + Sand-Balken), vom W1-Ende sieht
  man den Absatz aufs Band von Viertel 1; der Kicker ist breiter, am alten Fuß bleibt eine dünne Koralle-Linie.
  Echtzeit Route-Bot 17.09 s (wie vorher), 1099 Frames in ~18 s, 0 Konsolenfehler; Level-Dreiecke 187 567 (vorher 175 473).

## Medaillen gegen die Grundtechnik (Phase 3 umgesetzt, Logik der nächsten Phase)

Vor der Integration maß build.ts Gold/VELOCITY/Autor am RouteFollower sync 1.0 auf Koralle (49 Start-Jitter: 17.28 s →
19.1 / 18.2 / 17.29 s). Der RouteFollower strafet an jedem Surf-Drop in der Luft zum nächsten Knoten und verliert dabei
150–190 u/s (Review, rftrace.txt); die Grundtechnik ist schneller. Die Integration hat Review-Vorschlag (a) umgesetzt:
`probes/level3.level3Reference` (Grundtechnik vom Brett Koralle x −160, bester Blickversatz −3…+1°, σ 1°, Verzug 0,
16 Seeds) — je Medaille zählt der schnellere Median (build.ts, fallen.md #163). Messung (Fix-Runde 2, gebaute JSON):

| Modell | Median | → Medaille |
|---|---|---|
| Referenz Koralle x −160, Blick −2.5° (14/16 im Ziel; −2° 11.97, −1° 13.39, 0° 14.98 s) | **11.59 s** | Gold 12.8 / VELOCITY 12.2 / Autor 11.6 |
| RouteFollower sync 1.0 Koralle / Türkis (49 Start-Jitter) | 17.28 / 19.48 s | zählt nicht (langsamer) |
| Hand 3° / 2° auf Türkis (48 Seeds) | 25.99 / 23.88 s | Bronze 27.3 / Silber 25.1 |
| Grundtechnik Türkis, bester Blick (Mensch-Band, 4 Seeds) | 13.63 s (−3°) | über Gold → Gold/VELOCITY nur innen |
| Review-Skript `spawn` Koralle x −160, σ 1°, 8 Seeds | −3° 11.4–12.1 · −2° 12.3–13.1 · 0° 13.8–15.1 s | |

- Für die nächste Phase (Medaillen-Logik aller Level): die Leiter springt von Silber 25.1 auf Gold 12.8 (Faktor 1.96).
  Bronze/Silber stehen für Hände, die an jedem Drop strafen (auf einer Surf-Map die falsche Technik), Gold/VELOCITY
  für die Grundtechnik mit Blick 2–3° weg von der Rampe. Blick 0° (so fährt, wer T7/T8 wörtlich nimmt) landet bei
  13.8–15.1 s: Silber sicher, Gold nie. Hebel wären eine Surf-Referenz auch für Bronze/Silber (z. B. Grundtechnik
  Türkis Blick 0°/+1° mit Verzug) oder ein RouteFollower ohne Luft-Strafe an Surf-Drops (Review-Vorschlag b).
- Die Probe "Mensch-Band" warnt, wenn die Grundtechnik auf Koralle den Autor um > 3 % unterbietet (Medaillen veraltet)
  oder Türkis VELOCITY schafft (heute beides nein: 11.56 s gegen Autor 11.6; Türkis 13.63 s gegen VELOCITY 12.2).

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
- **Grat-Bande**: Türkis-Seite Inset 18/16/14/12 u je Viertel statt abwechselnd 12/14 — jede Folge-Bande liegt
  zurückgesetzt. Auf der Koralle-Seite reichte das nicht (Review Phase 3, gemessen): eigene Fläche 28/22/16/10 u mit
  10 u Sägezahn je Stück, siehe "Review Phase 3".
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
- **Mond (Phase 3):** `sky.ts` setzte jede Scheibe fest "warm" (Blau × 0.55, unten Pink) — sie rendert jetzt mit
  `environment.moon: true` in der Lichtfarbe #d6fff5, mit zwei harten "Meeren" und ohne Outrun-Streifen.
- **Finne und Plattformen (Review Phase 3):** Vom Brett aus steht die Finne als türkises Segel zwischen den Chevrons
  (Koralle links, Türkis rechts) — die Gabel ist ab dem Start sichtbar. Die drei Checkpoint-Plattformen schweben über
  der Bande und sind aus der Kehre als Landmarken zu sehen (`shots/level3/rv2-fix/`: 00-start, 01/02-brett, K1–K3 aus
  Fahrersicht, 30–32 Respawn).

**Frame-Zeit** (Chromium/ANGLE ohne VSync und Frame-Limit, Route-Bot, 3 × 14 s je Level im Wechsel, Review Phase 3):
L2 Ø 0.56 ms, L3 Ø 0.52 ms (**× 0.94**, Soll ≤ 1.10); JS im rAF-Callback L3/L2 0.94. Szene 12 Draw Calls, 175 473
Level-Dreiecke (L2: 11 / 113 752). 407 Brushes (270 kollidierend, 137 Deko). Echtzeit mit VSync: Koralle sync 1.0
17.09 s, Türkis 19.70 s, sync 0.8 20.41 / 23.04 s (identisch zu vorher — die Routen-Linien berühren die geänderte
Geometrie nicht), 0 Respawns, 60 fps (min 60), 0 Konsolenfehler.

## Tests (`tests/level3.test.ts`, 16 Tests, ~1 s)

Name/Licht/Mond-Flag/prepLessons · Medaillen streng fallend, Par · beide Linien Start → CP1 → CP2 → CP3 → Ziel · die
Gabel (jeder Surf-Knoten über der Kehre liegt auf dem Stück seiner Bahn und auf ihrer Seite des GRATS, je Viertel ≥ 3
Knoten) · Außenbande Clip + Balken · **Außenbande ohne Lippe** (jede Bank ≥ 2 u hinter der vorigen, W1-Band bis
Viertel 4) · **Grat-Bande als Sägezahn** (jedes Stück ≥ 2 u hinter dem Ende des vorigen, W1-Finne bis Viertel 4) ·
**Finale-Schürze** (oberer Rand punktgleich mit dem Fuß der Kicker-Stücke, Außenkanten in deren Flankenebenen) ·
**Plattformen schweben** (unter der Mitte ≥ 7 u Luft, dann die Bande) · Kehre 180° · Layout = JSON-Kollision ·
perfekter Bot beide Linien (VELOCITY nur innen) · **Grundtechnik vom Brett** (Koralle −2.5°/0°, Türkis 0°: kein Pad,
kein Einbruch, im Ziel) · **Türkis-Bandfahrer** (Spawn, Blick −2.5°, Seeds 1–2: im Ziel dank Schürze) · **Netz ab dem
Brett** (W-Halter rechts der Finne erreichen CP1; das Ende des W1-Bands liegt im CP1-Trigger) · **Bande-Gleiter** über
alle vier Fugen ≤ 10 %. Gegenproben: gegen die Phase-3-JSON schlugen 6 Tests fehl (Lippe, Sägezahn, Plattform, Layout,
Grundtechnik mit cp2pad, Gleiter); gegen den Stand vor Fix-Runde 2 4 (Lippe W1→1, Layout, Netz ab dem Brett, Gleiter
W1→1), gegen den Stand ohne Schürze 3 (Schürze, Layout, Türkis-Bandfahrer).

## Offene Punkte

- ~~index.json nachziehen~~ — erledigt (Integration); Fix-Runde 2 ändert keine Medaille (Datei = Index 27.3 / 25.1 /
  12.8 / 12.2 / 11.6, Par 28).
- **Medaillen-Leiter (nächste Phase, build.ts):** Silber 25.1 → Gold 12.8, Bronze/Silber an Händen, die an jedem
  Surf-Drop strafen; siehe "Medaillen gegen die Grundtechnik". Die Probe warnt bei veralteten Medaillen.
- ~~Türkis-Band-Fahrer sterben nach CP3~~ — Fix-Runde 2: Finale-Schürze, 91 → 4/216 (Rest prallt unterhalb der
  Strandkante an die Strandstirn; ab CP3 kommt jeder Grundtechnik-Lauf ins Ziel, 162/162).
- ~~Netz erst ab Viertel 1~~ — Fix-Runde 2: W1-Band, W-Halter ab dem Start 12/12 an CP1. Auf der gemeinsamen Abfahrt
  nach CP3 gibt es weiter kein Netz (R1/Z/Finale verlangen die Grundtechnik; der CP3-Respawn trägt sie). Für den Plan
  (Integration): "Außenbahn fängt W-Halter ab dem Brett bis CP3".
- **Koralle-Einstieg vom Spawn (Medaillen-Neubau):** schräg links um die Finne → Drop W1 → Viertel 1 ins Leere (33/168
  bei 24–32°); Hebel `q1Skirt` gemessen und vorbereitet, aber medaillenwirksam — siehe "Fix-Runde 2".
- **Koralle-Abgang vom CP-Pad:** 15–25° kommen an, ≥ 35° oder seitlich fliegen über die schmale Innenbahn hinaus
  (schon vorher so). Eine breitere Innenbahn an den CPs wäre Leveldesign (Innenvorteil-Quoten neu messen).
- **Route-Achse im Review-Skript:** Die Koralle-Linie zieht zwischen W1 und Viertel 1 ~20° schräg; Fahrer mit
  `routeAxis` an der Finne bremsen sich dort (Mess-Artefakt, Proben nutzen `rampAxis`). Die W1-Knoten auf 240 u Tiefe
  zu legen, änderte die RouteFollower-Linie und damit die Medaillen — nicht gemacht.
- ~~Medaillen über ≥ 24 Seeds~~ — erledigt in Phase 3 (48 Seeds, 27.3 / 25.1 / Par 28).
- **Gabel als Zeit-Entscheidung (Lead):** Mit der Plan-Abnahme (Hand 1–3° innen 0 Tode, Quote ≤ 0.90) ist
  Koralle für jeden, der die Kurve hält, die bessere Wahl; Türkis ist die Netzbahn (Aussetzer und Nicht-Drücker
  sterben innen, außen nicht). Soll die Gabel auch für Könner eine Abwägung sein, braucht es einen höheren
  Todes-Preis innen (z. B. CP2 ans Kehrenende) oder ein Netz außen, das weniger Zeit kostet — beides ändert die
  Plan-Abnahme.
- ~~Registry-Test-Timeout~~ — erledigt in Phase 3 (eigenes Timeout 120 s).
- ~~Mondscheibe gelb~~ — erledigt in Phase 3 (`environment.moon`).
- Validator-Respawn-Surfer auf `route` (`physics.respawnSurf`, level-tools): startet am CP-Spawn (rechts vom Grat)
  und fährt ab CP1/CP2 Türkis; die Zeile "[route] Grundtechnik-Surfer … CP1 836 / CP2 794" ist also keine
  Koralle-Zahl. Für Gabel-Level braucht er den Start auf der Seite der Linie (wie `probes/level3.surferStart`).
- Tote Zeit nach CP3 (35–39 %): S-Kurve oder Kaskade auf Z wäre eine Design-Erweiterung (Playtest).
