# Plan 006 — 3D-Viewmodel-Hand, Karte/Dose/Messer, neue Freischaltungen

**Stand:** 2026-09-28 · **Status:** umgesetzt (Gefühl mit echter Maus und Feinschliff der Posen offen)

## Problem

Nutzerwunsch 2026-09-28: die 2D-Sprite-Hand (Plan 004/005) komplett ersetzen durch eine Hand im
Stil der Referenzen `hand screens/` (8 PNGs): stilisierte Low-Poly-3D-Viewmodel-Hand, weißer
Handschuh, weiche graue Schattierung, dicke dunkle Kontur, pummelige Finger, Stulpe mit schwarzem
Band, hält eine Dose seitlich im Griff und kippt sie zum Trinken. Dazu Sammelkarte und
Butterfly-Messer mit tempoabhängigen Tricks, neue Freischaltungen, Live-3D-Vorschau im Menü.

## Entscheidungen

- **Echtes 3D im Renderer, nicht im HUD**: `RenderFx.viewModel` (ViewModelFrame) — PS2Renderer
  zeichnet nach der Welt ins selbe Low-Res-Target (Tiefe geleert, `autoClear` aus), eigene Szene,
  eigene Kamera vFOV 54° (≈ Source viewmodel_fov 68 bei 4:3). Damit treffen Dithering,
  Quantisierung, Fade und Blitz die Hand wie die Welt (Plan 004 hatte sie bewusst ausgenommen).
  Der Renderer ist "dumm": die UI (`ui/hand`, DOM-/three-frei) liefert Anker, Drehungen, 23
  Gelenkwinkel, Gegenstands-Transform und -Zustand; der Renderer setzt nur Transformationen.
- **Modell** (`render/viewmodel/vmGeometry`): alles aus elliptischen Röhren mit Kugelkappen,
  geteilte Normalen (Gouraud + Hülle). Handfläche, 4 Finger × 3 Glieder als Hierarchie (Grund-
  gelenk ZXY: Spreizen, Beugen), Daumen mit Sattelgelenk (Ruhe-Ausrichtung + Abspreizen/Opposition),
  Handgelenk (Beugen/Neigen/Drehen), Stulpe + Band am Unterarm (angeschnitten, läuft aus dem Bild).
- **Material** (`vmMaterials`): Vertex-Licht im View-Raum (Hemisphäre aus entsättigter Level-
  Umgebung, Schlüssellicht oben links mit Wrap, Rim in Trim-Farbe), kein Fog, kein Snapping.
  Kontur: Inverted Hull pixelgenau (Ableitung der Projektion, Chebyshev-Norm), plus Tinten-Kante
  für Innenlinien. Screen-Door-Auflösen (`uVis`) für den Karten-Zaubertrick.
- **Grundhaltung** (`VM_ARM_BASE` im Vertrag): aus einer Wunsch-Basis gerechnet und gegen die
  Referenzen iteriert (Kontaktblätter `shots/vm/s5…s10`): Daumen oben, Finger ins Bild nach links,
  Unterarm um 2.05 rad gedreht, damit die Finger ÜBER der Dosenfront liegen (vorher verschwanden
  sie hinter der Dose). Die UI leitet daraus "oben im Bild"/"zur Kamera" im Handraum ab (`ui/hand/rot`),
  damit Würfe im Bild nach oben fliegen.
- **Posen** (`ui/hand/poses`): relaxed, open, fist, run, grip, pinch, knife, thumbsUp, point, flat,
  crack — Gelenkwinkel in Grad, exponentiell überblendet (τ 0.035–0.08 s, Tricks wählen τ). Bei
  motionFx 0 springen Posen (keine Bewegung).
- **Bewegung** (`ui/hand/handMotion`): Plan-004-Animator übernommen (Bob über stridePhase, Sprung,
  Landung leicht bei Bhop, Maus-Sway, Wind ab 480 u/s, Ducken, Surf-Neigung, Respawn von unten,
  motionFx 0 statisch), ergänzt um 3D-Sway (yaw/pitch) und Sprung-/Landungs-Nicken.
