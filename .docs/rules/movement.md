# Regeln: Movement (verbindlich)

Das Movement ist das Produkt. Diese Regeln sind nicht verhandelbar ohne
Eintrag in einem Plan unter `.docs/plans/`.

## 1. Source-Semantik ist die Referenz

`PlayerMovement` ist ein Port von Source `CGameMovement` (siehe
`.docs/research/source-movement.md`), nicht eine "inspirierte" Neuschreibung.
Reihenfolge pro Tick wie `FullWalkMove`:

1. Duck-Zustand aktualisieren (Hull wechseln, siehe §4)
2. Halbe Gravitation (`StartGravity`)
3. Sprung prüfen (inkl. Puffer + Coyote) — **vor** Friction
4. Am Boden: `velocity.y = 0`, Friction; dann `WalkMove` (Accelerate, StepMove, StayOnGround)
   In der Luft: `AirMove` (AirAccelerate, TryPlayerMove)
5. Kategorisieren (Boden-Trace 2 u nach unten, `normal.y ≥ 0.7`, `vel.y ≤ nonJumpVelocity`)
6. Zweite halbe Gravitation (`FinishGravity`), falls in der Luft
7. Geschwindigkeit pro Achse auf `maxVelocity` kappen

Weil der Sprung vor der Friction kommt, verliert ein Sprung im Landetick
**keine** Geschwindigkeit. Das ist Bhop. Der Sprungpuffer macht genau diesen
Tick erreichbar.

**Arcade-Abweichungen** (Plan 007, "Spaß, arcadig, smooth" statt 1:1-CS). Jede hat einen Schalter in
`MovementConfig`; im CS2-Preset steht er auf 0/aus, dort ist das Verhalten bitgleich zum Source-Port
(`npm run sim -- --preset cs2`). Zahlen: `npm run sim -- --section arcade`, movement-tuning.md "Arcade-Pass".

| Abweichung | Schalter | Wo im Tick |
|---|---|---|
| Knick-Projektion: `d = dir·vel` vor dem Kopieren (Bugfix, sonst \|v\| = 1 → Luft-Hänger in konkaven Ecken) | keiner (gilt immer) | 4, TryPlayerMove |
| Rampbug-Fix: Gegen-Ebene beim Surfen → Nachtrace 0.25/1/2 u entlang der Surf-Normale | `surfSeamFix` | 4, TryPlayerMove |
| Lande-Gnade (§5) | `landGraceTime` | 4, Friction/WalkMove |
| Hang-Landung: Landung auf Schrägen phasenfest, bergab Gewinn, bergauf kein Verlust (gestundet, §5), Richtung bleibt | `slopeLandGain` | 5, nach Categorize |
| Anfänger-Cap 40 (§2) | `airSpeedCapLow` | 4, AirAccelerate |
| Kanten-Assist (§5) | `ledgeStep`, `ledgeMemory` | 4, AirMove |
| Rutschen (§4) | `slideMinSpeed` (+ `slide*`) | 1 Duck, 4 Friction/WalkMove |
| Luftlenkung mit W (§5) | `airControl` (+ Einstellung) | 4, AirMove vor AirAccelerate |

Reihenfolge in Schritt 4 am Boden: **Lande-Gnade vor Rutschen vor Friction** — im Gnade-Fenster wirkt
keinerlei Reibung, auch keine Rutsch-Reibung; danach entscheidet der Rutsch-Zustand.

## 2. Die heiligen Formeln

```
Accelerate(wishdir, wishspeed, accel):
  current  = dot(vel, wishdir)
  add      = wishspeed - current;             if add <= 0 return
  accelspd = accel * wishspeed * dt;          accelspd = min(accelspd, add)
  vel     += wishdir * accelspd

AirAccelerate(wishdir, wishspeed, accel):
  cap      = airSpeedCapAt(|vel_h|)           // 32 → 24 (350…700 u/s); an Surf-Flanken 24
  wishspd  = min(wishspeed, cap)              // der Skill-Hebel (Source: konstant 30)
  current  = dot(vel, wishdir)
  add      = wishspd - current;               if add <= 0 return
  accelspd = accel * wishspeed * dt           // NICHT wishspd! Voller wishspeed.
  accelspd = min(accelspd, add)
  vel     += wishdir * accelspd

Friction:
  speed = |vel| (am Boden: horizontal);  if speed < 0.1 return
  control = max(speed, stopSpeed)
  drop = control * friction * dt
  vel *= max(speed - drop, 0) / speed
```

