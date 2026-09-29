/**
 * 3D-View-Hand (Plan 006) im echten Spiel → shots/viewmodel/. Port VM_PORT (Default 5282).
 *
 *   scenes-1920x1080.png   Kontaktblatt: Idle/Lauf/Ducken/Sprung/Landung/Bhop/Daumen/Surf/Schnell (Ausschnitt um die Hand)
 *   uw-<szene>.png         3840×1080 (32:9) Vollbild: Hand im 16:9-Safe-Frame
 *   hud-<w>x<h>.png        Vollbild 1920×1080 / 2560×1080 / 3840×1080 mit Dose
 *   props-<item>.png       Kontaktblatt: Tricks je Gegenstand in mehreren Phasen (festgehalten)
 *   live-<item>.png        Kontaktblatt: echte Bot-Läufe, Tricks nach Tempo, dazu zwei Kacheln Ziel-Reaktion ("ZIEL …")
 *   compare.png            Referenzbilder (hand screens/) NEBEN eigenen Ausschnitten
 *   menu-*.png, finish-unlock.png
 *   skins.png              Plan 007: alle 6 Hand-Skins × Posen/Griffe aller Gegenstände (dev/viewmodel.html, Spielgröße, Lupe)
 *   items.png              Plan 007: Trick-Phasen der neuen Gegenstände + Surf-Zustände aller (deterministisch, Spielgröße)
 *   budget.json            Plan 007: Draw Calls/Dreiecke je Skin × Gegenstand (Budget ≤ 50 / ≤ 12 000)
 *   snapshot.png           Plan 007 K7: __vel.snapshot() (Ziel-Foto ohne HUD) in Low-Res-Größe
 *   ingame-<skin>.png      Plan 007 KI3/KI4: neue Skins im echten Spiel (Szenen wie scenes, Katze = Nutzer-Abnahme)
 *   selfie-*.png           Plan 007 KI7: Selfie im laufenden Spiel (96×54, ×4), Welt-Durchgänge, Dauer, Frame danach
 * Exit 1 bei Konsolenfehlern, wenn die Hand in einer Spielszene fehlt oder ein Check scheitert.
 *
 *   node tools/viewmodel-shots.mjs [filter]      filter: scenes|uw|hud|props|live|compare|menu|finish|skins|items|budget|snapshot|ingame|selfie
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const failed = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed.push(label);
};
/** Gegenstände mit Tricks (Plan 006 + Plan 007). */
const TRICK_ITEMS = ['can', 'card', 'knife', 'spinner', 'yoyo', 'lighter', 'coin', 'kendama', 'phone'];
/** Surf-Zustände (Plan 007 KI1–KI8): Kontaktblätter halten sie mit Surf-Eingabe fest. */
const SURF_STATES = ['balance', 'surfSleeper', 'surfFlame', 'edgeSpin', 'cupRide', 'gimbal', 'surfBalance', 'surfFan', 'surfHeli'];
const GLOVES = ['classic', 'neon', 'gold', 'robot', 'skeleton', 'cat'];
const ITEMS = ['none', 'can', 'card', 'knife', 'yoyo', 'spinner', 'coin', 'lighter', 'kendama', 'phone'];
try {
  if (want('scenes')) await scenes(1920, 1080, true);
  if (want('uw')) await scenes(3840, 1080, false);
  if (want('hud')) for (const [w, h] of [[1920, 1080], [2560, 1080], [3840, 1080]]) await hudShot(w, h);
  if (want('props')) for (const item of TRICK_ITEMS) await propSheet(item);
  if (want('live')) for (const item of TRICK_ITEMS) await liveSheet(item);
  if (want('compare')) await compare();
  if (want('menu')) await menuShots();
  if (want('finish')) await finishShot();
  if (want('skins')) await skinSheet();
  if (want('items')) await itemSheet();
  if (want('budget')) await budget();
  if (want('snapshot')) await snapshotShot();
  if (want('ingame')) for (const glove of ['cat', 'skeleton']) await scenes(1920, 1080, true, glove);
  if (want('selfie')) await selfieShots();
} finally {
  await browser.close();
  await srv.close();
}
if (missing.length) console.error(`Hand fehlt in: ${missing.join(', ')}`);
if (errors.length) console.error(`${errors.length} Konsolenfehler:\n${errors.join('\n')}`);
if (failed.length) console.error(`${failed.length} Checks gescheitert:\n${failed.join('\n')}`);
if (errors.length || missing.length || failed.length) process.exit(1);
console.log('ok');

