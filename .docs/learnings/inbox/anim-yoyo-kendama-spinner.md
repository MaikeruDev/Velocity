# Inbox: Animator Jo-Jo / Kendama / Spinner (Plan 008 Schritt 2, 01.10.)

Zum Zusammenführen in fallen.md (paralleler Strang, AGENTS.md §4).

## A. Erst die Hand im Bild kartieren, dann Bahnen legen — mit der RICHTIGEN Lage des Gegenstands

Bahnen in Bildrichtungen (rechts/oben/Kamera ab der Schlaufe) liefen quer durch die Hand: Around the World vorn durch
Handfläche und Daumen (−2.4), Pass/Breakaway/Wiege begannen AM Anker (= im Mittelfinger). Hilfreich war eine Karte
"ab welcher Tiefe c ist die Scheibe frei" über ein r/u-Raster (oberer UND unterer Rand des blockierten Intervalls —
sonst sieht man Taschen wie die Ruhelage zwischen Kuppen und Daumen nicht). Falle: meine erste Karte hatte die
Jo-Jo-Scheibe um 90° falsch (Achse = lokal y, nicht z; items/yoyo) und log; maßgeblich ist immer die Mesh-Messung
(`tools/lib/handContact`). Ergebnis: `cam` zeigt beim Jo-Jo zur Handflächen-Seite; ATW geht rechts HINTER der Faust
durch (Tiefe c = D·s·(2−|s|), C1-glatt), Würfe verlassen die Tasche über einen Austrittspunkt unten-vorn, Rückwege
kommen kubisch (erst unten auf dessen Tiefe, dann hoch) herein.

## B. Fangpunkt fest, nicht per FK der sich schließenden Finger

Die Jo-Jo-Ruhelage folgte der FK der aktuellen Finger: bei offener Hand lag sie an den Kuppen, beim Schließen sprang
das Jo-Jo 5 Einheiten in 1/30 s, und der Wurf zog es mit den sich öffnenden Fingern durch Ring-/kleinen Finger.
Fester Fangpunkt (FK der Griff-Pose, Ladezeit) + Finger-Schutz löste beides.

## C. Finger-Schutz als stetige Abbildung (Kugel-Wolke), nicht als Kontakt-Physik

Gegenstand/zweiter Körper werden nach der Zeitleiste aus dem Hand-Modell geschoben: Wolke aus Kugeln (Jo-Jo: zwei
Rand-Ringe NAHE DEN FLANKEN — volle 2.6 liegen bei |y| ≈ 0.9; ein Ring in der Mitte unterschätzte den Rand um
0.3–0.5; Spinner: Rotor als volle Scheibe, Nabe als Kugel-Ring statt zwei langer Kugeln), Hüllkugel als Vorab-Test,
Gradient per zentraler Differenz, einseitig mit weichem Einsatz und einer TOLERANZ AUS DER RUHELAGE (sonst schiebt er
den ruhenden Griff). Grenzen: steckt ein Finger quer DURCH die Scheibe (Daumen auf der Lager-Kappe, wenn der Spinner
seitlich abhebt), gibt es keinen kleinen Ausweg — dann Bahn/Finger ändern (Daumen spreizt vorher ab, Hüpfer statt
linearem Schieben). Kosten ≤ 30 µs/Frame.

## D. Schnur: Punkte frei heißt nicht Sehnen frei

`RopeHandGuard.project` schiebt nur die 9 Punkte; zwei freie Punkte links/rechts eines Fingers ließen die Sehne quer
durch ihn laufen (gerade hängende Jo-Jo-Schnur in JEDEM Frame bis 1.4 durch Ring-/kleinen Finger). Neu (additiv)
`projectChords`: Stichproben je Sehne, Endpunkte entlang des Gradienten so verschieben, dass die Stichprobe auf der
Oberfläche liegt (4 Durchgänge × 8 Teilungen; 3 × 4 reichte nicht). Die erste Sehne (Schlaufe im Finger) auslassen —
sie mitzunehmen machte es schlechter. Rest: die letzten Einheiten vor dem Fang (Schnur läuft zwischen den Fingern in
die Faust, verdeckt) und die exakt vorgegebene Wiegen-Figur (Test verlangt Daumen-/Zeigefingerspitze exakt — offen).

## E. Posenwechsel liegen auf dem Frame-Raster — Schlaufe/Schutz dürfen nicht an ihnen hängen

