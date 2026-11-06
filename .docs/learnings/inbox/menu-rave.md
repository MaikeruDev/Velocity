# Inbox: Menü-Stil 'rave' (Plan 010)

## backdrop-filter isoliert: mix-blend-mode im Kind sieht die Kulisse nicht

Xerox-Foto = Element mit `backdrop-filter: grayscale contrast` über dem Spiel-Canvas. Ein Kind mit `background: magenta;
mix-blend-mode: multiply` zum Einfärben ergab eine FLACHE Farbfläche: das backdrop-filter-Element ist eine eigene Blend-Gruppe,
das Kind mischt nur mit dessen (leerem) Inhalt. Einfärben direkt in der Filterkette: `… sepia(1) hue-rotate(268deg) saturate(3.2)`
(Magenta) bzw. `hue-rotate(140deg)` (Cyan).

## Tinte um ein backdrop-Fenster: box-shadow-Spread statt Fläche darunter

Ein deckender Hintergrund UNTER dem Fenster wäre genau das, was backdrop-filter dann sieht (Tinte statt Spiel). Lösung: das
Fenster unten in der Ebenenfolge, `box-shadow: 0 0 0 calc(100vw + 100vh) var(--ink)` deckt den Rest. Folge: das Fenster nie per
opacity ein-/ausblenden (sonst liegt die rohe Kulisse frei) — beim Intro deckt ein Kind-Deckel es auf.

## Button-Reset im Stil-CSS: in :where() setzen

`.vel-menu.vel-style--rave button { padding: 0; background: none }` leckte erst in alle Bestands-Screens (überstimmt `.vel-btn`),
auf `.rv button` eingeschränkt überstimmte es dann die eigenen `.rv-start`-Regeln (Spezifität 0,3,1 > 0,3,0). Mit
`:where(.vel-menu.vel-style--rave .rv button)` hat der Reset Spezifität 0 und jede Klassenregel gewinnt.

## Pseudo-Ebene hinter einem transformierten Knopf

`::before { z-index: -1 }` in einem Knopf mit `transform` liegt ÜBER dessen eigenem Hintergrund (transform = Stacking Context).
Fläche und Versatz-Schatten darum beide als Pseudo-Elemente (z -1 / z -2), der Knopf selbst ohne Hintergrund.

## Playwright page.evaluate mit tsx: "__name is not defined"

tsx/esbuild (keepNames) fügt `__name(...)` in Funktionen ein, die page.evaluate dann im Browser ohne Helfer ausführt. Abhilfe:
Funktionsrumpf als String übergeben (aus einer .js-Datei gelesen) statt als Pfeilfunktion.

## Ticker im Takt ohne JS pro Frame

WAAPI `track.animate()` mit n+1 Keyframes (je einer pro Beat, jeder mit Ease-out) läuft auf dem Compositor und ruckt pro Beat;
Phase per `anim.currentTime = (beat mod n) · beatMs` an ctx.beat() binden (beim Aufbau, beim Wechsel auf live, alle 8 Takte).
Nach Textänderung Klone + Animation neu (Breite ändert sich).
