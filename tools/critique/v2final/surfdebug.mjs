// Debug: wo stirbt der Browser-Surfer auf L3 nach CP3? (eine Fahrt, Spur alle 0.2 s)
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const srv = await startDevServer(5418);
const browser = await launchBrowser();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__vel.start('level3', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing');
  await page.evaluate(() => {
    let yaw = window.__vel.levelInfo().spawnYaw;
    window.__vel.setInputOverride((st) => {
      const n = st.surfNormal; const nh = Math.hypot(n.x, n.z);
      if (st.surfing && nh > 0.1) {
        let ax = -n.z / nh, az = n.x / nh;
        if (ax * st.vel.x + az * st.vel.z < 0) { ax = -ax; az = -az; }
        yaw = Math.atan2(-ax, -az);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const into = -(n.x * rx + n.z * rz);
        return { side: into > 0 ? 1 : -1, sprint: true, yaw };
      }
      if (!st.onGround) return { yaw, sprint: true };
      const sp = Math.hypot(st.vel.x, st.vel.z); if (sp > 200) yaw = Math.atan2(-st.vel.x, -st.vel.z);
      return { forward: 1, jumpHeld: true, sprint: true, yaw };
    });
  });
  const trace = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await page.waitForTimeout(200);
    const s = await page.evaluate(() => { const s = window.__vel.state(); return { t: s.runTime, p: [Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z)], v: Math.round(s.speed), surf: s.surfing, g: s.onGround, cp: s.checkpoint.index, fin: !!s.finish, r: window.__vel.events(5).filter(e=>e.type==='respawn').map(e=>e.reason) }; });
    trace.push(s);
    if (s.fin) break;
  }
  console.log(trace.map((s) => JSON.stringify(s)).join('\n'));
} finally { await browser.close(); await srv.close(); }
