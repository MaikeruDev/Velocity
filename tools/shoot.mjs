/**
 * Hero-Shots aus dem echten Spiel + Ablauf-Checks (npm run shot). Port 5190,
 * per SHOT_PORT änderbar (parallele Läufe brauchen eigene Ports).
 *
 *   node tools/shoot.mjs               → Shots nach shots/game/ und Ablauf-Checks
 *   node tools/shoot.mjs --shots       → nur Shots
 *   node tools/shoot.mjs --check       → nur Checks (Titel → Klick → Level → CP → Fall → Respawn → Ziel → R → Esc → Menü …)
 *
 * Positionen kommen aus __vel.levelInfo() (Trigger/Spawns), nicht hart kodiert —
 * die Level-JSONs werden parallel umgebaut. Exit 1 bei Konsolenfehlern oder
 * fehlgeschlagenen Checks.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.SHOT_PORT ?? 5190);
const OUT = 'shots/game';
const VIEW = { width: 1280, height: 720 };
const args = process.argv.slice(2);
const ONLY_SHOTS = args.includes('--shots');
const ONLY_CHECK = args.includes('--check');

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const consoleErrors = [];
const failures = [];
let passed = 0;
try {
  if (!ONLY_CHECK) await heroShots();
  if (!ONLY_SHOTS) await flowChecks();
  if (!ONLY_SHOTS) await v2Checks();
} finally {
  await browser.close();
  await srv.close();
}

if (!ONLY_SHOTS) console.log(`\nChecks: ${passed} ok, ${failures.length} fehlgeschlagen`);
if (failures.length > 0) console.error(failures.map((f) => `  ✗ ${f}`).join('\n'));
if (consoleErrors.length > 0) console.error(`\n${consoleErrors.length} Konsolenfehler:\n${consoleErrors.join('\n')}`);
if (failures.length > 0 || consoleErrors.length > 0) process.exit(1);

// ================================================================== Helfer

async function newGamePage(query = '', b = browser) {
  const page = await b.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`);
  });
  await page.goto(`${srv.url}${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__vel.events(0);
  });
  return page;
}

function st(page) {
  return page.evaluate(() => window.__vel.state());
}

function info(page) {
  return page.evaluate(() => window.__vel.levelInfo());
}

async function waitFor(page, pred, timeoutMs, label) {
  const t0 = Date.now();
  let s = await st(page);
  while (!pred(s)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timeout (${timeoutMs} ms): ${label} — Zustand ${summary(s)}`);
    await page.waitForTimeout(50);
    s = await st(page);
  }
  return s;
}

function summary(s) {
  return `${s.gameState}/${s.menu ?? '-'} lvl=${s.levelId} pos=${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)} spd=${Math.round(s.speed)} t=${s.runTime?.toFixed?.(2) ?? 'null'} cp=${s.checkpoint.index}/${s.checkpoint.total} locked=${s.locked}`;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${OUT}/${name}.png`);
}

function center(t) {
  return { x: (t.min.x + t.max.x) / 2, y: t.min.y, z: (t.min.z + t.max.z) / 2 };
}

function byOrder(lv, kind) {
  return lv.triggers.filter((t) => t.kind === kind).sort((a, b) => a.order - b.order);
}

function check(ok, label, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    check(false, label, err instanceof Error ? err.message : String(err));
  }
}

function lastEvent(page, type) {
  return page.evaluate((t) => window.__vel.events().filter((e) => e.type === t).at(-1) ?? null, type);
}

// ================================================================== Hero-Shots

async function heroShots() {
  console.log('Hero-Shots');
  // --- Titel
  let page = await newGamePage();
  await page.waitForTimeout(2200);
  await shot(page, '01-title');

  // --- Level 1: Start, HUD im Lauf, Pause, Einstellungen
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(700);
  await shot(page, '02-level1-start');
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  await waitFor(page, (s) => s.hopChain >= 6 && s.speed > 520, 40000, 'Hop-Kette im Lauf');
  await shot(page, '03-hud-run');
  await page.evaluate(() => window.__vel.pause());
  await page.waitForTimeout(350);
  await shot(page, '04-pause');
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.waitForTimeout(350);
  await shot(page, '05-settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__vel.resume());

  // --- Blick über die Hop-Kette: vom ersten Checkpoint in Laufrichtung
  const lv1 = await info(page);
  const cps1 = byOrder(lv1, 'checkpoint');
  await page.evaluate(() => {
    window.__vel.useBot(null);
    window.__vel.freeze(true);
  });
  const cp1 = cps1[0];
  await page.evaluate(({ p, yaw }) => {
    window.__vel.teleport(p.x, p.y, p.z, yaw);
    window.__vel.setView(yaw, -7);
  }, { p: cp1.spawn, yaw: cp1.spawnYaw });
  await page.waitForTimeout(2600); // HUD-Popups ausklingen lassen
  await shot(page, '06-hopchain');

  // --- Hohe Geschwindigkeit: vom zweiten Checkpoint mit 1400 u/s in die Luft
  const cp2 = cps1[1] ?? cp1;
  await page.evaluate(({ p, yaw }) => {
    const v = window.__vel;
    v.freeze(false);
    v.teleport(p.x, p.y + 40, p.z, yaw);
    const r = (yaw * Math.PI) / 180;
    v.setVelocity(-Math.sin(r) * 1400, 180, -Math.cos(r) * 1400);
  }, { p: cp2.spawn, yaw: cp2.spawnYaw });
  await page.waitForTimeout(420);
  await shot(page, '07-highspeed');

  // --- Ergebnis: Bot vorgespult bis ins Ziel, dann Echtzeit bis zum Overlay
  await page.evaluate(() => {
    window.__vel.useBot('route', { sync: 1, seed: 11 });
    window.__vel.freeze(true);
  });
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => window.__vel.stepTicks(256));
    if (s.finish || s.bot?.status === 'failed') break;
  }
  await page.evaluate(() => window.__vel.freeze(false));
  await waitFor(page, (s) => s.menu === 'finish', 5000, 'Ergebnis-Overlay');
  await page.waitForTimeout(500);
  await shot(page, '08-result');
  await page.close();

  // --- Level 2: Start, Surf, Luft-Checkpoint
  page = await newGamePage();
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(700);
  await shot(page, '09-level2-start');
  const lv2 = await info(page);
  const cps2 = byOrder(lv2, 'checkpoint');
  // Erster Luft-Checkpoint = höher als 640 u (Surf-Übergang).
  const air = cps2.find((t) => t.max.y - t.min.y > 640 && t.spawn.y > t.min.y + 400) ?? cps2.at(-1);
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  await waitFor(page, (s) => s.surfing && s.speed > 800, 60000, 'Surf mit > 800 u/s');
  await shot(page, '10-surf');
  await waitFor(page, (s) => s.pos.z < air.max.z + 700 || s.checkpoint.index >= air.order || s.bot?.status !== 'running', 30000, 'Anflug Luft-Checkpoint');
  await shot(page, '11-air-checkpoint-approach');
  // Standbild: von der Route vor dem Luft-Checkpoint auf das Tor schauen.
  const before = lv2.route.filter((n) => n.pos.z > air.max.z + 200).at(-1);
  if (before) {
    await page.evaluate(({ p }) => {
      const v = window.__vel;
      v.useBot(null);
      v.freeze(true);
      v.teleport(p.x, p.y, p.z, 0);
      v.setView(0, 4);
    }, { p: before.pos });
    await page.waitForTimeout(2600);
    await shot(page, '12-air-checkpoint-gate');
  }
  // Respawn-Blick an CP3 (Pad auf dem Grat der Folgerampe): die Flanke liegt sichtbar voraus.
  await page.evaluate(({ p, yaw }) => {
    const v = window.__vel;
    v.useBot(null);
    v.freeze(true);
    v.teleport(p.x, p.y, p.z, yaw);
    v.setView(yaw, 0);
  }, { p: air.spawn, yaw: air.spawnYaw });
  await page.waitForTimeout(2600);
  await shot(page, '13-cp3-respawn-view');
  // Ausfahrt: vom letzten Ring-Knoten auf Vorfeld, E1 und die Surf-Kette.
  const t0 = lv2.route.findIndex((n) => n.note === 'Ausfahrt');
  if (t0 > 0) {
    const a = lv2.route[t0 - 1].pos;
    const b = lv2.route[t0].pos;
    const yaw = (Math.atan2(-(b.x - a.x), -(b.z - a.z)) * 180) / Math.PI;
    await page.evaluate(({ p, yaw }) => {
      window.__vel.teleport(p.x, p.y, p.z, yaw);
      window.__vel.setView(yaw, -8);
    }, { p: a, yaw });
    await page.waitForTimeout(400);
    await shot(page, '14-exit-apron');
  }
  await page.close();

  // --- Level 1: Finale mit Auffangrampe unter dem Schluss-Gap
  page = await newGamePage();
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(400);
  const lv1b = await info(page);
  const gap = lv1b.route.findIndex((n) => n.note === 'Schluss-Gap');
  if (gap > 0) {
    const a = lv1b.route[gap].pos;
    const b = lv1b.route[gap + 1].pos;
    const yaw = (Math.atan2(-(b.x - a.x), -(b.z - a.z)) * 180) / Math.PI;
    await page.evaluate(({ p, yaw }) => {
      const v = window.__vel;
      v.freeze(true);
      v.teleport(p.x, p.y, p.z, yaw);
      v.setView(yaw, -14);
    }, { p: a, yaw });
    await page.waitForTimeout(2600);
    await shot(page, '15-finale-catch');
  }
  await page.close();
}

// ================================================================== Ablauf-Checks

async function flowChecks() {
  console.log('\nAblauf-Checks (echter Klick, Pointer Lock soweit headless möglich)');
  const page = await newGamePage();
  let s = await st(page);
  check(s.gameState === 'title' && s.menu === 'title', 'Titel: Zustand title, Titelmenü sichtbar', summary(s));

  // --- Titel → Klick → Level 1 (User-Geste: Lock + Audio im Klick-Handler)
  await step('Klick "Klicken zum Starten" startet Level 1', async () => {
    await page.locator('.vel-start').click();
    s = await waitFor(page, (x) => x.gameState === 'playing' && x.levelId === 'level1', 8000, 'playing level1');
    check(true, 'Klick "Klicken zum Starten" startet Level 1');
    s = await waitFor(page, (x) => x.locked, 3000, 'Lock nach Klick');
    check(true, 'Pointer Lock nach Klick aktiv');
    const loaded = await lastEvent(page, 'levelLoaded');
    check(loaded?.subtitle !== undefined, 'levelLoaded trägt subtitle', JSON.stringify(loaded));
  });
  const lv = await info(page);
  const cps = byOrder(lv, 'checkpoint');
  const finish = lv.triggers.find((t) => t.kind === 'finish');
  const kill = lv.triggers.find((t) => t.kind === 'kill');

  // --- Start-Zone verlassen → Timer läuft
  await step('W: Start-Zone verlassen startet den Timer', async () => {
    await page.keyboard.down('KeyW');
    try {
      s = await waitFor(page, (x) => x.running && x.runTime !== null, 4000, 'Timer läuft');
    } finally {
      await page.keyboard.up('KeyW');
    }
    check(s.pos.z < lv.spawn.z - 80, 'W: Start-Zone verlassen startet den Timer', summary(s));
    check((await lastEvent(page, 'runStart')) !== null, 'runStart-Event');
  });

  // --- Checkpoint 1 (nur in Reihenfolge)
  await step('Checkpoint in Reihenfolge', async () => {
    if (cps.length >= 2) {
      const c2 = cps[1];
      await page.evaluate(({ p, yaw }) => window.__vel.teleport(p.x, p.y, p.z, yaw), { p: c2.spawn, yaw: c2.spawnYaw });
      await page.waitForTimeout(150);
      s = await st(page);
      check(s.checkpoint.index === 0, 'CP 2 vor CP 1 zählt nicht', summary(s));
    }
    const c1 = cps[0];
    await page.evaluate(({ p, yaw }) => window.__vel.teleport(p.x, p.y, p.z, yaw), { p: c1.spawn, yaw: c1.spawnYaw });
    s = await waitFor(page, (x) => x.checkpoint.index === 1, 2000, 'CP 1');
    const ev = await lastEvent(page, 'checkpoint');
    check(ev?.index === 1 && ev.total === cps.length && ev.split === null, 'CP 1 erreicht (Event, split null ohne Bestzeit)', JSON.stringify(ev));
  });

  // --- Fall → Respawn am CP, Blick = Spawn-Yaw, Timer läuft weiter
  await step('Fall unter killY → Respawn an CP 1', async () => {
    const c1 = cps[0];
    const t0 = (await st(page)).runTime;
    await page.evaluate(({ p, y }) => {
      window.__vel.setView(123, -30);
      window.__vel.teleport(p.x, y, p.z);
    }, { p: c1.spawn, y: lv.killY - 60 });
    s = await waitFor(page, (x) => Math.hypot(x.pos.x - c1.spawn.x, x.pos.z - c1.spawn.z) < 40 && Math.abs(x.pos.y - c1.spawn.y) < 40, 2000, 'Respawn an CP 1');
    const ev = await lastEvent(page, 'respawn');
    check(ev?.reason === 'fall', 'Fall unter killY → Respawn an CP 1 (reason fall)', JSON.stringify(ev));
    check(Math.abs(angleDiff(s.yawDeg, c1.spawnYaw)) < 0.5 && Math.abs(s.pitchDeg) < 0.5, 'Blick nach Respawn = Spawn-Yaw, Pitch 0', `yaw ${s.yawDeg} soll ${c1.spawnYaw}`);
    check(s.running && s.runTime >= t0 && s.checkpoint.index === 1, 'Timer läuft nach Respawn weiter, CP bleibt', summary(s));
  });

  if (kill) {
    await step('Kill-Trigger → Respawn', async () => {
      const k = center(kill);
      await page.evaluate(({ p }) => window.__vel.teleport(p.x, p.y + 8, p.z), { p: k });
      await page.waitForTimeout(200);
      const ev = await lastEvent(page, 'respawn');
      check(ev?.reason === 'kill', 'Kill-Trigger → Respawn (reason kill)', JSON.stringify(ev));
    });
  }

  // --- F → zurück zum letzten Checkpoint (Timer läuft weiter, Grund manual)
  await step('F → zurück zum Checkpoint', async () => {
    const c1 = cps[0];
    await page.evaluate(({ p }) => window.__vel.teleport(p.x + 40, p.y, p.z - 300), { p: c1.spawn });
    await page.waitForTimeout(100);
    const t0 = (await st(page)).runTime;
    await page.keyboard.press('KeyF');
    s = await waitFor(page, (x) => Math.hypot(x.pos.x - c1.spawn.x, x.pos.z - c1.spawn.z) < 40, 2000, 'Respawn an CP 1 per F');
    const ev = await lastEvent(page, 'respawn');
    check(ev?.reason === 'manual', 'F → Respawn an CP 1 (reason manual)', JSON.stringify(ev));
    check(s.running && s.runTime >= t0 && s.checkpoint.index === 1, 'F: Timer läuft weiter, CP bleibt', summary(s));
  });

  // --- Ziel erst nach allen CPs
  await step('Ziel nach allen Checkpoints → Ergebnis', async () => {
    const f = center(finish);
    await page.evaluate(({ p }) => window.__vel.teleport(p.x, p.y + 4, p.z), { p: f });
    await page.waitForTimeout(150);
    s = await st(page);
    check(s.gameState === 'playing' && !s.finish, 'Ziel vor allen CPs zählt nicht', summary(s));
    for (const c of cps.slice(1)) {
      await page.evaluate(({ p, yaw }) => window.__vel.teleport(p.x, p.y, p.z, yaw), { p: c.spawn, yaw: c.spawnYaw });
      await waitFor(page, (x) => x.checkpoint.index >= c.order, 2000, `CP ${c.order}`);
    }
    await page.evaluate(({ p }) => window.__vel.teleport(p.x, p.y + 4, p.z), { p: f });
    s = await waitFor(page, (x) => x.gameState === 'finished', 2000, 'finished');
    const ev = await lastEvent(page, 'finish');
    check(ev !== null && ev.best === true && ev.previousBest === null, 'Ziel: finish-Event (erste Bestzeit)', JSON.stringify(ev));
    s = await waitFor(page, (x) => x.menu === 'finish', 4000, 'Ergebnis-Menü');
    check(!s.locked, 'Ergebnis-Menü: Maus frei', summary(s));
    check(s.finish && s.finish.splits.length === cps.length, 'Ergebnis mit allen Zwischenzeiten', JSON.stringify(s.finish?.splits));
    await page.waitForTimeout(250); // Einblend-Animation des Menüs (160 ms) abwarten
    await shot(page, 'flow-result');
  });

  // --- R im Ergebnis → Neustart
  await step('R im Ergebnis → Neustart', async () => {
    await page.waitForTimeout(500); // Eingabesperre des Ergebnis-Screens
    await page.keyboard.press('KeyR');
    s = await waitFor(page, (x) => x.gameState === 'playing' && x.menu === null, 3000, 'playing nach R');
    const ev = await lastEvent(page, 'respawn');
    check(ev?.reason === 'restart' && s.runTime === null && s.checkpoint.index === 0, 'R im Ergebnis → Neustart (Timer aus, CP 0)', summary(s));
    check(Math.hypot(s.pos.x - lv.spawn.x, s.pos.z - lv.spawn.z) < 2, 'Neustart am Level-Spawn', summary(s));
    s = await waitFor(page, (x) => x.locked, 3000, 'Lock nach R');
    check(true, 'Lock nach R wieder aktiv');
  });

  // --- R im Spiel → Neustart
  await step('R im Spiel', async () => {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(900);
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyR');
    await page.waitForTimeout(120);
    s = await st(page);
    check(s.runTime === null && Math.hypot(s.pos.x - lv.spawn.x, s.pos.z - lv.spawn.z) < 2, 'R im Spiel → sofort zurück an den Start', summary(s));
  });

  // --- Esc → Pause, Enter → weiter
  await step('Esc → Pause', async () => {
    await page.keyboard.press('Escape');
    s = await waitFor(page, (x) => x.gameState === 'paused' && x.menu === 'pause', 3000, 'Pause');
    check(!s.locked, 'Esc → Pause-Menü, Maus frei', summary(s));
    const before = s.pos;
    await page.waitForTimeout(300);
    s = await st(page);
    check(s.pos.x === before.x && s.pos.y === before.y && s.pos.z === before.z, 'Pause: keine Ticks', summary(s));
    await page.waitForTimeout(400); // Chrome sperrt Re-Lock direkt nach Esc kurz
    await page.keyboard.press('Enter');
    s = await waitFor(page, (x) => x.gameState === 'playing' && x.menu === null && x.locked, 4000, 'weiter nach Enter mit Lock');
    check(true, 'Enter in der Pause → weiter mit Lock');
  });

  // --- F1 → Tuning, Klick ins Bild → weiter
  await step('F1 → Tuning-Panel, Klick ins Bild → weiter', async () => {
    await page.keyboard.press('F1');
    s = await waitFor(page, (x) => x.gameState === 'paused' && x.tuningVisible, 2000, 'Tuning offen');
    check(!s.locked && s.menu === null, 'F1: Tuning sichtbar, Spiel pausiert, Maus frei', summary(s));
    await page.waitForTimeout(400);
    await page.mouse.click(300, 600);
    s = await waitFor(page, (x) => x.gameState === 'playing' && x.locked, 4000, 'weiter nach Klick mit Lock');
    check(!s.tuningVisible, 'Klick ins Bild → weiter mit Lock, Tuning zu', summary(s));
  });

  // --- M → Mute (darf nichts kaputt machen)
  await step('M → Ton aus', async () => {
    await page.keyboard.press('KeyM');
    await page.waitForTimeout(100);
    await page.keyboard.press('KeyM');
    s = await st(page);
    check(s.gameState === 'playing', 'M schaltet Ton um, Spiel läuft weiter', summary(s));
  });

  // --- Esc → Pause → Levelauswahl → Titel
  await step('Esc → Menü (Levelauswahl)', async () => {
    await page.keyboard.press('Escape');
    await waitFor(page, (x) => x.menu === 'pause', 3000, 'Pause');
    await page.getByRole('button', { name: 'Levelauswahl' }).click();
    s = await waitFor(page, (x) => x.gameState === 'title' && x.menu === 'title', 3000, 'Titel');
    check(true, 'Esc → Pause → Levelauswahl → Titel');
    const bestText = await page.locator('.vel-level.is-selected .vel-level-best').innerText();
    check(!bestText.includes('--:--'), 'Titel zeigt neue Bestzeit am zuletzt gespielten Level', bestText);
  });

  // --- Ergebnis → Esc → Titel
  await step('Ergebnis → Esc → Titel', async () => {
    await page.locator('.vel-start').click();
    await waitFor(page, (x) => x.gameState === 'playing', 5000, 'playing');
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(700);
    await page.keyboard.up('KeyW');
    for (const c of cps) {
      await page.evaluate(({ p, yaw }) => window.__vel.teleport(p.x, p.y, p.z, yaw), { p: c.spawn, yaw: c.spawnYaw });
      await waitFor(page, (x) => x.checkpoint.index >= c.order, 2000, `CP ${c.order}`);
    }
    const f = center(finish);
    await page.evaluate(({ p }) => window.__vel.teleport(p.x, p.y + 4, p.z), { p: f });
    await waitFor(page, (x) => x.menu === 'finish', 4000, 'Ergebnis');
    const ev = await lastEvent(page, 'finish');
    check(ev && ev.previousBest !== null, 'Zweiter Lauf kennt die vorige Bestzeit', JSON.stringify(ev));
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    s = await waitFor(page, (x) => x.gameState === 'title', 3000, 'Titel');
    check(true, 'Ergebnis → Esc → Titel');
  });

  // --- Tab-Wechsel → Pause
  await step('Tab-Wechsel pausiert', async () => {
    await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    s = await st(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    check(s.gameState === 'paused' && s.menu === 'pause', 'Tab-Wechsel → Pause', summary(s));
  });

  // --- Einstellungen live: Pixelhöhe → HUD/Renderer ziehen mit
  await step('Einstellungen live', async () => {
    await page.evaluate(() => window.__vel.setRenderSettings({ pixelHeight: 360 }));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__vel.setRenderSettings({ pixelHeight: 270 }));
    // "Vollbild beim Start" (Default an) hat das Fenster per Klick ins Vollbild gebracht —
    // Playwright kann ein Vollbild-Fenster nicht verkleinern (Browser.setWindowBounds).
    await page.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : null));
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 960, height: 540 });
    await page.waitForTimeout(200);
    await page.setViewportSize(VIEW);
    check(true, 'Pixelhöhe und Fenstergröße live geändert');
  });

  // --- Ladefehler → Titel mit Meldung
  await step('Ladefehler', async () => {
    const ok = await page.evaluate(() => window.__vel.start('gibt-es-nicht', { lockless: true }));
    s = await st(page);
    const toast = await page.locator('#vel-toast').innerText();
    check(!ok && s.gameState === 'title' && s.menu === 'title' && toast.includes('gibt-es-nicht'), 'Ladefehler → Titelmenü mit Meldung', `${summary(s)} toast="${toast}"`);
  });
  await page.close();

  // --- Dev-Direktstart ?level=level2 → Pause, "Weiter" startet
  await step('?level=level2', async () => {
    const p2 = await newGamePage('?level=level2');
    s = await waitFor(p2, (x) => x.levelId === 'level2' && x.gameState === 'paused', 8000, 'level2 pausiert');
    check(s.menu === 'pause', '?level=level2 → Level geladen, Pause mit "Weiter"', summary(s));
    await p2.locator('.vel-pause-screen .vel-btn--primary').click();
    s = await waitFor(p2, (x) => x.gameState === 'playing' && x.locked, 4000, 'playing mit Lock');
    check(true, 'Klick auf "Weiter" → spielen mit Lock');
    await p2.close();
  });

  // --- WebGL2 fehlt → lesbare Meldung
  await step('WebGL2 fehlt', async () => {
    const noGl = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2', '--disable-gpu'] });
    try {
      const p3 = await noGl.newPage({ viewport: VIEW });
      await p3.goto(srv.url, { waitUntil: 'load' });
      await p3.waitForSelector('#vel-fatal:not([hidden])', { timeout: 5000 });
      const text = await p3.locator('#vel-fatal').innerText();
      check(text.includes('WebGL2'), 'Ohne WebGL2 → lesbare Meldung', text.slice(0, 80));
      await p3.screenshot({ path: `${OUT}/flow-no-webgl2.png` });
    } finally {
      await noGl.close();
    }
  });
}

// ================================================================== v2 (E2E-Review v2final)

/**
 * Kanten-Assist live im Spiel und der Trainings-Tipp im Ergebnis. Der Assist kam in 25 Bot-Läufen nie vor (Bots ducken
 * vor der Kante); hier deterministisch: L1, Hop 7 → Crouch-Kante (66 u), 320 u/s, Sprung im ersten Tick, C 8 Ticks
 * (63 ms) NACH dem Anprall. Headless (tools/sim/arcade edgeHop): vault, Ankunft 320 u/s; ohne Assist 85 u/s.
 */