Luft-Strafe-Gewinn entsteht **nur**, weil `wishspd` gekappt, `accelspd` aber
mit vollem `wishspeed` gerechnet wird. Wer das "vereinfacht", löscht das Spiel.

Der Cap hängt vom Horizontal-Tempo vor dem Schub ab (Plan 003, Plan 007 A5): bis 350 u/s
**40**, linear auf 24 bei 700 u/s, darüber 24 — die ersten Strafes zahlen sich sofort aus
(4°-Hand bis 500 u/s in 1.8 statt 4.0 s), die Decke steigt um ≤ 8 % gegenüber Cap 24
(perfekt H20 1162 statt 1084). Nur in freier Luft; an Surf-Flanken gilt der Basis-Cap
(Halten/Klettern ist darauf abgestimmt). Einzige Formel: `airSpeedCapAt`
(MovementConfig.ts) — Bots und HUD rufen dieselbe Funktion.

## 3. Was verboten ist

- Glättung/Beschleunigung/Filterung der Mausbewegung. Roh rein, sofort raus.
- Geschwindigkeits-Kappung in der Luft (kein `sv_enablebunnyhopping 0`-Cap).
- Stamina, Landestrafe, Sprung-Cooldown. (Die Rutsch-Schub-Abklingzeit ist kein Sprung-Cooldown:
  sie begrenzt nur den +50-u/s-Schub beim Rutsch-Eintritt.)
- Physik in Frame-Zeit statt Tick-Zeit.
- Physik-Libraries, Kapsel-Collider, Rigidbodies.
- Walljump, Wallrun, Double-Jump (bewusst nicht in dieser Version).

## 4. Ducken

- **Am Boden**: Hull schrumpft von oben (Origin bleibt), Kamera sinkt weich in
  `duckTime`. Aufstehen nur, wenn die Stand-Hull frei ist.
- **In der Luft**: Hull schrumpft von unten — Origin springt um
  `standHeight - duckHeight` (18 u) nach oben, Augenposition in Weltkoordinaten
  bleibt identisch (kein Kamera-Ruck). Das ist der Crouch-Jump: +18 u
  Kantenhöhe. Aufstehen in der Luft senkt die Füße wieder, nur wenn frei.
- Geduckt am Boden: runSpeed × `duckSpeedScale` (85 u/s) — unabhängig von Sprint
  (Auto-Sprint hält Sprint dauerhaft).
- **Crouch-Jump nach Vor-Ducken** (Plan 003): ist die Hull beim Absprung vom Boden
  schon geduckt und über ihr Platz, springt sie direkt in die Luft-Duck-Geometrie
  (Füße +18, eyeHeight −18, Welt-Auge bleibt; danach eyeHeight mit Duck-Rate auf
  duckEye). Ducken und Springen ergeben so in jeder Reihenfolge den Crouch-Jump.
- **Rutschen** (Plan 007 A7, `slideMinSpeed` 280): Ducken am Boden ab 280 u/s → die Hull duckt
  sofort (schrumpft von oben, Origin bleibt), das Auge sinkt in `slideEyeTime` (0.06 s). Keine
  Bodenbeschleunigung, Rutsch-Reibung `v −= (0.3·v + 80)·dt` ohne stopSpeed, Lenken zur
  Blickrichtung mit 1.4 rad/s (nur bis 90° neben der Fahrt, Betrag bleibt), Hangabtrieb, keine
  Schritte. Schub +50 u/s (bis 380) nur aus dem Lauf: ≥ 0.25 s Bodenzeit, 2 s Abklingzeit —
  Landen + Ducken ist Verzeihen, kein Schub-Farmen (W-Farmer Ø 339 u/s). Ende unter 160 u/s
  (Duck-Walk) oder aufgestanden; unter einer Decke rutscht man weiter. **Kein Rutschen im
  Landetick mit Sprung** (der Sprung kommt vorher) — Bhop mit gehaltenem Ducken ist bitgleich.
  Sprung aus der Rutsche = Crouch-Jump. Verlässt die Rutsche den Boden **ohne** Sprung (Kante, Mulde,
  Kuppe), geht sie im ersten Bodentick weiter, solange die Hull geduckt ist und das Tempo ≥ 160 u/s
  (ohne Schub) — sonst würgte jede Bodenwelle sie unter 280 zum Duck-Walk ab (229 → 85 u/s in 0.3 s).
  Nach einem Sprung nicht: Crouch-Jump-Landungen auf schmale Ziele bremsen wie in Source.
  Events `slideStart {speed, boost}` / `slideEnd`, `PlayerSnapshot.sliding`. **Gemeldet erst nach der
  Lande-Gnade**: die Physik rutscht ab dem ersten Bodentick (keine Schritte), `sliding` und `slideStart` kommen
  aber erst, wenn die Reibung einsetzt — ein Sprung in der Gnade ist ein Crouch-Hop (clean), keine Rutsche.
  Sonst kratzte jeder 1–8 Ticks späte Crouch-Hop. `slideEnd` nur für gemeldete Rutschen.

