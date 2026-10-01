# Learnings — Fallen, die uns Zeit gekostet haben

Jeder Punkt hier ist beim Bau von VELOCITY real aufgetreten, nicht abgeschrieben.

---

## 1. rolldown ohne Native-Binding (Windows)

`npm install` lässt die optionale Dependency `@rolldown/binding-win32-x64-msvc`
aus (npm/cli#4828). Vitest/Vite brechen dann mit *"Cannot find native binding"* ab.

**Richtig:** Binding in `optionalDependencies` pinnen (Version = installiertes
`rolldown`), dann greift npm sie auf Windows zuverlässig und ignoriert sie anderswo.

## 2. `npx tsx -e` mit JSON-Imports hängt

Inline-Eval mit `import … with { type: 'json' }` blieb unter Git-Bash ohne
Ausgabe hängen. **Richtig:** kleines Skript unter `tools/` und `npx tsx tools/x.ts`,
JSON per `readFileSync` + `JSON.parse` laden.

## 3. Render: "Banding" war gar keine Quantisierung

Breite Farbbänder über Himmel und Void sahen nach 5-Bit-Banding aus. Ursache
waren die additiven Scanlines der Start-Lichtsäule — die Kamera stand *in* der
Trigger-Box und schaute durch deren Wände. **Richtig:** Verdacht erst mit
`dev/render.html?...&bits=8&dither=0` gegenprüfen; bleibt das Muster, ist es
Geometrie. Trigger-Wände blenden jetzt aus, wenn die Kamera in der Zone steht.

## 4. Render: Mindestbreite dünner Bänder senkrecht zur Kante messen

Neon-Trims werden im Vertex-Shader auf ≥ 1 Low-Res-Pixel aufgeweitet. Entlang
der Extrusionsrichtung aufzuweiten reicht nicht: bei schräg laufenden Kanten ist
das Band senkrecht zur Kante dann nur Bruchteile eines Pixels breit → Sägezahn
mit Lücken. **Richtig:** Bildschirmrichtung der Kante (Attribut `aOther`) nehmen
und den *senkrechten* Anteil auf die Mindestbreite bringen.

## 5. Render: Vertex-Snapping verschiebt xy, aber nicht die Tiefe

Snapping bewegt Dreiecke um Bruchteile eines Pixels. Bei flachem Blick/in der
Ferne sind das mehrere Units Tiefenfehler — Deko auf Flächen (Trims) verliert
den Tiefentest trotz 0,35 u Abstand. `polygonOffset` mit Steigungsfaktor hilft,
zog aber mit `DoubleSide` die abgewandten Seitenbänder VOR die Oberseite.
**Richtig:** Bänder einseitig mit korrekter Wicklung, gemeinsamer Kantenvertex
für Ober-/Seitenband (getrennte Offsets → 1-px-Lücke), dann Faktor −1.5/Units −24.

## 6. Render: Nearest ohne Mipmaps → Pixelrauschen in der Ferne

Ohne Mipmaps (look.md) flirren entfernte Böden als Rauschen. Blende zur
Texturmittelfarbe ab ~1,5 Texel/Pixel hilft — aber mit `max(|dFdx|,|dFdy|)`
verschwindet das Muster schon auf der nächsten Plattform (flacher Blick ist
anisotrop). **Richtig:** geometrisches Mittel beider Achsen.

## 7. UI: Pixel-Webfonts nur im Pixelraster, Pixelify ohne Ligaturen

Menütexte sahen "kaputt" aus: *Empfindlichkeit* → "EmpAndlichkeit", *Effekte* →
"EFFekte", *CS2* → "OS2". Zwei Ursachen: (a) Pixelify Sans hat `fi`/`ff`/`fl`-
Ligaturen, die im Pixelstil wie andere Buchstaben aussehen; (b) Pixel-Fonts bei
krummen Größen (11–14 px) verschwimmen, Silkscreen ist nur bei Vielfachen von
8 px scharf. Außerdem ist Pixelify Sans' Versal-C fast geschlossen (liest sich als
O), E ist rund (€-artig), ß sieht aus wie B — für deutsche Substantive heikel.
**Richtig:** `font-variant-ligatures: none`; Silkscreen (nur Versalien) für alles
Kurze in 16/24/32 px mit `text-transform: uppercase` (macht ß korrekt zu SS);
Pixelify nur für Fließtext, Kürzel darin in Silkscreen (`.vel-mono`).

## 8. UI: lil-gui mit `container: document.body` verliert die Auto-Platzierung

Mit explizitem Container setzt lil-gui die Klasse `lil-auto-place` (fixed, oben
rechts, z-index) nicht. Das Panel lag statisch im Body und wurde von absolut
positionierten Canvases überdeckt — Titel und Beschriftungen unsichtbar.
**Richtig:** Für ein schwebendes Panel keinen Container übergeben.

## 9. Input: Esc im Pointer Lock ist kein keydown und keine User-Geste

Chrome verbraucht Esc im Lock selbst (Lock weg, kein keydown — im Playwright-Test
gesehen). Laut HTML-Spec zählt Esc nie als User-Aktivierung, ein "Weiter per Esc"
kann den Lock also nicht neu anfordern (Chrome sperrt Re-Lock direkt nach
Esc-Unlock zusätzlich kurz — nicht selbst gemessen). **Richtig:** Lock-Verlust,
den wir nicht selbst ausgelöst haben, als 'pause'-Aktion behandeln (InputManager
macht das); Fortsetzen nur per Klick/Enter (Enter → Lock im Test ok). Außerdem:
der Filter "Tastatur gehört dem fokussierten Slider" muss Esc durchlassen, sonst
hängt man im Einstellungsmenü fest (im Test gefunden).

## 10. Input: Chrome drosselt requestPointerLock

Nach ein paar Pause/Weiter-Runden lehnte Chrome jeden Lock ab: *"NotAllowedError:
Too many pointer lock requests in a short window of time."* Treiber war unser
eigener Fallback (erst `unadjustedMovement`, bei NotSupportedError ohne) — zwei
Anfragen pro Wiedereinstieg, plus parallele Aufrufe aus Klick und Enter.
**Richtig:** Raw-Unterstützung nach dem ersten NotSupportedError merken (danach
nur noch eine Anfrage), gleichzeitige `requestLock()`-Aufrufe auf ein Promise
zusammenlegen, Fehlergrund über `InputManager.lockError` sichtbar machen.

## 11. Audio: Rückkopplungsschleifen machen Chromium-Renders nichtdeterministisch

Zwei identische OfflineAudioContext-Renders unterschieden sich um bis zu 0,06
(≈ 14 000 LSB) — nur in den Delay-Echos der Stabs. Chromium bricht einen Zyklus
(Ping-Pong: DelayL → DelayR → DelayL) an einer Stelle auf, die von der
Traversierungsreihenfolge abhängt; dort kommt ein Render-Quantum (128 Frames)
Versatz dazu. Welche Stelle, wechselt von Lauf zu Lauf. **Richtig:** Feedback
ausrollen — Kette aus N DelayNodes mit Abgriffen und Gain < 1 je Stufe
(`Mixer.buildPingPong`). Deterministisch und die Echos liegen exakt im Takt.

## 12. Audio: Bitgleiche Offline-Renders gibt es in Chromium nicht

Auch ohne Zyklen bleiben Abweichungen ~1e-7 (nach Kompressor ~1e-4): Chromium
summiert mehrere Verbindungen an einem Eingang in Hash-Set-Reihenfolge, und
Float-Addition ist nicht assoziativ. **Richtig:** Determinismus mit Toleranz
prüfen (audiocheck: ≤ 16 LSB), nicht per Hash. Außerdem offline keine
`disconnect()`-Aufräumerei im `ended`-Handler: das Event kommt über den
Main-Thread zu einem zufälligen Render-Zeitpunkt und kappt Filter-Ausklänge
mal früher, mal später (`releaseWhenEnded` überspringt Offline-Kontexte).

## 13. Audio: `linearRampToValueAtTime` nach `setTargetAtTime` ersetzt dieses

Laut Spec übernimmt eine Rampe, die auf ein noch nicht begonnenes SetTarget
folgt, dessen Startpunkt — das SetTarget verschwindet faktisch (Riser stieg
linear statt spät anzuziehen). **Richtig:** komplexe Hüllkurven als
`setValueCurveAtTime` vorberechnen (Clap, Riser, Tape-Stop) oder nur
SetTarget-Ketten bzw. nur Rampen verwenden.

## 14. Kollision: `testBox` genau auf Bodenhöhe meldet "im Solid"

Eine Hull, deren Unterkante exakt auf einer Oberseite liegt (Spawn `y = 0` auf
Plattform-Top 0), gilt für `BrushWorld.testBox`/`traceBox` als `startSolid`:
`clipBoxToBrush` braucht für "draußen" `d1 > 0`, bei Kontakt ist `d1 = 0`.
Schon `+0.001` ist frei (gemessen mit sandbox.json). Spawn-Punkte im Levelformat
sind Fußpositionen genau auf der Fläche. **Richtig:** Spawn/Respawn vor dem
ersten Tick anheben (≥ `DIST_EPSILON`, z. B. +1 u und per Trace absetzen);
Prüfungen immer mit angehobener Hull (der Level-Validator testet `pos + 1 u`).

## 15. Kollision: Die achsparallele Hull ruht am Hang auf ihrer Bergkante

Auf einer Rampe liegt nicht die Hull-Mitte auf der Fläche, sondern die bergseitige
Unterkante (16 u zur Seite). Füße einer ruhenden Hull liegen also `16·tanθ` über
der Fläche in der Mitte — auf 8° 2,2 u, auf 10°-Ring 2,8 u, an einer 60°-Surf-Flanke
entsprechend 16 u seitlich versetzt. Route-Knoten "auf der Fläche" steckten im
Solid. Bei fallender Surf-Achse zusätzlich: an der Hull-Hinterkante (s − 16) ist
der First höher. **Richtig:** Höhe als Maximum der Fläche unter den vier
Hull-Ecken nehmen (`Ring.restY`, `SurfRamp.riderPos`).

## 16. Level: Wer eine fallende Surf-Rampe verlässt, fliegt nicht waagerecht

Der Validator rechnete Surf-Ausgänge zuerst mit vy = 0 → bei 1100 u/s "überflog"
man angeblich Landeflächen, die man real trifft: am Ende einer 14–25° fallenden
Achse hat man schon −270 … −460 u/s nach unten. **Richtig:** vy aus der Flanke
unter dem Knoten ableiten (Steigung in Flugrichtung = −(n·d)/n.y) und das erste
Bahnsegment kurz halten — eine 8-Segment-Sehne liegt unter der Parabel und
schneidet sonst die eigene (steigende) Rampe.

## 17. Movement: Dieselbe Clip-Ebene zweimal → Stillstand auf Surf-Rampen

Auf einer 57°-Surf-Flanke blieb der Spieler nach ~1 s mitten in der Luft
stehen (vel = 0, auch die 400 u/s entlang der Rampe). Ursache: Rundung lässt die
Box knapp *unter* `DIST_EPSILON` vor der schrägen Ebene stehen; der nächste Trace
liefert fraction 0 mit derselben Normalen. `TryPlayerMove` sammelt dann zwei
identische Clip-Ebenen → Knick-Kante = Kreuzprodukt 0 → Geschwindigkeit 0 → hängt
für immer. Source-2013-Code hat dafür keinen Schutz (der Trace dort ist anders).
**Richtig:** Quake-3-Fix aus `PM_SlideMove` übernehmen: trifft ein Trace eine
Ebene, die schon in der Liste ist (dot > 0.99), Geschwindigkeit um die Normale
herausschieben und nächsten Bump — keine doppelte Ebene. Tritt nur an
nicht-achsparallelen Flächen auf, daher fällt es auf flachen Testleveln nicht auf.
(Spawn-Falle aus Punkt 14: `PlayerMovement.teleport` schiebt selbst frei.)

## 18. Bot: "Optimaler Strafe-Winkel" hält nicht auf der Surf-Rampe

Der Formel-Winkel (wishdir ⊥ Geschwindigkeit, maximaler Gewinn) drückt nur mit
`add = cap` = 17 u/s pro Tick in die Rampe — beim Aufprall mit −600 u/s rutschte
der Bot trotz richtiger Taste von der Flanke. Surfer halten die Taste *rein* in
die Rampe (wishdir = −n_h): dann ist `add = cap + v·n_h` und AirAccelerate drückt
mit bis zu airAccel·wishspeed·dt (100 u/s mit Sprint). Aber: bei entlang der
Achse fallenden Rampen hat −n_h einen Anteil *gegen* die Fahrtrichtung → der Bot
bremste sich bis auf den Grat aus. **Richtig:** Druckrichtung = −n_h ohne Anteil
entlang der Flugrichtung, und nur unterhalb der Linie zwischen den Knoten drücken,
sonst Gewinn-Strafe. Außerdem Knoten nur als "passiert" zählen, wenn die Füße
nicht weit darunter sind — sonst sammelt ein abstürzender Bot Knoten im freien Fall
und der Fortschritt im Report lügt.
Nachtrag (Review): "nur unter der Linie drücken" reicht nicht — wer mit −650 u/s
auf die Flanke fällt, rutscht bei Gewinn-Strafe (17 u/s pro Tick) unten raus.
Der Bot regelt jetzt die Falllinien-Speed gegen den Höhenfehler zur Knotenlinie
(RouteFollower.surf) und drückt schon im Anflug in die Rampe.

## 19. Shell: Patch-Skripte nicht inline in Git-Bash

`node -e "…"` mit Template-Literals (Backticks) und Heredocs mit `$`/Backticks
wurden von Git-Bash zerlegt: halbe Ersetzungen, verschluckte Kommentarwörter,
einmal "unexpected EOF". **Richtig:** Patch-Skript mit dem Write-Tool als Datei
in den Scratchpad legen und `node datei.mjs` ausführen; jede Ersetzung mit
"nicht gefunden → throw" absichern.

## 20. Input: Keyboard Lock lässt den Pointer Lock bei Esc stehen

Im Vollbild mit `navigator.keyboard.lock([... 'Escape' ...])` liefert Chrome einen
kurzen Esc-Druck als normalen keydown an die Seite und gibt den Pointer Lock
**nicht** frei (erst 2 s Halten verlässt Vollbild + Lock). Gemessen mit echtem
Tastendruck in headless Chromium: `keydown Escape, isTrusted, pointerLockElement
gesetzt`. Ohne eigene Freigabe hängt die Maus unsichtbar hinter dem Pause-Menü
und dreht die Kamera. **Richtig:** im keydown-Handler bei Esc im Lock selbst
`exitLock()` rufen (unterdrückt die zweite Pause aus dem Lock-Verlust).
Headless Chromium kann Vollbild + Keyboard Lock — das ist testbar
(`node tools/shoot-ui.mjs --check`).

## 21. Test-Harness darf die Arbeit der API nicht heimlich übernehmen

Der Esc-Check war grün, obwohl der InputManager den Lock nicht freigab: die
UI-Preview rief bei 'pause' selbst `exitLock()`. **Richtig:** Harness so dünn wie
die spätere Integration halten und jeden neuen Check einmal gegen den
ausgebauten Fix laufen lassen — er muss rot werden.

## 22. HUD: Absolute Beschleunigungs-Schwellen sind bei Tempo unerreichbar

Speedometer-Grün ab 30 u/s² war ab ~620 u/s physikalisch unmöglich: ein Luft-Tick
bringt höchstens `sqrt(v² + cap²) − v`, also ~`tickRate·cap²/(2v)` u/s²
(bei 1000 u/s nur 18). Grün kam nur noch aus der Hysterese. Die Preview-Fake-Daten
(60 → 22 u/s pro Hop) haben das verdeckt. **Richtig:** Schwelle relativ zu diesem
Maximum (`ui/hudLogic.ts`), geprüft mit echtem PlayerMovement + StrafeBot bei
60/144 fps (`tests/loop-hud.test.ts`). Allgemein: HUD-Logik nie nur mit
erfundenen Kurven kalibrieren.

## 23. Canvas: Konturtext nicht per globalAlpha in Einzel-Blits ausblenden

Kontur als 8 versetzte Blits + Füllung darüber: mit globalAlpha < 1 summiert sich
die Kontur im Glypheninneren fast deckend auf — verblassender Text wird zum
dunklen Fleck statt transparent. **Richtig:** Glyphe je Stil einmal fertig
komponieren (Kontur, Schatten, Füllung in einem Bild), zum Ausblenden die Zeile
deckend in einen Scratch-Canvas und diesen einmal mit Alpha kopieren.
Zweite Falle dabei: ein neuer Canvas pro Glyphen-Zelle kostet 50–100 µs
(Erzeugung + putImageData), nicht das Compositing — vorhersehbare Paletten
(Speedometer-Farben) daher beim resize() vorbacken statt mitten im Lauf.

## 24. Render: Dünne Bänder nie nach innen auf die eigene Fläche aufweiten

Die Neon-Trims wurden im Vertex-Shader auf ≥ 1 px aufgeweitet, indem die
Innen-Vertices am Bildschirm weiter auf die Plattform geschoben wurden. Ein
verschobener Vertex behält aber seine Tiefe: an der Hinterkante (Fläche zeigt
zur Kamera hin) liegt die Plattform dort 20–90 u näher, das Band verliert den
Tiefentest. Im Anlauf auf hop2 zeigte nur die Hälfte der Frames eine Linie,
sie flackerte alle paar Frames (Review-Befund, per Sweep bestätigt: 129/251).
Zweite Falle dahinter: Kanten- und Innenvertex eines 0,1-px-Bandes einzeln zu
snappen reißt sie bis 0,5 px auseinander, ohne die Tiefe anzupassen, und das
Band liegt dann schief zur Fläche. **Richtig:** Kanten-Vertices nach AUSSEN über
die Silhouette schieben (dahinter ist nur Hintergrund oder die Nachbarfläche
derselben Kante). Das ganze Band starr um den Snap-Versatz des zugehörigen
Brush-Vertex verschieben. Senkrecht zur UNgesnappten Kantenrichtung messen:
Die gesnappte ist an Teilkanten-Stößen für beide Segmente verschieden und
lässt den Stoß aufreißen. Die Drehung durch Snapping deckt eine Reserve in der
Mindestbreite ab (1.25 px). Prüfen mit `node tools/shoot-render.mjs --trim-sweep`.

## 25. Render: 1-Texel-Diagonalen sind bei 4 u/Texel keine Linien

Chevrons (2 Texel dicke 45°-Linien) und die Surf-Lichtlinie (1 Texel) zerfielen
nah vor der Kamera zu Sägezähnen bzw. Rautenketten. Das sah nach affinem
Mapping aus, ist aber reine Nearest-Vergrößerung (mit affine=0 identisch):
Texel einer 1-Texel-Diagonale berühren sich nur an Ecken. **Richtig:** Symbole
als gefüllte Flächen (dann tragen feine Stufen die Diagonale) oder Linien
mindestens 2 Texel breit, damit Nachbartexel über Kanten verbunden sind.

## 26. Kamera: Stufen auf interpolierten Frame-Deltas erkennen — zwei Fallen

Eine Stufe passiert in einem Physik-Tick, die Render-Interpolation verteilt sie
aber auf zwei Frames (60 Hz bei 128 Tick: rund jede zweite Stufe). Eine
Schwelle "Sprung größer als Rampe + Ducken erklären" sieht dann zwei halbe
Stufen und glättet gar nichts (gemessen: 8 u Ruck pro Frame auf 8er-Stufen).
**Richtig:** exakt klassifizieren: Füße-Δy (Auge minus eyeHeight, damit Ducken
nicht zählt) minus den Anteil, den die Bodennormale erklärt (−(n.x·dx+n.z·dz)/n.y),
ist Stufe; nur zwischen zwei Frames, die ganz zwischen Boden-Ticks liegen
(vel.y im Snapshot exakt 0), sonst zählt der Rest einer Landung als Stufe.
Zweite Falle dahinter: die geteilte Stufe zählt als zwei Stufen mit ~0 u
Lauflänge → Treppen-Steigung explodiert → Abbaurate 1600 u/s → wieder Rucke.
Aufeinanderfolgende Stufen-Frames sind ein Ereignis. Prüfen mit
`npx tsx tools/sim/cameraPlot.ts` (Plot) und `tests/camera.test.ts`.

## 27. Movement: Sprint 320 hebt auf Rampen ab — NON_JUMP_VELOCITY gilt für 250 u/s

StepMove übernimmt die vel.y aus dem Rampen-Clip (v·sinθ·cosθ). In Source ist
das mit max. 250 u/s höchstens 125 < 140, man bleibt immer am Boden. Mit Sprint
320 sind es ab ~32° über 140: Laufen die Rampe hoch wurde zu Hoppeln (Luft-Ticks,
Landungen, keine Schritte, Sprint langsamer als Gehen). **Richtig:** nach einem
Boden-Tick die Abhebe-Schwelle mit der höchsten Bodengeschwindigkeit skalieren
(140·320/250 ≈ 179); bei Landungen aus der Luft bleibt 140 (Ramp-Slide wie Source).
Allgemein: jede Source-Konstante, die an 250 u/s hängt, prüfen, wenn Sprint dazukommt.

## 28. Movement: 128 Tick + Cap-Schub kriecht steile Flanken hoch

CS:GO (64 Tick, airaccelerate 12) hält den Schub in die Rampe über
m_surfaceFriction 0.25 unter g·dt·tanθ — man rutscht ab. Bei 128 Tick ist g·dt
halb so groß und mit airaccelerate 40 ist der Schub cap-begrenzt (17 u/s pro
Tick, 0.25 ändert daran nichts): mit W an einer 46–70°-Flanke kroch man mit
~10 u/s hoch. Am Boden schob der Source-Clip die Hull die Flanke hoch, bis die
2-u-Bodensonde nichts mehr fand — der Sprung am Rampenfuß wurde verschluckt.
**Richtig:** am Boden steile Flächen wie Wände clippen (horizontale Normale),
TryTouchGroundInQuadrants, und in der Luft ohne Längsfahrt (< 100 u/s entlang
der Rampenachse) darf Luftschub die Falllinien-Speed nicht erhöhen. Nicht den
Schub pauschal bei vel.y ≥ 0 kappen — das nimmt Surfern das Hochsteuern.

## 29. Bot: Fehlermodell relativ zum Gewinnfenster verfälscht Cap-Vergleiche

Die sync-Bots skalierten Winkelfehler mit dem Gewinnfenster cap/|v|. Kleinerer
Cap → proportional kleinerer Fehler → der Sweep zeigte, unsaubere Spieler
verlören mit Cap 17 kaum etwas. Mit absolutem Winkelfehler (die Hand kennt den
Cap nicht) bekommt ein Spieler mit 2° Fehler bei Hop 10 in VELOCITY 444 u/s,
in CS2 mit 64 Tick 591. **Richtig:** Presets und Caps nur mit absoluten Modellen
vergleichen (`aimNoiseDeg`, `turnRateDeg`, `npm run sim` Abschnitt
"Menschenmodell"); das relative Modell nur, um einen HUD-Sync nachzustellen.

## 30. Parallelbau: Level-JSONs ändern sich während der Messung

Beim Bot-Tuning lieferte derselbe Code in Minutenabstand andere Ergebnisse,
weil der Level-Strang `public/levels/*.json` neu baute (Knotenzahl, Tempo-
Vorgaben). **Richtig:** für A/B-Vergleiche Level-Dateien vorher kopieren und
nur gegen die Kopie messen; Regressionstests für Bot-Verhalten auf eigenen,
synthetischen Leveln (z. B. der nachgebaute Surf-Einstieg in movement.test.ts).

## 31. Kollision: Ohne Kanten-Bevels hat jede Hüllenfuge einen Phantom-Keil

`BrushWorld` ergänzt nur achsparallele Bevels. Box gegen konvexe Hülle wird
nur über die Flächenebenen getestet; die Separating Axes aus Kante × Box-Kante
fehlen. An einer Fuge zweier Surf-Stücke (Stoß an Stoß, gleiches Endprofil)
liegt die hintere Hull-Ecke noch "unter" der rückwärts verlängerten
Flankenebene des Folgestücks — sobald die Vorderkante dessen Stirnkappe
passiert, meldet der Trace einen Treffer mit Normale entlang der Achse:
Tempo 0 in einem Tick, man hängt in der Luft (Rampbug). Passiert an
**konvexen** Knicken (Folgestück steiler, Keil bis 32·(tanB − tanA) ≈ 9 u)
genauso wie an konkaven. **Richtig (Level):** Folgestück 64 u vor dem Ende
des Vorgängers beginnen lassen, konkav entlang der eigenen Neigung, konvex
zusätzlich 32·(tanB − tanA) + 12 u tiefer (`lib.surfChain`); Übergänge
zwischen Rampen als "Drop" auf gleicher Achse (`lib.surfDrop`). **Richtig
(Engine, offen):** Kanten-Bevels wie im Quake/Source-BSP-Compiler.
Gefunden nur mit Physik-Probe (Nahtstopp = Speed halbiert sich in der Luft in
einem Tick) — Ballistik und Hull-Traces entlang der Parabel sehen es nicht.

## 32. Bot: RouteFollower-Eigenheiten, um die Level herumgebaut werden

