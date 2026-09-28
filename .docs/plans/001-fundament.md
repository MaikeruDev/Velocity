# Plan 001 — Fundament und erste spielbare Version

**Stand:** 2026-09-26 · **Status:** umgesetzt (Stränge gebaut, reviewt, gefixt)

## Problem

Ein Source-Movement fühlt sich nur dann richtig an, wenn *alle* Teile
zusammenpassen: Tick-Physik, rohe Maus, Kamera-Feedback, Musik, die mitgeht,
und Level, deren Lücken genau die Geschwindigkeiten verlangen, die man mit
gutem Strafen erreicht. Ein Teil davon falsch und das Ganze fühlt sich
"irgendwie schwammig" an, ohne dass man sagen kann warum.

## Entscheidungen

1. **Verträge zuerst.** Level-Format, Kollisions-API, MovementConfig,
   Snapshot/Input/Events, Audio- und Renderer-API sind als Typen festgelegt
   (siehe AGENTS.md §3.4), bevor Module parallel gebaut werden.
2. **Kollision + Level-Kompilierung sind fertig und getestet**, bevor
   Movement, Renderer und Level-Design starten — alle drei hängen daran.
3. **Parallelbau in fünf Strängen**, jeder in eigenem Ordner:
   Movement+Kamera (`src/player`), Renderer (`src/render`), Audio (`src/audio`),
   Engine+UI (`src/engine`, `src/ui`), Level (`tools/levels`, `public/levels`).
4. **Integration** (`src/main.ts`, `src/engine/Game.ts`) erst danach, von einer Hand.
5. **Selbstkritisches Playtesten ohne Hände:** Strafe-Bot vs. Geradeaus-Bot
   in der Sim, Bot-Durchläufe durch die Level, Playwright-Screenshots,
   Offline-Render der Musik mit Spektralanalyse. Danach Review-Runden mit
   adversarialen Kritikern pro Dimension (Movement, Kamera, Audio, Look, Level)
   und Polish-Durchgänge, bis nichts Klobiges mehr gefunden wird.

## Stränge (Ergebnis je Strang)

| Strang | Liefert |
|---|---|
| Movement | `PlayerMovement`, `CameraRig`, Bots, Vitest, `tools/sim.ts`, getunte `VELOCITY_DEFAULT` |
| Render | `PS2Renderer` (RendererApi), Shader, prozedurale Texturen, Himmel, Trims, Post |
| Audio | `TechnoAudio` (AudioApi), Sequencer, Instrumente, SFX, `tools/audiocheck.mjs` |
| Engine+UI | `FixedLoop`, `InputManager`, `Settings`, HUD mit Bitmap-Font, Menüs, Tuning-Panel |
| Level | `tools/levels/*`, zwei Level als JSON, `tools/validate-levels.ts` |
