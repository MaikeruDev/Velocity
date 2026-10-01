/**
 * Unabhängiger E2E-Prüfer v2: ein Neuling spielt das Training T1…T8 mit ECHTEN Tastatur- und Maus-Events
 * (headless Chromium bekommt echten Pointer Lock; Mausbewegung = movementX). Kein setInputOverride, kein useBot.
 * Pro Pflichtstufe: Versuch 1 (wörtliche Anweisung, Neulings-Parameter), bei Stillstand Vorführung (H) ansehen,
 * dann Versuch 2 (was die Vorführung zeigt), sonst über das Pausenmenü überspringen.
 *
 *   node tools/critique/v2final/newcomer.mjs [t1 t3 …]    Port NB_PORT (Default 5419)
 * Ausgabe: tools/critique/v2final/shots/nb-*.png, logs/newcomer.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.NB_PORT ?? 5419);
const OUT = 'tools/critique/v2final/shots';
const LOG = 'tools/critique/v2final/logs/newcomer.json';
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const ATTEMPT1 = Number(process.env.NB_A1 ?? 45);
const ATTEMPT2 = Number(process.env.NB_A2 ?? 60);
const DEG_PER_PX = 0.07128; // gemessen: 100 px → 7.128° (Default-Empfindlichkeit)

const lessonJson = (id) => JSON.parse(readFileSync(`public/levels/training/${id}.json`, 'utf8'));
const center = (z) => ({ x: (z.min[0] + z.max[0]) / 2, y: (z.min[1] + z.max[1]) / 2, z: (z.min[2] + z.max[2]) / 2 });
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const yawTo = (p, t) => (Math.atan2(-(t.x - p.x), -(t.z - p.z)) * 180) / Math.PI;
// deterministischer Zufall
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const report = { lessons: {} };
let page;
const held = new Set();
async function setKeys(want) {
  for (const k of [...held]) if (!want.has(k)) { await page.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
}
async function releaseAll() { await setKeys(new Set()); }
let mouseX = 960;
async function turn(deg) {
  // Maus nach links = Yaw +. Große Drehungen in Teilschritten (echte Events).
  const px = -deg / DEG_PER_PX;
  if (Math.abs(px) < 0.5) return;
  mouseX += px;
  await page.mouse.move(mouseX, 540);
}
async function tap(k, ms = 90) { await page.keyboard.down(k); await page.waitForTimeout(ms); await page.keyboard.up(k); }

const poll = () => page.evaluate(() => {
  const v = window.__vel;
  const s = v.state();
  const tr = v.training();
  const w = window;
  w.__nbT ??= 0;
  const ev = v.events().filter((e) => e.t > w.__nbT);
  if (ev.length) w.__nbT = ev[ev.length - 1].t;
  const hl = v.hudLayout();
  return {
    pos: s.pos, speed: s.speed, onGround: s.onGround, surfing: s.surfing, ducked: s.ducked, yaw: s.yawDeg, locked: s.locked,
    menu: s.menu, g: s.gameState, notice: s.notice, lesson: s.lesson,
    tr: tr && { idx: tr.stageIndex, total: tr.stageTotal, id: tr.stageId, title: tr.stageTitle, count: tr.count, goal: tr.goal, done: tr.done,
      demo: tr.demo, demoGoal: tr.demoGoal, tip: tr.tip, tipKind: tr.tipKind, tipSerial: tr.tipSerial, rank: tr.rank, spawn: tr.spawn, judge: tr.judge, result: tr.result !== null, task: tr.task, stars: tr.stars },
    verdict: hl.verdict,
    ev: ev.filter((e) => ['lessonHop', 'lessonStage', 'gate', 'respawn', 'slideStart', 'jump', 'land'].includes(e.type)).map((e) => ({ type: e.type, verdict: e.verdict, counted: e.counted, gain: e.gain, reason: e.reason, perfect: e.perfect, clean: e.clean, speed: e.speed })),
  };
});

/** Neulings-Verhalten je Stufe. mode 1 = wörtlich/unerfahren, 2 = nach der Vorführung. Liefert Tasten + Soll-Drehung. */
function makeBrain(lessonId, stageId, L, mode) {
  const zones = Object.fromEntries((L.training.zones ?? []).map((z) => [z.id, z]));
  const route = L.route ?? [];
  const S = { lastGround: true, airT: 0, groundT: 0, hop: 0, side: 1, slid: false, cT: 0, jumpCd: 0, jumped: new Set(), bias: 0, aimNoise: 0, t: 0, fell: 0 };
  const P = (n) => ({ x: n.pos[0], y: n.pos[1], z: n.pos[2] });
  const react = mode === 1 ? 0.16 : 0.08; // Reaktion nach dem Absprung
  const rate0 = mode === 1 ? 90 : 130; // Maus °/s beim Strafen
  const aim = (st, t, maxRate, dt) => {
    const d = wrap(yawTo(st.pos, t) - st.yaw);
    return Math.max(-maxRate * dt, Math.min(maxRate * dt, d));
  };
  const nextJumpNode = (st, filter) => {
    for (let i = 0; i < route.length; i++) {
      const n = route[i];
      if (!filter(n) || S.jumped.has(i)) continue;
      const p = P(n);
      const ahead = st.pos.z - p.z; // Lektionen laufen nach −Z
      if (ahead > -10 && Math.abs(p.y - st.pos.y) < 40) return { i, ahead, p };
    }
    return null;
  };
  // generisches Ziel: erste Zone der Aufgabe bzw. nächster Routenknoten
  const strafe = (st, dt, sideFor, targetYawRate) => {
    const keys = new Set(['Space']);
    if (st.onGround) {
      keys.add('KeyW');
      return { keys, turn: 0 };
    }
    if (S.airT < react) { keys.add('KeyW'); return { keys, turn: 0 }; }
    const side = sideFor();
    if (mode === 1) keys.add('KeyW'); // wörtlich: "W + Leertaste … dann in der Luft A" — W bleibt gedrückt
    keys.add(side > 0 ? 'KeyA' : 'KeyD');
    const r = (targetYawRate ?? rate0) * (0.8 + 0.4 * rnd());
    return { keys, turn: side * r * dt };
  };
  return (st, dt) => {
    S.t += dt;
    // Bhop-Landungen dauern 1 Tick — der Poll (~20 ms) sieht sie nicht; Absprünge kommen aus dem Event-Log.
    const jumped = st.ev.some((e) => e.type === 'jump');
    if (jumped) { S.hop++; S.airT = 0; }
    if (st.onGround) { S.groundT += dt; S.airT = 0; } else { if (!jumped) S.airT += dt; S.groundT = 0; }
    S.lastGround = st.onGround;
    const task = st.tr?.task;
    // Surf-Lektionen
    if (lessonId === 't7' || lessonId === 't8') {
      const keys = new Set();
      S.aimNoise = 0.97 * S.aimNoise + (rnd() - 0.5) * (mode === 1 ? 1.2 : 0.6);
      const want = 0 + S.aimNoise; // Blick entlang der Rampe (−Z)
      if (st.pos.y < (lessonId === 't7' ? 0 : 480) && !st.surfing) { S.fell += dt; if (S.fell > 1.2) { S.fell = 0; return { keys, turn: 0, press: 'KeyF' }; } }
      if (st.surfing || (!st.onGround && S.t > 0.5)) {
        keys.add('KeyA');
        if (mode === 1 && S.airT < 0.3 && !st.surfing) keys.add('KeyW');
      } else keys.add('KeyW');
      return { keys, turn: Math.max(-2, Math.min(2, wrap(want - st.yaw))) };
    }
    if (lessonId === 't3' || lessonId === 't4' || (lessonId === 't5' && stageId === 'anlauf')) {
      let sideFor = () => 1;
      if (stageId === 'rechts') sideFor = () => -1;
      if (stageId === 'wechsel') sideFor = () => (S.hop % 2 === 0 ? 1 : -1);
      return strafe(st, dt, sideFor);
    }
    if (lessonId === 't5') {
      // Tore nacheinander: Seite zum Ziel, Maus zum Ziel
      const ids = task?.zones ?? [];
      const tgt = zones[ids[Math.min(st.tr.count, ids.length - 1)]];
      const c = tgt ? center(tgt) : st.pos;
      const d = wrap(yawTo(st.pos, c) - st.yaw);
      const keys = new Set(['Space']);
      if (st.onGround || S.airT < react) { keys.add('KeyW'); return { keys, turn: Math.max(-3, Math.min(3, d)) * 0.5 }; }
      const side = d >= 0 ? 1 : -1;
      keys.add(side > 0 ? 'KeyA' : 'KeyD');
      const rate = Math.min(200, 60 + Math.abs(d) * 3) * (0.8 + 0.4 * rnd());
      return { keys, turn: side * rate * dt };
    }
    // Lauf-/Sprung-Stufen
    const keys = new Set(['KeyW']);
    let target = null;
    if (task?.zone && zones[task.zone]) target = center(zones[task.zone]);
    else if (task?.zones) target = center(zones[task.zones[0]]);
    let press = null;
    if (lessonId === 't1') {
      if (stageId === 'rutschen') {
        target = P(route[12]);
        const ok = mode === 2 ? st.speed > 290 : S.t > 0.6; // Neuling drückt C zu früh
        if (ok && !S.slid) { S.cT = 1.3; S.slid = true; }
        if (S.cT > 0) { S.cT -= dt; keys.add('KeyC'); if (S.cT <= 0 && mode === 1) S.slid = false, S.t = -1.5; }
      } else if (stageId === 'springen' || stageId === 'stufe') {
        const nj = nextJumpNode(st, (n) => n.jump);
        const lead = mode === 1 ? 30 + 60 * rnd() : 20;
        if (nj && nj.ahead < lead && st.onGround) { press = 'Space'; S.jumped.add(nj.i); }
      }
    } else if (lessonId === 't2') {
      keys.add('Space');
      if (stageId === 'halten' && !target) target = { x: 0, y: 0, z: st.pos.z - 1000 };
    } else if (lessonId === 't6') {
      if (stageId === 'stufe') {
        const nj = nextJumpNode(st, (n) => n.jump);
        if (nj && nj.ahead < 40 && st.onGround) { press = 'Space'; S.jumped.add(nj.i); }
      } else {
        // "Am grünen Band springen, dann in der Luft C" — Band = Absprungknoten, Neuling trifft es ±
        const nj = nextJumpNode(st, (n) => n.jump && n.crouch);
        if (S.lead === undefined) S.lead = mode === 1 ? 40 * (rnd() - 0.5) : 10 * rnd();
        if (nj && nj.ahead < S.lead && st.onGround && S.phase !== 'air') {
          press = 'Space'; S.jumped.add(nj.i); S.phase = 'wait'; S.cWait = mode === 1 ? 0.2 : 0.08; S.lead = undefined;
        }
        if (S.phase === 'wait') { S.cWait -= dt; if (S.cWait <= 0) S.phase = 'air'; }
        if (S.phase === 'air') { keys.add('KeyC'); if (st.onGround && S.groundT > 0.05) S.phase = null; }
        target = { x: 0, y: 0, z: st.pos.z - 600 };
      }
    }
    if (!target) target = { x: st.pos.x, y: 0, z: st.pos.z - 1000 };
    return { keys, turn: aim(st, target, 180, dt), press };
  };
}

