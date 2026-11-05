# Strang: Trailer-Musik (tools/trailer/)

## Audio: Belohnungs-SFX ducken die Musik auch bei sfx-Lautstärke 0
`checkpoint`, `finish` und `speedMilestone` rufen in `Sfx` `mixer.rewardDuck()` auf. Das läuft über den
Musikbus, also auch dann, wenn die SFX stumm sind (`volumes.sfx = 0`). In einem reinen Musik-Render
entsteht so ein 3.5–4-dB-Loch genau im Akzent. **Ausweg (offline):** erst bis hinter den Ziel-Beat planen,
dann das Ereignis mit einer frühen Zeit abschicken. `Music.checkpoint` trägt den Akzent per RETRO auf
dem schon geplanten Beat nach, der Duck fällt auf die frühe Zeit. Bei `finish` geht das nicht, weil der Riser
ab der Ereigniszeit läuft.

## Audio: `setMuted` mitten im Offline-Render zerstört Automation
`TechnoAudio.setMuted` wirkt für Hats/Ride/Shaker/Perc/Clap/Stabs/Pad nur auf die Planung, das ist
unkritisch. Für `kick`, `acid`, `fx` und `rumble` setzt es dagegen AudioParams bei `ctx.currentTime`.
Offline ist das immer 0, `cancelScheduledValues(0)` löscht also die gesamte bereits geplante Automation.
Für zeitgesteuertes Ausdünnen lieber einen zweiten Render mit Stummschaltung von Anfang an und dann
überblenden.

## Audio: Offline-Zeitbasis = ORIGIN 0.02 s + Limiter 6 ms
Takt n ist offline bei 0.02 + n · BAR geplant und wird 6 ms später hörbar. Wer Takt 0 auf Dateianfang
legen will, schneidet 26 ms ab. Danach liegen die gemessenen Crash-Onsets bei ±5 ms.

## Audio: L4-Anlauf exakt auf einen Takt legen
Der Overdrive-Anlauf startet am ersten Beat, an dem gilt: Ziel ≥ 0.87 und geglättete Energie ≥ 0.74,
aber Peak < 0.86 (sonst steigt der Layer ohne Anlauf). Der Energiesprung muss deshalb genau EIN 16tel
vor diesem Beat kommen (Attack 0.3 s, Schritt 0.114 s). Kommt er zwei 16tel vorher, landet die Energie
bei ~0.855, also knapp an der Kante.

## Werkzeug: ffmpeg unter C:\ffmpeg ist alt (Lavf59)
`ebur128` kennt dort kein `framelog=`. Ohne die Option aufrufen und die letzte `Summary` parsen.
`loudnorm` im Linear-Modus landet ~0.3 LU neben dem Ziel (−13.7 statt −14).
