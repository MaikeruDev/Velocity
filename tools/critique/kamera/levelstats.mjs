import { load, pp, r, mean, pct } from './derive.mjs';
for (const name of process.argv.slice(2)) {
  const { rows, events } = load(name);
  const T = rows[rows.length - 1].t;
  console.log(`\n=== ${name}: ${r(T, 1)} s, ${rows.length} Frames`);
  const lands = events.filter((e) => e.type === 'land');
  const jumps = events.filter((e) => e.type === 'jump');
  console.log('Landungen', lands.length, 'Sprünge', jumps.length, 'Respawns', events.filter((e) => e.type === 'respawn').map((e) => `${r(e.t, 1)}s ${e.reason}`).join(', '));
  const imp = lands.map((e) => e.impact);
  console.log('Impact: p10', r(pct(imp, 0.1), 0), 'p50', r(pct(imp, 0.5), 0), 'p90', r(pct(imp, 0.9), 0), 'max', r(Math.max(...imp), 0), '| >450 (Shake):', imp.filter((x) => x > 450).length, '| >800:', imp.filter((x) => x > 800).length);
  // Pro Landung: Dip-Tiefe, Nick, Shake im Fenster 0..300 ms, und ob im selben Tick gesprungen (Bhop)
  const per = lands.map((e) => {
    const w = rows.filter((x) => x.t >= e.t && x.t < e.t + 0.3);
    const bh = jumps.some((j) => Math.abs(j.t - e.t) < 0.02);
    return { t: e.t, imp: e.impact, sp: e.speed, bhop: bh, dip: Math.min(0, ...w.map((x) => x.dip)), nod: w.length ? w.reduce((a, x) => (Math.abs(x.nod) > Math.abs(a) ? x.nod : a), 0) : 0, shake: Math.max(0, ...w.map((x) => x.shakeEnv)) };
  });
  for (const p of per) console.log(`  t=${r(p.t, 2)} impact ${r(p.imp, 0)} speed ${r(p.sp, 0)} ${p.bhop ? 'BHOP' : 'land'} dip ${r(p.dip, 2)} u nick ${r(p.nod, 3)}° shake ${r(p.shake, 3)}°`);
  // FOV
  const hf = rows.map((x) => x.hfov43);
  console.log('hFOV43: min', r(Math.min(...hf), 1), 'max', r(Math.max(...hf), 1), 'Mittel', r(mean(hf), 1));
  const rates = [];
  for (let i = 1; i < rows.length; i++) { const d = rows[i].t - rows[i - 1].t; if (d > 0) rates.push(Math.abs(rows[i].hfov43 - rows[i - 1].hfov43) / d); }
  console.log('|dFOV/dt| °/s: p50', r(pct(rates, 0.5), 2), 'p90', r(pct(rates, 0.9), 2), 'p99', r(pct(rates, 0.99), 2), 'max', r(Math.max(...rates), 1));
  // Pop: größte Einzelframe-Änderung
  let big = [];
  for (let i = 1; i < rows.length; i++) { const d = rows[i].hfov43 - rows[i - 1].hfov43; if (Math.abs(d) > 1) big.push(`${r(rows[i].t, 2)}s ${r(d, 2)}°`); }
  console.log('FOV-Sprünge >1°/Frame:', big.join(', ') || 'keine');
  // Speed-Verteilung und FOV-Kick vs Speed
  const sp = rows.map((x) => x.speed);
  console.log('Speed p10/p50/p90/max', r(pct(sp, 0.1), 0), r(pct(sp, 0.5), 0), r(pct(sp, 0.9), 0), r(Math.max(...sp), 0));
  for (const band of [[0, 300], [300, 500], [500, 700], [700, 900], [900, 1100], [1100, 2000]]) {
    const b = rows.filter((x) => x.speed >= band[0] && x.speed < band[1]);
    if (b.length) console.log(`  ${band[0]}-${band[1]} u/s: ${r((100 * b.length) / rows.length, 1)} % der Zeit, FOV-Kick Ø ${r(mean(b.map((x) => x.fovKick)), 2)}°`);
  }
  // Roll
  const air = rows.filter((x) => !x.onGround && !x.surfing);
  const surf = rows.filter((x) => x.surfing);
  const ar = air.map((x) => Math.abs(x.roll));
  console.log('Roll Luft: |roll| p50', r(pct(ar, 0.5), 2), 'p90', r(pct(ar, 0.9), 2), 'max', r(Math.max(0, ...ar), 2), `(Anteil Luft ${r((100 * air.length) / rows.length, 0)} %)`);
  if (surf.length) console.log('Roll Surf: |roll| p50', r(pct(surf.map((x) => Math.abs(x.roll)), 0.5), 2), 'max', r(Math.max(...surf.map((x) => Math.abs(x.roll))), 2), `(Anteil Surf ${r((100 * surf.length) / rows.length, 0)} %)`);
  // Strafe-Wechsel pro Sekunde in der Luft
  let flips = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].strafe !== 0 && rows[i - 1].strafe !== 0 && Math.sign(rows[i].strafe) !== Math.sign(rows[i - 1].strafe)) flips++;
  console.log('A/D-Wechsel', flips, '=', r(flips / T, 2), '/s');
  const rr = [];
  for (let i = 1; i < rows.length; i++) { const d = rows[i].t - rows[i - 1].t; if (d > 0) rr.push(Math.abs(rows[i].roll - rows[i - 1].roll) / d); }
  console.log('Roll-Rate °/s p90', r(pct(rr, 0.9), 1), 'max', r(Math.max(...rr), 1));
  // Shake gesamt
  const sh = rows.filter((x) => x.shakeEnv > 0.05);
  console.log('Frames mit Shake-Hüllkurve >0.05°:', sh.length, `(${r(sh.length / 60, 2)} s)`);
  // Stufenversatz
  const so = rows.map((x) => Math.abs(x.stepOff));
  console.log('Stufen-Versatz max', r(Math.max(...so), 2), 'Frames >0.5:', so.filter((x) => x > 0.5).length);
  // Bob am Boden
  const g = rows.filter((x) => x.onGround);
  console.log('Boden-Anteil', r((100 * g.length) / rows.length, 1), '% | bobV p-p am Boden', r(pp(g.map((x) => x.bobV)), 2));
}
