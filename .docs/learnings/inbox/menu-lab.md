# Inbox: Menü-Labor (Plan 010, Gerüst)

## Neue Einstellung verschiebt das Verifier-Bundle

`tools/online/build-function.mjs` bündelt `Settings.movementConfigFor` mit — ein neues Feld in `settingsTypes`/`sanitizeSettings`
(menuStyle) wird zwar weggeschüttelt, ändert aber esbuilds Minifier-Namen (z. B. `O1=8,D1=16` ↔ `D1=8,O1=16`). Inhaltlich
gleich, byteweise nicht → `tests/submitFunction` "Bundle veraltet". Prüfen: `tr ';,' '\n\n'` beider Bundles + diff — nur
Namen? Dann Bundle neu bauen, hochladen, index.ts deployen (Plan 009 §14), nicht den Test anfassen.

## `__vel.ready` ist true, bevor die Levelliste da ist

`installDebug` läuft vor `game.boot()`; `ready` sagt nur "Handle hängt". Playwright-Werkzeuge, die den Titel fotografieren,
warten zusätzlich auf `page.waitForLoadState('networkidle')` (index.json + Lektionen), sonst zeigt der Titel "lädt".

## Bestands-Screens blenden ein — Screenshot direkt nach waitForSelector ist leer

`.vel-screen` hat `animation: vel-in 160ms steps(4, end)` ab opacity 0. Gleich nach dem Erscheinen fotografiert = nur die
Kulisse. ≥ 200–300 ms warten. Und nach einem Klick (z. B. "Einstellungen") die Maus wegbewegen, bevor ein anderer Screen
fotografiert wird — sie überfährt sonst an derselben Stelle einen Knopf (:hover = gleiche Optik wie is-selected).

## Pointer Lock aus der Front Door: Enter geht, obwohl es im rAF ausgeführt wird

Engine-Aktionen (Enter → 'confirm') laufen erst im nächsten Frame durch `Menu.handleAction`, nicht im keydown-Handler.
`requestPointerLock` klappt trotzdem — die transiente User-Aktivierung hält einige Sekunden. Gemessen (Playwright, rave-Stub):
Klick auf Start und Enter → `gameState 'playing'`, `pointerLockElement` gesetzt. Nach einem await/Animationsende ist das nicht
garantiert; darum im Vertrag "play() synchron".