function unlockedAll() {
  const ids = ['glove.neon', 'glove.gold', 'glove.robot', 'glove.skeleton', 'glove.cat', 'item.card', 'item.can', 'item.knife', 'item.yoyo', 'item.spinner', 'item.coin', 'item.lighter', 'item.kendama', 'item.phone'];
  return { 'velocity.unlocks.v1': { v: 3, unlocked: Object.fromEntries(ids.map((id) => [id, 'x'])), locked: [] } };
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

async function scenes(vw, vh, sheet, glove = null) {
  const tag = glove ? glove : `${vw}x${vh}`;
  const storage = glove ? { ...unlockedAll(), 'velocity.settings.v1': { glove, fullscreenOnStart: false } } : { 'velocity.settings.v1': { fullscreenOnStart: false } };
  const page = await newPage({ width: vw, height: vh }, storage);
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

  const p2 = await newPage({ width: vw, height: vh }, storage);
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
  if (sheet && glove) {
    // Mit Gegenständen: Griff und Leerlauf-Trick im echten Spiel.
    for (const item of ['can', 'spinner', 'yoyo', 'phone']) {
      const p3 = await newPage({ width: vw, height: vh }, withItem(item, glove));
      await p3.evaluate(() => window.__vel.start('level1', { lockless: true }));
      await p3.waitForTimeout(2600);
      tiles.push(await tile(p3, vw, vh, `${item}`));
      await p3.context().close();
    }
  }
  if (sheet) {
    sceneTiles.push(...tiles);
    await compose(tiles, `${OUT}/${glove ? 'ingame' : 'scenes'}-${tag}.png`, `View-Hand im Spiel ${tag}`, 300);
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
  spinner: [
    ['none', [0]],
    ['flick', [0.1, 0.25]],
    ['swap', [0.2, 0.5, 0.85]],
    ['toss', [0.2, 0.35, 0.55]],
    ['ufo', [0.3, 0.5, 0.8, 1.0]],
    ['balance', [0.3]],
  ],
  yoyo: [
    ['none', [0]],
    ['sleeper', [0.1, 0.2, 0.6, 1.1]],
    ['pass', [0.12, 0.2, 0.3]],
    ['breakaway', [0.2, 0.4, 0.55]],
    ['around', [0.1, 0.3, 0.45, 0.6]],
    ['cradle', [0.4, 0.8, 1.2]],
    ['surfSleeper', [0.6]],
  ],
  lighter: [
    ['none', [0]],
    ['flickOpen', [0.1, 0.2]],
    ['strike', [0.14, 0.2, 0.3]],
    ['twirl', [0.2, 0.35, 0.5]],
    ['tossOpen', [0.3, 0.45, 0.75]],
    ['lidFlick', [0.25]],
    ['finale', [0.5, 0.9]],
    ['surfFlame', [0.6]],
  ],
  coin: [
    ['none', [0]],
    ['knuckleRoll', [0.3, 0.55, 0.8, 1.05, 1.3, 1.9]],
    ['flip', [0.15, 0.3, 0.5]],
    ['highFlip', [0.4, 0.8, 0.95]],
    ['vanish', [0.3, 0.8, 1.25]],
    ['call', [0.6, 0.7]],
    ['edgeSpin', [0.4]],
  ],
  kendama: [
    ['none', [0]],
    ['bigCup', [0.1, 0.25, 0.4, 0.6]],
    ['smallCup', [0.3, 0.6]],
    ['spike', [0.3, 0.5, 0.65]],
    ['aroundJapan', [0.6, 0.9, 1.3, 1.7]],
    ['cupRide', [0.8]],
  ],
  phone: [
    ['none', [0]],
    ['scroll', [0.3, 0.7]],
    ['tap', [0.2, 0.4]],
    ['flipCatch', [0.2, 0.4, 0.6]],
    ['spinToss', [0.3, 0.5, 0.7]],
    ['buzz', [0.1]],
    ['photo', [0.5, 0.8, 1.2]],
    ['gimbal', [0.6]],
  ],
  }[item];
}

/** Plan 007 KI8: Surf-Zustände der alten Gegenstände (nicht in phasesOf — deren Kacheln belegt vm-hash). */
function ki8Phases(item) {
  return { can: [['surfBalance', [0.15, 0.35, 0.8]]], card: [['surfFan', [0.2, 0.4, 0.8]]], knife: [['surfHeli', [0.2, 0.5, 0.8]]] }[item] ?? [];
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
    // Bis ins Ziel fahren (auch nach 9 Kacheln): die Ziel-Reaktion gehört ins Blatt (Review Phase 2).
    while (Date.now() - t0 < 90000) {
      const s = await page.evaluate(() => ({ hand: window.__vel.hand(), st: window.__vel.state() }));
      // Im Ergebnis ist die Hand aus; im Ausrollen davor (bis 1.1 s nach dem Ziel) nicht.
      if (s.st.menu === 'finish') break;
      if (s.st.gameState === 'finished') {
        await page.waitForTimeout(200);
        for (const wait of [0, 350]) {
          await page.waitForTimeout(wait);
          const z = await page.evaluate(() => ({ hand: window.__vel.hand(), st: window.__vel.state() }));
          if (z.st.menu === 'finish') break;
          tiles.push(await tile(page, vw, vh, `${level} ZIEL ${z.hand.trick}`, `t ${z.hand.trickTime.toFixed(2)} s`));
        }
        break;
      }
      const b = s.st.speed >= 800 || s.st.surfing ? 3 : s.st.speed >= 500 ? 2 : 1;
      if (got < 9 && s.hand.trick !== 'none' && s.hand.trickTime > 0.15 && bucket[b] < 3) {
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
  await tileCheck(page, 'gesperrt', 14, 0);
  await smallWindows(page, 'gesperrt', 14, 0);
  await page.evaluate(() => window.__vel.unlockAll());
  await page.waitForTimeout(300);
  // Plan 007 Phase 2: alle Gegenstände/Skins gebaut — keine "in Arbeit"-Kachel mehr.
  await tileCheck(page, 'alles frei', 0, 0);
  await smallWindows(page, 'alles frei', 0, 0);
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
  for (const [glove, item, file] of [
    ['Gold-Handschuh', /^Fidget-Spinner/, 'menu-gold-spinner'],
    ['Roboter-Hand', /^Dose/, 'menu-robot-can'],
    // Plan 007 Phase 2: neue Skins und Gegenstände in der Menü-Vorschau.
    ['Katzenpfote', /^Jo-Jo/, 'menu-cat-yoyo'],
    ['Skelett-Hand', /^Kendama/, 'menu-skeleton-kendama'],
    ['Standard', /^Handy/, 'menu-phone'],
    ['Standard', /^Sturmfeuerzeug/, 'menu-lighter'],
    ['Standard', /^Münze/, 'menu-coin'],
  ]) {
    await page.getByRole('button', { name: new RegExp(`^${glove}`) }).click();
    await page.getByRole('button', { name: item }).click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/${file}.png` });
  }
  // Vorschau-Phasen Surf (ab 24 s) und Checkpoint (ab 30 s) mit dem Spinner.
  await page.getByRole('button', { name: /^Fidget-Spinner/ }).click();
  await page.waitForFunction(() => /Surf/.test(document.querySelector('.vel-preview-tier')?.textContent ?? ''), null, { timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/menu-spinner-surf.png` });
  await page.waitForFunction(() => /Checkpoint/.test(document.querySelector('.vel-preview-tier')?.textContent ?? ''), null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/menu-spinner-checkpoint.png` });
  await page.context().close();
}

/** Kleinere Fenster (1366×768, 1280×720): dasselbe Raster ohne Scrollen, danach zurück auf 1080p. */
async function smallWindows(page, label, locked, pending) {
  for (const [w, h] of [
    [1366, 768],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await tileCheck(page, `${label} ${w}×${h}`, locked, pending);
    await page.screenshot({ path: `${OUT}/menu-${locked > 0 ? 'locked' : 'free'}-${w}x${h}.png` });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
}

/** Kosmetik-Raster (Plan 007 K6): 16 Kacheln, alle im Bild, kein Scrollen; Zahl gesperrter/"in Arbeit"-Kacheln. */
async function tileCheck(page, label, locked, pending) {
  const t = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.vel-cosm')];
    const screen = document.querySelector('.vel-cosmetics-screen');
    return {
      n: els.length,
      locked: els.filter((e) => e.classList.contains('is-locked')).length,
      pending: els.filter((e) => e.classList.contains('is-pending') && !e.classList.contains('is-locked')).length,
      inView: els.every((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      }),
      scroll: screen ? screen.scrollHeight > screen.clientHeight + 1 : true,
      progress: [...document.querySelectorAll('.vel-cosm .vel-cosm-progress')].map((e) => e.textContent),
    };
  });
  check(t.n === 16 && t.inView && !t.scroll, `Kosmetik ${label}: ${t.n} Kacheln, alle im Bild ${t.inView}, Scrollen ${t.scroll}`);
  check(t.locked === locked && t.pending === pending, `Kosmetik ${label}: gesperrt ${t.locked} (soll ${locked}), in Arbeit ${t.pending} (soll ${pending}), Fortschritt ${JSON.stringify(t.progress)}`);
}

async function finishShot() {
  const page = await newPage({ width: 1920, height: 1080 }, { 'velocity.settings.v1': { fullscreenOnStart: false } });
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 1 }));
  await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ finish: window.__vel.state().finish, photo: window.__vel.state().photo, unlocks: window.__vel.unlocks() }));
  console.log(`finish: ${st.finish?.time} s, unlocked ${JSON.stringify(st.finish?.unlocked)}, store ${st.unlocks}`);
  await page.screenshot({ path: `${OUT}/finish-unlock.png` });
  // Plan 007 I3: ohne Handy kein Foto (kein Polaroid im Ergebnis).
  const pol = await page.locator('.vel-polaroid').count();
  check(st.photo === null && pol === 0, `finish ohne Handy: kein Foto (photo ${JSON.stringify(st.photo)}, Polaroids ${pol})`);
  // Vergleichswert für das Polaroid: Überlauf des Ergebnisses ohne Foto je Fenstergröße (nur Info).
  const base = [];
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    base.push(`${w}×${h} ${await page.evaluate(() => {
      const scr = document.querySelector('.vel-menu:not([hidden]) .vel-screen');
      return scr ? scr.scrollHeight - scr.clientHeight : -1;
    })} px`);
  }
  console.log(`finish ohne Handy, Überlauf: ${base.join(', ')}`);
  await page.context().close();
  await finishPhoneShot();
}

/**
 * Plan 007 I3: Ziel mit Handy → Selfie (96×54) im Ergebnis als Polaroid mit Zeit und Medaille, dazu der
 * HUD-Stempel "FOTO" im Ziel-Ausrollen. finish-phone-hud.png (Stempel), finish-phone.png (Ergebnis).
 */
async function finishPhoneShot() {
  const page = await newPage({ width: 1920, height: 1080 }, withItem('phone'));
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 1 }));
  await page.waitForFunction(() => window.__vel.state().gameState === 'finished', null, { timeout: 90000 });
  // Auslöser 0.76 s nach dem Ziel, Ergebnis nach 1.1 s: dazwischen steht der Stempel.
  await page.waitForFunction(() => window.__vel.state().photo !== null || window.__vel.state().menu === 'finish', null, { timeout: 5000 });
  // Der Stempel erscheint im Frame NACH dem Auslöser (Selfie läuft nach dem Bild des Frames).
  await page.waitForFunction(() => window.__vel.hudLayout().rects.photo[2] > 0 || window.__vel.state().menu === 'finish', null, { timeout: 2000 }).catch(() => undefined);
  const hud = await page.evaluate(() => ({ menu: window.__vel.state().menu, photoRect: window.__vel.hudLayout().rects.photo, trick: window.__vel.hand().trick }));
  await page.screenshot({ path: `${OUT}/finish-phone-hud.png` });
  check(hud.menu !== 'finish' && hud.photoRect[2] > 0, `finish mit Handy: HUD-Stempel FOTO im Ausrollen (Rechteck ${JSON.stringify(hud.photoRect)}, Menü ${hud.menu}, Trick ${hud.trick})`);
  await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 10000 });
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => {
    const scr = document.querySelector('.vel-menu:not([hidden]) .vel-screen');
    const img = document.querySelector('.vel-polaroid-img');
    const r = img?.getBoundingClientRect();
    return {
      photo: window.__vel.state().photo,
      finish: window.__vel.state().finish,
      caption: document.querySelector('.vel-polaroid-cap')?.textContent ?? null,
      img: r ? { w: r.width, h: r.height, top: r.top, bottom: r.bottom } : null,
      scroll: scr ? scr.scrollHeight - scr.clientHeight : -1,
    };
  });
  await page.screenshot({ path: `${OUT}/finish-phone.png` });
  console.log(`finish-phone: ${st.finish?.time} s, Foto ${JSON.stringify(st.photo)}, Polaroid ${JSON.stringify(st.img)}, Beschriftung "${st.caption}", Überlauf ${st.scroll}`);
  check(st.photo !== null && st.photo.w === 96 && st.photo.h === 54 && st.photo.mean > 1, `finish mit Handy: Selfie 96×54, nicht leer (${JSON.stringify(st.photo)})`);
  check(st.img !== null && st.img.w === 288 && st.img.h === 162 && st.img.bottom <= 1080, `finish mit Handy: Polaroid ×3 im Bild (${JSON.stringify(st.img)})`);
  check(typeof st.caption === 'string' && st.caption.includes(':'), `finish mit Handy: Polaroid beschriftet mit Zeit + Medaille ("${st.caption}")`);
  check(st.scroll <= 1, `finish mit Handy: Ergebnis ohne Scrollen bei 1920×1080 (Überlauf ${st.scroll})`);
  // Zeit und Polaroid dürfen sich nicht überdecken — auch in kleinen Fenstern (Zeit dort 64 px).
  for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const o = await page.evaluate(() => {
      const t = document.querySelector('.vel-finish-time');
      const p = document.querySelector('.vel-polaroid');
      const scr = document.querySelector('.vel-menu:not([hidden]) .vel-screen');
      if (!t || !p) return null;
      // Breite des Textes selbst (nicht der Box): über einen Range messen.
      const range = document.createRange();
      range.selectNodeContents(t);
      const tr = range.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      return { timeRight: Math.round(tr.right), polLeft: Math.round(pr.left), scroll: scr ? scr.scrollHeight - scr.clientHeight : -1 };
    });
    if (w === 1280) await page.screenshot({ path: `${OUT}/finish-phone-1280x720.png` });
    console.log(`finish mit Handy ${w}×${h}: Überlauf ${o?.scroll} px`);
    check(o !== null && o.timeRight <= o.polLeft, `finish mit Handy ${w}×${h}: Zeit endet vor dem Polaroid (${JSON.stringify(o)})`);
  }
  await page.context().close();
}

/** Kontaktblatt über dev/viewmodel.html (deterministisch, eigener WebGL-Kontext). */
async function devSheet(spec, file) {
  const cw = spec.crop ? Math.round((spec.crop[2] - spec.crop[0]) * spec.w) : spec.w;
  const page = await browser.newPage({ viewport: { width: Math.min(3800, (spec.cols ?? 4) * (cw * spec.zoom + 6) + 12), height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${srv.url}dev/viewmodel.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vm !== undefined);
  if (file) {
    await page.evaluate((s) => window.__vm.render(s.cells, { w: s.w, h: s.h, zoom: s.zoom, depth: s.depth, crop: s.crop }), spec);
    await page.locator('#sheet').screenshot({ path: file });
    console.log(`${file}: ${spec.cells.length} Kacheln`);
  }
  return page;
}

// Funktionen statt const: die Top-Level-Awaits oben laufen vorher (fallen.md #85).
function gameSize() {
  return { w: 480, h: 270, zoom: 2, depth: 40, crop: [0.45, 0.12, 1, 1] };
}
function live(o) {
  return { aspect: 16 / 9, ...o };
}

/** Plan 007: alle Hand-Skins mit Posen und Griffen aller Gegenstände (Spielgröße, Ausschnitt um die Hand). */
async function skinSheet() {
  const cells = [];
  for (const glove of GLOVES) {
    for (const pose of ['relaxed', 'open', 'thumbsUp', 'fist']) cells.push({ label: `${glove} · ${pose}`, glove, pose, frame: { x: 0.589, y: 0.33 }, kick: 0.5 });
    for (const item of TRICK_ITEMS) cells.push({ label: `${glove} · ${item}`, glove, live: live({ item }), kick: 0.5 });
  }
  const page = await devSheet({ ...gameSize(), cols: 13, cells }, `${OUT}/skins.png`);
  await page.close();
}

/** Plan 007: Trick-Phasen der neuen Gegenstände, dazu Surf/Checkpoint-Zustände (deterministisch). */
async function itemSheet() {
  const cells = [];
  const hold = (item, trick, at) => (trick === 'none' ? { item } : { item, trick, at, surfing: SURF_STATES.includes(trick), surfSide: SURF_STATES.includes(trick) ? 0.5 : 0 });
  for (const item of TRICK_ITEMS) {
    const old = ['can', 'card', 'knife'].includes(item);
    for (const [trick, times] of old ? ki8Phases(item) : phasesOf(item)) {
      for (const at of times) cells.push({ label: `${item} · ${trick} ${at}`, live: live(hold(item, trick, at)) });
    }
    if (old) continue;
    cells.push({ label: `${item} · Surf 800 u/s`, live: live({ item, speed: 800, surfing: true, surfSide: 0.6, frames: 60 }) });
    cells.push({ label: `${item} · 1000 u/s`, live: live({ item, speed: 1000, frames: 240 }) });
    cells.push({ label: `${item} · Checkpoint vorn`, live: live({ item, events: [{ type: 'checkpoint', index: 1, total: 3, time: 5, split: -0.3 }], frames: 20 }) });
  }
  const page = await devSheet({ ...gameSize(), cols: 6, cells }, `${OUT}/items.png`);
  await page.close();
}

/** Plan 007: Draw Calls und Dreiecke je Skin × Gegenstand (Ruhe + teuerste Phasen). */
async function budget() {
  const page = await devSheet({ ...gameSize(), cells: [] }, null);
  const perfect = { type: 'jump', speed: 600, gain: 12, perfect: true, clean: true, chain: 4, sync: 0.9, crouched: false, coyote: false };
  const cells = [];
  for (const glove of GLOVES) {
    for (const item of ITEMS) {
      const tag = `${glove} × ${item}`;
      cells.push({ label: tag, glove, live: live({ item }) });
      // Teuerste Momente: Funkeln (Gold), Unschärfe-Ring (Spinner), Poof (Karte), Trick in der Luft.
      cells.push({ label: tag, glove, live: live({ item, speed: 1000, frames: 240, events: [perfect] }) });
      // Direkt nach dem perfekten Hop: Gold-Funkeln läuft (0.25 s) — nach 240 Frames wäre es vorbei.
      cells.push({ label: tag, glove, live: live({ item, speed: 600, frames: 6, events: [perfect] }) });
      if (item === 'card') cells.push({ label: tag, glove, live: live({ item, trick: 'vanish', at: 0.3 }) });
    }
  }
  const stats = await page.evaluate((s) => window.__vm.stats(s.cells, { w: s.w, h: s.h, zoom: 1, depth: s.depth }), { ...gameSize(), cells });
  await page.close();
  const worst = {};
  for (const s of stats) {
    const w = worst[s.label] ?? { calls: 0, triangles: 0 };
    worst[s.label] = { calls: Math.max(w.calls, s.calls), triangles: Math.max(w.triangles, s.triangles) };
  }
  const rows = Object.entries(worst);
  const maxCalls = Math.max(...rows.map(([, v]) => v.calls));
  const maxTris = Math.max(...rows.map(([, v]) => v.triangles));
  const top = rows.sort((a, b) => b[1].calls - a[1].calls || b[1].triangles - a[1].triangles).slice(0, 5);
  writeFileSync(`${OUT}/budget.json`, JSON.stringify(worst, null, 1));
  console.log(`budget: teuerste ${top.map(([k, v]) => `${k} ${v.calls}/${v.triangles}`).join(', ')}`);
  check(maxCalls <= 50 && maxTris <= 12000, `Budget: max ${maxCalls} Draw Calls (≤ 50), max ${maxTris} Dreiecke (≤ 12 000) über ${rows.length} Kombinationen`);
}

/** Plan 007 K7: __vel.snapshot() liefert das Bild in Low-Res-Größe (ohne HUD), auch in 96×54. */
async function snapshotShot() {
  const page = await newPage({ width: 1920, height: 1080 }, withItem('spinner', 'gold'));
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(2600);
  const s = await page.evaluate(() => {
    const a = window.__vel.snapshot();
    const b = window.__vel.snapshot(96, 54);
    return { a, b: b ? { width: b.width, height: b.height, litShare: b.litShare } : null };
  });
  check(s.a !== null && s.a.width === s.a.lowResWidth && s.a.height === s.a.lowResHeight && s.a.litShare > 0.2, `snapshot: ${s.a?.width}×${s.a?.height} (Low-Res ${s.a?.lowResWidth}×${s.a?.lowResHeight}), hell ${s.a?.litShare}`);
  check(s.b !== null && s.b.width === 96 && s.b.height === 54 && s.b.litShare > 0.2, `snapshot 96×54: ${JSON.stringify(s.b)}`);
  if (s.a) writeFileSync(`${OUT}/snapshot.png`, Buffer.from(s.a.dataUrl.split(',')[1], 'base64'));
  const st = await page.evaluate(() => window.__vel.renderStats());
  console.log(`renderStats im Spiel (Gold + Spinner): ${st?.viewModelCalls} Draw Calls, ${st?.viewModelTriangles} Dreiecke`);
  // 0 Draw Calls = Hand fehlt (z. B. Level startet nicht) — das Foto allein fiele darauf nicht herein.
  check((st?.viewModelCalls ?? 0) > 0 && (st?.viewModelCalls ?? 0) <= 50, `snapshot: Hand im Spiel gezeichnet (${st?.viewModelCalls} Draw Calls, 1..50)`);
  await page.context().close();
}

/**
 * Plan 007 KI7: Selfie im laufenden Spiel über den echten Renderer (render/selfie.ts, dieselben Module
 * wie das Spiel — Vite liefert dieselbe Instanz). Gemessen: Welt-Durchgänge während des Selfies (gezählte
 * renderer.render mit der Welt-Szene), Dauer, der NÄCHSTE Frame (rAF-Abstand, < 25 ms), Canvas 96×54
 * nicht leer (Varianz > 0). Je Skin ein Bild (×4) zum Ansehen.
 */
async function selfieShots() {
  const results = [];
  for (const glove of ['classic', 'cat', 'robot']) {
    const page = await newPage({ width: 1920, height: 1080 }, withItem('phone', glove));
    await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await page.waitForTimeout(2600);
    await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1 })));
    await page.waitForTimeout(900);
    const r = await page.evaluate(async (g) => {
      const { debugRenderer } = await import('/src/render/PS2Renderer.ts');
      const { selfieStats } = await import('/src/render/selfie.ts');
      const { ViewHand } = await import('/src/ui/hand/ViewHand.ts');
      const rd = debugRenderer();
      if (!rd) return { error: 'kein Renderer' };
      const gl = rd.renderer;
      const world = rd.scene;
      const orig = gl.render.bind(gl);
      let worldPasses = 0;
      let allPasses = 0;
      const counting = (s, c) => {
        allPasses++;
        if (s === world) worldPasses++;
        orig(s, c);
      };
      const h = new ViewHand();
      h.setGlove(g);
      const vm = h.selfieFrame();
      // Im rAF auslösen (wie im Spiel am Frame-Ende), danach die nächsten Frame-Abstände messen.
      const frames = [];
      const out = await new Promise((resolve) => {
        requestAnimationFrame((t0) => {
          // Zähler nur um den Selfie-Aufruf (das Spiel rendert im selben rAF vorher seinen Frame).
          gl.render = counting;
          const before = performance.now();
          const c = rd.selfie(96, 54, vm);
          const ms = performance.now() - before;
          gl.render = orig;
          let last = t0;
          const tick = (t) => {
            frames.push(t - last);
            last = t;
            if (frames.length < 6) requestAnimationFrame(tick);
            else resolve({ c, ms });
          };
          requestAnimationFrame(tick);
        });
      });
      const c = out.c;
      if (!c) return { error: 'selfie null' };
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let sum2 = 0;
      const n = c.width * c.height;
      for (let i = 0; i < n; i++) {
        const y = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
        sum += y;
        sum2 += y * y;
      }
      const mean = sum / n;
      const big = document.createElement('canvas');
      big.width = c.width * 4;
      big.height = c.height * 4;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(c, 0, 0, big.width, big.height);
      return { w: c.width, h: c.height, variance: sum2 / n - mean * mean, mean, ms: out.ms, worldPasses, allPasses, stats: { ...selfieStats }, frames, dataUrl: big.toDataURL('image/png') };
    }, glove);
    await page.context().close();
    if (r.error) {
      check(false, `selfie ${glove}: ${r.error}`);
      continue;
    }
    writeFileSync(`${OUT}/selfie-${glove}.png`, Buffer.from(r.dataUrl.split(',')[1], 'base64'));
    // Frame mit dem Selfie (frames[0]: rAF des Auslösers → nächster) und der danach — beide < 25 ms.
    const next = Math.max(r.frames[0], r.frames[1]);
    console.log(`selfie ${glove}: ${r.w}×${r.h}, Varianz ${r.variance.toFixed(1)}, Mittel ${r.mean.toFixed(1)}, ${r.ms.toFixed(2)} ms, Welt-Durchgänge ${r.worldPasses} (render-Aufrufe ${r.allPasses}, Viewmodel ${r.stats.viewModelPasses}), Frames danach ${r.frames.map((f) => f.toFixed(1)).join('/')} ms`);
    results.push(r);
    check(r.w === 96 && r.h === 54 && r.variance > 0, `selfie ${glove}: 96×54, nicht leer (Varianz ${r.variance.toFixed(1)})`);
    check(r.worldPasses === 1 && r.stats.viewModelPasses === 1, `selfie ${glove}: genau 1 Welt- und 1 Viewmodel-Durchgang (${r.worldPasses}/${r.stats.viewModelPasses})`);
    check(next < 25, `selfie ${glove}: Frames danach höchstens ${next.toFixed(1)} ms (< 25)`);
  }
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
