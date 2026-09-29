# Movement-Tuning (VELOCITY_DEFAULT)

**Stand:** 2026-09-28, Plan 007 (Arcade-Pass, Strang movement) · Quelle aller Zahlen: `npm run sim` (tools/sim.ts), 128 Tick.
Regel (rules/movement.md §7): jede Wertänderung hier begründet, mit Sim-Zahlen.
Die jüngste Runde (Knick-Fix, Rampbug-Fix, Lande-Gnade, Hang-Landung, Cap 40, Kanten-Assist, Rutschen,
Luftlenkung) steht unter **"Arcade-Pass (Plan 007)"** am Ende, davor **"Runde Game-Feel (Plan 003)"**;
ältere Tabellen weiter oben sind der Stand ihrer Runde (Cap 17 bzw. 24 konstant).

## Ergebnis

| Wert | CS2_CLASSIC | VELOCITY_DEFAULT | Warum |
|---|---|---|---|
| tickRate | 64 | **128** | Feinere Subtick-Maus, Surf-Clipping pro Tick genauer. Vorgabe. (Doppelter Strafe-Gewinn pro Sekunde — den nimmt der Cap wieder weg, s. u.) |
| gravity / jumpImpulse | 800 / 301.99 | **800 / 301.99** (unverändert) | 57 u Sprung, 0.755 s Luft. Mehr Hangtime lohnt nicht (s. u.). |
| runSpeed / sprintSpeed | 250 / 250 | 250 / **320** | Sprint = schneller Anlauf und bessere Start-Hops; Hop 1 ab 320 statt 250. **Nur am Boden** (s. Abweichungen). |
| accelerate | 5.5 | **8** | 0 → 250 in **0.20 s** statt 0.55 s. Parcours braucht Antritt. |
| friction / stopSpeed | 5.2 / 80 | 5.2 / 80 (unverändert) | Stopp 250 → < 10 in **0.39 s** (Ziel 0.35–0.6). |
| airAccelerate | 12 | **40** | Gewinnfenster ab ~20 gesättigt (auch mit absolutem Zielfehler, s. Sweep); verzeiht Überdrehen, hält beim Surfen. |
| airSpeedCap | 30 | **17** | Der Hebel für die Speed-Kurve: perfekter Bot Hop 5/10/20 = **450/585/788**. Offene Frage an den Auftraggeber, s. "Menschenmodell". |
| nonJumpVelocity | 140 | 140 (unverändert) | Nach einem Boden-Tick gilt davon abgeleitet 140·320/250 ≈ 179 (s. Abweichungen). |
| coyoteTime / jumpBufferTime | 0 / 0 | 0.1 / 0.12 | Timing-Hilfen (rules §5), unverändert. |
| autoHop, duckTime | – | true, 0.15 | unverändert. |
| airSpeedCapLow / FadeFrom / FadeTo | 0 (aus) | **40 / 350 / 700** | Plan 003: Cap bis 350 u/s, linear auf 24 bei 700 — nur in freier Luft. Plan 007: 32 → 40 (Anfänger-Band). S. "Arcade-Pass". |
| strafeAssist | false | **true** | Plan 003: W zählt in der Luft nicht, solange A/D gedrückt ist. |
| autoHopSpeedShare / autoHopGroundTime | 0 (Autobhop sofort) / – | **0.97 / 0.2 s** | Plan 003: Smart-Auto-Hop, gehaltene Taste springt am Boden erst mit Anlauf. |
| autoHopLandShare / autoHopLandAirTime | 0 / – | **0.75 / 0.25 s** | Prüfung 27.09.: Strafer (A/D) nach echter Luftphase springen schon ab 0.75 × Wunschtempo. S. "M1b". |
| landGraceTime | 0 | **0.0625 s** | Plan 007 A3: 8 Bodenticks ohne Friction nach echter Landung, Schub-Kappe. |
| slopeLandGain / surfSeamFix | 0 / false | **1 / true** | Plan 007 A4 (Hang-Landung phasenfest, Bergauf-Verlust gestundet) und A2 (Rampbug-Fix). |
| ledgeStep / ledgeMemory | 0 / 0 | **5 u / 0.2 s** | Plan 007 A6: Kanten-Assist; Crouch-Kanten ≥ 66 u (Review 28.09.). |
| slideMinSpeed (+ slide*) | 0 | **280** | Plan 007 A7: Rutschen; Nebenwerte in beiden Presets gleich (wirken ohne Hauptschalter nicht). |
| airControl (+ airControl*) | 0 | **1.6 rad/s** | Plan 007 A8: Luftlenkung mit W; Einstellung "Luftlenkung mit W" (aus → 0). |

Zielkorridor aus dem Auftrag, alle erfüllt:

| Ziel | Sim |
|---|---|
| perfekter StrafeBot Hop 5 ≈ 400–480 | **450** |
| Hop 10 ≈ 520–650 | **585** |
| Hop 20 ≈ 700–900 | **788** |
| sync 0.7 klar darunter, aber > 330 bei Hop 10 | **400** (relatives Modell); absolutes Modell mit gemessenem Sync 0.7 (≈ 2.3–2.6° Zielfehler): **≈ 400–420** |
| Naive ≈ runSpeed | **250** (exakt, auf allen 20 Hops) |
| Stopp 250 → < 10 in 0.35–0.6 s | **0.391 s** |
| 0 → 250 in ~0.15–0.3 s | **0.203 s** |

Die Korridore für Hop 5/10 sind als Test festgeschrieben (`tests/movement.test.ts`).

## Die Physik dahinter (warum ausgerechnet der Cap)

Luft-Gewinn pro Tick bei Winkel-Optimum (a = min(airAccel·wishspeed·dt, cap)):

    |v'|² = |v|² + 2·a·cap − a²      → mit a = cap:  |v'|² = |v|² + cap²

Damit ist die Speed-Kurve des **perfekten** Strafers geschlossen lösbar:
nach n Hops mit je N ≈ 96 Luft-Ticks gilt `v_n² ≈ v_0² + n·N·cap²`.
Aus dem Ziel Hop 10 ≈ 585 folgt cap² ≈ (585² − 250²)/(10·96.6) ≈ 290 → **cap ≈ 17**.
Source-30 bei 128 Tick ergäbe 705/965/1342 — doppelt so steil wie gewünscht.

**Derselbe Cap bestimmt aber auch das Gewinnfenster.** Liegt die wishdir um den
Winkel ε neben dem Optimum (90° zur Flugrichtung), ist der Gewinn pro Tick

    Δ|v| ≈ (cap² − (|v|·ε)²) / (2·|v|)     → Gewinn nur für |ε| < cap/|v|

(gilt für airAccel·wishspeed·dt ≥ 2·cap, bei uns 78 ≥ 34). Das Fenster ist also
±cap/|v| **absolut**: bei 500 u/s ±1.95° mit Cap 17, ±3.4° mit Cap 30. Kurve des
perfekten Bots und Fehlertoleranz hängen am selben Wert — steilere Kurve und
verzeihenderes Fenster gibt es nur zusammen. Anders ausgedrückt: die Korridore
des Auftrags erzwingen Cap ≈ 17–18 und damit ein Fenster, das deutlich enger ist
als in CS2 mit 64 Tick (dort Cap 30, Hop 10 perfekt = 706).

## Menschenmodell (seit Review-Runde 1)

Die sync-Bots (0.85/0.7) skalieren ihre Fehler mit dem Gewinnfenster. Das
stellt einen HUD-Sync nach, verfälscht aber jeden Cap-Vergleich: kleiner Cap →
proportional kleiner Fehler. Die Hand eines Menschen kennt den Cap nicht. Deshalb
hat die Sim jetzt absolute Modelle (`StrafeBot`-Optionen):

- **Zielfehler n°** (`aimNoiseDeg`): absoluter Winkelfehler 1σ, zeitlich korreliert (AR(1), 0.15 s).
- **konst. n°/s** (`turnRateDeg`): der Blick dreht pro Strafe mit fester Rate (Start auf dem Optimum) — wie ein Spieler, der die Maus gleichmäßig zieht.

`npm run sim`, Abschnitt "Menschenmodell" (Hop 5/10/20, gemessener Sync):

| Bot | VELOCITY H5 | H10 | H20 | Sync | CS2 64 t H5 | H10 | H20 | Sync |
|---|---|---|---|---|---|---|---|---|
| perfekt | 450 | 585 | 788 | 1.00 | 529 | 706 | 967 | 1.00 |
| perfekt, max. 300°/s | 443 | 580 | 785 | 1.00 | 527 | 705 | 966 | 1.00 |
| konst. 250°/s | 435 | 573 | 757 | 1.00 | 523 | 681 | 723 | 0.81 |
| konst. 150°/s | 391 | 516 | 727 | 1.00 | 483 | 665 | 933 | 1.00 |
| Zielfehler 1° | 429 | 531 | 680 | 0.93 | 517 | 676 | 880 | 0.96 |
| Zielfehler 2° | 381 | 444 | 521 | 0.73 | 477 | 591 | 714 | 0.81 |
| Zielfehler 3° | 325 | 361 | 396 | 0.64 | 427 | 498 | 571 | 0.71 |
| Zielfehler 4° | 273 | 294 | 315 | 0.59 | 377 | 418 | 463 | 0.65 |
| sync 0.85 (relativ) | 392 | 495 | 658 | 0.88 | 473 | 573 | 772 | 0.87 |
| sync 0.7 (relativ) | 329 | 400 | 512 | 0.73 | 343 | 407 | 542 | 0.71 |
| Naive | 250 | 250 | 250 | 0 | 250 | 250 | 250 | 0 |

Lesart:
- **Korrektur:** Früher stand hier "ein guter Spieler kann den perfekten Bot fast
  erreichen". Das gilt nur bei Winkelfehler 0 (Drehraten-Grenze allein kostet
  kaum etwas). Schon 1° absoluter Fehler kostet bei Hop 20 −14 %, 2° −34 %, 3°
  −50 %. Bei hohem Tempo wird das Fenster so eng (bei 800 u/s ±1.2°), dass ein
  Spieler mit 3° Fehler bei ~400 u/s stehen bleibt.
- Bei gleicher Hand bringt VELOCITY (Cap 17, 128 Tick) **weniger** als CS2 mit 64
  Tick: 2° Fehler → Hop 10 444 statt 591, 4° → 294 statt 418 (kaum über Naive).
  Das relative sync-Modell zeigt davon nichts (400 gegen 407) — deshalb war der
  alte Cap-Sweep nicht aussagekräftig.
