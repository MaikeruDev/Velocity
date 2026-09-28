# Regeln: Look (verbindlich)

Ziel: sieht aus wie ein PS2-Spiel um 2002 auf einem Röhrenfernseher —
Rez, Jet Set Radio Future, SSX Tricky, Tony Hawk 3 — in einer Nacht-/Dämmerungs-
Techno-Welt. Gepixelt, aber **lesbar**: Plattformkanten müssen auch bei
1000 u/s aus dem Augenwinkel erkennbar sein.

## Pipeline (fest)

1. Szene rendert in ein `WebGLRenderTarget` mit niedriger Auflösung
   (höchstens `pixelHeight` Zeilen — Faktor ceil(devH/pixelHeight), echte Zahl über
   `effectiveLines()` in render/lowres.ts; Breite nach Seitenverhältnis), `NearestFilter`,
   **kein** Antialiasing.
2. Post-Pass auf dem Low-Res-Bild: Farbquantisierung auf `colorBits` pro
   Kanal mit geordnetem 4×4-Bayer-Dithering (im Low-Res-Pixelraster!),
   dezente chromatische Aberration (stärker mit Speed), Vignette, optional
   Scanlines (Vollausschlag 16 %, Default 0.25 → 4 % — unter einer 5-Bit-Stufe
   von 3,2 % wären sie praktisch aus). HUD-Canvas wird hier im selben Raster eingerechnet.
3. Hochskalieren auf Fenstergröße **ganzzahlig** mit Nearest-Neighbor
   (Canvas in Low-Res + CSS `image-rendering: pixelated`, Skalierung so
   gewählt, dass jeder Low-Res-Pixel exakt N×N Bildschirmpixel ist).

## Materialien

- Eigener Shader: **Vertex**-Beleuchtung (Gouraud: Hemisphären-Ambient +
  eine Sonne), **Vertex**-Fog (linear, wie PS2), Vertex-Snapping auf das
  Low-Res-Raster, Mischung aus affinem und perspektivischem Texture-Mapping.
- Brush-Flächen werden in ~64-u-Zellen tesselliert, damit Vertex-Licht und
  Fog Variation haben und affines Warping dezent bleibt.
- Texturen prozedural (Canvas, 32–64 px, Nearest, begrenzte Palette),
  weltraum-projiziert (1 Texel ≈ 4 u), keine Bilddateien.
- Oberkanten begehbarer Flächen bekommen **Neon-Trims** (emissiv, kaum vom
  Fog geschluckt, pulsieren mit der Kick). Das ist Lesbarkeit, nicht Deko.

## Flow-Feedback (Plan 003)

Tempo und Hop-Qualität zeigen sich in der Welt, aber **nur** an Trims, am
Void-Gitter und am Bildrand, nie auf Flächen:

- **Speed-Streifen** (post.ts): ab ~380 u/s in Trim-Farbe, nur außerhalb r ≥ 0.55
  (Bildmitte bleibt pixelgleich), Helligkeit pulst mit der Kick. `speedLines` 0 = aus.
- **Landewelle** (trimMaterial): Lichtring 3600 u/s vom Absprungpunkt eines guten
  Hops, 0.3 s, hellt Trims auf und weitet sie ≤ 2 px nach außen.
- **Tempostufe** 0..3: Trim-Oberband heißer Richtung Weiß, Seitenband Zweitfarbe.
  Nicht komplett umfärben — die Trim-Farbe ist die Gegenfarbe zur Welt (Kontrast).
- **Void-Gitter**: Welle mit Tempo stärker, auf der Kick läuft ein Ring vom Spieler weg.
- **Ghost**: Hull als Dither-Hologramm (Screen-Door, kein Blending), blendet < ~180 u aus.

Ruhezustand (Tempo 0, keine Welle, Stufe 0) ist pixelgleich zum Bild ohne diese
Effekte — Prüfung: `node tools/shoot-render.mjs --fx`.

## View-Hand (Plan 006, ersetzt die Sprite-Hand aus Plan 004)

