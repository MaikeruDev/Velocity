# Inbox: Animator Dose / Sturmfeuerzeug / Handy (Plan 008 Schritt 2, 01.10.)

Zum Zusammenführen in fallen.md (paralleler Strang, AGENTS.md §4).

## A. Würfe aus der Dosen-/Feuerzeug-/Handy-Faust: "Bild-oben" zeigt IN die Handfläche

Die Faust liegt im Bild über dem Gegenstand; VIEW_AXES.up hat im Handgelenk-Raum +0.39 entlang z (Handflächen-Normale ist
−z). Gerade nach oben geworfen flog die Dose durch Handfläche und Finger (−2.4, Messung `hand-contact`-Stil je Frame).
Dazu schlug ein langer Körper, der um die Bild-Tiefenachse dreht, mit den Enden kurz nach dem Abwurf durch die Hand.
**Richtig:** Flugrichtung = Bild-oben ohne z-Anteil + `away`·(−z) (PropFlight.setAway, 0.5–0.85; Spin um die
Längsachse mit offenem Deckel 1.5), Drehachse = Handflächen-Normale (Überschlag nach vorn), Finger öffnen VOR dem Abwurf
(sonst steckt der Zeigefinger vorn in der abfliegenden Dose), Ring/kleiner Finger am Handy erst öffnen, wenn es weg ist,
und erst nach dem Fang schließen (`quadIn`), Daumen eigens wegklappen. Der Flug wird im Raum des RUHENDEN Handgelenks
gerechnet und die Hand-Bewegung (hx/hy/hz, Handgelenk-jointAdd) pro Frame herausgerechnet; Abwurf/Fang = Griff bei
den Hand-Zuständen zu diesen Zeiten → kein Sprung. `envelope.ts` beachten: der Bogen nach links oben braucht
Hand-Drift nach rechts, sonst verlässt die Dose die Hülle (die Hülle wird aus Dose/Karte/Messer SELBST gemessen —
zirkulär: Dosen-Tricks dürfen nicht weiter als die alten 0.055 nach links).

## B. Gegenstand im Griff drehen = Durchdringung — Hand und Handgelenk drehen lassen

Handy-Foto/Gimbal drehten das Handy per rotateView im Griff (73°), Feuerzeug-Surf schob es per offsetView aus dem Griff,
Buzz rückte es in den Daumen. **Richtig:** die Hand bewegt den Gegenstand (hx/hy/hz, hroll, Handgelenk). Eine Drehung um
die Blickachse exakt in die Handgelenk-Gelenke zerlegen (three `Euler.setFromRotationMatrix(…, 'ZXY')`, e = [−Beugen,
Drehen, Seitneigen]) geht, sieht aber bei ±0.7 rad wie ein geknicktes Handgelenk aus (Band dreht mit) — für das Querdrehen
lieber Unterarm-Rollen (hroll 0.9) + etwas Handgelenk-Drehen (−0.5) und die Hand anheben.

## C. Feuerzeug-Deckel: Scharnier auf der falschen Seite schlug in den Zeigefinger

Offen (2.95 rad) steckte der Deckel 1.35 im Zeigefinger-Mittelglied; auch 1.7 rad noch −0.44. Scharnier auf die Rad-Seite
(−x, wie beim echten Sturmfeuerzeug) → 0. Der Daumen schnippt jetzt die freie Ecke (+x).

## D. Crack per Zeigefinger: die Dose muss erst im Griff rutschen

IK (Spreizen/Grund/Mittel/End gegen das Griff-Modell): der Zeigefinger erreicht das Laschen-Ende nicht (1.5 Einheiten zu
kurz bei 45° Spreizung). Lasche zum Zeigefinger drehen (items/can LID_TURN) UND die Dose 2.5 entlang ihrer Achse nach
unten rutschen lassen (Nachgreifen) → 0.4 Fehler. Weiter als ~0.5 (37°) zieht der Finger die Lasche nicht — sie schnappt
dann allein auf (sieht echter aus).

## E. Allokations-Probe in Node: sie misst sonst den Test-Harness

`--trace-gc` mit Standard-Semispace zählt bei 16 B/Frame gar nichts. Empfindlich: `--max-semi-space-size=1`. Dann aber:
(1) eine lange Schleife im Skript-Top-Level läuft per OSR, der zweite Aufruf bis zur Neu-Optimierung im Baseline-Code —
viele kurze Aufrufe einer `step(n)`-Funktion; (2) mehrere Gegenstände in EINEM Prozess machen gemeinsame Methoden
polymorph (im Spiel ist immer nur einer aktiv); (3) parallel gestartete Prozesse kompilieren im Hintergrund zu spät —
`--no-concurrent-recompilation --no-concurrent-osr --single-threaded-gc`. Danach deterministisch.
Gefundene echte Boxer: Wackelfeder `PropTricks.spinKick` beim Dosen-Fang (HEAD: ~24 Scavenges/24 000 Frames — ersetzt
durch geschlossenes Nachdrehen `PropFlight.carry`), `cond ? kommazahl : 0` (→ Math.max), Schluck-Schleife mit `if`,
`TAU * ganzzahligesFeld * x / y` (→ Rate vorberechnet), und große Trick-Methoden, in denen Track.value/ramp2 das
Inlining-Budget sprengen (Rückgaben werden HeapNumbers → kleine void-Helfer, Zeit über Felder: TossRig, inFlight).

## F. Kontaktblätter mit vollem Zustand

`hand-audit trick` kann Feuerzeug-Zustände (Deckel offen, brennt) nicht vorbelegen. Eigenes Skript: ViewHand im Browser
(`await import('/src/ui/hand/ViewHand.ts')`), frei mit 240 Hz laufen lassen, Frames als nicht-live Zellen (joints,
propPos/Rot, param, frame-Felder) an `__vm.render`. Falle: im Vorlauf startet der Leerlauf (Dose: crack nach 1.2 s,
Feuerzeug: Wieder-Zünden nach Ruhe) — Zustand JEDEN Vorlauf-Frame setzen (auch `calmT`).
