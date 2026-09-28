# Inbox: Strang cosmetics-core (Plan 007, Phase 1)

Zusammenführen in `fallen.md` macht Phase 3. Alles hier ist beim Bauen wirklich passiert.

## Pixelgleicher Umbau in three.js: die Material-REIHENFOLGE ist Teil des Bildes

three sortiert opake Objekte stabil nach (groupOrder, renderOrder, **material.id**, z, **object.id**);
beide ids sind globale Zähler in Erzeugungsreihenfolge. Bei gleicher Tiefe (Deckel auf Dose, Karte vor
Kante, Hülle hinter Fläche) entscheidet damit die Bau-Reihenfolge, welches Fragment gewinnt. Der
Registry-Umbau (ViewModel → skins/, items/) blieb nur deshalb 252/252 Kacheln pixelgleich, weil jeder
Builder Materialien, Geometrien und Meshes in exakt derselben Reihenfolge anlegt wie der alte Code und
neue Materialien (Gold, Roboter) lazy NACH den alten entstehen. **Richtig:** beim Umziehen von
Aufbau-Code die Reihenfolge 1:1 übernehmen, Neues lazy anhängen, vorher/nachher per Kachel-Hash
vergleichen (dev/viewmodel.html, `live`-Zellen, zwei Läufe vorher = byte-gleich).

## Schnur: Scheinkraft aus der zweiten Differenz je Frame ist nicht framerate-unabhängig

Die Hand bekommt bei Sprung/Landung einen Geschwindigkeits-SPRUNG. Je Frame als Beschleunigung
gemessen wird er zu einer Spitze Δv/dt über genau einen Frame; der Deckel (0.6 g, sonst überschlägt
sich das Pendel) schneidet diese Spitze bei 30 Hz 33 ms lang ab, bei 2400 Hz nur 0.4 ms. Mit ×1.5
Scheinkraft lief das Pendel bei gleicher Handbahn um 3.4 px (30 Hz) / 2.0 px (60 Hz) auseinander.
**Richtig:** den Anker je Frame nur als Position übergeben und in JEDEM 1/240-s-Unterschritt einen
kritisch gedämpften Folger (8 Hz) nachführen; dessen Beschleunigung ist die Scheinkraft (`RopeDrive`).
Gleiche Handbahn: 0.30 px / 0.08 px. Die ganze Kette (HandMotion je Framerate) lag erst bei 5.8 / 2.9 px —
behoben in der Fix-Runde (nächster Abschnitt), jetzt 1.13 / 0.92 px (Raster 0.25 / 0.03).

## HandMotion: Events UND Zustände gelten am Frame-Ende (#77 galt nur für Trick-Zeitleisten)

