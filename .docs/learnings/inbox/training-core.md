# Inbox: Strang training-core (Plan 007, Phase 2)

Zusammenführen in `fallen.md` macht Phase 3. Alle Befunde sind auf der finalen Physik (Cap 40, Lande-Gnade,
Hang-Schuld, Kanten-Assist, Rutschen, Luftlenkung) gemessen; Messskripte im Scratchpad `tc2/`.

## Judge: Gewinn bis zum letzten Luft-Tick — die Hang-Landung schenkt Tempo ohne Technik

Der Prototyp-Judge rechnete Gewinn = Landetempo − Absprungtempo. Auf einem Gefälle gibt die Hang-Landung (A4)
dabei Tempo: die Fehlerhand "A/D ohne Maus" rollte in T3 an den Schüssel-Rand, 10 % ihrer Urteile waren
'good' und sie bestand die Linkskurve 5/20. **Richtig:** Gewinn = Tempo im letzten Luft-Tick (prev im
Lande-Tick) − Absprungtempo; auf flachem Boden ändert die Landung |v_h| nicht, die Tabellen aus
`turnwindow.ts` bleiben (±0.1 u/s). Danach: ohne Maus 0/20, noMouse 100 %.

## "StrafeBots 1–3° ≥ 90 % gut" gilt bei 450–600 u/s für 3° nicht — die Fehl-Hops verlieren wirklich Tempo

StrafeBot 1° 100 %, 2° 99 %, 3° 80 % (300–450: 96 %). Die 33 Nicht-guten des 3°-Bots verlieren fast alle
Tempo (−1 … −68 u/s): bei 600 u/s ist das Gewinnfenster (cap/|v| ≈ 2.7°) kleiner als der Zielfehler. Der
v2-Prototyp hatte dasselbe (judgehigh.json: 3° bei 450–600 73 %); die Entwurfszahl "93–100 %" stammte nur
aus dem 300–450-Band. Einen Hop, der 30 u/s kostet, "gut" zu nennen, wäre gelogen → Warnung, keine
Schwellen-Kosmetik.

## T5: nicht der Radius, die Torbreite trägt — der Anfänger kreist ums verfehlte Tor

Plan-Stellschrauben (Tore 384, R 1200, 300 u/s, 0.3 s Boden) ergaben 12/20 (Soll 14). Messung: R 1500/1800
und mehr Rand 12/11/10, 5 Tore 14, 9 Tore 6, Tore 512 17/20, **576 19/20** (Median 38 s). Trace: die Hand
(feste Drehrate 60 °/s, Seite je Landung zum nächsten Tor) verfehlt ein Tor durch einen Fehl-Hop und kreist
danach um das nächste — ihr Kurvenradius ist enger als die Tordistanz — oder prallt mit 900 u/s an die
Bande. Breitere Tore fangen den Fehl-Hop auf; der Bogen bleibt ein Bogen (Durchmesser 1800–2900 u).

## Crouch-Reichweite aus dem Lauf ist 75 u, nicht 80 — die Bonus-Kante 76 ging nie

Einzelversuch-Raster (320 u/s, Absprungabstand × Duck-Zeit): 66 u → Absprung 20–180 u vor der Wand, Ducken
bis 0.45 s nach dem Absprung (das Tempo-Gedächtnis fängt spätes Ducken); 72 u → 20–140; 75 u → 60–130;
**76 u → nie**. Der Lip-Step (5 u) hilft nur knapp unter dem Scheitel, nicht auf die volle Crouch-Höhe.
Und: Vor-Ducken mit Sprint rutscht jetzt (≥ 280 u/s) — Sprung aus der Rutsche ist ein Crouch-Jump, die
Vor-Ducken-Hand schafft die 66er-Treppe 20/20 (v2: 25–55 %). "Erst springen, dann ducken" ist nur noch Rat.

## check.ts allein reicht nicht: der statische Validator findet, was Bots nie sehen

