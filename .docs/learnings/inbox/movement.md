# Inbox: Strang movement (Plan 007, Phase 1)

Zusammenführen in `fallen.md` macht Phase 3. Zahlen: `npm run sim -- --section arcade`,
`.docs/research/movement-tuning.md` "Arcade-Pass".

## M11 — Übergabe an den Strang l1l2: was die finale Physik auf den heutigen L1/L2-JSONs kippt

`npm run levels:check` (unveränderte `public/levels/level{1,2}.json`, finale Physik A1–A8): **2 F / 1 W**
(vorher 0 F / 2 W). Genau die in Plan 007 §1 vorhergesagten chaotischen Proben, keine weiteren.
Schrittweise gemessen, wer sie auslöst:

| Probe | Meldung | ausgelöst durch |
|---|---|---|
| L2 exitTiers | ✗ "Ausfahrt hat Todesstreifen mit Auto-Hop: 1/600 Läufe (ab Knoten 16, 580 u/s, Versatz 96: kill bei 1589,−1162,−2871 (apron→exit1→surf2))". Dazu wandert die Stufe "apron→exit1→surf1" von ab 540 auf **ab 500 u/s** (die 10°-Ausfahrt gibt jetzt Tempo) | A4 Hang-Landung |
| L2 s0Catch | ✗ "S0 fängt Nicht-Surfer nicht: 1/12 W-Halter ab CP2 tot (Blick −15° + Leertaste: kill nach 4.8 s bei 658,−1157,−2674)" | A4 Hang-Landung |
| L1 Abschnitt CP2→CP3 | ! "Abschnitt CP2→CP3 aus dem Stand (Bot Hand 3°): kill bei (−2375, −254, −6354)" | A5 Cap 40 |

Nur Information (keine Meldung): L1 sync 0.7 7/8 (Seed 8: kill vor Knoten 30, bei −2586,−254,−1740) —
kam mit A5. L1 Hand 1° ist 8/8 (Plan §1 erwartete 6/8 als Warnung).

Was besser wurde (für die Medaillen-Neumessung in Phase 3): L1 sync 1.0 25.1 → **24.9 s**, Hand 3°
38.4 → 34.4 s, Hand 2° 7/8 → 8/8, sync 0.9 7/8 → 8/8 (Warnung weg), **Könner-Inseln lohnen wieder**
(Hand 1° 5/6, Ø 2.24 s; war Warnung 2/6). Verlust je Auffangmulde L1 0.30 → 0.09 s. L2 sync 1.0
17.2 → 17.0 s, Hand 3° 21.7 → 20.6 s. Crouch-Kante L1: Plan-Knoten trägt 592–913 u/s (vorher 550–913).
Zwischenstände: nach A1–A3 0 F / 2 W; nach A4 3 F (zusätzlich L1 Könner-Inseln "perfekter Bot scheitert");
nach A5 2 F / 1 W (Inseln wieder grün); A6–A8 ändern die Liste nicht, das Weiterrutschen über Kanten (unten)
auch nicht (Bericht zeilengleich bis auf Laufzeiten; Bots rutschen nie). Nachgemessen 28.09. 13:20.
Die Umstellung der Arcade-Pfade von `Math.hypot` auf `hLen` (sqrt, s. u.) verschiebt nur die chaotischen
L2-Bot-Mediane um ≤ 0.1 s (sync 1.0 17.1 → 17.0 s, Hand 3° 20.7 → 20.6 s) — Rundung, fallen.md #72; L1, die
Fehlerliste, `npm run sim` (beide Presets) und der Arcade-Abschnitt sind zeilengleich.

**Stand nach der Review-Runde (28.09. nachmittags, erweiterter Validator von level-tools): 2 F / 3 W.**