async function v2Checks() {
  console.log('\nv2: Kanten-Assist live, Trainings-Tipp im Ergebnis');
  const page = await newGamePage();
  const lv1 = JSON.parse(readFileSync('public/levels/level1.json', 'utf8'));
  const hop7 = lv1.brushes.find((b) => b.tag === 'hop7');
  const ledge = lv1.brushes.find((b) => b.tag === 'ledge');
  const edgeRun = (assist) =>
    page.evaluate(
      ({ hop7, ledge, assist }) => {
        const v = window.__vel;
        v.freeze(true);
        const cfg0 = v.setConfig({});
        if (!assist) v.setConfig({ ledgeStep: 0, ledgeMemory: 0 });
        v.teleport((hop7.min[0] + hop7.max[0]) / 2, hop7.max[1] + 0.03125, -5621.8, 0);
        v.setVelocity(0, 0, -320);
        // Log ist auf 512 gekappt: Marke per Objekt-Identität statt Länge.
        const mark = v.events(1)[0] ?? null;
        let k = 0;
        let bonk = -1;
        let prev = 320;
        v.setInputOverride((s) => {
          if (bonk < 0 && k > 0 && !s.onGround && s.speed < prev * 0.5) bonk = k;
          prev = s.speed;
          const inp = { forward: 1, sprint: true, yaw: 0, jumpPressed: k === 0, jumpHeld: k === 0, crouch: bonk >= 0 && k >= bonk + 8 };
          k++;
          return inp;
        });
        let arrive = null;
        for (let i = 0; i < 192 && arrive === null; i++) {
          const s = v.stepTicks(1);
          if (s.pos.y >= ledge.max[1] - 2 && s.pos.z < ledge.max[2]) arrive = s.speed;
        }
        const all = v.events();
        const ledges = all.slice(all.indexOf(mark) + 1).filter((e) => e.type === 'ledge').map((e) => e.kind);
        v.setInputOverride(null);
        v.setConfig({ ledgeStep: cfg0.ledgeStep, ledgeMemory: cfg0.ledgeMemory });
        return { arrive, ledges, bonk };
      },
      { hop7, ledge, assist },
    );
  await step('Kanten-Assist live (L1-Crouch-Kante, C 63 ms nach dem Anprall)', async () => {
    await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await page.waitForTimeout(300);
    const a = await edgeRun(true);
    const b = await edgeRun(false);
    check(
      a.ledges.includes('vault') && a.arrive !== null && a.arrive >= 300 && b.ledges.length === 0 && (b.arrive ?? 0) < 150,
      'Kanten-Assist live: Event ledge vault, oben mit ≥ 300 u/s (ohne Assist < 150 u/s, kein Event)',
      `mit ${JSON.stringify(a)} ohne ${JSON.stringify(b)}`,
    );
  });

  // Ergebnis ohne Medaille, Training ohne Stern (frischer Speicher): Training T3 ist der Primärknopf, Enter startet es.
  await step('Ergebnis ohne Medaille → Training T3 angeboten', async () => {
    const info1 = await info(page);
    const cps = byOrder(info1, 'checkpoint');
    const finish = info1.triggers.find((t) => t.kind === 'finish');
    const run = await page.evaluate(({ sp, yaw }) => {
      const v = window.__vel;
      v.restart();
      v.freeze(true);
      v.teleport(sp.x, sp.y, sp.z, yaw);
      // Aus der Start-Zone laufen (startet den Timer), dann stehen: über Bronze (33 s), der Timer läuft in Ticks.
      v.setInputOverride(() => ({ forward: 1, sprint: true, yaw: (yaw * Math.PI) / 180 }));
      for (let i = 0; i < 384 && v.state().runTime === null; i++) v.stepTicks(1);
      v.setInputOverride(null);
      return v.stepTicks(128 * 36).runTime;
    }, { sp: info1.spawn, yaw: info1.spawnYaw });
    if (!(run > 34)) throw new Error(`Timer läuft nicht (runTime ${run}) — ${summary(await st(page))}`);
    for (const c of cps) await page.evaluate(({ p, yaw }) => { window.__vel.teleport(p.x, p.y, p.z, yaw); window.__vel.stepTicks(2); }, { p: c.spawn, yaw: c.spawnYaw });
    const f = center(finish);
    await page.evaluate(({ p }) => { window.__vel.teleport(p.x, p.y + 4, p.z); window.__vel.stepTicks(2); window.__vel.freeze(false); }, { p: f });
    await waitFor(page, (x) => x.menu === 'finish', 5000, 'Ergebnis');
    await page.waitForTimeout(400);
    const btn = await page.locator('.vel-finish-screen .vel-train-go').innerText().catch(() => '');
    const primary = await page.locator('.vel-finish-screen .vel-btn--primary').count();
    const hint = await page.locator('.vel-finish-screen .vel-train-tip').innerText().catch(() => '');
    await shot(page, 'flow-result-training');
    check(btn.toUpperCase().includes('TRAINING T3') && primary === 1 && hint.includes('T3'), 'Ergebnis ohne Medaille: Primärknopf "Training T3" + Hinweis', `Knopf "${btn}", Primär ${primary}, Hinweis "${hint}"`);
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    const s = await waitFor(page, (x) => x.levelId === 't3' && x.gameState === 'playing', 8000, 'Lektion T3');
    check(s.levelId === 't3', 'Enter im Ergebnis → Lektion T3', summary(s));
  });
  await page.close();
}

function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
