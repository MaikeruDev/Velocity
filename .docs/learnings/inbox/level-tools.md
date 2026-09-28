# Inbox: Strang level-tools (Plan 007, Phase 1)

Zusammenführen in `fallen.md` macht Phase 3. Alle Befunde sind in der Umsetzung wirklich aufgetreten und
gemessen (Phase-0-Physik in einer eingefrorenen Kopie).

## Der "perfekte" Bot ist auf L1 zweigeteilt — und dann trägt KEINE Kennzahl

Gold/VELOCITY/Autor kamen aus EINEM deterministischen sync-1.0-Lauf (22.24 s auf L1). Über den Start-Kasten
(±16 u quer × ±1° Blick bis zum ersten Absprung) zerfällt L1 in zwei Zweige: Phase-0-Physik 7 × 7 = 33/49
bei 21.9–23.9 s, 16/49 bei 25.9–30.7 s. Ursache (Trace, Blick 0.1°): der vorige Hop landet bei z −5411 statt
direkt auf der Kante, der Bot springt 16 u vor der Crouch-Wand ab und prallt (548 → 86 u/s), landet oben mit
92 u/s und verliert im Neustart CP2 → CP3 ≈ 2.5 s. L2 und der L4-Prototyp fahren EINEN Zweig.

Erster Befund war falsch: "Einzellauf = Glückstreffer, Median über 25 Starts ist robust". Das Review maß
nach: der Median wandert mit der Rasterdichte (5 × 5/7 × 7/9 × 9/11 × 11: 23.16/23.02/22.61/22.88 s), das
25-%-Quantil liegt stabil bei 22.24 — genau beim Einzellauf. Mit der Movement-Physik in Arbeit kippt es
dann: nur noch 12/49 im schnellen Zweig, Median stabil 25.2 s im LANGSAMEN, das 25-%-Quantil springt
22.00 ↔ 24.51. **Richtig:** auf einem zweigeteilten Level ist jede Kennzahl eine Frage der Stichprobe —
den Zerfall erkennen und melden (`physics.jitterBranches`: Lücke ≥ 4 % des Medians, je Seite ≥ 10 % der
Starts; build.ts warnt laut, levels:check warnt mit dem Abschnitt des größten Verlusts) und das Level
reparieren. Die Ecken eines Kastens sind außerdem keine faire Stichprobe (L1, Phase-0-Physik: alle vier im
langsamen Zweig, Median 26.72 s; Repo-Physik: zwei zu zwei, 22.27 s);
gleichmäßig abtasten (7 × 7 = 49 Zellmitten, 0.4 s je Level).

## `resumeIndex` ohne Höhe: in gestapelten Leveln startet der Bot eine Etage tiefer

`physics.resumeIndex` suchte den ersten Route-Knoten im Checkpoint-Trigger nur in x/z. In einer Wendel
liegt unter jedem Podest die vorige Umdrehung — nach CP3 (L4-Prototyp) setzte der Bot auf Knoten 12 an
(y 310 statt 1088) und fuhr die E1-Knoten ab: CP3→CP4 6/8 Modelle, Spiel-Uhr und timedRun-Respawns
falsch. Der Prototyp half sich mit `dropShadowNodes` (Knoten löschen). **Richtig:** Höhe mitprüfen
(`nodeInTrigger`: y in [min − 8, max]); jetzt 8/8 ohne Workaround. Achtung beim Regressionstest: eine
Attrappe, deren Weg hinter dem Checkpoint in x/z genau über der unteren Etage weiterläuft, kommt auch mit
dem falschen Wiedereinstieg ins Ziel (nur 3× langsamer). Den Rückfall fängt erst die statische Regel
"Schatten-Knoten" (Wiedereinstieg ≠ Durchgang am Spawn) auf der sauberen Attrappe.

## Probe "fällt von der Wendel": nur Landungen zu zählen übersieht den Fall, der noch läuft

`helixBoard` (aus dem L4-Prototyp) zählte "> 150 u tiefer" nur bei Bodenkontakt. Mit 2 s Probedauer war
ein Hüpfer, der durch eine Bandenlücke flog, am Ende noch in der Luft (570 u unter der Bahn) — kein Tod
(killY noch nicht erreicht), keine Landung: der Selbsttest "Bande-Lücke" rutschte durch. **Richtig:** am
Ende auch die Höhe im Flug werten ("fällt noch"); jede neue Probe erst gegen einen eingebauten Fehler
laufen lassen, bevor man ihrem Grün traut.

## `simulate`-Ziele sind Hull-Überlappung — eine dünne Schicht "auf Kantenhöhe" trifft man von unten

Für "Crouch-Kante ohne Ducken erreichbar" lag nahe, `simulate` mit einer dünnen Ziel-Box auf Kantenhöhe
zu rufen. Die Box wird aber gegen die ganze Hull (Füße bis Kopf, 72 u) geprüft: wer vor einer 64-u-Kante
steht, überlappt sie schon im ersten Tick. **Richtig:** Füße selbst prüfen (am Boden, y ≥ Kante − 1,
jenseits der Wand) — eigene Tick-Schleife statt `simulate`-Ziel.

## Messen während ein anderer Strang die Physik umbaut: eingefrorene Kopie

