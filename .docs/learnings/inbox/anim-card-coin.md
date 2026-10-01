# Inbox: Animator Karte / Münze / Messer-Feinschliff (Plan 008 Schritt 2, 01.10.)

Zum Zusammenführen in fallen.md (paralleler Strang, AGENTS.md §4).

## A. "Keine Durchdringung" reicht nicht — Schweben misst niemand

Der Karten-Twirl bestand alle Tests (kein Glied tiefer als −0.3 in der Karte) und schwebte trotzdem 0.1–0.6 über der
Daumenkuppe — im Seitenblatt deutlich als Spalt sichtbar, aus der Spielkamera nicht. Der Kontaktabstand schwankte mit
dem Drehwinkel, weil die Drehachse (Kartenmitte) nicht durch die Stütze ging. **Richtig:** die Stütze auf die
Drehachse legen und die Lage per FK aus genau den Gelenken dieses Frames rechnen (Pose + Finger-Versatz → Kuppen-Mitte,
Unterkante = Kuppen-Mitte + Kapselradius + 0.05 entlang Karten-y). Dann ist der Abstand konstant 0.05, egal wie die Karte
dreht und wie der Daumen wippt. Fürs Schaukeln (fan) um die Kuppen-MITTE drehen, nicht um den Berührpunkt: so rollt die
Kante über die Kugel statt in sie hinein. Prüf-Skript: je Frame kleinster Abstand JE Handteil ausgeben (nicht nur das
Minimum) — dann sieht man "thumb2 0.05" konstant oder eben "0.1 … 0.6" pendeln.

## B. Reichweite der Cartoon-Hand vor dem Trick-Design prüfen (Suche gegen die GANZE Kette)

"Twirl zwischen Daumen und Mittelfinger" (Achse durch beide Kuppen) geht mit diesem Rig nicht: der Mittelfinger erreicht
weder Ober- noch Diagonalecke der 88-mm-Karte (Reichweite ab Knöchel ~9.6, nötig ~12). Eine Kuppe hinter der Kartenecke
fand die Suche nur, wenn sie allein die Kuppe bewertete — mit Grund-/Mittelglied gegen die Karte geprüft stieß der
Zeigefinger immer hinein. **Richtig:** Gitter-Suche über die vier Gelenke mit Kosten aus ALLEN drei Gliedern gegen die
Kartenpunkte (Lage zum Anschnipp-Zeitpunkt). Ergebnis: Zeigefinger schnellt mit dem Mittelglied an die linke untere
Ecke (Kontakt 0.11), Drehachse durch die Daumenkuppe.

## C. French Drop: der direkte Weg "nach hinten in die Finger" ist durch den Zeigefinger versperrt

Aus der Daumen-Klemme fällt die Münze nicht gerade in die Finger: der Zeigefinger liegt direkt hinter ihr (jede Bahn mit
Anteil −Kamera: −0.5 … −1.4 sofort). Tabelle "Abstand über den Bahnanteil je Richtung" zeigte: nur nach links unten frei.
Bahn daher zweiteilig (links unten am Zeigefinger vorbei, dann hinter ihn auf die Kuppen von Mittel-/Ringfinger,
Kontakt 0.09), Bahn-Anteil quadratisch in der Zeit (Schwerkraft), DANN erst Dither (verdeckt) und DANN Faust-Pose — wird
die Pose geschlossen, solange die Münze noch sichtbar ist (visible > 0.01), zählt der Test die Finger in der Münze.

## D. event-probe: der Takt springt zwischen Regimen — Abklingzeiten nicht "linear" stimmen

L1 sync (ein deterministischer Bot) sprang bei Karten-Abklingzeiten 1.1/1.05/… zwischen "18 Tricks, 41.7 % frei,
19.5/min" und "23 Tricks, 48.7 % frei, 24.4/min, Surf 79.5 %"; kürzere Tricks machten es teils SCHLECHTER (mehr Starts
passen hinein). Mehrere Kombinationen probieren, die nächstgelegene im Band nehmen (hier HEAD-Abklingzeiten + Fächer 1.0:
45.5 % / 22.7/min, Hinweis-Grenze 45). Messer L1 1.5°-Hand: 31.4/min (vorher 33.8) — im Band.

## E. Parallel-Agenten mit `process.env` im Browser-Code legen alle Viewer-Werkzeuge lahm

Ein Strang tunte Konstanten per `Number(process.env.X ?? …)` in `ui/hand/*Tricks.ts` — im Node-Test geht das, im
Dev-Viewer bricht jedes Modul (`process is not defined`), damit hand-audit, vm-hash, shoot. Ausweichen ohne fremde
Dateien anzufassen: eigene Kopie von `tools/hand-audit.mjs` im Scratchpad mit
`page.addInitScript(() => { window.process = { env: {} }; })` vor `page.goto`. Für eigene Strang-Arbeit: Tuning-Werte
nie über process.env in Browser-Code, sondern im Scratch-Skript.