Die Hand legte Event-Impulse (Sprung, Landung, Kante) direkt auf die Federn und schritt dann den ganzen
Frame — bei 30 Hz lief sie damit einen Frame vor (6.6 px gegen 2400 Hz, gemessen in rope-hang), die
12-ms-Lande-Verzögerung rastete auf Frames (bis 21 ms zu spät). Zustände aus dem Snapshot (Luft, A/D,
Ducken) wirkten über den GANZEN Frame, der Sprung-Impuls aber (nach #77) erst am Ende — Luft-Neigung und
Kick fielen um einen Frame auseinander, das Pendel der Schnur verstärkte genau das (Neigung dreht seine
Schwerkraft). **Richtig:** Impulse nach dem Federschritt (Warteschlange `qy/qsq/qpitch`), eine Marke mitten
im Frame per Impulsantwort exakt nachholen (`Spring.impulse(dv, age)`), Zustände mit den Eingaben vom Ende
des LETZTEN Frames rechnen (`held`), Blick-Delta dagegen sofort (Intervall-Maß). Ergebnis: jeder Frame bei
30/60/144/240 Hz gegen 1200 Hz y ≤ 0.0004 Bildhöhen (vorher 0.023 = 6.3 px), Neigung ≤ 0.006° (0.57°).
Gleiche Falle in PropTricks: `spinKick` lief vor dem Wackel-Schritt (Fang 0.023 rad bei 30 Hz zu früh) —
jetzt mit dem Alter der Marke (`markLate = t − at`) exakt; Spinner-Präzession lief im ersten Trick-Frame
um dt vor und las ω vom letzten Frame (0.085 rad) — jetzt Trick-Zeit-Zuwachs und ω vor der Zeitleiste.
Alle Spinner-Tricks jetzt jeder Frame ≤ 0.0001 gegen 1440 Hz.

## Messszenario: das Blick-Delta ist ein Intervall-Maß

rope-hang leitete die Maus-Drehung aus dem Zustand AM FRAME-ENDE ab (`!onGround ? side·1.6·dt`) — bei
30 Hz begann die Drehung damit einen Frame vor dem Sprung. Im Spiel ist `yawDelta` die Drehung im
Frame-Intervall. Allein diese Korrektur brachte die ALTE HandMotion auf 2.03 / 1.31 px (statt 5.84 / 2.91);
der Rest kam aus HandMotion. **Richtig:** Intervall-Größen im Szenario als Integral über (t − dt, t]
(`yawAt(t) − yawAt(t − dt)`), Punkt-Größen (Boden, A/D) als Zustand am Frame-Ende; Wechselzeiten auf das
1/6-s-Raster legen (in viewHand.test lag der A/D-Wechsel bei 2.3 s — nicht auf dem 144-Hz-Raster).

## Frame-Vergleiche: Zeitleisten-Grenzen genau auf einem Rasterframe

Vergleicht man JEDEN Frame (nicht nur 1/6-s-Proben), fallen Phasen-Grenzen (Messer-Aerial: Ausholen → Luft
bei genau 0.1 s, Dose-Crack-Ende) auf Rasterframes; welche Seite ein Frame erwischt, entscheidet die
Float-Summe von t (30 × 1/30 ≠ 0.1 exakt). Abweichung dort 0.96 Einheiten (Messer: die Zeitleiste springt an
dieser Grenze — Plan 006, nicht angefasst) bzw. 6π beim `spin` (gleicher Winkel). Spin modulo 2π
vergleichen; für neue Gegenstände Zeitleisten an Phasen-Grenzen stetig bauen.

## Math.hypot allokiert in V8 (Node-Heap-Probe), Smi-Startwerte boxen in Chrome

`Math.hypot(ax, ay, az)` in `PropTricks.rotateLocal` stand mit 4–13 KiB/s als eigener Allokator in der
Node-Probe (mit Events); `Math.sqrt(x² + y² + z²)` ist pixelgleich (vm-hash 252/252) und halbiert den
Hand-Müll gegenüber HEAD (Karte 51 → 25–37 KiB/s, Messer 54 → 32–34, Dose 25 → 13–19). Ebenso in rope.ts.
`Spring.step(target, dt)` boxte in Chrome (alloc-probe: `step`/`stepGoal` 1.0–1.6 KiB/s), bis `x`/`v` mit
Double-Startwert angelegt wurden und der Frame-Pfad Ziel/Schrittweite als Felder setzt (`stepGoal()`).
Und wieder #61: HandMotion.update wurde durch die neuen Teile größer → in drei kleine Methoden geteilt.

## Festgehaltene Tricks können trotzdem kicken

Annahme der Prüfung: vm-hash-Kacheln schicken keine Events, festgehaltene Tricks nullen die Hand-Impulse.
Stimmt nicht ganz: die Dose macht beim Crack ab t ≥ 0.46 einmal `kick` über `(t >= 0.46 && !opened)`
statt über `mark()` — der Impuls kommt im ersten Frame durch. Seit er am Frame-Ende wirkt, sind "can crack
0.5/0.8" anders (4 + 2 Kacheln, 16 Pixel im Spielblatt). Das ist die einzige bewusste Abweichung der
eingecheckten Baseline (`tools/cosmetics/vm-hash-baseline/`, `vm-hash.mjs check`).

## Slide-Hop: die Physik schickt [jump, slideEnd]

PlayerMovement legt im Sprung-Tick erst `jump`, dann `slideEnd` an ("Rutschen endet mit dem Boden").
Wer `hold` (keine neuen Tricks beim Rutschen) vor dem Event setzt, schluckt jeden Slide-Hop. Ein Sprung
beendet die Rutsche immer → HandMotion setzt `sliding = false` beim `jump`. Test mit echter PlayerMovement
(viewHand.test "Slide-Hop mit der echten PlayerMovement").

## Spinner-Takt auf L2: die Band-Definition entscheidet, nicht der Spinner

Roh-Anteil L2 24.0 / 20.4 % (sync 1.0 / 1.5°), ohne Zustandszeit 33.6 / 30.5 %. Ursache strukturell: in
schnellen Surfs (26–29 % der Zeit) zeigt der Spinner die Balance (Zustand), wo Dose/Karte/Messer
Meilenstein-Tricks machen. Probiert und verworfen: Schnipp nach jeder Balance 29.5 / 26.8 % roh, aber
28.9 / 31.3 Tricks/min (Grenze 32) und Surf-Abdeckung 82–84 % (Grenze 80); nur nach ≥ 1 s Balance
27.0 / 24.5 %; Balance-Abklingzeit 0 → 24.0 / 20.4 %. Mit KI8 (Surf-Zustände für Dose/Karte/Messer) trifft
das alle Gegenstände — die Definition ("ohne Surf-Zustände" = Nenner ohne Zustandszeit) gehört in den Plan.

## Spinner-Aliasing ist absichtlich pro Frame

Drei Lappen = 3-fache Symmetrie: ab ~1 rad Drehung pro Frame läuft der Rotor scheinbar rückwärts.
Der angezeigte Schritt ist deshalb auf 0.9 rad/Frame gedeckelt, darüber blendet der Unschärfe-Ring ein.
Folge: Winkel und Unschärfe HÄNGEN an der Framerate (144 Hz: nie ein Ring), ω und alle Zeitleisten nicht.
Tests für dt-Unabhängigkeit dürfen die Kanäle `angle`/`blur` nicht vergleichen.

## Glanz je Vertex gestuft = Tarnmuster

Der Prototyp stufte das Glanzband im Vertex-Shader (smoothstep der Reflexion, im Fragment auf 3 Stufen
gerundet): auf der großen Handfläche wurden daraus unregelmäßige Flecken. Die Reflexion JE PIXEL aus
der interpolierten Normale, dann 3 Stufen, gibt saubere Chrom-Bänder, die der Form folgen.

## Trick-Takt mit Surf-Zustand: zwei Maßstäbe

Der Balance-Zustand des Spinners läuft auf L2 in 24–28 % der Zeit (Surf ≥ 500 u/s) und zählt nicht als
Trick. Der reine Anteil an der Laufzeit fällt dort auf 20–24 % (Band 25–45 %), bezogen auf die Zeit
AUSSERHALB des Zustands sind es 30–34 % — vergleichbar mit Dose/Karte/Messer, die keinen Surf-Zustand
haben. `tools/cosmetics/event-probe.ts` gibt beide aus; der Takt je Trick hängt fast nur an den
Abklingzeiten (toss/ufo 1.3/1.2 s → L1 sync 1.0 32.4 → 25.8 Tricks/min).

## Float32Array speichert −0

`param[i] = sign * 0` mit sign −1 ergibt −0; `expect(x).toBe(0)` scheitert (Object.is). Neutrale
Kanäle explizit mit `0` schreiben.

## Foto ohne HUD aus einem WebGL-Canvas ohne preserveDrawingBuffer

`drawImage(webglCanvas)` liest im SELBEN Task direkt nach `render()` den aktuellen Zeichenpuffer — erst
das Compositing leert ihn. `snapshot()` rendert den Post-Pass einmal ohne HUD, kopiert sofort und
rendert mit HUD nach, damit der angezeigte Frame unverändert bleibt.

## Registry-Umbau: eine größere Methode = V8 inlinet three-Setter nicht mehr = Dauer-Müll im Frame

Der erste Umbau stand pixelgleich da, `ViewModel.apply` allokierte aber im Dauerbetrieb 16.3 KiB/s
(Node-Mikroprobe mit Heap-Sampling + GC-Flags, 60 s aufgewärmt; Browser `alloc-probe --warmup 60`:
~10 KiB/s, Platz 1 der src/-Liste) — der Plan-006-Stand (HEAD, gleiche Szene) 0. Ursache: `apply`
bekam drei neue Aufrufe (Skin, Item-Registry, Schnur) und sprengte das Inlining-Budget von TurboFan;
`Vector3.set`/`Euler.set` liefen danach als echte Aufrufe, und jedes Double-Argument wird dafür als
HeapNumber geboxt (~17 pro Frame). Nach 8 s Aufwärmen sah es genauso aus — kein JIT-Anlauf (#65),
echter Dauer-Müll. **Richtig:** Frame-Methoden klein halten (`applyRig`/`applyItem`/`applySub`/
`applyPoof`, jede wieder 0); nach jedem Umbau im Frame-Pfad gegen den alten Stand messen — ein Export
von HEAD (`git archive HEAD | tar -x`, `node_modules` als Junction) läuft mit denselben Tools.

Zweite Quelle: `glow.value = …` pro Frame auf einem `{ value: 0.6 }`-Uniform boxt IMMER (~1 KiB/s je
Uniform). Alle `{ value }`-Literale teilen sich in V8 eine Map; weil viele Vektoren halten, ist das
Feld "tagged". **Richtig:** pro Frame beschriebene Zahlen-Uniforms als `ScalarUniform` (eigene Klasse,
Double-Startwert → Feld bleibt Double, Schreiben in place) — vmMaterials.ts.

## In-Game-Kontaktblätter taugen nicht für "pixelgleich" (bestätigt #57 mit Zahlen)

`viewmodel-shots props` (echtes Spiel, `forceTrick` + Echtzeit-Warten): vorher/nachher 39–44 Tsd.
verschiedene Pixel je Blatt — aber zwei Läufe DESSELBEN Codes auch 29–42 Tsd. (Dither-Rauschen und
Trim-Puls über das ganze Bild, Blatt-Höhe schwankt um 1 px). Der Beweis läuft deterministisch über
dev/viewmodel.html: dieselben Trick-Phasen × 2 Handschuhe × Spiel-/Menügröße = 252 Kacheln,
FNV-Hash je Kachel, zwei Baseline-Läufe byte-gleich (`node tools/cosmetics/vm-hash.mjs write|cmp`).

## Heredoc-Patches mit Backticks (bestätigt #78)

Wieder gebrochen ("unexpected EOF"); ebenso ein `node -e` mit eingebetteten `\\n` in einem
Template-Literal — es schrieb echte Zeilenumbrüche in einen JS-String. Patch-Skripte als Datei
(`patchlib.mjs` mit CRLF-Normalisierung und "nicht gefunden → throw").

---

# Strang cosmetics-items (Plan 007, Phase 2)

## Schnur: Moduswechsel mitten im Frame (geführt ↔ frei) muss die Schnur-Rechnung teilen

Kendama-Kugel loslassen (Becher kippt zurück) und Jo-Jo-Wurf-Ende sind Marken der Trick-Zeit, landen aber
mitten in einem Frame. `rope.freeEnd` galt für den GANZEN Frame → bei 30 Hz fiel die Kugel bis 30 ms zu
früh aus dem Becher (0.17 s später 2.5 Einheiten ≈ 17 px gegen 1440 Hz), das Jo-Jo-Pendel startete eine
Wurf-Phase zu spät (2.7 px). **Richtig:** den Frame an der Marke teilen — `Rope.updatePart(dt, k, s, e)`
bis zur Marke im alten Modus (Anfang zwischen letztem und diesem Anker interpoliert, Kraft-Anteil 0..k),
Modus umschalten, `updateRest(dt, k, …)` für den Rest; beim Wechsel frei → geführt die Bahn an der
Pendel-Lage ZUR MARKE starten (nicht an der vom letzten Frame-Ende). Kendama-Fänge danach: jeder Frame
≤ 0.043 Einheiten (Pendel-Phasen), Fang im Renderer exakt (< 1e-4).

## Schnur ist kein Stab

Verlet-Abstands-Bedingungen in beide Richtungen machen aus lockerer Schnur eine Kette von Stäben, die sich
gegeneinander stemmen — chaotisch, bei jeder Framerate anders. Nur Dehnung korrigieren (`if (d <= L)
continue`): locker hängt sie durch, gespannt verhält sie sich wie vorher (rope-hang unverändert 1.13 /
0.92 px). Becher-Fänge je Framerate: 0.25 → 0.009 Einheiten.

## surfSide am Surf-Ende springt auf 0

Surf-Zustände lesen die Seitenneigung der Rampe; im ersten Frame nach dem Surf liefert der Snapshot 0 →
die Lage ruckte um 0.3·side (sichtbar), beim Kendama schleuderte der Ruck die Kugel aus dem Becher (3.3
Einheiten Unterschied zwischen Frameraten). **Richtig:** `PropTricks.surfLean` — nur beim Surfen
aktualisiert, danach gehalten; der Ausklang des Zustands blendet sie weich aus.

## Frame-Vergleiche: Phasen-Grenzen nicht auf das gemeinsame Raster legen (bestätigt)

0.25/0.75/1.0 s liegen auf 30/60/144/240/1440 Hz zugleich; welche Seite ein Frame nimmt, entscheidet die
Float-Summe. Gekippt: Handy-Auslöser 0.75 (Blitz 1 gegen 0), Rauch-Ende 0.4 + 0.6, Münz-Wiedererscheinen.
**Richtig:** Grenzen neben das Raster legen (Auslöser 0.76, Rauch 0.587) oder Zeitleisten stetig bauen
(Münze: Größe/Drehung schon unsichtbar auf Startwert, Sichtbarkeit 0.05 s einblenden). Diskrete Kanäle
(Handy-Modus/-Wert) nicht Frame gegen Frame vergleichen, sondern eigens testen.

## writeRest muss jeden Kanal setzen, den der Gegenstand besitzt

Das Jo-Jo setzte `o.rot` nicht (der Sockel trägt nichts) — das Nachwackeln (`rotateView` VOR die aktuelle
Lage) summierte sich Frame für Frame: Euler-Winkel liefen je Framerate auseinander (π-Sprünge im Vergleich).

## Festgehaltene Tricks: Zustand nur beim Festhalten zurücksetzen

Kendama/Jo-Jo setzten die Schnur bei JEDEM `debugPlayName` zurück (für reproduzierbare Kontaktblätter —
die Dev-Seite ruft forceTrick jeden Frame). Frei laufend (Tests, `__vel.forceTrick`) startete der Trick
so aus einem Einschwing-Übergang (0.26 Einheiten je Framerate). Nur bei `at ≥ 0` zurücksetzen; freies
Pendel festgehalten = gerade nach unten legen (sonst zeigte das Blatt das Jo-Jo in der Faust).

## Trick-Takt: Meilensteine umgehen die Abklingzeit

`PropTricks.onEvent('speedMilestone')` fragt nur `free`, nicht die Abklingzeit — bei langen Tricks (Münze
1–1.4 s, Kendama) kam direkt nach jedem Sprung-Trick ein Meilenstein-Trick: 48–73 % Trick-Anteil. Münze,
Kendama, Feuerzeug, Handy prüfen die Abklingzeit selbst in `onMilestone`. Alle neuen Gegenstände liegen
danach auf L1/L2 in 26–43 % (ohne Surf-Zustandszeit) und 20.2–30.3 Tricks/min.

## Checkpoint vor der Surf-Rampe blockiert den Surf-Zustand

Der Münz-`call` startete in der Luft direkt vor der Rampe und lief 0.8 s — der Surf-Zustand kam erst danach
(Surf-Abdeckung 74–76 %, Grenze 80). **Richtig:** in der Luft oder im Surf wartet der call (verfällt nicht,
solange das dauert) und kommt bei Landung oder beim nächsten Sprung. Danach 100 %.

## V8: drei Muster, die im Frame-Pfad Kommazahlen boxen (Chrome UND Node)

1. **Modul-`let`** mit Kommazahl (fk.ts `px/py/pz`): jede Zuweisung = neue HeapNumber (Jo-Jo: 16 KiB/s).
2. **Zweig um Kommazahl-Rechnung** (`if (seg >= 2) { y = … }`): am Zusammenfluss mischt TurboFan den
   getaggten Parameter mit dem Float64-Ergebnis → boxt. Node-Probe: 469 Scavenges je 5·10⁶ Aufrufpaare,
   verzweigungsfrei (Drehung 0 für unbenutzte Glieder) 1. Auch `cond ? kommazahl : 0` boxte in Chrome →
   Faktor 0/1 (ganzzahlig) multiplizieren.
3. **Kommazahl aus Array/Feld als Argument** eines nicht geinlineten Aufrufs (`fingerPoint(…, ANCHOR[1], …)`,
   `setFrame(fin(inp.handX), …)`, `socketPoint(o.pos, o.rot, o.spin, …)`, `rope.update(dt, a[0], …)`):
   Literale sind fertige Konstanten, geladene Werte werden je Aufruf geboxt. **Richtig:** Puffer/Objekt
   übergeben (`Rope.updateV(dt, s, e)`, `RopeDrive.setFrameFrom(inp)`, `socketOf(o, local, out)`), Ziele als
   Felder (`Rope.s1/e1/stepH`), FK nur bei geänderten Gelenken (`fingersMoved`).
Isolierte Chrome-Probe (ViewHand allein, 200 000 Frames, CDP-Heap-Sampling): Jo-Jo 110 → 86 B/Frame
(Dose 35). `Rope.advance` blieb bei ~12 B/Frame, Ursache nicht gefunden (Node: 0) — offener Punkt.

## Katzenpfote lesbar machen (Nutzer-Abnahme steht aus)

- Weiße "Socke" als Unterarm las sich als Ärmel ("oranger Handschuh mit Hemd"): getigertes Bein + Krause.
- Streifen sind Vertex-Farbe: zwischen weit entfernten Ringen (−9 → −40) verschwimmen sie → dichte Ringe
  (0.9 u) nur in der Lit-Fläche, die Hülle braucht nur die Silhouette (Dreiecke 10 204 → 8 552).
- Büschel: spitze Kegel = Nieten/Stacheln, runde = Perlenkette; Flammenform (bauchig, weiche Spitze) liest
  sich als Fell.
- Krallen "halb sichtbar": 0.4 u Überstand ist im Spielbild unsichtbar, 0.9 u (Rückzug 1.3 statt 2.0) gut.

## Münze: Kopf/Zahl muss hell gegen dunkel sein

Zwei dunkle Motive auf Gold sind bei ~14 px nicht zu trennen. Zahl = dunkles Bronze-Feld mit hellem Blitz.
Der Knöchel-Lauf braucht die zur Kamera gedrehte Faust (hpitch 0.9, hyaw 0.3) — sonst verschwindet die
Münze ab dem Ringfinger hinter der Faust.

## Selfie messen, ohne Game anzufassen

Im Spiel-Tab `await import('/src/render/PS2Renderer.ts')` liefert dieselbe Modul-Instanz wie das Spiel
(Vite, gleiche URL) → `debugRenderer().selfie(96, 54, new ViewHand().selfieFrame())`. Welt-Durchgänge
zählen: `renderer.render` NUR um den Selfie-Aufruf im rAF umhängen — vorher gehängt zählte der Spiel-Frame
im selben rAF mit (2 statt 1).

## Paralleler Level-Strang verschiebt die Takt-Messung

event-probe baut L1/L2 aus `tools/levels/*.ts`; l1l2 baute L1 während der Messung um (Lauf 75.9 → 71.2 s,
1.5°-Hand 87.4 → 100.4 s) — Feuerzeug sprang dadurch von 30.8 auf 35.4 Tricks/min. Takt-Zahlen sind eine
Momentaufnahme; Phase 3 misst mit den finalen Leveln neu.