- Gleichmäßiges Drehen ist gutmütig: 150°/s ergibt 516 bei Hop 10 und steigt weiter.
- Innerhalb der Auftrags-Korridore bleibt der Vorgabe-Test "sync 0.7 > 330" auch
  im absoluten Modell erfüllt, wenn man gemessenen Sync 0.7 ansetzt (≈ 2.3–2.6°
  Fehler → ≈ 400–420 bei Hop 10).

**airSpeedCap-Sweep mit absoluten Spalten** (`npm run sim -- --sweep airSpeedCap=…`):

| cap | Perf H5 | Perf H10 | Perf H20 | 2° H10 | 3° H10 | 150°/s H10 | 0.7 rel. H10 |
|---|---|---|---|---|---|---|---|
| 15 | 414 | 529 | 705 | 400 | 323 | 478 | 372 |
| 16 | 431 | 557 | 747 | 422 | 342 | 497 | 386 |
| **17** | **450** | **585** | **788** | **444** | **361** | **516** | **400** |
| 18 | 468 | 613 | 830 | 466 | 380 | 535 | 415 |
| 19 | 487 | 641 | 872 | 489 | 400 | 554 | 430 |
| 20 | 506 | 670 | 914 | 512 | 419 | 573 | 445 |
| 22 | 544 | 728 | 999 | 558 | 458 | 611 | 476 |
| 25 | 604 | 816 | 1127 | 628 | 516 | 670 | 518 |
| 30 | 705 | 965 | 1342 | 743 | 608 | 768 | 573 |

**Entscheidung dieser Runde: Cap bleibt 17.** Begründung: die Korridore des
Auftrags sind erfüllt (auch der Sync-0.7-Korridor im absoluten Modell), der
Level-Strang baut gerade gegen diese Kurve (SpeedCurve in tools/levels/physics.ts),
und ein spürbar verzeihenderes Fenster (Cap 22–30) bricht den Korridor für den
perfekten Bot. Cap 18 läge noch in allen Korridoren (468/613/830) und brächte
Menschen +5 % — sinnvoll, sobald die Level stehen.

**Frage an den Auftraggeber (offen):** Sind die Korridore für den perfekten Bot
(Hop 10 ≈ 520–650, Hop 20 ≈ 700–900) wichtiger als Fehlertoleranz auf CS2-Niveau?
Wer das Fenster von CS2-64t will (±3.4° bei 500 u/s), braucht Cap 30; der
perfekte Bot läge dann bei 965/1342, und Level müssten für ~1.5× Tempo gebaut sein.
Ein Kompromiss wäre Cap 22 (perfekt 728/999, 2°-Spieler 558, 3°-Spieler 458).

### Weitere Sweeps

**airAccelerate** — ändert den perfekten Bot nicht (a ist ab 8.5 immer = cap), aber die Fehlertoleranz:

| airAccel | Perf H10 | 0.85 H10 | 0.7 H10 | 2° H10 | 3° H10 |
|---|---|---|---|---|---|
| 10 | 585 | 457 | 352 | 391 | 311 |
| 12 | 585 | 476 | 365 | 408 | 324 |
| 20 | 585 | 487 | 375 | 438 | 351 |
| **40** | 585 | **495** | **400** | **444** | **361** |
| 100 | 585 | 495 | 400 | 444 | 361 |

Unter ~2·cap/(wishspeed·dt) ≈ 17 wird das Fenster auf der Überdreh-Seite enger. Ab 40
gesättigt. Beim Surfen drückt "Taste in die Rampe" mit bis zu 78 u/s pro Tick
(40·250/128; Sprint wirkt in der Luft nicht mehr, s. Abweichungen).

**jumpImpulse** (Hangtime):

| jumpImpulse | Sprung | Luft | H10 | 0.7 H10 | Lücke @400 |
|---|---|---|---|---|---|
| **301.99** | 57 u | 0.750 s | 585 | 400 | 334 |
| 320 | 64 u | 0.797 s | 599 | 406 | 352 |
| 340 | 72 u | 0.852 s | 614 | 419 | 372 |
| 360 | 81 u | 0.898 s | 629 | 418 | 392 |

Mehr Hangtime bringt pro Hop nur +2–7 %, **pro Sekunde sogar weniger** (der Gewinn hängt an der
Luftzeit, längere Hops verteilen ihn nur). Dafür bricht schon 320 die Kisten-Staffel: 64-u-Kanten
gingen ohne Crouch-Jump. → CS-Werte bleiben.

**accelerate** (Boden, 0 → 250): 5.5 → 0.555 s · 6.5 → 0.313 · **8 → 0.203** · 10 → 0.141 · 12 → 0.109.
8 ist der Punkt, an dem Antritt direkt wirkt, ohne dass Gegenlenken/Stoppen zappelig wird.
Muss > friction bleiben, sonst liegt das Boden-Maximum unter runSpeed (Gleichgewicht v = ws·accel/friction).

**friction** (Stopp 250 → < 10): 4 → 0.50 s · **5.2 → 0.39 s** · 6.5 → 0.31 s. Im Korridor, CS-Wert bleibt.

## Sim-Tabellen (Auszug, `npm run sim`)

### Speed bei Landung nach Hop n (Start 250 u/s am Boden, Kurs halten)

| Hop | Strafe 1.0 | Strafe 0.85 | Strafe 0.7 | Zielfehler 2° | Zielfehler 3° | konst. 150°/s | Naive (W) |
|---|---|---|---|---|---|---|---|
| 1 | 300 | 285 | 267 | 286 | 273 | 280 | 250 |
| 2 | 344 | 323 | 277 | 322 | 302 | 309 | 250 |
| 3 | 383 | 352 | 303 | 343 | 307 | 337 | 250 |
| 5 | 450 | 392 | 329 | 381 | 325 | 391 | 250 |
| 8 | 535 | 455 | 367 | 423 | 348 | 468 | 250 |
| 10 | 585 | 495 | 400 | 444 | 361 | 516 | 250 |
| 12 | 631 | 534 | 420 | 451 | 346 | 562 | 250 |
| 15 | 694 | 580 | 450 | 474 | 358 | 627 | 250 |
| 20 | 788 | 658 | 512 | 521 | 396 | 727 | 250 |

10 s Bhop: perfekt 4814 u Luftlinie (Ø 484 u/s, Ende 658), 0.85 → 4195 u, 0.7 → 3473 u,
Zielfehler 2° → 3881 u, 3° → 3264 u, konst. 150°/s → 4268 u, Naive 2500 u.

### Boden & Sprung (VELOCITY_DEFAULT)

| Messung | Wert |
|---|---|
| 0 → 250 / 0 → 320 (Sprint) | 0.203 s / 0.203 s |
| Stopp 250 → < 10 / → 0 | 0.391 s / 0.406 s (39 u Bremsweg) |
| Stopp 320 → < 10 | 0.430 s |
| Geduckt gehen | 85 u/s |
| Sprunghöhe / Crouch-Jump (Füße) | 57.00 u / 75.00 u |
| Luftzeit flach (Landung per 2-u-Bodensonde) | 0.750 s |
| Sprint eine 33°/40°/44°-Rampe hoch | 0 Luft-Ticks (vorher bis 282 von ~500) |

### Sprungweiten (Absprung-Speed × Höhendifferenz, ohne Luft-Strafe)

Distanz (u, Origin) bis die Füße die Zielhöhe kreuzen; in Klammern max. Lücke Kante-zu-Kante (= +32).

| u/s | +48 | +32 | 0 | −64 | −128 | −256 |
|---|---|---|---|---|---|---|
| 250 | 132 (164) | 157 (189) | 189 (221) | 232 (264) | 264 (296) | 316 (348) |
| 320 | 169 (201) | 201 (233) | 242 (274) | 297 (329) | 338 (370) | 404 (436) |
| 400 | 211 (243) | 251 (283) | 302 (334) | 371 (403) | 423 (455) | 505 (537) |
| 500 | 264 (296) | 314 (346) | 378 (410) | 464 (496) | 529 (561) | 631 (663) |
| 600 | 317 (349) | 377 (409) | 453 (485) | 557 (589) | 635 (667) | 757 (789) |
| 800 | 423 (455) | 502 (534) | 604 (636) | 742 (774) | 846 (878) | 1010 (1042) |
| 1000 | 528 (560) | 628 (660) | 755 (787) | 928 (960) | 1058 (1090) | 1262 (1294) |

Crouch-Jump-Tabelle: `npm run sim` (Füße +18 u → +48 wird deutlich weiter, z. B. 400 u/s: 255 statt 211).

### Surf (Flanke normal.y ≈ 0.54, Start 400 u/s)

Ohne Eingabe gleitet man die Flanke hinunter: 783 → 1405 → 2060 u/s nach 1/2/3 s.
Mit Taste in die Rampe und Blick entlang der Rampe schwebt man (400 u/s, 2 u Höhenverlust in 3 s) —
das ist das Source-Verhalten: die Luftbeschleunigung in die Rampe wird von der Fläche nach oben
umgelenkt und hält der Schwerkraft die Waage. Tempo holt man durch Abwärts-Surfen + Strafen.

## Verworfen

- **airAccelerate runter statt Cap runter** (Cap 30 lassen, a < cap erzwingen): für H10 ≈ 585
  bräuchte es airAccelerate ≈ 2.5 → max. Luft-Drehrate bei 800 u/s nur ~40 °/s. Die Luft fühlt
  sich an wie Eis, Surfen wird unkontrollierbar. Das Fenster wird dabei auch nicht breiter:
  Gewinn-Form wird schief (Rampe statt Parabel), das Optimum liegt am steilen Rand.
- **Cap 30 lassen** (Source-treu): verzeihend wie CS2, aber perfekter Bot 965/1342 — außerhalb der
  Auftrags-Korridore (s. offene Frage oben).
- **Mehr Hangtime** (jumpImpulse 320–360): s. Sweep — pro Sekunde kein Gewinn, bricht die
  Crouch-Jump-Staffel.
- **friction erhöhen** für knackigeres Stoppen: 6.5 → 0.31 s, fällt aus dem Korridor und macht
  jeden verpassten Bhop-Tick teurer (Friction wirkt im ersten Bodentick nach verpasstem Sprung).
- **Kriech-Schutz als pauschale Schubkappe bei vel.y ≥ 0 an steilen Flächen** (Review-Vorschlag):
  nimmt Surfern das Hochsteuern auf der Rampe (Taste in die Rampe dreht die Bahn nach oben). Ersetzt
  durch den Schutz nur ohne Längsfahrt (s. u.).

## Abweichungen vom Source-Port (bewusst)

