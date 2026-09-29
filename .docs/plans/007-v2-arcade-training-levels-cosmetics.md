# Plan 007 — v2: Arcade-Movement, Trainingsmodus, Level 3/4, Kosmetik v2

**Stand:** 2026-09-29 · **Status:** umgesetzt (Phase 0–3; Mensch-Playtest S6 und die Lead-Fragen in §10 offen)

## Problem

Nutzerwunsch 2026-09-28 (sinngemäß):
- Movement muss nicht 1:1 CS sein. Es soll **Spaß machen, arcadig, smooth und befriedigend** sein.
- **Trainingsmodus**: keine Strafe-Trainer-Leiste, sondern Tutorial-Maps, die wirklich beibringen, wie man spielt, strafet und Speed aufbaut.
- **Level 3** (reine Surf-Map) und **Level 4** (vertikaler Turm): ja.
- **Replays** erst mit Datenbank, also nicht in diesem Plan.
- **Kosmetik**: mehr Gegenstände (Jo-Jo, Fidget-Spinner, Münze über die Knöchel, Feuerzeug-Flick, Kendama, Handy mit Selfie im Ziel) und Hand-Skins (Roboter, Skelett, Gold, Katzenpfote). **Kein Trail, keine Musik-Packs.**

Harte Grenzen bleiben: **kein Walljump, kein Wallrun, kein Double-Jump**. Die Skill-Decke ist weiter das Strafen (Sync von Maus und A/D).

Grundlage sind sechs gemessene Entwürfe:
- momentum: `tools/critique/v2/momentum`
- arcade-mechanics: `tools/critique/v2/arcade-mechanics`
- training: `tools/critique/v2/training`
- level3: `tools/critique/v2/level3`
- level4: `tools/critique/v2/level4`
- kosmetik: `tools/critique/v2/kosmetik`

Die Ausgaben liegen jeweils unter `shots/v2/<thema>/`. Dieser Plan ist die Synthese: was gebaut wird, was nicht, in welcher Reihenfolge und wer welche Dateien besitzt.

---

## 1. Stichproben der Synthese (gegen den echten Code)

| Behauptung | Prüfung | Ergebnis |
|---|---|---|
| Knick-Projektion in `tryPlayerMove` ist kaputt (level4) | `PlayerMovement.ts:925` `vel.copy(dir).multiplyScalar(dir.dot(vel))`; numerisch nachgestellt | **bestätigt.** `dot` wird nach `copy` ausgewertet, also ist \|v\| immer 1. Ein-Zeilen-Fix |
| `resumeIndex` prüft keine Höhe (level4) | `tools/levels/physics.ts:409` prüft nur x/z | **bestätigt** |
| SpeedCurve-Cache-Schlüssel unvollständig (momentum) | `physics.ts:83` | **bestätigt.** Es fehlen `airSpeedCapLow`, `FadeFrom`, `FadeTo`, `sprintSpeed`, `strafeAssist` |
| Lande-Gnade 8 ist auf den heutigen Leveln grün (momentum) | `levels-grace8.txt` gegen Baseline | **bestätigt:** 0 F, Mulden-Verlust L1 0.30 → 0.16 s |
| Slide, Kanten-Assist und Luftlenkung sind grün (arcade-mechanics) | Der Entwurf maß nur designProbes und Spiel-Uhr, **nicht** den vollen Validator. Nachgemessen: `levels:check`, alle drei global installiert, dazu Gnade 8 | **bestätigt, 0 F / 2 W.** L1 Hand 2° 7/8 → 8/8, sync 1.0 25.1 → 24.3 s, Hand 3° 38.4 → 37.6 s. L2 unverändert |
| Gesamtpaket (Slide/Kante/Luft/Gnade/Hang/Cap 40) kippt die chaotischen Proben (momentum) | nachgemessen, derselbe Aufbau plus `MOM=slope`, `MOM_SLOPE_DIR=1`, `MOM_SLOPE_SLIDE=1`, Cap 40 | **bestätigt, 2 F**, beide in L2: Ausfahrt 1/600 bei 580 u/s, Versatz 96, und S0 1/12 bei Blick −15° + Leertaste. Dazu L1 sync 1.0 25.1 → **29.3 s** auf dem heutigen Layout. Könner-Inseln lohnen jetzt (6/6, Ø 2.24 s), neu als Warnung: Hand 1° 6/8. **Ein L1/L2-Durchgang ist Pflicht** |
| „Medaillen bleiben mit Kanten-Assist" (arcade-mechanics) | `build.ts` MEDAL_MODELS: Bronze = Hand 3° × 1.05 | **teilweise falsch.** Der 3°-Median ändert sich (−0.7 s), also auch Bronze. Irrelevant, weil Phase 3 alle Medaillen neu baut |
| Rampbug-Fix lässt L1/L2 bitgleich (level3) | `regress-base.txt` gegen `regress-fix.txt` | **bestätigt:** nur die Laufzeitzeilen unterscheiden sich |
| Der Typecheck ist sauber | `npx tsc --noEmit` | **falsch:** 12 Fehler in `tools/critique/v2/level3` (`sweepWelle.ts` und veraltete Varianten). Phase 0 räumt auf |
| L3 und L4 teilen die Tonart F | `LevelFile.music.root` | **harmlos.** `root` liest im Code niemand (kein Nutzer in `src/audio`). L4 bekommt trotzdem G für später |
| Kurven-Lektion T5 lehrt Anfänger (training) | `validate.txt` | **zu hart:** Der ordentliche Anfänger besteht den Bogen nur **4/20**, obwohl der Entwurf „RouteFollower 5° 20/20" als Maßstab nimmt. Deshalb entschärfen (T5 unten) |
| Freischaltung „finish" über BestTimes (kosmetik) | Training-Entwurf: Lektionen erzeugen keine Bestzeit | **Widerspruch.** Ersetzt durch die Anforderung `{kind:'training'}` aus `TrainingProgress` |

Die Nachmessungen liefen mit der unveränderten `tools/validate-levels.ts`. Geladen waren `--import tools/critique/v2/momentum/patch.ts` und ein Import, der `installGlobal({slide, ledge, air})` aus `arcade-mechanics/ArcadeMovement.ts` mit den Default-Werten aufruft. Laufzeit: ~30 s je Variante.

---

## 2. Entscheidungen: Arcade-Movement

**Leitprinzip:** Momentum geht nie durch Zufall (Tick-Phase), durch Millisekunden-Pech oder durch einen Bonk verloren. Schwerkraft zahlt sich aus. Es gibt ein neues Verb (Rutschen). Die Skill-Decke bleibt das Strafen.

Jede Abweichung ist ein Feld in `MovementConfig`. Im CS2-Preset steht es auf 0/aus, dort bleibt alles bitgleich zu heute.