## 5. Fehlerverzeihung ohne Skill-Verlust

- **Coyote-Time**: nach Verlassen einer Kante (nicht nach Sprung) noch
  `coyoteTime` springbar.
- **Jump-Buffer**: Druck bis `jumpBufferTime` vor der Landung wird im
  Landetick ausgeführt → perfekter Hop.
- **Auto-Hop** (Einstellung, Default an): gehaltene Taste hüpft im Landetick —
  als **Smart-Auto-Hop** (Plan 003): eine NUR gehaltene Taste springt am Boden erst,
  wenn keine Bewegungstaste gedrückt ist, das Tempo ≥ `autoHopSpeedShare` (0.97) ×
  Boden-Wunschtempo ist oder man ≥ `autoHopGroundTime` (0.2 s) steht. Strafer (A/D gedrückt)
  springen im ersten Bodentick nach ≥ `autoHopLandAirTime` (0.25 s) Luft schon ab
  `autoHopLandShare` (0.75) × Wunschtempo — sonst hing jede Strafe-Landung knapp unter 310 u/s
  bis 0.2 s am Boden. Reines W bleibt bei 0.97. Sonst friert
  jede langsame Landung ein (Sprung vor WalkMove → nie Bodenbeschleunigung →
  24-u/s-Mondhüpfen). Frischer Druck, Puffer, Mausrad und Coyote springen sofort;
  Bhop mit Tempo landet immer über der Schwelle. `land.jumpQueued` nutzt dieselbe
  Bedingung — beide nur zusammen ändern.
- **Strafe-Assist** (Einstellung `strafeAssist`, Default an): in der Luft zählt W/S
  nicht, solange A/D gedrückt ist (auch beim Surfen). Gehaltenes W dreht die
  wishdir zur Flugrichtung und frisst zwei Drittel des Gewinns; W+A an der
  Surf-Rampe nahm sonst jeden Druck in die Rampe. Reines A/D ist unverändert.
- **Mausrad = Sprung** (beide Richtungen), wie jeder Bhop-Spieler es bindet.

- **Lande-Gnade** (Plan 007 A3, `landGraceTime` 0.0625 s = 8 Ticks): nach einer Landung aus
  ≥ 0.1 s Luft keine Friction in den ersten 8 Bodenticks. Ein Sprung darin ist verlustfrei
  (`jump.clean`; `perfect` bleibt tick-genau), Kette und Sync reißen erst danach. **Schub-Kappe
  (Pflicht):** in der Zeit hebt Boden-Accelerate |v_h| nicht über max(Tempo davor, wishspeed) —
  ohne sie wäre die reibungsfreie Zeit Ground-Strafe (+18 % in 8 Ticks). Tipp-Hand ±20 ms:
  H20 742 → 1166 u/s. Mehr als 12 Ticks wäre "Eis" auf Stopp-Landungen.
- **Kanten-Assist** (Plan 007 A6, `ledgeStep` 5 u, `ledgeMemory` 0.2 s), nur in der Luft und nur
  bei frontalem Anprall (≤ 45° zur Wandnormalen) an eine senkrechte Wand:
  - Lip-Step: liegt begehbarer Boden höchstens 5 u über den Füßen, Stufe hoch und Landung auf der
    Kante (vel.y = 0, auch knapp vor dem Scheitel). **Nicht, solange der Rest-Aufstieg (v_y²/2g) die Kante um
    ≥ 2 u selbst überragt** — sonst schluckte er den Sprung direkt vor einer Stufe (8 ms Luft statt 0.7 s);
    dann gibt das Gedächtnis das Tempo oben zurück. Event `ledge {kind:'step', dy}`.
  - sonst Tempo-Gedächtnis: v_h vor dem Anprall kommt innerhalb von 0.2 s Luftzeit zurück, sobald
    die Hull höher frei ist (Steigen, spätes Ducken) und auf der alten Höhe weiter blockiert wäre.
    Ein schwächerer Folge-Anprall überschreibt es nicht. Event `ledge {kind:'vault'}`.
  - Wand-Tasche: kommt ein Luft-Move zwischen fast parallelen Wänden gar nicht vom Fleck (Source
    nullt die Geschwindigkeit → Schweben, solange W hineindrückt), fällt man senkrecht weiter.
  Kein Impuls von Wänden, höchstens 5 u Hub, nur auf begehbare Oberkanten → **kein Walljump**.
  Reichweite ohne Ducken aus dem Stand/Lauf 57 + 5 = 62 u, **aus der Auto-Hop-Landung bis 63.5 u**: die
  Landung schwebt bis 1.5 u über dem Boden (2-u-Sonde), der nächste Sprung startet dort. Mit Crouch-Jump
  **aus dem Lauf gemessen 75 u** (T6-Raster, 320 u/s: 72 u ab 20–140 u Absprungabstand, **76 u nie** — der
  Lip-Step hilft nur knapp unter dem Scheitel); in günstiger Phase mit Assist bis 80 u, aus der Auto-Hop-
  Landung rechnerisch ~81.5 u (`npm run sim -- --section arcade`), am Hang bergab mehr.