/** Titel → Training → Lektion anklicken (echte Klicks). */
async function openFromList(id) {
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__vel.state().menu)) !== 'title'; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
  await page.getByRole('button', { name: /^Training\s*\d/ }).first().click();
  await page.waitForTimeout(500);
  const names = await page.evaluate(() => [...document.querySelectorAll('.vel-menu:not([hidden]) button')].map((b) => b.innerText.replace(/\s+/g, ' ')));
  const want = id.toUpperCase();
  const i = names.findIndex((n) => n.startsWith(want + ' '));
  if (i < 0) throw new Error(`Lektion ${id} nicht in der Liste: ${JSON.stringify(names)}`);
  await page.locator('.vel-menu:not([hidden]) button').nth(i).click();
  await page.waitForTimeout(500);
  if ((await page.evaluate(() => window.__vel.state().menu)) !== null) {
    await page.getByRole('button', { name: /Klicken zum Starten/i }).first().click();
  }
}

async function shot(name) { await page.screenshot({ path: `${OUT}/nb-${name}.png` }); }

async function watchDemo(lessonId, stageId, rec) {
  await tap('KeyH');
  const t0 = Date.now();
  let shotDone = false;
  let maxSpeed = 0, sawDemo = false, goal = false;
  const keysSeen = new Set();
  while (Date.now() - t0 < 40000) {
    const st = await poll();
    if (st.tr?.demo) sawDemo = true;
    maxSpeed = Math.max(maxSpeed, st.speed);
    if (st.tr?.demoGoal) goal = true;
    if (sawDemo && !shotDone && Date.now() - t0 > 2200) { await shot(`${lessonId}-${stageId}-demo`); shotDone = true; }
    if (sawDemo && !st.tr?.demo) break;
    if (!sawDemo && Date.now() - t0 > 2000) break;
    await page.waitForTimeout(50);
  }
  rec.demo = { shown: sawDemo, goal, seconds: (Date.now() - t0) / 1000, maxSpeed: Math.round(maxSpeed) };
}

