# Plan 002 — Integration und erste spielbare Version

**Stand:** 2026-09-27 · **Status:** in Arbeit (Integration und Review-Fixes erledigt, Mensch-Playtest offen)

## Problem

Fünf Module sind einzeln gebaut, reviewt und getestet — aber noch nie
zusammen gelaufen. Kein Mensch und kein Bot hat das Spiel im Browser gespielt.

## Entscheidungen vor der Integration

1. **Air-Speed-Cap 24 statt 17** (siehe movement-tuning.md, "Entscheidung
   Integration"): Maßstab ist CS2-Parität für menschliche Hände, nicht ein
   Korridor für den perfekten Bot.
2. **Kanten-Bevels** in `compileLevel` (q3map `AddBrushBevels`): beseitigt
   Phantom-Keile an schrägen Brush-Kanten (Rampbug). Referenztest gegen einen
   exakten Separating-Axis-Test: `tests/bevels.test.ts`.
3. Vertragsergänzungen, die die Stränge angefragt haben, werden jetzt
   eingepflegt (RendererApi.aspect, AudioApi.dispose, RouteNode-Flags, Doku).

## Schritte

- ✓ Integration: `src/engine/Game.ts`, `src/main.ts`, `window.__vel`, Playwright-
  Harnesses (`tools/shoot.mjs`, `tools/playtest.mjs` mit Bot im echten Spiel). Beide
  Level im Browser von Titel bis Ergebnis spielbar, 0 Konsolenfehler.
- ✓ Level-Retuning auf Cap 24 + Bevels, RouteNode-Flags statt Notiz-Präfixen.
- ✓ End-to-End-Review (27.09.) und Fixes:
  - Subtick-Yaw nach Tick-Zeit (144 Hz: 100 % statt 86–94 % Strafe-Gewinn).
  - Todesbänder mit Auto-Hop geschlossen: L1-Finale (Auffangrampe, Block bündig),
    L1 Kehre → Wende lückenlos, L2 Vorfeld Ring → E1, S1 unter E1.
  - L2: Ausfahrt im ersten Durchgang, Ring-Innenbahn mit Lücken, Anlaufbahn als
    Hop-Linie; Respawn-Pads auf dem Grat der Folgerampe; Luft-Trigger nur noch über
    den Rampen.
  - Kill-Zonen gestuft und neben den Rampen; Taste F (zurück zum Checkpoint).
  - HUD ohne Allokation pro Frame, Split ohne Referenz als kleine Zeile.
  - Validator über 8 Seeds, Par gemessen, RouteFollower überspringt surfend
    passierte Knoten.
- Offen: Game-Feel mit Menschen (Maus-Rohdaten, > 60 Hz, Surf-Gefühl, Ring-Linien),
  Polish-Durchgänge.
