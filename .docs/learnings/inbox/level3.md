# Inbox: Strang level3 (Plan 007, Phase 2)

Zusammenführen in `fallen.md` macht Phase 3. Alles gemessen gegen die finale Phase-1-Physik.

## W-Halter auf einem Auffang-Band: "Blick auf den nächsten Knoten" misst Stau, nicht das Level

Die Probe "Außenbahn fängt Nicht-Drücker" (L3) ließ W-Halter auf den nächsten Türkis-Knoten blicken (wie
novice.ts). Auf dem Band unter der Außenflanke liegt dieser Knoten oft direkt NEBEN einem an der Flanke (199 u
waagrecht, 382 u höher): W drückt senkrecht in die Flanke, der Halter kriecht mit 0.1–0.3 u/s und läuft in
das 40-s-Limit. Blickmodelle im Vergleich (24 Läufe ab CP1/CP2): nächster Knoten 23/24, 120 u voraus 23/24,
200 u 22/24, 320 u 24/24 — **jeder Fehlschlag Stau, nie Tod**. **Richtig:** den Blick auf einen Knoten ≥ 320 u
voraus richten (so schaut ein Spieler, der weiter will) und das Modell "nächster Knoten" nur auf Tod prüfen;
Stau-Zahl im Bericht nennen (#73 ist dieselbe Falle an der L2-Grube).

## Finale-Linie zu tief: der perfekte Bot bleibt nach CP3 stehen (Gate-Befund "Stall vor Knoten 70")

Mit Cap 40 blieb der Prototyp auf safeRoute mit sync 1.0 0/8 vor Knoten 70 (Finale) stehen. Ursache war die
Knotenlinie des Finale-Kickers 320 u unter dem Grat (wie in der Kehre): mit 200 u (Knoten ab 300 u, Launch
ebenso) kommen 49/49 Jitter-Starts ins Ziel; mit 320 heute noch 3/49 (Koralle) bzw. 4/49 (Türkis) ohne Ziel und
+0.8 s. Der Validator mit seinen 8 festen Seeds sah davon nichts (0 F) — **erst die 49 Start-Jitter zeigen,
ob eine Linie für den perfekten Bot trägt.** Nach jeder Linien-Änderung beide Linien über `jitterMedian`
auf "ohne Ziel" prüfen, nicht nur den Median.

## Die 8-Seed-Quote der 3°-Hand streut stärker als die Soll-Grenze

Gabel-Nutzen "Hand 3° route/safeRoute ≤ 0.90": Türkis über Seeds 1–8 23.98–28.17 s. Dieselbe Geometrie ergibt
0.896 (8 Seeds) und 0.859 (24 Seeds); benachbarte Parameter springen über 8 Seeds zwischen 0.896 und 0.925,
über 24 bleiben sie bei 0.847–0.867. **Richtig:** Design-Quoten über ≥ 24 Seeds messen und die 8 Validator-Seeds
nur mitnennen; Parameter auf dem 24-Seed-Plateau wählen.

## Außenbande als unsichtbarer Clip mit Leuchtbalken: Deko an der Fuge ist koplanar

Look-Pass "schlanker Leuchtbalken, Kollision gleich": Bande `visible: false`, Balken und Pfosten als Deko
ganz IN der Clip-Hülle. Der Validator prüft Deko nur gegen SICHTBARE Kollision und Z-Fighting nur zwischen
sichtbaren Flächen — beides passt zum Clip. Aber ein Pfosten genau auf der Gehrungsfuge teilt seine Stirn mit
der Stirn des Balkens (gleiche Ebene, gleiche Richtung): 7 Z-Fighting-Fehler. **Richtig:** Deko-Teile, die an
Fugen sitzen, einige u hinter die Fuge setzen (hier 4 u). Physik bitgleich belegt: alle Bot-Zeiten und Raster vor/nach identisch,
die 49 Jitter-Zeiten der Koralle einzeln, Median und Spanne der Türkis-Jitter (Kollisions-Reihenfolge unverändert).

## Mondfarbe lässt sich aus Level-Daten nicht setzen

`environment.sunColor` #d6fff5 färbt das Licht, die Scheibe am Himmel aber rechnet `sky.ts` fest "warm": oben
(1.05 r + 0.05, 1.02 g + 0.06, **0.55 b**), unten Pink aus Horizont + trimColorAlt. Jede Sonnen-/Mondscheibe
wird gelb; Blau über 0.55 ist unerreichbar. Ein Mond braucht eine Option im Renderer (Integration/Look).

## Messende Level-Builder sprengen das Vitest-Limit

`tests/levels.test.ts` ruft in "die Registry kennt level1–level4 …" jeden Phase-2-Builder auf. `buildLevel3()`
misst wie L2 (zwei Durchgänge `measureSurfSpeeds` mit SURF_GRID auf zwei Linien) und braucht ~13.5 s — der Test
scheitert am 5-s-Standardlimit. Ein Durchgang allein kostet schon 5.6 s (Türkis 4.1 s: viele Rasterläufe
hüpfen langsam über das Band bis ans 30-s-Limit). **Richtig:** Tests, die Builder aufrufen, bekommen ein
eigenes Timeout (oder prüfen nur Registry-ids); Level-Tests lesen die gebaute JSON (tests/level3.test.ts
< 1 s).

## Echtzeit-Messungen im Browser: VSync macht jeden Frame 16.7 ms

Frame-Zeit "L3 ≤ L2 + 10 %" über rAF-Abstände ist mit VSync bedeutungslos (beide 60 fps). Mit Chromium-Flags
`--disable-frame-rate-limit --disable-gpu-vsync` ist der rAF-Abstand die echte Frame-Zeit (L2 0.85 ms, L3 0.76
ms), dazu die JS-Zeit im rAF-Callback per `addInitScript` (Callbacks einwickeln). Level außerhalb des Index
per `page.route('**/levels/index.json')` ergänzen — index.json bleibt unberührt.

## Scratch-Skripte außerhalb des Repos: kein bloßes `import 'three'`

tsx löst Paketnamen vom Ort der Datei auf; ein Skript im Scratchpad findet `three` nicht. Entweder nur
Repo-Module importieren (die bringen three selbst mit) oder `.../Velocity/node_modules/three/build/three.module.js`
relativ importieren.
