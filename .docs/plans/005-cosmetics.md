# Plan 005 — VELOCITY-Medaille, Freischaltungen, Kosmetik, Dose, Ultrawide

**Stand:** 2026-09-28 · **Status:** umgesetzt; Sprite-Dose und Unlock-Zuordnung abgelöst durch Plan 006

## Problem

Nutzerwünsche 2026-09-28:
1. Neue Top-Medaille **VELOCITY** pro Level — über Gold, für sehr gute Menschen erreichbar.
2. **Freischaltungen** aus Medaillen (persistiert, versioniert, nie verlierbar): VELOCITY auf
   L1 → Handschuh-Variante, VELOCITY auf L2 → Dose in der Hand. Sandbox zählt nicht.
3. **Kosmetik-Menü** im Titel mit gesperrten Einträgen und Live-Vorschau.
4. **Die Dose**: weiße Energy-Drink-Dose (kein Markenlogo) als Pixel-Art; die Hand macht
   Tricks, je schneller desto cooler.
5. **Ultrawide**: Hand und Showkeys auf 21:9/32:9 nicht mehr ganz außen.

## Entscheidungen

- **Medaille** (`LevelMedals.velocity`, Vertrag): sync 1.0 × 1.05, zwischen Gold (× 1.10)
  und Autor (× 1.0). Begründung und Messung in level-design.md Regel 10 (Hand-Modelle
  streuen zu stark). L1 23.4 s, L2 16.7 s. `author` bleibt im Format, ist aber keine
  Medaille mehr — das Ergebnis zeigt "Entwickler-Zeit geschlagen!". `MedalId` =
  velocity/gold/silver/bronze. Farbe: kein Metall, Neon — CSS-Schimmer Cyan/Magenta in
  harten Stufen, im HUD 2-Hz-Wechsel Cyan/Magenta.
- **HUD "Nächstes Ziel"**: `HudData.nextMedal` (Game setzt es beim Levelstart und im Ziel),
  klein in der Timerzeile hinter CP/PB in Medaillenfarbe; entfällt, solange dort der
  Ghost-Abstand steht (Zeile sonst zu voll).
- **Freischaltungen** (`engine/Unlocks.ts`): Store `velocity.unlocks.v1` = `{v: 1, unlocked:
  {id: ISO-Datum}}`. **Abgeleitet** aus Bestzeiten + Medaillen (`deriveUnlocks`), bei jedem
  Start und nach jedem Ziel nachgetragen (`sync` meldet nur neue). Ein verlorener Stand kostet
  also nichts; verdiente Freischaltungen bleiben auch bei strengeren Grenzen. Unbekannte
  Version/IDs fallen weg (die Ableitung holt Verdientes zurück). Neue Freischaltung wird
  sofort angelegt ("das ist der Belohnungsmoment") und im Ergebnis groß gezeigt.
- **Kosmetik in GameSettings** (`glove: 'classic'|'neon'`, `heldItem: 'none'|'can'`,
  Migration über `sanitizeSettings`). Die Wahl bleibt gespeichert, auch wenn gesperrt —
  Game/Menü zeigen dann den Standard (`applyCosmetics`/`effectiveCosmetics`).
- **Neon-Handschuh** statt Gold: dunkler Handschuh mit Cyan-Kontur und Magenta-Nähten,
  "Neon-Piping" wie die Trims der Welt — passt zur VELOCITY-Medaille (Neon, kein Metall).
  Nur Palette (`NEON_GLOVE_COLORS`), gleiche Formen; Rim bleibt die Level-Trim-Farbe.
- **Dose** (`ui/canSprite.ts`, DOM-frei): eigener Rasterizer — Zylinder mit Alu-Hals,
  Deckel mit Lasche, Bodenwulst, Schattierung nach Zylinder-Normale, Motiv neongrüner
  Zickzack-Blitz mit schwarzer Kante + zwei grüne Ringe (keine Kratzspuren — die wären dem
  echten Markenlogo zu nah). Perspektive: aufrecht sieht man den Deckel, kopfüber den Boden.
  72 Dreh- × 12 Twirl-Stufen, lazy gecacht (Twirl-0-Stufen beim Levelstart), bis 4 pro Frame
  (~0.1 ms je Stück). Kontur 1 px bis 300 Zeilen (die Dose ist nur ~18 px breit).
- **Halten**: neue Posen `hold` (Faust um die Dose, Daumen außen) und `point` (Zeigefinger
  hoch, zum Balancieren). Die Dose liegt HINTER dem Hand-Sprite am Griffpunkt `CAN_GRIP`
  (Faust-Wülste überdecken sie), transformiert mit derselben Neigung/demselben Squash wie das
  gerade gezeichnete Hand-Sprite (`designToSprite`) — auch beim Budget-Rückfall. Daumen hoch
  und Faust entfallen mit Dose (Checkpoint = Anstoßen-Pump, Ziel = großer Wurf).
