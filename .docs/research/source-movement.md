# Recherche: Source-Movement (Referenz für den Port)

Quelle: Source SDK 2013 `game/shared/gamemovement.cpp`, Quake 3
`bg_pmove.c` / `cm_trace.c`, CS:GO/CS2-Cvar-Defaults. Hier in Y-oben übersetzt.

## Konstanten (CS2-Defaults)

| Cvar | Wert | Bedeutung |
|---|---|---|
| sv_gravity | 800 u/s² | |
| sv_jump_impulse | 301.993377 u/s | √(2·800·57) → 57 u Sprunghöhe, 0.755 s Luftzeit auf ebenem Boden |
| sv_accelerate | 5.5 | Boden |
| sv_airaccelerate | 12 | Luft (Bhop/KZ-Server: 100–150) |
| sv_friction | 5.2 | |
| sv_stopspeed | 80 u/s | |
| sv_maxvelocity | 3500 u/s | pro Achse |
| Air-Wishspeed-Cap | 30 u/s | hartcodiert in `AirAccelerate` |
| Stufenhöhe | 18 u | |
| NON_JUMP_VELOCITY | 140 u/s | |
| Hull stehend | 32×32×72, Auge 64 | |
| Hull geduckt | 32×32×54, Auge 46 | |
| Max-Speed Messer | 250 u/s | Laufen geduckt ×0.34, Shift-Walk ×0.52 |

## Warum Air-Strafing Geschwindigkeit bringt

Pro Tick ist der Zugewinn höchstens `add = cap − v·ŵ`. Optimal ist ein
Wunschvektor fast senkrecht zur Geschwindigkeit: dann ist `v·ŵ ≈ 0`, der
Zuschlag `a = min(accel·wishspeed·dt, cap)` steht senkrecht und die neue
Geschwindigkeit ist

    |v'|² = |v|² + a² + 2·|v|·a·cosθ,  mit |v|·cosθ = cap − a
          = |v|² + 2·a·cap − a²

Maximal (a = cap): `|v'|² = |v|² + cap²` → Gewinn pro Tick ≈ cap²/(2|v|).
Pro Sekunde bei Tickrate T: `T·cap²/(2|v|)`.

| |v| u/s | 64 Tick | 128 Tick |
|---|---|---|
| 300 | 96 u/s² | 192 u/s² |
| 500 | 58 u/s² | 115 u/s² |
| 1000 | 29 u/s² | 58 u/s² |

Folgen:
- 128 Tick verdoppelt den möglichen Gewinn — Bhop fühlt sich deutlich
  belohnender an. Deshalb 128.
- `airAccelerate` bestimmt, **wie breit** der Winkel-Bereich mit Gewinn ist
  (Fehlertoleranz), nicht die Obergrenze. Bei 128 Tick: 12 → a = 23 u
  (knapp unter Cap), 40 → a = 78 → auf 30 gekappt, fast jeder Winkel nahe 90° gewinnt.
- Der Gewinn fällt mit 1/|v| — Speed zu halten wird mit steigender Geschwindigkeit
  schwerer. Natürliche Obergrenze ohne künstliches Cap.
- Geradeaus mit W in der Luft: `v·ŵ = |v| > 30` → null Gewinn. Nur Strafen zahlt sich aus.
- Die nötige Drehrate des Blicks: pro Tick dreht der Geschwindigkeitsvektor um
  ≈ `a·sinθ/|v|` rad — bei 500 u/s und 128 Tick ≈ 0.43°/Tick ≈ 55°/s.
  Das ist menschlich gut machbar und genau die Maus-Hand-Koordination, die Spaß macht.

## Tick-Ablauf (FullWalkMove, vereinfacht)

```
CheckDuck
StartGravity:      vel.y -= gravity * 0.5 * dt   (nur in der Luft wirksam)
if jump pressed:   CheckJumpButton → vel.y = jumpImpulse (bei Crouch-Jump gleich), ground = null
if onGround:       vel.y = 0; Friction
if onGround:       WalkMove    else AirMove
CategorizePosition
FinishGravity:     vel.y -= gravity * 0.5 * dt   (nur in der Luft)
CheckVelocity      (Achsen-Cap)
```

## TryPlayerMove (Slide-Move, max. 4 Bumps)

- Box um `vel·timeLeft` tracen. Bei Treffer: Ebene sammeln (max. 5),
  Geschwindigkeit an allen gesammelten Ebenen clippen
  (`ClipVelocity(v, n, overbounce=1)`: `v -= n·dot(v,n)·overbounce`, danach
  Komponenten < 0.1 nullen). Bei zwei Ebenen: entlang der Knick-Kante
  (Kreuzprodukt) weiterlaufen; bei drei → stoppen.
- Wenn die Geschwindigkeit danach gegen die Ursprungsgeschwindigkeit zeigt
  (`dot(v, primal) ≤ 0`): stoppen (verhindert Zittern in Ecken).
- In der Luft auf einer steilen Fläche (`normal.y < 0.7`) ist genau dieses
  Clipping das **Surfen**: Gravitation zieht nach unten, Clipping lenkt entlang
  der Rampe, Air-Strafe "in die Rampe" addiert Speed.

## StepMove

Zweimal versuchen: (a) normal `TryPlayerMove`; (b) um `stepSize` hoch tracen,
`TryPlayerMove`, um `stepSize` wieder runter tracen. Nimm (b), wenn es
horizontal weiter kam **und** auf begehbarem Boden endet. Danach `StayOnGround`
(nach unten schnappen, wenn Boden innerhalb `stepSize` unter einem liegt und
begehbar ist) — sonst "hüpft" man Rampen herunter.

## Kategorisieren / Boden

Trace 2 u nach unten. Boden, wenn getroffen, `normal.y ≥ 0.7` und
`vel.y ≤ nonJumpVelocity` (140). Wer schneller nach oben fliegt (Rampe hoch
mit Speed), löst sich — das ist der Ramp-Launch.

## Ducken in der Luft

`FinishDuck` in der Luft: `origin += (standHeight − duckHeight)` nach oben,
View-Offset von 64 auf 46 → Auge bleibt in Weltkoordinaten stehen.
Crouch-Jump räumt so 57 + 18 = 75 u hohe Kanten, normaler Sprung ~57 u.
