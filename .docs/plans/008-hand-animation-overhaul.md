# Plan 008 — Hand-/Animations-Overhaul, Schritt 1: Griff-Audit + Animations-Fundament

**Stand:** 2026-10-01 · **Status:** Schritt 1 umgesetzt (Griffe, Fundament, Butterfly-Messer). Schritt 2 (Tricks je
Gegenstand auf dem Fundament) offen — parallel durch Animator-Agenten, je Gegenstand nur `ui/hand/<item>Tricks.ts`
und ggf. `render/viewmodel/items/<item>.ts`.

## Problem

Nutzerwunsch 2026-10-01: "Animations-/Hand-Overhaul. Zuerst die Positionierung der Items in der Hand prüfen. Danach
die Animationen richtig awesome machen — echt aussehen (das Butterfly-Messer sieht nicht normal aus), befriedigend."
Die Sammelkarte gefällt (Look nicht verschlechtern).

Befund vorher (Kontaktblätter `shots/hand-v3/before/`, Zahlen `npx tsx tools/hand-contact.ts`): fast jeder Gegenstand
steckte in der Hand oder schwebte. Durchdringung (Einheiten ≈ cm, dichte Oberflächen-Abtastung gegen das
Kollisionsmodell der Hand):

| Gegenstand | vorher | nachher |
|---|---|---|
| Karte | Zeigefinger-Grundglied −1.43, Handfläche −0.53, Daumen berührte die Karte nicht (≥ 0.6 davor) | Daumenkuppe −0.09 auf der Vorderseite, Zeigefinger −0.14/−0.07 hinten, sonst frei |
| Dose | Daumenballen −1.13, Finger bis −1.34 (Mittel-/Ringfinger durch die Dose) | alle 15 Glieder −0.13…+0.14 (liegen an), Handfläche 0.00 |
| Messer | Griffe quer durch Faust und Handfläche (−1.20 … −2.40 offen), Klinge 10.5 cm | Kniff am Safe Handle: Daumen −0.10, Zeigefinger +0.15, Rest frei |
| Jo-Jo | Daumenkuppe −0.76 | Finger am Rand +0.03…+0.09, Daumen +0.20 |
| Spinner | Zeigefinger-Grundglied −1.35 im Rotor (lag auf der Zeigefinger-Kuppe) | Daumen- und Mittelfinger-Kuppe am Mittellager (−0.19/−0.18) |
| Münze | Daumen −1.06, Zeigefinger −1.04 | Daumen-Klemme: Zeigefinger +0.03, Daumen −0.03 |
| Feuerzeug | Daumen −1.15, Mittelfinger −1.38 | alle Glieder −0.12…+0.13, Daumen am Deckel |
| Kendama | Zeigefinger −1.32 (Griff 3.4 cm lang: kürzer als ein Finger breit) | Ken 1.5×, Griff diagonal in der Faust: Handfläche −0.34, Daumen am Griff; Kugel (hängend) −0.57 am Daumen, siehe offen |
| Handy | Zeigefinger −1.03, Handy 46 × 86 mm an den Kuppen, Daumen schwebte | 1.45× (67 × 125 mm), Rücken an den Fingern, Daumen auf dem Display (+0.01) |

## Griffregeln je Gegenstand (verbindlich für Schritt 2)

Kamera sieht die Hand von der Daumenseite/vom Handrücken (Daumen oben, Finger ins Bild nach links). Werte sind Ruhe-
Lagen; Tricks starten und enden dort. Jede Ruhe-Pose ist mit Finger-Kontakt gebacken (`tools/hand-grips.ts`) und durch
`tests/handFoundation.test.ts` ("Ruhe-Griffe … keine Durchdringung über 0.35, kein Schweben") abgesichert.

- **Karte (63 × 88 mm, Pose `pinch`):** Kniff an der Unterkante — Daumenkuppe flach auf der Vorderseite, die Karte
  lehnt hinten am stark gebeugten Zeigefinger; Mittel-/Ring-/kleiner Finger eingerollt. Karte 2 Einheiten höher im
  Bild als Plan 006 (sie steckte mit der Ecke im Zeigefinger) — Look sonst gleich.
