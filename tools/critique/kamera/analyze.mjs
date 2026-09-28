// Unabhängige Auswertung der Kamera-Rohdaten (record.mjs: fxState + rohe Kamera). Aus der Prüfung 27.09. übernommen.
import { readFileSync } from 'node:fs';
import { carve } from './carve.mjs';
const DIR = process.argv[2] ?? 'shots/critique/kamera/data';
const RAD = 180 / Math.PI;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const r = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '-';
function load(n) {
  const d = JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8'));
  const ix = Object.fromEntries(d.fields.map((f, i) => [f, i]));
  const t0 = d.frames[0][ix.t];
  const rows = d.frames.map((f) => { const o = {}; for (const k in ix) o[k] = f[ix[k]]; o.t = (o.t - t0) / 1000; o.onGround = o.onGround === 1; o.surfing = o.surfing === 1; o.speed = o.speed; return o; });
  const ev = d.events.map((e) => ({ ...e, t: (e.t - t0) / 1000 }));
  return { rows, ev, has: (k) => k in ix };
}
const hfov43 = (v) => 2 * Math.atan(Math.tan(v / 2 / RAD) * 4 / 3) * RAD;
for (const n of ['level1', 'level1h', 'level2', 'bhop', 'bhophuman']) {
  let L; try { L = load(n); } catch { continue; }
  const { rows, ev } = L;
  const jumps = ev.filter((e) => e.type === 'jump');
  const perf = jumps.filter((e) => e.perfect === true);
  const bad = jumps.filter((e) => e.perfect === false);
  const near = (t, w) => rows.filter((q) => q.t >= t - w && q.t <= t + w);
  const dyAt = (e) => Math.max(...near(e.t, 0.12).map((q) => Math.abs(q.cy - q.ey)));
  const pd = perf.map(dyAt).filter(Number.isFinite);
  const bd = bad.filter((e) => e.chain > 0).map(dyAt).filter(Number.isFinite);
  const popPk = perf.map((e) => Math.max(...rows.filter((q) => q.t >= e.t && q.t <= e.t + 0.25).map((q) => q.fxPop)));
  const yawOff = Math.max(...rows.map((q) => { let d = (q.ry - q.yaw) * RAD; d = ((d + 540) % 360) - 180; return Math.abs(d); }));
  const pitchOff = rows.map((q) => Math.abs((q.rx - q.pitch) * RAD));
  // FOV nach erstem Sprung
  const j0 = jumps[0];
  let fovDrop = NaN;
  if (j0) { const a = near(j0.t, 0.02)[0]; const b = rows.find((q) => q.t >= j0.t + 1); if (a && b) fovDrop = hfov43(b.vfov) - hfov43(a.vfov); }
  const air250 = rows.filter((q) => !q.onGround && q.speed > 250);
  const band = air250.filter((q) => q.speed < 600);
  // Roll-Vorzeichen gegen Kurvenrichtung (carve.mjs auf Augenpositionen)
  const cv = carve(rows.map((q) => ({ ...q, strafe: q.strafe, roll: q.roll })));
  let agree = 0, tot = 0;
  for (let i = 0; i < cv.length; i++) { const q = rows[i + 1]; if (q.onGround || q.surfing || q.speed < 200) continue; const roll = -q.rz * RAD; if (Math.abs(cv[i].aLat) > 300 && Math.abs(roll) > 0.2) { tot++; if (Math.sign(roll) === Math.sign(cv[i].aLat)) agree++; } }
  const surfRoll = rows.filter((q) => q.surfing).map((q) => Math.abs(q.rz * RAD));
  console.log(`\n## ${n}  (${rows.length} Frames, ${jumps.length} Sprünge, perfekt ${perf.length})`);
  console.log(`|Kamera−Auge| perfekte Hops: max ${r(Math.max(...pd))} p50 ${r(pct(pd, 0.5))} u · nicht perfekte (chain>0, n=${bd.length}): min ${r(Math.min(...bd))} p50 ${r(pct(bd, .5))}`);
  console.log(`Pop-Spitze je perfektem Hop: min ${r(Math.min(...popPk))} p50 ${r(pct(popPk, .5))} max ${r(Math.max(...popPk))}°`);
  console.log(`FOV (hFOV 4:3) erster Sprung → +1 s: ${r(fovDrop)}°  · max vFOV ${r(Math.max(...rows.map((q) => q.vfov)))}  max hFOV16:9 ${r(Math.max(...rows.map((q) => 2 * Math.atan(Math.tan(q.vfov / 2 / RAD) * q.aspect) * RAD)))}`);
  console.log(`Speed-Kick Ø (Luft>250) ${r(mean(air250.map((q) => q.fxKick)))}° · Surge Ø (Luft>250) ${r(mean(air250.map((q) => q.fxSurge)))}° · Surge Ø Band 250–600 ${r(mean(band.map((q) => q.fxSurge)))}°  · fovOffset max ${r(Math.max(...rows.map((q) => q.fxFov)))}`);
  console.log(`Roll-Vorzeichen = Kurve (Luft, |aLat|>300, |roll|>0.2): ${r(100 * agree / Math.max(1, tot), 0)} % (n=${tot}) · |Roll| Luft p50 ${r(pct(rows.filter((q) => !q.onGround && !q.surfing).map((q) => Math.abs(q.rz * RAD)), .5))}°`);
  if (surfRoll.length) console.log(`Surf |Roll| p50 ${r(pct(surfRoll, .5))}° p90 ${r(pct(surfRoll, .9))}° (n=${surfRoll.length})`);
  console.log(`BLICK: |cam.yaw − yaw| max ${r(yawOff, 4)}° · |cam.pitch − pitch| p50 ${r(pct(pitchOff, .5), 3)} p99 ${r(pct(pitchOff, .99), 3)} max ${r(Math.max(...pitchOff), 3)}°`);
}
