/**
 * Unabhängiger E2E-Prüfer v2: T8-Grundtechnik im echten Spiel auf L3 (tick-synchron über setInputOverride, aber
 * OHNE Werkzeug-Achse): Blick = entlang der Rampe (senkrecht zur horizontalen Surf-Normale, in Flugrichtung) + Versatz
 * + AR(1)-Rauschen σ (τ 0.15 s), Taste in die Rampe. In der Luft: Blick halten, keine Taste. Start: W + Sprung gehalten.
 *
 *   node tools/critique/v2final/surfbrowser.mjs     Port SURF_PORT (Default 5418)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.SURF_PORT ?? 5418);
const idx = JSON.parse(readFileSync('public/levels/index.json', 'utf8'));
const LEVEL = process.env.SURF_LEVEL ?? 'level3';
const medals = idx.find((e) => e.id === LEVEL).medals;
const CASES = [];
for (const sigma of (process.env.SURF_SIGMAS ?? '0.5,1,2,3').split(',').map(Number)) for (const look of (process.env.SURF_LOOKS ?? '0').split(',').map(Number)) for (let seed = 1; seed <= Number(process.env.SURF_SEEDS ?? 2); seed++) CASES.push({ sigma, look, seed });

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const res = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.evaluate((id) => window.__vel.start(id, { lockless: true }), LEVEL);
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing', null, { timeout: 20000 });
  for (const c of CASES) {
    await page.evaluate(() => window.__vel.restart());
    await page.waitForTimeout(300);
    await page.evaluate((c) => {
      const DEG = Math.PI / 180;
      let s = c.seed * 7919 + 13;
      const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const k = Math.exp(-1 / 128 / 0.15);
      let aim = 0;
      let yaw = null;
      let lastSide = 0;
      window.__surfLog = { surfTicks: 0, airTicks: 0, respawnsSeen: 0 };
      const info = window.__vel.levelInfo();
      const spawnYaw = info.spawnYaw;
      const spawns = [{ p: info.spawn, yaw: info.spawnYaw }, ...info.triggers.filter((t) => t.kind === 'checkpoint').map((t) => ({ p: t.spawn, yaw: t.spawnYaw }))];
      let prev = null;
      let sinceSurf = 99;
      window.__vel.setInputOverride((st) => {
        const g = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
        aim = aim * k + g * c.sigma * DEG * Math.sqrt(1 - k * k);
        if (yaw === null) yaw = spawnYaw;
        // Respawn (Sprung > 300 u): Blick wie der Spawn des nächsten Checkpoints
        if (prev && Math.hypot(st.pos.x - prev.x, st.pos.y - prev.y, st.pos.z - prev.z) > 300) {
          let best = spawns[0], bd = 1e18;
          for (const sp of spawns) { const d = Math.hypot(sp.p.x - st.pos.x, sp.p.y - st.pos.y, sp.p.z - st.pos.z); if (d < bd) { bd = d; best = sp; } }
          yaw = best.yaw; lastSide = 0; sinceSurf = 99; window.__surfLog.respawnsSeen++;
        }
        prev = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
        const n = st.surfNormal;
        const nh = Math.hypot(n.x, n.z);
        if (st.surfing && nh > 0.1) {
          window.__surfLog.surfTicks++;
          sinceSurf = 0;
          let ax = -n.z / nh, az = n.x / nh;
          if (ax * st.vel.x + az * st.vel.z < 0) { ax = -ax; az = -az; }
          const axisYaw = Math.atan2(-ax, -az);
          const rx = Math.cos(axisYaw), rz = -Math.sin(axisYaw);
          const into = -(n.x * rx + n.z * rz);
          lastSide = into > 0 ? 1 : -1;
          yaw = axisYaw - lastSide * c.look * DEG;
          return { side: lastSide, forward: 0, jumpHeld: false, sprint: true, yaw: yaw + aim };
        }
        if (!st.onGround) {
          window.__surfLog.airTicks++;
          sinceSurf += 1 / 128;
          // Mensch hält die Taste über kurze Luftphasen (Fugen) weiter
          const sp = Math.hypot(st.vel.x, st.vel.z);
          if (sinceSurf < 0.4) return { side: lastSide, yaw: yaw + aim, sprint: true };
          if (sp > 50) yaw = Math.atan2(-st.vel.x, -st.vel.z);
          return { yaw: yaw + aim, sprint: true };
        }
        const sp = Math.hypot(st.vel.x, st.vel.z);
        if (sp > 200) yaw = Math.atan2(-st.vel.x, -st.vel.z);
        return { forward: 1, jumpHeld: true, sprint: true, yaw: yaw + aim };
      });
    }, c);
    const t0 = Date.now();
    let st;
    while (Date.now() - t0 < 45000) {
      await page.waitForTimeout(400);
      st = await page.evaluate(() => { const s = window.__vel.state(); return { finish: s.finish, runTime: s.runTime, cp: s.checkpoint, top: s.topSpeed, log: window.__surfLog, ev: window.__vel.events(40).filter((e) => e.type === 'respawn').length }; });
      if (st.finish) break;
    }
    const resp = await page.evaluate(() => window.__vel.events(512).filter((e) => e.type === 'respawn' && e.reason !== 'restart').length);
    await page.evaluate(() => window.__vel.setInputOverride(null));
    const time = st.finish?.time ?? null;
    const medal = time == null ? null : time <= medals.velocity ? 'VELOCITY' : time <= medals.gold ? 'Gold' : time <= medals.silver ? 'Silber' : time <= medals.bronze ? 'Bronze' : 'keine';
    const r = { ...c, time, medal, cp: st.cp, top: Math.round(st.top), respawnsRecent: resp };
    res.push(r);
    console.log(JSON.stringify(r));
  }
} finally {
  writeFileSync(`tools/critique/v2final/logs/surfbrowser-${LEVEL}.json`, JSON.stringify({ medals, res, errors }, null, 1));
  await browser.close();
  await srv.close();
  console.log('errors', errors.length);
}
