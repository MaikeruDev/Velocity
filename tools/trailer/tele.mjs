// Telemetrie eines Takes kompakt: node tools/trailer/tele.mjs <take> [Schritt] [von] [bis]
import { readFileSync } from 'node:fs';
const [take, step = 30, from = 0, to = 1e9] = process.argv.slice(2);
const t = JSON.parse(readFileSync(`media/footage/frames/${take}/telemetry.json`, 'utf8'));
for (let i = +from; i < Math.min(t.length, +to); i += +step) {
  const s = t[i];
  console.log(`${String(i).padStart(5)} ${(i / 60).toFixed(2).padStart(6)}s ${s.gs.slice(0, 4)} ${String(s.sp).padStart(5)} vy${String(s.vy).padStart(5)} ${s.g ? 'G' : '-'}${s.surf ? 'S' : '-'}${s.slide ? 'L' : '-'}${s.duck ? 'D' : '-'} hop${String(s.hop).padStart(3)} cp${s.cp} y${String(s.y).padStart(6)} yaw${String(s.yaw).padStart(7)} ${s.trick ?? ''}${s.fin ? ' FIN' : ''}${s.menu ? ' MENU ' + s.menu : ''}`);
}