async function playStage(lessonId, L, st0) {
  const stageId = st0.tr.id;
  const rec = { id: stageId, title: st0.tr.title, rank: st0.tr.rank, attempts: [], verdicts: {}, tips: [], notices: [], respawns: 0, done: false };
  await shot(`${lessonId}-${stageId}-card`);
  const startIdx = st0.tr.idx;
  let tipSerial = st0.tr.tipSerial;
  let lastNotice = null;
  for (const mode of [1, 2]) {
    const brain = makeBrain(lessonId, stageId, L, mode);
    const limit = mode === 1 ? ATTEMPT1 : ATTEMPT2;
    const t0 = Date.now();
    let last = Date.now();
    let firstVerdictShot = false;
    let maxSpeed = 0;
    while ((Date.now() - t0) / 1000 < limit) {
      const st = await poll();
      if (!st.tr) break;
      maxSpeed = Math.max(maxSpeed, st.speed);
      for (const e of st.ev) {
        if (e.type === 'lessonHop') rec.verdicts[e.verdict] = (rec.verdicts[e.verdict] ?? 0) + 1;
        if (e.type === 'respawn') rec.respawns++;
      }
      if (st.tr.tipSerial !== tipSerial) { tipSerial = st.tr.tipSerial; rec.tips.push({ t: +((Date.now() - t0) / 1000).toFixed(1), mode, kind: st.tr.tipKind, text: st.tr.tip }); }
      if (st.notice && st.notice !== lastNotice) { rec.notices.push(st.notice); }
      lastNotice = st.notice;
      if (st.verdict && !firstVerdictShot && mode === 1) { firstVerdictShot = true; await shot(`${lessonId}-${stageId}-verdict`); }
      if (st.tr.idx !== startIdx || st.tr.done && st.tr.rank !== 'required') {
        rec.done = true;
        rec.attempts.push({ mode, seconds: +((Date.now() - t0) / 1000).toFixed(1), ok: true, maxSpeed: Math.round(maxSpeed) });
        await releaseAll();
        return rec;
      }
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const out = brain(st, dt);
      await setKeys(out.keys);
      if (out.turn) await turn(out.turn);
      if (out.press) await tap(out.press, 60);
      await page.waitForTimeout(8);
    }
    await releaseAll();
    const stE = await poll();
    rec.attempts.push({ mode, seconds: limit, ok: false, maxSpeed: Math.round(maxSpeed), count: `${stE.tr?.count}/${stE.tr?.goal}` });
    if (mode === 1) {
      await shot(`${lessonId}-${stageId}-stuck`);
      await watchDemo(lessonId, stageId, rec);
    }
  }
  // überspringen wie ein Mensch: Esc → Pausenmenü → "Stufe überspringen"
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await shot(`${lessonId}-${stageId}-pause`);
  const btn = page.getByRole('button', { name: /Stufe überspringen/ });
  if (await btn.count()) { await btn.first().click(); rec.skipped = 'menu'; } else { await page.evaluate(() => window.__vel.trainingSkip()); rec.skipped = 'debug'; }
  await page.waitForTimeout(600);
  const st = await poll();
  if (!st.locked) { await page.mouse.click(960, 540); await page.waitForTimeout(400); }
  return rec;
}

