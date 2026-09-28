/**
 * Drehraten-Fenster eines Hops — Quelle der StrafeJudge-Schwellen (Plan 007, TC1).
 *
 *   npx tsx tools/levels/training/turnwindow.ts            Tabellen + Vergleich mit strafeJudge.ts
 *   npx tsx tools/levels/training/turnwindow.ts --json p   zusätzlich JSON nach p
 *
 * Ein Hop auf flachem Boden mit Absprungtempo v0, in der Luft A gehalten und die Maus mit
 * KONSTANTER Rate (°/s) nach links gezogen — so, wie ein Mensch "die Maus gleichmäßig zieht".
 * Echte PlayerMovement mit VELOCITY_DEFAULT (Cap 40, Lande-Gnade, Luftlenkung an; Sprint wie im
 * Spiel mit Auto-Sprint). Gemessen wird der Tempo-Gewinn Absprung → Landung.
 *
 * Daraus (strafeJudge.ts, eine Stelle für alle Schwellen):
 *  - GOOD_GAIN_TABLE: "guter Hop" = Gewinn ≥ GOOD_SHARE × Gewinn der Referenz-Rate REF_RATE
 *    (die Rate, die der ordentliche Anfänger zieht) — skaliert mit der Physik statt fester 8 u/s.
 *  - FAST_TABLE: obere Grenze des 50-%-Fensters (Rate, ab der Überdrehen den Gewinn halbiert).
 * Nach jedem Movement-Tuning neu laufen lassen; weicht die Messung ab, meldet das Skript es.
 */
import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import type { MutablePlayerInput } from '../../../src/player/types';
import { NO_INPUT } from '../../../src/player/types';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { FAST_TABLE, GOOD_GAIN_TABLE, GOOD_SHARE, REF_RATE, goodGainAt, tooFastRate } from '../../../src/engine/strafeJudge';
import { flatLevel } from '../../sim/levels';

const DEG = Math.PI / 180;
const level = compileLevel(flatLevel(60000));

export type HopVariant = 'match' | 'against' | 'wOnly' | 'noMouse';

export interface HopResult {
  readonly gain: number;
  /** Luftzeit (s). */
  readonly air: number;
  /** Kursänderung der Flugrichtung (°). */
  readonly curve: number;
}

/** Ein Hop ab dem Boden mit Tempo v0 (Richtung −Z); A/D + Maus ab `delay` s Luftzeit. */
export function hop(cfg: MovementConfig, v0: number, rateDeg: number, variant: HopVariant, delay = 0): HopResult {
  const pm = new PlayerMovement(level.world, cfg);
  pm.state.vel.set(0, 0, -v0);
  pm.teleport(new Vector3(0, 0.01, 30000), { keepVelocity: true });
  const dt = 1 / cfg.tickRate;
  const inp: MutablePlayerInput = { ...NO_INPUT };
  let yaw = 0;
  let startSpeed = -1;
  let startDir = 0;
  let airTicks = 0;
  let prevSpeed = pm.state.speed;
  for (let t = 0; t < cfg.tickRate * 3; t++) {
    if (t > 0 && pm.state.onGround && startSpeed >= 0) {
      const dir = Math.atan2(-pm.state.vel.x, -pm.state.vel.z);
      // Wie StrafeJudge: Gewinn bis zum letzten Luft-Tick (prevSpeed = vor dem Lande-Tick).
      return { gain: prevSpeed - startSpeed, air: airTicks * dt, curve: (dir - startDir) / DEG };
    }
    inp.jumpHeld = t === 0;
    inp.jumpPressed = t === 0;
    const inAir = t > 0 && !pm.state.onGround;
    const acting = inAir && airTicks * dt >= delay;
    if (acting && variant !== 'noMouse') yaw += rateDeg * DEG * dt;
    inp.yaw = yaw;
    // Absprung-Tick mit W (wie ein Mensch, der anläuft); in der Luft W nur bei wOnly.
    inp.forward = variant === 'wOnly' || t === 0 ? 1 : 0;
    inp.side = !acting ? 0 : variant === 'match' || variant === 'noMouse' ? -1 : variant === 'against' ? 1 : 0;
    inp.sprint = true;
    prevSpeed = pm.state.speed;
    pm.tick(inp);
    if (!pm.state.onGround) {
      if (startSpeed < 0) {
        startSpeed = prevSpeed;
        startDir = Math.atan2(-pm.state.vel.x, -pm.state.vel.z);
      }
      airTicks++;
    }
  }
  return { gain: Number.NaN, air: Number.NaN, curve: Number.NaN };
}