Seit 2026-09-28 ein echtes **Low-Poly-3D-Viewmodel** im Stil der Referenzbilder in
`hand screens/` (PS1/PS2-Viewmodel: weißer Handschuh, weiche Graustufen, dicke dunkle Kontur,
pummelige Finger, Stulpe mit schwarzem Band). Bei Zweifeln gegen diese Bilder prüfen
(`node tools/viewmodel-shots.mjs compare` legt sie neben eigene Ausschnitte).

- **Gleiche Pipeline wie die Welt**: nach der Welt ins selbe Low-Res-Target (Tiefe geleert,
  eigene Szene/Kamera, vFOV 54° ≈ viewmodel_fov 68). Dithering, Quantisierung, Fade und Blitz
  treffen die Hand wie die Welt. Kein Fog, **kein Vertex-Snapping** (die Hand würde zittern).
- **Modell**: prozedural aus elliptischen Röhren mit Kugelkappen (Handfläche, 4 Finger à 3
  Glieder, Daumen 3 Glieder, Stulpe, Band, angeschnittener Unterarm), 7–12 Segmente. Finger dick
  (Radius ≈ halbe Gliedlänge) — fäustlingsartig, aber einzelne Finger.
- **Licht**: Gouraud im View-Raum — Hemisphäre in der entsättigten Level-Umgebungsfarbe (Anteil
  28 %, damit Weiß weiß bleibt) + Schlüssellicht von oben links aus Kamerarichtung mit Wrap
  (weiche Grautöne) + schmaler Rim in der Level-Trim-Farbe unten/außen.
- **Kontur**: Inverted Hull, im Clip-Space um ganze Low-Res-Pixel entlang der projizierten Normale
  (Chebyshev-Norm = quadratischer Pinsel), Hand 2.5 px bei 270 Zeilen, Gegenstände dünner, Messer
  1 px. Dazu eine **Tinten-Kante** im Lit-Shader (n·v < 0.22 → Konturfarbe): trennt Finger vor
  Fingern — die Hülle zeichnet nur die Außen-Silhouette.
- **Lage**: Handgelenk im 16:9-Safe-Frame (`ui/safeFrame`) 0.30 Bildhöhen links vom rechten Rand,
  0.17 über der Unterkante; Unterarm läuft verkürzt aus dem Bild. Grundhaltung `VM_ARM_BASE`:
  Daumen oben, Finger ins Bild nach links, Faust sichtbar über der Dosenfront (wie 015016/015019).
  Untere Mitte (Landepunkt) und unten links (Showkeys) bleiben frei.
- **Bewegung** wie Plan 004 (geklemmt, × `motionFx`, Bhop leicht), zusätzlich 3D-Sway (yaw/pitch
  ≤ 0.16 rad) und Sprung-/Landungs-Nicken. Posen als Gelenkwinkel, exponentiell überblendet.

## Kosmetik (Plan 005/006)

- **Neon-Handschuh**: nur Materialvariante (dunkler Handschuh, Cyan-Kontur + Cyan-Tinte, Magenta-
  Band leuchtend), gleiche Geometrie. Neue Varianten ebenso als Material, nicht als neue Formen.
- **Gegenstände**: Low-Poly, prozedurale Texturen (Pixelpuffer, Nearest, feste Palette, Alpha 128 =
  leuchtend), eigene dünnere Kontur. **Kein Markenlogo, kein echter Schriftzug, keine bekannte Figur**:
  Dose weiß mit eigenem grünem Zacken-Blitz + Ringen; Karte mit eigenem Monster ("Blitzmolch"),
  Navy/Cyan-Rahmen (kein gelber Rahmen), Holo-Streifen per Shader, Rückseite Spirale + V-Emblem;
  Messer = stumpfer Trainer (Löcher in der Klinge).
- **Tricks sind Show, nie im Blickzentrum**: Würfe steigen höchstens ~10 Einheiten (~0.3 Bildhöhen)
  über den Griff und bleiben rechts unten. Der Schluck holt die Dose kurz zur Mitte — nur in Ruhe.
- Zauber-"Poof": Pixel-Punkte (ganze Low-Res-Pixel, Weiß/Cyan), Auflösen per Bayer-Screen-Door.

## Kosmetik v2 (Plan 007)