async function playLesson(id) {
  const L = lessonJson(id);
  const lrec = { stages: [], started: Date.now() };
  report.lessons[id] = lrec;
  let st = await poll();
  for (let guard = 0; guard < 12; guard++) {
    st = await poll();
    if (!st.tr) break;
    if (st.tr.done || st.tr.rank !== 'required') break;
    const r = await playStage(id, L, st);
    lrec.stages.push(r);
    console.log(`${id} ${r.id}: ${r.done ? 'OK' : 'NICHT'} ${JSON.stringify(r.attempts)} verdicts=${JSON.stringify(r.verdicts)} tips=${r.tips.length} demo=${JSON.stringify(r.demo ?? null)}`);
    await page.waitForTimeout(900);
  }
  lrec.seconds = (Date.now() - lrec.started) / 1000;
  await releaseAll();
  await page.waitForTimeout(1300);
  await shot(`${id}-card-end`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  st = await poll();
  lrec.menuAfter = st.menu;
  lrec.stars = st.tr?.stars;
  await shot(`${id}-result`);
  lrec.resultText = await page.evaluate(() => document.querySelector('.vel-menu:not([hidden])')?.innerText?.slice(0, 600) ?? null);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false }));
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const ids = only.length ? only : ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (i === 0) {
      if (id === 't1') await page.getByRole('button', { name: /Training starten/i }).click();
      else await openFromList(id);
    } else {
      const next = page.getByRole('button', { name: /Nächste Lektion/ });
      const prev = ids[i - 1];
      const want = `t${Number(prev.slice(1)) + 1}`;
      if (want === id && (await next.count())) { await next.first().click(); }
      else { await page.keyboard.press('Escape'); await page.waitForTimeout(500); await openFromList(id); }
    }
    await page.waitForFunction((lid) => window.__vel.state().lesson === lid && window.__vel.state().gameState === 'playing', id, { timeout: 20000 });
    await page.waitForTimeout(2500); // Titel-Einblendung lesen
    const s = await poll();
    if (!s.locked) { await page.mouse.click(960, 540); await page.waitForTimeout(300); }
    await playLesson(id);
    writeFileSync(LOG, JSON.stringify({ ...report, errors }, null, 1));
  }
} catch (e) {
  console.error('ABBRUCH', e);
  report.crash = String(e?.stack ?? e);
} finally {
  report.errors = errors;
  writeFileSync(LOG, JSON.stringify(report, null, 1));
  await browser.close();
  await srv.close();
  console.log('Konsolenfehler:', errors.length, errors.slice(0, 5));
}