export interface RateWindow {
  readonly best: number;
  readonly max: number;
  readonly lo: number;
  readonly hi: number;
}

/** Beste Rate und 50-%-Fenster beim Tempo v0 (Raster 10 °/s bis 1800 °/s). */
export function rateWindow(cfg: MovementConfig, v0: number): RateWindow {
  const rates = Array.from({ length: 181 }, (_, i) => i * 10);
  const g = rates.map((r) => hop(cfg, v0, r, 'match').gain);
  let bi = 0;
  g.forEach((x, i) => {
    if (x > g[bi]) bi = i;
  });
  const half = g[bi] * 0.5;
  let lo = bi;
  while (lo > 0 && g[lo - 1] >= half) lo--;
  let hi = bi;
  while (hi < g.length - 1 && g[hi + 1] >= half) hi++;
  return { best: rates[bi], max: g[bi], lo: rates[lo], hi: rates[hi] };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/levels/training/turnwindow.ts')) {
  const cfg = VELOCITY_DEFAULT;
  const lines: string[] = [];
  const pad = (s: string | number, n: number): string => String(s).padStart(n);
  const SPEEDS = [200, 250, 320, 400, 450, 600, 800, 1000, 1400];
  const RATES = [0, 10, 20, 35, 60, 90, 120, 180, 240, 360, 540, 720, 1080];
  const json: Record<string, unknown> = {};
  for (const variant of ['match', 'against', 'wOnly', 'noMouse'] as const) {
    lines.push(`\n## ${variant}: Gewinn je Hop (u/s) / Kurve (°)`);
    lines.push(`${pad('v0 \\ °/s', 9)} ${RATES.map((r) => pad(r, 11)).join('')}`);
    for (const v0 of SPEEDS) {
      const row = RATES.map((r) => {
        const h = hop(cfg, v0, r, variant);
        json[`${variant}@${v0}@${r}`] = h;
        return pad(`${h.gain.toFixed(1)}/${h.curve.toFixed(0)}`, 11);
      });
      lines.push(`${pad(v0, 9)} ${row.join('')}`);
    }
  }
  lines.push(`\n## Reaktionsverzug (v0 320, ${REF_RATE} °/s): Gewinn je Hop`);
  for (const d of [0, 0.1, 0.2, 0.3, 0.4]) lines.push(`  Verzug ${d.toFixed(1)} s: +${hop(cfg, 320, REF_RATE, 'match', d).gain.toFixed(1)} u/s`);

  lines.push(`\n## Schwellen: gut = ${GOOD_SHARE} × Gewinn bei ${REF_RATE} °/s; zu schnell = obere 50-%-Grenze`);
  lines.push('     v0   ref-Gewinn   gut(mess)  gut(Tabelle)   bestes °/s   50 %-Fenster   zuSchnell(Tabelle)');
  let drift = 0;
  const table: Array<[number, number, number]> = [];
  for (const v0 of SPEEDS) {
    const ref = hop(cfg, v0, REF_RATE, 'match').gain;
    const w = rateWindow(cfg, v0);
    const good = Math.round(GOOD_SHARE * ref * 10) / 10;
    const gt = goodGainAt(v0);
    const ft = tooFastRate(v0);
    if (Math.abs(gt - good) > 0.6 || Math.abs(ft - w.hi) > 25) drift++;
    table.push([v0, good, w.hi]);
    lines.push(`  ${pad(v0, 5)}   ${pad(ref.toFixed(1), 10)}   ${pad(good.toFixed(1), 9)}   ${pad(gt.toFixed(1), 11)}   ${pad(`${w.best} (+${w.max.toFixed(0)})`, 12)}   ${pad(`${w.lo}–${w.hi}`, 12)}   ${pad(ft.toFixed(0), 18)}`);
  }
  lines.push(`\nTabellen in src/engine/strafeJudge.ts (${GOOD_GAIN_TABLE.length}/${FAST_TABLE.length} Stützstellen): ${drift === 0 ? 'passen zur Messung' : `${drift} Zeile(n) weichen ab — neu eintragen:`}`);
  if (drift > 0) {
    lines.push(`  GOOD_GAIN_TABLE = [${table.map(([v, g]) => `[${v}, ${g}]`).join(', ')}]`);
    lines.push(`  FAST_TABLE = [${table.map(([v, , f]) => `[${v}, ${f}]`).join(', ')}]`);
  }
  console.log(lines.join('\n'));
  const jp = process.argv.indexOf('--json');
  if (jp > 0 && process.argv[jp + 1]) writeFileSync(process.argv[jp + 1], JSON.stringify({ hops: json, table }, null, 1));
  if (drift > 0) process.exitCode = 1;
}