- **Tricks** (`ui/canTricks.ts`, DOM-frei, allokationsfrei): feste Zeitleisten
  (Ausholen → Wurf → Flug → Fang → Nachwippen) als Funktion der Trick-Zeit →
  framerate-unabhängig; Impulse an die Hand (Abtauchen, Wurf, Fang-Squash) an Marken;
  Überschwinger per exakt gelöster Wackelfeder.
  - Stand/Gehen (< 300 u/s): Kippen, ab und zu Schütteln (alle 2.6–4.4 s).
  - Lauf (300–500): Flip bei Sprüngen (Abklingzeit 1.3 s).
  - Flow (500–800): hoher Flip, Twirl (Etikett dreht sich), Flip; perfekte Hops → hoher Flip/Twirl.
  - Overdrive (≥ 800): Doppel-Flip, Wurf mit Spin und Fang hinter dem Handrücken (steigend
    vor, fallend hinter der Hand), hoher Flip, Twirl; perfekte Hops → Doppel-Flip/Fang hinten.
  - Surf ≥ 800: Dose auf den Zeigefinger (balanceUp → balance), pendelt, Handneigung stößt
    sie an; Ende des Surfs (0.3 s) → zurück in die Faust (balanceDown).
  - Meilenstein: größter Trick der Stufe ohne Abklingzeit. Harte Landung: Wackeln.
  - Nie abgebrochen außer Respawn/Levelstart. motionFx 0: keine Tricks, Dose steht still;
    dazwischen volle Drehungen, Höhe × (0.6 + 0.4 · motionFx).
- **Safe-Frame** (`ui/safeFrame.ts`): Rand-Elemente hängen an einem zentrierten Rahmen mit
  max. **16:9** (1 % Toleranz). Warum nicht 18:9: die Hand ist an der Bildhöhe bemessen und
  auf 16:9 gegen Landepunkt/Bildmitte abgenommen; mit 16:9 bleibt ihr Abstand zur Mitte auf
  jedem breiteren Bild exakt derselbe — keine zweite, ungeprüfte Geometrie. Betroffen: Hand
  (unten rechts), Showkeys (unten links). Timer, Speedometer, Splits, Hinweise, Intro- und
  Ziel-Band sind zentriert (Bänder sind Bildbreiten-Anteile und dürfen breit sein).
- **Kosmetik-Menü**: Titel → "Kosmetik". Handschuh (Standard/Neon) und "In der Hand"
  (Nichts/Dose); gesperrt = gestrichelt, Schloss, Bedingung in Gold ("VELOCITY-Medaille in
  02 SCHLEIFE (16.70 s)"). Live-Vorschau: eigene `ViewHand` in 150×176 Low-Res (×3 CSS),
  Demo-Ablauf Stand → Lauf → Flow → Overdrive → Surf (je 5.5 s). Ergebnis-Banner zeigt die
  frische Freischaltung mit kompakter Vorschau (nur Stand).
- **Debug**: `__vel.unlockAll()`, `__vel.resetUnlocks()` (sperrt bis zum Neuladen gegen die
  Ableitung), `__vel.unlocks()`, `__vel.canTrick(name, at?)` (Trick-Phase festhalten),
  `__vel.hand()` mit `glove`, `item`, `rastered`, `can {trick, x, y, angle, twirl, drawn}`.

## Verifikation

- `tests/cosmetics.test.ts`: Ableitung aus Medaillen (Gold reicht nicht, Sandbox nie),
  Persistenz/Version/kaputter Speicher, "verdient bleibt", unlockAll/reset, Settings-Migration
  und Round-Trip, Safe-Frame bei 4:3/16:10/16:9/21:9/32:9 (Abstand zur Mitte = 16:9),
  Trick-Stufen nach Tempo, kein Abbruch, Flips landen aufrecht + Fang-Squash, dt-Unabhängigkeit
  (30/60/144/240 gegen 1200 Hz), 20 000 wilde Schritte ohne NaN, Surf-Balance rein/raus,
  Leerlauf-Tricks, motionFx 0 statisch, Halte-Pose statt Daumen, Dosen-Raster in 224/270/448.
- `tests/ghost.test.ts`, `tests/levels.test.ts`: Reihenfolge bronze > silver > gold > velocity ≥ author.
- `npx tsx tools/can-sheet.ts 270 4` → `shots/cosmetics/can-sheet-270.png` (ohne Browser).
- `node tools/cosmetics-shots.mjs [filter]` (Port 5272, `COSM_PORT`): HUD 1920×1080/2560×1080/
  3840×1080, Kosmetik-Menü gesperrt/frei, Levelauswahl mit Medaillen, Ergebnis mit
  Freischaltung (L2, Bot sync 1.0 → 15.85 s → VELOCITY → Dose), Kontaktblätter
  `can-phases.png` (festgehaltene Phasen) und `can-live.png` (echte Bot-Läufe nach Tempo),
  Cache-Check (zweiter L2-Lauf rastert nur +3 Hand-Sprites).
- `node tools/alloc-probe.mjs level2 6 --unlock-all --settings '{"heldItem":"can"}'`.

## Offen

- Gefühl mit echter Maus: Häufigkeit der Tricks im Bhop (Abklingzeiten), Wurfhöhen — die
  Shots zeigen Standbilder. Die Tricks sind gut sichtbar; ob sie nach 20 Minuten nerven,
  weiß nur ein Mensch.
- Im Ergebnis-Screen mit Banner ist bei 1080p alles knapp im Bild; bei < 1000 px Höhe
  scrollt er (Kopf bleibt dank `justify-content: safe center` sichtbar).
- Das erste Rastern neuer Posen/Stufen allokiert (rasterizePose, kalter Code) — mit Dose mehr
  Posen, also mehr Füllen in den ersten Sekunden eines Laufs; Dauerbetrieb ist ruhig.
- Levelauswahl-Abzeichen sind 8 px (vorbestehend); der VELOCITY-Schimmer ist dort klein.