Alle Matrix-Zeilen waren grün, `levels:check -- training` meldete trotzdem 48 Fehler:
- Z-Fighting: Keile mit gleicher Dicke überlappen in Ecken (Walm) → koplanare Unterseiten/Stirnflächen;
  eine Bodenplatte bündig mit den Keil-Enden; eine Trennwand im Hang-Keil. **Richtig:** Stirnflächen nie
  auf dieselbe Ebene legen (Platte bis unter die Bande, Keile nur zwischen den Querkeilen, Dicken versetzt).
- Bodenmarkierungen müssen Parallelogramme sein (keine 16-Eck-Scheibe).
- Zonen, Tore und Stufen teilen EINEN id-Namensraum (Zone "rinne" + Stufe "rinne" = Fehler).
- Die Route muss den Ziel-Trigger (Portal) berühren — auch in Lektionen. Die Route darf dafür Umwege
  machen (T6: Portal-Nische, zurück an denselben Punkt; T7/T8: Route beginnt im Portal).
- Passbahn: der Validator fittet die Flugbahn exakt auf den Landeknoten. Landeknoten dicht hinter die Kante
  (60 u), Absprung passend (48er: 110 u; 66er-Crouch: 140 u bei 320 u/s; 72er: 120 u), sonst "stößt an".
**Richtig:** nach jeder Geometrie-Änderung `npm run levels:build -- training && npm run levels:check -- training`.

## Der RouteFollower ist kein Surf-Tempo-Modell

In T8 kam er nie über 800 u/s (Median 613): er regelt an der Flanke auf seine Knotenlinie und strafet dort.
Für Vorführung und Matrix der Surf-Lektionen deshalb `SurfHand` (Taste in die Rampe, Blick entlang der Achse
der Surf-Knoten — genau die Grundtechnik der Lektion): Demo 3/3, Grundtechnik ±3°/0.3 s 1000 u/s 20/20.

## Rutsch-Vorführung: wer hüpft, rutscht nicht

Der RouteFollower bhopt; vor dem T1-Tunnel war er in der Luft, als geduckt werden musste (0/3). createDemo
schaut jetzt voraus (Stand- gegen Duck-Hull entlang der Fahrt): niedrige Decke in 1.5 s → nicht mehr hüpfen,
in 0.35 s → ducken. Gegen die statische Welt getestet — ein geschlossenes Tor vor dem Tunnel ist keine Decke
(sonst sähe die Duck-Hull dieselbe Wand und die Vorführung duckte nie).

## Kleinigkeiten, die gebissen haben

- surfHold/surfSpeed: der Lücken-Zähler muss "nicht surfend" beginnen (∞). Mit 0 galt der erste Luft-Tick
  einer Stufe als Surf-Lücke — 900 u/s im Flug erfüllten "surfe 800".
- Crouch-Hand auf einer Treppe: die nächste Wand über z bestimmt → wer mit der Mitte 3 u vor der Wandlinie
  schon oben steht (Hull ±16), sprang dort erneut ab und lief rückwärts von der Stufe (12/20). Über die
  Höhe bestimmen (erste Wand, deren Oberkante über den Füßen liegt).
- T7 "10 s halten" war trivial: die Grundtechnik-Hand kriecht mit 100–250 u/s an der Flanke (Blickfehler
  +5–10° bremst bei hohem airaccelerate die Achsgeschwindigkeit), eine Fahrt dauert > 10 s. Meister jetzt:
  vier obere Marken mit ≥ 300 u/s.
- Allokation: der Tick-Pfad der Session ist nach Aufwärmen frei; je Hop-Urteil ~100–200 B (Ereignis, erlaubt).
  Ruft ein großer Aufrufer `tick(dt, …)`/`turnBand(speed)` ohne Inlining, boxt V8 die Double-Argumente
  (Harness mit update+turnBand im selben Loop: 13 B/Tick statt 2) — Vertragssignatur, nicht die Session.
