/**
 * 3D-View-Hand (Plan 006) im echten Spiel → shots/viewmodel/. Port VM_PORT (Default 5282).
 *
 *   scenes-1920x1080.png   Kontaktblatt: Idle/Lauf/Ducken/Sprung/Landung/Bhop/Daumen/Surf/Schnell (Ausschnitt um die Hand)
 *   uw-<szene>.png         3840×1080 (32:9) Vollbild: Hand im 16:9-Safe-Frame
 *   hud-<w>x<h>.png        Vollbild 1920×1080 / 2560×1080 / 3840×1080 mit Dose
 *   props-<item>.png       Kontaktblatt: Tricks je Gegenstand in mehreren Phasen (festgehalten)
 *   live-<item>.png        Kontaktblatt: echte Bot-Läufe, Tricks nach Tempo
 *   compare.png            Referenzbilder (hand screens/) NEBEN eigenen Ausschnitten
 *   menu-*.png, finish-unlock.png
 * Exit 1 bei Konsolenfehlern oder wenn die Hand in einer Spielszene fehlt.
 *
 *   node tools/viewmodel-shots.mjs [filter]      filter: scenes|uw|hud|props|live|compare|menu|finish
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.VM_PORT ?? 5282);
const OUT = 'shots/viewmodel';
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';
const want = (name) => !filter || name.includes(filter) || filter.includes(name);
mkdirSync(OUT, { recursive: true });

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const missing = [];
const sceneTiles = [];
try {
  if (want('scenes')) await scenes(1920, 1080, true);
  if (want('uw')) await scenes(3840, 1080, false);
  if (want('hud')) for (const [w, h] of [[1920, 1080], [2560, 1080], [3840, 1080]]) await hudShot(w, h);
  if (want('props')) for (const item of ['can', 'card', 'knife']) await propSheet(item);
  if (want('live')) for (const item of ['can', 'card', 'knife']) await liveSheet(item);
  if (want('compare')) await compare();
  if (want('menu')) await menuShots();
  if (want('finish')) await finishShot();
} finally {
  await browser.close();
  await srv.close();
}
if (missing.length) console.error(`Hand fehlt in: ${missing.join(', ')}`);
if (errors.length) console.error(`${errors.length} Konsolenfehler:\n${errors.join('\n')}`);
if (errors.length || missing.length) process.exit(1);
console.log('ok');

function unlockedAll() {
  return { 'velocity.unlocks.v1': { v: 2, unlocked: { 'glove.neon': 'x', 'item.card': 'x', 'item.can': 'x', 'item.knife': 'x' } } };
}
function withItem(item, glove = 'classic') {
  return { ...unlockedAll(), 'velocity.settings.v1': { heldItem: item, glove, fullscreenOnStart: false } };
}

async function newPage(viewport, storage = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((s) => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
  }, storage);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Ausschnitt um die Hand (CSS-px): aus dem Handgelenk-Anker des Frames, Platz nach oben/links für Tricks. */
async function handClip(page, vw, vh, tight = false) {
  const hand = await page.evaluate(() => window.__vel.hand());
  const cx = vw / 2 + hand.frame.x * vh;
  const cy = vh / 2 + hand.frame.y * vh;
  // tight: nur Hand + Gegenstand (wie die Referenz-Ausschnitte), sonst Platz für Würfe.
  const x = Math.max(0, Math.round(cx - (tight ? 0.4 : 0.62) * vh));
  const y = Math.max(0, Math.round(cy - (tight ? 0.36 : 0.72) * vh));
  const w = Math.round((tight ? 0.55 : 0.95) * vh);
  return { clip: { x, y, width: Math.min(vw - x, w), height: Math.min(vh - y, tight ? Math.round(0.5 * vh) : vh) }, hand };
}

async function tile(page, vw, vh, label, sub, expectVisible = true, tight = false) {
  const { clip, hand } = await handClip(page, vw, vh, tight);
  if (expectVisible && !hand.visible) missing.push(label);
  const buf = await page.screenshot({ clip });
  return { label, sub: sub ?? `${hand.pose} · ${hand.trick}`, png: buf.toString('base64') };
}