| Probe | Meldung | Aufgabe für l1l2 |
|---|---|---|
| L2 exitTiers | ✗ 1/600 (unverändert, s. o.) | wie oben |
| L2 s0Catch | ✗ 1/12 (unverändert) | wie oben |
| L1 CP2→CP3 | ! Hand 3° aus dem Stand (unverändert) | wie oben |
| **L1 Crouch-Kante Route 16→17** | ! "64.0 u hoch: Reserve 0.5 u < 2 u — ohne Ducken reicht es bis 63.5 u … Kante auf ≥ 66 u heben" | **neu: Kante auf 66 u** (Level-Regel jetzt ≥ 66 u, s. u.) |
| L1 Start-Kasten | ! "Perfekter Bot zerfällt … 12/49 bei 21.7–22.3 s, 37/49 bei 24.4–30.6 s" | Validator-Probe, auch mit Arcade aus (dort 33/49 / 16/49); Chaos-Stelle CP2→CP3 für die Medaillen entschärfen |

Die Review-Fixes (Hang-Schuld, Lip-Step im Steigen, Rutsch-Meldung) ändern keine Meldung. L1 zeilengleich.
L2-Bot-Mediane durch die Hang-Schuld (Ring-Landungen mit Drift nach außen stunden bis 59 u/s, die 10°-Ausfahrt
gibt dann +23 statt +82): sync 1.0 17.0 → **17.5 s**, sync 0.8 17.9 → 18.0, Hand 2° 19.0 → 19.4, Hand 3°
20.6 → 20.6, sync 0.7 18.7 → 19.5, sync 0.9 17.1 → 17.9, Hand 1° 17.1 → 17.2, Hand 1.5° 17.8 → 18.0 s.

## Kanten-Gedächtnis: ein schwächerer Folge-Anprall überschrieb das gemerkte Tempo

Nach einem frontalen Bonk drückt der Luft-Schub (W/A/D) weiter gegen die Wand. Mit Cap 40 sind das
~50 u/s — knapp über LEDGE_MIN_SPEED (50), also zählte jeder Folge-Tick selbst als "Anprall" und ersetzte
die gemerkten 539 u/s durch 50. Treppe 48/192 (perfekter Bot) blieb dadurch bei 8.17 s statt 3.30 s,
**mit Cap 32 fiel es nicht auf** (Schub ~40 < 50, der Prototyp maß 3.24 s). **Richtig:** nur ein
stärkerer Anprall überschreibt ein laufendes Gedächtnis. Allgemein: Schwellen, die "echte" Ereignisse von
Rauschen trennen, nach jeder Cap-/Beschleunigungsänderung gegen den Luft-Schub prüfen.

## Wand-Tasche: Doppelebenen-Regel + zwei fast parallele Wände = Schweben

