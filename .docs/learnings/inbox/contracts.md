# Inbox: Strang contracts (Plan 007, Phase 0)

Zusammenführen in `fallen.md` macht Phase 3. Befunde aus der Umsetzung; "(vorab)" = beim Lesen erkannt und
abgefangen, bevor es im Spiel auftrat — die übrigen sind wirklich passiert.

## Freischalt-Tabelle erweitern = Freischaltungen verteilen, die es noch nicht gibt (vorab)

Die neue Tabelle (Plan 007 §7) hängt Jo-Jo an L1-Silber, Feuerzeug an L2-Silber und die Skelett-Hand
an L2-Gold. Die gibt es heute schon — `UnlockStore.sync` hätte beim nächsten Start jedem mit L1-Silber
"FREIGESCHALTET: Jo-Jo" gemeldet und per `unlockPatch` einen Gegenstand angelegt, den noch niemand
zeichnet (leere Hand). **Richtig:** Tabelle als Vertrag komplett einführen, die Vergabe aber getrennt
schalten (`PENDING_UNLOCKS`: `deriveUnlocks` meldet, `sync`/`grantEarnedFor` vergeben nicht, Admin
kann alles). Die Menge leert der Integrationsschritt, wenn die Kosmetik existiert.

## `every()` über eine leere Liste ist erfüllt (vorab)

`TrainingRequirement` = "jede Lektion der Gruppe ≥ n Sterne". Ohne geladenen Lektions-Index ist die
Liste leer und `[].every(…)` = true → Spinner und Roboter wären ohne eine einzige Lektion frei.
**Richtig:** `lessons.length > 0 && lessons.every(…)`; Test mit leerer View.

## Pixelgleich für das Viewmodel: `viewmodel-sheet` mit `live`-Zellen, nicht `viewmodel-shots compare`

`compare` startet das echte Spiel und wartet in Echtzeit (2.6 s, Musik-Uhr) — nicht reproduzierbar
(bestätigt fallen.md #57). `tools/viewmodel-sheet.mjs` mit `live: {item, trick, at}`-Zellen fährt den
echten ViewHand-Controller festgehalten durch dev/viewmodel.html: zwei Läufe hintereinander ergaben
**byte-identische PNGs** (44 Kacheln). Damit ist "vorher/nachher pixelgleich" ein `cmp`. Für Fallbacks
("neuer Skin zeichnet wie classic") im Browser die Kachel-Canvases per `getImageData` hashen.

## Pflichtfeld in einem Event-Typ trifft auch Dev-Harnesses und Prototypen

`MovementEvent` 'jump' + `clean` brach 12 Literale: `src/audio/dev/*`, `src/ui/dev/fakeRun.ts`, die
Menü-Vorschau, drei Testdateien und zwei Prototyp-Kopien von PlayerMovement in `tools/critique/v2`.
tsc findet sie alle, weil `tools/**` im Include steht — deshalb den Prototyp-Ordner reparieren statt
ihn aus dem tsconfig zu nehmen (sonst verrotten die Referenzen unbemerkt).

## Node-ESM: absoluter Windows-Pfad im import braucht `file:///`

`import … from 'C:/Users/…/devServer.mjs'` in einem Scratch-Skript → `ERR_UNSUPPORTED_ESM_URL_SCHEME
(protocol 'c:')`. **Richtig:** `file:///C:/Users/…` oder relativ. (tsx schluckt den nackten Pfad.)

## `.gitignore`: ein ignoriertes Verzeichnis lässt sich nicht teilweise zurückholen (vorab)

`shots` + `!shots/v2/` wirkt nicht — Git steigt in ein ausgeschlossenes Verzeichnis gar nicht ab.
**Richtig:** `shots/*` und danach `!shots/v2/`. `*.log` greift darunter weiter (die drei
Varianten-Logs in `shots/v2/momentum` bleiben draußen).

## Vitest unter Last: "Failed to terminate forks worker … kill EPERM"

Einmal beim Lauf parallel zu `npm run sim`: Meldung, aber "18 passed / 329 passed"; zwei
Wiederholungen ohne Meldung. Kein Testfehler — Windows lässt den Worker-Kill gelegentlich nicht zu.
