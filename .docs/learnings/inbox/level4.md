# Inbox: Strang level4 (Plan 007, Phase 2)

Phase 3 führt diese Punkte in `fallen.md` zusammen. Alle Punkte sind beim Bau von L4 "04 TURM" wirklich aufgetreten
und gemessen (finale Phase-1-Physik). Zahlen und Varianten stehen in `.docs/research/levels/level4.md`.

## Wendel + Hang-Landung: Dreiecke mit 14° und 8° im Wechsel fressen das Tempo

`Helix` zerlegt jedes Segment in zwei Dreiecke, weil die vier Ecken nicht koplanar sind. Die Dreiecke haben
die Steigung der Innen- bzw. Außenkante: 14,3° bei r 640 und 8,1° bei r 1152, auf der Planlinie im Wechsel.
Seit der deterministischen Hang-Landung (Plan 007 A4) wird eine Bergauf-Landung auf dem steilen Dreieck ab
~650 u/s zum Rampslide, und das Tempo ist weg.

- Der perfekte Bot braucht dadurch 28.78 statt 26.89 s (25 Start-Jitter).
- Die Skill-Spreizung Hand 3° / sync 1.0 fällt auf 1.14.

**Richtig:** die Fläche zusätzlich radial teilen (Ringe bei r 864/1008). Jede Linie liegt dann auf fast
gleich steilen Stücken. Kosten: 1.5 × Brushes. Allgemein: Nach einer Änderung der Landephysik Flächen, die
aus Dreiecken zusammengesetzt sind, auf Steigungs-Sprünge entlang der Fahrlinie prüfen.

## Crouch-Kante + Auto-Hop = Phasen-Lotterie; was ein Hindernis kostet, misst man per Entschärfung

Hält man die Leertaste, springt man dort ab, wo man landet. Das Fenster für den Crouch-Sprung von der
Terrasse ist bei 900 u/s ~260 u breit (190–450 u vor der Wand), der Hop davor bergauf ~420 u lang. Egal wie
lang die Terrasse ist: Ein Teil der Phasen prallt ab.

- Crouch-Probe: 9–13 Anpraller pro 20 Läufe.
- Perfekter Bot: an K2 in 49/49 Starts (932 → ~110 u/s).
- Längere Terrassen (30–40°) verschieben nur die Phase (45–49/49).

Die Frage "wie viel kostet der Anprall" beantwortet man nicht durch Rechnen, sondern mit einer entschärften
Variante: K2 40 u hoch (ohne Ducken machbar) → Median 25.01 statt 26.82 s. Das ist auch das Maß, um das die
Medaillen für einen Menschen mit gutem Timing lascher sind.
**Richtig:** Bei jeder Kanten-Prüfung neben "kommt hoch" auch die Anpraller zählen und die Kosten als
Differenz zu einer entschärften Variante berichten. Die Level-Regel "≥ 95 % oben in 4 s" sagt nichts über
den Tempoverlust.

## Gerade Zinnen neben einem Sprungbrett stoppen jeden seitlich versetzten Läufer

Die Zinnen links und rechts des Bretts (Prototyp) standen quer zur Laufrichtung. Wer neben dem Brett anlief,
stand an der Zinne. Probe `funnel` auf dem Prototyp-JSON mit der finalen Physik: 8/8 Anläufe bleiben stehen.
**Richtig:** Schrägwände als Trichter von der Bande zum Brettrand (120 u lang), so gleitet man aufs Brett:
0/8 stehen, mit einer 8-u-Schräge (≈ Zinne) 5/8. Die Schräge endet genau am Brettrand, wo die Bande des Keils
beginnt, damit keine Bandenstirn frei in der Fahrlinie liegt.

## Bot-Vergleich von Linien ist verzerrt, wenn eine Linie Gräben hat

Der RouteFollower springt nicht absichtlich in Gräben, die tiefer als `PREDICT_MAX_DROP` (64) sind. Vor jedem
Graben läuft er deshalb zur Kante und springt dort (Stop-and-Go). Auf der L4-Innenbahn war er so bis zu
1,6 s langsamer. Das ist ein Bot-Artefakt, keine Aussage über Menschen.
**Richtig:** Linien mit derselben einfachen Technik vergleichen (W + Leertaste, Blick tangential, gleiche
Start-Tempi und Phasen), zusätzlich eine Variante ohne das Hindernis (hier: ohne Gräben). Erst so zeigt sich:
Die Innenbahn lohnt sich nur bis ~450 u/s. Kürzer heißt bei gleicher Höhe steiler.

## `resumeIndex` liefert den Knoten NACH dem Spawn, und der liegt nicht immer im Trigger

Ein Test "der Wiedereinstieg liegt im Checkpoint-Trigger" schlug an CP4 fehl: Der nächste Knoten ist der
Absprung auf dem Brett, 22 u unter der Krone. An CP5 (Surf-Checkpoint) ist es der Surf-Knoten 320 u tief auf
der Flanke. **Richtig:** Die Etage über den ERSTEN Knoten im Trigger prüfen (`nodeInTrigger`) und für den
Wiedereinstieg nur die Reihenfolge und die Höhe relativ zum Spawn an Podesten.

## Deko unter begehbaren Flächen: Hüllbox gegen die Fläche prüfen, nicht die Punkte

Die Lichtleisten unter der Wendel folgen der schrägen Unterkante. Ein Stück, das nur an den Ecken 1 u
Abstand hält, schneidet an steilen Stücken mit seiner Hüllbox die Fläche. Der Validator prüft Deko per
Hüllbox gegen sichtbare Kollision. Gegenprobe mit 1 u für alle Stücke: 9 Warnzeilen "Deko … schneidet
Kollisionsgeometrie". **Richtig:** Jedes Stück so tief hängen, bis `testBox` mit seiner Hüllbox frei
ist (1-u-Schritte). An 14°-Stücken sind das ~20 u, auf Podesten 1 u.

## Messen ohne `measure`: Tode in der Abfahrt sind Platzhalter-Artefakte

`buildLevel4({ measure: false })` setzt Surf-minSpeed und Launch-Band als Platzhalter. Mit einem solchen Build
zeigte ein E2-Vergleich "Hand 3° 50 Tode". Alle Tode lagen in der Abfahrt, weil der Bot dort mit falschen
Knoten-Tempi surfte. **Richtig:** Ungemessene Builds nur für Abschnitte vor der Surf-Kette auswerten oder
Tode ausdrücklich vor CP4 zählen. Der Build mit Messung kostet nur 0,5 s.

## Verwundene Hüllen-Dreiecke an steilen Stellen bekommen an jeder Fuge einen Trim

Eine Wendel-Grube (Sohle 26–33° steil, verwunden) zerfällt in Dreiecke mit spürbar verschiedenen Normalen. Der
Trim-Builder zieht an jeder Fuge, hinter der die Nachbarfläche nicht in derselben Ebene weitergeht, ein
Leuchtband. Das ergab ein rotes Zickzack quer durch jede Grube (Prototyp und erster Build; im Shot sichtbar,
nicht in den Messungen). Auf der flachen Bahn (≤ 11 u Anstieg je 4°-Segment) passiert das nicht. **Richtig:**
Flächen, die nur Sohle bzw. Füllung sind, mit `trim: false` bauen. Die Kante davor trägt die Lesbarkeit. Und:
Jeden neuen Abschnitt einmal im Spiel ansehen, denn Proben und Validator sehen keine Trims.