| # | Mechanik | Werte (VELOCITY) | Gefühl / Beleg | CS2 |
|---|---|---|---|---|
| A1 | **Knick-Projektion-Fix** (Bug) | `along = dir·vel` vor dem copy | Luft-Hänger in konkaven Ecken weg (Wall-Cling widerspricht der Vision): cornercling 21/72 → 0, Wendel 63/702 → 0 | gilt immer (Bugfix) |
| A2 | **Rampbug-Fix** `surfSeamFix` | Nachtrace 0.25/1/2 u entlang der letzten Surf-Normale bei Gegen-Ebene (cos < −0.5, \|v_h\| > 100) | Kurven sind überhaupt erst surfbar: 9–83 → 0–1 Nahtstopps/108. L3 ohne Fix: 41 Nahtstopps. L1/L2 bitgleich | aus |
| A3 | **Lande-Gnade** `landGraceTime` | 0.0625 s (8 Ticks) keine Friction nach ≥ 0.1 s Luft. In der Zeit hebt Boden-Schub \|v_h\| nicht über max(davor, wishspeed). Die Kette reißt erst danach | Tipp-Hand ±20 ms: H20 732 → 1142 u/s. Später Sprung (4 Ticks, 700 u/s) 593 → 700. Die Schub-Kappe ist Pflicht, ohne sie gemessen +18 % Exploit. Perfekter Bot bitgleich | 0 |
| A4 | **Deterministische Hang-Landung** `slopeLandGain` | 1. Bergab gewinnt man in jeder Phase, bergauf verliert man nichts. Die Richtung bleibt, die Rampslide-Entscheidung ist phasenfest | Beendet die Lotterie: 10° bergab 320–415 → immer 415; 16° bergauf 172–320 → 320. W+Space-Kette auf 16°: 320 → 656 u/s. Die Energie-Decke wird nie überschritten. Kippt 2–3 chaotische L1/L2-Proben (siehe §1) | 0 |
| A5 | **Anfänger-Cap** `airSpeedCapLow` | 32 → **40** (Fade 350/700 bleibt) | 4°-Hand bis 500 u/s: 4.0 → 1.8 s. 5°-Hand erreicht 500 in 8/8 statt 4/8 Seeds. Perfekt H20 +2.1 % (Testgrenze 1140 → 1170). Abstand perfekt/3° bleibt (1.82 → 1.77) | 0 |
| A6 | **Kanten-Assist** `ledgeStep`/`ledgeMemory` | Lip-Step ≤ 5 u, danach Landung auf der Kante (`vel.y = 0`). Tempo-Gedächtnis 0.2 s. Nur frontal (≤ 45°), nur in der Luft | Bonk → Kriechen beseitigt: gekrochen 15–23/40 → 1/40. Spät geduckt kommt man mit 77–86 % statt 15 % Tempo an. Turm 48/192: 7.1 → 3.2 s. **Crouch-Kante ohne Ducken 0/200.** Level-Regel: Crouch-Kanten ≥ 57 + 5 + 2 = **64 u** (umgesetzt: **≥ 66 u**, die Auto-Hop-Landung schwebt bis 1.5 u; §10) | 0 |
| A7 | **Rutschen (Slide)** `slide*` | Eintritt ab 280 u/s geduckt am Boden. Reibung 0.3 1/s + 80 u/s². Schub 50 bis 380, nur aus dem Lauf (≥ 0.25 s Boden, 2 s Abklingzeit). Lenken 1.4 rad/s. Hangabtrieb an. Ende < 160 u/s. Auge in 0.06 s | Neues Verb: Landung 800 + Ducken, Sprung nach 0.2 s: 272 → 737 u/s. Duck-Tunnel 768 u bei 900: 9.1 → 1.17 s. Bots rutschen nie, dadurch bitgleich. W-Farmen +5 % | `slideMinSpeed` 0 |
| A8 | **Luftlenkung mit W** `airControl*` + Setting | Nur W, kein A/D: v_h dreht zur Blickrichtung, 1.6 rad/s bis 350 u/s, dann linear auf 0.8 rad/s bei 700. Der Betrag bleibt. 0.5 s Pause nach steilem Kontakt | Slalom-Tode von Anfängern 30 → 22. W-Halter kommen durch L2 CP1→CP2. Strafer bitgleich. Kein Vorteil für Könner: W-Lenken 32° in 0.3 s, Strafen 98° | Setting aus |

**Reihenfolge in `friction()`:** Lande-Gnade vor Rutschen vor normaler Friction. Im Gnade-Fenster wirkt keinerlei Reibung, auch keine Rutsch-Reibung. Danach entscheidet der Rutsch-Zustand.

**Prestrafe** (Boden-Strafe W+A/D + Maus, bis 387 u/s) bleibt Physik wie heute. Er wird in T4 gelehrt und in movement-tuning.md dokumentiert.

Movement-Regeln, die sich ändern (movement.md):
- §2: Der Cap-Satz „Decke +≤ 5 %" wird zu „+≤ 8 % gegenüber Cap 24 (Cap 40)".
- §4 neu: „Rutschen".
- §5 neu: „Lande-Gnade", „Kanten-Assist", „Luftlenkung".
- §1: neue Abweichungsliste mit Rampbug-Fix und Hang-Landung.
- Neue Level-Regel: „Crouch-Kanten ≥ 64 u" (umgesetzt: ≥ 66 u, §10).

---

## 3. Entscheidungen: Inhalte

### Level 3 — „03 BRANDUNG · Halt die Linie."
Umgesetzt wie im Prototyp (`tools/critique/v2/level3/level3.ts`, DEFAULT_L3):
- Aufbau: Startbrett → W1 → 180°-Kehre, dann R1/Z → Finale-Kicker → Strand.
- **Gabel:** KORALLE innen (schmal, kein Netz, kurz) gegen TÜRKIS außen (Bande, Auffang-Band, lang).
- Neuer Vertrag `LevelFile.safeRoute`: Bronze und Silber werden auf der sicheren Linie gemessen, Gold, VELOCITY und Autor auf `route`.
- Prototyp mit Fix: safeRoute 0 F, Koralle sync 1.0 17.54 s gegen Türkis 19.46 s, 0 Tode.
- Der Endtangenten-Fix in `dropFrom` macht aus 174° echte 180°.
- Keine Pads, keine Boosts. Tempo kommt aus Höhe und Linie.

### Level 4 — „04 TURM · Tempo ist Höhe."
Umgesetzt wie im Prototyp (`tools/critique/v2/level4/level4.ts`):
- Wendel E1–E4 um den Kern, drei Podest-CPs.
- E2 Innenbahn mit Gräben als Wahl, E3 zwei 64-u-Crouch-Kanten (umgesetzt: 66 u).
- Steg mit Geländer (Clip + Deko), Krone (CP4), Sprungbrett, Surf-Abfahrt mit 4 Drops (CP5).
- **Keine Jump-Pads:** gemessen verschlechtern sie die Graben-Rettung (bis 6 s festhängen).
- Wird in Phase 2 **gegen die neue Physik neu gebaut**. A4 und A6 verändern den Aufstieg stark: bergauf landen kostet nichts mehr, Stufen-Bonks verzeihen.
- Tonart G.

### Trainingsmodus
Datengetriebene Lektions-Maps (`LevelFile.training`), aufgebaut aus diesen Bausteinen:
- **StrafeJudge**: Urteil pro Sprung (good / wOnly / noSide / noMouse / against / wHeld / tooFast / late / tooSlow / weak), Treffsicherheit 93–100 %.
- **TrainingSession**: Stufen, Aufgaben, Tipps, Tore.
- **GatedWorld**: Tore lösen sich auf.
- **Vorführung per Taste H**: Bot in Ich-Perspektive mit Showkeys.
- **Lektionskarte im HUD**, Zielband am Maus-Drehbalken.
- **Fortschritt mit Sternen** (`velocity.training.v1`).
- Kein Tod möglich, kein Timer, keine Bestzeit, kein Ghost.