Mein erster Umbau (Hand öffnet beim Wurf: Pose relaxed → yoyo) ließ das Pendel bei 30 Hz um 9 px abweichen: die
Schlaufe sitzt am Mittelfinger, die Pose wechselt im ersten Frame NACH der Marke. Lösung: Pose bleibt fest, Öffnen/
Schließen als Gelenk-Versatz w(t)·(relaxed − yoyo) — geschlossen in der Trick-Zeit; der Schnur-Finger öffnet nur
30 % (seine Bewegung stößt das Pendel an). Für Hand-Modell und Anker die ÜBERGEBENEN Gelenke + jointAdd nehmen
(im Spiel exakt die gezeigte Hand, in Proben mit fester Pose konstant) — nicht selbst überblenden. Posen-Labels sind
Vertrag (cosmetics.test fragt `pose === 'cradle'` bzw. `point`): dort Posenwechsel behalten.
Beim Ziel-Abbruch das Hand-Modell UND den Anker in onInterrupt aus den aktuellen Gelenken setzen (sonst 0.2 Versatz
zum Bild ohne Abbruch).

## F. Gekippter Ken: Unterarm-Rolle allein legt den Arm quer — Handgelenk mitnehmen

Kippen um 1.2 rad nur über hroll legte Stulpe und Arm quer ins Bild. Aufteilung 50/50 Rolle + Handgelenk um dieselbe
Bild-Tiefenachse (Euler ZXY wie ViewModel.applyJoints: x = −Beugen, y = Drehen, z = Seitneigen; Matrix aus Achse/Winkel
zerlegt). Alle Drehpunkte (Bewegung, Arm, Handgelenk) liegen im selben Ursprung, Würfe rechnen mit der Gesamtrolle.
Hinweis: Stulpe/Band hängen am Handgelenk-Knoten — jede Kippung in der Bildebene sieht wie eine Unterarm-Drehung aus.

## G. Kendama-Takt: längere Tricks + Abklingzeit ab START = Band gerissen

Der Vorgänger verlängerte die Fänge (geführtes Einschwingen 0.66 s) und kürzte die Abklingzeiten ("Takt bleibt") —
event-probe: 54–60 % Trick-Anteil (Band 25–45). Abklingzeiten zählen ab Trick-START: sind sie kürzer als der Trick,
wirken sie nicht; kürzere Tricks erzeugen dann nur mehr Starts. Erst Raster (Loslassen × Einschwingen × Abklingzeit,
parallel, geteilte Ausgabedatei vorher sichern und danach zurückspielen) fand eine Kombination ohne Verstoß.
Nebenwirkungen des kürzeren Einschwingens: Sprung am Phasenwechsel (Schnur-Ansatz rollt mit der zurückkippenden Hand
— Versatz in Phase 1 stetig einführen), Nachwackeln am Trick-Ende nicht ausgeklungen (Sprung beim Übergang in die
Ruhe, je Framerate anders — bis zum Ende ausblenden).

## H. Werkzeug-Fallen

- Such-Schalter per `process.env` in src-Dateien: im Browser gibt es kein `process` → Dev-Viewer hängt (Timeout im
  Blatt-Skript). Vor jedem Rendern festschreiben; der Vorgänger hatte solche Reste im Jo-Jo hinterlassen.
- Das Bild-Lesen zeigte bei gleichem Dateinamen scheinbar ein altes Blatt — für Vorher/Nachher neue Dateinamen.
- hand-audit "rechts" (yaw 70) zeigt bei Jo-Jo/Kendama/Spinner fast nur den Unterarm; vorn-links (yaw −50,
  pitch −15) zeigt Handfläche, Tasche und Schnur.
- viewHand.test "wilde Eingaben" liegt allein bei 3.7 s, im Gesamtlauf bei ~5.0 s gegen ein 5-s-Limit — flackert
  unter Last (auch ohne neue Testdateien). Mein Test senkt seine Prozess-Priorität und probt Allokation seriell.
- anim-can-lighter-phone "allokationsfrei": LighterTricks/tossOpen zeigte deterministisch 24 Scavenges, obwohl weder
  lighterTricks.ts noch seine Abhängigkeiten in dieser Sitzung geändert wurden (zu Sitzungsbeginn grün) — Strang
  Dose/Feuerzeug/Handy prüfen.
