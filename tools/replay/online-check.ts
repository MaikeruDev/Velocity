/**
 * Online-/Replay-Check im echten Spiel (Plan 009), Port ONLINE_PORT (Default 5701):
 *
 *  1. Bot fährt L1 ins Ziel (eingefroren, stepTicks) → Lauf wird aufgenommen und beim Mock eingereicht,
 *     Status im Ergebnis (Screenshot finish.png).
 *  2. Chromium → Node: das im Browser aufgenommene Replay verifiziert in Node (gleiche Zeit/Endposition).
 *  3. Node → Chromium: Bot-Replays aus Node (L1–L4) verifiziert im Browser (__vel.verifyReplay).
 *  4. Bestenliste aus dem Ergebnis öffnen: eigener Eintrag + Rivalen (leaderboard.png).
 *  5. Ghost eines Mock-Eintrags laden und mitfahren (race.png), HUD-Abstand am Checkpoint.
 *  6. Offline-Fallback (?online=off): Ziel ohne Einreichung, Bestenliste sagt "Offline" (offline.png).
 *
 *   npx tsx tools/replay/online-check.ts         → shots/online/ + report.json, Exit 1 bei Fehler
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { base64ToBytes, bytesToBase64, packReplay, unpackReplay } from '../../src/engine/replay/codec';
import { recordBotRun } from '../../src/engine/replay/botRun';
import { verifyReplay } from '../../src/engine/replay/verify';
import { loadLevelById } from './levels';

const PORT = Number(process.env.ONLINE_PORT ?? 5701);
const OUT = 'shots/online';
mkdirSync(OUT, { recursive: true });

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};

/** Bot bis ins Ziel (eingefroren, deterministisch schnell), danach Echtzeit bis zum Ergebnis-Menü. */
async function botToFinish(page: Page, seed: number, noise: number): Promise<{ time: number | null }> {
  await page.evaluate(({ seed, noise }) => {
    const v = window.__vel;
    if (!v) throw new Error('kein __vel');
    v.useBot('route', { aimNoiseDeg: noise, seed, restart: true });
    v.freeze(true);
  }, { seed, noise });
  for (let k = 0; k < 200; k++) {
    const st = await page.evaluate(() => window.__vel?.stepTicks(256) ?? null);
    if (!st || st.gameState === 'finished') break;
  }
  await page.evaluate(() => window.__vel?.freeze(false));
  await page.waitForFunction(() => window.__vel?.state().menu === 'finish', null, { timeout: 15000 });
  const st = await page.evaluate(() => window.__vel?.state() ?? null);
  return { time: st?.finish?.time ?? null };
}