| Lektion | Inhalt | Gruppe |
|---|---|---|
| T1 ERSTE SCHRITTE | Laufen, Springen (Mulden), Stufe 48, **Rutschen unter dem Tunnel** (Sprint + C) | Grundlagen |
| T2 AUTO-HOP | Leertaste halten statt hämmern, Kette ×6, Gräben | Grundlagen |
| T3 AIR-STRAFE | Arena 4800² mit Schüssel-Rand: 5 links, 5 rechts, 6 im Wechsel (verzeihend) | Grundlagen |
| T4 SPEED | Oval, endlos: 400, dann 5 Landungen ≥ 400; Bonus **Prestrafe** (≥ 350 u/s am Boden vor dem 1. Hop) und 500; Meister 600 | Grundlagen |
| T5 KURVEN | Luft-Tore auf dem Bogen, **entschärft** (siehe Phase 2) | Fortgeschritten |
| T6 CROUCH-JUMP | 48 / 64 (/ 72 Bonus): „erst springen, dann ducken" (umgesetzt 48 / 66 / 72) | Fortgeschritten |
| T7 SURF: HALTEN | 3°-Rampe, Einstieg 120 u unter dem First, 40 u Drop | Fortgeschritten |
| T8 SURF: SPEED | 10°-Kette, 800 → Drop → 1000 | Fortgeschritten |

Nicht in v2: T9 (optionale Mechanik-Lektion, das Rutschen steckt in T1), T10 (Prüfung) und der Vorflieger-Ghost.

### Kosmetik v2
- Registry-Umbau: ViewModel `items/*` und `skins/*`, ViewHand `PROP_FACTORIES`. Dazu `VM_RIG`/FK im Vertrag und neue PropTricks-Haken (onCheckpoint, onSurfStart, onSurfEnd, sub/string/param/skinFx).
- **Skins:** Gold, Roboter, Skelett, Katzenpfote.
- **Gegenstände:** Jo-Jo (Verlet-Schnur, Unterschritt 1/240 s, Scheinkraft ×1.5, Deckel 0.6 g), Spinner, Münze, Sturmfeuerzeug, Kendama, **Handy inkl. echtem Selfie im Ziel**. Das Selfie hat der Nutzer ausdrücklich gewünscht: Rückansicht 96×54 plus Peace-Hand, einmal im Ziel-Frame, der Timer steht dabei.
- **Surf-Zustände für alle Gegenstände**, auch Dose, Karte, Messer. Nötig, weil L3 eine reine Surf-Map ist.
- Budget: ≤ 50 Draw Calls, ≤ 12 000 Dreiecke je Kombination.
- Kein Trail, keine Musik-Packs, keine Gegenstand-Sounds.

### Werkzeug-/Medaillen-Entscheidungen
- sync-1.0-Medaillen (Gold, VELOCITY, Autor) werden als **Median über 5 Start-Jitter** (umgesetzt: 49, dazu Zweig-Warnung; Bronze/Silber über 48 Seeds, §10) gemessen, nicht als ein deterministischer Lauf. Begründung: Einzelläufe sind chaotisch (L4 Autor 23.9–27.9 s je Variante; L1 25.1 → 29.3 s im Gesamtpaket).
- `levels:build -- <id>` schreibt nur diese Level-Datei und **nicht** index.json. index.json baut nur Phase 3.
- Jeder Strang schreibt Erkenntnisse nach `.docs/learnings/inbox/<strang>.md`. Phase 3 führt sie in `fallen.md` zusammen, damit Dateibesitz disjunkt bleibt.

---

## 4. Verworfen

| Idee | Grund |
|---|---|
| Jump-Pads als Brush-Eigenschaft | Kein Konsument in L1–L4 oder im Training v2. L4 gemessen: schlechter (Graben-Rettung bis 6 s festhängend, Kronen-Katapult kostet Surf-Tempo). L3-Regel: „schnelle Linie spart Weg, nicht Höhe". Vertrag in 5 Modulen für null Nutzen. Später mit einem Level, das sie braucht |
| Kicker-Rampen `launch` (opt-in) | Kein Konsument: L3 und L4 validieren ohne. Global: 3 F (Inselnasen werden Schanzen) |
| Boost-Pads, Speed-Ringe | Boost als Respawn-Hilfe gemischt (−1.1…+0.5 s). Ringe: perfekter Bot 8/8 im Graben der Hop-Reihe |
| Surf-Halten mit W | levels:check 1 F (S0). L1-Rutsche für W-Halter langsamer (4.6 → 6.8 s). Untergräbt die Surf-Lektion (A/D in die Rampe) |
| Globaler Rampen-Absprung, Boden-Carving, Soft-Cap | 3 F; Friction dominiert (Kurve bei 800 endet bei 321); unnötig (Bots ≤ 1123 u/s) |
| Lande-Gnade > 12 Ticks | „Eis" auf Stopp-Landungen (Drop 800: nach 0.1 s noch 800) |
| Air-Step 18 u / Lip ≥ 8 u | Öffnet die Crouch-Kante (12–27/200) |
| Slide-Schub 70/400/1 s | W-Farmer +16 % |
| Luftlenkung ohne Surf-Pause | S0-Probe 1/12 tot |
| Landungsrolle (Kamera) | Verletzt „Blick 1:1". Lebt nur als Hand-Tuck beim Rutschen weiter |
| Cap-Alternative 44/350/550 | Hände plateauen früher (3°-Hand H20 596 statt 629). 40/350/700 ist der größere Aha-Effekt |
| Respawn-Schub (L3) | Unnötig: CPs aus dem Stand liefern 700–1140 u/s am nächsten CP |
| Landungs-Assist auf Surf-Flanken (L3) | Ändert das Surf-Gefühl global, kein Bedarf in L3 v1 |
| Dritte Crouch-Kante in L4 | Nach dem Playtest entscheiden |
| T9 optionale Mechanik-Lektion | Rutschen ist Teil von T1, Pads gibt es nicht |
| T10 Prüfung, Vorflieger-Ghost | Auf später verschoben; Ghost-Linien kommen mit Replays und Datenbank |
| Freischalt-Anforderung „finish" über BestTimes | Lektionen erzeugen keine Bestzeit → `{kind:'training'}` |
| 1-Platz-Sprungpuffer für Tricks | Gemessen +0–16 Prozentpunkte; der Engpass ist die Abklingzeit |
| Gegenstand-Sounds | Bräuchte eine AudioApi-Erweiterung, außerhalb des Plans |
| Replays, Trail, Musik-Packs | Nutzer |

---

## 5. Verträge (Phase 0, vor allen parallelen Strängen)

Alle Felder sind so eingeführt, dass sich das Verhalten nicht ändert. Die Physik ignoriert neue Felder, bis Phase 1 sie umsetzt. `airSpeedCapLow` bleibt in Phase 0 bei 32.

**`src/player/MovementConfig.ts`** — neue Felder (VELOCITY / CS2):
- Lande-Gnade: `landGraceTime` 0.0625 / 0.
- Hang-Landung: `slopeLandGain` 1 / 0.
- Rampbug-Fix: `surfSeamFix: boolean` true / false.
- Kanten-Assist: `ledgeStep` 5 / 0, `ledgeMemory` 0.2 / 0.
- Rutschen:
  - `slideMinSpeed` 280 / 0 (0 = aus)
  - `slideExitSpeed` 160
  - `slideFriction` 0.3
  - `slideDecel` 80
  - `slideBoost` 50
  - `slideBoostCap` 380
  - `slideBoostMinGround` 0.25
  - `slideBoostCooldown` 2.0
  - `slideSteerRate` 1.4
  - `slideSlopeGravity` 1
  - `slideEyeTime` 0.06