- **Luftlenkung mit W** (Plan 007 A8, `airControl` 1.6 → 0.8 rad/s zwischen 350 und 700 u/s,
  Einstellung "Luftlenkung mit W", Default an, CS2 aus): nur W, kein A/D, nicht an Surf-Flanken und
  erst 0.5 s nach dem letzten steilen Kontakt, Blick höchstens 90° neben der Flugrichtung. v_h dreht
  zur Blickrichtung, **der Betrag bleibt** — kein Gewinn, kein Strafe-Ersatz (320 u/s: W-Lenken
  ~34° in 0.3 s, perfekter Strafe ~98°). Ohne die Surf-Pause kippen Auffang-Designs (L2-S0).
- **Hang-Landung, gestundeter Verlust** (Plan 007 A4, `slopeLandGain`): bergauf verliert man nichts, aber der
  erlassene Clip-Verlust wird mit dem nächsten Bergab-Gewinn verrechnet (höchstens das Tempo über dem
  Lauftempo; teleport löscht). Ohne das pumpte jede Welle den Sprungimpuls in Tempo: W+Leertaste über
  10°-Wellen 320 → 785 u/s in 30 s, mehr als ein 3°-Strafer auf flachem Boden (H20 646). Jetzt einmal Gewinn, dann stabil (10°/1024: 430 u/s).
  Die Kappung nur auf die gewonnene Höhe reicht nicht (5°/512 wieder 353 → 542): auch der Abstieg erntet
  den Sprungimpuls.

Diese Hilfen senken die Einstiegshürde für das *Timing* und nehmen Tasten-
Reflexen (W halten) die Strafe. Die Skill-Decke bleibt das Strafen (Sync von
Maus und A/D) — der perfekte Strafer ist mit Smart-Hop, Assist, Lande-Gnade,
Rutschen und Luftlenkung bitgleich (nur Cap 40 hebt ihn, s. §2).