async function scenes(vw, vh, sheet) {
  const tag = `${vw}x${vh}`;
  const page = await newPage({ width: vw, height: vh }, { 'velocity.settings.v1': { fullscreenOnStart: false } });
  const tiles = [];
  const snap = async (name) => {
    if (sheet) tiles.push(await tile(page, vw, vh, name));
    else if (['idle', 'run', 'surf'].includes(name)) {
      await page.screenshot({ path: `${OUT}/uw-${name}.png` });
      const h = await page.evaluate(() => window.__vel.hand());
      if (!h.visible) missing.push(`uw-${name}`);
      console.log(`uw ${name}: Anker x ${(h.frame.x).toFixed(3)} Bildhöhen rechts der Mitte`);
    }
  };
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(2600);
  await snap('idle');
  await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1 })));
  await page.waitForTimeout(700);
  await snap('run');
  await page.evaluate(() => {
    window.__vel.restart();
    window.__vel.setInputOverride(() => ({ crouch: true }));
  });
  await page.waitForTimeout(800);
  await snap('duck');
  await page.evaluate(() => {
    window.__vel.restart();
    window.__vel.setInputOverride(() => ({}));
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    let jumped = false;
    window.__vel.setInputOverride((s) => {
      if (!s.onGround) jumped = true;
      return jumped ? { forward: 1 } : { forward: 1, jumpHeld: true, jumpPressed: true };
    });
  });
  await page.waitForFunction(() => {
    const s = window.__vel.state();
    return !s.onGround && s.vel.y < 25;
  });
  await snap('jump');
  await page.evaluate(() => {
    const v = window.__vel;
    v.restart();
    v.setInputOverride(() => ({}));
    const p = v.state().pos;
    v.teleport(p.x, p.y + 300, p.z);
  });
  await page.waitForFunction(() => window.__vel.state().onGround, null, { timeout: 5000 });
  await page.waitForTimeout(40);
  await snap('land');
  await page.evaluate(() => window.__vel.forceHandPose('thumbsUp'));
  await page.waitForTimeout(500);
  await snap('thumbs');
  await page.evaluate(() => window.__vel.forceHandPose(null));
  await page.evaluate(() => {
    window.__vel.setInputOverride(null);
    window.__vel.restart();
    window.__vel.useBot('route', { sync: 1, seed: 11 });
  });
  await page.waitForFunction(() => {
    const s = window.__vel.state();
    return s.hopChain >= 9 && s.speed > 560 && !s.onGround;
  }, null, { timeout: 40000 });
  await snap('bhop');
  await page.context().close();

  const p2 = await newPage({ width: vw, height: vh }, { 'velocity.settings.v1': { fullscreenOnStart: false } });
  await p2.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await p2.waitForTimeout(600);
  await p2.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  await p2.waitForFunction(() => {
    const s = window.__vel.state();
    return s.surfing && s.speed > 800;
  }, null, { timeout: 60000 });
  await p2.waitForTimeout(150);
  if (sheet) tiles.push(await tile(p2, vw, vh, 'surf'));
  else await snapUw(p2, 'surf');
  await p2.waitForFunction(() => window.__vel.state().speed > 1000, null, { timeout: 30000 }).catch(() => undefined);
  if (sheet) tiles.push(await tile(p2, vw, vh, 'fast'));
  await p2.context().close();
  if (sheet) {
    sceneTiles.push(...tiles);
    await compose(tiles, `${OUT}/scenes-${tag}.png`, `View-Hand im Spiel ${tag}`, 300);
  }
}

async function snapUw(page, name) {
  await page.screenshot({ path: `${OUT}/uw-${name}.png` });
  const h = await page.evaluate(() => window.__vel.hand());
  if (!h.visible) missing.push(`uw-${name}`);
}

async function hudShot(w, h) {
  const page = await newPage({ width: w, height: h }, withItem('can'));
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(2600);
  await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1 })));
  await page.waitForTimeout(350);
  const info = await page.evaluate(() => ({ hand: window.__vel.hand(), layout: window.__vel.hudLayout() }));
  await page.screenshot({ path: `${OUT}/hud-${w}x${h}.png` });
  const px = (info.hand.frame.x * h).toFixed(0);
  console.log(`hud ${w}x${h}: Handgelenk ${px} px rechts der Bildmitte (Bildhöhen ${info.hand.frame.x.toFixed(3)})`);
  if (!info.hand.visible) missing.push(`hud-${w}`);
  await page.context().close();
}

