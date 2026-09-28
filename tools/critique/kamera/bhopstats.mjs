import { load, pp, r, mean, pct } from './derive.mjs';
const name = process.argv[2] ?? 'bhop';
const { rows, events } = load(name);
const jumps = events.filter((e) => e.type === 'jump');
const lands = events.filter((e) => e.type === 'land');
console.log(name, 'Sprünge', jumps.length, 'Landungen', lands.length, 'Dauer', r(rows[rows.length - 1].t, 1));
const out = [];
for (let k = 0; k < lands.length; k++) {
  const e = lands[k];
  const j = jumps.find((x) => Math.abs(x.t - e.t) < 0.02);
  const w = rows.filter((x) => x.t >= e.t - 0.02 && x.t < e.t + 0.35);
  const air = rows.filter((x) => x.t > e.t + 0.1 && x.t < (lands[k + 1]?.t ?? e.t + 0.7) - 0.05);
  out.push({ hop: k + 1, t: e.t, imp: e.impact, sp: e.speed, perfect: j?.perfect ?? null, gain: j?.gain ?? null,
    dip: Math.min(...w.map((x) => x.dip)), nodMin: Math.min(...w.map((x) => x.pitchOff)), nodMax: Math.max(...w.map((x) => x.pitchOff)),
    fov: w.length ? w[0].hfov43 : 0, rollRange: air.length ? pp(air.map((x) => x.roll)) : 0, rollMaxAbs: air.length ? Math.max(...air.map((x) => Math.abs(x.roll))) : 0 });
}
for (const o of out.filter((o, i) => i < 5 || i % 5 === 0 || i >= out.length - 2)) console.log(`hop ${String(o.hop).padStart(2)} speed ${r(o.sp, 0)} imp ${r(o.imp, 0)} perfect ${o.perfect} dip ${r(o.dip, 2)}u pitch ${r(o.nodMin, 3)}..${r(o.nodMax, 3)}° hFOV43 ${r(o.fov, 1)} roll-Spanne ${r(o.rollRange, 2)}° max|roll| ${r(o.rollMaxAbs, 2)}°`);
const sp = rows.map((x) => x.speed);
console.log('Max Speed', r(Math.max(...sp), 0), 'Ende', r(sp[sp.length - 1], 0));
// A/D-Wechsel
let flips = 0;
for (let i = 1; i < rows.length; i++) if (rows[i].strafe !== 0 && rows[i - 1].strafe !== 0 && Math.sign(rows[i].strafe) !== Math.sign(rows[i - 1].strafe)) flips++;
console.log('A/D-Wechsel/s', r(flips / rows[rows.length - 1].t, 2));
