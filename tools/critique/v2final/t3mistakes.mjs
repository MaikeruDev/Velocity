/**
 * Unabhängiger E2E-Prüfer v2: typische Neulingsfehler in T3 LINKSKURVE mit ECHTEN Events — welche Rückmeldung kommt
 * (Urteil am Gain-Popup, Tipp im Coach-Band), wie schnell, und ist sie richtig? Je Fehlerbild 20 s, Lektion neu.
 *
 *   node tools/critique/v2final/t3mistakes.mjs     Port MIS_PORT (Default 5417)
 */
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.MIS_PORT ?? 5417);
const DEG_PER_PX = 0.07128;
const SECONDS = Number(process.env.MIS_S ?? 20);
// key: Tasten in der Luft, rate: Maus °/s (+ = links), w: W am Boden, ground: Tasten am Boden zusätzlich
const CASES = {
  ok90: { air: ['KeyA'], rate: 90, w: true },
  noMouse: { air: ['KeyA'], rate: 0, w: true },
  against: { air: ['KeyA'], rate: -90, w: true },
  wOnlyMouse: { air: ['KeyW'], rate: 90, w: true },
  slowMouse: { air: ['KeyA'], rate: 25, w: true },
  fastMouse: { air: ['KeyA'], rate: 420, w: true },
  noRunup: { air: ['KeyA'], rate: 90, w: false },
  lateKey: { air: ['KeyA'], rate: 90, w: true, delay: 0.35 },
  mashSpace: { air: ['KeyA'], rate: 90, w: true, mash: true },
};
const only = process.argv.slice(2);

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const out = {};
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
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /^Training\s*\d/ }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.vel-menu:not([hidden]) button', { hasText: 'T3' }).first().click();
  await page.waitForTimeout(400);
  if ((await page.evaluate(() => window.__vel.state().menu)) !== null) await page.getByRole('button', { name: /Klicken zum Starten/i }).first().click();
  await page.waitForFunction(() => window.__vel.state().lesson === 't3' && window.__vel.state().locked, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const held = new Set();
  const setKeys = async (want) => {
    for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
  };
  let mouseX = 960;
  for (const [name, c] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    await page.evaluate(() => window.__vel.trainingReset());
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__misT = window.__vel.events().at(-1)?.t ?? 0; });
    const rec = { verdicts: {}, verdictTexts: [], tips: [], notices: [], firstFeedback: null, count: null };
    const t0 = Date.now();
    let last = t0, airT = 0, tipSerial = -1, lastVerdict = null, lastNotice = null, shot = 0, mashT = 0;
    while ((Date.now() - t0) / 1000 < SECONDS) {
      const st = await page.evaluate(() => {
        const v = window.__vel; const s = v.state(); const tr = v.training(); const hl = v.hudLayout();
        const ev = v.events().filter((e) => e.t > window.__misT);
        if (ev.length) window.__misT = ev.at(-1).t;
        return { onGround: s.onGround, speed: s.speed, notice: s.notice, verdict: hl.verdict, tip: tr.tip, tipSerial: tr.tipSerial, tipKind: tr.tipKind, count: tr.count, idx: tr.stageIndex,
          ev: ev.filter((e) => e.type === 'lessonHop' || e.type === 'jump').map((e) => ({ type: e.type, verdict: e.verdict, gain: e.gain })) };
      });
      const now = Date.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const rt = +((now - t0) / 1000).toFixed(1);
      for (const e of st.ev) {
        if (e.type === 'jump') airT = 0;
        if (e.type === 'lessonHop') rec.verdicts[e.verdict] = (rec.verdicts[e.verdict] ?? 0) + 1;
      }
      if (st.verdict && st.verdict !== lastVerdict) { rec.verdictTexts.push({ t: rt, text: st.verdict }); rec.firstFeedback ??= rt; if (shot < 1) { await page.screenshot({ path: `tools/critique/v2final/shots/mis-${name}.png` }); shot++; } }
      lastVerdict = st.verdict;
      if (st.tipSerial !== tipSerial) { if (tipSerial >= 0 && st.tip) { rec.tips.push({ t: rt, kind: st.tipKind, text: st.tip }); if (st.tipKind !== 'stage') rec.firstFeedback ??= rt; } tipSerial = st.tipSerial; }
      if (st.notice && st.notice !== lastNotice) rec.notices.push({ t: rt, text: st.notice });
      lastNotice = st.notice;
      rec.count = st.count;
      if (st.idx > 0) { rec.stageDoneAt = rt; break; }
      if (!st.onGround) airT += dt;
      const keys = new Set();
      if (c.mash) { mashT += dt; if (mashT > 0.12) { mashT = 0; await page.keyboard.press('Space'); } } else keys.add('Space');
      let rate = 0;
      if (st.onGround || airT < (c.delay ?? 0.1)) { if (c.w) keys.add('KeyW'); }
      else { for (const k of c.air) keys.add(k); rate = c.rate; }
      await setKeys(keys);
      if (rate) { mouseX += -(rate * dt) / DEG_PER_PX; await page.mouse.move(mouseX, 540); }
      await page.waitForTimeout(8);
    }
    await setKeys(new Set());
    out[name] = rec;
    console.log(name, JSON.stringify({ verdicts: rec.verdicts, count: rec.count, done: rec.stageDoneAt ?? null, first: rec.firstFeedback, texts: [...new Set(rec.verdictTexts.map((v) => v.text))], tips: rec.tips.map((t) => `${t.t}s ${t.kind}: ${t.text.replace(/\n/g, ' / ')}`) }));
    await page.waitForTimeout(600);
  }
} finally {
  out.errors = errors;
  writeFileSync('tools/critique/v2final/logs/t3mistakes.json', JSON.stringify(out, null, 1));
  await browser.close();
  await srv.close();
  console.log('errors', errors.length);
}