- Landevorhersage akzeptiert bis 64 u unter Start/Ziel (`PREDICT_MAX_DROP`):
  eine Grube genau 64 u tiefer gilt als "sichere Landung" — der Bot hüpft
  hinein statt vorzulaufen. Grube 70 u tief (Crouch-Jump 75 kommt noch raus).
- Dieselbe Grenze lässt ihn auf Terrassen bremsen, wenn ein Hop zwei Stufen
  tiefer (> 64 u) landen würde: Terrassenlänge = ein Hop beim Plan-Tempo.
- Knoten zählen nicht, wenn er mehr als 128 u darunter vorbeifährt
  (`REACH_BELOW`); nach Drops surft er tief → Surf-Knoten tief legen (320 u),
  sonst dreht er zum verpassten Knoten um und fliegt seitlich weg.
- Bei niedrigem Tempo hüpft er auf der Plattform, statt zur Kante zu sprinten
  (kein Stop-and-Go) → erste Lücke nach jedem Checkpoint klein halten.
- Von Boden auf eine Surf-Flanke hüpft er nie sofort (Vorhersage kennt nur
  Boden-Landungen): auf E1 läuft er zum Absprungknoten und verliert ~25 %.
Level-Checks mit dem Bot sind trotzdem wertvoll — aber ein Bot-Fehler ist
erst dann ein Level-Fehler, wenn der Grundtechnik-Surfer / Mensch ihn auch hat.

## 33. Shell: Heredoc-Patchskripte verlieren Backslashes in Regex

`cat > patch.mjs <<'EOF'` mit einer Regex `/\\s+/` in einem Template-Literal
landete in der TS-Datei als `/s+/` (Git-Bash + Template-Escape): der Surf-
Abschnitt-Schlüssel war danach immer leer, drei Surf-Abschnitte fehlten still
im Raster. **Richtig:** wie #19 — Patchskripte mit dem Write-Tool schreiben,
oder die Stelle mit dem Edit-Tool ändern; bei Regex im Patch das Ergebnis per
grep gegenprüfen.

## 34. Audio: WaveShaper hält außerhalb ±1 den Endwert — "tanh" wird zum harten Clipper

Die Kick lief mit Drive bis 2.1 in eine tanh-Kurve über [−1, 1]. Alles jenseits
±1 bekommt beim WaveShaper den Endwert der Kurve: pro Kick ~44 ms flach
abgeschnitten (Knick von Steigung 0.26 auf 0), die "Sättigung" war ein Clipper.
Beim Acid kamen resonante Spitzen bis 6 an. **Richtig:** Kurve mit Reserve
bauen (`tanhCurve(drive, n, range)`, Eingang vorher ÷ range) und den höchsten
Eingang messen (Gain-Knoten vor dem Shaper an die Destination hängen).

## 35. Audio: AudioContext ohne sampleRate läuft mit Geräte-Rate (hier 96 kHz)

Dieser Rechner liefert 96 kHz. Damit kostete die Engine im Overdrive 66 %
statt 24 % Echtzeit (Convolver-Länge, Biquad-Koeffizienten pro Sample), und
der synchrone Aufbau mit drei generierten Impulsantworten dauerte 130 ms
(CPU ×4: 620 ms). Weil der Takt-Anker VOR dem Aufbau gesetzt war, verwarf der
Sequencer danach Schritt 0: die erste Kick fehlte, und das Pad setzte erst
nach 4 Takten ein. **Richtig:** `new AudioContext({ sampleRate: 48000 })`
(Chromium resampelt), Anker erst nach dem Aufbau setzen, IRs im Leerlauf
vorab und blockweise berechnen (7× schneller), Taktanfänge am ersten
*geplanten* Schritt erkennen statt an `step % 16 === 0`.

## 36. Audio: Die Beat-Uhr aus currentTime zittert, und der Limiter verzögert 6 ms

`ctx.currentTime` springt pro Frame in Audio-Blöcken. Gemessen: ±6 ms
Abweichung von der Geraden, RMS 3 ms. Der Neon-Puls flimmerte leicht. Chromiums
DynamicsCompressor hat 6 ms Pre-Delay, gemessen 264/288/576 Frames bei
44.1/48/96 kHz, nicht fix 256 Frames. **Richtig:** `getOutputTimestamp()` plus
Extrapolation mit `performance.now()` (0.3 ms RMS), Limiter-Latenz 0.006 s.

## 37. Audio: Headless Chromium startet AudioContext auch ohne Geste

Selbst mit `--autoplay-policy=user-gesture-required` war der Kontext sofort
`running`. Der Fehler "unlock() ohne Geste hängt in resume(), der zweite
Aufruf aus der Geste weckt nichts" ließ sich so nicht nachstellen. **Richtig:**
Chromes Verhalten per Unterklasse emulieren (resume-Promises warten, bis ein
Flag "Geste" gesetzt ist). Der Test muss gegen den alten Code rot werden.
Verwandt mit #21: Ein Clip-Check hinter dem Sicherheits-Clipper kann nie
fehlschlagen (Decke 0.985 < 0.99), deshalb misst audiocheck mit
`clipper: false`.

## 38. Input: `InputManager.locked` wird erst nach dem Lock-Promise wahr

`requestLock()` resolved mit `true`, sobald Chromes Promise erfüllt ist und
`document.pointerLockElement` stimmt. `locked` setzt aber erst der
`pointerlockchange`-Handler, und der kam im Playwright-Check danach. Direkt nach
dem Fortsetzen stand im Zustand `playing`, `locked: false`. Drei Checks
(Klick ins Bild, "Weiter", Enter) wurden dadurch sporadisch rot, obwohl das
Spiel korrekt lief. **Richtig:** Lock-Erfolg aus dem Promise-Ergebnis ableiten
(Game macht das). `locked` ist nur Zustand, Tests warten darauf
(`waitFor(x => x.locked)`), statt ihn im selben Moment zu lesen.

## 39. Render: Hoher Trigger heißt nicht Luft-Trigger

Die Lichtsäulen der Trigger begannen an `bounds.min.y`. Bei den Surf-Checkpoints
in Level 2 (1520 u hoch, Unterkante tief unter den Rampen) stand die Säule
unsichtbar im Void. Man sah beim Surfen nur ein paar senkrechte Striche unter
der Rampe (Playtest-Screenshot). Das naheliegende Kriterium "höher als 640 u
= Luft-Tor" war falsch: Das Ziel von Level 2 ist 900 u hoch und steht auf der
Zielplattform, CP 2 ist 708 u hoch auf der Landeinsel. **Richtig
(`triggerVisuals.columnBand`):** Luft-Tor nur, wenn der Trigger hoch ist UND
kein kollidierender Brush mit Oberkante nahe `min.y` in xz darunter liegt.
Dann wird die ganze Höhe gezeichnet (gleichmäßiger Schleier, Ring oben). Die
Rampe verdeckt per Tiefentest den Teil unter ihrer Fläche. Übrig bleibt ein
Vorhang genau dort, wo man durchsurft.

## 40. Integration: Die Preview-Harnesses enthalten stille Integrationslogik

