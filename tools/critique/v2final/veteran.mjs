/**
 * Unabhängiger E2E-Prüfer v2: Veteran-Läufe L1–L4 im echten Spiel (Echtzeit) mit RouteFollower + Menschenmodellen.
 * Zählt Arcade-Mechaniken live aus dem Event-Log (Rutschen, Lande-Gnade = clean && !perfect, Kanten-Assist, Respawns)
 * und vergleicht die Zeit mit den Medaillen des Index. Dazu Exploit-Proben (Ziel ohne Checkpoints).
 *
 *   node tools/critique/v2final/veteran.mjs [level …]     Port VET_PORT (Default 5420)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.VET_PORT ?? 5420);
const idx = JSON.parse(readFileSync('public/levels/index.json', 'utf8'));
const levels = process.argv.slice(2).length ? process.argv.slice(2) : ['level1', 'level2', 'level3', 'level4'];
const MODELS = (process.env.VET_MODELS ?? 'p:1:0,h1:1:1,h2:1:2,h3:1:3').split(',').map((s) => { const [n, sync, noise] = s.split(':'); return { n, sync: +sync, noise: +noise }; });
const SEEDS = Number(process.env.VET_SEEDS ?? 2);

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const out = { runs: [], exploits: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false }));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  for (const lv of levels) {
    await page.evaluate((id) => window.__vel.start(id, { lockless: true }), lv);
    await page.waitForFunction(() => window.__vel.state().gameState === 'playing', null, { timeout: 20000 });
    const medals = idx.find((e) => e.id === lv)?.medals;
    for (const m of MODELS) {
      for (let seed = 1; seed <= (m.noise ? SEEDS : 1); seed++) {
        await page.evaluate(() => { window.__vel.events(); window.__vetT = window.__vel.events().at(-1)?.t ?? 0; });
        await page.evaluate(({ m, seed }) => window.__vel.useBot('route', { sync: m.sync, aimNoiseDeg: m.noise, seed, timeout: 90 }), { m, seed });
        const t0 = Date.now();
        let st;
        const ev = [];
        while (Date.now() - t0 < 95000) {
          await page.waitForTimeout(500);
          const r = await page.evaluate(() => {
            const all = window.__vel.events().filter((e) => e.t > window.__vetT);
            if (all.length) window.__vetT = all.at(-1).t;
            const s = window.__vel.state();
            return { s: { g: s.gameState, finish: s.finish, bot: s.bot, runTime: s.runTime, cp: s.checkpoint, top: s.topSpeed, fps: s.fps }, ev: all.map((e) => ({ type: e.type, perfect: e.perfect, clean: e.clean, kind: e.kind, reason: e.reason, speed: e.speed, boost: e.boost, dy: e.dy, sync: e.sync })) };
          });
          st = r.s; ev.push(...r.ev);
          if (st.finish || (st.bot && st.bot.done)) break;
          if (st.bot === null && Date.now() - t0 > 3000) break;
        }
        const cnt = (f) => ev.filter(f).length;
        const time = st.finish?.time ?? null;
        const medal = time == null || !medals ? null : time <= medals.velocity ? 'VELOCITY' : time <= medals.gold ? 'Gold' : time <= medals.silver ? 'Silber' : time <= medals.bronze ? 'Bronze' : 'keine';
        const run = {
          level: lv, model: m.n, seed, time, medal, cp: st.cp, top: Math.round(st.top ?? 0), fps: st.fps, bot: st.bot,
          jumps: cnt((e) => e.type === 'jump'), perfect: cnt((e) => e.type === 'jump' && e.perfect), graceClean: cnt((e) => e.type === 'jump' && e.clean && !e.perfect),
          slides: cnt((e) => e.type === 'slideStart'), ledgeStep: cnt((e) => e.type === 'ledge' && e.kind === 'step'), ledgeVault: cnt((e) => e.type === 'ledge' && e.kind === 'vault'),
          respawns: cnt((e) => e.type === 'respawn'), respawnReasons: [...new Set(ev.filter((e) => e.type === 'respawn').map((e) => e.reason))],
        };
        out.runs.push(run);
        console.log(JSON.stringify(run));
        await page.evaluate(() => window.__vel.useBot(null));
        await page.waitForTimeout(300);
      }
    }
    // Exploit-Probe: direkt ins Ziel ohne Checkpoints
    const info = await page.evaluate(() => window.__vel.levelInfo());
    const fin = info.triggers.find((t) => t.kind === 'finish');
    if (fin) {
      await page.evaluate(() => window.__vel.restart());
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1 })));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__vel.setInputOverride(null));
      const c = { x: (fin.min.x + fin.max.x) / 2, y: fin.min.y + 2, z: (fin.min.z + fin.max.z) / 2 };
      await page.evaluate((c) => window.__vel.teleport(c.x, c.y, c.z), c);
      await page.waitForTimeout(600);
      const s = await page.evaluate(() => { const s = window.__vel.state(); return { finish: s.finish, cp: s.checkpoint, g: s.gameState }; });
      out.exploits.push({ level: lv, finishWithoutCp: !!s.finish, state: s });
      console.log('EXPLOIT', lv, JSON.stringify(s).slice(0, 200));
      await page.evaluate(() => window.__vel.restart());
    }
  }
} finally {
  out.errors = errors;
  writeFileSync('tools/critique/v2final/logs/veteran.json', JSON.stringify(out, null, 1));
  await browser.close();
  await srv.close();
  console.log('Konsolenfehler', errors.length, errors.slice(0, 5));
}
