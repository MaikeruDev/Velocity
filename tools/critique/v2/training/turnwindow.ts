/**
 * Trainingsmodus-Entwurf (v2/training) — Messung 1: Drehraten-Fenster eines EINZELNEN Hops.
 *
 *   npx tsx tools/critique/v2/training/turnwindow.ts
 *
 * Ein Hop auf flachem Boden mit Starttempo v0 (u/s), in der Luft A bzw. D gehalten und die
 * Maus mit KONSTANTER Rate R (°/s) gedreht — so, wie ein Mensch "die Maus gleichmäßig zieht".
 * Gemessen (echte PlayerMovement, VELOCITY_DEFAULT, Strafe-Assist an):
 *   - Tempo-Gewinn Absprung → Landung (u/s)
 *   - "Coach-Sync" = Anteil der A/D-Ticks mit Tempo-Gewinn (Coach.ts, strafeLanding)
 * Varianten: Taste passt zur Maus (richtig), Taste gegen die Maus, nur W + Maus, A/D ohne Maus.
 *
 * Zweck: Schwellen für die Live-Diagnose im Training ("zu langsam", "zu schnell", "gegen die
 * Maus", "keine Maus", "nur W") und die Ansage "zieh die Maus mit ~X °/s" aus Messung statt Gefühl.
 * Ausgabe: shots/v2/training/turnwindow.json + Tabelle auf stdout.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import type { MutablePlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel } from '../../../sim/levels';

const OUT = 'shots/v2/training';
mkdirSync(OUT, { recursive: true });
const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const DEG = Math.PI / 180;
const level = compileLevel(flatLevel(60000));

type Variant = 'match' | 'against' | 'wOnly' | 'noMouse';

interface HopResult {
  readonly gain: number;
  readonly sync: number;
  readonly air: number;
  /** Kursänderung der Flugrichtung (°) während des Hops. */
  readonly curve: number;
}

/** Ein Hop: Start am Boden mit Tempo v0 Richtung −Z, Sprung im ersten Tick, bis zur Landung. */
function hop(v0: number, rateDeg: number, variant: Variant, delay = 0): HopResult {
  const pm = new PlayerMovement(level.world, CFG);
  pm.state.vel.set(0, 0, -v0);
  pm.teleport(new Vector3(0, 0.01, 30000), { keepVelocity: true });
  // ein Boden-Tick, damit onGround sicher steht
  const inp: MutablePlayerInput = { ...NO_INPUT };
  let yaw = 0;
  let startSpeed = -1;
  let startDir = 0;
  let sideTicks = 0;
  let gainTicks = 0;
  let airTicks = 0;
  let prevSpeed = pm.state.speed;
  // Linkskurve: yaw steigt (positiv = links). "match" = A (side −1) bei Linksdrehung.
  for (let t = 0; t < CFG.tickRate * 3; t++) {
    const onGround = pm.state.onGround;
    if (t > 0 && onGround && startSpeed >= 0) {
      const dir = Math.atan2(-pm.state.vel.x, -pm.state.vel.z);
      return { gain: pm.state.speed - startSpeed, sync: sideTicks > 0 ? gainTicks / sideTicks : 0, air: airTicks * DT, curve: (dir - startDir) / DEG };
    }
    inp.jumpHeld = t === 0;
    inp.jumpPressed = t === 0;
    const inAir = t > 0 && !onGround;
    const acting = inAir && airTicks * DT >= delay;
    if (acting && variant !== 'noMouse') yaw += (rateDeg * DEG) / CFG.tickRate;
    inp.yaw = yaw;
    inp.forward = variant === 'wOnly' ? 1 : t === 0 ? 1 : 0;
    inp.side = !acting ? 0 : variant === 'match' || variant === 'noMouse' ? -1 : variant === 'against' ? 1 : 0;
    inp.sprint = false;
    prevSpeed = pm.state.speed;
    pm.tick(inp);
    if (!pm.state.onGround) {
      if (startSpeed < 0) {
        startSpeed = prevSpeed;
        startDir = Math.atan2(-pm.state.vel.x, -pm.state.vel.z);
      }
      airTicks++;
      if (inp.side !== 0) {
        sideTicks++;
        if (pm.state.speed > prevSpeed + 1e-3) gainTicks++;
      }
    }
  }
  return { gain: NaN, sync: NaN, air: NaN, curve: NaN };
}

const SPEEDS = [250, 320, 450, 600, 800, 1000];
const RATES = [0, 20, 40, 60, 90, 120, 180, 240, 360, 540, 720, 1080];
const table: Record<string, Record<string, HopResult>> = {};
const lines: string[] = [];
const pad = (s: string, n: number): string => s.padStart(n);

for (const variant of ['match', 'against', 'wOnly', 'noMouse'] as const) {
  lines.push(`\n## ${variant}: Gewinn je Hop (u/s) / Coach-Sync % / Kurve (°)`);
  lines.push(`${pad('v0 \\ °/s', 9)} ${RATES.map((r) => pad(String(r), 14)).join('')}`);
  for (const v0 of SPEEDS) {
    const row: string[] = [];
    for (const r of RATES) {
      const res = hop(v0, r, variant);
      (table[`${variant}@${v0}`] ??= {})[r] = res;
      row.push(pad(`${res.gain.toFixed(0)}/${Math.round(res.sync * 100)}/${res.curve.toFixed(0)}`, 14));
    }
    lines.push(`${pad(String(v0), 9)} ${row.join('')}`);
  }
}

// Reaktionszeit: A/D + Maus erst nach d s in der Luft (Anfänger drückt spät).
lines.push('\n## match mit Reaktionsverzug (v0 320, 120 °/s): Gewinn je Hop');
const delays = [0, 0.1, 0.2, 0.3, 0.4];
for (const d of delays) {
  const res = hop(320, 120, 'match', d);
  lines.push(`  Verzug ${d.toFixed(1)} s: +${res.gain.toFixed(1)} u/s, Sync ${Math.round(res.sync * 100)} %`);
  table[`delay@${d}`] = { 120: res };
}

// Beste Rate je Tempo (für die Ansage und die Zu-schnell-Grenze).
lines.push('\n## Fenster je Tempo (match): Rate mit max. Gewinn, Bereich mit ≥ 50 % des Max-Gewinns');
const fine = Array.from({ length: 145 }, (_, i) => i * 10);
const windows: Record<string, { best: number; lo: number; hi: number; max: number }> = {};
for (const v0 of SPEEDS) {
  const g = fine.map((r) => hop(v0, r, 'match').gain);
  let bi = 0;
  g.forEach((x, i) => {
    if (x > g[bi]) bi = i;
  });
  const half = g[bi] * 0.5;
  let lo = bi;
  while (lo > 0 && g[lo - 1] >= half) lo--;
  let hi = bi;
  while (hi < g.length - 1 && g[hi + 1] >= half) hi++;
  windows[v0] = { best: fine[bi], lo: fine[lo], hi: fine[hi], max: g[bi] };
  lines.push(`  ${v0} u/s: bestes ${fine[bi]} °/s (+${g[bi].toFixed(1)}), ≥50 %: ${fine[lo]}–${fine[hi]} °/s`);
}

console.log(lines.join('\n'));
writeFileSync(`${OUT}/turnwindow.json`, JSON.stringify({ table, windows }, null, 1));