Phase 1 läuft parallel: der Movement-Strang ändert `src/player/**` im selben Arbeitsbaum (nach 15 min
schon PlayerMovement/MovementConfig). "levels:check L1/L2 zeilengleich" und "Prototyp byte-gleich" sind
nur gegen dieselbe Physik aussagekräftig (vgl. #30 für Level-JSONs). **Richtig:** zu Beginn `src/`,
`tools/`, `tests/`, `public/` per robocopy in den Scratchpad kopieren, `node_modules` als Junction
(`mklink /J`), eigene Werkzeug-Dateien per Sync-Skript hineinkopieren und alle Vorher/Nachher-Messungen
dort fahren. Byte-Vergleiche gegen Prototyp-Ausgaben brauchen außerdem dieselbe Engine-Variante (L3 mit
`PMFIX=retrace`-Hook, L4 ohne).

## SpeedCurve-Cache: ein unvollständiger Schlüssel teilt Kurven zwischen Configs

Der Schlüssel bestand aus 8 Feldern — ohne `airSpeedCapLow`/`FadeFrom`/`FadeTo`, `sprintSpeed`,
`strafeAssist`. Zwei Configs in einem Prozess (Cap 32 und 40) bekamen dieselbe Kurve. **Richtig:**
stabiler Schlüssel über alle Felder (`configKey`, sortiert, rekursiv, Zahlen per `String` — JSON macht aus
Infinity "null"); neue MovementConfig-Felder zählen automatisch mit. Im Test beide Werte ausdrücklich
setzen: der Default wandert in Plan 007 von 32 auf 40, "Default vs. 40" wäre dann derselbe Schlüssel.

## Build-Filter und Validator-Filter gehören zusammen

`levels:build -- level3` schreibt (Plan 007) nur `level3.json`, nie `index.json`. `levels:check` las aber
nur Level aus dem Index — `levels:check -- level3` hätte in Phase 2 nichts geprüft. **Richtig:** ein
ausdrücklich angefragtes Level wird auch ohne Index-Eintrag geprüft (mit Hinweiszeile). Ebenso braucht
build.ts einen `main`-Guard, sonst baut jeder Import (Tests, medalProbe) alle Level neu nach `public/`.

## Crouch-Regel "≥ 64 u" lag auf der Kante: die Auto-Hop-Landehöhe fehlte

"Sprung 57 + Kanten-Assist 5 + 2 Reserve = 64" vergaß, dass der Boden-Trace (2 u) einen schon 1.75 u über
dem Boden als gelandet zählt und der Auto-Hop von dort springt: Scheitel 58.74 u, mit ledgeStep 5 ≈ 63.8 u.
Eine 64-u-Kante hat 0.2–0.5 u Reserve (Brute-Force des Reviews: 63.75 u in 57/19 470 Läufen oben, 63.9 u in
0). Die Level-Probe traf eine Kante 0.5 u unter der Reichweite nur 3× von 153 — auch mit 8-u- statt
24-u-Raster nicht öfter (schmales Phasenfenster: 320 u/s, 376 u vor der Wand). **Richtig:** die Reichweite
als Eigenschaft der Config messen (`noDuckReach`: Attrappe Boden + Wand, Bisektion), Reserve < 2 u warnen,
neue Kanten ≥ 66 u; Selbsttest-Fälle relativ zur gemessenen Reichweite (−0.5 u / +1 u) statt fester
Höhen, sonst prüfen sie nach dem nächsten Tuning etwas anderes.

## CLI-Filter: "0 Level, grün" ist ein Fehler

`levels:check -- level3` meldete für einen Stub ohne JSON, einen Tippfehler oder fehlende Lektionen
"✓ 0 Level, 0 Fehler" mit Exit 0 — genau der Befehl, auf den sich die Phase-2-Stränge verlassen.
`levels:build -- level1 bogus` schrieb level1.json und warf erst danach. **Richtig:** jedes Argument muss
etwas treffen (`selectLevels`, sonst ✗ und Exit 1), einzeln gebaute Lektionen auch unter
`training/<id>.json` suchen; im Build alle ids auflösen und alle Level messen, BEVOR geschrieben wird.

## Tick-Zeiten taugen nicht als Test-Signal für kleine Störungen

Der Test "1° Blickfehler ändert den Lauf" schlug fehl: der Fehler wirkt nur bis zum ersten Absprung (wenige
Ticks), die Spiel-Uhr ist auf 1/128 s quantisiert — beide Läufe 8.0078125 s. **Richtig:** die Mechanik als
Einheit testen (`StartAim` mit Boden-/Luft-Folge) und die Richtung gegen die echte Bewegung
(`jitterStart` = wohin Taste D schiebt; Kill-Zone rechts neben dem Spawn → Tod nur mit +16 u).

## Eigene Geometrie-Logik neben compileLevel driftet ab

`killTiles` rechnete Grundrisse selbst: Prismen fielen weg, Hüllen wurden nicht gedreht, `pivot` ignoriert
— eine Kill-Kachel konnte über einem Prisma-Boden liegen. **Richtig:** `compileBrush(def).bounds` nehmen
(dieselben Punkte wie im Spiel). Ebenso `finaleReserve`: die Lücke aus den echten Ecken der Plattform
statt aus der AABB (bei schräger Flugrichtung liegt eine AABB-Ecke näher als die Kante) und schräg
stehende Zielkanten als Fehler melden statt still eine falsche Reserve zu rechnen.
