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

Der Cap hängt vom Horizontal-Tempo vor dem Schub ab (Plan 003): bis 350 u/s 32,
linear auf 24 bei 700 u/s, darüber 24 — die ersten Strafes zahlen sich sofort aus,
die Decke steigt um ≤ 5 %. Nur in freier Luft; an Surf-Flanken gilt der Basis-Cap
(Halten/Klettern ist darauf abgestimmt). Einzige Formel: `airSpeedCapAt`
(MovementConfig.ts) — Bots und HUD rufen dieselbe Funktion.

## 3. Was verboten ist

- Glättung/Beschleunigung/Filterung der Mausbewegung. Roh rein, sofort raus.
- Geschwindigkeits-Kappung in der Luft (kein `sv_enablebunnyhopping 0`-Cap).
- Stamina, Landestrafe, Sprung-Cooldown.
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

Diese Hilfen senken die Einstiegshürde für das *Timing* und nehmen Tasten-
Reflexen (W halten) die Strafe. Die Skill-Decke bleibt das Strafen (Sync von
Maus und A/D) — der perfekte Strafer ist mit Smart-Hop und Assist bitgleich.

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
  `land.jumpQueued=false` nicht "kein perfekter Hop" heißt (fallen.md #54).

Die **View-Hand** (Plan 004) ist kein Kamera-Effekt, folgt aber denselben Regeln: sie liest
Snapshot, Events und das Blick-Delta, wirkt nie zurück, und `motionFx` 0 friert sie in ihrer
Pose ein. Landungen hält auch sie einen Tick zurück (Bhop = leicht, fallen.md #54).

Stufen-Hochlaufen und Ducken am Boden (smoothstep) werden kameraseitig immer
geglättet, damit die Sicht nicht springt.

## 7. Jede Tuning-Änderung ist belegt

Werte in `MovementConfig` ändern sich nur mit Begründung in
`.docs/research/movement-tuning.md` — idealerweise mit Zahlen aus `npm run sim`
(Speed-Kurven Strafe-Bot vs. Geradeaus-Bot, Sprungweiten, Zeit bis Stillstand).
