# Inbox: Menü-Stil ps2 (Plan 010)

## Button-Reset im Stil-Scope schlägt die eigenen Komponenten-Regeln

`.vel-menu.vel-style--ps2 .vel-frontdoor--ps2 button { background: none; border: 0; padding: 0 }` hat Spezifität (0,3,1) —
höher als `.vel-menu.vel-style--ps2 .ps2-save` (0,3,0). Folge: Slots ohne Polster/Rahmen, nur `.is-selected` (0,4,0) bekam
Glas → genau der gewählte Slot verdeckte sein 3D-Symbol. Reset immer in `:where(...)` setzen, dann gewinnt jede Klassenregel.

## Glas über einem 3D-Anker verdeckt das Objekt

Der three.js-Canvas liegt UNTER dem DOM. Ein halbtransparentes Panel über einem Anker dunkelt das Objekt ab ("gewählte Disc
ist dunkel"). Symbol-Mulden ohne Füllung bauen (`linear-gradient(transparent 0 var(--well), glass var(--well))`).

## Anker erst messen, wenn das Layout steht

Logo-Canvas bekommt seine CSS-Größe erst nach dem Laden des Bilds, Schriften kommen später → Objekte saßen über den Labels.
Anker (getBoundingClientRect) einmal im nächsten rAF nachmessen (Flag), zusätzlich nach `document.fonts.ready` und Resize —
nie je Frame.

## LatheGeometry: Wicklung hängt an der Laufrichtung des Profils

Profil von oben nach unten → Normalen nach innen; im Vertex-Licht heißt das Rim = 1 überall (Pylon blau statt orange).
Vorzeichen des Volumens (Σ a·(b×c)) prüfen und ggf. Dreiecke umdrehen. Und: ein langer Mantel ohne Zwischenpunkte trägt nur
EIN Dreieck je Segment — Streifen je Dreieck brauchen Profilpunkte an den Streifengrenzen.

## Boot überspringen mit Enter darf nicht starten

Die Enter-Taste kommt zweimal an: keydown (überspringt) und im nächsten Frame `onAction('confirm')`. 350 ms Sperre nach dem
Überspringen, sonst springt Enter direkt in die nächste Aktion.

## Halo eines versteckten Objekts

Versteckte Objekte (Boot) bekommen keine Transformation; ein Halo, das ihrer `scale` folgt, wird bildschirmgroß. Fokus-Effekte
nur an sichtbare, aktualisierte Objekte hängen.

## Runde 2: Bestands-Screens ohne zweiten WebGL-Kontext

Die Front Door wird beim Verlassen des Titels abgebaut — ihre Welt kann hinter Training/Einstellungen nicht weiterlaufen.
Lösung: in `unmount()` (vor `dispose`) einmal nur die Hintergrund-Szene zeichnen und im selben Task `canvas.toDataURL()`
lesen (kein preserveDrawingBuffer nötig), dazu freigestellte 3D-Symbole per `readRenderTargetPixels` + CPU-Bayer. Alles als
CSS-Variablen am `.vel-menu`-Root; das Scoped-CSS nutzt sie als Hintergrund/Icons. Symbole nur einmal je Sitzung.

## `zoom` statt Neu-Bemaßen der klassischen Screens

`zoom: var(--k)` auf `.vel-screen` skaliert Layout und Schrift (16 → 24 px bleibt im 8-px-Raster). `calc(100% - 144px)`
im gezoomten Element ergibt sichtbar H − 144·k (Prozent bleibt visuell, px wird gezoomt). Pixel-Canvases darin (Hand-
Vorschau 150×176) neu bemaßen, damit Low-Res-Pixel × zoom ganzzahlig bleibt (300 px × 1.5 = 3×).

## Fester Knopf aus dem Scroll-Bereich

Den vorhandenen Zurück-Knopf (`.vel-btn:has(> .vel-kbd)`) per `position: fixed` als Prompt-Leiste unten mittig zeigen —
echter, klickbarer DOM-Knopf statt Pseudo-Element. `row-reverse` stellt die Esc-Kappe vor den Text.
