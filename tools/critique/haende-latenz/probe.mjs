/**
 * Kritik-Linse HAENDE & LATENZ — Probe 1: Eingabe -> Tick -> Bild im echten Spiel.
 * Aendert keinen Projektcode. Port 5200 (CRIT_PORT).
 *
 *  A) Pointer Lock per Klick auf "Weiter", raw ja/nein
 *  B) Maus: echte CDP-Mausbewegung im Lock -> in welchem Spiel-Frame ist der Blick drin?
 *  C) Taste Space / Mausrad / C -> Tick (Event-Zeit) und Frame
 *  D) Wiedereinstieg: Esc -> "Weiter" nach d ms; F1 -> F1
 *
 *   node tools/critique/haende-latenz/probe.mjs [--uncapped]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5200);
const OUT = 'shots/critique/haende-latenz';
const UNCAPPED = process.argv.includes('--uncapped');
mkdirSync(OUT, { recursive: true });

const args = ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
if (UNCAPPED) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');

const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args });
const out = { uncapped: UNCAPPED };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // rAF-Hülle: Spiel-Frame (cb.name === 'frame') mit Start/Ende und Blick VOR dem Callback.
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const P = (window.__probe = { frames: [], mm: [], kd: [], wheel: [], on: false });
    window.requestAnimationFrame = (cb) =>
      raf((ts) => {
        if (P.on && cb.name === 'frame' && window.__vel) {
          const t0 = performance.now();
          const y0 = window.__vel.state().yawDeg;
          cb(ts);
          const t1 = performance.now();
          P.frames.push({ ts, t0, t1, y0, y1: window.__vel.state().yawDeg });
          return;
        }
        cb(ts);
      });
    document.addEventListener('mousemove', (e) => {
      if (P.on) P.mm.push({ t: performance.now(), ets: e.timeStamp, dx: e.movementX });
    }, true);
    window.addEventListener('keydown', (e) => {
      if (P.on) P.kd.push({ t: performance.now(), ets: e.timeStamp, code: e.code, repeat: e.repeat });
    }, true);
    window.addEventListener('wheel', (e) => {
      if (P.on) P.wheel.push({ t: performance.now(), ets: e.timeStamp, dy: e.deltaY });
    }, true);
  });

  await page.goto(`${srv.url}?level=level1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true && window.__vel.state().gameState === 'paused', null, { timeout: 20000 });
  // Keine Effekte, die den Blick verfaelschen (Screenshake addiert Yaw) — hier egal, yawDeg ist der rohe Blick.

  // ---------------- A) Lock
  const clickResume = async () => {
    const b = page.locator('button:has(.vel-resume-label)');
    await b.click({ timeout: 2000 }).catch((e) => console.log('click fail', e.message));
  };
  await page.mouse.move(640, 360);
  await clickResume();
  await page.waitForFunction(() => window.__vel.state().locked, null, { timeout: 3000 }).catch(() => undefined);
  let st = await page.evaluate(() => window.__vel.state());
  out.lock = { locked: st.locked, gameState: st.gameState };
  console.log('A) Lock nach Klick:', out.lock);

  // ---------------- B) Maus -> Frame
  await page.evaluate(() => {
    window.__probe.on = true;
  });
  let x = 640;
  for (let i = 0; i < 120; i++) {
    x += i % 2 === 0 ? 7 : -7;
    await page.mouse.move(x, 360);
    await page.waitForTimeout(5 + Math.random() * 20);
  }
  await page.waitForTimeout(100);
  const pb = await page.evaluate(() => {
    const P = window.__probe;
    P.on = false;
    const r = { frames: P.frames.slice(), mm: P.mm.slice() };
    P.frames.length = 0;
    P.mm.length = 0;
    P.kd.length = 0;
    return r;
  });
  const mmLat = [];
  let sameFrameYaw = 0;
  let checked = 0;
  const nonzero = pb.mm.filter((m) => m.dx !== 0).length;
  for (const m of pb.mm) {
    const f = pb.frames.find((fr) => fr.t0 >= m.t);
    if (!f) continue;
    mmLat.push(f.t0 - m.t);
    checked++;
  }
  // Blick aendert sich zwischen Frames nur durch Maus: y0 (Frame-Start) != y1 des Vorframes -> Event kam vor diesem Frame an.
  for (let i = 1; i < pb.frames.length; i++) {
    const a = pb.frames[i - 1];
    const b = pb.frames[i];
    if (Math.abs(b.y0 - a.y1) > 1e-6) sameFrameYaw++;
  }
  const frameDts = pb.frames.slice(1).map((f, i) => f.ts - pb.frames[i].ts);
  out.mouse = {
    events: pb.mm.length,
    nonzeroMovement: nonzero,
    eventToNextFrameStartMs: stats(mmLat),
    framesWithNewYaw: sameFrameYaw,
    frames: pb.frames.length,
    frameDtMs: stats(frameDts),
    yawChangedInsideCallback: pb.frames.filter((f) => Math.abs(f.y1 - f.y0) > 1e-6).length,
    frameCallbackMs: stats(pb.frames.map((f) => f.t1 - f.t0)),
  };
  console.log('B) Maus:', JSON.stringify(out.mouse));

  // ---------------- C) Tasten -> Tick
  const spawnOnGround = async () => {
    await page.evaluate(() => {
      const li = window.__vel.levelInfo();
      window.__vel.teleport(li.spawn.x, li.spawn.y, li.spawn.z, li.spawnYaw);
      window.__vel.setVelocity(0, 0, 0);
    });
    await page.waitForFunction(() => window.__vel.state().onGround, null, { timeout: 2000 });
    await page.waitForTimeout(60);
  };
  const lat = { space: [], wheel: [], crouchEvent: [], crouchHull: [], spaceFrame: [] };
  for (let k = 0; k < 25; k++) {
    await spawnOnGround();
    await page.evaluate(() => {
      window.__probe.on = true;
      window.__probe.kd.length = 0;
      window.__probe.frames.length = 0;
    });
    const n0 = await page.evaluate(() => window.__vel.events().length);
    await page.waitForTimeout(Math.random() * 17);
    await page.keyboard.down('Space');
    await page.waitForTimeout(30);
    await page.keyboard.up('Space');
    await page.waitForTimeout(80);
    const r = await page.evaluate((n0) => {
      const P = window.__probe;
      P.on = false;
      const ev = window.__vel.events().slice(n0).filter((e) => e.type === 'jump');
      return { kd: P.kd.filter((k) => k.code === 'Space')[0], jump: ev[0], frames: P.frames.slice() };
    }, n0);
    if (r.kd && r.jump) {
      lat.space.push(r.jump.t * 1000 - r.kd.t);
      const f = r.frames.find((fr) => fr.t0 >= r.kd.t);
      if (f) lat.spaceFrame.push(f.t1 - r.kd.t);
    }
  }
  for (let k = 0; k < 20; k++) {
    await spawnOnGround();
    await page.evaluate(() => {
      window.__probe.on = true;
      window.__probe.wheel.length = 0;
    });
    const n0 = await page.evaluate(() => window.__vel.events().length);
    await page.waitForTimeout(Math.random() * 17);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    const r = await page.evaluate((n0) => {
      const P = window.__probe;
      P.on = false;
      const ev = window.__vel.events().slice(n0).filter((e) => e.type === 'jump');
      return { w: P.wheel[0], jump: ev[0], n: ev.length };
    }, n0);
    if (r.w && r.jump) lat.wheel.push(r.jump.t * 1000 - r.w.t);
    else lat.wheel.push(null);
  }
  for (let k = 0; k < 15; k++) {
    await spawnOnGround();
    await page.evaluate(() => {
      window.__probe.on = true;
      window.__probe.kd.length = 0;
    });
    const n0 = await page.evaluate(() => window.__vel.events().length);
    await page.waitForTimeout(Math.random() * 17);
    await page.keyboard.down('KeyC');
    const tDown = await page.evaluate(() => performance.now());
    await page.waitForFunction(() => window.__vel.state().ducked, null, { timeout: 2000, polling: 'raf' }).catch(() => undefined);
    const tHull = await page.evaluate(() => performance.now());
    const r = await page.evaluate((n0) => {
      const P = window.__probe;
      P.on = false;
      const ev = window.__vel.events().slice(n0).filter((e) => e.type === 'duck');
      return { kd: P.kd.filter((k) => k.code === 'KeyC')[0], duck: ev[0] };
    }, n0);
    await page.keyboard.up('KeyC');
    if (r.kd && r.duck) lat.crouchEvent.push(r.duck.t * 1000 - r.kd.t);
    if (r.kd) lat.crouchHull.push(tHull - r.kd.t);
    void tDown;
  }
  out.keys = {
    spaceToJumpTickMs: stats(lat.space),
    spaceToFrameEndMs: stats(lat.spaceFrame),
    wheelToJumpTickMs: stats(lat.wheel.filter((v) => v !== null)),
    wheelMissed: lat.wheel.filter((v) => v === null).length,
    crouchToDuckEventMs: stats(lat.crouchEvent),
    crouchToHullDuckedMs: stats(lat.crouchHull),
  };
  console.log('C) Tasten:', JSON.stringify(out.keys, null, 1));

  // ---------------- D) Wiedereinstieg
  const relock = [];
  for (const d of [30, 150, 400, 800, 1200, 2000]) {
    st = await page.evaluate(() => window.__vel.state());
    if (!st.locked) {
      await clickResume();
      await page.waitForFunction(() => window.__vel.state().locked, null, { timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
    }
    const before = await page.evaluate(() => window.__vel.state().locked);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__vel.state().locked, null, { timeout: 2000 }).catch(() => undefined);
    const afterEsc = await page.evaluate(() => ({ locked: window.__vel.state().locked, menu: window.__vel.state().menu }));
    await page.waitForTimeout(d);
    const t0 = Date.now();
    await clickResume();
    const ok = await page
      .waitForFunction(() => window.__vel.state().locked, null, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    const ms = Date.now() - t0;
    const hint = await page.locator(".vel-lock-hint").first().textContent({ timeout: 200 }).catch(() => null);
    const title = await page.locator(".vel-lock-hint").first().getAttribute("title", { timeout: 200 }).catch(() => null);
    relock.push({ delayMs: d, lockedBefore: before, escUnlocked: !afterEsc.locked, menu: afterEsc.menu, relocked: ok, ms, hint, error: title });
    console.log('D) Esc -> Weiter nach', d, 'ms:', JSON.stringify(relock[relock.length - 1]));
    if (!ok) await page.waitForTimeout(1500);
  }
  out.relockAfterEsc = relock;

  // F1 -> F1
  st = await page.evaluate(() => window.__vel.state());
  if (!st.locked) {
    await clickResume();
    await page.waitForFunction(() => window.__vel.state().locked, null, { timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const f1 = [];
  for (const d of [100, 400, 1000]) {
    await page.keyboard.press('F1');
    await page.waitForFunction(() => window.__vel.state().tuningVisible, null, { timeout: 2000 }).catch(() => undefined);
    const mid = await page.evaluate(() => ({ locked: window.__vel.state().locked, gs: window.__vel.state().gameState }));
    await page.waitForTimeout(d);
    const t0 = Date.now();
    await page.keyboard.press('F1');
    const ok = await page
      .waitForFunction(() => window.__vel.state().locked && window.__vel.state().gameState === 'playing', null, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    const s2 = await page.evaluate(() => window.__vel.state());
    f1.push({ delayMs: d, midLocked: mid.locked, midState: mid.gs, relocked: ok, ms: Date.now() - t0, state: s2.gameState, menu: s2.menu, tuning: s2.tuningVisible });
    console.log('D) F1 -> F1 nach', d, 'ms:', JSON.stringify(f1[f1.length - 1]));
    if (!ok) {
      await clickResume();
      await page.waitForTimeout(1500);
    }
  }
  out.f1 = f1;
  out.errors = errors;
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(`${OUT}/probe${UNCAPPED ? '-uncapped' : ''}.json`, JSON.stringify(out, null, 2));

function stats(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, mean: r2(mean), min: r2(s[0]), p50: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1]) };
}
function r2(v) {
  return Math.round(v * 100) / 100;
}