Zwischen zwei um 4° verdrehten Banden-Stücken (L4-Prototyp) liefern alle vier Bumps fraction 0: die zweite
Wand gilt wegen dot > 0.99 als "dieselbe Ebene" (Q3-Fix, fallen.md #17), `vel += n` (1 u/s) kommt nicht
heraus, allFraction 0 → Source nullt die Geschwindigkeit. Solange W hineindrückt, schwebt man (fixcheck:
2 s, 1/702 — sichtbar erst, als Luftlenkung/Cap die Flugbahn in genau diese Ecke lenkten). **Richtig:**
trifft ein Luft-Move nur Wände (|n.y| < 0.1) und kommt gar nicht vom Fleck, senkrecht weiterfallen
(Kanten-Assist, CS2 aus). Allgemein: "Hänger 0/N" hängt an der Flugbahn — jede Physikänderung kann eine
andere Ecke treffen; Hänger-Proben nach dem Gesamtpaket wiederholen, nicht nur nach dem Einzel-Fix.

## fixcheck "Crouch-Kanten 198/200" ist ein Mess-Artefakt

Mit Kanten-Assist landet der Hüpfer mit vollem Tempo AUF der Kante (Mitte 0.7° vor der Wandlinie) und der
Smart-Auto-Hop springt sofort weiter (Tempo ≥ 0.97 × Wunschtempo). Die Probe zählt nur "am Boden, Mitte
hinter der Wandlinie" und bricht nach 4 s mitten im nächsten Hop ab. Ohne Assist kroch man mit 41 u/s an,
der Smart-Hop wartete, die Probe zählte. Mit "Hull über der Kante" als Kriterium: 200/200. Allgemein:
Proben mit Zeitlimit und Auto-Hop messen bei schnelleren Mechaniken leicht das Gegenteil.

## Lip-Step und Interpolation: die Kamera darf nicht den ganzen Versatz sofort abziehen

Der Lip-Step hebt die Füße in einem Tick um bis zu 5 u. Im Frame des Stufen-Ticks zeigt die Interpolation
erst tickAlpha·dy davon; wer beim Event −dy ansetzt, drückt die Kamera um (1 − tickAlpha)·dy unter die
Bahn und reißt sie im nächsten Frame hoch. **Richtig:** `rig.onTick()` je Physik-Tick (Game vor den Events)
und `CameraView.tickAlpha`; ausgeglichen wird genau der sichtbare Teil, dann linear in 0.1 s abgebaut
(60 Hz: roh 3.3 u in einem Frame → 0.57 u/Frame). Die Boden-Stufenglättung sieht den Lip-Step nicht
(Frames mit Luftanteil sind nicht "settled") — kein doppelter Ausgleich.

## Hang-Landung "< 3 u/s über 16 Phasen": die Rest-Spreizung ist Physik

Das Raster aus slopeland.ts startet je Phase bis zu einen Fall-Tick höher → der echte Aufprall ist bis
g·dt = 6.25 u/s schneller. Auf 35° gibt das bergab 2.94 u/s, nach einem Rampslide-Flug 3.51 u/s Spreizung
— Energie, keine Tick-Lotterie (die war 354 bzw. 803 u/s). Abnahmen mit Phasen-Rastern gegen die
Fallhöhen-Änderung des Rasters rechnen.

## Luftlenkung: "30–35° in 0.3 s" und "Tempo ±1" gelten nicht gleichzeitig

Bei 90° Blickversatz addiert Sources W-Schub im ersten Tick quer bis zum Cap (40 → +2.5 u/s), auch ohne
Lenkung; die 30–35° entstehen erst aus Lenkung + diesem Schub. Die Lenkung selbst hält den Betrag exakt
(Blick 45°: 320.00 u/s, 27.2°). Abnahmen für "Betrag bleibt" mit Blick ≤ 83° (cos > cap/|v|) messen.

## Prototyp-Patches auf PlayerMovement.prototype messen mit Schaltern aus die echte Engine

`tools/critique/v2/momentum/patch.ts` und `ArcadeMovement.installGlobal` sind mit allen Schaltern aus
transparent. Nach dem Einbau zeigt deren **erste Spalte** ("vorher"/"Original") deshalb die neue Engine —
praktisch als Gegenprobe (grace.ts: Gnade 8 zeilengleich zum Prototyp; slopeland.ts: "Richtung+Slide"
zeilengleich). Die übrigen Spalten wenden die Mechanik doppelt an und sind wertlos.

## Parallelbau: levels:check gegen eine eingefrorene Werkzeug-Kopie

Während level-tools `tools/levels/*` umbaute (zeitweise tsc-Fehler in physics.ts/validate-levels.ts),
liefen die Vergleiche gegen eine Kopie von `tools/{levels,sim,critique,validate-levels.ts}` und
`public/levels` im Scratchpad, mit Windows-Junctions auf das echte `src` und `node_modules`
(`mklink /J`) — so misst man die eigene Physik mit festen Werkzeugen (fallen.md #30). Endkontrolle mit
den geteilten Werkzeugen: identisch bis auf den Selbsttest (25 → 33 Fälle).

## Vertrags-Test aus Phase 0 schreibt Neutralität fest

`tests/contracts.test.ts` prüft "Anfänger-Cap bleibt bis Phase 1 bei 32" und "sliding ist nach Sprint + C
false" — Phase 1 kippt beide absichtlich (Cap 40, Rutschen). Die Datei gehört nicht diesem Strang; der
Eigentümer/Integration muss sie nachziehen (airSpeedCapLow 40; sliding nach Sprint + C true).

## Shell: Heredoc mit Anführungszeichen in TS-Strings bricht im Bash-Tool

`cat >> datei <<'EOF'` mit längerem TS-Code (Template-Strings, deutsche Anführungszeichen) scheiterte mit
"unexpected EOF while looking for matching `''" — nichts wurde geschrieben (wie fallen.md #78). Code mit
dem Write-Tool in eine Scratch-Datei legen und per Python anhängen.

## Rutschen auf flachem Testboden grün, im Level abgewürgt: neue Boden-Zustände auf echtem Gelände prüfen

Alle Rutsch-Abnahmen (Sprint + C, Tunnel, Hang, Farmer) laufen auf ebenem Boden. Im echten Spiel (L1-Start,
Playwright, Frames + Events) verließ die Rutsche nach 0.55 s über eine Mulde den Boden (`slideEnd` bei
270 u/s), landete unter `slideMinSpeed` (280) und durfte nicht neu starten — der Duck-Walk bremste 270 → 85 u/s
in 0.2 s. Wie im Prototyp. **Richtig:** Rutsche, die den Boden ohne Sprung verlässt, geht bei der Landung
weiter (Hull geduckt, ≥ `slideExitSpeed`, kein Schub; `slideCarry`); nach einem Sprung nicht (Crouch-Jump auf
schmale Ziele muss bremsen). L1-Start jetzt 1.37 s Rutschen. Allgemein: jeden neuen Boden-Zustand einmal
über Kante/Mulde/Kuppe eines echten Levels fahren, nicht nur über `flatWorld`.

## Kanten-Gedächtnis auf Treppen mit 32–40-u-Setzstufen: systematischer Doppel-Anprall (für Level-Stränge)

Treppe 32/192, perfekter Bot: 7.70 → 8.27 s. Die erste Fassung hier nannte das ein "Rhythmus-Artefakt des Bots"
— **falsch** (Review 28.09.): nur Gedächtnis ergibt exakt die Zeiten von "an", nur Lip-Step exakt die von "aus",
und es ist bei jedem Anlauftempo gleich (32/192 v0 320/450/600: 8.27/8.27/8.27 s; 32/128 +0.95 s; 32/224 +0.2
bis +0.4 s; 40/192 bis +0.2 s). Mechanik: der Hop prallt an die übernächste Setzstufe, das Gedächtnis gibt
476 u/s noch im Steigen zurück, der Scheitel reicht nicht über die nächste Stufe, zweiter Anprall im Fallen
(Landung 42 u/s). Eine längere Vorausschau beim Vault hilft nicht (16 Ticks gleich, 48 Ticks zerstört 48/192:
3.30 → 8.17 s). 24er (10.98 → 5.19 s) und 48er Setzstufen (8.17 → 3.30 s) gewinnen. **Level-Regel:** Treppen mit
Setzstufe 32–40 u nur mit Auftritt ≥ Hop-Weite beim Zieltempo, sonst Stufen ≤ 18 u (laufbar). **Vorschlag für
level-tools:** Probe "Treppen auf der Route: perfekter Bot mit Assist nicht langsamer als ohne". Allgemein: eine
Erklärung "Artefakt des Bots" erst glauben, wenn Schalter-Einzelmessungen (nur A, nur B) sie stützen.

## Ereignis-SFX-Pegel (für den Mensch-Playtest S6)

Offline gemessen (dev/audio.html, `renderOffline`, Differenz mit/ohne Ereignis bei gleichem Seed — Rest
−∞ dB, also exakt): max. 5-ms-RMS Griff-Klack −34 dBFS, Vault-Whoosh −32, Schritt −27.5, Landung (300) −27,
slideStart −25 (mit Schub −16). Bett bei 600 u/s mit Musik ≈ −14 dBFS RMS. Der Griff-Klack liegt ~7 dB unter
einem Schritt und fällt zusammen mit dem Lande-Thud der Kanten-Landung — bewusst leise, beim Playtest
anhören. Rutsch-Kratzen: +4 dB Gesamt-RMS, +10 dB im Band 1–3 kHz bei 600 u/s; hörbar schon bei 200 u/s;
nach `slideEnd` wieder exakt das Bett. **Falle:** `drive()` in `src/audio/dev/scenarios.ts` kopiert
`sliding` nicht (baut das Objekt feldweise) — wer das Kratzen offline hören will, muss `sliding` danach setzen
(Datei gehört nicht diesem Strang).

## `npm run shot` unter Last: "Esc → Pause-Menü, Maus frei" einmal rot

Parallel zu anderen Browser-Läufen meldete der Check einmal `locked=true` nach Esc, im direkten Wiederholungslauf
38/38. Pointer-Lock-Emulation unter Last, nicht Movement; bei einem roten Einzelcheck erst wiederholen.

## `Math.hypot` im Tick-Pfad erzeugt Müll (Heap-Zahlen), `Math.sqrt(x*x + z*z)` nicht

Node-Probe (CDP `HeapProfiler.startSampling` mit `includeObjectsCollectedByMinorGC`, 480 000 Ticks Rutschen/
Kante/Luftlenkung/Surf): der Arcade-Pass hob den Müll von 424 auf 621 B/Tick, fast alles `hypot` — V8 inlinet
`Math.hypot` nicht, der Builtin-Aufruf boxt jedes Ergebnis. Sogar CS2 zahlte mit, weil `updateSlide` die Länge
vor der Schalter-Prüfung rechnete. **Richtig:** Schalter zuerst prüfen, dann `hLen(x, z)` =
`Math.sqrt(x*x + z*z)` (inlinet, bleibt im Register) → 408–450 B/Tick, Minor-GCs 195 statt ~300 (HEAD ~200).
Die Source-Pfade behalten `hypot` (Bitgleichheit CS2, `npm run sim` zeilengleich). Die restlichen ~420 B/Tick
sind alt (`hypot` in tick/airMove/advanceStride, traceBox) — Kandidat für eine eigene Runde, dann aber mit
Neumessung aller Bot-Proben (Rundung kippt chaotische Läufe, s. o.).

## Hügel-Pumpe: "bergauf kein Verlust + bergab Gewinn" erzeugt Energie auf Wellen (Review 28.09.)

Die Hang-Landung wurde nur auf gleichförmigen Gefällen abgenommen ("Energie-begrenzt"). Auf Wellen erntete jede
Talfahrt den Sprungimpuls, den der Aufstieg gratis bekam: nur W + Leertaste, 10°/1024 u, 320 → 785 u/s in 30 s
(mehr als ein 3°-Strafer flach, H20 646). **Richtig:** den erlassenen Bergauf-Verlust stunden und vom nächsten
Bergab-Gewinn abziehen (höchstens Tempo über Lauftempo, je Tick gekappt) → 430 u/s stabil; bergauf bleibt
verlustfrei, gleichförmige Gefälle zeilengleich. Zwei naheliegende Varianten reichen nicht: nur die gewonnene
Höhe stunden (5°/512 wieder 353 → 542 — auch der Abstieg erntet den Sprungimpuls) und eine Energie-Kappe ab
Absprunghöhe (Review: 811). Die Rückkehr zu "bergauf verlustbehaftet" kostete L1 3.8 s (perfekter Bot 24.91 →
28.73 s). Allgemein: jede asymmetrische Verzeihung (Gewinn behalten, Verlust erlassen) auf periodischem Gelände
messen — ein Hin-und-Rück-Parcours ist eine Pumpe, wenn die Bilanz nicht aufgeht. Sim: Zeile "Hügel-Pumpe".
**Für l1l2/level3/level4:** Wellen geben jetzt einmal Tempo (10°: +110 u/s), danach nichts mehr; überhöhte
Kurven mit Drift nach außen (L2-Ring) stunden Verlust, der die nächste Talfahrt schmälert.

## Reichweite ohne Ducken: die Auto-Hop-Landung schwebt bis 1.5 u (Review 28.09.)

"Crouch-Kanten ≥ 64 u = 57 + 5 + 2 Reserve" rechnete mit dem Sprung vom Boden. Im Bhop-Rhythmus springt man
aber im Landetick ab, und die Landung liegt bis 1.5 u über dem Boden (2-u-Sonde, Füße 0.03–1.53 u) — ohne Ducken
kommt man bis 63 u (63.5 u 0/240), die Reserve war ≤ 1 u; der neue Validator warnte schon für L1. **Richtig:**
Crouch-Kanten ≥ 66 u (L1-Kante und die zwei L4-Kanten). Allgemein: Reichweiten immer aus dem Auto-Hop-Rhythmus
messen (Leertaste gehalten, Landung → Sprung), nicht nur aus dem Stand; die Vitest-Proben sprangen alle vom Boden.

## Lip-Step im Steigen verschluckte Sprünge vor Stufen (Review 28.09.)

"vel.y = 0, auch steigend" war für schmale Kanten gedacht, traf aber jeden Absprung direkt vor einer Stufe: nach
8–47 ms stand man auf der Stufe, der Sprung war weg, ohne Lande-Gnade griff sofort die Reibung. **Richtig:** kein
Lip-Step, solange der Rest-Aufstieg die Kante um ≥ 2 u selbst überragt (das Gedächtnis gibt das Tempo oben
zurück); knapp vor dem Scheitel fängt er weiter. "Nur fallend" (Review-Vorschlag) verlor diesen Scheitel-Fang.
Allgemein: jede Hilfe, die vel.y setzt, gegen "Taste gedrückt, aber nichts passiert" prüfen.

## Rutsch-Meldung in der Lande-Gnade (Review 28.09.)

Die Rutsche startete im ersten Bodentick der Gnade; jeder 1–8 Ticks späte Crouch-Hop meldete slideStart +
slideEnd (Kratz-Whoosh), während er als `clean` gelobt wurde. **Richtig:** Physik-Zustand und gemeldeten Zustand
trennen (`slideOn` intern, `state.sliding`/slideStart erst mit dem ersten Reibungs-Tick). Physik bitgleich,
nur Events/Snapshot später. Das zweite slideStart beim Weiterrutschen über Mulden bleibt im Vertrag (Handoff an
Phase 2); Sfx erkennt es (kein Sprung/Aufstehen/Respawn seit slideEnd, ≤ 1 s) und spielt keinen zweiten Whoosh.

## Tests, die nur wegen einer Kappe grün sind (Mutations-Audit, Review 28.09.)

Drei Mutationen überlebten die Suite: teleport ohne `memTicks = 0` (der Test teleportierte an den Start, das
alte Gedächtnis lief vor dem nächsten Anprall ab), Schub ohne Bodenzeit-Regel (Test landete mit 600 u/s — über
slideBoostCap 380, die Kappe allein hielt ihn grün) und Lip-Step ohne vel.y = 0. Jetzt 27/27 Mutationen erkannt
(Skript: Scratchpad `fixmv/mutate.py`). Allgemein: Missbrauchstests in das Band legen, in dem nur die geprüfte
Regel greift (hier 280 ≤ v < 380), und Rücksetz-Tests so bauen, dass der alte Zustand sofort wirken würde.

## Shell: Python-Textmodus auf Windows schreibt CRLF in LF-Dateien

Patches per `open(p).read()` / `open(p, 'w').write()` (Python, Windows) lesen LF und schreiben CRLF — vier
LF-Dateien waren danach komplett CRLF (git mit autocrlf zeigt es im Diff nicht; Patch-Muster mit LF passen danach
nicht mehr: "MUSTER FEHLT"). Gegenstück zu fallen.md #63. **Richtig:** `open(p, encoding='utf-8', newline='')`
für Lesen und Schreiben, danach die CR-Zahl prüfen (`open(p, 'rb').read().count(b'\r')`). Heredocs mit
Anführungszeichen scheitern weiter (#78) — Patch-Skripte mit dem Write-Tool anlegen.