// Funktion statt const: die Top-Level-Awaits oben laufen, bevor ein const hier initialisiert wäre.
function phasesOf(item) {
  return {
  can: [
    ['none', [0]],
    ['crack', [0.15, 0.35, 0.5, 0.8]],
    ['sip', [0.3, 0.7, 1.0]],
    ['flip', [0.05, 0.2, 0.33, 0.5]],
    ['twirl', [0.25, 0.4]],
    ['doubleFlip', [0.3, 0.55]],
    ['behindThrow', [0.35, 0.6, 0.85]],
  ],
  card: [
    ['none', [0]],
    ['spin', [0.15, 0.3, 0.45, 0.6, 0.75]],
    ['turn', [0.35]],
    ['tossSpin', [0.3, 0.5]],
    ['vanish', [0.1, 0.25, 0.35, 0.8, 1.35, 1.52, 1.62]],
  ],
  knife: [
    ['none', [0]],
    ['open', [0.15, 0.3, 0.45]],
    ['close', [0.2]],
    ['rollover', [0.25, 0.5]],
    ['aerial', [0.25, 0.45, 0.65]],
    ['doubleAerial', [0.45]],
  ],
  }[item];
}

async function propSheet(item) {
  const vw = 1920;
  const vh = 1080;
  const page = await newPage({ width: vw, height: vh }, withItem(item));
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(2600);
  const tiles = [];
  for (const [name, times] of phasesOf(item)) {
    for (const t of times) {
      if (item === 'can' && name === 'sip') {
        // Schluck nur offen: erst crack durchlaufen lassen.
        await page.evaluate(() => window.__vel.forceTrick('crack', 1.0));
        await page.waitForTimeout(100);
        await page.evaluate(() => window.__vel.forceTrick('none'));
      }
      const ok = await page.evaluate(([n, at]) => window.__vel.forceTrick(n, at), [name, t]);
      if (!ok) errors.push(`forceTrick ${item}/${name} unbekannt`);
      await page.waitForTimeout(450);
      tiles.push(await tile(page, vw, vh, `${name} ${t.toFixed(2)} s`));
    }
  }
  await page.evaluate(() => window.__vel.forceTrick('none'));
  await page.context().close();
  await compose(tiles, `${OUT}/props-${item}.png`, `${item} — Trick-Phasen (festgehalten, 1920×1080)`, 260);
}

async function liveSheet(item) {
  const vw = 1600;
  const vh = 900;
  const tiles = [];
  for (const [level, glove] of [['level1', 'classic'], ['level2', 'neon']]) {
    const page = await newPage({ width: vw, height: vh }, withItem(item, glove));
    await page.evaluate((l) => window.__vel.start(l, { lockless: true }), level);
    await page.waitForTimeout(2400);
    const idleStart = Date.now();
    while (Date.now() - idleStart < 7000) {
      const h = await page.evaluate(() => window.__vel.hand());
      if (h.trick !== 'none') break;
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(150);
    tiles.push(await tile(page, vw, vh, `${level} Stand`, undefined));
    await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 3 }));
    const bucket = [0, 0, 0, 0];
    let got = 0;
    const t0 = Date.now();
    while (got < 9 && Date.now() - t0 < 70000) {
      const s = await page.evaluate(() => ({ hand: window.__vel.hand(), st: window.__vel.state() }));
      // Im Ziel/Ergebnis ist die Hand absichtlich aus — dort nicht knipsen.
      if (s.st.menu === 'finish' || s.st.gameState === 'finished') break;
      const b = s.st.speed >= 800 || s.st.surfing ? 3 : s.st.speed >= 500 ? 2 : 1;
      if (s.hand.trick !== 'none' && s.hand.trickTime > 0.15 && bucket[b] < 3) {
        bucket[b]++;
        tiles.push(await tile(page, vw, vh, `${level} ${s.hand.trick}`, `${Math.round(s.st.speed)} u/s${s.st.surfing ? ' SURF' : ''}`));
        got++;
        await page.waitForTimeout(500);
      } else await page.waitForTimeout(40);
      if (s.st.menu === 'finish') break;
    }
    await page.context().close();
  }
  await compose(tiles, `${OUT}/live-${item}.png`, `${item} — echte Läufe (Route-Bot, L1 Standard / L2 Neon)`, 240);
}

