/**
 * Bot-Varianten ohne Bild durchspielen (gleicher Frame-Takt wie die Aufnahme): Zielzeit, Blick-Ruck.
 *   node tools/trailer/probe.mjs <level> '<botOpts-JSON>' […]
 */
import { BASE_SETTINGS, BPM, openGame, recordTake, startLevel } from './lib.mjs';
const [level, ...variants] = process.argv.slice(2);
const g = await openGame(Number(process.env.TRAILER_PORT ?? 5601));
const d = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
try {
  for (const v of variants) {
    const o = JSON.parse(v);
    await startLevel(g.page, level, BASE_SETTINGS);
    await g.page.evaluate(({ bpm, o }) => {
      window.__vel.film({ on: true, bpm, hud: true });
      window.__vel.useBot('route', o);
    }, { bpm: BPM, o });
    const t = await recordTake(g.page, `probe`, 45 * 60, { dry: true, until: (s) => s.fin !== null || s.bot === 'failed' });
    let flips = 0, prev = 0, maxd = 0, air = 0;
    for (let i = 1; i < t.length; i++) {
      const dy = d(t[i - 1].yaw, t[i].yaw);
      maxd = Math.max(maxd, Math.abs(dy));
      if (!t[i].g) air++;
      if (Math.abs(dy) > 0.3) { if (prev && Math.sign(dy) !== prev) flips++; prev = Math.sign(dy); }
    }
    const last = t.at(-1);
    const drops = [];
    for (let i = 15; i < t.length; i++) if (!t[i].fin && t[i - 15].sp - t[i].sp > 200 && (drops.length === 0 || i - drops.at(-1) > 30)) drops.push(i);
    console.log(v, '→', last.fin ? `Ziel ${last.fin.time.toFixed(2)}` : `KEIN Ziel (${last.bot}) cp ${last.cp}`, `Wenden/s ${(flips / (t.length / 60)).toFixed(2)}`, `max ${maxd.toFixed(1)}°/f`, `top ${Math.max(...t.map((s) => s.sp))}`, `Einbrüche ${drops.map((i) => (i / 60).toFixed(1) + 's').join(',') || '-'}`);
  }
} finally {
  await g.close();
}
