/**
 * Kritik-Linse LOOK: Bot faehrt level1/level2 in Echtzeit, Screenshots bei
 * Speed-Schwellen (250/500/800/1100), Abschnitts-Eintritten (Route-Knoten) und
 * Checkpoints. Pro Lauf eine Pixelhoehe/Viewport-Kombination.
 *
 *   node tools/critique/look/capture.mjs [level1|level2 ...] [--cfg 240|270|360]
 * Port 5208. Ausgabe: shots/critique/look/<level>-<cfg>/ + meta.json
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = 5208;
const OUT = 'shots/critique/look';
const args = process.argv.slice(2);
const cfgArg = args.indexOf('--cfg');
const CFGS_ALL = {
  240: { vp: { width: 1280, height: 720 }, px: 240 },
  270: { vp: { width: 1920, height: 1080 }, px: 270 },
  360: { vp: { width: 1920, height: 1080 }, px: 360 },
};
const cfgKeys = cfgArg >= 0 ? [args[cfgArg + 1]] : Object.keys(CFGS_ALL);
const levels = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--cfg');
const LEVELS = levels.length ? levels : ['level1', 'level2'];

const SECTIONS = {
  level1: { 1: 'lauf', 8: 'rampe-cp1', 10: 'hopreihe-a', 13: 'hopreihe-b', 16: 'crouch-anlauf', 17: 'crouch-kante', 19: 'kehre-a', 22: 'kehre-b', 25: 'slalom-a', 28: 'slalom-b', 32: 'terrassen-a', 35: 'terrassen-b', 37: 'finale-gap', 38: 'ziel' },
  level2: { 2: 'anlauf', 5: 'auf-den-ring', 7: 'ring-a', 11: 'ring-b', 14: 'ring-c', 15: 'ausfahrt', 17: 'e1', 18: 'surf1', 21: 'surf2', 24: 'surf3', 27: 'surf4', 29: 'surf4b', 30: 'launch', 31: 'ziel' },
};
const SPEEDS = [250, 500, 800, 1100];

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  for (const key of cfgKeys) {
    const cfg = CFGS_ALL[key];
    for (const lv of LEVELS) await run(lv, key, cfg);
  }
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) console.error(errors.join('\n'));

async function run(level, key, cfg) {
  const dir = `${OUT}/${level}-${key}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: cfg.vp });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.evaluate((px) => window.__vel.setRenderSettings({ pixelHeight: px }), cfg.px);
  await page.evaluate((lv) => window.__vel.start(lv, { lockless: true }), level);
  const low = await page.evaluate(() => { const c = document.getElementById('vel-canvas'); return [c.width, c.height]; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/00-spawn.png` });
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  const meta = { level, cfg: key, viewport: cfg.vp, lowRes: low, shots: [] };
  const sec = SECTIONS[level];
  const seenSec = new Set();
  const seenSpeed = new Set();
  let cpSeen = 0;
  let pendingCp = null;
  const t0 = Date.now();
  let n = 1;
  const snap = async (tag, s) => {
    const name = `${String(n++).padStart(2, '0')}-${tag}.png`;
    await page.screenshot({ path: `${dir}/${name}` });
    const s2 = await page.evaluate(() => window.__vel.state());
    meta.shots.push({ name, t: (Date.now() - t0) / 1000, speed: Math.round(s2.speed), speedBefore: Math.round(s.speed), pos: s2.pos, yaw: s2.yawDeg, pitch: s2.pitchDeg, onGround: s2.onGround, surfing: s2.surfing, node: s2.bot?.nextIndex, cp: s2.checkpoint.index });
  };
  for (;;) {
    const s = await page.evaluate(() => window.__vel.state());
    const idx = s.bot?.nextIndex ?? 0;
    for (const k of Object.keys(sec)) {
      const ki = Number(k);
      if (idx >= ki && !seenSec.has(ki)) { seenSec.add(ki); if (idx === ki) await snap(`sec-${sec[k]}-${Math.round(s.speed)}`, s); }
    }
    for (const v of SPEEDS) {
      if (s.speed >= v && !seenSpeed.has(v)) { seenSpeed.add(v); await snap(`speed${v}`, s); }
    }
    if (s.checkpoint.index > cpSeen) { cpSeen = s.checkpoint.index; pendingCp = Date.now() + 250; }
    if (pendingCp && Date.now() >= pendingCp) { pendingCp = null; await snap(`cp${cpSeen}-hud`, s); }
    if (s.finish || s.gameState === 'finished') { await page.waitForTimeout(200); await snap('finish', s); break; }
    if (s.bot && s.bot.status === 'failed') { meta.failed = s.bot.reason; break; }
    if (Date.now() - t0 > 120000) { meta.timeout = true; break; }
    await page.waitForTimeout(30);
  }
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 1));
  console.log(`${level} ${key}: ${meta.shots.length} shots, lowRes ${low.join('x')}${meta.failed ? ' FAILED ' + meta.failed : ''}`);
  await page.close();
}
