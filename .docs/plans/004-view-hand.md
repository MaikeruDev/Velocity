# Plan 004 — View-Hand (Cartoon-Handschuh)

**Stand:** 2026-09-28 · **Status:** abgelöst durch Plan 006 (3D-Viewmodel) — Bewegungslogik übernommen

## Problem

Nutzerwunsch 2026-09-28: bisher "kein Viewmodel". Jetzt eine leere rechte Hand im
Bild, Stil Mickey Mouse / 1930er Rubber-Hose (weißer Handschuh, dicke schwarze Kontur,
drei Nähte, gerollte Stulpe, vier dicke runde Finger inkl. Daumen). Sie soll das
Movement spiegeln (Sprung, Landung, Sway, Surf, Tempo) und darf weder Zielen noch
Lesen der nächsten Plattform stören.

## Entscheidungen

- **Zeichnen im HUD-Canvas, unter allen HUD-Elementen** (`Hud.underlay`), nicht als
  eigener Renderer-Layer: der HUD-Canvas ist bereits das Low-Res-Raster, wird nach
  der Quantisierung composited (feste Hand-Palette, nicht zerdithert — wie die
  Schrift), kein zweiter Textur-Upload, kein Eingriff in `RendererApi`. Speedometer
  und Timer liegen darüber. Preis: Respawn-Fade und CP-Blitz treffen die Hand nicht;
  dafür fährt sie beim Respawn von unten ein.
- **Prozedurale Pixel-Art** (`ui/viewHandSprite.ts`, DOM-frei): Posen aus Kapseln und
  Ellipsen in Gruppen; Kontur liegt außen an jeder Gruppe und über dahinterliegenden
  Gruppen, außer verschmolzenen (Finger ↔ Handrücken, sonst Querlinie am Fingeransatz).
  Schattierung per verschobener SDF-Probe (Licht oben links, zwei Grautöne), 1-px-Rim
  in Level-Trim-Farbe unten links. Kein Antialiasing.
- **Neigung und Squash werden neu gerastert**, nicht die Bitmap gedreht/skaliert (sonst
  zerfranst die 2-px-Kontur). Raster 2.5° × 0.03, Cache pro (Pose, Stufe) mit
  Obergrenze 160; höchstens ein neues Sprite pro Frame (~0.7 ms bei 270 Zeilen, 1.9 ms
  bei 448), sonst die nächste gecachte Stufe. Grundstellung aller Posen beim Levelstart.
- **Animator** (`ui/viewHandAnim.ts`, DOM-frei): gedämpfte Federn mit exakter
  geschlossener Lösung pro Frame (ζ 0.34–0.5 = Cartoon-Überschwinger), Glättungen
  per exp(−dt/τ) → framerate-unabhängig. Sway aus Blick-Delta/dt (tanh-gesättigt),
  Bob aus `stridePhase` × Bodentempo, Atmen im Stand, Luft: leicht oben, dann sinken,
  Fahrtwind ab 480 u/s (tiefer, außen, Vibration ≤ 0.55 % der Höhe), Ducken tiefer,
  Surf: Neigung/Versatz zur Rampe aus `dot(surfNormal, right)`.
- **Bhop nervt nicht**: Landungen werden einen Tick zurückgehalten (wie Kamera/Audio,
  fallen.md #54) — Hop-Landung 18 %, Kettensprung 30 % der vollen Stärke.
- **Posen**: offen (Stand/Gehen), Rennen (> 285 u/s am Boden, Hysterese 240), gespreizt
  (Luft; bleibt 0.1 s nach Bodenkontakt, damit Bhop nicht flackert), Surf, Daumen hoch
  (Ziel 2.4 s; perfekter Hop mit Gewinn, Kette ≥ 5, Sync ≥ 0.8 für 0.75 s, höchstens
  alle 12 s), Faust bei Checkpoint 0.6 s mit Pump.
- **Einstellung** `showHand` (Default an, Migration über `sanitizeSettings`), Bewegung
  × `motionFx` (0 = statisch). Unsichtbar in Titel/Pause/Ergebnis (HUD unsichtbar bzw.
  pausiert).

## Verifikation

- `tests/viewHand.test.ts`: dt-Unabhängigkeit (30/60/144/240 Hz gegen 1200 Hz),
  Grenzen bei 20 000 wilden Schritten, NaN/Infinity, motionFx 0 exakt statisch,
  Posen-Folge, Bhop-Landung leicht, Sway-/Wind-Richtung, Rasterizer in 224/270/448.
- `tests/settings.test.ts`: `showHand` Default, Migration, Round-Trip.
- `npx tsx tools/hand-sheet.ts 240 4` → `shots/hand/sheet-240.png` (alle Posen × Neigung/Squash).
- `node tools/hand-shots.mjs` (Port 5261) → `shots/hand/<szene>.png` + `-crop.png`.

## Offen

- Gefühl im echten Spiel mit Maus prüfen (Sway-Stärke `SWAY_X`, Bob-Amplitude) — die
  Shots zeigen Standbilder, nicht die Bewegung.
- Die Hand liegt über der Szene, bekommt also weder Fog noch Fade. Falls sie beim
  Respawn stört: Fade-Wert an `ViewHand` geben und die Hand ausblenden.
- Bei 4:3 und 224 Zeilen ist die Hand relativ breiter — Sichtprüfung dort offen.