- Luftlenkung: `airControl` 1.6 / 0, `airControlHigh` 0.8, `airControlFadeFrom` 350, `airControlFadeTo` 700, `airControlSurfGrace` 0.5.
- TuningPanel und `NumericMovementKey` ziehen nach.
- **Phase 1** setzt `airSpeedCapLow` 32 → 40.

**`src/player/types.ts`**
- `PlayerSnapshot.sliding: boolean` (diskret, nicht interpoliert; `copySnapshot`/`createSnapshot`).
- `MovementEvent` 'jump' bekommt `clean: boolean` (perfekt oder in der Lande-Gnade).
- Neue MovementEvents:
  - `{type:'slideStart'; speed; boost: boolean}`
  - `{type:'slideEnd'; speed}`
  - `{type:'ledge'; kind:'step'|'vault'; speed; dy}`

**`src/world/level/LevelFormat.ts`**
- `LevelFile.safeRoute?: readonly RouteNode[]`: sichere Linie einer Gabel, gleicher Start und gleiches Ziel. Nur für Bots, Validator und Medaillen.
- `LevelFile.prepLessons?: readonly string[]` und `LevelIndexEntry.prepLessons?` (Menü: „Empfohlen: T7/T8").
- `LevelFile.training?: TrainingDef`: schließt `medals` und `parTime` aus.
- `TrainingDef` = `{lesson, short, group: 'basics'|'advanced', zones?, gates?, stages, hud?: {forceKeys?, turnBand?}}`.
- `StageDef` = `{id, title ≤16, text ≤2×40, task: TaskDef, rank?: 'required'|'bonus'|'master', opens?, spawn?, demo?: DemoDef, tips?}`.
- `TaskDef` =
  - `reach{zone}`
  - `hopChain{count}`
  - `goodHops{count, side, minSideShare?}`
  - `speed{min, holdHops?, ground?}`
  - `surfHold{seconds}`
  - `surfSpeed{min}`
  - `crouchLand{zone, count}`
  - `course{zones, minSpeed, airborne?, groundGrace?}`
  - `event{event, count}`
- `DemoDef` = `hand{rateDeg, pattern, side?, seconds}` | `route{from, to, aimNoiseDeg?, seconds}`.
- Zonen und Tore als Box: `{id, min, max, tint?}`.
- `TrainingIndexEntry {id, name, subtitle?, file, lesson, short, group}` für `public/levels/training/index.json`.

**`src/world/level/compileLevel.ts`** und Kollision
- `CompiledLevel.gates: readonly CompiledGate[]` mit `{id, brush, bounds, tint}`. Tore liegen **nicht** in `world`.
- `CompiledLevel.zones: ReadonlyMap<string, Box3>`.
- `BrushWorld`: `clipBoxToBrush` wird exportiert. `GatedWorld` kommt erst in Phase 2.

**`src/engine/events.ts`** — neue RunEvents:
- `{type:'lessonHop'; verdict; gain; counted; count; goal}`
- `{type:'lessonStage'; index; total; rank; lessonDone}`
- `{type:'gate'; id; open}`

**`src/engine/trainingTypes.ts`** (neu):
- `Verdict`, `VERDICTS`.
- `TrainingSessionApi`:
  - Methoden `tick(dt, prev, cur, cmd, hullH, out)`, `onEvent`, `update(frameDt)`, `respawnPoint()`, `skipStage()`, `restartLesson()`, `turnBand(speed)`.
  - Eigenschaften `hud`, `gateOpen: Float32Array`, `suspended`, `done`, `stars`, `completedStageIds`.
- `TrainingProgressView {stars(lessonId): 0|1|2|3; lessons(): readonly TrainingIndexEntry[]}`.

**`src/engine/settingsTypes.ts`**
- `GloveId` + `'gold'|'robot'|'skeleton'|'cat'`.
- `HeldItemId` + `'yoyo'|'spinner'|'coin'|'lighter'|'kendama'|'phone'`.
- `GameSettings.airControl: boolean` (Default an).
- `BindAction` + `'demo'` (Default `['KeyH']`).
- Alter Stand lädt über `sanitizeSettings`.

**`src/engine/Settings.ts`**
- `movementConfigFor`: ist `airControl` aus, gilt `airControl: 0`.
- `SettingsStore.update`: Das CS2-Preset schaltet `airControl` aus, genau wie `strafeAssist`.

**`src/engine/Unlocks.ts`**
- `UnlockId` bekommt 10 neue IDs: `glove.gold|glove.robot|glove.skeleton|glove.cat|item.yoyo|item.spinner|item.coin|item.lighter|item.kendama|item.phone`.
- `UnlockRequirement = {kind:'medal'; levelId; medal} | {kind:'training'; group:'basics'|'all'; minStars: 1|3}`.
- `deriveUnlocks(levels, best, training?: TrainingProgressView)`.
- `UNLOCKS` nach der Tabelle in §7.
- `gloveUnlock`, `itemUnlock`, `unlockPatch` und `grantEarnedFor` ziehen nach; `grantEarnedFor` wertet nur `kind:'medal'` aus.
- Speicherformat v3 bleibt.

**`src/render/types.ts`**
- `ViewModelGlove` und `ViewModelItem` wie in den Settings.
- Neu: `VM_RIG` (Finger- und Daumenmaße aus ViewModel.ts), `VM_STRING_POINTS = 9`, `VM_PARAM` (Kanaltabelle).
- `ViewModelFrame` bekommt:
  - `subPos`, `subRot` (Float32Array 3)
  - `subSpin`, `subVisible`
  - `stringPts` (Float32Array 27), `stringCount`
  - `propParam` (Float32Array 4)
  - `skinFx`
- `RendererApi` bekommt `snapshot(w, h): HTMLCanvasElement | null` und `selfie(w, h, vm: ViewModelFrame): HTMLCanvasElement | null`. Beide laufen außerhalb des Frame-Pfads.
- `RenderFx.gateOpen?: Float32Array`.
- `setLevel` baut die Tore aus `level.gates`, ohne Signaturänderung.

**`src/ui/types.ts`**
- `HudData.lesson?: LessonHud | null` mit `{lessonTitle, stageTitle, text, count, goal, style, rank, stageIndex, stageTotal, demo}`.
- `HudKeys.turnBand?: {lo, hi} | null`.
- `MenuScreen` + `'training'|'lessonDone'`.
- `LessonResult` mit `{lessonId, name, stars, stages[], nextLessonId, unlocked}`.
- `MenuEvents` + `demo`, `skipStage`.
- `FinishResult.photo?: HTMLCanvasElement`.

**`src/audio/types.ts`**
- `MusicDrive.sliding?: boolean`.

**Nicht-Verträge mit Tool-API**
- `tools/levels/physics.ts`: `resumeIndex` bekommt eine y-Prüfung (Signatur gleich), `withRoute(level, 'route'|'safeRoute')`.
- `tools/levels/lib.ts`: `SurfPath`, `dropFrom`, `catchBand`, `surfPad`, `Helix`, `railing`, `placeNodes`, `surfCheckpoint(axis)`, `chainKillZones`, `finishAfterLaunch`.
- `PropTricks`: Haken und Ausgabefelder wie in §3.

---

## 6. Bauplan

Regeln für alle Stränge:
- Jeder Strang besitzt disjunkte Pfade. Engpass-Dateien haben pro Phase genau einen Besitzer (Tabelle unten).
- Pro Strang gilt: `npm run typecheck` 0, `npm test` grün. Eigene Erkenntnisse gehen nach `.docs/learnings/inbox/<strang>.md`.
- Commits laufen einzeln je Strang, gemergt wird am Phasenende.

| Engpass | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|---|
| `src/engine/Game.ts` | contracts (nur Kompilier-Stubs) | movement | training-ui | integration |
| `src/ui/Menu.ts` (+ menu.css) | contracts (Schalter „Luftlenkung mit W") | cosmetics-core | training-ui | integration |
| `src/world/level/LevelFormat.ts` | contracts | — (eingefroren) | — | integration |
| `src/engine/Unlocks.ts` | contracts | — | — | integration |
| `src/engine/settingsTypes.ts` / `Settings.ts` | contracts | — | — | integration |
| `src/render/PS2Renderer.ts` | contracts (Stubs) | cosmetics-core | training-ui | integration |
| `src/audio/Sfx.ts` | — | movement | training-ui | integration |
| `src/engine/debug.ts` | — | cosmetics-core | training-ui | integration |
| `tools/levels/{lib,physics,build}.ts`, `tools/validate-levels.ts` | — | level-tools | — (eingefroren, Stubs) | integration |
| `tools/levels/designProbes.ts` | — | level-tools | l1l2 | integration |
| `public/levels/index.json` | — | — | — (nicht committen) | integration |

### Phase 0 — Verträge und Aufräumen (seriell, ~1 Tag)
Ein Strang `contracts`:
- **C1:** Typecheck grün. Die veralteten L3-Varianten reparieren oder löschen (sweepWelle, level3_v3–v5). `tools/critique/v2` und `shots/v2` als Referenz committen.
- **C2–C5:** alle Verträge aus §5, jeweils mit Nutzer-Stubs, sodass alles kompiliert und sich bitgleich verhält.
- **C6:** AGENTS.md §3.4, Abschnitt „Plan 007 Verträge". Status dieses Plans auf „in Arbeit".

**Abnahme:**
- `tsc` 0 (heute 12).
- `npm test` grün.
- `npm run sim` zeilengleich zu `shots/v2/momentum/sim-baseline.txt`.
- `levels:check` zeilengleich zu `levels-baseline.txt`, bis auf die Laufzeiten.
- `npm run shot` 38/38.
- `viewmodel-shots compare` pixelgleich.

**Umgesetzt (28.09.)** — Liste aller neuen Felder in AGENTS.md §3.4 "Plan 007 Verträge". Abweichungen und
Entscheidungen, die spätere Stränge kennen müssen:
- `sweepWelle.ts` gelöscht: `L3Params` hat keine `welle*`-Felder mehr, das Skript hätte fünfmal dieselbe
  Variante gemessen. Ergebnis bleibt in `shots/v2/level3/sweepWelle.txt`. `level3_v3–v5`/`_acht`
  repariert (Prism-Zweig wie in `level3.ts`), bleiben Referenz. `.gitignore`: `shots/*` + `!shots/v2/`.
- **`PENDING_UNLOCKS`** (Unlocks.ts): die 10 neuen Freischaltungen stehen in `UNLOCKS` und werden von
  `deriveUnlocks` gemeldet, aber `sync`/`grantEarnedFor` vergeben sie nicht — sonst bekäme ein Spieler mit
  L1-Silber ein Jo-Jo angelegt, das noch niemand zeichnet. Admin/`unlockAll` setzen alle 14.
  **Phase 3 (integration) leert die Menge** und streicht die L3/L4-Ausnahme im Test "echte Level-Medaillen".
- `VM_RIG` ist die einzige Quelle der Fingermaße; `ViewModel.ts` liest sie (pixelgleich, 44 Kacheln).
- `CS2_CLASSIC`: nur die Hauptschalter sind 0/false, die Rutsch-/Lenk-Nebenwerte stehen wie bei VELOCITY
  (Startpunkt fürs Tuning-Panel, wirkungslos ohne Hauptschalter).
- Vorführungs-Taste: `BindAction` 'demo' → `InputAction` 'demo' (InputState). Die Tasten-Zeile im Menü und
  die Game-Logik baut training-ui.
- `viewmodel-shots compare` wartet in Echtzeit im Spiel (fallen.md #57, nicht reproduzierbar); die
  Pixelgleichheit ist über `tools/viewmodel-sheet.mjs` (dev/viewmodel.html, deterministisch) belegt.

### Phase 1 — Movement-Arcade-Pass ‖ Level-Werkzeug ‖ Kosmetik-Kern (parallel)

**Strang `movement`** (~5 Tage). Aufgaben der Reihe nach, jede einzeln gemessen:
1. **M1 Knick-Fix.**
   - Vitest „W in eine konkave Ecke gedrückt → fällt".
   - `cornercling` 0/72, `fixcheck` 0/702.
   - L1/L2-levels:check zeilengleich.
2. **M2 Rampbug-Fix** (Port aus `level3/pmFix`, ohne Debug-Zweige, ohne Allokation).
   - `probeCurveSweep` 45°, Innenflanke: ≤ 1 Nahtstopp/108 und ≤ 5 % Energieverlust.
   - L1/L2 zeilengleich.
3. **M3 Lande-Gnade.**
   - Sprung k = 1…8 Ticks nach der Landung bei 400/700/1000 u/s → Absprungtempo = Landetempo (±1e-6); k = 9 verliert genau einen Friction-Tick.
   - Exploit-Probe ≤ 500.0.
   - Tipp-Hand ±20 ms: H20-Median ≥ 1100.
   - Perfekter Bot bitgleich.
4. **M4 Hang-Landung.**
   - `slopeland` Tabelle A (5–35°, 320/600/1000, 57/192 u): max − min über 16 Phasen < 3 u/s.
   - Keine Bergauf-Landung ohne Rampslide unter dem Anflugtempo.
   - W+Space-Kette 10° ≥ 500, 16° ≥ 640, nie über √(v0² + 2gΔh).
   - Flach bitgleich.
5. **M5 Cap 40.**
   - `feel.ts`: 4°-Hand bis 500 u/s ≤ 2.0 s; 5°-Hand ≥ 7/8; 3°-Hand H10 ≥ 620.
   - Perfekt ab 250: H5 700–735, H10 875–905, H20 ≤ 1170.
   - CS2-Paritätstest grün.
6. **M6 Kanten-Assist.**
   - Crouch-Kante ohne Ducken 0/200.
   - Gekrochen ab 600 u/s ≤ 2/40 je Tempo.
   - Spätes Ducken Ø ≥ 75 %.
   - Treppe 48/192 perfekt ≤ 3.5 s.
   - Kamera-Sprung beim Step ≤ 1.5 × mittlerer Frame-Anstieg.
7. **M7 Rutschen.**
   - Sprint + C: nach 0.1 s ≥ 345 u/s, Rutschdauer bis < 160 u/s ≥ 1.0 s.
   - Landung 800 + Ducken, Sprung nach 0.2 s ≥ 700.
   - Tunnel 60×768 bei 900: ≤ 1.3 s, Ausgang ≥ 450.
   - Hang 25°/1024: Ausgang ≥ 480.
   - W-Farmer Ø ≤ 1.1 × 320.
   - Slide-Hop ohne Schub ≤ 305.
   - Sprung im Landetick: 0 Rutsch-Ticks. Keine footstep-Events beim Rutschen.
   - Im Gnade-Fenster keine Rutsch-Reibung.
8. **M8 Luftlenkung.**
   - Bei 320 u/s: 30–35° in 0.3 s, Tempo ±1.
   - Wirkungslos mit A/D, an Flanken und ≤ 0.5 s nach steilem Kontakt.
   - Setting aus = bitgleich.
9. **M9 Rückmeldung.**
   - CameraRig: Rutsch-Auge und Rumpeln × `screenShake`, Head-Bob aus beim Rutschen, Step-Versatz beim Lip-Step.
   - Sfx: Rutsch-Kratzen, Griff-Klack, Vault-Whoosh.
   - Game setzt `MusicDrive.sliding`.
   - Abnahme: `camera.test` grün, `audio:check` grün, motionFx/screenShake 0 → kein Rumpeln.
10. **M10 Sim und Doku.**
    - `npm run sim` mit Abschnitt „Arcade".
    - movement.md und movement-tuning.md (neue Runde mit allen Zahlen).
11. **M11 Übergabe.**
    - levels:check auf den heutigen JSONs laufen lassen. **Erwartet und dokumentiert** sind nur die chaotischen L1/L2-Proben aus §1 (L2 Ausfahrt 1/600, L2 S0 1/12, L1-Warnungen).
    - Jede andere Abweichung ist ein Fehler dieses Strangs.
    - Die Liste geht an den Strang `l1l2`.

Besitz: `src/player/**` (außer `bots/`), `src/audio/Sfx.ts`, `src/ui/TuningPanel.ts`, `src/engine/Game.ts`, `tools/sim.ts`, `tools/sim/**`, Tests `tests/{movement,camera,coach,ghost,input,loop-hud}.test.ts`, `.docs/rules/movement.md`, `.docs/research/movement-tuning.md`.

**Strang `level-tools`** (~3 Tage):
- **T1 physics.ts:**
  - `resumeIndex` mit y-Prüfung.
  - SpeedCurve-Schlüssel vollständig.
  - `withRoute`.
  - Abnahme: L1/L2 zeilengleich; Test „zwei Configs in einem Prozess → verschiedene Kurven"; L4-Prototyp ohne `dropShadowNodes` besteht die Validator-Abschnitte.
- **T2 lib.ts:**
  - `SurfPath`/`dropFrom` (Endtangenten-Fix), `catchBand`, `surfPad`.
  - `Helix`, `railing`, `placeNodes`, `surfCheckpoint(axis)`, `chainKillZones`, `finishAfterLaunch`.
  - Abnahme: Die Prototypen L3/L4 lassen sich mit den lib-Funktionen nachbauen. JSON ist byte-gleich zu den Prototyp-Ausgaben, außer der dokumentierten Kehre (180° ±0.5°). L1/L2-Build byte-gleich.
- **T3 safeRoute:**
  - Validator: Surf-Raster, Surf-Übergang bei 320 u/s und Respawn-Surfer sind Pflicht auf `safeRoute`, auf `route` nur Warnung.
  - build: Bronze und Silber auf `safeRoute`, falls vorhanden.
  - Abnahme: Level ohne `safeRoute` ergeben einen identischen Report.
- **T4 build.ts:**
  - Registry mit Stubs `level3.ts`, `level4.ts`, `training/index.ts`.
  - Filter `-- <id>` ohne index.json.
  - sync-1.0-Median über 5 Start-Jitter (±16 u quer, ±1° yaw). Umgesetzt: 7 × 7 = 49 Zellmitten.
  - Abnahme: Medaillen-Reihenfolge hält; die L1/L2-Abweichung zur Einzelmessung ist dokumentiert (nicht committen).
- **T5 designProbes/selftest:**
  - Stubs `probes/level3.ts` und `probes/level4.ts`.
  - Neue Selbsttest-Fehler: Bande-Lücke, Schatten-Knoten, Crouch-Kante < 64 u „ohne Ducken erreichbar".
  - Abnahme: Selbsttest ≥ 28/28.
- **T6 Validator-Hook für Trainings-Level:**
  - Kein `training` zusammen mit Medaillen.
  - Textlängen, Referenzen.
  - Aufruf des Stubs `tools/levels/training/check.ts`.

Besitz: `tools/levels/{lib,physics,ballistics,build,designProbes,selftest,medalProbe}.ts`, `tools/validate-levels.ts`, die Stub-Dateien, `tests/levels.test.ts`, `.docs/research/level-design.md`.

**Strang `cosmetics-core`** (~5 Tage):
- **K1 Registry-Umbau:** `VM_RIG`/`fk.ts`, Items/Skins, `PROP_FACTORIES`, PropTricks-Haken. Abnahme: Dose, Karte, Messer **pixelgleich** (`viewmodel-shots compare`, Differenz 0); `fk.test`: UI-FK = three-Welt.
- **K2** vmGeometry und vmMaterials erweitern: Superellipse, Lappen, Fell, Vertex-Farbe, Glanzband, `mergeGeometries`.
- **K3 Gold**, **K4 Roboter** (LED pulst mit der Kick), **K5 Spinner**.
- **K6 Kosmetik-Kachelraster** mit Fortschritt „2/4" und Vorschau-Phasen Surf/Checkpoint.
- **K7** `PS2Renderer.snapshot` echt; `selfie` delegiert an `src/render/selfie.ts` (Stub).
- **K8 Hand-Reaktionen** auf slideStart/slideEnd/ledge: Pose flat tief und außen, Griff, Vault.
- **K9** `ui/hand/rope.ts` plus Tests:
  - Geführte Enden exakt.
  - Pendel bei 30 Hz ≤ 2.5 px, bei 60 Hz ≤ 1.3 px.
  - 20 000 wilde Schritte ohne NaN.

Abnahme für alle Kombinationen (Skin × Gegenstand):
- `viewModelCalls` ≤ 50 und ≤ 12 000 Dreiecke.
- alloc-probe: kein Hand-Modul unter den Top-Allokatoren.
- motionFx 0 → statisch.

Besitz: `src/render/viewmodel/**`, `src/render/selfie.ts`, `src/render/PS2Renderer.ts`, `src/ui/hand/**`, `src/ui/Menu.ts`, `src/ui/menu.css`, `src/engine/debug.ts`, `tests/{cosmetics,viewHand,rope,fk}.test.ts`, `tools/viewmodel-shots.mjs`, `tools/viewmodel-sheet.mjs`, `tools/cosmetics/**` (envelope, event-probe, unlock-ladder aus dem Prototyp), `.docs/rules/look.md`.

### Phase 2 — Inhalte auf der neuen Physik (parallel)

Voraussetzung: movement und level-tools sind gemergt.

**Strang `level3`** (~2 Tage):
- `tools/levels/level3.ts` aus dem Prototyp auf lib bauen, gegen die neue Physik nachmessen und `probes/level3.ts` schreiben.
- Look-Pass: Außenbande als schlanker Leuchtbalken, Mondfarbe, Leuchtturm.

Abnahme:
- `levels:check -- level3` 0 F. safeRoute: jedes Raster 100 %, 0 Nahtstopps, Respawn-Surfer CP1–3.
- sync 1.0/0.8, Hand 1°/2°/3° auf beiden Linien 8/8, 0 Tode.
- Gabel-Nutzen: route/safeRoute sync 1.0 ≤ 0.93, Hand 3° ≤ 0.90.
- VELOCITY < safeRoute sync 1.0.
- Kehre 180° ±1°.
- Außenbahn fängt 12/12 W-Halter.
- Kein Pad < 64 u an einer Linie.
- Grundtechnik-Surfer an jedem CP ≥ 700 u/s.
- Frame-Zeit ≈ L2, 0 Konsolenfehler.

Besitz: `tools/levels/level3.ts`, `tools/levels/probes/level3.ts`, `public/levels/level3.json`, `tests/level3.test.ts`, `.docs/research/levels/level3.md`.

**Strang `level4`** (~2 Tage):
- `tools/levels/level4.ts` auf lib bauen (`Helix`, `railing`, `placeNodes`, ohne Schatten-Knoten-Workaround), gegen die neue Physik nachmessen, Tonart G.
- `probes/level4.ts` schreiben.
- Look: Geländer, `underTrim`, Wendel-Unterseite aufhellen.

Abnahme:
- `levels:check -- level4` 0 F / 0 W.
- 8 Modelle 8/8, 0 Tode vor CP4.
- Hand 3° ≥ 1.15 × sync 1.0; sync 1.0 zwischen 22 und 30 s.
- Bande: ≥ 700 Geradeaus-Hüpfer, 0 Tode, 0 Hänger > 0.25 s.
- Crouch-Kanten: ≥ 95 % oben in ≤ 4 s, ohne Ducken 0.
- Innenbahn ≥ 20 % kürzer, Rettung aus dem Graben ≤ 2 s.
- Anfänger W+Space+Ducken ohne Tod bis CP4 in ≤ 45 s.
- Drop-In ≥ 95 %.
- Launch sync 1.0 ≥ 950 u/s, Ziel-Reserve ≥ 10 %.

Besitz: `tools/levels/level4.ts`, `tools/levels/probes/level4.ts`, `public/levels/level4.json`, `tests/level4.test.ts`, `.docs/research/levels/level4.md`.

**Strang `l1l2`** (~1–2 Tage):
- Die M11-Liste abarbeiten:
  - L2 exitTiers (580 u/s, Versatz 96; 1100 u/s)
  - L2 s0Catch (Blick ±15° + Leertaste)
  - L1 Hand 1° und Abschnitt CP2→CP3
- L1 retunen.
- `levels:build -- level1` bzw. `-- level2`.

Abnahme:
- `levels:check -- level1 level2` 0 F.
- L1-Autor ≤ 23.35 s (heute 22.24 + 5 %; ungetunt 25.9–29.3).
- Crouch-Kante ≥ 64 u (umgesetzt 66 u).
- Surf-Rutsche fängt weiter jeden (250 Läufe, auch mit Luftlenkung).
- Könner-Inseln lohnen (Hand 1° ≥ 5/6, ≥ 1 s).

Besitz: `tools/levels/level1.ts`, `tools/levels/level2.ts`, `tools/levels/designProbes.ts`, `public/levels/level{1,2}.json`.

**Strang `training-core`** (~4 Tage):
- **TC1 `strafeJudge.ts`:** Schwellen (`goodGainAt`, `tooFastRate`) per `turnwindow.ts` **gegen die neue Physik** neu erzeugen.
- **TC2** `Training.ts` (implementiert `TrainingSessionApi`), `TrainingProgress.ts`, `GatedWorld.ts`.
- **TC3** `BeginnerHand.ts`.
- **TC4** Lektionen T1–T8 (`tools/levels/training/*`), Build nach `public/levels/training/`.
- **TC5** `training/check.ts` als Bot-Matrix.

Abnahme (je 20 Seeds, Grenze 120 s):
- Die Demo besteht jede Pflichtstufe deterministisch.
- T1/T2: NaiveBot 'hold' und RouteFollower 5° je 20/20; T1-Rutschstufe mit Sprint + C 20/20.
- T3: ordentlicher Anfänger ≥ 18/20.
- T4-Oval ≥ 18/20.
- **T5 entschärft:** ordentlicher Anfänger ≥ 14/20 (heute 4/20). Stellschrauben: Tore 384 breit, R 1200, minSpeed 300, 0.3 s Bodenkontakt erlaubt. Umgesetzt: 5 Tore (je 45°), 576 breit als ehrliche Streifen-Zonen: 16/20.
- T6-64 mit Markierung ≥ 18/20, ohne Ducken 0/20.
- T7: Grundtechnik ±6°/0.6 s 20/20.
- T8 ≥ 18/20.
- Fehlerhände 0/20: nur W + Maus, gegen die Maus, ohne Maus, W+Leertaste (T3/T4); nur W / nichts / Taste weg von der Rampe (T7).
- Diagnose ≥ 90 % je Fehlerbild.
- StrafeBots 1–3° bei 300–600 u/s ≥ 90 % „good".
- GatedWorld ohne geschlossene Tore positionsgleich zu BrushWorld (L1/L2, 8 Seeds, jeder Tick).
- Tick-Pfad allokationsfrei.
- Fortschritt überlebt Neuladen; ein kaputter Stand lädt leer.

Besitz: `src/engine/{strafeJudge,Training,TrainingProgress}.ts`, `src/player/bots/BeginnerHand.ts`, `src/world/collision/GatedWorld.ts`, `tools/levels/training/**`, `public/levels/training/**`, `tests/{training,strafeJudge,gatedWorld}.test.ts`.

**Strang `training-ui`** (~4 Tage). Er arbeitet gegen `TrainingSessionApi`; die finale Abnahme erfolgt nach dem Merge von training-core.
- **TU1 Game:**
  - Lektion → TrainingSession und GatedWorld.
  - Kein Timer, keine Bestzeit, kein Ghost.
  - Respawn-Punkt der Stufe.
  - Demo H mit Fade, jede Taste beendet sie.
- **TU2 HUD:** Lektionskarte statt Timer, Urteil am Gain-Popup, Zielband, Coach-Band.
- **TU3 Menü:**
  - Knopf TRAINING, Neulings-Band.
  - Liste mit Sternen und EMPFOHLEN.
  - `lessonDone`, Pause-Einträge.
  - Admin: Lektion abhaken oder zurücksetzen.
- **TU4 Coach:** Judge-Hinweise nur < 600 u/s, in Lektionen aus.
- **TU5 Tore:** `gateVisuals` (additiver Vorhang, Screen-Door-Auflösen). Sfx: Blip pentatonisch, Akkord, Sweep, kein Straf-Sound.
- **TU6** Playwright `tools/training-shots.mjs` (Port 5304).

Abnahme:
- Jede Lektion lädt.
- H startet die Demo, eine Taste beendet sie; der Spieler steht danach am Stufen-Spawn, der Fortschritt bleibt unverändert.
- Der Bot schließt jede Stufe ab.
- Ein Tor öffnet: Kollision weg, Visual aufgelöst.
- Ergebnis mit Sternen.
- 0 Konsolenfehler.
- `hudLayout`: mittleres 30-%-Band frei.
- Frame-Callback +< 0.05 ms.

Besitz: `src/engine/{Game,Coach,Input}.ts`, `src/engine/debug.ts`, `src/ui/{Hud,hudLogic,Menu}.ts`, `src/ui/menu.css`, `src/render/{gateVisuals,PS2Renderer}.ts`, `src/audio/Sfx.ts`, `tests/coach.test.ts`, `tools/training-shots.mjs`.

**Strang `cosmetics-items`** (~8 Tage):
- **KI1 Jo-Jo:** Takt kalibriert (Sleeper 0.7 s, pass 0.5 s).
- **KI2 Sturmfeuerzeug:** bläst ab 950 u/s aus.
- **KI3 Katzenpfote:** mit Silhouetten-Runde.
- **KI4 Skelett**, **KI5 Münze** (Kopf/Zahl = Split).
- **KI6 Kendama.**
- **KI7 Handy:** Feed, Tacho, Split, Gimbal beim Surf; **Selfie** in `selfie.ts` (Rückansicht 96×54, Peace-Hand).
- **KI8 Surf-Zustände** für Dose, Karte, Messer.
- **KI9 Hand-Reaktion** auf lessonStage (Faust) und lessonDone (Daumen hoch).

Abnahme:
- Jeder neue Gegenstand: event-probe L1/L2 (sync 1.0 und Hand 1.5°) mit 25–45 % Trick-Anteil und 20–32 Tricks/min.
- Auf L2 ≥ 80 % der Surf-Zeit ≥ 500 u/s mit sichtbarem Surf-Zustand.
- Bild-Hülle nie über −0.314 oder links von 0.055 (außer beim Foto).
- dt-Unabhängigkeit ≤ 0.01 (30/60/144/240 gegen 1200 Hz), 20 000 Schritte ohne NaN.
- Selfie: ein Welt-Durchgang im Ziel-Frame, Frame danach < 25 ms.
- **Nutzer-Abnahme** der Katzenpfote im ingame-Blatt.

Besitz: `src/render/viewmodel/**`, `src/render/selfie.ts`, `src/ui/hand/**`, `tests/{cosmetics,viewHand,rope}.test.ts`, `tools/viewmodel-shots.mjs`, `tools/cosmetics/**`.

### Phase 3 — Integration und Neuvalidierung (seriell, ~2 Tage)
Ein Strang `integration`:
- **I1 `levels:build` komplett:** L1–L4 plus Training, index.json, alle Medaillen neu. Alte Ghosts verfallen über die Level-Signatur.
- **I2 Freischalt-Leiter** mit den finalen Medaillen neu messen (`tools/cosmetics/unlock-ladder.ts`). UNLOCKS nur ändern, wenn die Leiter bricht.
- **I3 Ziel:**
  - Handy-Selfie als Polaroid im Ergebnis (`FinishResult.photo`).
  - HUD-Stempel „FOTO".
  - Levelliste „Empfohlen: T7/T8" aus `prepLessons`.
- **I4 Gesamtprüfung:**
  - tsc, vitest, sim.
  - `levels:check` 0 F über alle Level und Lektionen.
  - `npm run shot`, `npm run playtest` (4 Level, 0 Konsolenfehler, Ø 60 fps).
  - alloc-probe L3/L4/T3.
  - ghost-check L3/L4.
  - viewmodel-shots, training-shots, admin-shots.
- **I5 Doku:**
  - AGENTS.md: §1 Kosmetik-Liste, §2 Befehle, §3.4.
  - Inbox in `fallen.md` zusammenführen.
  - `level-design.md` verlinkt `levels/level3.md` und `level4.md`.
  - Plan-Status „umgesetzt".
  - Checkliste für den S6-Mensch-Playtest.

Abnahme:
- Alle Prüfungen grün.
- Medaillen streng fallend in allen 4 Leveln.
- Leiter monoton; jeder Spielertyp unter Top hat ein nächstes Ziel.
- Admin „Alles freischalten" = 14.

---

## 7. Freischalt-Tabelle

| Freischaltung | Bedingung | Warum |
|---|---|---|
| Fidget-Spinner (`item.spinner`) | Training Grundlagen T1–T4 bestanden (★) | Erste Belohnung; die Drehzahl lehrt „Tempo zählt" |
| **Roboter-Hand** (`glove.robot`) | Training komplett T1–T8 bestanden (★) | Jeder, der spielen lernt, bekommt einen Skin |
| Münze (`item.coin`) | Bronze in L1–L4 | Sammelziel für Einsteiger (Bronze = 3°-Hand) |
| Jo-Jo (`item.yoyo`) | L1 Silber | |
| Sturmfeuerzeug (`item.lighter`) | L2 Silber | |
| Kendama (`item.kendama`) | L3 Silber | |
| Handy (`item.phone`) | L4 Silber | Selfie im Ziel |
| Neon-Handschuh (`glove.neon`, bestehend) | L1 Gold | |
| **Skelett-Hand** (`glove.skeleton`) | L2 Gold | Früher erreichbarer Top-Skin (1.5°-Hand schafft L2-Gold) |
| Sammelkarte (`item.card`, bestehend) | L1 VELOCITY | |
| Dose (`item.can`, bestehend) | L2 VELOCITY | |
| Butterfly-Messer (`item.knife`, bestehend) | L1 + L2 VELOCITY | |
| **Gold-Handschuh** (`glove.gold`) | Gold in L1–L4 | Gold für Gold |
| **Katzenpfote** (`glove.cat`) | VELOCITY in L1–L4 | Die Krone |

- Sammelziele zeigen ihren Fortschritt („GOLD in allen 4 Leveln 2/4").
- Verdiente Freischaltungen bleiben erhalten (die Ableitung fügt nur hinzu).
- Admin kann alles.
- Gemessene Leiter (Bot-Spielertypen, kosmetik/unlock-ladder): 2 → 3 → 7 → 8 → 9 → 14. Phase 3 misst sie mit den finalen Medaillen neu.

---

## 8. Risiken

- **Chaotische Level-Proben** (fallen.md #72): Jede Landephysik-Änderung kippt 1–2 von 600 Läufen. Abgefangen durch den Strang `l1l2` und den Neubau von L3/L4 auf der finalen Physik. Zwischen Phase 1 und dem l1l2-Merge ist levels:check für L1/L2 bewusst rot; die Liste steht in M11.
- **Lande-Gnade und Rutschen verbilligen Hop-Timing.** Gewollt; die Decke bleibt das Strafen. Das Gefühl zeigt erst der Mensch-Playtest (S6).
- **Die Hang-Landung erzeugt eine Hügel-Pumpe** (bergauf gratis, bergab Gewinn). Energie-begrenzt. Level-Regel: auf/ab-Ketten auf Routen nur mit Messung.
- **Luftlenkung nimmt Anfängern den Druck, A/D zu lernen.** Das Training lehrt ausdrücklich „W lenkt, A/D + Maus beschleunigt"; der Judge meldet wOnly.
- **Kanten-Assist:** Die Sicherheit der Crouch-Kanten hängt an „≥ 64 u" (umgesetzt ≥ 66 u). Der Validator prüft „ohne Ducken 0 Erfolge".
- **Trainings-Schwellen stammen aus Bot-Händen.** Alle Schwellen stehen an einer Stelle (`strafeJudge.ts`) und werden nach jedem Tuning neu erzeugt.
- **Registry-Umbau berührt frisch abgenommenen Plan-006-Code.** Abgesichert durch den Pixelvergleich.
- **Katzenpfote** liest sich im Prototyp als oranger Handschuh. Deshalb Silhouetten-Runde und Nutzer-Abnahme.
- **Selfie:** ein zusätzlicher Welt-Durchgang im Ziel-Frame. Möglicher kurzer Ruckler; der Timer steht dabei.
- **Umfang:** ~40 Strang-Tage. Phase 2 hat sechs parallele Stränge. training-ui wird erst nach training-core final abgenommen.

## 9. Offene Geschmacksfragen

Siehe die Rückgabe der Synthese (openQuestions): eigene Belohnung für Training-Meister (★★★), Luftlenkung standardmäßig an, Stil der Katzenpfote, Level-Namen.
