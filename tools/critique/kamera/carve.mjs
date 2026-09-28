/** Kamera-Kritik: Was würde ein Roll aus der Querbeschleunigung (Carve) statt aus der A/D-Taste zeigen? */
import { load, r, pct, mean } from './derive.mjs';
export function carve(rows, { tau = 0.08, full = 3072, maxDeg = 3 } = {}) {
  const out = [];
  let lat = 0, pvx = null, pvz = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const dt = b.t - a.t;
    if (!(dt > 0)) { out.push({ t: b.t, aLat: lat, roll: 0 }); continue; }
    const vx = (b.ex - a.ex) / dt, vz = (b.ez - a.ez) / dt;
    const jump = Math.hypot(b.ex - a.ex, b.ez - a.ez) > 100;
    let inst = 0;
    if (pvx !== null && !jump && !b.onGround) {
      // Querbeschleunigung = (v_prev × v) / |v| / dt  (Vorzeichen: + = Kurve nach rechts)
      const cross = pvx * vz - pvz * vx; // y-Komponente von v_prev × v (three: Y oben)
      const sp = Math.hypot(vx, vz);
      if (sp > 150) inst = cross / sp / dt; // ≈ v·ω
    }
    lat = lat + (inst - lat) * (1 - Math.exp(-dt / tau));
    pvx = jump ? null : vx; pvz = jump ? null : vz;
    // Rechtskurve in three (yaw nimmt ab, v dreht im Uhrzeigersinn von oben) → cross > 0? Vorzeichen später an A/D prüfen.
    out.push({ t: b.t, aLat: lat, roll: Math.max(-maxDeg, Math.min(maxDeg, (maxDeg * lat) / full)), strafe: b.strafe, speed: b.speed, keyRoll: b.roll });
  }
  return out;
}
if (process.argv[1].endsWith('carve.mjs')) {
  for (const n of ['bhop', 'bhophuman', 'level1', 'level1h', 'level2']) {
    const { rows } = load(n);
    const c = carve(rows).filter((x) => x.speed > 200);
    const al = c.map((x) => Math.abs(x.aLat));
    // Vorzeichen-Übereinstimmung mit A/D
    const withKey = c.filter((x) => x.strafe !== 0 && Math.abs(x.aLat) > 300);
    const agree = withKey.filter((x) => Math.sign(x.aLat) === Math.sign(x.strafe)).length / Math.max(1, withKey.length);
    console.log(n.padEnd(10), '|a_lat| p50', r(pct(al, 0.5), 0), 'p90', r(pct(al, 0.9), 0), 'u/s² | Carve-Roll |.| p50', r(pct(c.map((x) => Math.abs(x.roll)), 0.5), 2), '° | Tasten-Roll |.| p50', r(pct(c.map((x) => Math.abs(x.keyRoll)), 0.5), 2), '° | Vorzeichen = A/D:', r(100 * agree, 0), '%');
  }
}
