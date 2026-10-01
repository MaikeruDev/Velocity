/**
 * Unabhängiger E2E-Prüfer v2: Arcade-Mechaniken live im Spiel (tick-synchron per setInputOverride), Event-Log zählt.
 *  1 Rutschen L1-Start (Sprint 1 s, dann C 1.5 s)   2 Lande-Gnade: Bhop mit 1–6 Ticks zu spätem Druck
 *  3 Kanten-Assist L4 an Crouch-Knoten: W + Sprung gehalten, C 0/80/160 ms nach dem Absprung
 *  4 Luftlenkung: 320 u/s, Blick 90° daneben, nur W 0.3 s
 *
 *   node tools/critique/v2final/mechanics.mjs    Port MECH_PORT (Default 5420)
 */
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.MECH_PORT ?? 5420);
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const out = {};
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  const go = async (id) => { await page.evaluate((id) => window.__vel.start(id, { lockless: true }), id); await page.waitForFunction(() => window.__vel.state().gameState === 'playing'); await page.waitForTimeout(300); };
  const evs = (since) => page.evaluate((since) => window.__vel.events().filter((e) => e.t > since).map((e) => ({ type: e.type, perfect: e.perfect, clean: e.clean, kind: e.kind, speed: e.speed !== undefined ? Math.round(e.speed) : undefined, boost: e.boost, dy: e.dy })), since);
  const now = () => page.evaluate(() => window.__vel.events().at(-1)?.t ?? 0);

  // 1 Rutschen
  await go('level1');
  await page.evaluate(() => window.__vel.restart());
  let t = await now();
  await page.evaluate(() => { let n = 0; window.__vel.setInputOverride(() => { n++; return { forward: 1, sprint: true, crouch: n > 128, yaw: 0 }; }); });
  const sp = [];
  for (let i = 0; i < 14; i++) { await page.waitForTimeout(200); sp.push(Math.round(await page.evaluate(() => window.__vel.state().speed))); }
  await page.evaluate(() => window.__vel.setInputOverride(null));
  out.slide = { speeds200ms: sp, events: (await evs(t)).filter((e) => e.type.startsWith('slide')) };
  console.log('slide', JSON.stringify(out.slide));

  // 2 Lande-Gnade: Bhop auf flachem Boden, Druck k Ticks nach der Landung
  out.grace = [];
  for (const late of [0, 2, 4, 6, 8, 10, 12]) {
    await page.evaluate(() => window.__vel.restart());
    await page.waitForTimeout(200);
    t = await now();
    await page.evaluate((late) => {
      let n = 0, groundTicks = 0, jumps = 0;
      window.__vel.setInputOverride((st) => {
        n++;
        if (st.onGround) groundTicks++; else groundTicks = 0;
        // Anlauf 0.6 s, dann: erster Sprung sofort, danach Druck genau `late` Ticks nach der Landung
        if (n < 77) return { forward: 1, sprint: true, yaw: 0 };
        const press = jumps === 0 ? true : groundTicks === late + 1;
        if (press && st.onGround) jumps++;
        return { forward: 1, sprint: true, yaw: 0, jumpHeld: press, jumpPressed: press };
      });
    }, late);
    await page.waitForTimeout(2200);
    await page.evaluate(() => window.__vel.setInputOverride(null));
    const e = (await evs(t)).filter((x) => x.type === 'jump');
    out.grace.push({ lateTicks: late, jumps: e.length, perfect: e.filter((x) => x.perfect).length, cleanNotPerfect: e.filter((x) => x.clean && !x.perfect).length, dirty: e.filter((x) => !x.clean).length });
  }
  console.log('grace', JSON.stringify(out.grace));

  // 4 Luftlenkung
  await page.evaluate(() => window.__vel.restart());
  await page.waitForTimeout(200);
  out.airControl = await page.evaluate(async () => {
    const v = window.__vel;
    v.freeze(true);
    const s0 = v.state();
    v.teleport(s0.pos.x, s0.pos.y + 200, s0.pos.z, 0);
    v.setVelocity(0, 0, -320);
    v.setInputOverride(() => ({ forward: 1, yaw: Math.PI / 2 }));
    v.stepTicks(38);
    const s = v.state();
    v.setInputOverride(null);
    v.freeze(false);
    return { turnDeg: +((Math.atan2(-s.vel.x, -s.vel.z) * 180) / Math.PI).toFixed(1), speed: +Math.hypot(s.vel.x, s.vel.z).toFixed(1) };
  });
  console.log('airControl', JSON.stringify(out.airControl));

  // 3 Kanten-Assist L4
  await go('level4');
  const route = await page.evaluate(() => window.__vel.levelInfo().route);
  const ci = route.findIndex((r) => r.crouch);
  out.ledge = [];
  if (ci > 0) {
    const a = route[ci - 1].pos, b = route[ci].pos;
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    for (const cDelay of [0, 10, 20, 30, 45]) {
      for (const speed of [250, 320, 450]) {
        t = await now();
        const r = await page.evaluate(({ a, b, yaw, cDelay, speed }) => {
          const v = window.__vel;
          v.freeze(true);
          // 160 u vor dem Absprungknoten starten
          const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
          const sx = b.x - (dx / L) * 160, sz = b.z - (dz / L) * 160;
          v.teleport(sx, b.y + 1, sz, (yaw * 180) / Math.PI);
          v.setVelocity((dx / L) * speed, 0, (dz / L) * speed);
          let air = -1, n = 0;
          v.setInputOverride((st) => {
            n++;
            const dist = Math.hypot(st.pos.x - sx, st.pos.z - sz);
            const jump = dist >= 160 && st.onGround && air < 0;
            if (jump) air = 0;
            else if (air >= 0 && !st.onGround) air++;
            return { forward: 1, sprint: true, yaw, jumpHeld: jump, jumpPressed: jump, crouch: air >= cDelay && air >= 0 && air < 200 };
          });
          const y0 = b.y;
          v.stepTicks(128 * 1.6);
          const s = v.state();
          v.setInputOverride(null);
          v.freeze(false);
          return { dy: Math.round(s.pos.y - y0), speed: Math.round(s.speed) };
        }, { a, b, yaw, cDelay, speed });
        const e = (await evs(t)).filter((x) => x.type === 'ledge');
        out.ledge.push({ cDelayTicks: cDelay, speed, up: r.dy > 30, endSpeed: r.speed, ledge: e.map((x) => `${x.kind}:${x.dy ?? ''}`) });
      }
    }
  }
  console.log('ledge', JSON.stringify(out.ledge));
} finally {
  out.errors = errors;
  writeFileSync('tools/critique/v2final/logs/mechanics.json', JSON.stringify(out, null, 1));
  await browser.close();
  await srv.close();
  console.log('errors', errors.length);
}
