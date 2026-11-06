# Inbox: Menü-Stil 'arcade' (Plan 010)

## `<button>` erbt die Schriftgröße nicht

Chrome setzt für Buttons `font: 13.333px …` (UA-Stylesheet). Wer Größen in `em` relativ zu einem Eltern-Element rechnet
(arcade: Bühne mit `font-size: 16·s px`), bekommt in Knöpfen 13.33 px → Silkscreen unscharf und skaliert nicht mit.
Fix: `font: inherit` am eigenen Knopf-Klasse. Fiel erst im 1080p-Bild auf (Karten wirkten "kleiner" als bei 720p).

## Silkscreen-Raster und Maßstab: s nur in 0.5er-Schritten

Bühne in em, `1em = 16·s px`, s ∈ {1, 1.5, 2, 2.5, 3, …} → 1em/2em/3em sind immer Vielfache von 8 px, und 0.125em
(1 Kunst-Pixel des Gehäuse-Canvas) ist ganzzahlig. Schriften also NUR 1/2/3/4em; 1.5em wäre bei s=1.5 36 px (unscharf).
720 → s=1, 1080 → 1.5, 1440 → 2, 2160 → 3 passen exakt (Bühne 720·s hoch).

## Räumliche Tasten-Navigation: Mittelpunkte reichen nicht

Nur "Mittelpunkt liegt in Richtung" + Abstand → die angehobene (translateY) gewählte Karte macht die Nachbarkarte
"darunter", und ein breiter Knopf oben (START) gilt als "rechts" von einem Menüpunkt darunter. Kandidat muss jenseits
der eigenen Kante liegen (Toleranz ¼ der Größe).

## Gehäuse-Canvas ÜBER dem Bildschirm-DOM

Rahmen mit ausgestanztem Röhren-Loch als Canvas oben drauf (pointer-events: none) statt clip-path am DOM: eine Form für
Rahmen, getreppte Ecken, Randschatten (Wölbung) und Glas-Reflex — Klicks gehen durch. Nur bei resize zeichnen.
