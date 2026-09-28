# Inbox: Strang training-ui (Plan 007, Phase 2)

Zusammenführen in `fallen.md` macht Phase 3.

## HUD-Text Glyphe für Glyphe ist teuer — vorrendern, nicht optimieren

`BitmapFont.drawText` zeichnet jede Glyphe mit einem eigenen `drawImage`. Die Lektionskarte (Titel 2×,
zwei Textzeilen, Hinweis, bis 12 Pips) kostete so **+0.3–0.4 ms je Frame** gegenüber der Timerzeile
(`__vel.benchHud`, 480×270). **Richtig:** die Karte in einen eigenen Canvas (`HudSprite` in Hud.ts) nur
bei Änderung zeichnen (Zähler, Blitz, Hinweis — Vergleich per Wert/String-Identität, kein Key-String
im Frame-Pfad) und sonst EIN `drawImage`. Rand um die Kachel (8 × UI-Skala): Akzentzeilen (Ü), Kontur
und Schatten ragen über das Band hinaus, sonst werden sie abgeschnitten.

## Zwei verblassende Texte im selben Frame = Scratch-Canvas zweimal beschreiben

`blitLineFaded` rendert jeden halbtransparenten Text in DENSELBEN Scratch-Canvas und kopiert ihn dann
mit `globalAlpha`. Ein Gain-Popup mit Urteil ("+23 GUT") sind zwei Texte → der Scratch wird im Frame
zweimal beschrieben, nachdem er schon Quelle eines `drawImage` war (Kopie des Snapshots): **+0.1 ms**,
obwohl ein normales Gain-Popup kaum etwas kostet. **Richtig:** je Popup-Slot eine eigene Kachel, beim
ersten Zeichnen voll deckend gerendert, danach nur noch `drawImage` mit `globalAlpha`.
Messung: Frame-Callback der Lektion vorher +0.41 ms (Phase-2-Erstlauf), jetzt **+0.020 ms**
(HUD +0.010, updateLesson 0.003, Session-Ticks 0.008).

## "Pixelgleich" für HUD-Umbauten: Zustände hashen, nicht Screenshots vergleichen

Das HUD ist deterministisch, wenn man es selbst treibt (`update(1/60)`, Ereignisse per `onEvent`).
Skript (`scratchpad/trui/hudprobe.mjs`): im Dev-Server `import('/src/ui/Hud.ts')`, 17 feste Zustände ×
2 Auflösungen (Pips, Pip-Pop, Blitz-Blinken, Balken, Rang, Demo-Band in beiden Farbphasen, alles
erledigt, Umlaute, normale Gain-Popups frisch/verblassend, zwei Urteile) → FNV-Hash je Canvas. Zwei
Läufe desselben Codes: identisch; vor/nach Karten- und Popup-Kacheln: **34/34 gleich**. Source-over in
eine leere Kachel und dann auf den leeren HUD-Canvas ergibt in Chrome dieselben Bytes wie direkt.

## Benchmarks mit Kacheln: je Variante eigene Instanz, kurze Blöcke reihum

Ein gemeinsames HUD für "normal / Lektion / Vorführung" verwirft bei jedem Variantenwechsel die
Kacheln der anderen, und lange Blöcke in fester Reihenfolge bekamen GC und GPU-Rückstau immer an
derselben Stelle ab (Lektion ohne Demo gemessen TEURER als mit Demo, reproduzierbar). **Richtig:** je
Variante ein eigenes `Hud`, Blöcke à 25 Frames, Reihenfolge je Runde rotiert.

## Gegen einen Vertrag bauen, dessen Umsetzung parallel entsteht

Game braucht von der Lektion mehr als `TrainingSessionApi`: Tipps im Moment und die Config
(Strafe-Assist → Urteil 'wHeld'). Statt die Klasse `TrainingSession` als Typ zu nehmen (dann hängt Game
an `stage`, `stageIndex`, `def`, … der Implementierung), eine lokale Schnittstelle
`LessonSession extends TrainingSessionApi { tip; setConfig }` — die aktive Stufe kommt aus
`LessonHud.stageIndex` + `LevelFile.training.stages`. Bricht training-core die zwei Extras, meldet tsc
genau diese zwei Stellen.

## Bots rutschen nie — Stufen ohne Vorführung brauchen im Werkzeug Ersatz-Bots

RouteFollower/StrafeBot ducken nur für Crouch-Jumps; eine Aufgabe `event: slideStart` (T1 RUTSCHEN)
oder `speed … ground` (Prestrafe) schafft kein vorhandener Bot, und `DemoDef` kennt nur `hand|route`.
`tools/training-shots.mjs` fährt solche Stufen skriptiert (Sprint → C; W + A + Maus 200 °/s) bzw. per
Zonen-Kurs mit Rutschen, sonst Routen-/Strafe-Bot sync 1, und nennt je Stufe, welcher Bot es war.
Stufen ohne eigene Vorführung sind für Neulinge eine Lücke (Taste H tut dort nichts) — Inhalt von
training-core, im Bericht als "ohne Vorführung" gelistet.

## Vorführung zählt nicht, spielt aber an — Stufen im Bericht über `completed` zuordnen

Mit `__vel.demo({play: true})` spielt Game nach einer geschafften Stufe sofort die Vorführung der
nächsten an. Eine kurze Stufe (T4 BONUS 500) war erledigt, bevor das Werkzeug wieder hinsah, und fehlte
im Bericht. **Richtig:** nach jeder Aktion die neuen Einträge von `training().completed` zuordnen.

## Dev-Server der Werkzeuge ohne HMR: Quellen ändern, während ein Lauf läuft, ist sicher

`tools/lib/devServer.mjs` startet Vite mit `hmr: false` — eine Seite lädt nicht neu, wenn sich eine
Datei ändert; erst ein `page.reload()` (Admin-Teil von training-shots) holt den neuen Stand. Längere
Playwright-Läufe blockieren die Arbeit am Code also nicht.

## Werkzeug: "Ergebnis erschienen" ist kein Erfolg der Stufe

Ein Ersatz-Bot, der eine Stufe verfehlt, rollt gern weiter ins Portal (Ziel-Trigger der Lektion) — sind
die Pflichtstufen erledigt, zeigt Game dann das Ergebnis. Das Werkzeug wertete `result !== null` als
"Stufe geschafft" und die folgende Meisterstufe tauchte als "nicht versucht" nirgends auf.
**Richtig:** geschafft = `stageIndex` ist weiter; Stufen, die nie drankamen, am Ende aus
`training().stages` nachtragen. Der Kurs-Bot bleibt nach der letzten Zone stehen.

## Überspringen ist kein "GESCHAFFT!"

`TrainingSession.skipStage()` meldet die übersprungene Stufe als ganz normales `lessonStage` (der
Vertrag hat kein Flag dafür) — HUD-Blitz, Akkord und Faust der Hand liefen auch beim Überspringen aus
dem Pause-Menü. Game weiß, dass es selbst übersprungen hat: das eine Ereignis des nächsten Ticks geht
nicht auf den Bus, nur die Buchführung (Fortschritt, Ergebnis nach der letzten Stufe) läuft.
