/**
 * Trainingsmodus im echten Spiel (Plan 007, TU6) → shots/training/. Port TRAIN_PORT (Default 5348).
 *
 *   node tools/training-shots.mjs [lesson-id …]      alle Lektionen aus levels/training/index.json (oder nur diese)
 *   TRAIN_LESSONS=<dir> node tools/training-shots.mjs   Lektionen aus <dir>/training/ statt public/levels/training/
 *                                                       (Entwicklung: ein Scratch-Build von levels:build)
 *
 * Screenshots: title-newbie.png (Neulings-Band), list.png (Lektionsliste), <id>-hud.png (Lektionskarte),
 * <id>-demo.png (Vorführung), <id>-pause.png, <id>-done.png (Ergebnis), gate-closed/-dissolve/-open.png,
 * admin.png. Bericht: shots/training/report.json.
 *
 * Checks (Exit 1 bei Fehler):
 *  - jede Lektion lädt; keine Bestzeit, kein Ghost im localStorage
 *  - H startet die Vorführung (Bot bewegt sich, Session angehalten); eine Taste beendet sie: Spieler am
 *    Stufen-Spawn, Fortschritt unverändert
 *  - Lektions-HUD (Karte, Urteil, Coach-/Demo-Band) nie im mittleren Band (35–65 % der Höhe)
 *  - ein Bot schließt jede Stufe ab: die Vorführung der Stufe (zählend), ohne Vorführung ein Ersatz-Bot
 *    nach der Aufgabe (Rutschen, Prestrafe und Boden-Kurse skriptiert, sonst Routen-Bot bzw. Strafe-Bot,
 *    je sync 1) — der Bericht nennt je Stufe, welcher. Pflicht für Exit 0: jede Pflichtstufe und jede
 *    Stufe mit Vorführung; eine Bonus-/Meisterstufe OHNE Vorführung, die kein Ersatz-Bot schafft, ist
 *    ein WARN (Inhaltslücke, kein UI-Fehler). Das Ergebnis zeigt Sterne
 *  - Tor: geschlossen blockiert es (Laufen dagegen), offen nicht; Optik nach ≤ 0.45 s aufgelöst
 *  - Liste, Ergebnis und Pause bei 1920×1080 ohne Scrollen
 *  - Admin "Abhaken" aller Lektionen schaltet über deriveUnlocks Spinner und Roboter frei
 *  - Urteil am Gain-Popup im selben Frame wie die Landung (≤ 1 Frame); Frame-Callback der Lektion
 *    +< 0.05 ms = HUD-Mehrkosten (benchHud, Lektion gegen normales Level) + updateLesson + Session-Ticks
 *    je Frame
 *  - 0 Konsolenfehler
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.TRAIN_PORT ?? 5348);
const LESSON_DIR = process.env.TRAIN_LESSONS ?? null;
const OUT = 'shots/training';
const filter = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const fails = [];
const report = { port: PORT, lessonsFrom: LESSON_DIR ?? 'public/levels/training', lessons: {}, checks: [] };
const check = (ok, msg, data) => {
  if (!ok) fails.push(msg);
  report.checks.push({ ok, msg, ...(data !== undefined ? { data } : {}) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${data !== undefined ? `  ${JSON.stringify(data)}` : ''}`);
};
/** Hinweis ohne Exit 1: Lücke im Inhalt (z. B. Bonus-Stufe ohne Vorführung, die kein Ersatz-Bot schafft). */
const warn = (msg, data) => {
  report.checks.push({ ok: true, warn: true, msg, ...(data !== undefined ? { data } : {}) });
  console.log(`WARN ${msg}${data !== undefined ? `  ${JSON.stringify(data)}` : ''}`);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false }));
  });
  if (LESSON_DIR) {
    await ctx.route('**/levels/training/**', (route) => {
      const rel = new URL(route.request().url()).pathname.split('/levels/')[1];
      try {
        route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(`${LESSON_DIR}/${rel}`, 'utf8') });
      } catch {
        route.fulfill({ status: 404, body: 'not found' });
      }
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console: ${m.text()}`);
  });
  const V = (fn, arg) => page.evaluate(fn, arg);
  const tr = () => V(() => window.__vel.training());
  const menu = () => V(() => window.__vel.state().menu);
  /** Scrollt der sichtbare Menü-Screen? (1080p-Abnahme) */
  const scrolls = () => V(() => {
    const s = document.querySelector('.vel-menu:not([hidden]) .vel-screen');
    return s ? s.scrollHeight - s.clientHeight : -1;
  });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const layoutOk = async (name) => {
    const L = await V(() => window.__vel.hudLayout());
    const [top, bottom] = L.centerBand;
    const bad = [];
    for (const k of ['card', 'verdict', 'notice', 'demo']) {
      const [, y, w, h] = L.rects[k];
      if (w > 0 && y < bottom && y + h > top) bad.push(`${k} ${y}..${y + h}`);
    }
    check(bad.length === 0, `${name}: Lektions-HUD frei vom mittleren Band ${top}..${bottom}`, { rects: L.rects, bad });
    return L;
  };

  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__vel.lessons().length > 0, null, { timeout: 30000 }).catch(() => undefined);
  const all = await V(() => window.__vel.lessons());
  check(all.length > 0, `Lektionsliste geladen (${all.length})`, all.map((l) => l.id));
  if (all.length === 0) throw new Error('keine Lektionen — TRAIN_LESSONS setzen oder levels:build -- training');

  // --- Titel: Neuling
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/title-newbie.png` });
  check(await page.locator('.vel-newbie').isVisible(), 'Titel: Neulings-Band sichtbar (keine Bestzeit, kein Training)');
  check(await page.locator('.vel-training-btn').isVisible(), 'Titel: Knopf TRAINING');

  // --- Lektionsliste
  await page.locator('.vel-training-btn').click();
  await page.waitForSelector('.vel-training-screen');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/list.png` });
  check((await scrolls()) <= 1, 'Liste bei 1920×1080 ohne Scrollen', { overflow: await scrolls() });
  check((await page.locator('.vel-lesson').count()) === all.length, 'Liste zeigt jede Lektion');
  check((await page.locator('.vel-lesson-rec').count()) === 1, 'genau eine Lektion EMPFOHLEN');

  const ids = filter.length ? all.map((l) => l.id).filter((id) => filter.includes(id)) : all.map((l) => l.id);
  let gateTested = false;
  for (const id of ids) {
    const rep = (report.lessons[id] = {});
    const ok = await V((lid) => window.__vel.start(lid, { lockless: true }), id);
    await page.waitForFunction((lid) => window.__vel.state().lesson === lid, id, { timeout: 15000 }).catch(() => undefined);
    const t0 = await tr();
    check(ok && t0 !== null && t0.lessonId === id, `${id}: Lektion lädt`, t0 ? { stages: t0.stageTotal, gates: t0.gates.length } : null);
    if (!t0) continue;
    await page.waitForTimeout(2600); // Titelkarte
    await page.screenshot({ path: `${OUT}/${id}-hud.png` });
    await layoutOk(`${id} Karte`);
    const store = await V((lid) => ({ best: localStorage.getItem('velocity.best.v1'), ghost: localStorage.getItem(`velocity.ghost.v1.${lid}`) }), id);
    check(!store.best?.includes(`"${id}"`) && store.ghost === null, `${id}: keine Bestzeit, kein Ghost`, store);

    // --- Vorführung per H, beendet per Taste
    if (t0.hasDemo) {
      const before = await tr();
      const spawn = before.spawn;
      await page.keyboard.press('KeyH');
      await page.waitForTimeout(1800);
      const during = await tr();
      const posD = await V(() => window.__vel.state().pos);
      check(during.demo && during.suspended && dist(posD, spawn) > 30, `${id}: H startet die Vorführung (Bot fährt, Session angehalten)`, { moved: Math.round(dist(posD, spawn)) });
      await page.screenshot({ path: `${OUT}/${id}-demo.png` });
      await layoutOk(`${id} Vorführung`);
      await page.keyboard.press('KeyW');
      await page.waitForTimeout(250);
      const after = await tr();
      const posA = await V(() => window.__vel.state().pos);
      check(
        !after.demo && dist(posA, spawn) < 2 && after.count === before.count && after.stageIndex === before.stageIndex && after.completed.length === before.completed.length,
        `${id}: Taste beendet die Vorführung — Spieler am Stufen-Spawn, Fortschritt unverändert`,
        { atSpawn: Math.round(dist(posA, spawn) * 100) / 100, count: [before.count, after.count], stage: [before.stageIndex, after.stageIndex] },
      );
    }

    // --- Pause einer Lektion
    await V(() => window.__vel.pause());
    await page.waitForSelector('.vel-lesson-pause');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${id}-pause.png` });
    check((await scrolls()) <= 1 && (await page.getByRole('button', { name: /Stufe neu/ }).count()) === 1, `${id}: Pause (Lektion) ohne Scrollen, mit "Stufe neu"`);
    await V(() => window.__vel.resume());
    await page.waitForTimeout(200);

    // --- Tor: Kollision und Optik (einmal, erste Lektion mit Tor)
    if (!gateTested && t0.gates.length > 0) {
      gateTested = true;
      report.gate = await gateTest(page, id, t0, check);
      await V(() => window.__vel.trainingReset());
      await page.waitForTimeout(300);
    }

    // --- Bot spielt die Lektion (Vorführung zählt): jede Stufe
    const stages = [];
    // Erledigte Stufen seit der letzten Aktion zuordnen: die Vorführung spielt nach einer Stufe gleich die
    // nächste an (Game, demoPlays) — so geht auch eine Anschluss-Stufe nicht im Bericht verloren.
    const attributed = new Set();
    const attribute = async (how, extra) => {
      const x = await tr();
      for (const sid of x?.completed ?? []) {
        if (attributed.has(sid)) continue;
        attributed.add(sid);
        const def = x.stages.find((st) => st.id === sid);
        stages.push({ stage: sid, rank: def?.rank ?? '?', how, ...extra, noDemo: def ? !def.hasDemo : undefined });
      }
    };
    for (let guard = 0; guard < 40; guard++) {
      const t = await tr();
      if (!t || t.stageIndex >= t.stageTotal || t.result) break;
      const si = t.stageIndex;
      let done = false;
      const tried = [];
      if (t.hasDemo) {
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          await V(() => window.__vel.demo({ on: true, play: true }));
          await page
            .waitForFunction((s0) => {
              const x = window.__vel.training();
              return !x || x.stageIndex !== s0 || !x.demo || x.result !== null;
            }, si, { timeout: 45000, polling: 100 })
            .catch(() => undefined);
          const tt = await tr();
          // Geschafft = die Stufe ist weiter; ein Ergebnis allein (Portal) ist KEIN Erfolg dieser Stufe.
          done = tt !== null && tt.stageIndex !== si;
          tried.push('Vorführung');
          if (done) await attribute('Vorführung', { attempts: attempt + 1 });
        }
        if (!done) await V(() => window.__vel.demo({ on: false }));
      }
      if (!done) {
        // Ersatz-Bot nach der Aufgabe, vom Stufen-Spawn aus (Stufen ohne eigene Vorführung).
        for (const fb of fallbacks(t)) {
          tried.push(fb);
          done = await runFallback(page, fb, si);
          if (done) {
            await attribute(`Ersatz-Bot ${fb}`, { noDemo: !t.hasDemo });
            break;
          }
        }
      }
      if (!done) {
        stages.push({ stage: t.stageId, rank: t.rank, how: 'Bot scheitert', tried, noDemo: !t.hasDemo });
        await V(() => window.__vel.trainingSkip());
        await page.waitForTimeout(200);
      }
    }
    rep.stages = stages;
    const required = await V(() => {
      const x = window.__vel.training();
      return x ? x.done : null;
    });
    // Nicht versuchte Stufen (Ergebnis kam vorher, z. B. durchs Portal) zählen wie gescheiterte.
    const last = await tr();
    for (const st of last?.stages ?? []) {
      if (!stages.some((s) => s.stage === st.id)) stages.push({ stage: st.id, rank: st.rank, how: 'nicht versucht', noDemo: !st.hasDemo });
    }
    const failed = stages.filter((s) => s.how === 'Bot scheitert' || s.how === 'nicht versucht');
    const noDemo = stages.filter((s) => s.noDemo).map((s) => `${s.stage}(${s.rank})`);
    // Pflicht: jede Pflichtstufe und jede Stufe MIT Vorführung schafft ein Bot (sonst UI-/Vorführungsfehler).
    // Bonus/Meister ohne Vorführung, die kein Ersatz-Bot schafft, sind eine Inhaltslücke → Hinweis.
    const hard = failed.filter((s) => s.rank === 'required' || !s.noDemo);
    const soft = failed.filter((s) => !hard.includes(s));
    check(hard.length === 0, `${id}: Bot schließt jede Pflichtstufe und jede Stufe mit Vorführung ab${noDemo.length ? ` — ohne Vorführung: ${noDemo.join(', ')}` : ''}`, stages);
    if (soft.length > 0) warn(`${id}: kein Bot schafft ${soft.map((s) => `${s.stage}(${s.rank})`).join(', ')} — Stufe ohne Vorführung`);
    // Ergebnis: automatisch nach der letzten Stufe.
    await page.waitForFunction(() => window.__vel.state().menu === 'lessonDone', null, { timeout: 8000 }).catch(() => undefined);
    const res = await tr();
    const stars = await page.locator('.vel-lesson-stars').textContent().catch(() => null);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${id}-done.png` });
    rep.result = res?.result ?? null;
    check((await menu()) === 'lessonDone' && res?.result !== null && typeof stars === 'string' && stars.includes('★'), `${id}: Ergebnis mit Sternen`, { stars, sessionStars: res?.result?.stars, done: required });
    check((await scrolls()) <= 1, `${id}: Ergebnis ohne Scrollen`, { overflow: await scrolls() });
    const saved = (await V(() => window.__vel.lessons())).find((l) => l.id === id);
    check((saved?.stars ?? 0) >= 1, `${id}: Sterne gespeichert`, { saved: saved?.stars });
    const store2 = await V((lid) => ({ best: localStorage.getItem('velocity.best.v1'), ghost: localStorage.getItem(`velocity.ghost.v1.${lid}`) }), id);
    check(!store2.best?.includes(`"${id}"`) && store2.ghost === null, `${id}: nach der Lektion keine Bestzeit/kein Ghost`, store2);
  }

  // --- Messungen in der ersten Lektion: Urteil-Verzug und Frame-Kosten
  report.measure = await measure(page, ids[0], check);

  // --- Übersicht nach den Lektionen
  await V(() => window.__vel.toTitle());
  await page.waitForTimeout(300);
  check((await menu()) === 'training', 'aus einer Lektion zurück → Lektionsliste');
  await page.screenshot({ path: `${OUT}/list-after.png` });

  // --- Admin: Lektion abhaken → Spinner/Roboter über die Ableitung
  await V(() => {
    localStorage.removeItem('velocity.training.v1');
    window.__vel.resetUnlocks();
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.waitForFunction(() => window.__vel.lessons().length > 0 && window.__vel.lessons().every((l) => l.loaded), null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForSelector('.vel-level');
  await page.keyboard.press('F8');
  await page.waitForSelector('.vel-admin-screen');
  const before = await V(() => window.__vel.unlocks());
  const rows = page.locator('.vel-admin-lesson');
  const n = await rows.count();
  for (let i = 0; i < n; i++) await rows.nth(i).getByRole('button', { name: 'Abhaken' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/admin.png` });
  const after = await V(() => window.__vel.unlocks());
  const lessons = await V(() => window.__vel.lessons());
  check(n === lessons.length && lessons.every((l) => l.stars === 3), 'Admin: jede Lektion abgehakt (★★★)', lessons.map((l) => `${l.id}:${l.stars}`));
  check(!before.includes('item.spinner') && after.includes('item.spinner') && after.includes('glove.robot'), 'Admin "Lektion abhaken" → Spinner und Roboter frei (deriveUnlocks)', { before, after });
} catch (err) {
  fails.push(`Abbruch: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  await browser.close();
  await srv.close();
}

report.errors = errors;
report.fails = fails;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
if (errors.length) console.log(`Konsolenfehler (${errors.length}):\n  ${errors.slice(0, 10).join('\n  ')}`);
else console.log('Konsole sauber.');
console.log(`${report.checks.filter((c) => c.ok).length}/${report.checks.length} Checks ok, ${errors.length} Konsolenfehler → ${OUT}/report.json`);
process.exit(fails.length || errors.length ? 1 : 0);

/**
 * Urteil-Verzug: in jedem Frame (nach dem Spiel-Frame) prüfen, ob ein neues 'lessonHop' da ist und das
 * HUD sein Urteil schon zeigt — 0 = im selben Frame wie die Landung (Judge urteilt im Lande-Tick).
 * Frame-Kosten: CPU-Zeit des Frame-Callbacks, Lektions-Frame-Arbeit an/aus in abwechselnden Blöcken
 * (im Stand mit Karte und während der Vorführung mit Urteilen, Zielband, Demo-Band).
 */
async function measure(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V((lid) => window.__vel.start(lid, { lockless: true }), id);
  await page.waitForTimeout(2600);
  // Frame-Arbeit der Lektion im Spiel (updateLesson: Tore, Vorführung, Tipps, Fortschritt) und der
  // Anteil am ganzen Frame-Callback, je 3 s.
  const frameCost = async () => {
    await V(() => window.__vel.frameCost());
    await page.waitForTimeout(3000);
    return V(() => window.__vel.frameCost());
  };
  const idle = await frameCost();
  // Vorführung: der Bot hüpft, Urteile und Zielband laufen. Dabei zuerst der Urteil-Verzug.
  await V(() => window.__vel.demo({ on: true }));
  await page.waitForTimeout(300);
  const lat = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const hopT = () => {
          const ev = vel.events(40).filter((e) => e.type === 'lessonHop');
          return ev.length ? ev[ev.length - 1].t : -1;
        };
        let last = hopT();
        const out = [];
        let frames = 0;
        const loop = () => {
          frames++;
          const t = hopT();
          if (t > last) {
            last = t;
            out.push(vel.hudLayout().verdict !== null ? 0 : 1);
          }
          if (frames < 360) requestAnimationFrame(loop);
          else resolve(out);
        };
        requestAnimationFrame(() => requestAnimationFrame(loop));
      }),
  );
  const demo = await frameCost();
  await V(() => window.__vel.demo({ on: false }));
  check(lat.length > 0 && lat.every((x) => x === 0), `${id}: Urteil erscheint im selben Frame wie die Landung (${lat.length} Hops)`, { framesLate: lat });
  // HUD: Lektion (Karte, Urteile, Zielband, Demo-Band) gegen normales Level (Timer, Gain-Popups) — dreimal.
  const huds = [];
  for (let k = 0; k < 3; k++) huds.push(await V(() => window.__vel.benchHud(3000)));
  const med = (key) => huds.map((h) => h[key]).sort((a, b) => a - b)[1];
  const hud = { normal: med('normal'), lesson: med('lesson'), lessonDemo: med('lessonDemo') };
  const r4 = (x) => Math.round(x * 10000) / 10000;
  // HUD-Mehrkosten nach unten bei 0 gekappt (ist die Lektion billiger, zählt das nicht als Gewinn).
  const hudAdded = Math.max(0, Math.max(hud.lesson, hud.lessonDemo) - hud.normal);
  const added = hudAdded + Math.max(idle.lessonMs, demo.lessonMs) + Math.max(idle.lessonTickMs, demo.lessonTickMs);
  check(added < 0.05, `${id}: Frame-Callback der Lektion +< 0.05 ms (HUD-Mehrkosten + updateLesson + Session-Ticks)`, {
    hudMs: { normal: r4(hud.normal), lesson: r4(hud.lesson), lessonDemo: r4(hud.lessonDemo) },
    updateLessonMs: { idle: r4(idle.lessonMs), demo: r4(demo.lessonMs) },
    sessionTicksMs: { idle: r4(idle.lessonTickMs), demo: r4(demo.lessonTickMs) },
    frameMs: { idle: r4(idle.ms), demo: r4(demo.ms) },
    addedMs: r4(added),
  });
  return { idle, demo, hud, huds, verdictFramesLate: lat };
}

/**
 * Tor 0 der Lektion: geschlossen gegen die Wand laufen (blockiert), dann per Stufen-Überspringen öffnen
 * (die Session öffnet die Tore der Stufe) — Optik muss nach ≤ 0.45 s aufgelöst sein, Laufen geht durch.
 */
async function gateTest(page, id, t0, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  // Das letzte Tor, durch das man aufrecht passt (Duck-Tunnel-Tore nicht): es geht erst spät auf — der
  // Anlauf dagegen erledigt keine frühe Stufe (Tor 0 von T1 öffnete sonst schon beim Dagegenlaufen).
  let gi = t0.gates.length - 1;
  while (gi > 0 && t0.gates[gi].max.y - t0.gates[gi].min.y < 80) gi--;
  const g = t0.gates[gi];
  const thinZ = g.max.z - g.min.z < g.max.x - g.min.x;
  const cx = (g.min.x + g.max.x) / 2;
  const cz = (g.min.z + g.max.z) / 2;
  // Von der Seite des Spawns aus anlaufen: 160 u vor der Wand, Blick zur Wand.
  const sp = t0.spawn;
  const side = thinZ ? Math.sign(sp.z - cz) || -1 : Math.sign(sp.x - cx) || -1;
  const start = thinZ ? { x: cx, y: g.min.y, z: cz + side * 160 } : { x: cx + side * 160, y: g.min.y, z: cz };
  // yaw 0 = −Z; Blick zur Wand: thinZ und side > 0 (Spieler bei +z) → −Z = 0°, sonst 180°.
  const yaw = thinZ ? (side > 0 ? 0 : 180) : side > 0 ? 90 : -90;
  const walk = async () => {
    await V(() => window.__vel.freeze(true));
    await V(({ s, yaw }) => window.__vel.teleport(s.x, s.y, s.z, yaw), { s: start, yaw });
    await V(() => window.__vel.setInputOverride(() => ({ forward: 1, sprint: true })));
    // 1.25 s Sprint (≈ 400 u): durch ein offenes Tor, aber nicht bis zum Portal dahinter.
    await V(() => window.__vel.stepTicks(160));
    const p = await V(() => window.__vel.state().pos);
    await V(() => window.__vel.setInputOverride(null));
    await V(() => window.__vel.freeze(false));
    // Durch = die Wandmitte in Laufrichtung überquert.
    return thinZ ? (p.z - cz) * side < 0 : (p.x - cx) * side < 0;
  };
  const through0 = await walk();
  const t1 = await V(() => window.__vel.training());
  check(!through0 && t1.gateBlocked[gi], `${id}: geschlossenes Tor blockiert (dagegen gelaufen)`, { gate: g.id });
  // Blick aufs Tor aus 300 u für die Bilder.
  const view = thinZ ? { x: cx, y: g.min.y, z: cz + side * 300 } : { x: cx + side * 300, y: g.min.y, z: cz };
  await V(({ s, yaw }) => window.__vel.teleport(s.x, s.y, s.z, yaw), { s: view, yaw });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/gate-closed.png` });
  // Überspringen bis das Tor offen ist (die Stufe, die es öffnet), zurück vors Tor (Überspringen setzt an
  // den Start der nächsten Stufe), dann Bild mitten im Auflösen und Zeit bis gateOpen = 1.
  const skips = await V(({ s, yaw, gi }) => {
    const vel = window.__vel;
    let n = 0;
    while (vel.training().gateBlocked[gi] && n < 12) {
      vel.trainingSkip();
      n++;
    }
    vel.teleport(s.x, s.y, s.z, yaw);
    window.__gateT0 = performance.now();
    return n;
  }, { s: view, yaw, gi });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/gate-dissolve.png` });
  const timing = await V(async ({ n, gi }) => {
    const vel = window.__vel;
    return await new Promise((resolve) => {
      const loop = () => {
        const x = vel.training();
        const dt = performance.now() - window.__gateT0;
        if (x.gateOpen[gi] >= 1 || dt > 2000) resolve({ skips: n, ms: Math.round(dt), open: x.gateOpen[gi], blocked: x.gateBlocked[gi] });
        else requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }, { n: skips, gi });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/gate-open.png` });
  check(!timing.blocked && timing.open >= 1 && timing.ms <= 450, `${id}: Tor öffnet — Kollision weg, Optik nach ≤ 0.45 s aufgelöst`, timing);
  const through1 = await walk();
  check(through1, `${id}: offenes Tor — man läuft hindurch`);
  return timing;
}