- **Dose (66 × 168 mm → Modell 71 × 156, Pose `grip`):** seitlich in der Faust, Achse quer über die Handfläche,
  Rücken an der Handfläche, alle Fingerglieder liegen an, Daumen auf dem Deckelrand (Referenz 015016/015019).
- **Butterfly-Messer (Pose `balisong`):** Safe Handle am Griff-Ende gekniffen — Daumenkuppe vorn, Zeigefinger-Endglied
  hinten, die Messer-Ebene zeigt zur Kamera (Kniff-Linie = Ebenen-Normale), das Messer steht links oben aus der Faust.
  Geschlossen: Bite Handle außen links, die Schneide zeigt zu ihm. Offen: Bite Handle innen an der Handfläche ("landet
  in der Handfläche"). Mittel-/Ring-/kleiner Finger eingerollt, damit Bite Handle und Klinge frei vor der Faust
  schwingen. Warum am Griff-Ende: näher am Stift liegt die Handfläche in der Schwungbahn (Abtastung der Hand in der
  Messer-Ebene, Befund in fallen.md).
- **Jo-Jo (57 mm, Pose `yoyo`):** in der lockeren Faust, Finger am Rand, Daumen auf der Flanke, Schlaufe am
  Mittelfinger (Schnur-Anker unverändert). Ruhelage wie Plan 007 (Bild gleich), die Pose legt die Finger an.
- **Spinner (~75 mm, Modell ×1.25, Pose `spin`):** Daumen- und Mittelfinger-Kuppe drücken auf die Lager-Kappen, die
  Achse liegt auf ihrer Verbindung (aus der Pose per FK), Zeigefinger frei zum Anschnippen. Auf die Kuppe (swap,
  balance) wechselt er per Achse-Winkel-Drehung (`relRot`).
- **Münze (25 mm, Modell Ø 42 mm — Lesbarkeit #114, Pose `coin`):** Daumen-Klemme — Münze steht an der Seite des
  Zeigefinger-Endglieds, der Daumen drückt von der anderen Seite (Ausgangslage für Flip und Knöchel-Lauf), Vorderseite
  zur Kamera. Der Motivwechsel im Wurf rechnet die Kante aus der Ruhelage (`EDGE_TURN`).
- **Sturmfeuerzeug (38 × 57 mm, Modell ×1.3, Posen `lighter`/`flick`):** breite Seite flach an der Handfläche,
  Zeige-/Mittelfinger um den Körper, Ring/kleiner Finger darunter eingerollt (das Feuerzeug ist kürzer als die Hand
  breit), Daumen am Deckel; `flick` = Daumen schiebt den Deckel.
- **Kendama (~18 cm, Modell 1.5× ≈ 13 cm, Kugel Ø 5 cm, Pose `ken`):** Ken diagonal durch die Faust (Hammergriff),
  Querstück über dem Zeigefinger, Daumen seitlich am Griff. Schnur 9 (hängend im Bild).
- **Handy (72 × 150 mm, Modell ×1.45, Posen `phone`/`phoneTap`):** Rücken an Zeige-/Mittelfinger, Ring/kleiner
  Finger stützen die Kante, Daumen auf dem Display (scrollt/tippt).
- **Nichts:** unverändert (Posen relaxed/run/open …).
- **Skins:** alle Skins hängen an denselben Gliedern (VM_RIG) — die Griffe gelten für alle. Kontaktblätter
  `shots/hand-v3/after/skins-*.png` (Spielbild + Seiten-/Unteransicht je Skin × Gegenstand). Das Kollisionsmodell
  ist das des Handschuhs; Katzenpfote (dickere Endglieder) und Skelett (dünner) weichen um wenige Zehntel ab.

## Animations-Fundament (DOM-/three-frei, allokationsfrei, framerate-unabhängig, in Node testbar)

| Datei | Inhalt |
|---|---|
| `ui/hand/curves.ts` | Easing-Bibliothek (`linear`, `quadIn/Out`, `cubicIn/Out/InOut`, `quintOut`, `sineInOut`, `smoothstep`, `smootherstep`, `backIn/Out/InOut(s)`, `elasticOut(cycles, damping)`, `bezier(x1,y1,x2,y2)` wie CSS, `bellCurve`), `Track` (Keyframes `[t, v, ease?]`, stetig per Konstruktion; `{ smooth: true }` = C1 über alle Keys, Catmull-Rom + Fritsch-Carlson, Enden flach), `Clip` (mehrere Spuren → Float64Array), `phase(t, a, b)` |
| `ui/hand/secondary.ts` | `Follower` (Feder-Dämpfer 2. Ordnung, ζ beliebig, exakt für ein im Frame linear laufendes Ziel → 30–240 Hz gleich; `impulse(dv, age)` holt Marken mitten im Frame exakt nach), `Overlap` (Follow-through: Glied hängt einem Treiber nach), `anticipate(depth, split)` (Ausholen als Easing), `homogeneous()` |
| `ui/hand/rigid.ts` | `Toss` (Wurf als geschlossene Parabel mit Drehung: `plan(from, to, T, a0, a1)` trifft Fangpunkt/-winkel exakt, `at(t, out)`, `velocity`, `apexUp`), `settle(v, s, ω, ζ)` (Nachfedern nach dem Fang), `squash(s)` |
| `ui/hand/chain.ts` | `PlanarChain` (1–3 Pendel-Glieder an einer bewegten Basis: Lagrange mit Massenmatrix, Geschwindigkeits-Verlet auf festem 1/960-s-Raster ab Trick-Start, Ausgabe interpoliert → jede Framerate dieselbe Bahn; Gelenk-Grenzen mit Rückprall per Impuls; `ChainDriver.base/forces`, Zeit über `chain.tEval`; `pointOfA/velocityOfA/applyForceA` für Kräfte; `energy()`) |
| `ui/hand/knifeRig.ts` | Balisong-Mechanik: `KNIFE_LINKS` (Klinge um den Stift des Safe Handle, Grenzen 0…π = Kicker/Stopp-Stift; Bite Handle um den zweiten Stift im Tang), `KnifeSim` (Kette im mitbewegten Messer-Raum: Drehung in der Ebene integriert, Stift-Beschleunigung und Schwerkraft in den aktuellen Achsen, Fliehkraft aus Überschlägen aus der Ebene; Griff gegen Griff als Kontakt, Hand als Hindernis, "grip" = Finger schließen und führen zum Ziel), `KM` (Kanäle einer Handbewegung: hx/hy/hz, pitch/yaw/roll, Handgelenk flex/dev/twist, Sockel spin/ox/oy/oz, Überschlag flip, Bühne sx/sy, grip/gripBlade, latch), `TrackMotion` (Kanäle aus Tracks, optional Überschlag-Achse und freier Flug `toss`) |
| `ui/hand/handShape.ts` | `HandShape`: Kollisionsmodell der Hand (Handfläche als elliptische Röhre, 15 Glied-Kapseln aus FK), `distance(x,y,z)`, `measure(p)` (Frame-Pfad), `partDistance`; liegt auf ±0.25 am echten Handschuh-Mesh (Test) |
| `ui/hand/propShape.ts`, `propShapes.ts` | `PropShape`: Kontakt-Körper eines Gegenstands (Quader/Zylinder/Kugel/Kapsel je Glied), `PROP_PRIMS` für alle Gegenstände, `socketMatrix()`; Maße wie die Item-Geometrie |
| `ui/hand/fingerContact.ts` | `GripSolver.close()` (pro Frame: Finger schließen in Stufen von offen → zu, bis sie anliegen; `limit` für den halb geschlossenen Fang), `GripSolver.fit()` (Gitter-Suche zum Backen einer Ruhe-Pose: jedes Glied liegt an, keins steckt drin), `applyStages`, `setCurl` |
| `PropOut.jointAdd` | Gelenk-Versatz (VM_JOINT-Layout) auf die überblendete Pose: Handgelenk-Flicks, Finger-Overlap, Finger-Kontakt. Je Frame vor der Zeitleiste 0, × motionFx, im Abbruch-Überblenden mit (Handgelenk). |

Werkzeuge: `node tools/hand-audit.mjs <out> rest|skins|tricks|knife|trick <item> <trick> [s] [open]|all` (Kontakt-
blätter: Spielbild + Orbit vorn/rechts/links/unten/oben/hinten; Zeitlupe als Kacheln alle 1/30 s, frei mit 240 Hz
gerechnet), `npx tsx tools/hand-contact.ts [item] [--glove g]` (Kontakt-Tabelle), `npx tsx tools/hand-grips.ts
<item> [--from pose] [--open pose] [--to pose] [--mask 31] [--pos x,y,z] [--view r,u,c] [--close]` (Griff backen),
`npx tsx tools/knife-tune.ts open|close [--iters N] [--seed s] [--probe …]` (Handgelenk-Flick per Physik-Suche),
Dev-Viewer `dev/viewmodel.html?live&item=knife&trick=open&speed=0.25` (Zeitlupe 1×…0.1×, Scrub-Schieber = Trick-Zeit,
Kamera Spiel/vorn/rechts/links/unten/oben/hinten, Skin) und Zellen-Optionen `view` (Orbit) / `live.play` (frei bis `at`).

### Mini-Beispiel für Animator-Agenten (Trick aus einem Handgelenk-Flick, mit Nachfedern)

```ts
// Ladezeit: Spuren über die Trick-Zeit (stetig, C1), Handgelenk statt freier Item-Drehung.
const FLICK = new Track([[0, 0], [0.08, -0.25, cubicOut], [0.2, 0.55, backOut(2)], [0.42, 0, cubicInOut]]);
const LIFT = new Track([[0, 0], [0.1, 0.02], [0.25, -0.03], [0.42, 0]], { smooth: true });
const toss = new Toss(800); // im Trick-Start: toss.plan(from, to, 0.34, 0, Math.PI * 2)

// evaluate(id, t, dt, inp, m, o):
o.jointAdd[VM_JOINT.wristFlex] += FLICK.value(t);   // der Flick ist im Gelenk, das Item hängt am Handgelenk
o.hy += LIFT.value(t);
const ang = toss.at(t - 0.12, this.p3);              // Flug: echte Parabel, Fang exakt am Ziel
for (let k = 0; k < 3; k++) o.pos[k] = this.p3[k];
this.rotateLocal(o, 0, 0, 1, ang);
if (this.mark(0, 0.46, t)) this.kick(o, 0.3, -0.8);  // Fang: Ruck in die Hand (Frame-Ende, #77)
o.jointAdd[VM_JOINT.finger + 5] += settle(4, t - 0.46); // Mittelfinger federt nach (geschlossene Form)
// afterPose(j): Finger um das Item legen — this.grip.close(tmp, POSE_JOINTS[POSE.open], POSE_JOINTS[POSE.fist],
//   shape, GRIP_FINGERS, -0.1, smoothstep((t - 0.4) / 0.08)); Differenz zu j in o.jointAdd schreiben.
```

Regeln: Zeitleisten als geschlossene Funktion der Trick-Zeit oder Physik auf festem Raster (nie `x += v·dt` mit
Frame-dt); Marken über `mark()`; keine Kommazahl-Argumente an nicht geinlinete Aufrufe im Frame-Pfad (Puffer,
fallen.md #107); Bild-Hülle (look.md) mit `npx tsx tools/cosmetics/envelope.ts <item>` prüfen; jede Item-Datei hat
ihre Ruhe-Pose in poses.ts — neue Posen HINTEN anhängen (Indizes bleiben).

## Butterfly-Messer (exemplarisch migriert)

- **Modell** (`VM_KNIFE` in render/types, Vertrag): Griffe 10.6 × 1.35 × 1.05, Klinge 8.8 × 1.8, zwei Stifte im
  Abstand 1.6 am Klingen-Tang (sichtbarer Tang-Block), Riegel am Bite Handle (`VM_PARAM.knife.latch`: eingerastet
  quer unter beiden Griff-Enden, offen hängt er). 47 Draw Calls im teuersten Skin (Budget 50: Klinge, Spitze und Tang
  in einer Geometrie).
- **Bewegung = Hand, Messer = Physik:** Basic Opening/Closing aus dem Safe Handle als Handgelenk-Flick (Beugung ≈
  Drehung um die Messer-Normale, ⅓ Unterarm-Roll, Hub) — Keyframes per Physik-Suche (`tools/knife-tune.ts`: Ziel-
  Zustand am Fang, ruhiges Einschwingen, kein Griff-gegen-Griff, Klinge weg von der Hand, Bild-Hülle, wenig Handweg).
  Ergebnis: der Bite Handle fällt heraus, schwingt über die Stift-Seite, die Klinge kommt heraus, der Bite Handle
  läuft einmal um den Safe Handle (−2π/+2π, Test) und landet an der Handfläche; Finger greifen (Führung), Riegel
  klappt, Mittel-/Ringfinger federn nach. Auf ~0.56 s, Zu ~0.71 s.
- **Rollover:** Daumen gibt frei, das Messer überschlägt sich einmal um das Zeigefinger-Endglied (Achse aus der FK,
  aus der Ebene heraus), Klinge/Bite flattern frei (Fliehkraft), Fang + Führung.
- **Aerial/Doppel-Aerial:** Ausholen (Handgelenk), Loslassen, echte Parabel in der Messer-Ebene (Wurf-g 780) mit
  konstanter Drehung um den Schwerpunkt, 2.5 Einheiten vor den Fingern; im freien Fall nur Fliehkraft auf die Kette;
  Fang am Ausgangspunkt wechselt offen/zu. Flugzeiten (0.35/0.36 s) so gewählt, dass die Klinge in keinem Frame die
  Hand berührt (Physik ist deterministisch, die Suche ist reproduzierbar).
- **Bühne:** während eines Messer-Tricks rückt die Hand 0.18 Bildhöhen nach rechts und 0.10 nach unten (Doppel-Aerial
  0.18 nach unten), weich ein/aus und Teil der Physik-Bewegung.
- **Helikopter (Surf)** unverändert, nur auf den neuen Griff umgestellt.
- **Prüfung:** `tests/handFoundation.test.ts` — Physik 30/60/144/240 Hz gegen 1200 Hz (< 0.02 rad), Bite einmal herum,
  Griff-Kontakt < 0.25, ausgeklappte Klinge in keinem Frame (60 + 144 Hz, alle Tricks, offen und zu) näher als 0 am
  Hand-Modell, Riegel, Handgelenk-Flick > 0.2 rad; Kosten ≤ 0.15 ms/Frame, 0 GC-Scavenges in 24 000 Frames (Node).

## Bewusste Abweichungen / Verträge

- `render/types`: neu `VM_KNIFE`, `VM_PARAM.knife = { latch: 0 }` (additiv). AGENTS.md §3.4 nachgetragen.
- vm-hash-Baseline bewusst neu geschrieben (Begründung im Kopf von `tools/cosmetics/vm-hash.mjs`).
- Bild-Hülle: das neue Messer reicht im Doppel-Aerial bis −0.338 Bildhöhen (Plan 006: −0.314); Auf/Zu/Rollover/Aerial
  bleiben innerhalb. Die Hülle für neue Gegenstände bleibt die dokumentierte (−0.314 / 0.055).
- Messer-Tricks kürzer (Physik): Abklingzeiten Rollover/Aerial/Doppel 0.9/1.0/1.1 s; event-probe grün, eine Warnung
  (L1 Hand 1.5°: 33.8 Tricks/min, Band 20–32; Plan-006-Gegenstände nur Hinweis).

## Offen (für Schritt 2 / Nutzer)

- **Kendama:** die hängende Kugel (Verlet-Schnur kennt die Hand nicht) liegt in Ruhe 0.57 im Daumen; Ken an der
  Handfläche −0.34. Schnur-Hand-Kontakt oder Schnurlänge/Anker im Kendama-Schritt lösen.
- **Spinner/Karte:** Kontakte −0.2 bzw. −0.14 sind gewollt (Handschuh drückt), aber knapp an der Testgrenze.
- **Finger-Kontakt live** (`GripSolver.close` in afterPose) ist API, beim Messer noch nicht genutzt (der Kniff hält
  das Messer, die übrigen Finger bleiben eingerollt); Fang-Schließen ist Posenwechsel + Nachfedern.
- Rollover-Klinge hat im offenen Zustand nur ~0.06 Abstand zur Handfläche (Modell ±0.25) — im Spiel ansehen.
- Gefühl mit echter Maus (Takt, Größe der Hand-Bühne) — Nutzer-Abnahme der neuen Messer-Tricks.