**Level-Regeln aus dem Arcade-Pass:**
- **Crouch-Kanten ≥ 66 u** (63.5 aus der Auto-Hop-Landung + 2 Reserve). Darunter kommt man ohne Ducken
  hoch; der Validator misst die Reichweite ("ohne Ducken 0 Erfolge", Warnung unter 2 u Reserve). Kanten, die
  MIT Crouch-Jump sicher gehen sollen, ≤ 72 u (T6-Bonus). Von einer flachen Terrasse mit gehaltener
  Leertaste prallen 25–38 % der Anläufe ab (Hop-Phase, Lead: bleibt so) — Absprungmarke **zweistufig**:
  durchgehendes Band, wo ein Crouch-Jump bei jedem realen Tempo sauber ist (L4: Hull-Front 32–104 u ab 250 u/s),
  Streifen davor für "mit Tempo" (112–208 u ab 450 u/s); die Probe beginnt beim langsamsten realen Tempo
  (250 u/s: Wiederholer nach Anprall, Neulinge, Respawn), Kosten per Gabelung messen (fallen.md #130, #164, #165).
- **Banden, die einen Tod verhindern, ≥ 128 u** — oder sichtbar niedrig und darüber ein unsichtbarer Clip
  (L2-Ring, L4-Wendel/Steg: bis 256 u über der Bahn, Dach nach innen geneigt, n.y < 0.7). 80 u reichen seit dem
  Kanten-Assist nicht mehr: Crouch-Hop + Assist bis 80 u, am Hang trifft die AABB-Hull eine Bande mit der
  Talecke (−6 u), bergab fehlt die Hanghöhe (fallen.md #133). Probe: Flucht nach außen, 0–80° zur Wand,
  Hop/Crouch-Hop/Ducken gehalten, bergauf/bergab — mit Gegenprobe am alten Stand.
- **Treppen** mit Setzstufe 32–40 u: das Gedächtnis gibt nach dem Anprall Tempo zurück, das in die nächste
  Setzstufe trägt (Doppel-Anprall, systematisch +0.2 bis +1.0 s für den perfekten Bot). Auftritt ≥ Hop-Weite
  beim Zieltempo oder Stufen ≤ 18 u (laufbar). 24er und 48er Setzstufen gewinnen mit dem Assist.
- **Surf-Gehrungskurven:** Achsgefälle ≥ 6° und Knick ≤ 4° je Fuge (≥ 12 Stücke je 45°) → ≤ 4 %
  Energieverlust an der Innenflanke; gröbere Gehrungen 6–10 % trotz Rampbug-Fix (Geometrie, keine Naht).
- Nie ohne Messung: lange begehbare Gefälle vor Lücken (Hang-Landung + Rutschen geben Tempo, Energie-
  begrenzt), Duck-Tunnel länger als ~0.6 × Rutschstrecke. Wellen pumpen nicht mehr (sim "Hügel-Pumpe"),
  geben aber einmal Tempo (10°: +110 u/s); Rutschen den Hang hinunter ist davon unberührt (Hangabtrieb).

## 6. Kamera ist Gefühl, nicht Physik

Head-Bob, FOV-Kick, Lande-Dip, Roll und Screenshake wirken **nur** auf
die Kamera, nie auf Hull oder Velocity. Alle skalieren mit den Einstellungen
und müssen auf 0 abschaltbar sein (Plan 003):

- `headBob` = nur der Lauf-Bob.
- `motionFx` = Bewegungs-Feedback: Lande-Dip (weich gesättigt), Perfekt-Hop-Pop,
  Carve-Roll (aus der Querbeschleunigung, nicht aus der A/D-Taste), Surf-Lean
  (zur Rampennormale) und Sync-Surge. Die FOV-Anteile (Pop, Surge) zusätzlich × `fovKick`.
- `fovKick` = Tempo als FOV: Log-Kurve, 6° pro Verdopplung über 250 u/s, weiches
  Knie bei 800 u/s (10.07°) → Kappe 11° gesamt (Speed + Pop + Surge; 116.5° bei 16:9, Runde 2).
  Kein Sprint-Term.
- `screenShake` = nur Translation (+ höchstens 0.3° Roll) — Yaw/Pitch bleiben exakt
  der Blick. Das Surf-Rumpeln hängt ebenfalls daran.
- Perfekter Hop = kein Dip. Jede Landung wird einen Tick zurückgehalten, weil
  `land.jumpQueued=false` nicht "kein perfekter Hop" heißt (fallen.md #54). Gelobt (Pop, Landewelle)
  wird jeder verlustfreie Hop (`jump.clean`, auch in der Lande-Gnade); ist die Landung da schon als Dip
  nachgeholt, läuft der Dip ohne Positionssprung aus.

Rutschen (Plan 007): kein Head-Bob (keine Schritte), Carve-Roll aus dem Lenken, Rumpeln nur als
Translation × `screenShake` × `motionFx` (0.15 u beim Eintritt bis 0.5 u ab 900 u/s). Der Lip-Step
ist wie eine Stufe Ruck-Schutz (immer an): die Kamera gleicht genau den Teil aus, den die
Interpolation schon zeigt (`CameraView.tickAlpha`, `rig.onTick()`), und baut ihn linear in 0.1 s ab.

Die **View-Hand** (Plan 004) ist kein Kamera-Effekt, folgt aber denselben Regeln: sie liest
Snapshot, Events und das Blick-Delta, wirkt nie zurück, und `motionFx` 0 friert sie in ihrer
Pose ein. Landungen hält auch sie einen Tick zurück (Bhop = leicht, fallen.md #54).

Stufen-Hochlaufen und Ducken am Boden (smoothstep) werden kameraseitig immer
geglättet, damit die Sicht nicht springt.

## 7. Jede Tuning-Änderung ist belegt

Werte in `MovementConfig` ändern sich nur mit Begründung in
`.docs/research/movement-tuning.md` — idealerweise mit Zahlen aus `npm run sim`
(Speed-Kurven Strafe-Bot vs. Geradeaus-Bot, Sprungweiten, Zeit bis Stillstand).
