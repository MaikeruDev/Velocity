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
