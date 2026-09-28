/**
 * Prüfer (Plan 003, S4): die ersten 90 s im echten Spiel, Echtzeit, 1280×720.
 *   node tools/critique/verify1/play90.mjs [szenario ...]   (PORT via V1_PORT, Default 5235)
 * Szenarien: keys-l1 keys-l2 (echte Tasten W+Leertaste gehalten, Blick auf den nächsten Knoten),
 *   naive-l1 naive-l2 (Projekt-NaiveBot), hand5-l1 hand5-l2 (RouteFollower 5°),
 *   vet-l1 vet-l2 (sync 1.0 bis ins Ziel, dann Neustart mit sync 0.85 gegen den Ghost).
 * Ausgabe: shots/verify1/play/<szenario>/*.png + report.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.V1_PORT ?? 5235);
const OUT = 'shots/verify1/play';
const ALL = ['keys-l1', 'keys-l2', 'naive-l1', 'naive-l2', 'hand5-l1', 'hand5-l2', 'vet-l1', 'vet-l2'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const report = {};

async function open(level) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await p.goto(srv.url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__vel?.ready === true);
  await p.evaluate(async () => { await document.fonts.ready; });
  const ok = await p.evaluate((lv) => window.__vel.start(lv, { lockless: true }), level);
  if (!ok) throw new Error('start fehlgeschlagen');
  await p.evaluate(() => window.__vel.events());
  await p.waitForTimeout(400);
  return { p, errors };
}

/** Blick jedes Frame auf den nächsten Routenknoten (Mensch schaut zur nächsten Plattform). */
async function steerToRoute(p) {
  await p.evaluate(() => {
    const v = window.__vel;
    const route = v.levelInfo().route;
    let i = 1;
    const step = () => {
      const s = v.state();
      if (s.gameState !== 'playing') { requestAnimationFrame(step); return; }
      // nächster Knoten = erster, der noch vor uns liegt (nach Respawn zurücksetzen)
      let best = 0, bd = Infinity;
      for (let k = 0; k < route.length; k++) {
        const n = route[k].pos;
        const d = Math.hypot(n.x - s.pos.x, n.z - s.pos.z) + Math.abs(n.y - s.pos.y) * 2;
        if (d < bd) { bd = d; best = k; }
      }
      i = Math.min(route.length - 1, Math.max(best + 1, 1));
      const n = route[i].pos;
      const d = Math.hypot(n.x - s.pos.x, n.z - s.pos.z);
      if (d < 120 && i + 1 < route.length) i++;
      const t = route[i].pos;
      const yaw = Math.atan2(-(t.x - s.pos.x), -(t.z - s.pos.z)) * 180 / Math.PI;
      v.setView(yaw, 0);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function watch(p, dir, seconds, { shotEvery = 10, stopOnFinish = true } = {}) {
  const log = [];
  let lastHints = '{}';
  let lastShot = -1e9;
  let shots = 0;
  const t0 = Date.now();
  let deaths = 0;
  let lastNotice = null;
  let maxCp = 0;
  let maxSpeed = 0;
  let firstSurfHint = null, firstCrouchHint = null, firstStrafeHint = null;
  for (;;) {
    const el = (Date.now() - t0) / 1000;
    if (el > seconds) break;
    const s = await p.evaluate(() => window.__vel.state());
    const ev = await p.evaluate(() => window.__vel.events());
    deaths = ev.filter((e) => e.type === 'respawn' && e.reason !== 'manual' && e.reason !== 'restart').length;
    maxCp = Math.max(maxCp, s.checkpoint.index);
    maxSpeed = Math.max(maxSpeed, s.speed);
    const hints = JSON.stringify(s.hints);
    const row = { t: +el.toFixed(2), x: Math.round(s.pos.x), y: Math.round(s.pos.y), z: Math.round(s.pos.z), v: Math.round(s.speed), g: s.onGround, surf: s.surfing, cp: s.checkpoint.index, chain: s.hopChain, notice: s.notice, hints: s.hints, state: s.gameState, deaths };
    log.push(row);
    if (s.hints.surf && firstSurfHint === null) firstSurfHint = el;
    if (s.hints.crouch && firstCrouchHint === null) firstCrouchHint = el;
    if (s.hints.strafe && firstStrafeHint === null) firstStrafeHint = el;
    const trig = hints !== lastHints || (s.notice && s.notice !== lastNotice);
    if ((trig || el - lastShot >= shotEvery) && shots < 24) {
      await p.waitForTimeout(trig ? 120 : 0);
      const tag = trig ? `hint-${Object.entries(s.hints).filter(([, v]) => v).map(([k]) => k).join('+') || 'notice'}` : 't';
      await p.screenshot({ path: `${dir}/${String(Math.round(el * 10)).padStart(4, '0')}-${tag}.png` });
      lastShot = el;
      shots++;
    }
    lastHints = hints;
    lastNotice = s.notice;
    if (stopOnFinish && (s.finish || s.gameState === 'finished')) {
      await p.waitForTimeout(1800);
      await p.screenshot({ path: `${dir}/zz-result.png` });
      break;
    }
    await p.waitForTimeout(250);
  }
  const last = log[log.length - 1];
  return { seconds: last?.t, maxCp, maxSpeed: Math.round(maxSpeed), deaths, firstSurfHint, firstCrouchHint, firstStrafeHint, finish: last?.state === 'finished', end: last, speedAt: [10, 20, 30, 60, 90].map((k) => log.find((r) => r.t >= k)?.v ?? null), log };
}

const SC = {
  async keys(level, dir) {
    const { p, errors } = await open(level);
    await steerToRoute(p);
    await p.keyboard.down('KeyW');
    await p.keyboard.down('Space');
    const r = await watch(p, dir, 90);
    await p.keyboard.up('Space');
    await p.keyboard.up('KeyW');
    await p.close();
    return { ...r, errors };
  },
  async naive(level, dir) {
    const { p, errors } = await open(level);
    await p.evaluate(() => window.__vel.useBot('naive', {}));
    const r = await watch(p, dir, 30);
    await p.close();
    return { ...r, errors };
  },
  async hand5(level, dir) {
    const { p, errors } = await open(level);
    await p.evaluate(() => window.__vel.useBot('route', { aimNoiseDeg: 5, seed: 3 }));
    const r = await watch(p, dir, 90, { shotEvery: 12 });
    await p.close();
    return { ...r, errors };
  },
  async vet(level, dir) {
    const { p, errors } = await open(level);
    await p.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    const a = await watch(p, dir, 60, { shotEvery: 3 });
    const res1 = await p.evaluate(() => ({ finish: window.__vel.state().finish, ghost: window.__vel.ghost() }));
    // zweiter Lauf gegen den Ghost der Bestzeit
    mkdirSync(`${dir}/ghost`, { recursive: true });
    await p.evaluate(() => window.__vel.useBot('route', { sync: 0.85, seed: 5 }));
    await p.waitForTimeout(300);
    const b = await watch(p, `${dir}/ghost`, 60, { shotEvery: 2 });
    const res2 = await p.evaluate(() => ({ finish: window.__vel.state().finish, ghost: window.__vel.ghost() }));
    await p.close();
    return { run1: { ...a, log: undefined }, res1, run2: { ...b, log: undefined }, res2, errors };
  },
};

try {
  for (const name of want) {
    const [kind, lv] = name.split('-');
    const level = lv === 'l1' ? 'level1' : 'level2';
    const dir = `${OUT}/${name}`;
    mkdirSync(dir, { recursive: true });
    const r = await SC[kind](level, dir);
    report[name] = r;
    const s = { ...r, log: undefined };
    console.log(name, JSON.stringify(s).slice(0, 1500));
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  }
} finally {
  await browser.close();
  await srv.close();
}