/** Referenzen links, eigene Ausschnitte rechts — ehrlicher Vergleich von Silhouette, Kontur, Stulpe. */
async function compare() {
  const refs = readdirSync('hand screens')
    .filter((f) => f.endsWith('.png'))
    .map((f) => ({ label: f.replace('Screenshot ', ''), sub: 'Referenz', png: readFileSync(`hand screens/${f}`).toString('base64') }));
  const vw = 1920;
  const vh = 1080;
  const own = [];
  for (const [item, trick, at, label] of [
    ['can', 'none', 0, 'Dose im Griff'],
    ['can', 'sip', 0.8, 'Dose Schluck'],
    ['can', 'flip', 0.3, 'Dose Flip'],
    ['none', null, 0, 'leer'],
  ]) {
    const page = await newPage({ width: vw, height: vh }, withItem(item));
    await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await page.waitForTimeout(2600);
    if (trick) {
      if (trick === 'sip') {
        await page.evaluate(() => window.__vel.forceTrick('crack', 1.0));
        await page.waitForTimeout(100);
      }
      await page.evaluate(([n, a]) => window.__vel.forceTrick(n, a), [trick, at]);
      await page.waitForTimeout(450);
    }
    own.push(await tile(page, vw, vh, label, 'VELOCITY 270 Zeilen', true, true));
    await page.context().close();
  }
  await compose([...refs, ...own], `${OUT}/compare.png`, 'Referenz (hand screens/) vs. VELOCITY', 300);
}

async function menuShots() {
  let page = await newPage({ width: 1920, height: 1080 }, { 'velocity.settings.v1': { fullscreenOnStart: false } });
  await page.getByRole('button', { name: 'Kosmetik' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/menu-locked.png` });
  await page.evaluate(() => window.__vel.unlockAll());
  for (const [glove, item, file, wait] of [
    ['Neon-Handschuh', /^Sammelkarte/, 'menu-card-neon', 3000],
    ['Standard', /^Dose/, 'menu-can', 2500],
    ['Standard', /^Butterfly-Messer/, 'menu-knife', 2500],
  ]) {
    await page.getByRole('button', { name: new RegExp(`^${glove}`) }).click();
    await page.getByRole('button', { name: item }).click();
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${OUT}/${file}.png` });
  }
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${OUT}/menu-knife-overdrive.png` });
  await page.context().close();
}

async function finishShot() {
  const page = await newPage({ width: 1920, height: 1080 }, { 'velocity.settings.v1': { fullscreenOnStart: false } });
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 1 }));
  await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ finish: window.__vel.state().finish, unlocks: window.__vel.unlocks() }));
  console.log(`finish: ${st.finish?.time} s, unlocked ${JSON.stringify(st.finish?.unlocked)}, store ${st.unlocks}`);
  await page.screenshot({ path: `${OUT}/finish-unlock.png` });
  await page.context().close();
}

async function compose(tiles, file, title, width) {
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const cells = tiles
    .map((t) => `<figure><img src="data:image/png;base64,${t.png}"><figcaption><b>${t.label}</b><br>${t.sub}</figcaption></figure>`)
    .join('');
  await page.setContent(
    `<html><body style="margin:0;background:#120a26;color:#f1edff;font:13px monospace"><h2 style="margin:8px 12px">${title}</h2><div style="display:flex;flex-wrap:wrap;gap:6px;padding:6px">${cells}</div>` +
      `<style>figure{margin:0;width:${width}px}img{width:${width}px;image-rendering:pixelated;display:block}figcaption{padding:2px 0}</style></body></html>`,
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
  console.log(`${file}: ${tiles.length} Kacheln`);
}
