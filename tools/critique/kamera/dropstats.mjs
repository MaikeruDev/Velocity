import { load, r, pp } from './derive.mjs';
const d = load('drops');
const res = [];
for (const dr of d.raw.drops) {
  const rows = d.rows.slice(dr.start, dr.start + dr.n);
  const land = rows.findIndex((x) => x.onGround);
  const w = rows.slice(Math.max(0, land - 1));
  const t0 = rows[land].t;
  const imp = d.events.filter((e) => e.type === 'land')[res.length]?.impact;
  const dipMin = Math.min(...w.map((x) => x.dip));
  const tMin = w.find((x) => x.dip === dipMin).t - t0;
  const back = w.find((x) => x.t - t0 > tMin && x.dip > dipMin * 0.1);
  const vis = w.filter((x) => x.shakeEnv > 0.15);
  const o = { h: dr.h, impact: r(imp, 0), dip: r(dipMin, 2), tPeakMs: r(tMin * 1000, 0), t90Ms: back ? r((back.t - t0) * 1000, 0) : null, nod: r(Math.min(...w.map((x) => x.nod)), 3), shakeDegMax: r(Math.max(...w.map((x) => x.shakeEnv)), 3), shakeVisS: r(vis.length / 60, 3), yawJitterPP: r(pp(w.map((x) => x.yawOff)), 3), pxShake: r(Math.max(...w.map((x) => x.shakeEnv)) * w[0].pxPerDeg, 2) };
  res.push(o);
  console.log(JSON.stringify(o));
}