/**
 * Ersatz-Bots für eine Stufe ohne eigene Vorführung, nach Aufgabe: Rutschen (Sprint, dann C) und
 * Prestrafe (W + A, Maus 200 °/s links, wie drivers.ts prestrafeRate) und Boden-Kurse (Sprint auf die
 * Zonen der Reihe nach zu, ab 100 u vor der ersten Zone C = Rutschen) skriptiert, sonst der Routen-Bot
 * (sync 1, ohne Neustart) und der Strafe-Bot (sync 1).
 */
function fallbacks(t) {
  const k = t.task?.kind;
  const list = [];
  if (k === 'event' && t.task.event === 'slideStart') list.push('rutschen');
  if (k === 'speed' && t.task.ground) list.push('prestrafe');
  if (k === 'course' && !t.task.airborne) list.push('kurs');
  list.push('route', 'strafe');
  return list;
}

/** Ersatz-Bot vom Stufen-Spawn aus fahren lassen, bis die Stufe wechselt (true) oder 40 s um sind. */
async function runFallback(page, kind, si) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  const ok = await V(({ kind }) => {
    const vel = window.__vel;
    const x = vel.training();
    if (!x) return false;
    const sp = x.spawn;
    vel.teleport(sp.x, sp.y, sp.z, sp.yaw);
    const yaw0 = (sp.yaw * Math.PI) / 180;
    const dt = 1 / vel.state().tickRate;
    if (kind === 'rutschen') {
      // 1 s Sprint geradeaus (≥ 280 u/s), dann C halten; nach 1.2 s loslassen und von vorn.
      let t = 0;
      vel.setInputOverride(() => {
        t += dt;
        const c = t % 2.5;
        return { forward: 1, sprint: true, crouch: c > 1 && c < 2.2, yaw: yaw0 };
      });
      return true;
    }
    if (kind === 'prestrafe') {
      let t = 0;
      let yaw = yaw0;
      vel.setInputOverride(() => {
        t += dt;
        if (t > 0.5) yaw += ((200 * Math.PI) / 180) * dt;
        return { forward: 1, sprint: true, side: t > 0.5 ? -1 : 0, yaw };
      });
      return true;
    }
    if (kind === 'kurs') {
      const zs = x.task.zones.map((id) => x.zones.find((z) => z.id === id)).filter((z) => z !== undefined);
      if (zs.length === 0) return false;
      const mid = zs.map((z) => ({ x: (z.min.x + z.max.x) / 2, z: (z.min.z + z.max.z) / 2 }));
      let k = 0;
      let slide = false;
      let finished = false;
      vel.setInputOverride((st) => {
        // Nächste Zone, sobald die Hull die aktuelle berührt (32 breit); nach der letzten stehen bleiben
        // (sonst rollt der Bot ins Portal und beendet die Lektion vor der nächsten Stufe).
        const z = zs[k];
        const inZone = st.pos.x + 16 > z.min.x && st.pos.x - 16 < z.max.x && st.pos.z + 16 > z.min.z && st.pos.z - 16 < z.max.z;
        if (inZone && k < zs.length - 1) k++;
        else if (inZone) finished = true;
        if (finished) return {};
        const m = mid[k];
        const dx = m.x - st.pos.x;
        const dz = m.z - st.pos.z;
        // C erst kurz vor der ersten Zone (Abstand zur Box ≤ 100 u): früher gerutscht ist das Tempo im Tunnel weg.
        const z0 = zs[0];
        const ex = Math.max(z0.min.x - st.pos.x, 0, st.pos.x - z0.max.x);
        const ez = Math.max(z0.min.z - st.pos.z, 0, st.pos.z - z0.max.z);
        // Liegt die Zone tief unter einem (Rinne am Hang), gleich oben rutschen — der Hang gibt das Tempo.
        const below = z0.max.y < st.pos.y - 64;
        if (!slide && (Math.hypot(ex, ez) < 100 || below) && st.speed > 290) slide = true;
        return { forward: 1, sprint: true, crouch: slide, yaw: Math.atan2(-dx, -dz) };
      });
      return true;
    }
    if (kind === 'route') {
      const li = vel.levelInfo();
      if (!li || li.route.length === 0) return false;
      vel.useBot('route', { sync: 1, restart: false });
      return true;
    }
    vel.useBot('strafe', { sync: 1 });
    return true;
  }, { kind });
  if (!ok) return false;
  await page
    .waitForFunction((s0) => {
      const x = window.__vel.training();
      return !x || x.stageIndex !== s0 || x.result !== null;
    }, si, { timeout: 40000, polling: 100 })
    .catch(() => undefined);
  const t = await V(() => window.__vel.training());
  await V(() => {
    window.__vel.useBot(null);
    window.__vel.setInputOverride(null);
  });
  // Nur Fortschritt dieser Stufe zählt — ein Ergebnis durchs Portal (Bot rollte weiter) nicht.
  return t !== null && t.stageIndex !== si;
}