- **Skins = Geometrie je Rig-Slot**: Handfläche, 4×3 Fingerglieder, 3 Daumenglieder, Unterarm (VM_RIG).
  Je Slot EIN Lit-Mesh + EINE Hülle — Teile (Nieten, Scharniere, Ballen …) per Vertex-Farbe in eine
  Geometrie zusammengeführt (`mergeGeometries`). So folgen alle Skins allen Posen und Griffen, und die
  Draw-Call-Zahl bleibt bei 36 wie beim Handschuh. Varianten ohne neue Form bleiben Material (Gold).
- **Gold**: Handschuh-Geometrie, warmes Gelb mit hartem Licht (Wrap 0.1), **gestuftes Glanzband**
  (Reflexion des Blicks JE PIXEL, 3 harte Stufen — Environment-Map-Look, kein PBR), Tinte/Kontur
  dunkelbraun. Funkeln bei perfektem Hop: 3 Pixel-Kreuze an den Knöcheln, 0.25 s.
- **Roboter**: kantige Hülsen (Superellipse n = 4) mit Spalt, dunkle Scharniere, Sensor-Pads, gerippter
  Unterarm; das **LED-Band pulst mit der Kick** und wird mit dem Tempo heller (Licht, keine Bewegung —
  bleibt auch bei motionFx 0).
- **Fidget-Spinner**: Drehzahl = Tempo. Gegen Wagenrad-Aliasing höchstens 0.9 rad Drehung pro Frame;
  darüber ein **Unschärfe-Ring als Bayer-Screen-Door** (Dichte ≤ 0.45, Körper-/Trim-Farbe), kein Blending.
  Nabe blinkt am Checkpoint grün (vorn) / rot (zurück).
- **Schnur** (Jo-Jo, Kendama, ab Phase 2): `Line`, 1 Low-Res-Pixel, rohe Farbe, 9 Punkte.
- **Bild-Hülle der Tricks** (gemessen, `npx tsx tools/cosmetics/envelope.ts`): kein Trick eines neuen
  Gegenstands höher als −0.314 oder weiter links als 0.055 Bildhöhen ab Bildmitte (16:9) — das ist die
  Hülle der abgenommenen Dose/Karte/Messer. Ausnahme: ruhige Momente nach dem Ziel (Foto).
- **Budget** je Kombination Skin × Gegenstand: ≤ 50 Draw Calls, ≤ 12 000 Dreiecke
  (`node tools/viewmodel-shots.mjs budget`).
- **Umbauten an Bestehendem** (Hand, Dose, Karte, Messer) bleiben pixelgleich — Beweis deterministisch
  mit `node tools/cosmetics/vm-hash.mjs check` gegen die eingecheckte Baseline (252 Kacheln Spiel/Menü,
  `tools/cosmetics/vm-hash-baseline/`; auf anderer GPU: HEAD selbst hashen, `write` + `cmp`), nicht
  mit In-Game-Blättern (die streuen zwischen zwei Läufen desselben Codes). Einzige bewusste Abweichung
  zu Plan 006: der Lasche-Ruck der festgehaltenen Dose ("can crack 0.5/0.8") wirkt am Frame-Ende.
- **Zeitpunkt von Impulsen** (Hand, Wackeln, Tricks): Events und Marken gelten am Frame-Ende (fallen.md
  #77); Zustände (Luft, A/D, Ducken) ab dem Frame-Ende, in dem der Snapshot sie zeigt; eine Marke mitten
  im Frame per Impulsantwort exakt nachgeholt (`Spring.impulse`, `PropTricks.spinKick`). Maßstab: jeder
  Frame bei 30/60/144/240 Hz gegen die Referenz (viewHand.test, cosmetics.test, rope.test).
- **Ziel-Foto** (`RendererApi.snapshot`): Kopie des geditherten Low-Res-Bilds OHNE HUD, Nearest.

## Verboten

- Glatte, moderne Darstellung: PBR, Schatten-Maps, SSAO, Bloom mit weichem
  Glow über viele Pixel, MSAA/FXAA, Mipmaps mit Linear-Filter.
- Effekte, die das Lesen der nächsten Plattform erschweren (zu starker CA,
  Wobble, Fog vor der nächsten Sprungkette).
