/**
 * Unabhängiger E2E-Prüfer v2: Neuling spielt L1 mit ECHTEN Events (Pointer Lock, Tastatur, Maus).
 * Stil 'hold': W + Leertaste gehalten, Blick zum nächsten Routenknoten (Mensch: ≤ 220 °/s, Zielrauschen),
 * C in der Luft an Crouch-Knoten (liest die ↑C-Markierung). Kein Strafen. Bis zu LIMIT s.
 * Stil 'strafe': nach T3/T4 — am Boden W, in der Luft A/D zur Seite des Ziels + Maus dorthin (90–160 °/s).
 *
 *   node tools/critique/v2final/l1newbie.mjs [hold|strafe] [level1]   Port NB2_PORT (Default 5417)
 */
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.NB2_PORT ?? 5417);
const style = process.argv[2] ?? 'hold';
const levelId = process.argv[3] ?? 'level1';
const LIMIT = Number(process.env.NB2_LIMIT ?? 150);
const DEG_PER_PX = 0.07128;
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const yawTo = (p, t) => (Math.atan2(-(t.x - p.x), -(t.z - p.z)) * 180) / Math.PI;
let seed = Number(process.env.NB2_SEED ?? 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const rec = { style, levelId, notices: [], respawns: [], cps: [], finish: null, maxNode: 0 };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
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
  await page.waitForTimeout(600);
  if (levelId !== 'level1') {
    const nr = levelId.replace('level', '0');
    await page.locator('button', { hasText: new RegExp(`^\\s*${nr}`) }).first().click();
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: /Klicken zum Starten/i }).click();
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing' && window.__vel.state().locked, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const route = await page.evaluate(() => window.__vel.levelInfo().route);
  // Sprung-/Crouch-Flags aus dem JSON (levelInfo liefert kein jump)
  const held = new Set();
  const setKeys = async (want) => {
    for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };
  let mouseX = 960;
  const turn = async (deg) => { const px = -deg / DEG_PER_PX; if (Math.abs(px) < 0.5) return; mouseX += px; await page.mouse.move(mouseX, 540); };
  let stillT = 0, node = 1, lastNotice = null, airT = 0, hop = 0, noise = 0, crouchT = 0, shots = 0;
  const t0 = Date.now();
  let last = t0;
  let lastT = 0;
  while ((Date.now() - t0) / 1000 < LIMIT) {
    const st = await page.evaluate((lastT) => {
      const v = window.__vel; const s = v.state();
      const ev = v.events().filter((e) => e.t > lastT);
      return { pos: s.pos, speed: s.speed, onGround: s.onGround, surfing: s.surfing, yaw: s.yawDeg, notice: s.notice, cp: s.checkpoint, finish: s.finish, runTime: s.runTime, hints: s.hints,
        ev: ev.map((e) => ({ type: e.type, t: e.t, reason: e.reason, index: e.index })), lastT: ev.length ? ev.at(-1).t : lastT };
    }, lastT);
    lastT = st.lastT;
    const now = Date.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const rt = +((now - t0) / 1000).toFixed(1);
    if (st.notice && st.notice !== lastNotice) { rec.notices.push({ t: rt, text: st.notice, speed: Math.round(st.speed) }); if (shots < 4) { await page.screenshot({ path: `tools/critique/v2final/shots/l1nb-${style}-notice${shots++}.png` }); } }
    lastNotice = st.notice;
    for (const e of st.ev) {
      if (e.type === 'respawn') { rec.respawns.push({ t: rt, reason: e.reason, node }); }
      if (e.type === 'checkpoint') rec.cps.push({ t: rt, runTime: st.runTime });
      if (e.type === 'jump') { hop++; airT = 0; }
    }
    if (st.ev.some((e) => e.type === 'respawn')) {
      // zurück: nächsten Knoten zur neuen Position suchen
      let best = node, bd = 1e9;
      for (let i = 0; i < route.length; i++) { const d = Math.hypot(route[i].pos.x - st.pos.x, route[i].pos.z - st.pos.z, route[i].pos.y - st.pos.y); if (d < bd) { bd = d; best = i; } }
      node = Math.min(route.length - 1, best + 1);
    }
    if (st.finish) { rec.finish = st.finish; break; }
    if (!rec.trace) rec.trace = [];
    if (rt - (rec.trace.at(-1)?.t ?? -9) >= 2) { rec.trace.push({ t: rt, pos: [Math.round(st.pos.x), Math.round(st.pos.y), Math.round(st.pos.z)], v: Math.round(st.speed), node, g: st.onGround, surf: st.surfing }); if (rt > 55 && !rec.midShot) { rec.midShot = true; await page.screenshot({ path: `tools/critique/v2final/shots/l1nb-${style}-${levelId}-mid.png` }); } }
    // Stillstand: nach 8 s drückt ein Mensch F (zurück zum Checkpoint) — vorher Position/Screenshot sichern
    if (st.speed < 30) stillT += dt; else stillT = 0;
    if (stillT > 8) {
      rec.stuck = rec.stuck ?? [];
      rec.stuck.push({ t: rt, pos: st.pos, node, yaw: st.yaw, onGround: st.onGround });
      if (rec.stuck.length <= 2) await page.screenshot({ path: `tools/critique/v2final/shots/l1nb-${style}-${levelId}-stuck${rec.stuck.length}.png` });
      await page.keyboard.press('KeyF');
      stillT = 0;
    }
    if (!st.onGround) airT += dt; else airT = 0;
    // Knoten weiterschalten
    const n = route[node];
    const dh = Math.hypot(n.pos.x - st.pos.x, n.pos.z - st.pos.z);
    // weiter, wenn nah dran oder schon vorbei (Projektion auf den Abschnitt hinter dem Knoten) — ein Mensch schaut nach vorn
    const pv = route[Math.max(0, node - 1)].pos;
    const sx = n.pos.x - pv.x, sz = n.pos.z - pv.z;
    const past = (st.pos.x - n.pos.x) * sx + (st.pos.z - n.pos.z) * sz > 0;
    if ((dh < 140 || past) && node < route.length - 1) node++;
    rec.maxNode = Math.max(rec.maxNode, node);
    const tgt = route[node].pos;
    noise = 0.95 * noise + (rnd() - 0.5) * 2;
    const d = wrap(yawTo(st.pos, tgt) + noise - st.yaw);
    const keys = new Set();
    let turnDeg;
    if (style === 'hold') {
      keys.add('KeyW'); keys.add('Space');
      turnDeg = Math.max(-220 * dt, Math.min(220 * dt, d));
      if (st.surfing) { keys.delete('KeyW'); }
    } else {
      keys.add('Space');
      if (st.onGround || airT < 0.1) { keys.add('KeyW'); turnDeg = Math.max(-220 * dt, Math.min(220 * dt, d)) * 0.5; }
      else {
        const side = d >= 0 ? 1 : -1;
        keys.add(side > 0 ? 'KeyA' : 'KeyD');
        turnDeg = side * Math.min(160, 70 + Math.abs(d) * 3) * (0.8 + 0.4 * rnd()) * dt;
      }
    }
    // ↑C: Crouch-Knoten in Reichweite → in der Luft ducken
    const cn = route.slice(Math.max(0, node - 1), node + 1).find((r) => r.crouch);
    if (cn && !st.onGround && Math.hypot(cn.pos.x - st.pos.x, cn.pos.z - st.pos.z) < 260) crouchT = 0.6;
    if (crouchT > 0) { crouchT -= dt; keys.add('KeyC'); }
    await setKeys(keys);
    await turn(turnDeg);
    await page.waitForTimeout(8);
  }
  await setKeys(new Set());
  rec.seconds = (Date.now() - t0) / 1000;
  const s = await page.evaluate(() => { const s = window.__vel.state(); return { cp: s.checkpoint, runTime: s.runTime, hints: s.hints, finish: s.finish, menu: s.menu }; });
  rec.end = s;
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `tools/critique/v2final/shots/l1nb-${style}-${levelId}-end.png` });
  rec.menuText = await page.evaluate(() => document.querySelector('.vel-menu:not([hidden])')?.innerText?.slice(0, 700) ?? null);
} finally {
  rec.errors = errors;
  writeFileSync(`tools/critique/v2final/logs/l1newbie-${style}-${levelId}.json`, JSON.stringify(rec, null, 1));
  await browser.close();
  await srv.close();
  console.log(JSON.stringify({ finish: rec.finish?.time ?? null, medal: rec.finish?.medal ?? null, respawns: rec.respawns.length, cps: rec.cps.length, maxNode: rec.maxNode, notices: rec.notices.map((n) => n.text), errors: errors.length }));
}