- **Doppelte Clip-Ebene** (aus Quake 3 `PM_SlideMove`): trifft ein Trace dieselbe Ebene zweimal
  (Rundung an schrägen Ebenen, Box knapp unter DIST_EPSILON), wird die Geschwindigkeit um die
  Normale herausgeschoben statt zwei identische Ebenen zu sammeln. Ohne das: Kreuzprodukt 0 →
  Stillstand mitten auf Surf-Rampen (in der Sim reproduziert, siehe learnings #17).
- **Steile Fläche am Boden = Wand** (neu): im Boden-Move clippt eine Fläche mit 0 < n.y < 0.7
  mit ihrer horizontalen Normale. Source schiebt die Hull dort per Clip die Flanke hoch, bis die
  2-u-Bodensonde nichts mehr findet: mit W am Fuß einer 50°/60°-Rampe wurde man ~17 u angehoben,
  war 255 von 256 Ticks in der Luft und 0 von 7 Sprüngen kamen durch. Jetzt: am Boden, Sprung klappt.
- **TryTouchGroundInQuadrants** (neu portiert): trifft die 2-u-Sonde eine steile Fläche, prüfen
  vier Viertel-Boxen, ob darunter Boden liegt (Rampenfuß, Kanten).
- **m_surfaceFriction 0.25** (neu portiert, eingeschränkt): wie Source, wenn man nach der
  Kategorisierung nicht am Boden ist und 0 < vel.y ≤ Abhebeschwelle — aber nur, wenn die Sonde eine
  steile Fläche getroffen hat. Source setzt es auch in freier Luft (letzte ~0.18 s jedes Aufstiegs);
  das würde bei airaccelerate 12 (CS2-Preset) den Strafe-Gewinn im Aufstieg vierteln und bei uns
  Luftbremse/Surf-Druck, ohne Nutzen. Bei airAccelerate 40 ändert 0.25 den cap-begrenzten Schub nicht
  (19.5 > 17) — es wirkt nur auf starken Druck.
- **Kriech-Schutz** (neu): in der Luft über einer steilen Fläche und mit weniger als 100 u/s
  Längsfahrt (entlang der Rampenachse) darf AirAccelerate die Falllinien-Speed nicht erhöhen.
  Grund: bei 128 Tick ist g·dt halb so groß wie in CS:GO, der cap-begrenzte Schub (17) übertrifft
  g·dt·tanθ bis ~70° — man kroch mit W ~10 u/s eine Surf-Flanke hoch. Halten (Schweben) bleibt
  möglich, Surfen mit Längsfahrt ist unberührt.
- **Abhebe-Schwelle nach Boden-Tick** (neu): CategorizePosition nach einem Boden-Tick nutzt
  max(nonJumpVelocity, nonJumpVelocity·maxBodenSpeed/250) = 179 statt 140. Source garantiert mit
  250 u/s: Laufen auf begehbaren Rampen erzeugt höchstens 0.5·v = 125 < 140. Mit Sprint 320 wären es
  160 → Sprint 33–44°-Rampen hoch war Hoppeln (bis 282 Luft-Ticks, Sprint langsamer als Gehen).
  Landungen (Ramp-Slide aus Bhop-Tempo) nutzen weiter 140. Auch Coyote benutzt die neue Schwelle.
- **Sprint nur am Boden** (neu): in der Luft ist wishspeed immer runSpeed. Vorher drückte Shift in der
  Luft mit 100 statt 78 u/s pro Tick (Surf-Halten, Luftbremse) — Luftphysik an einer Bodentaste.
  Strafe-Gewinn war nie betroffen (cap-begrenzt).
- **Sprung-Tick ohne Boden-Erkennung**: im Tick des Sprungs wird nie Boden kategorisiert — sonst
  würde ein im Tuning-Panel gesetzter jumpImpulse < nonJumpVelocity den Sprung verschlucken.
- **Sprung setzt vel.y = jumpImpulse, dann halbe Gravitation** (Source `CheckJumpButton` →
  `FinishGravity`). Ergebnis: exakt 57.00 u Sprunghöhe, auf den Tick-Stützstellen die exakte Parabel.
- **ClipVelocity wie Source 2013** (Nachkorrektur, falls Rundung noch in die Ebene zeigt) statt
  Quake/HL1-Nullen kleiner Komponenten.
- **Nicht portiert:** Wasser, Leitern, Base-Velocity.
- **Ducken am Boden:** Auge sinkt über duckTime, die Hull schrumpft (wie Source `m_bDucking` →
  `FinishDuck`) erst danach. Dadurch ist "Ducken + Springen im selben Tick" ein vollwertiger
  Crouch-Jump. Aufstehen am Boden: Hull sofort (wenn frei), Auge steigt weich.
- **Stuck-Schutz:** Source `CheckStuck` probiert eine Tabelle über mehrere Ticks; hier wird die
  Tabelle (26 Richtungen × 23 Radien bis 80 u) sofort durchsucht, **je Radius erst stehend, dann
  geduckt** — ein Respawn im Duck-Tunnel landet geduckt am Ort statt 80 u weiter auf dem Dach.
  Nach erfolgloser Suche erst nach 16 Ticks wieder (Source: Zeitdrossel), statt bis zu 1196
  Box-Tests pro Tick. Teleport auf exakte Bodenhöhe (Spawns!) zählt als Berührung = Solid und wird
  sofort freigeschoben.
- **Smart-Auto-Hop** (Plan 003): eine NUR gehaltene Sprungtaste (kein frischer Druck, kein Puffer,
  kein Mausrad) springt am Boden erst, wenn keine Bewegungstaste gedrückt ist, das Horizontal-Tempo
  ≥ 0.97 × Boden-Wunschtempo ist oder man ≥ 0.2 s am Stück am Boden steht. Source-Autobhop springt
  im Lande-Tick immer — weil der Sprung vor WalkMove kommt, beschleunigt der Boden dann nie, und in
  der Luft deckelt der Cap bei 24 u/s (W+Space aus dem Stand: 48 u in 2 s, nach jedem Treppen-Bonk
  Mondhüpfen). Bhop mit Tempo landet immer über der Schwelle → Skill-Decke unverändert.
- **Tempoabhängiger Luft-Cap** (Plan 003): AirAccelerate kappt wishspd mit `airSpeedCapAt(|v_h|)`
  (32 → 24 zwischen 350 und 700 u/s, Horizontal-Tempo vor dem Schub). Die Struktur der Formel bleibt
  (accelspd mit vollem wishspeed). An Surf-Flanken (steile Fläche unter einem oder `surfing`) gilt
  der Basis-Cap 24.
- **Strafe-Assist** (Plan 003): in der Luft wird `forward` für die wishdir auf 0 gesetzt, solange
  A/D gedrückt ist (auch beim Surfen). CS2-Preset: aus.
- **Duck-Walk unabhängig von Sprint** (Plan 003): geduckt am Boden immer runSpeed × duckSpeedScale.
- **Crouch-Jump nach Vor-Ducken** (Plan 003): ist die Hull beim Absprung vom Boden schon geduckt und
  darüber Platz, springt sie direkt in die Luft-Duck-Geometrie (Füße +18, eyeHeight −18).
- **Arcade-Pass** (Plan 007): Knick-Projektion (Bugfix, immer), Rampbug-Fix, Lande-Gnade, Hang-Landung,
  Kanten-Assist (inkl. Wand-Tasche), Rutschen, Luftlenkung — Übersicht rules/movement.md §1, Zahlen im
  Abschnitt "Arcade-Pass" unten.
- **strafeSync als Zeitfenster** (neu): Ring mit einem Slot pro Tick über 1 s (kein Sample / Fehl /
  Gewinn), strafeSync = Gewinne / max(Samples, ¼ Fenster). Vorher rückte der Ring nur bei
  Strafe-Eingabe weiter — nach 5 s Bhop und 20 s Stehen stand er noch auf 1.0 (Musik blieb auf Layer 1).
  Jetzt nach 1 s Stehen 0; der erste Sprung nach gerissener Kette meldet sync 0.

## Kamera: Stufen-Glättung (CameraRig)

Review-Befund: die alte Heuristik (Frame-Δy größer als "Rampe + Ducken") sah Stufen, die die
Interpolation auf zwei Frames verteilt, als zwei halbe und glättete nichts; eine erkannte Stufe
baute sich mit τ = 35 ms ab (bei 60 Hz 38 % pro Frame). Gemessen: Kamera-Sprung pro Frame 2–10 × so
groß wie der mittlere Anstieg.

Jetzt (`CameraRig.updateStepSmoothing`, CameraView hat dafür `eyeHeight` und `groundNormal`):
- Stufe = Höhenänderung der **Füße**, die die Bodenebene nicht erklärt (−(n.x·dx+n.z·dz)/n.y mit der
  Normale dieses oder des vorigen Frames), nur zwischen Frames, die ganz zwischen Boden-Ticks liegen
  (vel.y exakt 0). Ducken und Rampen werden nie geglättet; Landungen auch nicht.
- Ausgleich sofort im Frame der Stufe, Abbau **linear** wie Source `SmoothViewOnStairs`, aber mit
  treppenabhängiger Rate: einzelne Stufe in 0.1 s; auf einer Treppe 1.15 × (mittlere Steigung ×
  Speed), geschätzt aus Stufenhöhe und Lauflänge der letzten Stufen — die Kamera steigt dann fast
  gleichmäßig wie auf einer Rampe. Aufgestauter Versatz bleibt nie länger als ~0.1 s.

| Treppe | 30 Hz | 60 Hz | 144 Hz |
|---|---|---|---|
| 8/16 gehen / sprint | 1.23 / 1.30 | 1.39 / 1.09 | 1.16 / 1.21 |
| 16/32 gehen / sprint | 1.20 / 1.09 | 1.19 / 1.07 | 1.14 / 1.13 |
| 8/32 gehen / sprint | 1.20 / 1.09 | 1.19 / 1.07 | 1.12 / 1.13 |

(max. Kamera-Sprung pro Frame ÷ mittlerer Anstieg pro Frame während des Steigens. Vorher: 8/16
bei 60 Hz 7.2–8.0 u Kamera-Sprung bei 8 u Stufe, also praktisch keine Glättung; 16/32 bei 30 Hz
mit Sprint 16 u = ganze Stufe. Test:
`tests/camera.test.ts` verlangt < 1.5. Plot: `npx tsx tools/sim/cameraPlot.ts` →
`shots/movement/camera-steps.png`.) Auf Rampen 25°/40° bleibt die Kamera am Auge (< 2 u an den
Knicken bei 60/144 Hz).

## Bots (Messinstrument, nicht Gameplay)

- **StrafeBot sync 1.0**: Formel-Optimum jeden Tick (cos θ = (cap − a)/|v|), reines A/D.
  Übermenschlich — eine Obergrenze, kein Spielermodell.
- **sync < 1**: Markov-Episoden aus "gut" (kleines, driftendes Winkelrauschen im Fenster) und
  Fehlern (8 Ticks Ø: 55 % Überdrehen, 30 % Blick zu weit hinten, 15 % keine Taste). Fehler relativ
  zum Fenster → stellt einen HUD-Sync nach, **nicht** für Cap-/Preset-Vergleiche.
- **aimNoiseDeg / turnRateDeg**: absolute Menschenmodelle (s. oben) — dafür.
- **maxTurnRate**: Drehraten-Grenze; "perfekt @300°/s" zeigt, dass Drehrate allein kaum kostet.
- **RouteFollower** (Level-Durchlauf): Knoten-Semantik wie der Level-Strang ("jump: hier
  abspringen, Flug bis zum nächsten Knoten"), Landevorhersage per Hull-Traces, Crouch-Jump wenn
  nötig, Kantensprung statt Runterlaufen. Seit Review-Runde 1:
  - **Surf-Regler** auf die Falllinien-Speed: Ziel ist die Knotenlinie (+24 u); rutscht er schneller
    ab als gewünscht → voll in die Rampe (wishdir = −n_h), im Band → Gewinn-Strafe, darüber gleiten.
  - **Surf-Anflug**: sagt die Bahn eine Surf-Flanke voraus, drückt er schon im Fall in die Rampe.
  - **Luftbremse** nur, wenn Lenken nicht reicht und die gebremste Landung näher am Knoten liegt; zu
    Absprungknoten nie mit Bremse hüpfen.
  - **Rennlinie**: vor Knoten mit starkem Knick dreht er schon ein (Luftdrehrate cap/|v| pro Tick).
  - **Ehrlicher Fortschritt**: Knoten zählen nur, wenn die Füße höchstens 32 u darunter sind
    (vorher 128); seitlich bleibt die Toleranz 96 u (auf der Surf-Flanke heißt seitlich nur höher/tiefer).
  Level-Retuning auf Cap 24 + Kanten-Bevels (Level-Strang, 26.09. spät):
  - **Route-Flags statt Notiz-Präfixen** (`RouteNode.surf/air/precision`). Surf-Ziel: eine
    vorhergesagte Landung auf einer Surf-Flanke gilt als sicher — der Bot hüpft wie ein Mensch mit
    Auto-Hop direkt vom Boden auf die Rampe (vorher lief er bis zum Absprungknoten, fallen.md #32).
    Zu Surf-Knoten keine Luftbremse.
  - **Menschenmodell** `aimNoiseDeg` wird an den StrafeController durchgereicht (Level-Check:
    Hand 2°/3° als Info, der Pflichtweg soll für 3° schaffbar sein).
  - **Stop-and-Go**: Ein Hop, der ungebremst zu kurz ist, wird nicht gebremst versucht (ein
    gebremster Hüpfer entlang der eigenen Plattform kostete mehr Tempo als der Lauf zur Kante), und
    am Absprungknoten springt er nicht, wenn der Sprung zu kurz wäre — er läuft weiter und springt
    an der Kante (Test "Stop-and-Go"). Damit schafft auch sync 0.7 beide Level.
  - **Surf-Anflug** nur noch, wenn der vorhergesagte Aufprall unter der Knotenlinie liegt, und nur
    auf echte Flanken: Bevel-Normalen an Kanten, deren Horizontalteil in Flugrichtung zeigt, zählen
    nicht (fallen.md #41 — sonst bremst er sich an Inselkanten aus bzw. drückt sich auf den
    jetzt begehbaren Grat).
  Stand nach dem Retuning (`npm run levels:check`, Voll-Lauf Start → Ziel): Level 1 sync 1.0 31.4 s,
  sync 0.8 38.4 s, Hand 2° 42.4 s, Hand 3° 47.7 s, sync 0.7 50.0 s (Par 50); Level 2 sync 1.0 26.9 s,
  sync 0.8 34.3 s, Hand 2° 33.5 s, Hand 3° 42.0 s, sync 0.7 33.7 s (Par 60). Jeder Abschnitt geht
  mit allen fünf Modellen aus dem Stand. Tests: Level 1 und 2 mit sync 1.0/0.8, Pflichtweg 3°.
  Nach dem E2E-Review (27.09.):
  - **Verpasste Surf-Knoten**: Surft er (`state.surfing`) und hat einen Surf-Knoten entlang der
    Achse passiert, zählt der Knoten — auch tiefer als 32 u und bis 400 u seitlich (auf der Flanke
    heißt tiefer auch weiter außen). Vorher drehte er zum verpassten Knoten um; lag der hinter einem
    Drop, war er unerreichbar und der Bot blieb an der Flanke stehen (Level 2, 3°-Hand Seed 11 und
    sync 0.8 Seed 3). Im freien Fall zählt weiter nichts. Test: zwei Rampen mit Drop, hoher Knoten
    kurz vor dem Drop (ohne die Regel: 'stall').
  - **Mehrere Seeds**: Voll-Läufe laufen im Validator mit Seeds 1–8 (`FULL_RUN_SEEDS`) und
    berichten die Quote; ein einzelner Seed verdeckte Ausfälle. Stand (20 Seeds): Level 2 alle fünf
    Modelle 20/20; Level 1 sync 1.0/0.8 20/20, Hand 2°/3° 17/20, sync 0.7 16/20 (Ausfälle in
    Hop-Reihe und Slalom — die Prüfungen dieser Abschnitte).
  Zeiten (Median Seeds 1–8): Level 1 sync 1.0 29.2 s, sync 0.8 42.0 s, Hand 3° 46.3 s (Par 49);
  Level 2 sync 1.0 17.8 s, sync 0.8 20.6 s, Hand 3° 23.7 s (Par 25).
  Nach der Prüfung von Runde 1 (27.09.):
  - **Lenk-Vorrang** (`StrafeControllerOptions.steerPriority`, im RouteFollower Default an, nur
    Menschenmodelle): muss der Kurs korrigiert werden (Fehler > band), wird ein Zielfehler nach vorn
    auf die Dreh-Seite gespiegelt (gleicher Betrag). Bei 900 u/s ist das Gewinnfenster ±1.5°; ein
    1°-Zielrauschen lag halb davor — dort wirkt AirAccelerate nicht, die Kurve blieb bis 0.5 s aus,
    und die GUTEN Hände (schneller = kleineres Fenster) knallten im L1-Slalom an die Inselflanke
    (fallen.md #70). Varianten gegen 20/50 Seeds: +1 Fenster Bias (alle Zeiten +3 s, bei +2 Stalls),
    Klemmen aufs Optimum (am wenigsten Tode, aber Fehler nach vorn verschwinden = zu gut), Spiegeln
    (gewählt, Fehlergröße bleibt). StrafeBot/SpeedCurve (Level-Planung) unverändert, Level-Geometrie
    beim Neubau byte-gleich; gemessene Werte (Medaillen, Surf-minSpeed) verschieben sich.
  - **Über den Knoten hinaus gefallen** (`droppedPast`): landet der Bot hinter einem Knoten auf
    tieferem Boden (≥ 96 u darunter, kein Sprung zurück) und geht die Route ohnehin tiefer weiter,
    hakt er den Knoten ab statt umzukehren (L1: Überflug der letzten Slalom-Insel auf die Rutsche —
    4 von 11 Toden guter Hände waren dieses Umkehren).
  - Gute Hände L1, 50 Seeds (verify1/goodhands.ts), vorher → nachher: sync 0.95 49 → 48, sync 0.9
    47 → 47, Hand 1° 46 → 50, Hand 1.5° 46 → 49, Hand 2° 44 → 49 ("vorher" = ohne Lenk-Vorrang, mit
    Abhaken); 20 Seeds, Prüfer-Stand → jetzt: 20/18/16/16/19 → 19/18/20/19/19 (Slalom-Tode je Modell 0–2
    von 50). Respawn aus dem Stand ab CP2/CP3 (cp3stand.ts, 5 Modelle × 30): 131/133 → 144/140 von 150. L2 alle 50/50. levels:check prüft
    sync 0.9, Hand 1° und Hand 1.5° jetzt mit (Warnung bei Ausfall).
  - **NaiveBot** hält die Taste wirklich (`press: 'hold'`, Default; `'spam'` = alter Mausrad-Druck
    je Landung): L1/L2 5 s → 1057 u bei 247 u/s, mit Sprint 1334 u bei 313 u/s (vorher 169 u, 32 u/s).

## Entscheidung Integration (2026-09-26): Cap 24 — CS2-Parität für Menschen

Die Korridore aus dem ursprünglichen Auftrag bezogen sich auf den **perfekten**
Bot. Das war der falsche Maßstab: um ihn zu bremsen, musste der Cap auf 17, und
damit schrumpfte das Gewinnfenster so stark, dass ein Mensch mit 4° Zielfehler
bei Hop 10 kaum über Geradeaus-Hüpfen kam (294 vs. 250 u/s). Für ein Spiel,
dessen Skill-Decke Air-Strafing ist, ist das genau falsch herum: gerade die
ersten, unsauberen Strafes müssen sich lohnen.

Neuer Maßstab: **gleiche Hand → gleicher Speed wie CS2 mit 64 Tick.** Der
Sweep (`npm run sim -- --sweep airSpeedCap=22,24,25,30`):

| cap | Perf H5 | Perf H10 | Perf H20 | 2° H10 | 3° H10 | CS2-64: 2° / 3° H10 |
|---|---|---|---|---|---|---|
| 22 | 544 | 728 | 999 | 558 | 458 | 591 / 498 |
| **24** | **584** | **787** | **1084** | **604** | **497** | 591 / 498 |
| 25 | 604 | 816 | 1127 | 628 | 516 | 591 / 498 |
| 30 | 705 | 965 | 1342 | 743 | 608 | 591 / 498 |

Cap 24 trifft CS2 für 2° und 3° Zielfehler auf ±2 %. Der Test
"gleiche Hand, gleicher Lohn wie CS2" in `tests/movement.test.ts` hält das fest.
Die Skill-Decke (perfekter Bot) liegt höher als vorher — gewollt.
Folge: Level müssen für ~1.3× Tempo gegenüber der Cap-17-Kurve validiert werden.

Nachtrag Plan 003: Der Paritätstest heißt jetzt "gleiche Hand wird nie schlechter belohnt als in CS2"
(2°/4° Zielfehler, H10 ≥ 0.95 × CS2). Über 700 u/s ist die Physik pro Tick identisch mit Cap 24
(eigener Unit-Test), dort gilt die Parität von oben weiter.

## Runde Game-Feel (Plan 003, Strang movement, 27.09.)

Ziel: Default-Hilfen dürfen nie Beton erzeugen, die ersten Strafes müssen sich sofort lohnen,
die Skill-Decke bleibt (≤ +5 %). Alle Zahlen gegen die echte Engine (keine Unterklassen), Level-
Messungen gegen eine Kopie der Level von 01:03 ("Original-Level" der Kritik, fallen.md #30).
Mess-Skripte: `tools/critique/movement-curves/*` (aimgain-dyn, air, ground, crouchwall),
`tools/critique/synthese/smarthop.ts`, `npm run sim`.

### M1 Smart-Auto-Hop (autoHopSpeedShare 0.97, autoHopGroundTime 0.2 s)

Eine nur gehaltene Taste springt am Boden erst, wenn (a) Horizontal-Tempo ≥ 0.97 × Boden-Wunschtempo
(Sprint/Ducken/Tastenlänge wie computeWish), (b) ≥ 0.2 s am Stück am Boden oder (c) keine
Bewegungstaste gedrückt. Frischer Druck, Puffer, Mausrad und Coyote springen sofort.
`land.jumpQueued` nutzt dieselbe Bedingung (`heldHopReady`).

| Messung (flach, 2 s, Tasten ab t=0) | vorher | nachher |
|---|---|---|
| W+Space gehalten (Respawn-Fall): Weg / Dauertempo | 48 u / 24 u/s | **470 u / 245 u/s** |
| W+Shift+Space gehalten | 48 u / 24 u/s | **606 u / 315 u/s** |
| W+Space, Leertaste bei t=0 frisch gedrückt (erster Hop im Stand, gewollt) | 48 u / 24 u/s | 317 u / 247 u/s |
| W+Shift+Space frisch gedrückt | 48 u / 24 u/s | 395 u / 313 u/s |
| L1-Treppe (Original-Level), 30 Phasen, Anlauf 320: oben angekommen | 0/30 (24 u/s, > 6 s) | **30/30** (313–315 u/s, Ø 2.15 s) |
| L1-Rampe, 30 Phasen: min. Tempo oben | 136 u/s | **311 u/s** |
| Wand (64 u) bei Speed 0, W+Space gehalten: Landung → Sprung | 0.008 s (Mondhüpfen) | **0.203 s** |
| Wand-Hüpfen: Hop-Kette | zählt hoch (×11) | 1 (Kette reißt, > 3 Boden-Ticks) |
| Perfekter StrafeBot ab 320 (H1/H5/H10), nur Smart-Hop | 397/617/812 | 397/617/812 (identisch, auch nur gehalten) |

Warum **0.97 statt 0.95** (Plan): die Schwelle garantiert nur Hop-Tempo ≥ Anteil × Wunschtempo. Mit
0.95 sind das 237.5 u/s, gemessen je nach Beschleunigungs-Phase 238–244 (W+Space gehalten: 239,
Akzeptanz ≥ 240 verfehlt). Kleinster Anteil mit Garantie ≥ 240/305: 0.96. Nicht 0.99/1.0: genau auf
Wunschtempo scheitert die Bedingung an Rundung (249.9999) und jede W-Landung stünde 0.2 s.

| Anteil (nur M1, Cap 24) | 0.90 | 0.95 | **0.97** | 0.98 | 0.99 | 1.00 |
|---|---|---|---|---|---|---|
| W+Space gehalten: Weg / Tempo | 437/226 | 460/239 | **470/245** | 480/250 | 480/250 | 480/250 |
| W+Shift+Space gehalten | 564/292 | 593/308 | **606/315** | 606/315 | 614/320 | 614/320 |
| Rampe min. / Treppe min. | 288/292 | 304/308 | **311/315** | 315/315 | 317/315 | 320/315 |
| 1. Sprung nach | 0.172 s | 0.188 s | **0.195 s** | 0.203 s | 0.203 s | 0.203 s |

Bodenzeit zählt ein eigener Zähler `groundTicks` (Lande-Tick zählt mit, Teleport = 0), nicht
`frictionTicks`: das steht nach dem Spawn auf NO_LANDING, Bedingung (b) wäre sofort erfüllt und der
erste Hop nach jedem Respawn wieder einer im Stand (so misst `synthese/smarthop.ts`: 306/384 u).

### M1b Smart-Hop bremste Strafer mit gehaltener Taste (Prüfung 27.09.)

Befund: Mit NUR gehaltener Taste und Auto-Sprint (Schwelle 0.97 × 320 = 310 u/s) wartete jede
Strafe-Landung unter 310 u/s bis 0.2 s am Boden — Reibung, Kette reißt. Kein Bot sah das, alle
drückten bei jeder Landung frisch (fallen.md #68). Neu: **mit A/D gedrückt, im ersten Bodentick nach
≥ 0.25 s Luft** reicht `autoHopLandShare` 0.75 × Wunschtempo (240 mit Sprint, 187 ohne). Kriechen
(24–32 u/s) und Anprall (0) bleiben weit darunter; der Antritt aus dem Stand und reines W bleiben
bei 0.97 (sonst hopste der W-Halter nach einem Treppen-Teilanprall dauerhaft mit 241 statt 312).
`jumpWillQueue` nutzt weiter `heldHopReady` (gleiche Bedingung).

`tools/critique/verify1/heldhands.ts` (flach, 8 Seeds, Landetempo H1/H3/H5/H10/H20, nur gehalten):

| Start 320, Sprint | frisch gedrückt | gehalten vorher | gehalten nachher |
|---|---|---|---|
| 6°-Hand | 357/397/368/382/357 | 357/386/345/353/**313** (69 von 160 Landungen warten, 1575 Bodenticks) | 357/397/368/382/**351** (3 warten, 75 Ticks) |
| 5°-Hand | 379/436/420/435/410 | 379/436/420/427/401 (17 warten) | 379/436/420/435/410 (0) |
| 6°-Hand ab 250 | 325/387/365/381/357 | 325/358/331/337/309 (86 warten) | 325/387/365/381/351 (3) |
| perfekt / 3° | unverändert | unverändert | unverändert |

Die drei verbleibenden Wartefälle sind Landungen unter 240 u/s (verpatzter Strafe) — dort ist
der Boden-Antritt gewollt. Unverändert: W+Space gehalten 470 u/245 u/s, mit Sprint 606 u/315 u/s
(synthese/smarthop.ts); Rampe/Treppe (ramp-phase.ts) 30/30, min 312, Ø 1.42 s; Wand bei Tempo 0:
erster Sprung nach 0.195–0.203 s; Leertaste-Halter bis CP1 310/310 in beiden Leveln
(spaceholder.ts). Zwischenstand ohne die A/D-Bedingung: Treppe min 241 (W-Halter) → verworfen.
Vitest: "gehaltene Taste nach Luftphase: knapp unter Lauftempo springt sofort, Kriechtempo wartet".

### M3 Tempoabhängiger Luft-Cap (32 → 24 zwischen 350 und 700 u/s)

`airSpeedCapAt(cfg, |v_h|)` (MovementConfig.ts) ist die einzige Formel; PlayerMovement, StrafeController,
RouteFollower (Rennlinie) und HUD (SpeedTrend) rufen sie. Horizontal-Tempo vor dem Schub.

aimgain-dyn (StrafeBot mit absolutem Zielfehler, ab 320, 8 Seeds, Landungs-Speed):

| Hand | vorher H1/H3/H5/H10/H20 | nachher H1/H3/H5/H10/H20 | CS2 64 t H10/H20 |
|---|---|---|---|
| perfekt | 397/519/617/812/1103 | 442/590/687/867/1144 | 734/988 |
| 3° | 371/441/470/526/540 | 416/**513**/545/595/593 | 522/582 |
| 4° | 355/404/405/427/410 | 399/475/480/505/484 | 440/464 |
| 5° | 337/367/345/353/**329** | 379/436/420/435/**410** | 371/381 |
| 6° | 317/330/294/300/**278** | 357/397/368/382/**357** | 317/323 |

Die 5°/6°-Hände liegen nach 20 Hops jetzt über dem Sprint-Start (320) und über CS2. Sim ab 250
(`npm run sim`): perfekt H5/H10/H20 584/787/1084 → 670/853/**1134** (+4.6 %), Zielfehler 2° H10
604 → 676, 3° H10 497 → 576, 4° H10 408 → 492, konst. 150°/s H10 651 → 728, Naive 250 (unverändert).

**Nicht an Surf-Flanken.** Mit Cap 32 auch in Surf-Kontakt drückte "Taste in die Rampe" langsam 33 %
stärker: der Grundtechnik-Surfer auf der L2-Kette kletterte (vy +25 statt +11 u/s) und fuhr eine
andere Linie; +3° Blickversatz 512 → 1007 u/s, aber +5° fiel 160 u vor dem Launch statt mit 761
anzukommen. Halten/Klettern an Flanken ist auf Cap 24 abgestimmt (fallen.md #28). Mit Basis-Cap bei
Surf-Kontakt (`steepBelow || surfing`) ist die Surf-Kette in allen Blickversätzen (−4…+10°) und mit
zitternder Hand (1–3°, 6 Seeds) bitgleich zu vorher.

Bot-Instrument: das relative Fehlermodell (sync < 1) skaliert seine Winkelfehler mit dem Gewinnfenster.
Mit Cap(v) wäre die Hand bei niedrigem Tempo absolut schlampiger geworden (RouteFollower sync 0.8 fiel
in 3/8 Seeds in die erste Sandbox-Lücke). Das Fenster nutzt jetzt den Basis-Cap `airSpeedCap`
(StrafeController): gleiche Hand wie vorher, Physik belohnt sie stärker (fallen.md #50).

### M4 Strafe-Assist (strafeAssist, VELOCITY an, CS2 aus)

air.ts "Schwung" (Blick startet auf der Flugrichtung, Maus dreht konstant, Zickzack, ab 320):

| Hand | vorher H1/H2/H3/H5/H10 | nachher |
|---|---|---|
| 90°/s, A/D | 346/373/399/451/576 | 356/392/426/491/632 (M3) |
| 90°/s, A/D + W gehalten | 330/340/350/370/419 | **356/392/426/491/632** (= reines A/D) |
| 135°/s, A/D + W gehalten | 342/364/385/427/527 | 372/421/467/552/725 (= reines A/D) |

Surf (L2-Kette ab CP2, Grundtechnik-Surfer, Blickversatz −2/0/+2/+5°): W+A starb vorher in jedem
Versatz an der ersten Rampe (kill z −2174…−2232: W dreht die wishdir zur Fahrtrichtung, add < 0, kein
Druck in die Rampe). Mit Assist identisch zu reinem A: 1380/1276/1074/761 u/s. Deshalb gilt der
Assist auch in Surf-Kontakt; die Variante "aus bei Surf-Kontakt" ließ W+A weiter sterben. Einziger
schlechterer Fall: Blick IN die Rampe + W + Taste entlang der Fahrt stirbt 120 u früher (kill z −2125
statt −2242) — stirbt in beiden. Blick in die Rampe mit W allein ist unberührt. Auf der synthetischen
Riesenrampe (surfWorld) glitt W+A vorher ohne Druck ab (1969 u/s, 2305 u tiefer), jetzt hält es wie A
(401 u/s). Perfekter Bot unverändert (reines A/D), CS2 identisch.

### M5 Ducken unabhängig von Sprint

Duck-Walk mit Sprint 108.8 → **85.0 u/s** (ohne Sprint 85.0). Voraussetzung für Auto-Sprint (Sprint
dauerhaft an). Hinweis: `ground.ts` rechnet "Duck-Walk mit Sprint" analytisch (sprintSpeed ×
duckSpeedScale) und zeigt deshalb weiter 109 — gemessen ist 85.

### M6 Crouch-Jump nach Vor-Ducken

Ist die Hull beim Absprung vom Boden schon geduckt (Ducken > duckTime vor dem Sprung) und die
Stand-Hull frei, geht sie im Sprung-Tick in die Luft-Duck-Geometrie: Füße +18, eyeHeight −18 (Welt-Auge
bleibt), danach läuft eyeHeight mit Duck-Rate (18 u / 0.15 s = 0.94 u/Tick) auf duckEye.

| Ducken vor dem Sprung | 0–140 ms | 160 ms | 250 ms | 500 ms |
|---|---|---|---|---|
| Füße max. vorher | 75.0 | 57.0 | 57.0 | 57.0 |
| Füße max. nachher | 75.0 | **75.0** | **75.0** | **75.0** |

Welt-Auge relativ zu einem parallelen Normalsprung: im Sprung-Tick kein Versatz, danach Zusatz-Hub
höchstens 0.94 u/Tick ≈ 2.0 u pro 60-Hz-Frame (0.94 bei 144 Hz) — dieselbe Rate wie der bisherige
Crouch-Jump mit 100 ms Vor-Ducken. Unter niedriger Decke (Stand-Hull nicht frei) kein Hub.
crouchwall.ts ohne Ducken weiter 0/80.

### Auswirkung auf die Level (für die Neuvalidierung, Plan 003 S3)

RouteFollower-Voll-Läufe, 20 Seeds, "neu" = diese Runde, "alt" = Cap 24 konstant, ohne Assist,
Autobhop sofort. Kopie = Level von 01:03, aktuell = Level-Strang-Build von 02:39:

| Level | Modell | neu | alt |
|---|---|---|---|
| L1 Kopie | 2° / 3° / sync 0.8 / sync 0.7 | 15 / 18 / 20 / 16 (sync 0.8 Median 30.8 s) | 17 / 17 / 20 / 16 (42.2 s) |
| L1 aktuell | 2° / 3° / sync 0.8 / sync 0.7 | 16 / 16 / 20 / 16 (35.1 s) | 17 / 20 / 19 / 11 (41.6 s) |
| L2 Kopie | 2° / 3° / sync 0.8 / sync 0.7 | 20 / 19 / 19 / 18 | 20 / 20 / 20 / 20 |
| L2 aktuell | 2° / 3° / sync 0.8 / sync 0.7 | 19 / 20 / 20 / 20 | 20 / 20 / 20 / 20 |

Summe L1 gleich (137/160 gegen 137/160), Läufe deutlich schneller. Die Tode wandern vom frühen Teil
(Knoten 12–16) in den schnellen Schluss (Knoten 24–31: Überschieß-Bänder). Der perfekte Bot (sync 1.0)
ist auf L1 langsamer (35.0 statt 29.2 s): er landet nach dem Crouch-Jump (Knoten 16) 66 u weiter, nur
188 u vor der +64-Stufe; von dort trägt kein Sprung, er läuft (Friction 661 → 330 u/s) und stößt an.
Level-Tempo und Überschieß-Bänder für die neue Kurve neu messen (S3). Der Vitest "Pflichtweg 3°-Hand"
stand auf dem Build von 02:39 bei 5/8 Seeds (20 Seeds: 16/20), auf der Kopie bei 7/8.

Level-Build 02:49 (gegen diese Physik gebaut), 20 Seeds neu / alt: L1 Hand 2° **13** / 17 (Tode vor
Knoten 27–29), Hand 3° 19 / 19, sync 0.8 20 / 19, sync 0.7 18 / 18; L2 2° 19 / 20, sonst 20 / 20.
`npm run levels:check`: 3 Level, 0 Fehler, 1 Warnung (L1 Hand 3° 7/8), Vitest grün. Offen für S3:
die bessere 2°-Hand ist schneller und überschießt den schnellen Schluss von L1 (Knoten 27–29).

## Arcade-Pass (Plan 007, Strang movement, 28.09.)

Nutzerwunsch: Spaß, arcadig, smooth, befriedigend statt 1:1-CS; harte Grenzen bleiben (kein Walljump,
Wallrun, Double-Jump), die Skill-Decke bleibt das Strafen. Jede Abweichung hat einen Schalter in
`MovementConfig` (CS2 = 0/aus → `npm run sim -- --preset cs2` in allen eigenen Spalten bitgleich zu vorher).
Alle Zahlen gegen die echte Engine; Werkzeug: **`npm run sim -- --section arcade`** (`tools/sim/arcade.ts`,
Spalte "aus" = nur dieser Schalter auf 0, "an" = VELOCITY). Prototypen und Entwurfszahlen:
`tools/critique/v2/{momentum,arcade-mechanics,level3,level4}`. Die Mechaniken wurden einzeln eingebaut und
nach jedem Schritt mit `levels:check` (eingefrorene Kopie der Werkzeuge, fallen.md #30) gemessen.

### A1 Knick-Projektion (Bugfix, immer)

`tryPlayerMove`, zwei Clip-Ebenen ohne Einzellösung: `vel.copy(dir).multiplyScalar(dir.dot(vel))` wertete
das Skalarprodukt NACH dem Kopieren aus → |v| = 1 u/s entlang der Knick-Kante → Luft-Hänger in konkaven
Ecken. Jetzt `along = dir·vel` vorher (Source). `tools/critique/v2/level4/cornercling.ts`: **21/72 → 0/72**
Hänger. levels:check L1/L2 nach M1 zeilengleich (nur Laufzeiten).

### A2 Rampbug-Fix (`surfSeamFix`)

Beginnt ein Luft-Move an einer Surf-Fläche und trifft der Trace eine Ebene gegen die Fahrt (horizontal
cos < −0.5, |v_h| > 100), wird derselbe Weg 0.25/1/2 u entlang der letzten Surf-Normale angehoben
nachgetraced; kommt der weiter und trifft keine Gegen-Ebene, gilt er. Echte Stirnwände treffen auch
angehoben. `probeCurveSweep.ts` (45°-Kurve, 1536 u Bogen, Raster wie der Validator, 108 Läufe je Zeile),
Innenflanke, Stand vor v2 (HEAD) → finale Physik (Review-Runde 28.09. vollständig nachgemessen):

| Achsgefälle | Stücke je 45° (Knick je Fuge) | 2 (22.5°) | 3 (15°) | 4 (11.3°) | 6 (7.5°) | 12 (3.8°) | 24 (1.9°) |
|---|---|---|---|---|---|---|---|
| 0° | Nahtstopps | 0 → 0 | 1 → 0 | 3 → 0 | 10 → 0 | 43 → 1 | 82 → 0 |
| 0° | Energieverlust | 20 → 19 % | 18 → 18 % | 12 → 12 % | 11 → 11 % | 16 → 9 % | 29 → 8 % |
| 6° | Nahtstopps | 2 → 0 | 14 → 0 | 27 → 0 | 15 → 0 | 50 → 0 | 55 → 0 |
| 6° | Energieverlust | 10 → 9 % | 10 → 8 % | 17 → **4 %** | 9 → **4 %** | 25 → **2 %** | 30 → **1 %** |
| 10° | Nahtstopps | 4 → 0 | 11 → 0 | 6 → 0 | 14 → 0 | 22 → 0 | 52 → 0 |
| 10° | Energieverlust | 10 → 8 % | 10 → 10 % | 7 → 6 % | 10 → 7 % | 15 → **4 %** | 31 → **3 %** |

Außenflanke: keine Verschlechterung gegen HEAD. Die Nahtstopps sind überall weg; der Restverlust grober
Gehrungen (6–10 % bei 2–6 Stücken, 8–19 % bei flacher Achse) ist Geometrie, keine Naht. Die Abnahme "≤ 5 %"
gilt also nur für feine Gehrungen — **Level-Regel (L3):** Surf-Gehrungskurven mit Achsgefälle ≥ 6° und Knick
≤ 4° je Fuge (≥ 12 Stücke je 45°), dann ≤ 4 %. L1/L2 nach M2 zeilengleich; eine glatte Surf-Rampe fährt mit
und ohne Fix bitgleich (Vitest).

### A3 Lande-Gnade (`landGraceTime` 0.0625 s = 8 Ticks)

Nach einer Landung aus ≥ 0.1 s Luft keine Friction in den ersten 8 Bodenticks (`frictionTicks` zählt jetzt
Bodenticks seit der Landung). Schub-Kappe: Boden-Accelerate hebt |v_h| in der Zeit nicht über
max(Tempo davor, wishspeed). Kette und `lastAirSync` reißen erst nach max(3, 8) Ticks. `jump.clean` =
perfekt oder alle Bodenticks davor in der Gnade.

| Messung | aus | an |
|---|---|---|
| Sprung k Ticks nach der Landung, 700 u/s: k = 1 / 2 / 4 / 8 / 9 / 12 | 672 / 644 / 593 / 502 / 482 / 426 | **700 / 700 / 700 / 700** / 672 / 593 |
| k = 1…8 bei 400/700/1000: Abweichung vom Landetempo · k = 9: Abweichung von genau v·5.2/128 | – | **0.000 · 0.000** |
| Tipp-Hand ±20 ms (perfekter Strafe, 8 Seeds) H5/H10/H20 | 677/701/742 | **726/897/1166** |
| Exploit: Landung 500, 8 Ticks Ground-Strafe W+D, Sprung (ohne Kappe im Prototyp 591) | 448.7 | **500.0** |
| Drop 800 u/s ohne Sprung, W: Tempo nach 0.05 / 0.1 / 0.25 s (momentum/grace.ts) | 624 / 467 / 320 | 800 / 650 / 320 |

`npm run sim` nach M3: nur die Zeilen "Naive aus dem Stand … frisch gedrückt" ändern sich (395 → 403 u),
CS2 bitgleich. levels:check nach M1–M3: 0 F / 2 W wie vorher, L1 Hand 2° 7/8 → 8/8, sync 1.0 25.1 → 24.3 s,
Verlust je Auffangmulde L1 0.30 → 0.16 s, L2 0.34 → 0.25 s.

### A4 Deterministische Hang-Landung (`slopeLandGain` 1)

Referenz = Anflug-Geschwindigkeit vor dem ersten Clip an begehbarem Boden (`tryPlayerMove`) bzw. vor der
2-u-Sonde (Sonden-Fall). Geklippt nach oben > nonJumpVelocity → Rampslide (in der Luft bleiben) in jeder
Phase; sonst Landung in alter Richtung mit h1 = h0 + k·max(0, Clip-Anteil entlang der Flugrichtung − h0).
Flacher Boden (n.y ≥ 0.9999) unberührt. `land.speed` meldet das umgelenkte Tempo.

| Messung (5–35°, 320/600/1000 u/s, Fall 57/192 u, je 16 Tick-Phasen) | aus | an |
|---|---|---|
| bergab: größte Spreizung max − min | 353.8 | **2.94** |
| bergauf ohne Rampslide: Spreizung / größter Verlust gegen den Anflug | 53.9 / 53.9 | **0 / 0** |
| Rampslide-Fälle: Spreizung | 803.2 | 3.51 (35°, 1000 u/s) |
| Beispiel 10° bergab 320/192: min/max | 320 / 415 | 415 / 415 |

Die Rest-Spreizung ist Physik, nicht Lotterie: das Messraster startet je Phase bis zu einen Fall-Tick höher,
der Aufprall ist dadurch bis g·dt = 6.25 u/s schneller; auf 35° gibt das ×sinθcosθ ≈ 2.9 u/s (bergab)
bzw. nach dem Rampslide-Flug 3.5 u/s.

W + Leertaste gehalten, 1500 u Hang ab 320 u/s: 5° 378 → 435, **10° 381 → 508, 16° 320 → 656**,
25° 493 → 693 u/s; Energie-Decke √(v0² + 2gΔh) 559/725/889/1105 nie überschritten. levels:check nach
M1–M4: **3 F** — L1 Könner-Inseln (perfekter Bot scheitert), L2 Ausfahrt 1/600, L2 S0 1/12 (wie der
Prototyp "slopeslide").

**Hügel-Pumpe (Review 28.09.) → gestundeter Bergauf-Verlust.** "Energie-begrenzt" galt nur auf gleichförmigem
Gefälle. Auf Wellen erntete jede Talfahrt den Sprungimpuls, den der Aufstieg gratis bekam (bergauf kein
Verlust, bergab Gewinn, dazwischen verlustfreier Bodenlauf): nur W + Leertaste, kein Strafen, Tempo nach
10 / 20 / 30 s (`hillRun`, sim-Zeile "Hügel-Pumpe"):

| Wellen | Source (slopeLandGain 0) | Arcade vorher | **jetzt** |
|---|---|---|---|
| 5°, Periode 512 u | 311 → 320 → 320 | 415 → 518 → 621 | **353 → 353 → 353** |
| 10°, 512 u | 312 → 312 → 376 | 482 → 594 → 783 | **377 → 377 → 377** |
| 10°, 1024 u | 315 → 320 → 319 | 570 → 742 → 785 | **430 → 430 → 430** |
| 15°, 768 u | 319 → 320 → 315 | 519 → 523 → 578 | **413 → 414 → 414** |
| 10°, 1024 u + 512 u eben | 320 → 381 → 445 | 468 → 673 → 788 | **430 → 430 → 430** |

(Hand-3°-Strafer auf flachem Boden H20: 646.) Fix: der erlassene Clip-Verlust bergauf (h0 − along) wird als
Schuld gemerkt und vom nächsten Bergab-Gewinn abgezogen; die Schuld ist nie größer als das Tempo über dem
Lauftempo (je Tick gekappt — Reibung, Wände und Stehen löschen sie), teleport löscht sie. Bergauf bleibt es
verlustfrei, auf gleichförmigem Gefälle ändert sich nichts (Tabelle oben, Einzel-Landungen, W+Space-Kette
zeilengleich), CS2 bitgleich. Verworfen: (a) Review-Option A "bergauf wieder verlustbehaftet (phasenfest)" —
kippt die Planentscheidung und kostet den perfekten Bot auf L1 **24.91 → 28.73 s** (L2 17.05 → 17.18 s);
(b) Schuld nur bis zum Tempo-Äquivalent der gewonnenen Höhe — die Pumpe kommt langsam zurück (5°/512 353 →
416 → 542, 10°/512 436 → 506 → 593), weil auch der Abstieg den Sprungimpuls erntet; (c) Energie-Kappe ab
Absprunghöhe (Review-Prototyp) — 10°/1024 noch 811. Pausen-Exploit (nach jeder Landung 10 Ticks am Boden)
und perfekter Strafer auf Wellen: wie vorher (Pause ~320; Strafer 5°/512 1594 statt 1665 nach 30 s, flach
1569). Folge auf L2: der perfekte Bot landet im überhöhten Ring (n.y 0.985) mit Drift nach außen = bergauf
(Schuld bis 59 u/s), die 10°-Ausfahrt gibt dann +23 statt +82 u/s → sync 1.0 **17.05 → 17.48 s**; L1 bitgleich.
Fehler-/Warnliste von levels:check unverändert.

### A5 Anfänger-Cap `airSpeedCapLow` 32 → 40

| StrafeBot mit Zielfehler, Start 320, 8 Seeds | Cap 32 | Cap 40 |
|---|---|---|
| 3°: H10 · Zeit bis 500 u/s (Median) · Seeds ≥ 500 | 590 · 2.2 s · 8/8 | **631** · 1.2 s · 8/8 |
| 4° | 514 · 4.0 s · 8/8 | 565 · **1.8 s** · 8/8 |
| 5° | 451 · – · 4/8 | 510 · 2.6 s · **8/8** |
| perfekt ab runSpeed H5 / H10 / H20 | 670 / 853 / 1134 | **717 / 890 / 1162** |

Decke +2.5 % (ab 250) bzw. +7.2 % gegenüber konstantem Cap 24 (1084); Testkorridor jetzt H5 700–735,
H10 875–905, H20 ≤ 1170. Abstand perfekt/3° bleibt (H20 1.83 → 1.80). CS2-Paritätstest ("gleiche Hand nie
schlechter als CS2") grün. Surf-Halten unverändert 401 u/s (4 u mehr Höhe: Cap 40 in den freien Luftticks
vor dem ersten Kontakt). levels:check nach M1–M5: **2 F / 1 W** (L1 Könner-Inseln wieder 5/6, Ø 2.9 s;
neu Warnung L1 CP2→CP3 Hand 3° aus dem Stand).

### A6 Kanten-Assist (`ledgeStep` 5 u, `ledgeMemory` 0.2 s)

Port aus `arcade-mechanics/ArcadeMovement.ts` (airSlideMove) plus zwei Befunde dieses Strangs:
- **Gedächtnis wurde überschrieben.** Mit Cap 40 drückt der Luft-Schub nach dem Anprall mit ~50 u/s weiter
  gegen die Wand; das war selbst ein "Anprall" über LEDGE_MIN_SPEED und ersetzte die gemerkten 539 u/s nach
  einem Tick durch 50. Jetzt überschreibt nur ein stärkerer Anprall. Treppe 48/192 perfekt: 8.17 → **3.30 s**
  (ohne den Fix 8.17 s trotz Assist; mit Phase-0-Physik wie im Prototyp 3.24 s).
- **Wand-Tasche.** fixcheck (L4-Bande) zeigte mit dem vollen Paket 1/702 Luft-Hänger: zwischen zwei um 4°
  verdrehten Banden-Stücken greift die Doppelebenen-Regel (dot > 0.99), kein Bump kommt vom Fleck, Source
  nullt die Geschwindigkeit, W drückt weiter → 2 s Schweben. Jetzt: nur Wände getroffen, keine Bewegung →
  senkrecht weiterfallen. **1/702 → 0/702**, cornercling 0/72, levels:check unverändert.

| Messung | aus | an |
|---|---|---|
| L1-Crouch-Kante OHNE Ducken (H7, 40 Startpunkte × 5 Tempi) | 0/200 | **0/200** |
| MIT Ducken, gekrochen (< 50 % Tempo) bei 600 / 761 / 900 u/s | 15 / 20 / 23 von 40 | **1 / 1 / 1** |
| zu spät geduckt (0–148 ms nach dem Anprall): Ø Ankunftstempo | 15 % | **98 %** (nur Kanten-Assist auf Phase-0-Physik: 77–86 % wie der Prototyp; Lande-Gnade bzw. Rutschen halten das Tempo in den ersten Bodenticks auf der Kante: 28 → 3 Ankünfte unter 50 %) |
| Treppe 48/192, perfekt ab 320: bis 384 u | 8.17 s | **3.30 s** |
| Treppe 32/192 (Rückschritt durch das Gedächtnis, s. u.) | 7.70 s | 8.27 s |
| Treppe 24/192 | 10.98 s | **5.19 s** |
| L1-Rutsche seitlich (dbg-chute: Knoten 31, ±48, 600–1100 u/s) | 9/9 im Ziel | 9/9 |
| Höchste Kiste ohne Ducken (Stand/Lauf · aus der Auto-Hop-Landung) / mit Crouch-Jump | 57 · ~58.5 / 75 u | **62 · 63–63.5 / 80 u** |
| Kante ohne Ducken aus dem Auto-Hop-Rhythmus, je 80 Läufe: 62 / 63 / 64 / 66 u | 0 / 0 / 0 / 0 | 7 / 2 / 0 / 0 |
| Sprung 1 / 6 / 25 u vor einer Stufe 4 / 8 / 16 u, 600 u/s: Luftzeit · Landetempo | 0.74 s · 0 (Bonk) | vorher 0.01–0.05 s · 600, **jetzt 0.69–0.73 s · 600** |

**Reichweite ohne Ducken (Review 28.09.):** die Auto-Hop-Landung schwebt bis 1.5 u über dem Boden (Füße im
Tick vor dem Absprung 0.03–1.53 u, 2-u-Sonde) und der nächste Sprung startet dort — ohne Ducken erreicht man
bis 63 u (Bhop-Strafer 62.5 u 12/120, W + Leertaste 63 u 5/120, 63.5 u 0/240). "64 = 57 + 5 + 2 Reserve"
hatte also ≤ 1 u Reserve; der Validator (level-tools, `noDuckReach` 63.5 u + 2) warnt schon für die
L1-Kante (64.0 u). Level-Regel deshalb **Crouch-Kanten ≥ 66 u** (L1-Kante und die zwei L4-Kanten auf 66 u).
Vitest: aus dem Auto-Hop-Rhythmus 62 u erreichbar, 66 u in 0/80.

**Lip-Step im Steigen (Review 28.09.):** "vel.y = 0, auch steigend" verschluckte den Sprung, wenn man direkt
vor einer Stufe/einem Bordstein absprang (8–47 ms Luft, danach Reibung ohne Lande-Gnade). Jetzt kein Lip-Step,
solange der Rest-Aufstieg v_y²/2g die Kante um ≥ 2 u selbst überragt; das Gedächtnis gibt das Tempo zurück,
sobald die Hull oben frei ist (Zeile oben). Knapp vor dem Scheitel fängt der Lip-Step weiter (60-u-Kiste bei
250 u/s: 3 Steps steigend, 2 fallend; Vitest). Ohne Gedächtnis (`ledgeMemory` 0) bleibt der alte Fang. Die
Review-Variante "nur fallend" verlor diesen Scheitel-Fang (Kamera-Integrationstest rot). `--section arcade`
bis auf die neuen Zeilen zeilengleich (0/200, 1/40 je Tempo, 98 %, 48/192 3.30 s, Rutsche 9/9);
Treppen-Probe (Review `stairs2`/`stairs16`, perfekter Bot, v0 320/450/600 bzw. 450/700): 48/192 @600
3.85 → 3.88 s, 48/256 @450/600 3.21/2.95 → 3.30/3.02 s, 16/128 @450 4.73 → **4.30 s**, 16/64 @700 3.65 → 3.77 s,
16/192 @700 5.02 → 5.18 s; verschluckte Sprünge 1 → 0 je Treppe. Keine Liste von levels:check ändert sich.

**Treppe 32/192 (Korrektur Review 28.09.):** der Rückschritt ist systematisch und kommt vom Gedächtnis, nicht
vom Rhythmus des Bots. Nur Gedächtnis ergibt exakt die Zeiten von "an", nur Lip-Step exakt die von "aus"
(v0 320/450/600): 32/192 7.70/7.52/7.71 → 8.27/8.27/8.27 s, 32/128 7.52/7.71/7.71 → 8.47/8.66/8.66,
32/160 +0.2 s, 32/224 7.90/7.89/8.09 → 8.08/8.27/8.47, 40/192 6.19/6.20/6.20 → 6.38/6.20/6.39. Spur: der Hop
prallt an die übernächste Setzstufe, das Gedächtnis gibt 476 u/s noch im Steigen zurück, der Scheitel reicht
nicht über die nächste Stufe, zweiter Anprall im Fallen, Landung mit 42 u/s. Längere Vorausschau beim Vault
hilft nicht (16 Ticks: gleich; 48 Ticks: 48/192 3.30 → 8.17 s). **Level-Regel:** Treppen mit Setzstufe 32–40 u
nur mit Auftritt ≥ Hop-Weite beim Zieltempo, sonst Stufen ≤ 18 u (laufbar); 24er und 48er Setzstufen gewinnen
mit dem Assist. Für level-tools vorgeschlagen: Probe "Treppen auf der Route: perfekter Bot mit Assist nicht
langsamer als ohne".

### A7 Rutschen (`slideMinSpeed` 280 + `slide*`)

| Messung | aus | an |
|---|---|---|
| Sprint 320 + C: Tempo nach 0.1 s · Dauer bis < 160 u/s | 320 · 0.28 s | **351 · 1.34 s** |
| dto. Auge auf duckEye nach · Schritt-Events beim Rutschen | 0.156 s · – | **0.063 s · 0** |
| Landung 800 + Ducken, Sprung nach 0.1 / 0.2 / 0.4 s | 650 / 379 / 134 | 788 / **756** / 698 |
| Duck-Tunnel 60 × 768 u, Anflug 900: Zeit · Ausgang | 8.59 s · 85 | **1.13 s · 548** |
| Hang 25° / 15°, 1024 u ab 320 geduckt: Tempo am Fuß | Duck-Walk | **517** / 344 |
| Schub-Farmer (nur W, 0.26 s laufen → C → springen), Ø letzte 6 s | 320 | **339** (≤ 352) |
| Slide-Hop ohne Schub (rutschen bis < 300, springen), Ø | 295 | **300** (≤ 305) |
| Bhop mit gehaltenem Ducken, perfekt / 3°: Tempo nach 10 s · Rutsch-Ticks | 993.696 / 670.633 | **993.696 / 670.633 · 0** |
| Über eine 24-u-Kante ohne Sprung (Kante bei 229 u/s): Tempo 0.3 s nach der Landung | Duck-Walk | **195** (vorher 85, s. u.) |

Im Gnade-Fenster keine Rutsch-Reibung (Tempo nach 8 Ticks exakt das Landetempo, Vitest). Lenken nur bis
90° neben der Fahrt (Blick nach hinten dreht nicht um; im Prototyp drehte er) — sonst wie der Prototyp.

**Weiterrutschen über Kanten** (Befund im echten Spiel, L1-Start): wie im Prototyp endete die Rutsche mit
dem Boden. Über die Mulde hinter dem L1-Startfeld (Füße 0.2 s in der Luft) kam sie mit 270 u/s an — unter
`slideMinSpeed`, also kein neuer Eintritt, und der Duck-Walk bremste 270 → 85 u/s in 0.2 s. Jetzt geht eine
Rutsche, die den Boden **ohne Sprung** verlassen hat, im ersten Bodentick weiter (Hull geduckt, Tempo ≥
`slideExitSpeed`, kein Schub). `slideOverDrop` (Kante 24 oder 64 u, Anlauf 230 u): vorher 229 → 85, jetzt
229 → 195 u/s; im Spiel rutscht man vom L1-Start 1.37 s statt 0.55 s. Nach einem Sprung (auch Coyote) nicht:
Crouch-Jump auf ein schmales Ziel soll bremsen (251 → 85). levels:check zeilengleich (Bots rutschen nie).

**Rückmeldung ohne Rutschen (Review 28.09.).** (a) Die Rutsche begann schon im ersten Bodentick der
Lande-Gnade; jeder 1–8 Ticks späte Crouch-Hop meldete slideStart + slideEnd (Kratz-Whoosh, Bett-Kratzen,
Hand-Pose), obwohl er als `clean` gelobt wurde. Jetzt rutscht die Physik wie bisher ab dem ersten Bodentick
(intern `slideOn`: keine Schritte, Lenken, Hangabtrieb — bitgleich, `npm run sim` zeilengleich), gemeldet
(`sliding`, slideStart) wird erst mit dem ersten Reibungs-Tick; slideEnd nur für gemeldete Rutschen. Landung
700 + C, Sprung k Ticks später: k = 1 / 4 / 8 → 0 Events (vorher 2), k = 12 → slideStart + slideEnd. Der
slideStart kommt damit 62 ms nach dem Lande-Thud. (b) Weiterrutschen über eine Mulde: slideEnd in der Luft,
slideStart bei der Landung → Sfx spielte den Einstiegs-Whoosh zweimal (L1-Start: zwei in 0.72 s). Sfx
erkennt das Weiterrutschen (slideStart ohne Schub ≤ 1 s nach slideEnd, dazwischen kein Sprung, kein
Aufstehen, kein Respawn) und spielt keinen Whoosh; das Bett-Kratzen läuft über `MusicDrive.sliding`
(Offline-Differenz: Weiterrutschen −300 dB, frische Rutsche/nach Sprung/nach Aufstehen/nach 1.2 s ≈ −31 dB).
Vertrag unverändert.

### A8 Luftlenkung mit W (`airControl` 1.6 → 0.8 rad/s, Surf-Pause 0.5 s)

| Messung | aus | an |
|---|---|---|
| 320 u/s, Blick 90° daneben, nur W, 0.3 s: Drehung · Tempo | 7.1° · 322.5 | **33.6° · 322.5** |
| 320 u/s, Blick 45° daneben (reine Drehung) | 0.0° · 320.00 | 27.2° · **320.00** |
| 900 u/s, Blick 90° | – | 14.8° · 900.3 |
| W+D / Surf-Flanke 2 s mit W / 0.4 s nach steilem Kontakt | – | bitgleich / bitgleich / 0.00° |
| StrafeBots 0/2/3/5° 10 s | – | bitgleich |

Das Plus von 2.5 u/s bei 90° ist Sources W-Schub quer im ersten Tick (auch ohne Lenkung); die Lenkung
selbst hält den Betrag exakt (45°-Zeile). Die Abnahme "30–35° **und** ±1 u/s" gilt deshalb nur getrennt:
30–35° mit Blick 90°, ±0 u/s mit Blick ≤ 83°.

### Level-Stand mit der finalen Physik (M11, Übergabe an l1l2)

`levels:check` auf den unveränderten L1/L2-JSONs: **2 F / 1 W** (vorher 0 F / 2 W) — genau die in Plan 007
§1 vorhergesagten chaotischen Proben. Liste mit Zahlen: Plan 007, Abschnitt "Ergebnis" (M11), Fallen dazu in fallen.md #117.

Nach der Review-Runde (28.09., mit dem erweiterten Validator von level-tools): **2 F / 3 W**. Neu gegenüber
der Physik-Liste sind nur Validator-Proben: "Crouch-Kante 64.0 u Reserve 0.5 u < 2 u" (Kanten-Assist +
Auto-Hop-Landehöhe → Kante auf 66 u) und "Perfekter Bot zerfällt über den Start-Kasten" (auch mit allen
Arcade-Schaltern aus, dort mit anderem Split). Die Review-Fixes selbst ändern keine Meldung; L1 zeilengleich,
L2-Bot-Mediane durch die Hang-Schuld: sync 1.0 17.0 → 17.5 s, sync 0.7 18.7 → 19.5 s, Hand 3° 20.6 → 20.6 s.