Die UI-Preview blendete das HUD unter Titel, Einstellungen und Ergebnis selbst
aus (`setView`). Im echten Spiel schien der HUD-Timer durch das 86-%-Overlay
des Ergebnis-Screens, genau über der Überschrift. Zweiter Fall: Die Level-Namen
tragen ihre Nummer ("01 GRUNDKURS"), das Menü nummeriert selbst noch einmal.
Im Titel stand "01 01 GRUNDKURS". Beides fiel erst im ersten Screenshot
des echten Spiels auf, keine Modul-Preview konnte es zeigen. **Richtig:**
Vor der Integration die Dev-Harnesses jedes Strangs auf Logik lesen, die "nur
für die Vorschau" aussieht, und die ersten Screenshots des echten Spiels
Screen für Screen ansehen (vgl. #21: Harness und Integration gleich dünn halten).

## 41. Kollision: Mit Kanten-Bevels meldet jede Kante eine Bevel-Normale — und jeder Grat trägt

Seit `compileLevel` Kanten-Bevels erzeugt (#31 behoben), liefert ein Trace, der
eine konvexe Kante streift, die Normale der Bevel-Ebene. An der Stirnkante der
10°-Insel E1 ist das etwa (0, 0.6, −0.8): "surf-steil". Der RouteFollower hielt
sie im Vorbeifallen für eine Surf-Flanke voraus, drückte "in die Rampe" — in
Wahrheit nach hinten — und bremste sich mit 78 u/s pro Tick auf ~30 u/s herunter
(Level 2, sync 0.8, Absturz an S1). Zweite Folge: Der Grat einer Surf-Rampe mit
< 45° Achsgefälle ist jetzt begehbar (Bevel entlang des Firsts, n.y = cos α), wie
in Source. Der Bot drückte bei langen Falls (Respawn-Pad, Drop) über 1 s lang in
die Rampe, landete auf dem First, hatte Bodenkontakt, hüpfte ab und flog über den
Kicker hinweg (Level 2, S4). **Richtig:** "Flanke voraus" nur, wenn ihre
Horizontal-Normale nicht in Flugrichtung zeigt (dot < 0.5), und im Anflug nur
drücken, wenn der vorhergesagte Aufprall unter der Knotenlinie liegt. Surf-Ketten
brauchen die Knick-Überlappungen aus #31 nicht mehr (Stoß an Stoß: 0 Nahtstopps
im Raster). Allgemein: Wer Kollisions-Normalen auswertet (Bots, Kamera, Audio),
bekommt nach einer Bevel-Änderung an Kanten neue Normalen, die keine Fläche sind.

## 42. Level: "Gemessen statt geschätzt" hängt am Messinstrument — prüfen, wer die Grenze setzt

Level 2 leitet die Lücke hinter dem Launch aus dem langsamsten gemessenen
Abflug ab (Surfer, 3°-Hand, Surf-Raster). Die Lücke sprang zwischen zwei Builds
von 728 auf 456 u, ohne dass sich die Geometrie davor geändert hatte: erst ein
Bot-Fix (schnellere bzw. langsamere Linie), dann ein zusätzlicher Raster-Punkt
(Einstieg 50 u unter dem Grat mit bremsendem Blick — der Fahrer drückt sich auf
den begehbaren First, #41, und verliert durch Bodenreibung Tempo). Ein
extremer, aber legitimer Fall bestimmte damit das ganze Finale. **Richtig:**
Bei jeder abgeleiteten Grenze einmal ausgeben, welcher Fahrer/Einstieg sie setzt
(Skript: Fahrer einzeln an `measureSurfSpeeds` übergeben), und bewusst
entscheiden, ob er zählen soll. Einstiege aus dem Stand deckt der Respawn-Lauf
ab — das Raster prüft das Einstiegs-Band (400–1400 u/s), nicht 320.


## 43. Level: Design-Probe mit einem Absprungpunkt sieht den Auto-Hop-Folgesprung nicht

Beide "kein Todesstreifen"-Proben waren grün, im Spiel starb man trotzdem.
`finaleTiers` (L1) wertet die ERSTE Landung auf dem Absprungblock als Erfolg,
`exitTiers` (L2) startet nur am Knoten "Ausfahrt". Mit gehaltener Leertaste
(Auto-Hop ist Default) springt man aber sofort dort wieder ab, wo man landet:
auf dem Block 400–500 u vor der Kante, auf der Ausfahrt je nach Tempo 120 u
früher als der Knoten. Folge im E2E-Review: L1 aus T5 mit 425–600 u/s zu kurz
gegen die Stirnseite des Ziels, L2 aus T0 mit ~500–600 u/s gegen die 131 u hohe
Stirnwand von E1 (17 % von 330 Geradeaus-Läufen tot). **Richtig:** Proben ab
dem VORIGEN Knoten mit Auto-Hop bis zum Ziel/Surf weiterlaufen lassen und den
Absprungpunkt (Tempo × seitlicher Versatz) rastern. Stirnwände unter
Landekanten sind die typische Todesursache: vel.z → 0 in der Luft.

## 44. Tools: `__vel.events()` ist auf 512 Einträge gekappt

Ein Sweep mit vielen Läufen merkte sich `n0 = events().length` und prüfte
`events().slice(n0)` auf 'respawn'. Sobald das Log voll ist, bleibt die Länge
512, `slice(512)` ist immer leer: jeder Tod galt als Erfolg (Todesband
verschwand im Sweep, im Einzellauf war es da). **Richtig:** In langen Sweeps
Tod über den Zustand erkennen (Positionssprung > 200 u pro Tick,
`checkpoint.index`), oder vor jedem Lauf `start()` bzw. Log leeren.

## 45. Input: Subtick-Yaw nach Tick-Index statt Tick-Zeit kostet bei 144 Hz Strafe-Gewinn

`InputState.tickInput` verteilt die Mausdrehung eines Frames mit (i+1)/n über
dessen Ticks. Bei 144 Hz und 128 Tick hat jeder ~9. Frame keinen Tick, der
nächste Tick bekommt dann zwei Frames Drehung: Yaw-Schritt pro Tick schwankt
0.89×–1.78× (60 Hz: 0.71×–1.07×). Eine Hand mit konstanter Drehrate verliert
dadurch pro Luftabschnitt 6–14 % des Gewinns (60 Hz 1–3 %, 240 Hz 2–4 %);
Interpolation nach Tick-Zeit zwischen den letzten zwei Frame-Samples hält 100 %
(Experiment: FixedLoop + InputState + PlayerMovement in leerer Welt, Strafe mit
D und konstanter Drehrate, 4 Phasenlagen). Tests mit 60 Hz sehen das kaum.
**Richtig:** Bruchteil pro Tick aus der Zeit ableiten, u = ((i+1)·dt − Rest)/frameDt,
und den Blick in JEDEM Frame sampeln (auch ohne Tick).

## 46. Level: Über einer Lücke hat Auto-Hop immer ein Todesband — nur Boden darunter hilft

Mit gehaltener Leertaste springt man dort ab, wo man zuletzt gelandet ist, also
irgendwo in der letzten Sprungweite D0 = v·0.755 s vor der Kante. Tödlich ist
eine Phase, deren Flug die Kante verlässt und vor der Gegenseite unter deren
Oberkante ankommt. Das Band existiert, sobald Lücke − 32 > v·(t_Fall − t_flach)
(32 = Hull). Bei gleicher Höhe ist die rechte Seite 0: jede echte Lücke hat ein
Band. Eine tiefere Landefläche macht es nur schmaler: Level 1 mit 192 u Fall braucht
v > 820 u/s für 368 u Lücke. Auch 120 u statt 215 u Lücke (Kehre → Wende) hat die
Ausfälle nur verschoben. **Richtig:** An Übergängen, die jeder nehmen muss, eine
Auffangfläche unter die Lücke (Level 1: Rampe unter dem Schluss-Gap bis an die
Zielkante; Level 2: Vorfeld Ring → E1) oder keine Lücke. Prüfen mit dem
Auto-Hop-Raster (designProbes), nie mit einem einzigen Absprungpunkt (#43).

## 47. Level: Ein Respawn-Pad in der Surf-Kette ist ein Hindernis für hohe Linien

Das neue Pad auf dem Grat der Folgerampe (Drop-In ~100 u statt 600 u blind) stand
zuerst 32 u hinter dem Ende der vorigen Rampe, mit senkrechter Stirn. Wer dicht
am Grat fuhr, lag mit der Hull-Innenkante auf dem Flankenende von S2 und mit der
Front an der Pad-Stirn. Die 3°-Hand hing dort fest (Stall, Level 2 Seed 11). Auf
der Flanke von S2 liegt genau 74 u neben dem Grat die Höhe des Grats von S3,
deshalb trifft man die Pad-Höhe dort leicht. **Richtig:** Pad als Keil ohne
Südstirn, bündig ab dem Rampenende (kein Spalt), Unterseite auf Grathöhe. Wer
hoch fährt, rollt darüber, wer tiefer surft, fährt darunter durch. Allgemein:
Nach jedem neuen Brush in einer Fahrlinie die Bots über mehrere Seeds laufen
lassen, einer allein zeigt es nicht (#48).

## 48. Tests: Bot-Regressionstest trennt nur, wenn der Fehler unumkehrbar ist

Test für "verpasste Surf-Knoten überspringen": Ein Knoten 24 u unter dem First
auf derselben Rampe blieb auch ohne Fix grün. Der RouteFollower dreht um,
klettert und holt ihn nach. Rot wurde der Test erst, als der hohe Knoten 100 u
nach einem tiefen und kurz VOR einem Drop lag: Hinter dem Drop ist er
unerreichbar, der Bot bleibt stehen (so auch im echten Level 2). Genauso bei
Seeds: Level 1 sync 0.8 schaffte Seed 11 (Validator, Test), scheiterte aber an
Seed 7. **Richtig:** Den Test so bauen, dass der Fehler unumkehrbar ist (Drop,
Tod), jede Gegenprobe gegen den ausgebauten Fix fahren (#21), und Bot-Aussagen
über mehrere Seeds treffen (`FULL_RUN_SEEDS`, Quote statt Einzellauf).

## 49. Tools: Heap-Sampling ordnet Allokationen inlineter Funktionen dem Aufrufer zu

Beim Prüfen "HUD allokiert nichts mehr" (`node tools/alloc-probe.mjs`, CDP
HeapProfiler) standen die alten HUD-Allokationen (Style-Spreads, formatTime,
mixHex) fast nicht unter `Hud.ts`. TurboFan inlinet update/draw in den
rAF-Callback, die Samples landen bei `frame` (Loop.ts). Neue Einträge wie
`intText` waren dagegen nur Lazy-Caches, die sich beim ersten Auftreten eines
Werts füllen. **Richtig:** Vorher/Nachher über die Summe im Frame-Pfad
vergleichen (`frame` fiel von 1.3 auf 0.7 KiB/s), mit gleichem Seed und
Level. Einzelne Funktionsnamen nicht als Beleg nehmen, Cache-Füllungen von
Dauerlast unterscheiden (länger laufen lassen).

## 50. Bot: Relatives Fehlermodell + tempoabhängiger Cap = absolut schlampigere Hand

Mit Cap 32 bei niedrigem Tempo (Plan 003) fiel der RouteFollower mit sync 0.8 in 3/8 Seeds in die
erste Sandbox-Lücke: 314 → 32 u/s in 0.25 s nach dem Absprung. Die Physik war es nicht (für einen
festen absoluten Winkelfehler ε ist Δ|v|² = cap² − v²sin²ε bzw. bei Sättigung cap-unabhängig — ein
größerer Cap schadet nie). Das sync-Modell skaliert seine "Blick zu weit hinten"-Episoden mit dem
Gewinnfenster cap/|v|: größerer Cap → größerer absoluter Fehler (Variante von #29). **Richtig:**
Fehlerfenster mit dem Basis-Cap `airSpeedCap` rechnen, nicht mit `airSpeedCapAt(v)` — dann bleibt
die Hand gleich und nur die Physik belohnt sie anders. Allgemein: wer die Physik tempoabhängig macht,
prüft jedes Messinstrument, das sich aus denselben Größen skaliert.

## 51. Movement: Auto-Hop ohne Bodenkontakt — und die Bodenzeit, die nach dem Spawn "unendlich" ist

Source-Autobhop springt im Lande-Tick, und der Sprung kommt vor WalkMove: wer mit wenig Tempo
landet (Stand, Treppen-Bonk, Wand), bekommt nie Bodenbeschleunigung und kriecht mit dem Luft-Cap
(24 u/s) weiter, solange die Taste gehalten wird — der Default-Fall für Anfänger. Drei Fallen beim
Fix (Smart-Auto-Hop, `heldHopReady`): (a) `frictionTicks` steht nach dem Teleport auf NO_LANDING;
als Bodenzeit benutzt ist "≥ 0.2 s am Boden" sofort erfüllt und der erste Hop nach jedem Respawn
wieder einer im Stand → eigener Zähler `groundTicks` (Lande-Tick zählt mit, Teleport = 0).
(b) Eine Tempo-Schwelle 0.8 × Wunschtempo friert W-Hopper bei 203 u/s ein (unter Lauftempo).
(c) Die Schwelle garantiert nur Hop-Tempo ≥ Anteil × Wunschtempo: 0.95 ergab je nach
Beschleunigungs-Phase 238–244 u/s — nur ein Phasen-Raster zeigt das, ein Einzellauf nicht.
`land.jumpQueued` muss dieselbe Bedingung nutzen (mit groundTicks = 1 für den Folge-Tick).

## 52. Tools: `setInputOverride(fn)` — `i` ist der Tick-Index im Frame, nicht seit Start

`fn(state, i, n)` bekommt pro Frame i = 0 … n−1. `jumpPressed: i === 0` drückt die Sprungtaste
deshalb in JEDEM Frame frisch (Mausrad-Spam), nicht einmal am Anfang. Ein Browser-Check "Leertaste
gehalten" misst so einen anderen Input: frische Drücke springen immer sofort (so gewollt), der
Smart-Auto-Hop greift nie. **Richtig:** "einmal gedrückt, dann gehalten" mit eigenem Flag im
Closure/`globalThis` modellieren (Flag vor jedem Szenario zurücksetzen).

## 53. Movement: Tempoabhängiger Cap an der Surf-Flanke ändert Halten/Klettern

Cap 32 auch bei Surf-Kontakt ließ "Taste in die Rampe" langsam 33 % stärker drücken: Der Surfer
kletterte (vy +25 statt +11), nahm eine andere Linie und kam mit +5° Blickversatz 160 u vor dem
Launch zu langsam an (vorher 761 u/s Launch). Aggregat-Checks (Zitter-Hände 6/6) blieben grün,
nur das Blickversatz-Raster zeigte es. **Richtig:** Luft-Cap-Änderungen, die fürs Strafen gedacht
sind, nur in freier Luft (`steepBelow || surfing` → Basis-Cap); Surf-Kette danach bitgleich.
Allgemein: an Surf-Flanken ist der Cap kein Strafe-Hebel, sondern die Druckgrenze in die Rampe
(#18, #28).

## 54. Kamera/Audio: `land.jumpQueued` sagt nicht, ob der perfekte Hop kommt

`jumpQueued` ist false, wenn der Sprung im Folgetick frisch gedrückt wird (Taste oder Mausrad
genau nach der Landung, nichts gepuffert, nichts gehalten) — der Sprung ist trotzdem perfekt
(frictionTicks = 0). Der Route-Bot springt immer so. Mit "Dip nur verschieben, wenn jumpQueued"
zeigte die Kamera bei den Bot-Hops in level1h (sync 0.8) einen Frame lang Dip: p50 1.75 u, Abstiege bis 4.7 u.
**Richtig (CameraRig):** jede Landung einen Tick zurückhalten und erst auflösen, wenn sicher ein
weiterer Tick gelaufen ist — Framezeit nach dem Land-Frame ≥ Tick-Dauer (FixedLoop: acc ≥ 0 nach
dem Land-Frame); der Frame des Land-Ticks selbst zählt nicht. Kostet nicht-perfekte Landungen
1 Frame (60 Hz) bzw. 2 (144 Hz). Dasselbe gilt für Sfx.land (Plan 003 S2): `jumpQueued=false`
heißt nicht "sofort spielen", sonst knallt die Landung genau beim perfekten Tipp-Hop.

## 55. Kamera: Gewinnrate aus dem Tick-Speed erst entzerren, dann asymmetrisch glätten

`view.speed` springt nur bei Ticks. Bei 144 Hz wechseln Frames mit 0 und 1 Tick, bei 60 Hz
2 und 3 — die Rate dSpeed/dt pro Frame ist eine Rechteckwelle um den wahren Wert. Ein Filter mit
schnellem Abbau (Surge soll bei Fehlern sofort einbrechen) folgt den Null-Frames und hält den
Surge künstlich tief. **Richtig:** erst symmetrisch kurz entzerren (τ ≈ 0.03 s), dann asymmetrisch
(Aufbau 0.3 s, Abbau 0.07 s). Bodenkontakt eines Bhops (1 Tick) nicht als 0 einspeisen, sondern
halten (hier 0.1 s), sonst bricht der Surge bei jeder perfekten Landung ein.

## 56. Render: Relative Luma-Ziele auf hellen Neon-Trims haben eine Decke

Plan-Ziel "Trim-Luma im Wellenring +60 %" ist mit der mittleren Luma nicht erreichbar:
Cyan-Trims liegen nach Quantisierung schon bei Luma 0.72, reines Weiß ist 1.0 → höchstens
+39 %. Die Welle erreicht +33 % (Front fast weiß, 0.72 → 0.96). Mehr Signal gibt es nur über
FLÄCHE (Band kurz um ≤ 2 px nach außen aufweiten: Licht-Summe im Ring +40 … +114 %), nicht
über Helligkeit. **Richtig:** Bei Aufhell-Zielen erst die Decke ausrechnen (1/L − 1); für
helle Elemente Kontrast/Fläche messen statt relativer Luma. Und: "Ring"-Mittelwerte über
alle geänderten Pixel verdünnen den scharfen Kamm mit dem schwachen Nachglühen.

## 57. Tools: Hero-Shots (`npm run shot`) sind nicht pixelgleich reproduzierbar

Zwei identische Läufe unterscheiden sich in jedem Spiel-Shot (Titel 16k px, Surf 240k px):
Echtzeit-Bot, Musik-Uhr und Pause-Zeitpunkt (00:03.05 vs .10) schwanken. Ein "pixelgleich
mit/ohne Option X"-Kriterium lässt sich damit nicht prüfen. **Richtig:** Gleichheit im
deterministischen Harness (dev/render.html, feste Zeit/Kick, synchrones render() +
readPixels: `tools/shoot-render.mjs --fx`) belegen; die Hero-Shots nur auf Konsolenfehler
und Sichtprüfung. Vite-Spiegel mit node_modules-Junction liefern zudem 403 für
@fontsource-Dateien (außerhalb der fs-allow-Liste) — nur für Render-Messungen nutzen.

## 58. Input: Vollbild in derselben Geste erst NACH dem Lock-Versuch — sonst scheitert der Raw-Rückfall

"Vollbild beim Start" (Plan 003, U3) forderte Pointer Lock und Vollbild direkt nacheinander
in der Klick-Geste an. `requestFullscreen` VERBRAUCHT die Nutzeraktivierung,
`requestPointerLock` prüft sie nur. Headless kann der Browser kein `unadjustedMovement`:
der erste Lock scheitert mit NotSupportedError, der Rückfall ohne Raw kommt erst nach einem
`await` — und fand keine Aktivierung mehr ("A user gesture is required"). Headed (echtes
Chrome, Raw geht) fiel es nicht auf. **Richtig:** Vollbild erst anfordern, wenn das
Lock-Promise entschieden ist (`Game.fullscreenFromGesture`); die Aktivierung hält ~5 s,
der Lock entscheidet in Millisekunden. Prüfen headless UND headed (Rückfall-Pfad ≠ Raw-Pfad).
Achtung beim Messen: Playwright-Tastendrücke gehen über CDP an die Seite, Browser-Kürzel
wie Strg+W lösen sie nie aus — "kein Dialog" belegt dort nur, dass keydown mit
preventDefault ankommt und kein beforeunload feuert.

## 59. Tools: Heap-Sampling ohne GC-Flags sieht nur ~6 % des Mülls — und Doubles in Feldern boxen

`HeapProfiler.startSampling` zählt ohne `includeObjectsCollectedByMinorGC/MajorGC` nur, was
beim Stopp noch lebt: Level 2 mit Bot 48 KiB/s statt 775 KiB/s. `tools/alloc-probe.mjs` setzt
die Flags jetzt; Vergleiche mit alten Zahlen (#49) sind damit ungültig. Referenz 27.09.
(nach Plan-003-Strängen, 60 fps headless, 1280×720): Level 2 mit Bot (route, sync 1, Seed 11)
~1500 KiB/s gesamt, davon src/ ~930; Level 2 ohne Bot ~825 / 434; Level 1 mit Bot ~1440 / 955.
BitmapFont.styled 0.0 (vorher ~20 KiB/s). Zweite Falle: Kleinkram wie `Math.round(x)` in ein
Feld, das ein selten optimierter Leser (HUD, einmal pro Frame) liest, boxt bei JEDEM Lesen
eine HeapNumber (Hud.drawKeys 1.2–1.9 KiB/s allein durch `turnDeg`). **Richtig:** Anzeige-
Ganzzahlen mit `| 0` (vorher auf int32 klemmen) als Smi speichern; drawKeys danach 0.4 KiB/s.
Summen schwanken zwischen Läufen um ±8 KiB/s — Vorher/Nachher immer mit ≥ 2 Läufen je Seite.

## 60. Level: Der "perfekte" Bot springt in Hop-Ketten systematisch zu kurz — der Rückstand wächst

Die Hop-Reihe (Level 1) setzt Plattformmitten eine Flugweite `v · 0.755 s` auseinander. Der
RouteFollower springt aber dort ab, wo er landet, und landete nach dem ersten (gebremsten) Hop
jedes Mal ~20 u vor der nächsten Plattform auf dem Grabenhang. Von dort ist der Flug flacher
(0.72 s), der Rückstand wuchs bis H6 auf ~230 u — der Crouch-Hop ging zu früh ab, und JEDER Lauf
(auch sync 1.0) stand danach mit 320 u/s an der Kante. Das färbt alles dahinter: Kehre, Könner-
Inseln und die Autor-/Gold-Zeiten. Die Bot-Übersicht (8/8 im Ziel) sah dabei gesund aus.
**Richtig:** In Ketten nicht nur "kommt durch" prüfen, sondern Landepunkte gegen die
Plattformmitten und das Tempo an Schlüsselstellen (Crouch-Kante, Pad 1) über die Seeds ausgeben;
Abstände relativ zur echten Flugweite planen (Level 1: × 0.94, H7 × 1.04, per Sweep bestimmt).

## 61. Level: Eine Auffangfläche neben einer Surf-Rampe braucht eine Bande

Wer ohne Surf-Technik (W gehalten, keine Taste in die Rampe) auf eine 60°-Flanke fällt, rutscht
ab und verlässt den Fuß mit ~400 u/s NACH AUSSEN. Mit Auto-Hop springt er auf der Auffangfläche
sofort weiter — in dieselbe Richtung: jeder dritte Geradeaus-Läufer flog seitlich von einer
640 u breiten Fläche (Rutsche Level 1). **Richtig:** Bande (128 u, höher als ein Sprung) an beiden
Rändern, im Selbsttest gegengeprüft. Dasselbe am Ring von Level 2: wer W + Leertaste hält, lenkt
in der Luft nicht und fliegt tangential ab (novice.ts: 54 Tode) — dort eine 80-u-Bande mit
offener Ausfahrt. Die Öffnung nicht an der Ideallinie bemessen, sondern an geraden Linien quer
über die Landefläche dahinter (die Ausfahrt-Probe fand Läufer, die an der Bande entlang ewig kreisen).

## 62. Tools: Der Bot beendet seine Route beim PASSIEREN des letzten Knotens — auch im Flug

`runRoute` meldet "finished", sobald der Ziel-Knoten passiert ist, der Lauf zählt aber nur mit
Berührung des Ziel-Triggers (`touchedFinish`). Mit einem niedrigen Ziel-Trigger (der Lauf soll mit
der Landung enden, nicht über der Zielkante) flog der Bot über den Knoten, war "fertig" und hatte
das Ziel nie berührt: sync 1.0 0/8 im Ziel. **Richtig:** Ziel-Knoten hinter den Landepunkt des
schnellsten Flugs legen (Level 1: 1700 u hinter der Zielkante).

## 63. Shell: Patch-Skripte scheitern still an CRLF-Dateien

`src/render/trims.ts` und `textures.ts` haben CRLF, die Level-Tools LF. Mehrzeilige Ersetzungen
("nicht gefunden → throw", #19) schlugen dort fehl, obwohl der Text im Editor identisch aussah.
**Richtig:** Im Patch-Helfer `\r\n` → `\n` normalisieren und beim Schreiben das Original-
Zeilenende wiederherstellen; vorher `file <pfad>` prüfen.

## 64. Audio: Tiefband-Check und Lautheit hängen am Limiter — leiser machen verschiebt Verhältnisse

Plan 003 A9 senkte die Layer-Stufen (Mixer `LAYER_LIFT_DB`) um bis zu 2 dB. Danach fiel der
audiocheck "Bass/Rumble ≥ 4 dB unter Kick im Tiefband" (−3.5 dB), obwohl sich am Bass nichts
geändert hatte: Die Kick solo lag nie am Limiter, der Mix ohne Kick (Bass, Rumble, Pad, Acid)
schon — vorher drückte der Limiter ihn mit, jetzt nicht mehr. Die Kick fiel um die vollen
2.0 dB, der Rest nur um 1.3 dB. Ebenso: Integrierte Lautheit eines Laufs ist nicht die der Musik
— Belohnungs-SFX mit Energie-Aufschlag, Wind und Surf-Zischen lagen in den Replays 1.5–3 LU
darüber (l2: Musik −15.7, gehört −12.8 LUFS). **Richtig:** Pegeländerungen vor dem Limiter
immer mit vollem audiocheck gegenprüfen (nicht nur Lautheit); Lautheitsziele an der gehörten
Spur (Musik + SFX) messen, Musik-Anteil getrennt ausweisen. Unter 90 Hz gehört das Tiefband
der Kick: Bass mit Low-Shelf −2 dB statt die Kick lauter zu machen.

## 65. Tools: alloc-probe nach 2.5 s misst den JIT-Anlauf, nicht den Dauerbetrieb

Die Referenzwerte aus #59 (Level 2 ohne Bot ~825 KiB/s, src/ ~434) sind zu ~85 % Aufwärm-Müll:
Ignition/Sparkplug (und Maglev an Aufrufgrenzen) boxen jede Gleitkommazahl als HeapNumber,
auch Lesezugriffe auf Double-Felder. Dieselbe Szene nach unterschiedlich langem Aufwärmen
(27.09., 1280×720, 60 fps): 2.5 s → 725 / 355 KiB/s (gesamt / src/), 10 s → 357 / 101,
20 s → 280 / 74, 60 s → 249 / 42. In Node zeigt dieselbe Schleife das Muster ebenfalls
(CameraRig.update 133 KiB/s nach 20 s, 0 nach 120 s — und nach einem späten "wrong map"-Deopt
wieder 125). Was nach 60 s bleibt, ist fast nur three.js: `setValueV3f`/`setValueV1f` ~108 KiB/s
— jeder `gl.uniform3f` mit wechselnden Werten boxt seine Doubles für den API-Aufruf (u. a.
`cameraPosition` je Programm); ohne three zu patchen nicht zu ändern.
**Richtig:** Vor Allokations-Urteilen beide Zahlen messen — Anlauf (`--warmup 2.5`) und
Dauerbetrieb (`--warmup 60`, ohne Bot). Gegen den Anlauf hilft nur Vorwärmen:
`engine/jitWarmup.ts` fährt im Titel-Leerlauf 8192 Ticks Movement + Kamera auf Wegwerf-
Instanzen (16 ms) → Anlauf src/ 355 → ~268 KiB/s. `getOutputTimestamp()` liefert je Aufruf
ein neues Objekt → nur alle 0.25 s holen (TechnoAudio.heardTime 7.5 → 2.8 KiB/s).
Deopt-Suche im Browser: `chromium.launchServer({ args: ['--js-flags=--trace-deopt'] })`,
stdout von `server.process()` lesen (buildLevelMeshes deoptimiert beim Laden ~550× "exit
from OSR'd inner loop" — Ladezeit, nicht Frame-Pfad).

## 66. Ghost: Das Ziel liegt zwischen zwei Raster-Samples — ohne Schluss-Sample steht der Ghost zu früh

Aufnahme im 32-Hz-Raster (Sample k bei Laufzeit k/32) endet mit dem letzten Raster-Sample VOR
der Zielzeit. Die Wiedergabe klemmte danach auf dieses Sample: bis zu 1/32 s × 1000 u/s = 31 u
Versatz genau im Zielanflug (Vitest: 23.8 u). **Richtig:** Beim Ziel ein Sample über das Ziel
hinaus mit der letzten Tick-Geschwindigkeit extrapolieren (GhostRecorder.finish). Prüfen gegen
einen identischen Lauf (gleicher Seed, gleiche Sync): Abstand Ghost↔Spieler auf dem Raster
0.001 u; zwischen den Samples bleibt die Sehne (Ø 0.3 u, max 9 u beim Crouch-Jump-Versatz der
Füße um 18 u in einem Tick) — unsichtbar. Der HUD-Abstand kommt aus den aufgezeichneten
Checkpoint-/Zielzeiten des Ghosts, nicht aus einer Positionssuche: Level 2 kreuzt sich selbst
(Ring), und im Ziel von Level 1 (Landung auf breiter Fläche) liegen Spieler und Ghost weit auseinander.

## 67. Audio/Game: Die Rampe, auf der man surft, ist für den Vorbeizieh-Whoosh "direkt daneben"

Seitliche Proben quer zur Flugrichtung treffen beim Surfen ständig die eigene Rampe (Level 2:
3/4 aller Treffer < 160 u, alle surfend) — der Whoosh rauschte jeden Surf lang voll und
maskierte das Surf-Zischen. Level 1 hat dagegen fast nichts in Reichweite: die Säulen stehen
> 400 u neben der Linie, nur die Rutsche meldet sich (19 von 1604 Proben). **Richtig:** Beim
Surfen die Seite der Surf-Normale ausblenden (|rechts·n| > 0.3), nur Distanz auswerten
(#41). Wer den Whoosh an Level-1-Säulen hören will, muss sie näher an die Linie stellen
(< 160 u), nicht die Probe verlängern — der Whoosh ist auf 40–160 u abgestimmt.

## 68. Tools: Alle Projekt-Bots drücken den Sprung bei jeder Bodenberührung FRISCH — der Smart-Hop bleibt ungemessen

`StrafeBot` und `NaiveBot` setzen `jumpPressed = onGround`, der `RouteFollower` `jumpPressed = willJump`. Ein frischer
Druck springt immer sofort, der Smart-Auto-Hop (nur gehaltene Taste) wird dadurch in Sim,
levels:check und `__vel.useBot` nie ausgelöst. Folgen (Prüfung 27.09.): `NaiveBot` ("W +
Sprung halten") kriecht weiter mit 32 u/s (naivebot.ts 169 u in 5 s) — er ist ein
Mausrad-Spammer, kein Halter. Und die Wartezeit des Smart-Hops trifft Strafer, deren Landung
mit gedrückter A/D unter 0.97 × Wunschtempo liegt (Auto-Sprint → Schwelle 310 u/s): 6°-Hand
nur gehalten H20 357 → 313 u/s, 43 % der Landungen stehen ~0.18 s am Boden; kein Bot sah das.
**Richtig:** Für Aussagen über Auto-Hop die Bot-Eingabe umbiegen (`jumpPressed` nach dem ersten
Tick false, `sprint` wie im Spiel = true) — Beispiel tools/critique/verify1/heldhands.ts.

## 69. Tools: sfxmask.mjs druckt die Wind-Zeile unter dem Header des VORIGEN Levels

`tools/critique/audio/sfxmask.mjs` loggt `Wind (Dauer)` vor `console.log(L.name)`. In der
Konsole steht der L4-Wind (2.3 dB) unter "L3" — sieht aus wie "A2 verfehlt". Maßgeblich ist
`sfxmask.json` (`row.wind` je Level): L3 +10.3 dB. Ebenso: `__vel.useBot('route', …)` kennt
kein `aimNoiseDeg` (nur sync/seed/…); eine "5°-Hand" im Browser ist still ein sync-1-Bot.

Nachtrag (Fix-Runde 27.09.): `NaiveBot` hält jetzt wirklich (`press: 'hold'`, Default; `'spam'` =
alter Druck je Landung), `__vel.useBot` reicht `aimNoiseDeg` und `press` durch, sfxmask druckt die
Wind-Zeile unter dem richtigen Level. StrafeBot/RouteFollower drücken weiter frisch — für Aussagen
über den Smart-Hop bleibt heldhands.ts das Werkzeug.

## 70. Bots: Bei hohem Tempo verliert eine Zielrausch-Hand die KURVE, nicht nur Tempo

Das Gewinnfenster des Air-Strafes ist cap/|v| breit: bei 900 u/s ±1.5°. Ein Zielfehler NACH
VORN (wishdir vor dem Fenster) heißt `dot(v, wishdir) ≥ cap` → AirAccelerate addiert nichts →
weder Gewinn noch Drehung. Das AR(1)-Rauschen der `aimNoiseDeg`-Hand (1°, τ 0.15 s) lag so bis
0.5 s am Stück vor dem Fenster; der Bot flog geradeaus und knallte im L1-Slalom an die Inselflanke.
Folge: GERADE die guten Hände starben (schneller → schmaleres Fenster), Hand 1°/1.5° 16/20, Hand 2°
19/20 — levels:check prüfte nur 2°/3°/sync 0.7–1.0 und sah es nicht. **Richtig:** Menschen ziehen
die Maus weiter, wenn eine nötige Kurve nicht kommt: `steerPriority` spiegelt beim Kurskorrigieren
Fehler nach vorn auf die Dreh-Seite (gleicher Betrag). Nicht aufs Optimum klemmen (Fehler
verschwinden → Hand zu gut, Medaillen verrutschen um Sekunden) und keinen festen Bias addieren
(bremst überall, bei +2 Fenstern Stalls). Außerdem: Werkzeuge mit Respawn müssen den Seed je
Versuch wechseln — derselbe Seed wiederholt denselben Fehlversuch (novice.ts: 73 Tode an einem
Knoten).

## 71. Kamera: FOV-Ziele in 16:9-Grad nachrechnen — die Kurve erreicht 112° schon bei 500 u/s

Der FOV-Kick rechnet in horizontalen 4:3-Grad (CS-Konvention); 16:9 sieht
`2·atan(4/3 · tan(h43/2))`. Basis 90 → 106.3°, und jeder 4:3-Grad ist dort ~0.96 Grad. Die Vorgabe
"≤ 112° bei 16:9, Log-Kurve 300–800 u/s unverändert" ist unerfüllbar: 112° entspricht nur 5.8°
Kick, die Kurve (6°/Verdopplung über 250) liefert 6.0° bei 500 und 10.07° (115.7°) bei 800 u/s.
Vor dem Umsetzen eines Grad-Ziels die Tabelle Speed → 16:9 ausrechnen, sonst jagt man eine Kappe,
die die Kurve im Kernband flach drückt. Entschieden (Runde 2): Kurve bis 800 exakt, Kappe 11°
(116.5°). Nebenbei: `node -e` mit Template-Strings und Backticks in Git-Bash zerlegt die Shell —
Testcode mit dem Edit-Tool schreiben.

## 72. Level: Jede neue Kante in der Landezone der Ausfahrt kippt das Auto-Hop-Raster — Varianten rastern, nicht raten

Die Einstiegsrampe S0 vor S1 (Level 2, Polish-Runde 2) brauchte elf Anläufe, bis `exitTiers`
(600 Geradeaus-Läufe ab Ring/T0, 320–1500 u/s, ±96) wieder 0 Tode zeigte. Ursachen der Reihe nach:
(a) Linien auf S0 und S1 seitlich versetzt (andere Breite/Flanke) → `routeAxis` kippt zwischen den
Knoten um 11°, der Grundtechnik-Surfer fährt schräg über die Flanke (45/600 tot); (b) 50°-S0 vor
60°-S1: an der Linie ~95 u Stufe, wer das S0-Ende nur STREIFT, bekommt +250–400 u/s nach außen und
fliegt am S1-Fuß vorbei (der Surfer steuert in der Luft nicht); (c) Übergangsstück 50°→60°: die
Knickfläche fällt in Fahrtrichtung weg (Normale −0.44), dasselbe; (d) Auffangfläche, die die Flanke
schneidet, fängt auch tiefe, haltbare Linien ab (23–35/600); (e) jeder Drop S0→S1 (64/96/128 u) und
jede Kettenhöhe verschiebt, welche Geschwindigkeit genau eine Drop-Kante streift (1–7/600, chaotisch).
**Richtig:** Keine neue Kante in Flugbahnen: gleiches Profil, Stoß an Stoß, Linien auf derselben
x-Position; Auffangflächen UNTER den Fuß (wie L1-Rutsche), nie an die Flanke. Danach Länge/Gefälle
rastern (Umgebungsvariable im Level-Skript, Schleife über Build+Check) und ein Plateau wählen, nicht
den einen grünen Punkt — hier grün: 672 u × 3°/4°, 640 × 4°, 608 × 2°; rot dazwischen.

## 73. Tools: novice.ts bleibt in jeder Auffanggrube stecken — "0 Tode" heißt dort STAU

Der NodeTracker zählt einen Knoten nur, wenn der Bot höchstens 64 u darunter ist. Wer auf einer
Auffangfläche unter einer Surf-Rampe steht, zielt deshalb ewig auf den Knoten auf der Flanke über
sich und läuft in die Bande (L1-Rutsche schon in Runde 1, jetzt S0 in L2: alle fünf Typen STAU nach
44–52 s, 0–1 Tode statt 55–114). W-Halter "schweben" außerdem an der flachen (4°) S0-Flanke: der
Blick auf den höheren Knoten drückt sie in die Rampe. **Richtig:** Bei Auffang-Designs Tode UND
Stau-Ort berichten; ob der Rückweg begehbar ist, prüft eine eigene Probe (designProbes `s0BackWay`),
nicht der Novize. Auf Banden landet man auch von oben (sie sind 32 u breit, Grat begehbar #41):
Nordenden jeder Grube schließen, die Bande außerhalb der Flugbahn von der Kante darüber setzen.

## 74. Audio/Level: Der Vorbeizieh-Whoosh hört nur Kollisions-Geometrie — und dünne Pylonen sind ein Blip

`Game.probeNear` traced `world.traceBox` (Box ±4 u, Füße +20…+56, ±160 u quer, alle 2 Ticks).
Deko (`collide:false`) ist nicht in der Welt — ein Deko-Pylon macht keinen Laut. Ein 24 u dünner,
kollidierbarer Pylon ist bei 870 u/s zwei Proben (30 ms) lang seitlich: bei τ 25 ms Anstieg und Pegel
∝ Nähe^1.5 (40…160 u) kaum hörbar. **Richtig:** Finnen längs zur Flugrichtung (L1-Slalom: 24 × 128 u,
~0.15 s je Insel), kollidierbar, außen neben der Landefläche; Abstand an allen Startpunkten der
Design-Proben prüfen (mit 16 u Abstand stand die Finne auf den Startpunkten der Rutschen-Probe, die
96 u seitlich neben der letzten Insel beginnt). Offline messbar ohne Browser: die Probe entlang eines
RouteFollower-Laufs nachrechnen (`npx tsx tools/levels/whoosh.ts level1`, Werte stimmen mit Plan 003 überein).

## 75. Look: Emissive Glyphen und Kanten-Trims wachsen mit dem Weltmaßstab — direkt davor füllen sie das Bild

Die Crouch-Wand (L1) war aus dem Anlauf richtig groß (~9 Low-Res-px), 35 u davor aber 19 % des Bildes
flaches Cyan: 12 Texel hohe Glyphen plus das Kanten-Trim (3 u oben + 4 u Seite, in Augenhöhe genau
auf der Kante). Kleiner als 8 Texel geht nicht ohne 1-Texel-Striche (#25); das Trim ist Lesbarkeit.
**Richtig:** Die Botschaft dorthin legen, wo sie gebraucht wird — die Absprungzone als Boden-
markierung auf H7 (in Laufrichtung gestreckt wie eine Straßenmarkierung, 25 u je Glyph-Zeile, sonst
liest sie sich aus dem Anlauf als Striche), die Wandglyphen verkleinern. Messen: Anteil Cyan-Pixel
(G, B > 150, R < 0.6·G) in Screenshots aus 35/86/265/465 u.

## 76. UI: Pixel-Sprites nicht drehen oder skalieren — neu rastern, und das Frame-Budget gilt nicht fürs Vorwärmen

Die View-Hand (Plan 004) hat 2-px-Konturen im Low-Res-Raster. Ein gedrehtes oder per
`drawImage` gestauchtes Bitmap mit Nearest-Filter zerfranst genau diese Kontur (Zeilen
doppelt/weg, 1-px-Lücken). **Richtig:** Neigung und Squash als Parameter in den
Rasterizer, in Stufen (2.5°, 0.03) cachen. Das Rastern kostet ~0.7 ms (270 Zeilen) bis
1.9 ms (448) — Hüllkreise je Gruppe und "tief innen keine verschobenen Proben" sparten
~40 %. Pro Frame höchstens ein neues Sprite, sonst die nächste gecachte Stufe.
Falle dabei: `prewarm()` lief durch dieselbe Budget-Sperre und rasterte nur 1 von 6 Posen
(`__vel.hand().cached` = 1) — die erste Luft-Pose kostete dann mitten im Sprung. Für
schnelle Iteration an Proportionen ohne Browser: `npx tsx tools/hand-sheet.ts` (PNG aus
den Palette-Indizes, `zlib.crc32` ab Node 22.2).

## 77. UI: Zeitleisten aus Events — der erste Frame darf nicht um dt vorlaufen

Die Dosen-Tricks (Plan 005) starten bei 'jump' aus dem Tick-Pfad und laufen als Funktion der
Trick-Zeit. Erster Ansatz: `t += dt` im nächsten update() — bei 30 Hz lag der Trick dann 33 ms
vor der 1200-Hz-Referenz (6 Einheiten Höhe beim hohen Flip). Das Event kommt aus den Ticks
DIESES Frames, also am Ende des Intervalls; der erste gezeigte Frame ist τ = 0.
**Richtig:** beim Start ein `fresh`-Flag, im ersten update() kein dt addieren. Zweite Falle im
Test: Abtastzeiten wie 0.55 s liegen nicht auf dem 30-Hz-Raster (Runden verschiebt um bis zu
½ Frame = 9° Drehung) — Event- und Messzeiten auf Vielfache von 1/6 s legen (gemeinsames Raster
von 30/60/144/240/1200 Hz).

## 78. Shell: Heredoc-Patch mit TS-Template-Literals und „deutschen“ Anführungszeichen bricht

Ein `node <<'EOF'`-Patch mit Backtick-Templates, `${…}` und „…“ im Text endete mit *"unexpected
EOF while looking for matching `''"* — nichts angewendet, aber auch kein Hinweis, welche Zeile.
Bestätigt #19. **Richtig:** größere Patches (Blöcke mit Template-Literals) immer mit dem
Write-Tool als .mjs + separater Block-Datei, `patch()`-Helfer mit "nicht gefunden → throw" und
CRLF-Normalisierung (#63).

## 79. CSS: `justify-content: center` in einem scrollenden Flex-Container schneidet oben ab

Der Ergebnis-Screen mit Freischalt-Banner wurde höher als 1080 px; der zentrierte Inhalt
lief oben aus dem Container — Titel und Zeit waren unerreichbar (Scrollen geht nur nach unten).
**Richtig:** `justify-content: safe center` (fällt bei Überlauf auf start zurück) und den
Screen mit Banner kompakter setzen (`.vel-finish-screen--unlock`).

## 80. Tools: alloc-probe kurz nach dem Start zeigt das Füllen des Sprite-Caches, nicht Thrashing

Mit Dose meldete alloc-probe (Level 2, 8 s Aufwärmen) `rasterizePose` mit 2.2 MiB/s statt
~0.5 — sah nach überlaufendem Cache aus (der alte Cache leerte bei 160 Sprites ALLES). Gezählt:
46 Hand-Sprites im ersten Lauf, +3 im zweiten — es war nur das erste Rastern der zusätzlichen
Posen (kalter Code boxt, #59). **Richtig:** Cache-Verhalten über zwei Läufe zählen
(`__vel.hand().rastered`, `node tools/cosmetics-shots.mjs cache`), nicht aus einer Heap-Probe
schließen. Der Cache verdrängt jetzt trotzdem LRU statt komplett zu leeren.

## 81. Render: Inverted-Hull-Kontur braucht die ABLEITUNG der Projektion, nicht P·n

Erster Ansatz im Viewmodel (Plan 006): Normale mit `projectionMatrix * vec4(n, 0)` in den Clip-Space,
xy normieren, um N Pixel verschieben. An Teilen weit außen oder nah an der Kamera (Stulpe, Finger am
Bildrand) fehlte die Kontur an ganzen Silhouetten — der perspektivische Term fehlt (ndc = clip.xy/w,
d(ndc) = (Pn.xy − ndc·Pn.w)/w). **Richtig:** `d = (pn.xy - clip.xy/clip.w * pn.w) * uRes`, dann mit
der Chebyshev-Norm (max |x|,|y|) normieren — das ist der quadratische Pinsel im Pixelraster, schräge
Kanten werden nicht dünner. Quader (Karte, Messergriff) brauchen Ecken-Normalen aus den VORZEICHEN
(±1,±1,±1)/√3; Positions-Normalen zeigen bei langen/dünnen Quadern fast nur längs, die Kontur an den
langen Kanten fehlte.

## 82. Render: Röhren-Generator mit fallendem y dreht das Winding um

Die Stulpe (Ringe vom Handgelenk nach −y) war schwarz: alle Flächen zeigten nach innen, sichtbar war
nur die Kontur-Hülle (BackSide). **Richtig:** im Generator bei `y1 < y0` die Dreiecke umdrehen, BEVOR
`computeVertexNormals` läuft; Pol-Normalen danach explizit auf die Achse setzen, UV-Naht-Normalen mitteln.

## 83. Render: Deckel-Details müssen ÜBER der Kegelkappe des Körpers liegen

Die Trinköffnung der Dose war nach dem crack unsichtbar: die Kappe des Dosenkörpers ist ein flacher
Kegel zum Pol, und an Radius 1.5 lag er höher als Deckelscheibe und Öffnung. **Richtig:** Pol tief
genug (H − 0.35) und Deckel/Öffnung knapp unter H — isoliert prüfen mit
`tools/viewmodel-sheet.mjs` und `live: { trick: 'sip', at: 0.8, opened: true }`.

## 84. Look: Referenz-Griff — die Finger müssen über der Dosenfront liegen, nicht dahinter

Erste Grundhaltung (Daumen oben, Handrücken rechts) sah im Stand gut aus, mit Dose verschwanden aber
alle Finger hinter ihr — die Referenzen (015016/015019) zeigen die Faust ÜBER der Front. Eine
Drehung um die Unterarmachse (twist 2.36 → 2.05) plus Roll 0.8 löste es. **Richtig:** Grundhaltung
nicht raten — Wunsch-Basis (Finger-, Daumenrichtung im Bild) in Euler ZXY umrechnen und dann mit einem
Kontaktblatt über twist/roll/pitch variieren (`arm` in dev/viewmodel.html), neben den Referenzen.

## 85. Tools: Top-Level-await vor einem `const` weiter unten = TDZ-Fehler

`tools/viewmodel-shots.mjs` rief oben (Top-Level-await) eine Funktion, die ein weiter unten
deklariertes `const PHASES` las → "Cannot access 'PHASES' before initialization". Funktionen sind
gehoistet, `const` nicht. **Richtig:** Tabellen in Funktionen kapseln oder vor den ersten await stellen.

## 86. Tools: alloc-probe-Summen streuen stärker als ein zusätzlicher Render-Pass

Viewmodel-Pass an vs. aus (Level 2, --warmup 60): 280 vs 620 KiB/s gesamt — "aus" war MEHR. Die
Summen (three.js, intern) streuen von Lauf zu Lauf um ein Vielfaches. **Richtig:** nur die src/-
Funktionsliste im Dauerbetrieb lesen (neue Module dürfen dort nicht oben auftauchen), keine Summen
zwischen Läufen vergleichen. Bestätigt nebenbei #78: auch Python-Heredocs mit `'…'`-Strings und
Backticks brechen in Git-Bash — Patch-Skripte als Datei schreiben.

## 87. Admin-Menü: Ableitung und Caches holen Gelöschtes zurück

Zwei Stellen, an denen "von Hand entfernen" still nicht hielt: (1) Freischaltungen werden bei
jedem Start aus den Bestzeiten nachgetragen — eine Sperre, die nur in der Sitzung galt
(`deriveOff`, alt `__vel.resetUnlocks`), war nach dem Neuladen weg. (2) `GhostStore` hält einen
Speicher-Cache pro Level; nur den localStorage-Key zu löschen lässt den Ghost im laufenden Spiel
stehen. **Richtig:** Sperren persistent speichern (`locked` im Unlock-Stand v3, Ableitung
überspringt sie) und Bestzeit-Änderungen aus dem Menü per Event an Game melden
(`adminBest` → `ghostStore.clear`, Bestzeit/Nächstes Ziel nachziehen). Nebenbei #78 erneut:
auch ein Bash-Heredoc mit `„…“` und Python-Triple-Quotes brach — Patch-Skripte als Datei.

---

# Plan 007 (v2: Arcade-Movement, Training, L3/L4, Kosmetik v2)

Zusammengeführt in Phase 3 aus `.docs/learnings/inbox/*.md` (Stränge contracts, level-tools, movement,
cosmetics-core, level3, level4, l1l2, training-core, training-ui, cosmetics-items, integration). Zahlen und
Messskripte stehen in den Strang-Berichten und in `.docs/research/`.

## 88. Freischaltungen: eine erweiterte Tabelle verteilt Dinge, die es noch nicht gibt

Die Plan-007-Tabelle hängt Jo-Jo an L1-Silber und die Skelett-Hand an L2-Gold — beides hatten Spieler
schon. `UnlockStore.sync` hätte beim nächsten Start "FREIGESCHALTET: Jo-Jo" gemeldet und per `unlockPatch`
eine leere Hand angelegt. **Richtig:** den Vertrag komplett einführen, die Vergabe aber getrennt schalten
(`PENDING_UNLOCKS`: Ableitung meldet, sync vergibt nicht, Admin darf alles) und die Menge leeren, wenn die
Kosmetik existiert (Phase 3: entfernt). Dazu: `[].every(…)` ist `true` — eine Trainings-Anforderung
"jede Lektion ≥ 1 Stern" war ohne geladenen Lektions-Index erfüllt. `lessons.length > 0 && every(…)`.

## 89. Verträge: ein Pflichtfeld trifft auch Dev-Harnesses und Prototyp-Kopien

`MovementEvent` 'jump' + `clean` brach 12 Literale (src/audio/dev, src/ui/dev/fakeRun, Menü-Vorschau,
Tests, zwei PlayerMovement-Kopien in tools/critique/v2). tsc findet sie, weil `tools/**` im Include
steht — Prototyp-Ordner reparieren statt ausschließen, sonst verrotten die Referenzen. Gegenstück:
Harnesses, die Objekte feldweise bauen (`scenarios.drive()`), verlieren NEUE optionale Felder still —
das Rutsch-Kratzen war offline stumm, bis Phase 3 `sliding` durchreichte. Und Vertrags-Tests, die
"verhaltensneutral" festschreiben (contracts.test: Cap 32, `sliding` immer false), kippen absichtlich, sobald die
Physik kommt — beim Einschalten im selben Zug mitziehen.

## 90. Kleinkram Werkzeug/Umgebung (Windows, Git, Vitest)

- Node-ESM: ein absoluter Windows-Pfad im `import` braucht `file:///C:/…` (sonst
  ERR_UNSUPPORTED_ESM_URL_SCHEME); tsx schluckt den nackten Pfad.
- `.gitignore`: `shots` + `!shots/v2/` wirkt nicht — Git steigt in ausgeschlossene Ordner nicht ab.
  `shots/*` und dann `!shots/v2/`.
- Vitest unter Last: "Failed to terminate forks worker … kill EPERM" ist kein Testfehler.
- `npm run shot` meldete unter Parallel-Last einmal "Esc → Pause, Maus frei" rot (Lock-Emulation) — einen
  roten Einzelcheck erst wiederholen.
- Scratch-Skripte außerhalb des Repos finden `three` nicht (tsx löst Paketnamen vom Dateiort) — nur
  Repo-Module importieren oder `…/node_modules/three/build/three.module.js` relativ.

## 91. Level: Der "perfekte" Bot ist zweigeteilt — dann trägt keine Kennzahl

Gold/VELOCITY/Autor kamen aus EINEM sync-1.0-Lauf. Über einen Start-Kasten (±16 u quer × ±1° Blick bis
zum ersten Absprung) zerfiel L1 in zwei Zweige (Bonk vor der Crouch-Kante, +2.5 s). Median UND
25-%-Quantil springen dann mit der Stichprobe (Rasterdichte, Physik-Stand). Die vier Ecken eines Kastens
sind keine faire Stichprobe. **Richtig:** 7 × 7 = 49 Zellmitten (`physics.jitterMedian`), den Zerfall
erkennen (`jitterBranches`: Lücke ≥ 4 % des Medians, je Seite ≥ 10 %) und laut melden — dann das LEVEL
reparieren, nicht die Kennzahl wechseln. Ebenso L3: erst die 49 Starts zeigten, dass die Finale-Linie
(320 u unter dem Grat) für den perfekten Bot 3–4/49 Mal ohne Ziel endet; die 8 Validator-Seeds sahen 0 F.

## 92. Level-Werkzeug: `resumeIndex` braucht die Höhe — und liefert den Knoten NACH dem Spawn

In einer Wendel liegt unter jedem Podest die vorige Umdrehung; `resumeIndex` (nur x/z) setzte den Bot nach
CP3 eine Etage tiefer an. **Richtig:** y mitprüfen (`nodeInTrigger`: [min − 8, max]). Der zurückgegebene
Knoten ist der NÄCHSTE nach dem Spawn und liegt oft außerhalb des Triggers (Absprung auf dem Brett, Surf-
Knoten 320 u tiefer) — Etage über den ersten Knoten IM Trigger prüfen, für den Wiedereinstieg nur
Reihenfolge und Höhe relativ zum Spawn. Eine Attrappe, deren Weg zufällig über der unteren Etage
weiterläuft, kommt mit falschem Wiedereinstieg trotzdem ins Ziel — die statische Regel "Schatten-Knoten"
fängt den Rückfall.

## 93. Proben: erst gegen einen eingebauten Fehler laufen lassen, dann ihrem Grün trauen

- `helixBoard` zählte "fällt von der Wendel" nur bei Bodenkontakt; ein Hüpfer durch eine Bandenlücke war
  am Probe-Ende noch in der Luft → kein Tod, keine Landung, Selbsttest rutschte durch. Höhe im Flug werten.
- `simulate`-Ziele sind Hull-Überlappung (Füße bis Kopf): eine dünne Box "auf Kantenhöhe" trifft man vor
  der Wand schon von unten. Füße selbst prüfen.
- L4-Bande: die Probe schickte nur Geradeaus-Hüpfer ≤ 25° nach außen — ≥ 65° zur Wandnormalen, wo der
  Kanten-Assist (≤ 45°) nie greift. "702 Hüpfer, 0 Tode" war formal richtig und wertlos. Für jede Hilfe,
  die Reichweite schafft (Kanten-Assist, Crouch-Jump, Hang), die Probe in ihren Wirkbereich legen (frontal
  und schräg, Hop/Crouch-Hop/Ducken gehalten, bergauf/bergab, an der Wand und mit Anlauf) und im Test eine
  Gegenprobe am alten Stand mitführen (muss Fluchten finden).
- Mutations-Audit (movement): drei Mutationen überlebten, weil eine Kappe den Test allein grün hielt
  (Schub-Test mit 600 u/s über slideBoostCap). Missbrauchstests in das Band legen, in dem nur die geprüfte
  Regel greift; Rücksetz-Tests so bauen, dass der alte Zustand sofort wirken würde.

## 94. Parallelbau: gegen eine eingefrorene Kopie messen

Stränge änderten `src/player/**`, `tools/levels/*` und `Game.ts` im selben Baum (zeitweise tsc rot, einmal
startete KEIN Level). "Zeilengleich"/"byte-gleich" gilt nur gegen dieselbe Physik und dieselben Werkzeuge
(#30). **Richtig:** `src/`, `tools/`, `public/` per robocopy in den Scratchpad, `node_modules` (und ggf. das
echte `src`) als Junction (`mklink /J`), eigene Dateien hineinsynchronisieren, alle Vorher/Nachher-Läufe
dort. Im Browser fehlende fremde Methoden per `page.route('**/src/ui/Hud.ts*')` als No-op anhängen (nur wenn
sie fehlen) und den Shim im Bericht nennen. Takt- und Zeit-Zahlen, die auf fremden Leveln laufen
(event-probe, Freischalt-Leiter), sind Momentaufnahmen — nach dem letzten Level-Build neu messen.

## 95. Level-Werkzeug: Cache-Schlüssel, Filter, eigene Geometrie — alles, was neben dem Original rechnet, driftet

- SpeedCurve-Cache: der Schlüssel kannte 8 Felder (ohne Cap-Felder, `sprintSpeed`, `strafeAssist`) — zwei
  Configs in einem Prozess teilten eine Kurve. Stabiler Schlüssel über ALLE Felder (`configKey`, Zahlen per
  `String`, JSON macht aus Infinity null); im Test beide Werte ausdrücklich setzen (Default wandert).
- Filter: `levels:build -- level3` schreibt nie index.json, `levels:check` las aber nur den Index → hätte
  nichts geprüft. Jedes CLI-Argument muss etwas treffen ("0 Level, grün" ist ✗), gebaute Lektionen auch
  unter `training/<id>.json` suchen, im Build alle ids auflösen und messen, BEVOR geschrieben wird;
  build.ts braucht einen main-Guard (sonst baut jeder Import alle Level nach public/).
- `killTiles`/`finaleReserve` rechneten Grundrisse selbst (Prismen fehlten, Drehung/pivot ignoriert, AABB
  statt echter Ecken). `compileBrush(def).bounds` bzw. die echten Ecken nehmen.
- Tick-quantisierte Zeiten (1/128 s) sind kein Test-Signal für 1° Blickfehler — die Mechanik als Einheit
  testen und die Richtung gegen die echte Bewegung.

## 96. Movement: Crouch-Kanten ≥ 66 u — Reichweiten aus dem Auto-Hop-Rhythmus messen

"57 + Lip-Step 5 + 2 Reserve = 64 u" rechnete mit dem Sprung vom Boden. Im Bhop-Rhythmus springt man im
Landetick, und die Landung schwebt bis 1.5 u (2-u-Sonde): ohne Ducken bis 63.5 u, eine 64er-Kante hatte
0.2–0.5 u Reserve (Brute-Force: 63.75 u in 57/19 470 oben; die Level-Probe traf 0.5 u unter der Reichweite
nur 3/153). **Richtig:** Reichweite als Eigenschaft der Config messen (`noDuckReach`, Bisektion), < 2 u
Reserve warnen, Kanten ≥ 66 u, Selbsttest-Fälle relativ zur gemessenen Reichweite. Oben: mit Crouch-Jump
aus dem Lauf (320 u/s) 75 u, eine 76er-Kante schafft niemand (T6-Raster); mit Assist und günstiger Phase
bis 80 u (sim) — deshalb halten 80-u-Banden nicht mehr (#133).

## 97. Movement: Schwellen gegen Rauschen nach jeder Cap-Änderung gegen den Luft-Schub prüfen

Nach einem Bonk drückt der Luft-Schub (Cap 40: ~50 u/s) weiter gegen die Wand — knapp über
LEDGE_MIN_SPEED (50): jeder Folge-Tick galt als "Anprall" und überschrieb die gemerkten 539 u/s. Mit Cap 32
(Schub 40) fiel es nicht auf. **Richtig:** nur ein stärkerer Anprall überschreibt ein laufendes Gedächtnis.

## 98. Movement: Wand-Tasche — Doppelebenen-Regel + zwei fast parallele Wände = Schweben

Zwischen zwei um 4° verdrehten Banden-Stücken lieferten alle Bumps fraction 0 (zweite Wand "dieselbe
Ebene", #17), Source nullt die Geschwindigkeit: solange W hineindrückt, schwebt man. **Richtig:** trifft
ein Luft-Move nur Wände und kommt nicht vom Fleck, senkrecht weiterfallen. Hänger-Proben nach dem
GESAMTPAKET wiederholen — jede Physikänderung lenkt die Bahn in andere Ecken. Offen (l1l2): die Kerbe
Surf-Flanke/senkrechte Wand (L2, E1-West) bleibt ein Hänger (`allFraction === 0`, die Flanke ist keine
Wand); levels:check warnt (3/720).

## 99. Proben mit Zeitlimit und Auto-Hop messen bei schnelleren Mechaniken das Gegenteil

fixcheck "Crouch-Kanten 198/200": mit Kanten-Assist landet man mit vollem Tempo AUF der Kante, der
Smart-Hop springt sofort weiter, und die Probe ("am Boden hinter der Wandlinie") bricht nach 4 s mitten im
nächsten Hop ab. Mit "Hull über der Kante" 200/200. Ebenso fehlte der L4-Crouch-Probe der Tempoverlust.

## 100. Kamera: Lip-Step + Interpolation — nur den sichtbaren Teil ausgleichen

Der Lip-Step hebt die Füße in einem Tick um bis 5 u; im Frame des Ticks zeigt die Interpolation erst
tickAlpha·dy. −dy beim Event drückt die Kamera unter die Bahn. **Richtig:** `rig.onTick()` je Physik-Tick
(Game vor den Events) und `CameraView.tickAlpha`; genau den sichtbaren Teil ausgleichen, linear in 0.1 s
abbauen.

## 101. Abnahmen gegen Mess-Artefakte rechnen (Phasen-Raster, W-Schub, gepatchte Prototypen)

- Hang-Landung "< 3 u/s über 16 Phasen": das Raster startet je Phase bis einen Fall-Tick höher → echter
  Aufprall bis g·dt schneller; 2.9–3.5 u/s Rest sind Energie, keine Lotterie (die war 354–803 u/s).
- Luftlenkung "30–35° in 0.3 s" und "Tempo ±1" gelten nicht zugleich: Sources W-Schub addiert quer bis zum
  Cap. "Betrag bleibt" mit Blick ≤ 83° messen.
- Prototyp-Patches auf `PlayerMovement.prototype` sind mit Schaltern aus transparent — nach dem Einbau zeigt
  ihre erste Spalte die NEUE Engine (brauchbare Gegenprobe), die übrigen wenden die Mechanik doppelt an.
- Eine Erklärung "Artefakt des Bots" erst glauben, wenn Schalter-Einzelmessungen (nur A, nur B) oder ein
  gegabelter Lauf (bis zum Absprung-Tick abspielen, dann andere Eingabe) sie stützen — "Doppel-Anprall auf
  32-u-Treppen" und "Sehne statt Bogen an K2" waren beide falsch geraten.

## 102. Movement: Neue Boden-Zustände auf echtem Gelände fahren, nicht nur auf `flatWorld`

Alle Rutsch-Abnahmen liefen flach grün; im Spiel verließ die Rutsche nach 0.55 s über eine Mulde den Boden,
landete unter 280 u/s und durfte nicht neu starten (Duck-Walk bremste 270 → 85 u/s). **Richtig:** Rutsche
ohne Sprung geht bei der Landung weiter (`slideCarry`); nach einem Sprung nicht. Jeden neuen Boden-Zustand
über Kante/Mulde/Kuppe eines echten Levels fahren.

## 103. Movement: Asymmetrische Verzeihung auf periodischem Gelände ist eine Pumpe

"Bergauf kein Verlust + bergab Gewinn" erntete auf Wellen den Sprungimpuls: nur W + Leertaste 320 → 785 u/s
in 30 s. **Richtig:** den erlassenen Verlust stunden und vom nächsten Bergab-Gewinn abziehen (`slopeDebt`,
höchstens Tempo über Lauftempo) → einmal Gewinn, dann stabil. Nur die gewonnene Höhe stunden reicht nicht.
Überhöhte Kurven mit Drift nach außen stunden ebenfalls (L2-Ring +0.43 s für den perfekten Bot).

## 104. Movement: Jede Hilfe, die vel.y setzt oder Zustände meldet, gegen "Taste gedrückt, nichts passiert" prüfen

- Lip-Step im Steigen verschluckte Sprünge direkt vor Stufen (8 ms Luft). Nicht, solange der Rest-Aufstieg
  die Kante um ≥ 2 u selbst überragt (`LEDGE_RISE_CLEAR`), knapp vor dem Scheitel weiter fangen.
- Rutschen startete im ersten Bodentick der Lande-Gnade — jeder späte Crouch-Hop kratzte (slideStart/End)
  und wurde zugleich als clean gelobt. Physik- und gemeldeten Zustand trennen: `sliding`/'slideStart' erst mit
  dem ersten Reibungs-Tick. Weiterrutschen erzeugt ein zweites slideStart{boost:false} (Sfx ohne zweiten Whoosh).
- Die Physik schickt beim Slide-Hop [jump, slideEnd] — wer "keine Tricks beim Rutschen" vor dem Event setzt,
  schluckt jeden Slide-Hop (Hand: `sliding = false` beim jump).

## 105. Level-Regel: Treppen mit 32–40-u-Setzstufen und Kanten-Gedächtnis

Der Hop prallt an die übernächste Setzstufe, das Gedächtnis gibt 476 u/s noch im Steigen zurück, der
Scheitel reicht nicht über die nächste Stufe → zweiter Anprall (Treppe 32/192: +0.6 s bei jedem Anlauf).
Auftritt ≥ Hop-Weite beim Zieltempo oder Stufen ≤ 18 u. 24er und 48er Setzstufen gewinnen mit dem Assist.

## 106. V8: Builtins mit Kommazahlen allozieren im Tick-/Frame-Pfad (`Math.hypot`, `Number.isFinite`)

- `Math.hypot` wird nicht geinlinet, jedes Ergebnis geboxt: Arcade-Pass 424 → 621 B/Tick (fast alles hypot),
  Wand-Erkennung des StrafeJudge 57 B/Tick, `PropTricks.rotateLocal` 4–13 KiB/s. `Math.sqrt(x*x + z*z)`
  bleibt im Register (Judge 3.2 B/Tick). Schalter VOR der Längenrechnung prüfen (CS2 zahlte sonst mit).
  Die Source-Pfade behalten hypot (CS2 bitgleich; Rundung kippt chaotische Läufe, #72).
- `Number.isFinite(x)` auf Kommazahlen: `Rope.advance` blieb nach 150 s mit 6 KiB/s Top-Allokator (60
  Aufrufe/s laufen lange in Chromes Zwischenstufen, dort geht die Zahl geboxt in den Builtin). `x - x === 0`
  bzw. `!(dt > 0)` nach min/max — gleiche Semantik, kein Aufruf.

## 107. V8: Muster, die im Frame-Pfad Kommazahlen boxen (Chrome UND Node)

1. **Modul-`let`** mit Kommazahl (fk.ts): jede Zuweisung eine neue HeapNumber (Jo-Jo 16 KiB/s).
2. **Zweig um Kommazahl-Rechnung** / `cond ? kommazahl : 0`: am Zusammenfluss wird gemischt und geboxt →
   verzweigungsfrei rechnen (Faktor 0/1 multiplizieren).
3. **Kommazahl aus Array/Feld als Argument** eines nicht geinlineten Aufrufs (`fingerPoint(…, ANCHOR[1])`,
   `rotateView(o, ax, ay, az, angle)` durch vier Ebenen): Puffer/Objekt übergeben (`Rope.updateV`,
   `RopeDrive.setFrameFrom(inp)`, Achse/Winkel in `rq`), Ziele als Felder/Plätze.
4. **Smi-Startwert** eines Kommazahl-Felds (`z: 0`, `squash: 1`, `{ value: 0.6 }`-Uniforms teilen eine Map):
   mit Double-Startwert anlegen und danach setzen; Uniforms als `ScalarUniform` (vmMaterials).
5. **Große Frame-Methoden**: `ViewModel.apply` sprengte nach dem Registry-Umbau das Inlining-Budget, die
   three-Setter liefen als Aufrufe (17 Boxen/Frame, 10–16 KiB/s Dauer-Müll). Klein halten
   (`applyRig/applyItem/applySub/applyPoof`), three-Setter nur bei Änderung.
6. **Kleine schleifenlose Frame-Funktionen** (1 Aufruf/Frame) erreichen TurboFan erst nach Minuten; bis
   dahin boxt jede Kommazahl-Operation. Rechnung in früh optimierte Schleifen-Funktionen ziehen, selten
   laufende Pfade (FK der Wiege) aus dem Frame nehmen.
**Messen:** `alloc-probe --warmup 150` für Dauer-Müll (60 zeigt noch Tier-Anlauf, #65), isolierte
CDP-Probe (200 000 Frames) je Gegenstand, gegen einen HEAD-Export (`git archive HEAD | tar -x`, Junction
auf node_modules) mit denselben Tools. Allokation je Ereignis (Urteil ~200 B) ist erlaubt.

## 108. Shell/Patches: Heredocs, CRLF, Encoding (bestätigt #33/#63/#78)

- Heredocs mit Backticks, `„…“`, `'…'` oder Python-Triple-Quotes brechen in Git-Bash ("unexpected EOF") —
  Patch-Skripte mit dem Write-Tool als Datei anlegen, bei non-ASCII-Mustern `python -X utf8 skript.py`.
- Das Bash-Tool macht aus `\\n` in Heredocs `\n` — Stellen mit Zeilenumbruch mit dem Edit-Werkzeug ändern.
- Python-Textmodus auf Windows schreibt LF-Dateien als CRLF (git zeigt es mit autocrlf nicht). `open(p,
  encoding='utf-8', newline='')` für Lesen UND Schreiben, danach die CR-Zahl prüfen. Der Baum ist gemischt
  (src/engine/Game.ts, Menu.ts, Hud.ts CRLF; Tests/Doku LF) — das Edit-Werkzeug trifft beide.
- `str.index(muster)` findet das ERSTE Vorkommen: beim Verschieben eines CSS-Blocks landete ein Schnitt in
  einer gleichnamigen Regel innerhalb des verschobenen Blocks. Nach jedem Skript-Patch die Stelle ansehen.

## 109. three.js: Beim pixelgleichen Umbau ist die Material-REIHENFOLGE Teil des Bildes

three sortiert opake Objekte nach (groupOrder, renderOrder, material.id, z, object.id), ids sind globale
Zähler. Bei gleicher Tiefe (Deckel auf Dose, Hülle hinter Fläche) entscheidet die Bau-Reihenfolge. Der
Registry-Umbau blieb nur 252/252 pixelgleich, weil jeder Builder in exakt der alten Reihenfolge anlegt und
Neues lazy dahinter. Beweis deterministisch (`tools/cosmetics/vm-hash.mjs check` bzw. `viewmodel-sheet.mjs` mit `live`-Zellen über
dev/viewmodel.html; zwei Läufe byte-gleich),
nicht mit In-Game-Blättern (zwei Läufe desselben Codes: 29–42 Tsd. Pixel verschieden, #57).

## 110. View-Hand/Schnur: Framerate-Unabhängigkeit hängt an der ganzen Kette

- Scheinkraft aus der zweiten Differenz je Frame: der Sprung-Impuls wird eine Spitze über genau einen
  Frame, die 0.6-g-Kappe schneidet bei 30 Hz 33 ms ab → Pendel je Framerate anders (3.4/2.0 px). Anker je
  Frame als Position, in jedem 1/240-s-Unterschritt ein kritisch gedämpfter Folger (`RopeDrive`).
- HandMotion legte Event-Impulse vor den Federschritt (bei 30 Hz einen Frame zu früh) und Zustände über
  den ganzen Frame. Impulse nach dem Schritt (Warteschlange, `Spring.impulse(dv, age)`), Zustände mit den
  Eingaben vom Ende des LETZTEN Frames, das Blick-Delta sofort (Intervall-Maß; im Szenario als Integral über
  (t − dt, t]). Kette danach 1.13/0.92 px (Grenze 2.5/1.3).
- Moduswechsel geführt ↔ frei (Kendama-Kugel loslassen, Jo-Jo-Wurf-Ende) mitten im Frame: Frame an der Marke
  teilen (`updatePart`/`updateRest`), beim Wechsel frei → geführt an der Pendel-Lage ZUR MARKE starten.
- Verlet mit Abstands-Bedingung in beide Richtungen macht Schnur zu Stäben (chaotisch je Framerate): nur
  Dehnung korrigieren. `Rope.advance(0)` muss die Anker setzen.
- `surfSide` springt im ersten Frame nach dem Surf auf 0 (Lage ruckte, Kugel flog aus dem Becher) → beim
  Surfen merken, danach halten (`surfLean`). `writeRest` muss jeden Kanal setzen, den der Gegenstand
  besitzt (ungesetztes `o.rot` summierte das Nachwackeln).

## 111. Frame-Vergleiche: Phasen-Grenzen gehören nicht auf das gemeinsame Raster

0.1/0.25/0.75/1.0 s liegen auf 30/60/144/240/1440 Hz zugleich; welche Seite ein Frame nimmt, entscheidet
die Float-Summe von t (30 × 1/30 ≠ 0.1). **Richtig:** Grenzen daneben legen (Handy-Auslöser 0.76, Rauch
0.587) oder Zeitleisten stetig bauen; diskrete Kanäle eigens testen; `spin` modulo 2π vergleichen;
Plan-006-Stufen (Messer-Aerial 0.1 s) nicht umbauen, im Vergleich auslassen und zählen. Festgehaltene Tricks
können trotzdem kicken (Dose "crack" über `t >= 0.46 && !opened`) und dürfen Zustand nur beim Festhalten
(`at ≥ 0`) zurücksetzen. `Float32Array` speichert −0 (`toBe(0)` scheitert) — neutrale Kanäle mit `0`. Spinner-Aliasing ist absichtlich pro
Frame (höchstens 0.9 rad/Frame, darüber Unschärfe-Ring): dt-Tests dürfen `angle`/`blur` nicht vergleichen.

## 112. Kosmetik-Takt: die Definition entscheidet, nicht der Gegenstand

- Surf-Zustände (Spinner-Balance, Dose/Karte/Messer seit KI8) sind keine Tricks: das Band 25–45 % gilt als
  "Anteil an der Zeit OHNE Surf-Zustände" (Lead-Entscheid); roh fiel der Spinner auf L2 auf 20–24 %.
- `onEvent('speedMilestone')` fragte nur `free`, nicht die Abklingzeit → nach jedem Sprung-Trick ein
  Meilenstein-Trick (48–73 %). Lange Tricks prüfen die Abklingzeit in `onMilestone` selbst.
- Wer die Ziel-Belohnung garantiert, verschiebt den Takt (+2.6 Tricks/min bei 23-s-Läufen): kalibriert wurde
  MIT Ziel-Trick, event-probe zeigt beide Zahlen.
- Abwechslung messen statt raten: Breakaway aus den Listen genommen → Pass dominierte (46–63 %). Kennzahl
  "häufigster Trick an den Starts" (`topTrick`).
- Reine Surf-Level (L3) brauchen eine eigene Definition: dort ist in 78–86 % der Zeit Trick ODER Zustand
  sichtbar, der Trick-Anteil ohne Zustandszeit liegt aber bei 13–17 % (Vorschlag: Aktion 40–90 %,
  Trick-Band nur bei ≥ 40 % zustandsfreier Zeit — Lead-Frage).
- Ein Checkpoint vor einer Surf-Rampe: der Münz-`call` lief 0.8 s in den Surf hinein (Abdeckung 74 %). In der
  Luft/im Surf wartet er; am ZIEL darf nichts warten (#113).

## 113. Ziel-Belohnung bricht ab — am Frame-Ende, mit festem abklingendem Versatz

"Nie abbrechen" (Plan 006) war für die Ziel-Reaktion falsch: wer ins Ziel surfte, bekam kein Selfie (L1
sync 1.0: 0/15 Fotos). Das Ziel bricht jetzt Tricks, Zustände und die Rutsch-Sperre ab. Fallen dabei:
kürzestes Überblenden je Frame kippt, sobald der neue Trick schnell dreht (Messer sprang um π) → Versatz
EINMAL festhalten (Lage als Differenz-Drehung D = R_alt·R_neuᵀ) und abklingen lassen (Inertialisierung,
`XFADE` 0.25 s); Abbruch mit der Ausgabe des VORIGEN Frames ist framerate-abhängig → der alte Trick läuft
den Frame zu Ende, Ziel-Trick ab Trick-Zeit 0 (#77); zweite Körper genauso (freies Jo-Jo-Pendel rechnet den
Frame frei, geführte Kendama-Kugel bleibt geführt). Handy: Foto auch bei motionFx 0, `takeShutterNow()` wenn
das Ergebnis früher kommt.

## 114. Look/Hand: Lesbarkeit entsteht aus Muster, Größe und Kontrast — nicht aus Details

- Glanz je Vertex gestuft = Tarnflecken auf großen Flächen → Reflexion JE PIXEL, dann 3 harte Stufen.
- Tigerstreifen als Vertex-Farbe hängen an der Ring-Dichte und verschwimmen ("oranger Handschuh") → Muster
  im Fragment-Shader im Objektraum, Auswahl über ein je Teil KONSTANTES Attribut (`aTabby`), 0 Draw Calls.
- Fell: weiße Kegel = Zahnkranz, spitze = Stacheln, 1.3–2.5 u lange Büschel = "Krallen am Handgelenk".
  Fell-Saum aus vielen kurzen, stumpfen Zacken, Spitze DUNKLER als das Fell, flach zum Unterarm; das
  Merkmal "Krallen" gehört den Krallen (0.9 u Überstand, 0.4 u sieht man nicht).
- Weiße "Socke" als Unterarm las sich als Ärmel; Münze: zwei dunkle Motive auf Gold sind bei 14 px nicht zu
  trennen (Zahl = dunkles Feld, heller Blitz); Knöchel-Lauf nur mit zur Kamera gedrehter Faust.
- Eine 1-px-Schnur verschwindet vor dem weißen Handschuh → Schlagschatten 1 Low-Res-Pixel versetzt in
  Konturfarbe (+1 Draw Call), statt je Punkt die Farbe zu wechseln (Vertrag).
- Punkte, die von der Kamera WEG kippen, wandern in der Projektion zur Bildmitte (Bild-Hülle der Tricks):
  den Kreis vorn rechts kippen, links nicht nach hinten.
- Figuren ohne Physik bauen: die Jo-Jo-Wiege überblendet die 9 Schnurpunkte zwischen gerechneter Schnur
  und einer Figur aus Fingerspitzen (FK) — Anfang/Ende exakt, framerate-unabhängig, 0.9 u zur Kamera.

## 115. Render: Foto/Selfie ohne `preserveDrawingBuffer` und ohne Game anzufassen

`drawImage(webglCanvas)` liest im SELBEN Task nach `render()` den aktuellen Puffer; erst das Compositing
leert ihn. `snapshot()` rendert den Post-Pass einmal ohne HUD, kopiert, rendert mit HUD nach. Messen im
Spiel-Tab: `await import('/src/render/PS2Renderer.ts')` liefert dieselbe Modul-Instanz (Vite, gleiche URL);
Welt-Durchgänge nur um den Selfie-Aufruf zählen. Game ruft das Selfie NACH dem `render()` des Frames (Kamera
des letzten Bilds) — das HUD-Rechteck des Stempels erscheint erst im Frame danach (Werkzeug wartet darauf);
einen alten Auslöser vor dem Ziel-Event verwerfen (`takeShutter()` in finishRun).

## 116. In-Game-Werkzeuge: "kein Konsolenfehler" beweist nicht, dass das Spiel lief

`Game.setLevel` warf (fremder Strang), das Spiel zeigte das Menü mit Fehlerbanner, `pageerror` feuerte
nicht — `viewmodel-shots snapshot` meldete "ok" (Foto vom Titel, 0 Draw Calls). In-Game-Proben immer auf
ein Merkmal des laufenden Levels prüfen (Hand gezeichnet, Draw Calls > 0, Level-id).

## 117. Level: Chaotische Proben — erst ein dichtes Raster zeigt, ob ein Fix trägt oder Glück ist

M11 meldete L2 Ausfahrt 1/600 und S0 1/12. Ein Anlauf fand Grat-/Breiten-Kombinationen mit 0/600 — die
direkten Nachbarn hatten 1–38/600: Chaos, kein Fix. Dicht gefahren waren es 19/9243 bzw. 6/136. **Richtig:**
die Probe dichter fahren (Ausfahrt 2.5 u/s × 6 u, S0 1°-Schritte über ±90° × Leertaste × Shift × C), die
Tode per Ereignis-Trace nach Mechanik sortieren und die Geometrie so ändern, dass die Fehlerzahl MONOTON auf
0 fällt (S2 768/896/1024/1152: 20/6/0/0). Die dichten Raster gehören in den Validator, nicht in den
Scratchpad (Phase 2: S0 2184 Läufe, Ausfahrt-Rand ±160, Rutsche 2875 W-Halter mit Blickversatz und C).

## 118. Level: Box-Hulls stehen auf jeder konvexen Kante — Grate und Bandenoberkanten sind Absprungrampen

L2-S0: W-Halter landeten AUF dem Grat (Achs-Bevel) und sprangen über die Flanke, AUF der 32-u-Ostbande und
liefen hinaus, und hüpften durch einen Durchgang auf eine 64-u-Bande, die von oben erreichbar war. Eine nach
innen fallende Dachschräge hilft nicht (die Außenkante bekommt eine Bevel-Normale mit n.y ≈ 0.9, #41).
**Richtig:** Oberkanten für jede Flugbahn unerreichbar machen (Finne 128 u auf dem Grat; unsichtbarer
Spieler-Clip über der Bande) oder sicheren Boden dahinter. Eine Auffang-Grube ist nur dicht, wenn ihre
Banden von OBEN nicht zu erreichen sind. Eine Finnen-Stirn in der Bahn der Grat-Reiter ist eine Bonk-Wand
(62 Hänger) → ganz neben den Grat und als Keil (48 u lenkte zu stark: 10 Tode; 96–256 u: 0).

## 119. Look/Validator: Deko und Stücke an Fugen koplanar → versetzen

Finne mit Schnitten genau an den Stößen der Surf-Kette, L3-Pfosten genau auf der Gehrungsfuge des
Leuchtbalkens, T-Keile gleicher Dicke im Walm, eine Bodenplatte bündig mit Keil-Enden: jedes Mal
Z-Fighting (koplanare Stirnflächen). **Richtig:** Schnitte 16 u hinter die Stöße, Deko an Fugen 4 u zurück,
Dicken versetzen. Unsichtbare Clips mit Deko IN der Hülle sind validator-sauber (Deko-Check nur gegen
sichtbare Kollision). Deko unter schrägen Flächen per Hüllbox hängen (`testBox` in 1-u-Schritten), nicht
per Eckpunkten — an 14°-Stücken sind das ~20 u. Schräge Deko auf Flanken geht nicht: der Deko-Check testet
die AABB, `marking` zeichnet trims.ts nur bei n.y > 0.7 → Bögen über der Rampe statt Streifen.

## 120. Level: Knoten aus der Ballistik ableiten statt sie zu verschieben

Seit Cap 40 fliegt das untere L2-Band nach einem Hop 466 statt 424 u/s und landete ~60 u hinter dem ersten
Ring-Knoten auf der tieferen Innenbahn ("landet in Höhe 38 statt 49"). Radius schieben half nicht; der erste
Ring-Knoten sitzt jetzt dort, wo ein Hop mit dem Planungstempo aufsetzt (Schleife mit Abbruch-Fehler).

## 121. Level-Tempo: Im Takt des perfekten Strafers kostet Weg nur die Langsamen

Ein Hop je Plattform dauert ~0.755 s, egal wie schnell. Liegen Reihe und Kehre im perfekten Takt, gewinnt der
perfekte Bot dort nichts, aber jeder Langsamere läuft mehr Weg (L1 Hand 3° 30.5 → 38.1 s, Neuling W+Leertaste
CP1 → H7 14.4 → 19.7 s). Enger takten machte den perfekten Bot wieder chaotisch. **Richtig:** den Takt
behalten und die ANZAHL senken (4 statt 6 Reihen-Plattformen, 6 statt 7 Kehren-Pads → Neuling 13.7 s, ein
Zweig). Saubere Läufe des perfekten Bots sind Inseln im Parameterraum: an jedem Abschnitts-Eingang das echte
Tempo messen (Eintritt in den CP-Trigger, nicht die erste Landung) und den Abschnitt im perfekten Takt wachsen
lassen (`perfect(v, k)`); Kurz-Messungen (Nasen-Winkel 32°) sind Punkte im Chaos, kein Plateau.

## 122. Level-Proben: Zielzeit hinter einer Abkürzung misst Chaos — den Abschnitt messen

`expertIslands` verglich Zielzeiten; Slalom und Rutsche danach streuen ±5 s, das Vorzeichen der "Ersparnis"
war Zufall. **Richtig:** Spiel-Uhr CP2 → CP3 (der Abschnitt der Abkürzung), 12 Seeds, perfekter Bot ≥ 0 s.
Könner-Balken als gleich lange Hops entlang der Bahn statt fester Lücken (vorher Luftbremse vor jedem
zweiten). Selbst messende Level (L1 misst Plateau-Absprung, H7, CP3-Tempo beim Bau) brauchen einen
Drift-Bericht gegen die eingecheckte JSON (`reportDrift`, laut ab 16 u) — sonst verschiebt jedes
Movement-Tuning still Strecke, Medaillen und Ghosts.

## 123. Level-Proben: Blickmodell "nächster Knoten" misst Stau, nicht das Level

Auf dem L3-Auffang-Band liegt der nächste Türkis-Knoten oft direkt NEBEN einem an der Flanke: W drückt
senkrecht hinein, der Halter kriecht mit 0.1 u/s ins Zeitlimit (wie #73). Blick ≥ 320 u voraus = so schaut,
wer weiter will (24/24); das Modell "nächster Knoten" nur auf Tod prüfen, Staus im Bericht nennen.

## 124. Medaillen und Quoten: 8 Seeds sind zu wenig, wo eine Linie zwei Zeit-Moden hat

L3-Türkis: Fall aufs Band ja/nein kostet 2–4 s. Hand 3° Seeds 1–8 24.55 s, 48 Seeds 25.99 s → Bronze aus
8 Seeds schaffte die Bronze-Hand nur in 21/48 Läufen; die Gabel-Quote sprang zwischen Nachbarparametern
0.896 ↔ 0.925 (8 Seeds), über 24 blieb sie 0.847–0.867. **Richtig (Phase 3):** Bronze/Silber in build.ts als
Median über 48 Seeds (`MEDAL_SEEDS`), Design-Quoten über ≥ 24 Seeds, Probe "Medaillen-Stichprobe" (Anteil
der Läufe der Medaillen-Hand mit Medaille, Warnung < 50 %; L3 jetzt 22/24 bzw. 21/24). Die Freischalt-Leiter
war über 8 Seeds nicht monoton (1°-Hand auf L1 bimodal 22.05 ↔ 27.30 s), über 24 ja.

## 125. Level-Risiko: Hand-Modelle fallen von keiner Flanke — Risiko misst erst ein Aussetzer-Modell

RouteFollower mit Zielrauschen drückt dauerhaft in die Rampe; über 48 Seeds starben Hand 2°–5° auf keiner
L3-Linie. "Innen riskant" war unbelegt. **Richtig:** Aussetzer-Modell (A/D beim Surfen periodisch los,
`probes/level3.lapseRun`, Tode kosten Zeit wie im Spiel): 0.5 s alle 2 s → innen 22/48 mit Tod, außen 0/48.
16 Seeds brauchen ein Modell deutlich über der Schwelle (0.4 s: 4/16, über 48 nur 5/48). Risiko ist keine
Zeit-Abwägung: für jeden, der die Kurve hält, bleibt innen schneller (Lead-Frage).

## 126. Level-Proben ab Checkpoint: der Surfer fährt die Bahn, auf der der Spawn liegt

Der L3-Grundtechnik-Surfer [route] startete am CP-Spawn rechts vom gemeinsamen Grat und drückte in die
Flanke, auf der er landete — die "Koralle"-Zahlen waren Türkis-Fahrten (0 % der Luftticks links). **Richtig:**
auf dem ersten Surf-Knoten der Linie AUF IHRER SEITE starten und die Bahn mitmessen (Vorzeichen des
Querabstands zum nächsten Gratpunkt, Soll ≥ 90 %). Der Validator-Respawn-Surfer (`physics.respawnSurf`) hat
denselben blinden Fleck (offen).

## 127. Look: Scheiben, Marken und Deko gegen das HUD und im Spiel ansehen

- Der Tacho steht in der Bildmitte: eine Mondscheibe genau voraus lag im L3-Finale hinter der Tempo-Zahl
  (und im Südwesten am Kehren-Ausgang). Scheibe in eine Richtung legen, in die die Strecke nie blickt.
- Bodenmarken > ~30° neben der Blickachse und 120 u voraus liegen unter Showkeys (links) bzw. Hand (rechts);
  ~150 u voraus und ≤ ±25° bleiben frei.
- `sky.ts` färbte JEDE Scheibe warm (Blau × 0.55) — "Mondfarbe" aus Level-Daten ging nicht. Phase 3:
  `EnvironmentDef.moon` (Scheibe in sunColor, ohne Outrun-Streifen).
- Verwundene Hüllen-Dreiecke (L4-Grabensohle 26–33°) bekommen an jeder Fuge einen Trim → rotes Zickzack.
  Sohlen/Füllungen mit `trim: false`. Proben und Validator sehen keine Trims — jeden neuen Abschnitt einmal
  im Spiel ansehen.

## 128. Tests/Messung: Builder messen beim Bau, Browser misst mit VSync

- `buildLevel3()` misst zwei Surf-Raster (~11–19 s): ein Test, der Builder aufruft, braucht ein eigenes
  Timeout; Level-Tests lesen die gebaute JSON (< 1 s).
- Frame-Zeit über rAF-Abstände ist mit VSync bedeutungslos (16.7 ms). `--disable-frame-rate-limit
  --disable-gpu-vsync`, dazu die JS-Zeit im rAF-Callback. Level außerhalb des Index per
  `page.route('**/levels/index.json')` ergänzen (index.json bleibt unberührt).
- `buildLevel4({ measure: false })` setzt Surf-Tempi als Platzhalter — Tode in der Abfahrt sind dann
  Artefakte. Ungemessene Builds nur vor der Surf-Kette auswerten (gemessen kostet 0.5 s).

## 129. Wendel + Hang-Landung: Dreiecke mit 14° und 8° im Wechsel fressen Tempo

`Helix` zerlegt jedes Segment in zwei Dreiecke mit der Steigung der Innen- bzw. Außenkante (14.3°/8.1°).
Seit der Hang-Landung wird eine Bergauf-Landung auf dem steilen Dreieck ab ~650 u/s zum Rampslide: perfekter
Bot 28.78 statt 26.89 s. **Richtig:** radial teilen (Ringe), jede Linie liegt auf fast gleich steilen Stücken.
Nach jeder Änderung der Landephysik zusammengesetzte Flächen auf Steigungs-Sprünge entlang der Fahrlinie prüfen.

## 130. Crouch-Kante + gehaltene Leertaste = Phasen-Lotterie — ≥ 25 % Anprall ist Physik

Man springt dort ab, wo man landet; oben ist man bei Wandkontakt ≈ 0–0.56 s nach dem Absprung, frühen
Kontakt gibt das Gedächtnis zurück, späten nicht, ein Hop dauert 0.755 s → von einer flachen Terrasse prallen
≥ 25 % ab, egal wie schnell (L4-K2: der perfekte Bot 49/49). Längere Terrassen verschieben nur die Phase.
**Richtig:** eine ↑C-Absprungmarke (L1-H7, L4 beide Terrassen) und per Probe belegen, dass jeder Sprung aus
der Marke ohne Tempoverlust hochkommt; den teuren Anprall zählen (Warnung, Schwelle belegt wirksam); die
Kosten per **Gabelung** berichten, nicht als Differenz zweier Varianten (korrigiert, #164: "K2 40 u: −1.8 s" war
ein Vergleich zweier chaotischer Varianten — gegabelt an der Landung vor K2 sind es 0.46 s bis CP3). "≥ 95 % oben
in 4 s" sagt nichts über Tempo. Die Lotterie bleibt (25–38 % je Kante, Lead-Entscheid Phase 3: bewusst stehen
gelassen, Absprungband zweistufig #165).

## 131. Level: Zinnen quer zur Laufrichtung stoppen jeden seitlich Versetzten

Neben dem L4-Sprungbrett blieben 8/8 seitliche Anläufe an der Zinne stehen. Schrägwände als Trichter von der
Bande zum Brettrand (120 u) → 0/8; die Schräge endet genau am Brettrand, keine freie Bandenstirn in der Linie.

## 132. Bot-Vergleiche von Linien sind verzerrt, wenn eine Linie Gräben hat

Der RouteFollower springt nicht absichtlich in Gräben tiefer als `PREDICT_MAX_DROP` (64) — vor jedem Graben
Stop-and-Go, bis 1.6 s langsamer. Linien mit derselben einfachen Technik vergleichen (W + Leertaste, gleiche
Tempi/Phasen) plus eine Variante ohne Hindernis. Ergebnis L4: die Innenbahn lohnt nur bis ~450 u/s — kürzer
heißt bei gleicher Höhe steiler ("Vorsichts-Linie").

## 133. Banden, die Tod verhindern: 80 u halten seit dem Kanten-Assist nicht mehr

L4-Wendel/Steg hatten 80 u ("> Crouch-Jump 75"). Crouch-Jump + Assist reichen bis 80 u, am Hang trifft die
AABB-Hull eine Bande längs des Hangs mit der Talecke (−6 u), bergab fehlt zusätzlich die Hanghöhe: altes JSON
1310/5472 Läufe hinaus, am Steg bis 8 s freier Fall. **Richtig:** sichtbare Bande niedrig (Blick frei),
darüber ein unsichtbarer Clip deutlich höher als jede Reichweite (L4: 256 u; gemessen max 161 u Fußhöhe) mit
nach innen geneigtem Dach (n.y < 0.7 → weder Stehen noch Lip-Step) und dahinter ein Kill-Ring. Kill-Zonen am
Kreis aus AABB-Stücken ragen mit der Sehne nach innen → Oberkante unter die tiefste Bahn, beim Bau Abstand zu
jeder Etage prüfen (`safeKill`). Dieselbe Klasse an der L2-Ringbande (80 u): Flucht-Probe (Phase 3) 10/2898 Läufe
über die Bande, 1 auf ihr stehend → Clip bis 256 u mit geneigtem Dach: 0/0 (`designProbes.ringBoardEscape`,
Gegenprobe am alten JSON findet die 10). Wer durch die gewollten Öffnungen (Ausfahrt, Anflug) hinausfliegt, zählt
nicht — Austritts-Winkel mit den offenen Sektoren vergleichen, sonst meldet die Probe 300 Fehlalarme.

## 134. StrafeJudge: Gewinn bis zum letzten Luft-Tick — und Wand-Kontakt ist keine Technik

- Gewinn = Landetempo − Absprungtempo schenkte auf Gefällen Tempo (Hang-Landung): die Fehlerhand "A/D ohne
  Maus" bestand die T3-Linkskurve 5/20. Gewinn bis zum letzten Luft-Tick (prev im Lande-Tick) messen.
- 'weak' ("fast, flüssiger ziehen") traf fast nur Hops an Bande/Insel (T4: 44/44 mit Tempoverlust). Die
  Invariante freier Luft (Verschiebung = v_h·dt, v_h ändert sich nur entlang der wishdir) ab dem ERSTEN
  Luft-Tick prüfen (der Sprung-Tick ist ein AirMove), bei "nur W" die Luftlenkung beachten (dreht bei gleichem
  Betrag). 0 Falsch-Positive in 10 392 Landungen auf freiem Boden. Wand-Hops bekommen kein Urteil (außer 'good').
- Blick-Sprung: InputState verschiebt den Yaw nach 32 Umdrehungen um k·2π — dYaw wickeln, sonst urteilt der
  Judge einen normalen Hop als 'tooFast'.
- "StrafeBots 1–3° ≥ 90 % gut" hält für 3° nur bis 450 u/s (80 % bei 300–600): bei 600 u/s ist das
  Gewinnfenster (cap/|v| ≈ 2.7°) kleiner als der Zielfehler, die Fehl-Hops verlieren wirklich Tempo. Einen Hop,
  der 30 u/s kostet, "gut" zu nennen wäre gelogen → Warnung, keine Schwellen-Kosmetik (Lead-Abnahme). Diagnose-
  Quoten immer mit UND ohne 'good' im Nenner nennen.

## 135. Lektions-Zonen: achsparallele Quadrate sind auf der Diagonale unsichtbar großzügig

T5 mit 7 Toren und Quadrat-Zonen ±288 ergab 19/20 — eine Box ist quer zur Fahrt |cos φ| + |sin φ| mal so breit
(787 statt 576 u auf 30°/60°), Nachbarzonen überlappten. Mit ehrlichen Toren (Streifen durch das Torzentrum,
`t5.gateStrip`) nur 10/20; die Hand verfehlt das Tor nach dem ersten Knick — die Torzahl hilft, die Breite kaum
(5 Tore bei 576: 16/20). Zonen, die eine Linie meinen, als Streifen bauen und die ehrliche Breite messen.

## 136. Lektionen: der statische Validator findet, was die Bot-Matrix nie sieht

Alle Matrix-Zeilen grün, `levels:check -- training` meldete 48 Fehler: Z-Fighting (Keile gleicher Dicke im Walm,
Platte bündig mit Keil-Enden), Bodenmarkierungen müssen Parallelogramme sein, Zonen/Tore/Stufen teilen EINEN
id-Namensraum, die Route muss den Ziel-Trigger (Portal) berühren, Passbahnen fitten exakt auf den Landeknoten
(Landeknoten ~60 u hinter die Kante, Absprung passend). Nach jeder Geometrie-Änderung
`npm run levels:build -- training && npm run levels:check -- training`. Texte, die Zahlen nennen, aus den
Konstanten bauen und im Test gegen Aufgabe/Geometrie prüfen ("KANTEN À 76" bei einer 72er-Kante).

## 137. Vorführungen: im Spielmodus prüfen, mit der Technik der Stufe, bis zum Ziel

- check.ts ließ Vorführungen mit ZÄHLENDER Session laufen: die Stufe schloss, das Tunneltor ging auf, "3/3".
  Im Spiel (Taste H) ist die Session `suspended` — das Tor blieb zu, der Bot stand davor. Die Session wertet
  die Vorführung im Schatten aus (`demoPassed`) und öffnet die Tore NUR für sie; `check.runDemo` spielt wie
  Game (suspendiert, `seconds` lang, Routenende erreichen, Stand danach wiederhergestellt).
- Vorführungen liefen bis `DemoDef.seconds` weiter und prallten 51–64 % der Zeit gegen das Tor → Game
  beendet sie am Ziel ("SO GEHT'S!", nach 1 s zurück) oder nach 0.5 s Stillstand.
- Der RouteFollower ist kein Surf-Tempo-Modell (T8 nie über 800 u/s) → `SurfHand` (Taste in die Rampe, Blick
  entlang der Achse). Wer hüpft, rutscht nicht → vor niedriger Decke (1.5 s voraus) nicht mehr hüpfen, in
  0.35 s ducken; ein geschlossenes Tor ist keine Decke.
- Wo das HUD Urteile zeigt, darf die Vorführung nur gute Hops machen (T5 mit 3° Zielfehler: 6 × "RUHIGER").
- Behoben (Phase 3): `DemoDef.route.style` 'walk'/'hold', ohne style in Lektionen ohne Drehbalken 'jump' (#170).
  Weiter ohne Vorführung: 10 Bonus-/Meisterstufen (T1 flink/rinne, T2 kette20, T4 prestrafe, T5 bogen600, T6 fluss,
  T7 west/oben, T8 bonus/meister) — H meldet dort "keine Vorführung".

## 138. Lektionen laufen mit der Lehr-Config, nicht mit der des Spielers

Mit CS2-Preset gibt es kein Rutschen (T1 unmöglich → kein Stern → zwei Freischaltungen gesperrt), ohne
Auto-Hop ist "Leertaste halten" falsch und die Vorführung hüpfte einmal. `Training.lessonMovementConfig()`
(VELOCITY mit allen Hilfen) gilt ab dem Laden einer Lektion; Einstellungen/F1 in der Lektion werden gemerkt
und greifen danach (`playerConfig`). Gegenstück: `new Coach()` nahm strafeAssist = an; wer "Assist aus"
gespeichert hatte, bekam für "W in der Luft" die Diagnose "Maus weiter ziehen" — Konstruktor-Config ist Pflicht.

## 139. Lektions-Aufgaben: prüfen, was die Stufe lehrt — und was eine Fehlerhand trotzdem schafft

- T2 HALTEN (Kette ×6) bestand der Mausrad-Hämmerer auf der Stelle (40 u/s); den Meister "Kette ×20" schaffte
  W + Leertaste geradeaus. Absprünge unter 200 u/s zählen nicht; Meister = ganzer Slalom als `course`.
- T7 "10 s halten" war trivial (eine kriechende Grundtechnik-Hand braucht länger); T8 mit der T7-Referenzhand
  12/20 — ihr ging die Rampe aus, sie fiel nicht (14°/3000 statt 10°/2400: 20/20).
- Zonen zeichnet niemand: "durch die Marken" braucht sichtbare Geometrie (Bögen, #119).
- Pips einer Kette zeigen die LAUFENDE Kette (reißt sie, fallen sie); ein 'land'-Tipp ist ein Zustand (seit
  einer Landung ≥ after s am Boden), sonst kam "nicht stehen bleiben" mitten im Bhop; surfHold/surfSpeed:
  der Lücken-Zähler beginnt "nicht surfend" (∞), sonst galt der erste Luft-Tick als Surf.
- Eine Crouch-Hand bestimmte die nächste Wand über z und sprang oben erneut ab (12/20) — über die Höhe
  bestimmen (erste Wand, deren Oberkante über den Füßen liegt).

## 140. HUD: Text Glyphe für Glyphe ist teuer — vorrendern, je Popup eine eigene Kachel

Die Lektionskarte kostete +0.3–0.4 ms/Frame (`drawText` = ein drawImage je Glyphe). Karte und Demo-Band in
einen eigenen Canvas (`HudSprite`), nur bei Änderung neu (Vergleich per Wert, kein Key-String im Frame), mit
Rand für Kontur/Umlaute. Zwei verblassende Texte je Frame im selben Scratch-Canvas (Gain + Urteil) kosteten
+0.1 ms → je Popup-Slot eine Kachel, einmal deckend gerendert, danach drawImage mit globalAlpha. Ergebnis
+0.015 ± 0.005 ms. "Pixelgleich" für HUD-Umbauten: das HUD selbst treiben (`update(1/60)`, Events) und 17
Zustände × 2 Auflösungen hashen (34/34 gleich), nicht Screenshots vergleichen.

## 141. Messen unter der Uhr-Auflösung und mit Kacheln

`performance.now()` ist ohne Cross-Origin-Isolation auf ~0.1 ms vergröbert — Frame-Einzelwerte wie 0.005 ms
sind Quantisierungs-Mittel. Am Stück messen (`__vel.benchLesson`: 2·10⁴ Aufrufe), HUD-Mehrkosten als Median
aus 9 × benchHud mit Streuung, Abnahme als "+x ± y ms". Bei Kachel-Caches je Variante eine eigene Instanz, kurze
Blöcke reihum (sonst verwirft jeder Wechsel die Kacheln der anderen und GC trifft immer dieselbe Variante).
Urteil-Verzug per Zähler (`verdictSerial`/`verdictDrawn`), nicht "irgendein Popup sichtbar" (lebt 0.9 s, ein
Hop dauert 0.7 s — der Check prüfte nichts).

## 142. Gegen einen Vertrag bauen, dessen Umsetzung parallel entsteht

Game brauchte von der Lektion mehr als `TrainingSessionApi` (Tipps, Config, `demoPassed`). Statt die Klasse als
Typ zu nehmen (dann hängt Game an ihren Interna), eine lokale Schnittstelle `LessonSession extends
TrainingSessionApi { tip; setConfig; demoPassed }` — bricht die Umsetzung, meldet tsc genau diese Stellen.

## 143. Training-UI: Überspringen, Urteile, Werkzeug-Bots

- `skipStage()` meldet die übersprungene Stufe als normales `lessonStage` → HUD-Blitz, Akkord, Faust. Game fängt
  genau diese Ereignisse ab — als ZÄHLER: zweimal Überspringen vor einem Tick (Pause → Lock scheitert → zweiter
  Klick) feierte mit einem Boolean die zweite Stufe als "LEKTION GESCHAFFT!".
- Urteile nur, wo Strafen gelehrt wird (`hudLogic.stageJudges` = `turnBand() ≠ null`): in T1/T2 sah, wer genau
  "W + LEERTASTE HALTEN" tat, "+0 W LOS" und "SYNC 0 %" in Rot.
- Bots rutschen nie, DemoDef kennt nur hand|route: training-shots fährt Rutsch-, Prestrafe- und Boden-Kurs-
  Stufen skriptiert. "Ergebnis erschienen" ist kein Erfolg (Ersatz-Bot rollt ins Portal) — geschafft =
  `stageIndex` weiter, Zuordnung über `training().completed` (mit `demo({play:true})` spielt Game nach einer
  Stufe sofort die nächste Vorführung an).
- Der Dev-Server der Werkzeuge läuft ohne HMR: Quellen während eines langen Laufs ändern ist sicher, erst
  `page.reload()` holt den neuen Stand.

## 144. Integration: Medaillen, Index, Freischaltungen — eine Quelle, ein voller Build

Die Freischaltungen lesen die Medaillen aus `public/levels/index.json`, HUD und Ergebnis aus `<id>.json`.
`levels:build -- <id>` schreibt den Index nicht → bis zum vollen Build zeigte das Ergebnis "Silber", schaltete
das Jo-Jo aber nicht frei. **Richtig:** nach jedem Level-Bau ohne Filter `npm run levels:build`; der Test
"echte Level-Medaillen" prüft jetzt Index = Level-Datei für alle vier Level.

## 145. Integration: Polaroid und Layout — Überdeckung messen, nicht nur Scrollen

Das Polaroid neben der 96-px-Zeit schob in der 820-px-Spalte die Zeit UNTER das Bild ("00:15." lesbar) — der
Check "ohne Scrollen" war grün. **Richtig:** Überdeckung messen (Text-Breite per `Range.getBoundingClientRect`
gegen die Bild-Box) in 1920×1080, 1366×768, 1280×720; mit Foto ist das Ergebnis breiter (1120 px), in kleinen
Fenstern ×2 statt ×3 (ganzzahlig).

## 146. V8: die JIT-Stufe einer Frame-Funktion messen — nach 60 s ist es selten TurboFan

Chromium mit `--js-flags=--allow-natives-syntax`, Frames EINZELN getaktet (jeder Frame ein eigener Task über
`MessageChannel` wie rAF — eine Schleife in einem `evaluate` wird per OSR ein großer optimierter Block), dann
`%GetOptimizationStatus(fn)`. Bits dieser Version: `0x20001` nie kompiliert, `0x41` Ignition, `0x4001` Sparkplug,
`0x19` Maglev, `0x29` TurboFan. Nach 3600 Frames (= alloc-probe `--warmup 60`) war KEINE Hand-Funktion TurboFan:
`ViewModel.apply*`/`PropTricks.update` Maglev, Trick-Zeitleisten (Jo-Jo `cradle`, Kendama `cupCatch`) Sparkplug.
- Sparkplug boxt JEDE Kommazahl-Operation, Maglev nur an Aufruf-Grenzen und gemischten Zusammenflüssen. Die Stufe
  hängt am ausgeführten Anteil des eigenen Bytecodes → je Trick eine kleine Methode (Jo-Jo evaluate 4.6 → 0.3 KiB/s).
- Selten laufende Zeitleisten (Wiege) bleiben minutenlang Sparkplug (3.3 KiB/s nach 60 s, nach 150 s weg) —
  Stufen-Anlauf, keine Allokation im Code. **Nicht** synchron vorwärmen: machte es schlimmer (Deopts danach).
- Schnelle Probe statt 80 s im Spiel: ViewHand + ViewModel im Dev-Tab, 3600 getaktete Frames, dann 480 messen
  (`scratchpad/fx2-ci/handalloc.mjs`, trifft alloc-probe auf ±10 %; Stufen je Funktion `tier.mjs`).

## 147. three: Setter mit Kommazahl-Argumenten boxen in Maglev — `Euler.fromArray(tupel)` nicht

`rotation.set(x, y, z)` und `rotation.x = v` werden in Maglev nicht geinlinet, jedes Argument wird eine HeapNumber
(ViewModel.applyRig 8.4–9.6 KiB/s, applyItem 2 KiB/s nach 60 s), auch bei unveränderten Werten. **Richtig:**
Position/Skalierung direkt in die Vector3-Felder; Drehung über ein mit Kommazahlen angelegtes Tupel und
`rotation.fromArray(tupel)` (dieselben Felder, derselbe Callback, vm-hash 252/252), nur bei Änderung.
ViewModel.ts danach 0.0 KiB/s (vorher größter src-Allokator). Dazu `socketOf`/`socketPoint` über
`fromEulerXYZV`, Kendama-Kugel über `axisAngleQ` mit Winkel im Float64Array.

## 148. Belohnungen brechen ab — auch die Trainings-Stufe

Die Reaktion auf eine geschaffte Stufe lief mit Gegenstand als Checkpoint ohne Referenz — nur, wenn gerade nichts
lief; Dose/Karte/Messer hatten keinen Checkpoint-Haken (Reaktion in 0–4 % bzw. 73–88 % der Fälle). **Richtig:**
Stufe und Lektion nehmen den Weg des Ziels (#113: Abbruch am Frame-Ende + XFADE, Haken `onLesson(done)`, Priorität
Ziel > Lektion > Stufe) → 200/200 je Gegenstand. Ein "binnen 0.1 s"-Test braucht den Fall MIT laufendem
Leerlauf-Trick (≥ 2.2 s stehen), sonst prüft er den leichten Fall.

## 149. Einlagen im Surf-Zustand: Zeitleiste in Trick-Zeit, Enden an Einlagen koppeln

- Takt über die Trick-Zeit (Beginn exakt auf dem Takt), Auslöser (Kehre, Meilenstein) am Frame-Ende — dann ist alles
  framerate-unabhängig; Frame-Ende-Impulse exakt nachholen (`beatBegin()/beatEnd()` wie `mark()`, Alter über `lateness`).
- Ein Zustand darf nicht mitten in einer Einlage enden, deren Drehung nicht mit dem Zustand ausklingt (volle 2π →
  sonst Sprung auf 0): Ende erst bei `beatU ≥ 1`; alles, was mit dem Zustand ausblenden kann, × Hüllkurve.
- Diskrete Schwellen auf Kanälen, die eine Einlage bewegt (Flamme aus bei Deckel < 0.55), kippen je Framerate →
  stetig ausblenden. Kendama: endet der Surf im Hüpfer, erst landen, dann loslassen (sonst 20 px bei 30 Hz).
- Zustands-Ende auf dem gemeinsamen Raster (3.8 s liegt auf 30 UND 1440 Hz): welcher Frame es noch zeigt, entscheidet
  die Float-Summe (#111) — dort muss die Ausgabe schon der Ruhe gleichen. Test-Längen auf das 1/6-s-Raster legen.

## 150. Kosmetik-Takt und Abwechslung: messen, dann Regeln — Meilensteine brauchen die Abklingzeit

- `event-probe` endet mit Exit 1 bei Verstoß (Plan 007): 25–45 % der Zeit ohne Surf-Zustände und 20–32 Starts je
  Minute ohne Zustände OHNE Ziel-Trick (L1/L2), Surf-Abdeckung ≥ 80 %, kein Trick > 50 % der Starts (ab 20),
  Ziel-Reaktion und Foto in jedem Lauf; Plan-006-Gegenstände nur Warnung.
- Ein Trick je Stufe und Checkpoint = derselbe Trick ergab 55–100 % Anteil (Kendama bigCup, aroundJapan nie). Zwei
  Tricks je Stufe, Checkpoint/Meilenstein im Wechsel, gute Hops im Zyklus, Zähler je Stufe.
- Faustregel beim dauernd hüpfenden Bot: Anteil ≈ Dauer / (Dauer + Abklingzeit + halber Hop-Abstand). Meilensteine
  ohne Abklingzeit-Prüfung füllen jede Lücke (Jo-Jo L1 45.1 % — längere Abklingzeiten änderten nichts, bis
  `onMilestone` sie prüfte). Parallel umgebaute Level verschieben die Zahlen → Grenzen mit Abstand treffen.

## 151. WebGL: generische Attribut-Werte sind Kontext-Zustand, nicht VAO-Zustand

Ein Shader-Attribut ohne Array an der Geometrie liest den generischen Wert (`vertexAttrib*`). three setzt ihn aus
`material.defaultAttributeValues` nur beim AUFBAU eines VAO — Vorgaben am Material schützen also nicht; ein
fremdes Material (Vertex-Farben ohne color) konnte ihn auf 1 setzen (Katze: Handfläche 0.9 u zurückgezogen,
Halsband gestreift). **Richtig:** jede Geometrie, die mit dem Shader gezeichnet wird, trägt das Attribut
(`aClaw`/`aTabby` mit Nullen an jedem Katzen-Teil).

## 152. Look: Fell-Saum als Silhouette, nicht als Einzelkörper

14 Zacken-Körper ums Handgelenk lasen sich als Perlen-/Noppenreihe (jede mit eigener Kontur). Ein gezackter Ring in
der Bein-Geometrie (`Ring.fur`: jeder zweite Vertex weiter außen, Spitzen dunkler) gibt den Saum als Zickzack in
Fläche UND Kontur, mit weniger Dreiecken (Katze × Messer 8284 → 7772). Muster (Tigerstreifen) je Pixel im
Objektraum, nicht als Vertex-Farbe (#114).

## 153. Level: Slalom — weniger Inseln brechen die Lenk-Pflicht über die Rutsche

Sechs Slalom-Inseln im perfekten Takt kosteten jeden außer dem perfekten Bot 1.3–3 s. "4 Inseln" fiel durch, sobald
die Lenkprobe dicht lief: 1187/7020 Geradeaus-Hüpfer kamen durch (die alte Probe suchte `slalom5`/`slalom6` per
Name und brach ab). Mechanik: die Rutsche begann unter dem ANFANG der letzten Insel und fing jeden, der davor in die
Spalten-Lücke fiel. **Richtig:** Rutsche unter dem ENDE der letzten Insel, 5 Inseln (`SL_N`), Routen-Seite der
Rutsche folgt der Spalte der letzten Insel; Proben suchen Inseln über `slalomIslands()`, nicht per Name. Dicht
0/7020 (auch 0/13 995 bei 2.5 u/s); Hände 1°–3° 0.8–2.3 s schneller, perfekter Bot 20.27 → 19.48 s, ein Zweig.

## 154. Level: Abkürzungen im falschen Takt bremsen den Besten — und legen die Einstiegs-Phase fest

Die L1-Könner-Balken lagen im Takt von ~780 u/s; der perfekte Bot kam mit 952 u/s und bremste auf 681 (sonst Lücke),
an CP3 736 statt 1087 u/s, am Ziel 1.7 s langsamer, zwei Zweige — die Probe maß seit #122 nur CP2 → CP3.
**Richtig:** Balken im Takt des perfekten Strafers (3 Balken, Mitten 724 u ≈ seine Hop-Weite 726 u), den perfekten
Bot über die Start-Jitter an der ZIELZEIT messen (sein Median ist robust, nur Hand-Zielzeiten sind Chaos). Das Ende
der Balken-Bahn in der Wende (`CUT_END`) legt die Phase, mit der man in den getakteten Slalom kommt: Raster 192…448
→ 256–320 ein Zweig ohne Tod, ab 352 Tode, ab 416 Zweige; 288 gewählt. Einstiegs-Phasen aller Linien in einen
getakteten Abschnitt vergleichen (Landepunkt auf Insel 1 je Modell), nicht nur das Tempo.

## 155. Level-Proben: 5 Tempi oder 20-u/s-Schritte übersehen Streifen — dicht kostet Sekunden

Slalom-Lenkprobe 5 u/s × 8 u (7020 Läufe, 1.3 s) statt 5 Tempi × 16 u (115). L2-Ausfahrt-Rand 2.5 u/s (5676 Läufe,
~5 s) statt 20 u/s: der Todesstreifen lag bei 875–886 u/s, das alte Raster traf 880 nur an den überlebenden
Versätzen (Gegenprobe am alten JSON: 3/5676 → Fehler). Fix-Breiten monoton belegen (S2 1024/1056/1088/1152 →
9/3/0/0 Tode) — erst dann ist es kein Glück (#117).

## 156. L2-Kerbe S0-Flanke/E1-Westwand: kein Level-Ausweg ohne begehbaren Grat

Im Hänger (x 1200) hilft keine Eingabe (nichts/W/S/A/D/Leertaste/C/Blick ±90°: 0 u in 2.5 s), nur F. Jede Füllung
zwischen Flanke und Wand bildet wieder zwei Ebenen parallel zur Rampen-Achse (waagerechte Kante → Schweben);
ohne Kontakt zu beiden müsste die Wand ≳ 100 u vom Grat weg (heute 48; E1 schmaler bricht das Ausfahrt-Kernraster)
oder der Grat begehbar werden (15 neue S0-Tode). Bleibt Physik (#98): Wand-Tasche-Regel auf "Surf-Ebene +
senkrechte Wand, allFraction 0" ausdehnen. Validator warnt mit dem dichten Zähler (24/5676) — offen.

## 157. Level-Proben: Bots auf der Route prüfen die Route, nicht das Level

Alle L3-Abnahmen waren grün (Pad ≥ 64 u neben der Linie, W-Halter 24/24, VELOCITY < safeRoute), und doch lagen die
Checkpoint-Pads im Flugband von Menschen: die Bots fahren 240–320 u unter dem Grat, die Grundtechnik (Taste in die
Rampe, Blick entlang) höher, mit Blick-Verzug in der Kurve noch höher (CP2-Pad: 20/80 harte Stopps 1114 → 80 u/s).
**Richtig:** ein Mensch-Modell mitfahren (SurfRider + Blickversatz −3…+1° + Tiefpass-Verzug 0/0.1/0.2 s + AR(1),
vom Start, ab jedem Checkpoint, quer über die Einstiegsrampe) und als Fehler zählen: Pad-Kontakt, Einbruch > 30 % in
einem Tick (außer kurz vor einem Absturz), Stau auf dem Netz (`probes/level3.humanBand`, 584 Läufe, ~2 s).

## 158. Mess-Achse: die Rampe, nicht die Route — und die Übergabe Bot → Surfer

- `routeAxis` verbindet Surf-Knoten auf verschiedenen Tiefen: L3 W1 320 u → Viertel 1 240 u gibt ~20° Schräglage
  (Surfer bremst sich an der Bande bis zum Stillstand), L4-Abfahrt bis ~8° (Blick 0° war 1° neben der Rampe:
  Drop-In 137 statt 144/150). **Richtig:** Achse aus den Fugen-Querschnitten der Rampenstücke (`probes/level3.rampAxis`,
  L4 `descentAxis`) — so blickt ein Mensch.
- Übergabe an den Surfer "beim ersten Bodenkontakt nach CP4": in 3/7 Starts setzt der Bot nie auf (Hybrid = Bot);
  "beim CP-Eintritt": der Surfer erbt 9° Lenkwinkel und stirbt am Fuß. **Richtig:** erster Kontakt mit Boden ODER Flanke.

## 159. Alles auf dem Grat trifft, wer an den Grat klettert — und ohne etwas landet er auf dem Grat

Pad hinter die Landezone verschoben: immer noch 152 Kontakte (Koralle-Fahrer klettern in der konkaven Kurve an den
Grat). Pad weg, Bande mit Lücke: am Drop landet man auf dem nackten Grat (begehbarer Bevel, #118) und fliegt über die
Nachbarbahn, oder schlägt an der Stirn der wieder einsetzenden Bande an. **Richtig:** eine Bande ohne Lücke vom Start
bis zum Ende der Gabel, jede Folge-Bande 2 u weiter innen (Stirn verdeckt), die Checkpoint-Plattform schwebt DARÜBER
(Unterkante Bande + 8 u, hinter der Landezone des Drops; Trigger unverändert). L3: 392 → 0 Pad-Kontakte in 810 Läufen.

## 160. Drei Ebenen im konkaven Knick: Source nullt das Tempo — Sägezahn statt Knick

- Wer innen an einer gekrümmten Bande entlangfährt (Flanke + Facette a), trifft an jeder Gehrungsfuge Facette b im
  konkaven Winkel: drei Ebenen → `TryPlayerMove` setzt v = 0 (735 → 3 u/s). Ebenso die Außenbande eines Auffang-
  Bands: wo sie achsparallel läuft, fängt der Achsen-Bevel der nächsten Bank die Hull-Ecke (−92 %).
- `dropFrom` beginnt 96 u vor dem Ende und dreht die Kurve weiter: die erste Bank der Außenbande lag 1.51 u VOR der
  Innenfläche der vorigen, mit Stirn in Fahrtrichtung (943 → 0 u/s, unsichtbar, weil Clip).
**Richtig:** jedes Stück am Anfang ein paar u zurücksetzen (L3: Bande 10 u Sägezahn, erste Bank 8 u, Bänke 6 u) —
man verlässt eine Facette, bevor die nächste kommt; Test "Fuge a jeder Bank ≥ 2 u hinter der Innenfläche der
vorigen". Prüfen mit einem Gleiter-Sweep (Abstand 0.5–16 u × 300–1100 u/s × hüpfend/frei, `probes/level3.bankGlide`),
nicht mit zwei Stichproben: die Achsen-Falle zeigte sich nur an einer von drei Fugen.

## 161. Die Oberseite einer Bande ist eine Surf-Fläche — und ihre Unterkante eine Tasche

- 60° zur Flanke geneigt heißt n.y 0.5 → surfbar: nach dem 128-u-Drop (L3 W1 → Viertel 1) landete, wer an der Finne
  abhob, auf der Bandenoberseite und fuhr darauf → unsichtbarer Clip darüber in der Landezone (bis 248 u, s 0–640).
- lib-Bande endet 28 u unter dem Grat: bei 60°-Flanke liegt die Flanke 16–18 u neben dem Grat schon 28–31 u tiefer —
  die Unterkante schwebt 7–10 u über der Flanke, die schräge Hull-Ecke klemmt darunter (776 → 0) → Unterkante 12 u
  unter der Flanke (`railDepth`).

## 162. Nahtstopps sind chaotisch: selbst nachgebaut, verschwinden sie

Ein Surf-Raster-Nahtstopp (inner1a, 850 u/s, −90 u, +2°) kam in einer nachgebauten Schleife nicht wieder — sie
normierte die Startrichtung mit `Math.hypot` statt `Vector3.normalize()`, 1 ULP Unterschied. **Richtig:** mit
`surfGrid(level, {speeds:[v], laterals:[l], looksDeg:[g]})` selbst reproduzieren und die Geometrie so ändern, dass die
ganze Klasse verschwindet (Population statt Einzelfall, #117).

## 163. Medaillen am RouteFollower sind auf Surf-Maps zu weich — zweites Modell (Referenz)

Der RouteFollower strafet an jedem Surf-Drop in der Luft zum nächsten Knoten (−150–190 u/s) und drückt beim Surfen
entlang −n_h: bei fallender Achse zeigt das ~10 % gegen die Fahrt (10°: n_längs 0.088), jeder Druck bremst. L3:
Autor 17.29 s gegen Grundtechnik Koralle 11.6 s; L4 ab CP4 Bot 9.15 s, Surfer 6.13 s ("Hand 3° + einfach surfen"
unterbot Gold und VELOCITY). Die Route holte höchstens 1.3 s zurück; der naive Bot-Fix ("nur quer zur Fahrt drücken")
ließ den perfekten Bot auf L3 nicht mehr ins Ziel und machte L2 2.5 s schneller — kein Einzeiler. **Entschieden
(Phase 3):** `build.ts LevelEntry.reference` (`physics.MedalReference`), je Medaille zählt der schnellere Median aus
RouteFollower und Referenz; L3 `level3Reference` (Grundtechnik vom Brett Koralle, bester Blickversatz −3…+1°, 16
Seeds, nur Gold/VELOCITY/Autor), L4 `level4Reference` (Hybrid: Hand klettert als RouteFollower, surft ab dem ersten
Kontakt nach CP4 mit der Grundtechnik, alle Medaillen). Wächter: L3 `medalsVsHuman`, L4 `surfMedal` (Test).
Auf Surf-Abschnitten keine Knoten ohne `surf`, die der Bot "treffen" will (Sprungbrett-Knoten: S-Bremse, −1.1 s).
Die unlock-ladder rechnet ihre Spielertypen mit derselben Referenz.

## 164. Kosten eines Hindernisses per Gabelung, nicht per Varianten-Vergleich

"K2 = 40 u: −1.8 s" (#130) verglich zwei chaotische Varianten (dieselbe Review maß K1 = K2 = 40 u als +0.7 s).
Gabelung an genau der Landung vor K2, gleiche Geometrie, nur die Technik anders (Leertaste los + C, rutschen, im Band
springen): **0.46 s** bis CP3 über 49 Starts, robust über die Absprungstelle (0.42–0.48). Route-Knoten (Knoten ohne
Sprung auf der Terrasse, Crouch-Knoten 70–200 u) bringen den RouteFollower nicht zum Absprung im Band: er passiert
Knoten in der Luft und springt, wo er landet (K2 weiter 13/13).

## 165. Absprungmarken beim langsamsten realen Tempo messen — zweistufig

Die ↑C-Marke (Hull-Front 32–238 u) galt erst ab 450 u/s, die Probe begann dort. Bei 250 u/s ist ein Crouch-Jump nur
bei 16–104 u sauber, bei 700–950 u/s bei 32–≥ 280 u; langsam kommen genau die, die die Marke brauchen (Wiederholer
nach einem Anprall ~110 u/s, Neulinge ~320, Respawn). **Richtig:** durchgehendes Band im immer gültigen Bereich
(L4 Hull-Front 32–104 u: 240/240 bei 250–950 u/s), Streifen davor für "mit Tempo" (112–208 u: 150/150 ab 450),
Raster auf allen Radien der Bahn, Abstand senkrecht zur (radialen) Wand; Gegenprobe Band 120 u weiter weg findet
die Abpraller.

## 166. Gräben auf steilem Hang: der Hop ist tempo-unabhängig kurz und flach — keine Risiko-Wahl

Auf 12° bergauf ist ein Hop bei 450–900 u/s 230–263 u lang und hebt sich bei 800 u/s nur ~10 u über den Hang. 210–262
u breite Gräben trifft man fast immer; knapp daneben wirft die steigende Sohle hoch (800 → 517 u/s), eine senkrechte
Landekante lässt abprallen (800 → 100). Schmale Gräben, flache Gruben, Hop-Takt: saubere Läufe schneller, Fehlläufe
+1.4 bis +4 s — Lotterie, keine Wahl (L4-Innenbahn: "Vorsichts-Linie" mit Bernstein-Warnstreifen). Vor einer
Risiko-Linie auf einem Hang den Hop gegen den Hang rechnen (x = v(j − v·tanα)/(g/2)).

## 167. Bodenmarken auf verwundenen Hängen

Ein Parallelogramm liegt auf einer Helix-Fläche nie ganz auf (Wölbung bis ~0.7 u). Drei Ecken per lokalem Trace
(± 80 u — über E2 liegen weitere Etagen, ein Trace von oben traf die falsche), die vierte als Parallelogramm-
Ergänzung, dann so heben, dass die Mitte 0.35 u über der Fläche liegt (Validator: Mitte ± 0.5 u; Ecken −0.03…0.7 u).

## 168. Ein Fix deckt das nächste Problem auf — Population neu fahren, Tode je Abschnitt

Ohne Bandenlippe (#160) kamen die L3-Türkis-Bandfahrer, die vorher an der Fuge standen, bis R1 — und rutschten dort
am Westrand hinaus (167/405 Läufe nach CP3 tot; `r1Lateral` 120 hilft, braucht aber eine neue Abfahrt). Nach jedem
Fix die ganze Population neu fahren und Tode je Abschnitt berichten, nicht nur die Zahl, die der Fix senken sollte.

## 169. Lektionen: Fehlerhände mit schneller Maus prüfen — und die Technik vor dem Gewinn urteilen

Alle Fehlerhände liefen mit 60 °/s. Mit 180–360 °/s gewinnt "nur W + Maus" Tempo (Blick quer zur Fahrt = W-Strafe,
320 u/s: 360 °/s +66 u/s je Hop) und bestand T4 (20/20 in 8.5 s, schneller als der Anfänger mit A/D) und T5; der
Judge nannte dieselben Hops je nach Rate "W LOS" oder "GUT". Der **W-Lenker aus T2** bestand den T5-Bogen 20/20 ohne
einen Strafe. **Richtig:** Judge ohne A/D bzw. mit Maus gegen die Taste nie 'good' (Technik vor Gewinn); in
Strafe-Stufen (Lektion mit `hud.turnBand`) zählen Tempo und Tore nur mit A/D (≥ 25 % des Luftabschnitts), eine
Landung ohne A/D zählt nicht, reißt die Serie aber nicht; Matrix mit 180/360 °/s und dem W-Lenker, Diagnose
"streng" ('good' im Nenner = Fehler). Ordentlicher Anfänger unverändert (T4 20/20, T5 16/20).

## 170. Vorführungen: was die Showkeys zeigen, ist die Lektion

Der RouteFollower strafet immer (A/D 18–46 % der Ticks, bis 640 u/s) — auch in "NORMAL SPRINGEN" und "W HALTEN".
In Lektionen ohne Drehbalken spielt die Vorführung 'jump' (W + Sprint, Sprung an `jump`-Knoten, C in der Luft an
`crouch`-Knoten, Ducken vor Decken), T2 LENKEN `style: 'hold'`. Knoten hinter dem Stufen-Spawn überspringen, sonst
läuft sie erst zurück. Prüfen: A/D-Ticks und Höchsttempo bis zum Ziel (`check.demoTeachesStage`: 0 A/D, ≤ 390 u/s),
im Spiel die Showkeys ansehen.

## 171. Surf-Lektionen: Zielrauschen ist mittelwertfrei — der Neuling irrt systematisch

±3°-Rauschen bestand alles; ein fester Blickfehler an der Flanke zeigt das Toleranzband: T7 kriecht mit 4° in die
Rampe und hält trotzdem, fällt ab 6° hinab; T8 kippt schon bei 3–4° IN die Rampe (5/20, 0/20), hinab trägt bis 6°.
Der alte T8-Text "TIEFER AN DER FLANKE = SCHNELLER" lud zum häufigsten Fehler ein. `SurfHand.biasDeg` (+ = in die
Rampe) nur an der Flanke anlegen, nicht auf den Anlauf. Tipps nennen den Blick, nicht die Taste.

## 172. V8: seltene Pfade und Rückgaben über Aufrufgrenzen

- `StrafeJudge.contact()` läuft in T7 nur in wenigen Luft-Ticks: 60 × 6000 Ticks Aufwärmen reichten nicht (~290 B je
  Aufruf, #107.6); Surf-Abschnitte misst der Judge jetzt gar nicht, `jitWarmup` wärmt den Judge vor.
- `BeginnerHand.next`: Smi-Startwerte + `cond ? d : sign*step` → 29 B/Tick; Double-Start + min/max-Klemme → 12.6,
  Rest in Bot.ts (wrapAngle/mulberry32/gaussian geben Kommazahlen über Aufrufgrenzen zurück; nur Vorführung/Bots).
- Messen: je Fall einzeln UND gemischt, mit langem Aufwärmen; einzelne Fälle zeigen Tier-Anlauf, gemischte
  verdecken seltene Pfade (T7 allein 5 B/Tick in contact, gemischt 0).

## 173. Training-UI: was zu einer Stufe gehört, schaltet am 'lessonStage' um

- Der Coach-Tipp der alten Stufe blieb stehen und widersprach der neuen Karte ("JETZT: A HALTEN" unter "D HALTEN"):
  HUD verwirft ein Coach-Band bei 'lessonStage' (`Hud.dropCoachNotice`), Game zusätzlich beim Überspringen und bei
  "Lektion neu" (deren 'lessonStage' erreicht das HUD nicht, #143); die Session setzt in `enter()` die Tipp-Sperre
  zurück (sonst kam der erste Tipp der neuen Stufe erst 6 s nach dem alten).
- "5/5" war nie zu sehen: Zähler und Ziel stehen im Tick der Erfüllung schon auf der neuen Stufe. Das HUD merkt sich
  Ziel und Art aus dem zuletzt GEZEICHNETEN Frame und zeigt während STAGE_FLASH die volle Reihe; zwei Stufen im
  selben Frame (T4 HALTEN + BONUS 500): die erste feiern — Bonus 500 verlangt seither 3 Landungen in Folge.

## 174. Layout-Checks: "nicht gezeichnet" ist kein "frei"

`layoutOk` wertete w = 0 als frei und maß direkt nach der Titelkarte — Urteil 1/16, Coach-Band 0/16 gemessen, der
Bericht behauptete "16/16". Das Element erzwingen (W + A ohne Maus bis Urteil UND Urteils-Tipp im selben Frame),
w > 0 verlangen, mehrere Zeilenzahlen prüfen (pixelHeight 240/270/448 → bei 1080 px 216/270/360 Zeilen).

## 175. Rückmeldung, wo der Judge schweigt — Warnungen an dieselbe Bedingung wie das Urteil

Der StrafeJudge wertet Absprünge unter 200 u/s nie (`MIN_TAKEOFF`). Wer "IN DER LUFT: A HALTEN" wörtlich nahm, hüpfte
mit 40 u/s 20 s ohne Rückmeldung. HUD: in Stufen mit Urteil bei jedem Absprung unter MIN_TAKEOFF "ANLAUF MIT W" am
Gain-Popup (nicht in der Vorführung, kein Urteils-Zähler); T3-Text beginnt mit "W + LEERTASTE: ANLAUFEN". W blinkte
rot in der Luft, obwohl mit Strafe-Assist W dort nicht zählt und der Judge "GUT" sagte → nur ohne Assist (wie 'wHeld').
Ohne Sprint (Auto-Sprint aus, kein Shift) waren T1 RUTSCHEN und T4 PRESTRAFE unmöglich (250 < 280/350 u/s) →
Lektionen erzwingen Auto-Sprint (`Game`: `input.configure(binds, autoSprint || session)`); Shift hieße dort
"langsamer", die Texte sagen "VOLL ANLAUFEN".

## 176. Coach in normalen Leveln: W-Hüpfer erfuhren nie, dass es Strafen gibt

'wOnly'/'noSide' sind mit Luftlenkung legitim und zählen nicht als Fehler — ein W + Leertaste-Spieler bekam in L1
nie einen Strafe-Hinweis. Einmal je Sitzung ein Anstoß (`noStrafe`) nach 6 solchen Hops unter 400 u/s, ohne je gut
gestrafet zu haben: "SCHNELLER? IN DER LUFT A ODER D HALTEN / UND DIE MAUS MITZIEHEN · TRAINING T3" (L1: 5.4 s).
Bewusste Abweichung vom Entwurf (dort "W LOSLASSEN" als Fehler-Hinweis).

## 177. Werkzeug: Fenstergrößen, Debug-Felder, alternde Pixel-Baselines

- Menü in kleinen Fenstern: Scroll-Überlauf UND die Unterkante des Start-Knopfs messen (1280×720, 1366×768); eine
  `max-height`-Query, die Schrift verkleinert, darf die schmale Query (≤ 900 px) nicht überstimmen.
- `__vel.state()` hat `yawDeg`, nicht `yaw` — `undefined * π` ergab NaN-Blick (orange Fläche), ein Bild ohne Inhalt.
- Pixel-Baselines altern: die HUD-Hashes stammten von vor `hud.judge` ("normal-gain" wich ab, weil der Baseline-Code
  Gain-Popups in Lektionen unterdrückte); `shoot-render --fx` wich auf L1/L2 ab, weil die Basis älter als das
  Level-Retuning war. Vor einem Umbau die Baseline mit dem aktuellen Stand neu schreiben.

## 178. Crouch-Kanten-Lotterie: der Hebel ist das Kanten-Gedächtnis, nicht die Terrasse

Die Hop-Phase bleibt im freien Flug erhalten; mit gehaltener Leertaste ist jede Landung der nächste Absprung — die
letzte Absprungstelle vor der Wand ist über einen ganzen Hop verteilt. Geduckt sind die Füße nur 0.19–0.565 s nach dem
Absprung über Kante − Lip-Step, ein geduckter Hop dauert 0.81 s → ≥ 30 % später Kontakt (#130). Geometrie hilft nicht
(L4, 29.09.): Terrassen 25–50° 71–88/240 teure Anpraller; eine höhere Absprungfläche oder Leiste am Wandfuß trägt auch
ohne Ducken hinauf (63.5 u + Stufe > 66); eine Decke als Takt-Anker braucht ~2 u Kopffreiheit (13 Hops/s, Deckenstirn
= neuer Anprall). Der Hebel: das Gedächtnis zählt nur Luftzeit, der späte Anprall verbraucht seine 0.2 s im Fallen und
im Neu-Hop bis über die Kante. `crouchEdges` mit `ledgeMemory` 0.3/0.45/0.6 s: 55/11/3 statt 81/240, ohne Ducken weiter
0, Design-Proben L1–L4 bei 0.45 s unverändert. **Richtig:** bevor man Geometrie gegen eine Lotterie baut, die Config der
beteiligten Hilfe als Parameter derselben Probe durchmessen (kein src-Eingriff nötig) und den Befund dem Owner geben.

## 179. Gräben auf steilem Hang: die Tiefe ist der Kosten-Hebel — Rettung nicht am Bodenkontakt messen

Die L4-Gräben trifft man fast immer (#166); was es kostet, macht die Sohle, die bündig zur Landekante steigt: bei 72 u
26–33° steil (die Landung wirft hoch, 800 → 517 u/s), bei 24 u ~18°. W+Leertaste innen minus außen: 72 u bis +1.33 s
(Falle ab 450 u/s), 24 u −0.90…+0.19 s (Neuling innen, Strafer außen). "Rettung = am Boden hinter dem Graben" misst die
Hop-Phase mit: landet ein Hop 0.5° vor der Grenze, zählt erst der nächste (+0.6 s, 1.45 → 2.05 s). **Richtig:** "wieder
auf Bahnhöhe hinter dem Graben" (Boden oder Hop darüber) und dieselbe Strecke ohne Graben als Basis mitmessen (aus dem
Stand 1.45–1.55 s); Wahl-Proben mit einer Gegenprobe am alten Stand (`laneChoice`, 72 u muss als Falle auffallen).

## 180. Ein Netz braucht Checkpoint und Ausgang — und Erweiterungen dürfen nichts Bestehendes neu rechnen

- **Checkpoint quer übers Netz:** RunState zählt nur den NÄCHSTEN Checkpoint. Ein Auffang-Band neben dem CP-Trigger
  (L3: W1-Band, CP1 reichte nur bis zum Fuß) führt Bandfahrer an ihm vorbei — CP2, CP3 und Ziel zählen danach nie.
  Trigger bis über die Band-Außenkante ziehen (L3 CP1 −384…+768) und testen, dass das Band-Ende im Trigger liegt.
- **Den Ausgang des Netzes fahren:** Bandfahrer kommen schnell (1250–1640 u/s) und tief (Querlage 690 von 768) auf die
  gemeinsame Abfahrt; mit Blick weg von der Rampe drückt die Taste ab ~1000 u/s nicht mehr (asin(24/v)), sie driften
  hinaus. R1/Z breiter half nichts (91/216 tot), sie flogen am Fuß des Finale-Kickers vorbei — dort 2048 statt 1536:
  3–4/216. Erst den Trace eines Toten lesen, dann die Stelle ändern, an der er abfliegt.
- **Breiter bauen ist nicht bitgleich:** dieselbe Flankenebene aus anderen Eckpunkten ändert die letzte Stelle der
  Ebenengleichung; chaotische Läufe (#72) verschoben die 3°-Hand über 48 Seeds 25.99 → 26.02 s → Bronze 27.3 → 27.4,
  index.json veraltet, obwohl kein Lauf je an den Fuß kam. Stattdessen eine **Schürze** unter dem alten Fuß anhängen
  (Trapez je Stück, oberer Rand punktgleich mit dem Fuß, gleiche Ebene): alle Medaillen-Modelle bitgleich. Neue
  Brushes **hinten** an die Liste (vor `killTiles`, die sie kennen müssen): alle früheren Indizes bleiben.
- **Breite Einstiegsrampe vor schmaler Bahn ist eine Falle:** L3-W1 trägt links bis 384 u vom Grat, die Koralle-Bahn
  danach nur bis 192. Wer vom Spawn schräg um die Finne läuft (24–32°), landet bei −260…−300, hält die Taste richtig
  und fällt am Drop ins Leere (33/168 im Ziel). Startproben nicht nur geradeaus vom Brett fahren, sondern auch schräg
  (W + A!) — und eine Erweiterung, die das behebt, trägt oft auch eine schnellere Linie der Referenz (hier −3°:
  11.59 → 11.27 s): Medaillen neu bauen.

## 181. Lektionen: "gegen die Maus" gewinnt Tempo — rückwärts; und im Absprung-Tick ist die Maus nicht gemessen

A gehalten + Maus konstant nach rechts dreht die Flugrichtung nach hinten: man fliegt rückwärts und gewinnt Tempo
(T3-Arena ohne W: 1497 u/s in 40 s). Der Judge sagt zu Recht "FALSCHE SEITE" — aber T4 v400/HALTEN zählten Tempo und
Landungen nur nach A/D-Anteil: 5/5 bestanden in 3.2 s, jeder Hop "FALSCHE SEITE". Die A/D-Pflicht muss dieselbe
Bedingung prüfen wie das Urteil (Netto-Drehung nicht gegen die Taste). Falle dabei: im ersten Luft-Tick ist dYaw = 0,
"nicht dagegen" war dort immer wahr — der Rückwärts-Strafer zählte in jedem Absprung-Tick. Der laufende Abschnitt zählt
erst nach 0.1 s A/D (`SIDE_EVIDENCE`), davor der letzte; der Erklär-Tipp wartet ebenso (sonst "A/D fehlt" im
Absprung-Tick). Fehlerhände, die am Boden wieder nach vorn schauen (BeginnerHand 'gegen'), zeigen das nie — ein
Treiber, der den Fehler konsequent durchzieht (`drivers.backStrafe`), schon.

## 182. Vorführungen: der RouteFollower flackert — Strafe-Vorführung als Hand, die das nächste Tor ansteuert

Die T5-Vorführung (RouteFollower, 0.5° Zielfehler) wechselte A/D alle 0.03–0.1 s (1216 A/D-Ticks, ~20 Wechsel/s,
bis 940 u/s): gute Hops, aber die Showkeys flackern — nicht "KURVE = EINE SEITE HALTEN". Eine Demo-Hand mit Ziel = nächster
Knoten und FESTER Rate war chaotisch (Raster Rate × Reichweite: bestanden/verfehlt im Wechsel; bei 700+ u/s überzog sie
das Tor). Robust: Rate je Hop aus der Kursabweichung (einholen in 0.65 s, höchstens rateDeg, mindestens die Hälfte) —
alle Kombinationen 120–240 °/s × 300/400 u bestehen alle vier T5-Stufen in 14–16 s, 11 Wechsel in 15 s, im Bogen 75 % A.
Prüfen: `check.DEMO_MAX_FLIPS` (≤ 2.5 A/D-Wechsel je s) für Hand- und Routen-Vorführungen. Die 10 Stufen ohne
Vorführung aus #137 haben jetzt eine (PRESTRAFE: `PrestrafeHand` am Boden, die Stufe erkennt Training am DemoDef-Objekt),
außer T6 FLUSS: ohne A/D trifft kein Skript den Hop-Rhythmus vor drei Kanten verlässlich.

## 183. Tipps: jeder Tipp belegt die Tipp-Sperre — Zustands-Tipps an dieselbe Bedingung wie die Anleitung

- T3 "JETZT: A HALTEN, MAUS FLÜSSIG LINKS" ('air') kam auch beim Hüpfen ohne Anlauf (40 u/s) und sperrte den
  Anlauf-Tipp 6 s. In Stufen mit Urteil gilt 'air' erst nach einem Absprung ≥ MIN_TAKEOFF.
- "Surfend langsamer werden" als Blick-Diagnose (T8): "am Stück" feuerte bei 4° in die Rampe nur in 15/20 Läufen und
  erst nach ~16 s — Zielrauschen unterbrach jede Serie. Ausgleichender Zähler (+dt langsamer, −dt schneller, ab 0.4 s):
  20/20 nach ~6 s, Grundtechnik ±1°/±3° nie, 4° die Flanke hinab nie. Eine Regel "X u/s unter dem Höchsttempo" traf
  dagegen schon die Reaktionszeit am ersten Flankenkontakt (±3° ohne Fehler 6/20).
- Wer Shift aus Gewohnheit hält (Sprint in vielen Spielen), läuft mit Auto-Sprint 250 u/s — unter Rutschen (280) und
  Prestrafe (350). Game erzwingt Auto-Sprint, die Session erkennt "W ohne Sprint am Boden 0.75 s" in diesen Stufen.
- Browser-Probe mit festem Blick 4° in die T8-Rampe OHNE Rauschen: man klettert über den Grat und fällt (Grube-Tipp),
  statt langsamer zu werden — Diagnosen mit der Hand messen, die den Fehler realistisch macht (Rauschen + Reaktion).

## 184. Vorführung eines Luft-Kurses: ein fester Absprungpunkt geht nicht auf — die Hop-Phase planen

T6 FLUSS (drei 66er-Kanten in einem Zug, ≤ 0.25 s Boden, ≥ 250 u/s) hatte keine Vorführung: 'jump' läuft zwischen den
Kanten am Boden (Kurs von vorn), der RouteFollower strafet und schafft es nur mit Anläufen. Ein Skript "springen, wenn der
Rest nach dem Hop aufgeht, sonst weiterlaufen" mit FESTEM Absprungpunkt (140 u vor jeder Wand) scheitert an der
Geometrie: Landung oben → nächstes Ziel 437 u, bei 320 u/s = 1 Hop (241) + 196 u Laufen (> 2 × 0.2 s) oder 2 Hops − 45 u;
mit "so spät wie möglich springen" landete der letzte Hop 41 u vor der Wand — die Hull streift sie, Tempo kurz 0, und der
Kurs beginnt neu (< 200 u/s), obwohl man oben ankommt. **Richtig:** den Absprungpunkt je Kante im Fenster wandern lassen
(170…80 u vor der Wand) und je Bodenkontakt per kleiner Tiefensuche über die restlichen Kanten Zwischenhops + Absprung-
punkt wählen, Laufen gleichmäßig verteilen (`Training.FlowDemo`, Stil 'flow' für course + airborne ohne Drehbalken):
5.0 s, 0 A/D, max 0.2 s Boden, nie unter 320 u/s. Das Hochkommen-Band (20–180 u) ist nicht das Ohne-Wandkontakt-Band.

## 185. Seiten-Aufgaben: Taste UND Drehrichtung

"Maus gegen die Taste" prüft die Summe Σ −side·dYaw über den Hop. Ein gemischter Hop (A 60 % mit Maus langsam links,
dann D mit Maus schnell rechts) ist nicht 'against', überwiegend A — aber netto eine Rechtskurve, und er zählte in
LINKSKURVE. `HopReport.turnSide` (Netto-Yaw der A/D-Ticks) muss für left/right/alternate zur Taste passen; sonst Erklär-
Tipp "Maus in Tastenrichtung". Die Matrix (T3/T4) blieb unverändert — Hände und Demo-Hand strafen je Hop eine Seite.

## 186. Kosmetik: JIT-Rest ohne Allokation im Code nachweisen — `--trace-opt` über `DEBUG=pw:browser`

Nach `--warmup 60` standen Jo-Jo `cradle`/Kendama `cupCatch` noch mit 2–4 KiB/s in alloc-probe. Chromium mit
`--js-flags=--allow-natives-syntax --trace-opt --trace-deopt` und `DEBUG=pw:browser` gibt die Marken auf stderr:
die Zeitleisten wurden in 3600 getakteten Frames NIE zur Optimierung markiert (seltener Leerlauf-Trick, zu wenige
Aufrufe), kein Deopt-Kreislauf — Sparkplug boxt jede Kommazahl-Operation. Nach 9000 Frames: Jo-Jo 6.4 → 0.8 KiB/s.
Kein Code-Fix nötig (Vorwärmen verschlimmert es, #146); Code-Allokation erkennt man an Maglev-Funktionen in der Liste.
Takt-Grenzen driften mit Level-Umbauten: Münze L1 lag nach dem L1-Umbau bei 45.4 % / 32.6 pro min (Band 45/32) —
Abklingzeiten flip/roll 1.0/0.9, Meilenstein Stufe 2 = roll (sonst flip 52 % auf L2).

## 187. Training-UI: ein Tipp und der Stufenwechsel im selben Frame — Verwerfen allein reicht nicht

`Hud.dropCoachNotice` bei 'lessonStage' verwirft nur, was schon im Coach-Band STEHT. Fällt der Tipp der alten Stufe in
einem früheren Tick desselben Frames (bei 60 Hz ~2 Ticks je Frame), ist er beim Wechsel noch nicht angezeigt — Game
zeigt ihn danach in updateLesson (`tip.serial` hat sich geändert) unter der neuen Karte. Game merkt sich `tip.serial`
beim Stufenwechsel (`stageTipSerial`: 'lessonStage', Überspringen, Lektion neu) und zeigt nur Tipps mit höherer Nummer
(im Abschluss-Tick zeigt die Session selbst keinen Tipp mehr). Prüfen lässt es sich nicht mit `stepTicks(1)` + Überspringen
(stepTicks ruft onFrame — der Tipp steht dann schon und wird korrekt verworfen): erst Tick für Tick bis zum Wechsel zählen,
dann nach "Lektion neu" dieselben n Ticks in EINEM stepTicks(n). Gegenprobe ohne Fix: 3/3 alter Tipp sichtbar, mit: 0/3.

## 188. Luft-Hänger im Knick Flanke + Wand: ein ebener Boden ≥ Hull-Breite macht daraus einen Stand

L2-Kerbe S0-Ostflanke/E1-Westwand (#156): der Knick hat nur 10° Gefälle; ein Tick Schwerkraft schiebt die Hull entlang
des Knicks < DIST_EPSILON, jeder Bump endet mit fraction 0, `allFraction 0` nullt das Tempo — jeden Tick neu, kein
Aufbau. #156 ("kein Level-Ausweg") stimmte nur für Füllungen, die wieder zwei Ebenen bilden. **Richtig:** ein EBENER
Boden (Sims, `s0Notch`) am Grund der Kerbe, so hoch, dass zwischen Flanke und Wand ≥ 32 u bleiben (20 u unter dem First
→ 36 u): man landet, geht weiter, springt auf E1 (44 u) oder über den Grat. Das Ende ist ein Fenster, monoton belegt
(Tode/Hänger, dichtes Raster): bis an die E1-Kante hüpft, wer vorn landet, schräg über die Grube in den Tod (+64: 25/0,
0: 2/0), zu kurz hält die Kerbe davor wieder (−32: 0/1, −64: 0/6); −16…−24 frei. Ergebnis: Ausfahrt-Rand 0 Tode/0 Hänger in 39 259 Läufen,
Fall aus dem Stand in die Kerbe 80/594 → 1/1134 (mit Nordschub 4, alle in den letzten 20 u). Rest (Physik, #98): Finnen-Spitze an der S0-WESTflanke (x ≈ 1150,
Nordschub, 9/1134) und der Grat selbst, wenn man neben dem Vorfeld auf ihn fällt. Werkzeug: Hull an jeder Stelle mit
Tempo 0/−150/−300 fallen lassen, 3 s nichts drücken — findet Knicke, die kein Routen-Raster trifft.

## 189. Slalom-Umbauten auch ab dem Checkpoint-Stand messen — der Bot sieht die Geometrie voraus

L1-Phasen-Insel: Sperr-Finne in der Gegenspalte + Zunge (oder 16/20/25°-Nase) senkte die Einbrüche der Hände 1.5°/2° auf
~0 (48 Seeds, Lauf ab Start), aber ab dem CP3-Stand — also nach jedem Respawn — starben Hand 2°/3° 4–13/6–9 von 96
statt 2/1: die 32°-Nase wirft, wer von der Wende mittig über die Spaltenfuge hüpft, hoch und rettet ihn. Verworfen.
Zwei Mess-Fallen: (1) RouteFollower tastet die Welt voraus — ein Lauf weicht schon VOR der geänderten Stelle ab, einzelne
Tode wandern (Vergleich nur über Zählungen, ≥ 96 Seeds). (2) Hängen die Tode an einem Seed, der ab CP3 identisch
wiederholt (Respawn-Schleife bis zum Timeout), sieht das wie 30 Tode aus — Tode je Seed zählen, nicht je Respawn.

## 190. Medaillen: eine Referenz nur für die oberen Stufen macht die Leiter krumm — jede Stufe mit DERSELBEN Hand messen

L3 maß Gold/VELOCITY/Autor am Grundtechnik-Surfer, Bronze/Silber am RouteFollower, der an jedem Surf-Drop 150–190 u/s
verliert: Silber 25.1 → Gold 12.8 s (× 1.96), und die 3°-Hand holte in der Freischalt-Leiter über Koralle Silber (22.5 s).
**Richtig:** jedes Medaillen-Modell nimmt den schnelleren Median aus RouteFollower und Referenz mit SEINER Hand
(`physics.surfSigma`: Surf-Rauschen = aimNoiseDeg, gleiches AR(1) τ 0.15 s), und Leiter, Validator-Par und
Medaillen-Stichprobe rufen dieselbe Referenz. Drei Nebenfallen: (1) **Surfen verzeiht Rauschen** — mit bestem Blick
trennt die Referenz 3°- und 2°-Hand nur um 2.6 % (L3 Türkis 14.20/13.84 s); getrennt wird über das Wissen (Bronze Blick 0°
wie gelehrt, ab Silber der beste Versatz) plus Mindestabstand 4 % (`staggerMedals`, lockert nur die leichtere Stufe).
(2) **"Bester Blick" braucht eine Ziel-Quote** — der Median (Tod = langsamster) nahm bei 48 Seeds Koralle −3° mit 25/48 im
Ziel; ≥ 80 % (`REFERENCE_FINISH`). (3) **"Perfekt" nicht rauschfrei surfen** — über die 49 Start-Jitter starben 7/49
(Median 11.75 s, langsamer als die 1°-Hand); σ 1° ließ die 2°-Hand unter VELOCITY. σ 0.5° = beste Hand der Proben.
Und: Stichproben gleich groß halten — die Leiter mit 24 Seeds sah die 2°-Hand auf Koralle bei 12.09 s (VELOCITY),
build mit 48 bei 12.19 s (Gold); die Leiter nimmt jetzt `MEDAL_SEEDS`.

## 191. Median einer zweigeteilten Hand: der Medaillen-Abstand lügt

L1 1°-Hand über 48 Seeds: 15 Läufe 20.0–20.6 s, 33 Läufe 24.5–27.8 s (Einbruch CP1 → CP3 ohne Tod, Crouch-Kanten-Lotterie
#178), Median 24.81. Gold (1°-Hand × 1.05 = 26.1 s) → VELOCITY (19.8 s) sieht nach 31.8 % aus, für den Spieler mit
einer sauberen Runde sind es 1–4 %. Vor einem Abstand-Urteil die Verteilung ansehen (`timedMedian(...).runs`), nicht nur
den Median; bei zwei Moden ist die Stelle im Level (oder die Physik) der Hebel, nicht der Aufschlag. Ebenso: ein
Selbsttest-Fall, der an einer Stelle der Geometrie hängt ("Lücke ohne jump-Flag" am Slalom-Knoten), wird still stumpf,
wenn ein Strang dort Boden einzieht (slalom1Lip) — den Fall über den Knoten danach bauen und bei Umbauten mitprüfen.

## 192. Surf-Bots ohne Blickziel sind kein Mensch — Medaillen-Plausibilität über Blickfehler messen, nicht über "werkzeugfrei"

E2E-Review v2final: ein Browser-Surfer mit Blick aus der Surf-Normale kam auf L3 nie ins Ziel (nach CP3 nach außen
gedriftet), die Referenz mit `rampAxis` immer. Nachgemessen (Grundtechnik-Surfer, nur die Achse getauscht): (1) **Höhenlinie**
(waagrechte Tangente aus n): auf Rampen mit Achsgefälle liegt sie atan(n_axial/n_quer) neben der Achse — W1 6°, R1 8°,
auf dem steigenden Finale-Kicker andersherum; vom Brett 0–4/8 im Ziel, auf W1 bis zum Stillstand. (2) **Flugrichtung**
(Blick = v_h): kein Rückweg zur Linie, das Rauschen läuft als Irrfahrt weg, R1-Rand bei Querlage ±1200, ab CP3 1–2/16.
Mit Blick auf die Rampe (Achse) und festem Versatz −6…+12°, σ 3°, Verzug 0.4 s ab CP3 dagegen 12/12 je Versatz. Ein Mensch
sieht die Rampe; die Frage ist, wie genau er ihre Achse trifft. Deshalb prüft levels:check jetzt Blickfehler (L3: ab CP3
−6…+10° alle im Ziel; Bronze-Hand auf Türkis ±4°: 0° 15.1, +2° 16.3 s gegen Bronze 16.6; L4-Abfahrt ±4°: +2° 27.7, +4°
29.2 gegen 29.2) — L3 +2° liegt 2 % unter Bronze, das ist der Punkt für den S6-Playtest.

## 193. node_modules nach Worktree-Aufräumen halb gelöscht — aus dem npm-Cache zurückholen, nicht neu installieren

01.10.: `.bin`, `@fontsource/*`, `@jridgewell/*`, `@esbuild/win32-x64`, `@oxc-project/types` und die package.json der
Rolldown-Binding fehlten (alle um 01:51, zeitgleich mit dem Entfernen eines Prüf-Worktrees; die Binding-`.node` blieb,
weil der laufende `npm run dev` sie sperrte). Symptome: `npx tsx` "nicht gefunden", vite "Cannot find native binding",
tsc und vitest liefen noch. Ein `npm install` scheitert am gesperrten `.node` (Dev-Server läuft). **Reparatur ohne
Netz und ohne Versionswechsel:** je fehlendem Paket das Tarball aus `%LOCALAPPDATA%/npm-cache/_cacache/content-v2`
über den `integrity`-Hash der package-lock (Hash prüfen) mit `C:/Windows/System32/tar.exe` entpacken (Git-Bash-tar
deutet `C:` als Host), danach `npm rebuild --ignore-scripts --offline` für die `.bin`-Links. Nie einen Worktree mit
verlinktem node_modules per `rm -rf` wegräumen.

## 194. Lektions-HUD: der erste Hop aus dem Stand ist kein Fehler

Die Karte sagt "W + Leertaste", der Smart-Hop springt nach 0.2 s Stand — am Stufen-Spawn steht man meist schon so lange,
der erste Absprung kommt mit 0–40 u/s und bekam "ANLAUF MIT W", obwohl W gedrückt war (E2E-Review). Jetzt: der erste
Absprung nach Stufenstart/Respawn/Levelstart bekommt keinen Tadel (`Hud.standHop`), ein langsamer Absprung mit gehaltenem
W heißt "WEITER ANLAUFEN". Allgemein: ein Urteil prüfen gegen "was tut, wer die Karte wörtlich befolgt" (training-shots:
"Karte wörtlich").

## 195. Griff-Audit: Kontaktmessung braucht dichte Oberflächen-Abtastung und mehrere Kamerawinkel

Erste Messung (Mesh-Ecken + Dreiecks-Mitten gegen die Hand-Kapseln) meldete die Dose als "Finger 0.5 frei" — die Finger
steckten 1.3 cm drin: ein Dosen-Mantel hat nur Ringe an 5 Höhen, zwischen ihnen gab es keine Probe. **Richtig:** je
Dreieck ein baryzentrisches Raster ≤ 0.35 Einheiten (`tools/lib/handContact.ts`), Hand als HandShape (liegt auf ±0.25 am
Mesh, Test). Aus der Spielkamera sah fast jeder Griff gut aus; erst Seiten-/Unteransicht (`ViewModel.debugOrbit`,
`tools/hand-audit.mjs`) zeigte Daumen im Feuerzeug, Messergriffe quer durch die Faust und einen Daumen, der die Karte nie
berührte. Griffe immer aus ≥ 3 Winkeln UND als Zahl prüfen.

## 196. Finger-Kontakt: "bis zur ersten Berührung schließen" hängt an der Fingerspitze — Griffe per Gitter-Suche backen

Gemeinsames Beugen aller Gelenke bis zum ersten Kontakt stoppte an der Kuppe (Finger stand gestreckt an der Dose); Stufen
(erst Grundgelenk, dann Mittel-/Endgelenk) blieben stecken, weil die Wurzel des drehenden Glieds schon anlag; Rückwärts-
Extrapolation über die Start-Pose bog Mittelglieder in die Dose. **Richtig:** offen → zu interpolieren und zum Backen eine
Gitter-Suche über (Grund, Mittel, End) mit Kosten "jedes Glied liegt an, keins durchdringt, gleichmäßig gebeugt"
(`GripSolver.fit`); pro Frame reicht `close()` (Fang). Der Daumen dieses Rigs öffnet zur Handfläche hin — für Griffe
außerhalb seiner Bahn (Karte, Kniff) eigene Daumen-Suche.

## 197. Butterfly: wo der Kniff sitzt, entscheidet, ob der Trick überhaupt geht — erst die Hand in der Messer-Ebene kartieren

Mit dem Kniff nahe am Stift lag die Handfläche (Daumenballen) in der Messer-Ebene genau dort, wo der Bite Handle beim
Öffnen herunterschwingen muss — kein Flick und keine Physik-Suche fand einen Weg (Bite durch die Hand oder Griffe
überkreuzt). Gespiegelt schwang die Klinge durch die Handfläche; gekippt lag der Daumen im Weg. **Richtig:** vorher die
Hand in der Ebene abtasten (Raster: welcher Handteil liegt wo), dann den Griff wählen — Kniff am Griff-Ende, Messer
steht aus der Faust, die Schwungbahn ist frei. Zweite Falle: das 19-cm-Messer schwingt bis in die Bildmitte → Bühne
(Hand rückt während des Tricks nach rechts unten) und Bild-Hülle als Kosten in der Suche.

## 198. Physik in der mitbewegten Messer-Ebene — Projektion auf eine feste Ebene bricht bei Überschlägen

Erste Fassung projizierte Basis-Winkel, Stift-Beschleunigung und Schwerkraft auf die Ebene vom Trick-Start. Für Flicks um
Achsen AUS der Ebene (Handgelenk-Beugung ist nicht exakt die Messer-Normale) fehlten die Fliehkräfte, und ein Überschlag
(Rollover um den Zeigefinger) spiegelt die Ebene — die Projektion wird unbestimmt. **Richtig:** im Messer-Raum rechnen:
Drehrate um die Normale integrieren (θ), Beschleunigung/Schwerkraft in den aktuellen Achsen, Fliehkraft aus der
Drehung in der Ebene (|Ω_p|²r − Ω_p(Ω_p·r)) als Kraft am Schwerpunkt. Danach mussten alle abgestimmten Flicks neu
gesucht werden (Physik ist chaotisch: jede Modelländerung → `tools/knife-tune.ts` neu laufen lassen, mehrere Seeds
parallel). Energie-Test: halb-implizites Euler driftete 1.1 % in 2 s, Geschwindigkeits-Verlet hält < 1 %.

## 199. V8: Physik-Unterschritte boxen über Aufruf-Grenzen — Zeit und Punkte über Felder/Puffer, eine Motion-Klasse

KnifeSim erzeugte 290 Scavenges je 24 000 Frames (Node), alle aus 960-Hz-Unterschritten: `driver.base(t, …)`,
`frameAt(t − h, …)`, `hand.distance(x, y, z)`, `pointOf(link, lx, ly)` übergaben Kommazahlen an nicht geinlinete
Aufrufe; eine zweite KnifeMotion-Klasse (Aerial) machte `m.at(t, out)` polymorph und boxte erneut. **Richtig:** Zeit als
Feld (`chain.tEval`, `KnifeSim.tq`), Punkte/Kräfte über Float64Array-Puffer (`pointOfA`, `applyForceA`, `HandShape.measure`),
Kanäle aus base() in forces() wiederverwenden statt neu auswerten, EINE Motion-Klasse mit optionalen Teilen (Wurf als
`toss`). Danach 0 Scavenges in 24 000 Frames je Trick. Messen: `node --import tsx --trace-gc` und Scavenges zwischen zwei
Marken zählen; der Inspector-Sampling-Profiler mit "collected by minor GC" verfälschte die Optimierung (zeigte MB, wo
trace-gc 0 zählte).

## 200. Node-Allokationsprobe: console.log-Marken zählen den stdio-Puffer von --trace-gc, nicht die Scavenges

`--trace-gc` schreibt aus V8 über einen eigenen stdio-Puffer (an einer Pipe 4 KiB ≈ 24 Zeilen), `console.log` geht direkt
an den Stream. Scavenges "zwischen MARK_START und MARK_END" waren daher 0 oder ~24 (eine Puffer-Leerung fiel ins Fenster),
nie die echte Zahl: tossOpen meldete 24/25, ein Lauf später 1; yoyo aroundDouble 24 nach einer unbeteiligten Änderung.
Echte Zahl vorher: ALLE Würfe 4–5 je 12 000 Frames (Dose, Feuerzeug, Handy; ~150–500 B/Frame), die Probe sah es nicht.
**Richtig:** Marken im selben Strom — `--expose-gc`, `gc()` als Marke, zwischen den zwei `Mark-Compact … testing`-Zeilen
zählen (beide anim-*-Tests). Bytes direkt: `--max-semi-space-size=64 --min-semi-space-size=64`, Differenz von
`v8.getHeapSpaceStatistics()` new_space über das Fenster (Modul-`let` als Gegenprobe: 16.2 B/Frame). `PerformanceObserver('gc')`
allokiert selbst. Gefundene Boxer: (1) `Track.value` rief das Easing des Segments als `e(u)` — megamorph (sineInOut/quadIn/
quadOut/… je Segment), nie geinlinet, jede Rückgabe eine HeapNumber (~28 B je Aufruf) → bekannte Easings über eine
Kennzahl inline in `Track.evalInto(buf, ti, out, k)`, value() ist eine Hülle darüber; (2) `TossRig.eval` (7× value +
4× settleIn) — in Helfer zerlegt wurden die Helfer geinlinet und DARIN value/settleIn nicht mehr: Zeit/Parameter über
Puffer (tb, gp), settle-Formel inline; (3) `homogeneous(y0, v0, ω, ζ, h, out)` zu groß zum Inlinen (Grund 5 in
`--trace-turbo-inlining` = Bytecode-Limit), fünf Kommazahl-Argumente → Puffer (Feuerzeug-Flammennachlauf 80 B/Frame).
Ergebnis 250 → 68 B/Frame (tossOpen), Würfe allgemein ~50 B/Frame, alle Tricks 0 Scavenges; bitgleich (vm-hash 0 und
Bit-Hash aller ViewHand-Ausgaben × 65 Gegenstand/Trick gegen eine Vorher-Kopie, Gegenprobe mit 1e-15-Störung schlägt an).
