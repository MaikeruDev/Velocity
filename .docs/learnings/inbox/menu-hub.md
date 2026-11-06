# Learnings — Menü-Stil 'hub' (Plan 010)

- **shot.ts überfährt den ERSTEN `.vel-frontdoor button`.** Liegt davor ein unsichtbarer Knopf (projizierte Schilder mit
  `visibility: hidden`), läuft `locator.hover` 30 s in den Timeout. Reihenfolge im DOM: Karte (Starten) zuerst, Schilder
  danach; Stapelung per `z-index`.
- **Enter auf einem fokussierten Knopf ist kein 'confirm'.** Nach einem Mausklick auf Leiste/Schild behält der Knopf den
  Fokus → das nächste Enter klickt ihn nur erneut. Navigationsknöpfe nach dem Klick `blur()`en, dann geht Enter an
  `onAction('confirm')`.
- **Ziel-Lerp über 180° läuft durch die Kamera.** Kamerafahrt mit Blickwechsel nach hinten/vorne (Anflug) als Gier/Nick
  interpolieren, nicht als Zielpunkt-Lerp.
- **Deko in Blickrichtung prüfen, in ALLEN Seitenverhältnissen.** Die Plakatwand lag von den Rand-Stationen aus angeschnitten
  am Bildrand (16:9 hinter dem Konto-Chip, 32:9 sowieso) — Lösung: nur während des Anflugs sichtbar.
- **Quader verdecken ihr Inneres:** offener Spind = Quader ohne Vorderseite (Flächenmaske), sonst sieht man das Innenleben nie.
- **Canvas-Text in der Welt:** Silkscreen erst nach `document.fonts.load('700 32px Silkscreen')` neu rastern; Alpha
  schwellen (≥ 110 → 255) für harte Pixel; `getContext('2d', { willReadFrequently: true })`, sonst Konsolen-Warnung.