// Wie tools/lib/devServer.mjs (dort ohne Typen): Vite im selben Prozess, Chromium mit ANGLE.
// Klassischer Titel (Default ist 'ps2', Plan 010) — die Prüfungen suchen dessen Elemente.
process.env.VITE_TEST_MENU_STYLE ??= 'classic';
const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const srv = { url: `http://localhost:${PORT}/`, close: () => vite.close() };
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${srv.url}?online=mock`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(() => window.__vel?.setSettings({ playerName: 'Prüfstand' }));
  await page.evaluate(() => window.__vel?.start('level1', { lockless: true }));

  // ---- 1) Lauf → Einreichen
  const run = await botToFinish(page, 3, 1);
  check('L1 im Ziel (Bot im Browser)', run.time !== null, `Zeit ${run.time}`);
  await page.waitForFunction(() => window.__vel?.online().status?.state !== 'pending', null, { timeout: 20000 });
  const on = await page.evaluate(() => window.__vel?.online() ?? null);
  check(
    'Eingereicht und vom Mock verifiziert',
    on?.status?.state === 'accepted' && typeof on.status.rank === 'number',
    `${on?.status?.state}: ${on?.status?.text} (Spieler ${on?.name}, ${on?.replayTicks} Ticks, Replay ${on?.replay ? Math.round((on.replay.length * 3) / 4) : 0} B)`,
  );
  const statusText = await page.textContent('.vel-online-status');
  check('Status im Ergebnis-Screen', (statusText ?? '').includes('Rang'), `"${statusText?.trim()}"`);
  await page.screenshot({ path: `${OUT}/finish.png` });

  // ---- 2) Chromium → Node
  if (on?.replay) {
    writeFileSync(`${OUT}/run-level1.b64`, on.replay);
    const rep = await unpackReplay(base64ToBytes(on.replay));
    const res = verifyReplay(rep, loadLevelById('level1'));
    check(
      'Chromium-Replay in Node gültig, gleiche Zeit',
      res.valid && res.time === run.time,
      `Node: ${res.valid ? 'gültig' : `${res.reason} ${res.detail}`} · Zeit Node ${res.time} / Browser ${run.time} · Ende ${res.endPos?.join(', ')}`,
    );
    const inBrowser = await page.evaluate((b64) => window.__vel?.verifyReplay(b64) ?? null, on.replay);
    check(
      'Dasselbe Replay im Browser nachgespielt = Node',
      inBrowser !== null && inBrowser.valid && inBrowser.time === res.time && JSON.stringify(inBrowser.endPos) === JSON.stringify(res.endPos),
      `Browser ${inBrowser?.time} @ ${inBrowser?.endPos?.join(', ')}`,
    );
  } else check('Chromium-Replay vorhanden', false, 'kein Replay im Debug-Handle');

  // ---- 3) Node → Chromium (L1–L4)
  for (const id of ['level1', 'level2', 'level3', 'level4']) {
    const level = loadLevelById(id);
    const rep = recordBotRun(level, { follower: { aimNoiseDeg: 1.5, seed: 9 } });
    if (!rep) {
      check(`Node-Bot ${id}`, false, 'nicht im Ziel');
      continue;
    }
    const node = verifyReplay(rep, level);
    const b64 = bytesToBase64(await packReplay(rep));
    const br = await page.evaluate((b) => window.__vel?.verifyReplay(b) ?? null, b64);
    check(
      `Node-Replay ${id} im Chromium bitgleich`,
      node.valid && br !== null && br.valid && br.time === node.time && JSON.stringify(br.endPos) === JSON.stringify(node.endPos) && JSON.stringify(br.splits) === JSON.stringify(node.splits),
      `Node ${node.time} @ ${node.endPos?.join(', ')} · Chromium ${br?.valid ? `${br.time} @ ${br.endPos?.join(', ')}` : `${br?.reason}: ${br?.detail}`}`,
    );
  }

  // ---- 4) Bestenliste aus dem Ergebnis
  await page.click('.vel-board-btn');
  await page.waitForSelector('.vel-board-top .vel-board tbody tr', { timeout: 60000 });
  await page.waitForSelector('.vel-board-around .vel-board tbody tr', { timeout: 20000 });
  const rows = await page.$$eval('.vel-board-top .vel-board tbody tr', (trs) => trs.map((tr) => ({ me: tr.classList.contains('is-me'), text: (tr.textContent ?? '').replace(/\s+/g, ' ').trim() })));
  const mine = await page.$$eval('.vel-board-around .vel-board tbody tr.is-me', (trs) => trs.map((tr) => (tr.textContent ?? '').replace(/\s+/g, ' ').trim()));
  check('Bestenliste: Rivalen + eigener Eintrag', rows.length >= 4 && mine.length === 1, `${rows.length} Top-Zeilen, ich: ${mine[0] ?? '—'}`);
  await page.screenshot({ path: `${OUT}/leaderboard.png` });

  // ---- 5) Ghost eines Mock-Eintrags (nicht meiner) laden und mitfahren
  const ghostBtn = await page.$('.vel-board-top tr:not(.is-me) .vel-board-ghost');
  if (!ghostBtn) check('Ghost-Knopf eines Rivalen', false, 'keiner gefunden');
  else {
    const label = await ghostBtn.evaluate((b) => b.closest('tr')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    await ghostBtn.click();
    await page.waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 15000 });
    await page.waitForFunction(() => window.__vel?.online().race?.loaded === true, null, { timeout: 15000 });
    const race = await page.evaluate(() => ({ online: window.__vel?.online().race ?? null, ghost: window.__vel?.ghost() ?? null }));
    check('Fremd-Ghost geladen', race.ghost?.loaded === true && (race.ghost.time ?? 0) > 0, `${race.online?.label} · Ghost-Zeit ${race.ghost?.time} (Zeile: ${label})`);
    await page.evaluate(() => window.__vel?.useBot('route', { aimNoiseDeg: 2, seed: 4, restart: true }));
    let shot = false;
    let cpDiff: number | null = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      await page.waitForTimeout(120);
      const snap = await page.evaluate(() => {
        const v = window.__vel;
        if (!v) return null;
        v.freeze(true);
        const s = v.state();
        const g = s.runTime !== null ? v.ghost(s.runTime) : v.ghost();
        v.freeze(false);
        return { s, g };
      });
      if (!snap) break;
      if (snap.g.diff !== null && cpDiff === null) cpDiff = snap.g.diff;
      const p = snap.g.pose;
      if (!shot && p && snap.s.running && snap.s.runTime !== null && snap.s.runTime > 1.5) {
        const yaw = (snap.s.yawDeg * Math.PI) / 180;
        const dx = p.x - snap.s.pos.x;
        const dz = p.z - snap.s.pos.z;
        const dist = Math.hypot(dx, dz);
        const ahead = (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / Math.max(1, dist);
        if (dist > 120 && dist < 900 && ahead > 0.85) {
          await page.screenshot({ path: `${OUT}/race.png` });
          shot = true;
        }
      }
      if (snap.s.finish || (shot && cpDiff !== null)) break;
    }
    check('Mitfahren: Ghost im Bild (Screenshot)', shot, shot ? `${OUT}/race.png` : 'Ghost nie vorn im Bild');
    check('Mitfahren: HUD-Abstand am Checkpoint', cpDiff !== null, `Abstand ${cpDiff?.toFixed(2)} s`);
    if (!shot) await page.screenshot({ path: `${OUT}/race.png` });
  }

  // ---- 6) Offline-Fallback (eigene Seite; die Mock-Seite schließen, sonst konkurriert sie um Frames)
  await page.close();
  const off = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  off.on('pageerror', (e) => errors.push(`offline pageerror: ${e.message}`));
  off.on('console', (m) => {
    if (m.type() === 'error') errors.push(`offline console: ${m.text()}`);
  });
  await off.goto(`${srv.url}?online=off`);
  await off.waitForFunction(() => window.__vel?.ready === true);
  await off.evaluate(() => window.__vel?.start('level2', { lockless: true }));
  await botToFinish(off, 2, 1);
  const offStatus = await off.evaluate(() => window.__vel?.online() ?? null);
  check('Offline: Ziel ohne Einreichung', offStatus?.backend === 'off' && offStatus.status?.state === 'offline', `${offStatus?.status?.text}`);
  const hasBoardBtn = (await off.$('.vel-finish-screen .vel-board-btn')) !== null;
  await off.screenshot({ path: `${OUT}/offline-finish.png` });
  await off.evaluate(() => window.__vel?.showLeaderboard('level2'));
  await off.waitForTimeout(400);
  const offText = await off.textContent('.vel-board-top');
  check('Offline: Bestenliste sagt "Offline"', (offText ?? '').includes('Offline') && hasBoardBtn === true, `"${offText?.trim()}"`);
  await off.screenshot({ path: `${OUT}/offline.png` });
} finally {
  await browser.close();
  await srv.close();
}
check('0 Konsolenfehler', errors.length === 0, errors.slice(0, 5).join(' | ') || '0');
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, errors }, null, 2));
process.exit(checks.some((c) => !c.ok) ? 1 : 0);