- **Tricks** (`ui/hand/propTricks` + je Gegenstand): feste Zeitleisten über die Trick-Zeit
  (framerate-unabhängig, gemessen ~0.001 Abweichung 30 vs 1200 Hz), Impulse an Marken, Wackelfeder
  exakt gelöst, nie abgebrochen außer Respawn, Tempo-Stufen 300/500/800 u/s.
  - Dose: crack einmal pro Leben im ersten ruhigen Moment (spätestens nach 12 s Bodenzeit), Lasche
    als Hebel, Öffnung bleibt bis Respawn; Schluck nur offen und nur in Ruhe/ruhiger Landung; Flip,
    hoher Flip, Twirl, Doppel-Flip, Wurf hinter die Hand (Tiefe −8, die 3D-Hand verdeckt ihn echt).
  - Karte: Spin (Vorder-/Rückseite), turn (bleibt gewendet), tossSpin, Zaubertrick (Wisch → Dither-
    Auflösen + Poof → leere Hand → Poof + Wiedererscheinen mit Überschwinger).
  - Messer: Auf/Zu (Klinge + zweiter Griff an Stiften, Griff macht eine volle Runde), Rollover,
    Aerial/Doppel-Aerial (Fang wechselt offen/zu).
- **Freischaltungen**: L1-Gold → Neon, L1-VELOCITY → Karte, L2-VELOCITY → Dose, beide VELOCITY →
  Messer. `UnlockDef.requires` (Liste). Format v2 im selben Key; v1 migriert (Neon → + Karte, Neon +
  Dose → + Messer). Frische Freischaltung wird sofort angelegt (`unlockPatch`).
- **Menü-Vorschau**: `ViewModelPreview` — eigener kleiner WebGL-Kontext mit derselben Hand, PostPass
  (Dither, ohne CA/Streifen), Demo-Ablauf der Tempostufen; beim Verlassen `dispose()` +
  `forceContextLoss()` (Browser erlauben nur wenige Kontexte). Kein Kontext frei → Vorschau fehlt still.
- **Nicht gemacht**: Zisch-Sound beim crack (bräuchte ein neues GameEvent/AudioApi — nur das Flag
  `CanTricks.cracked` ist vorbereitet); Balancieren der Dose auf dem Finger beim Surf (Plan 005)
  ist entfallen.

## Verifikation

- `tests/viewHand.test.ts` (Bewegung dt-unabhängig, Grenzen bei 20 000 wilden Schritten inkl.
  Gelenke, NaN, motionFx 0 statisch + Posen springen, Posen-Folge, Überblenden, Bhop leicht,
  Sway/Wind/Respawn, Safe-Frame-Anker), `tests/cosmetics.test.ts` (Ableitung, v2, Migration v1,
  unlockAll/reset, Settings-Round-Trip, Tempo-Stufen je Gegenstand, crack genau einmal pro Leben,
  Lasche/Öffnung, Schluck nur in Ruhe, kein Abbruch, dt-Unabhängigkeit, NaN, Karte verschwindet &
  kommt zurück, Messer auf/zu/aerial, motionFx 0 statisch mit Gegenstand).
- `node tools/viewmodel-shots.mjs` (Port 5282): `shots/viewmodel/scenes-1920x1080.png`,
  `uw-*.png` (3840×1080), `hud-*.png`, `props-{can,card,knife}.png`, `live-*.png`, `compare.png`,
  `menu-*.png`, `finish-unlock.png`. `node tools/viewmodel-sheet.mjs` für Kacheln ohne Spiel.
- `npm run shot` (38/38), `npm run playtest` (0 Konsolenfehler, FPS Ø 60), alloc-probe Dauerbetrieb:
  Hand-Module nicht unter den Top-Allokateuren.

## Offen

- Gefühl mit echter Maus (Sway-Stärke, Häufigkeit der Tricks, ob der Schluck zu oft kommt).
- Luft-/Surf-Pose "open" steht recht groß und aufrecht rechts im Bild — mit echter Maus prüfen,
  ob sie beim Surfen stört; ggf. flacher/weiter außen.
- Innenlinien (Tinten-Kante) flackern bei Bewegung leicht (Schwelle auf interpolierten Normalen).
- Zisch-Sound beim crack.
