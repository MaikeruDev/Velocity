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
 *  - Lektions-HUD (Karte, Urteil, Coach-/Demo-Band) nie im mittleren Band (35–65 % der Höhe): je Lektion Karte
 *    und Vorführung; in der ersten Lektion mit Urteil zusätzlich ERZWUNGEN (W + A ohne Maus, bis Urteil und
 *    Urteils-Tipp im selben Frame gezeichnet sind — beide mit w > 0) bei 216, 270 und 360 Zeilen, dort auch das
 *    Demo-Band
 *  - Stufenwechsel (T3, W + A + Maus 60 °/s): im ersten Frame der neuen Stufe steht kein Coach-Text der alten,
 *    die Karte zeigt "GESCHAFFT!" mit der VOLLEN Pip-Reihe der erledigten Stufe, der Luft-Tipp der neuen Stufe kommt
 *    nach ≤ 2 s; die Legende am Drehbalken ("MAUS-TEMPO / IM FLUG IM GRÜNEN HALTEN") steht bis zum ersten guten Hop.
 *    Fallen Tipp und Wechsel in denselben Frame (alle Ticks per stepTicks in einem Aufruf), erscheint der Tipp nicht
 *  - Lektion neu + Überspringen direkt nach einer erledigten Stufe verwerfen deren Geschafft-Blitz; in der ersten
 *    Bonus-/Meisterstufe mit Vorführung zeigt die Karte "[ENTER] ERGEBNIS" UND "[H] ZEIGEN"
 *  - W-Showkey: in der Lektion (Strafe-Assist erzwungen) nie rot, auch mit Spieler-Config ohne Assist; Gegenprobe
 *    in L1 ohne Assist blinkt rot (hudLayout().wRed)
 *  - L1 mit W + Leertaste ohne Strafen: Coach-Anstoß "SCHNELLER? … TRAINING T3" nach ≤ 10 s, kein Fehler-Hinweis
 *  - Titel: "Empfohlen: T7/T8" an jedem Level mit Vor-Lektionen (LevelIndexEntry.prepLessons)
 *  - 1280×720 und 1366×768: Titel mit Neulings-Band (Start-Knopf im Bild), Liste, Lektions-Pause (auch mit Ergebnis-
 *    Knopf) ohne Scrollen, Karte ganz im Bild; 1280×720 das größte Ergebnis (T1, 6 Stufen, Spinner + Roboter)
 *  - ein Bot schließt jede Stufe ab: die Vorführung der Stufe (zählend), ohne Vorführung ein Ersatz-Bot
 *    nach der Aufgabe (Rutschen, Prestrafe und Boden-Kurse skriptiert, sonst Routen-Bot bzw. Strafe-Bot,
 *    je sync 1) — der Bericht nennt je Stufe, welcher. Pflicht für Exit 0: jede Pflichtstufe und jede
 *    Stufe mit Vorführung; eine Bonus-/Meisterstufe OHNE Vorführung, die kein Ersatz-Bot schafft, ist
 *    ein WARN (Inhaltslücke, kein UI-Fehler). Das Ergebnis zeigt Sterne
 *  - Tor: geschlossen blockiert es (Laufen dagegen), offen nicht; Optik nach ≤ 0.45 s aufgelöst; mehrfaches
 *    Überspringen ohne Tick dazwischen schickt kein 'lessonStage' auf den Bus (kein "GESCHAFFT!")
 *  - Neuling befolgt die Anweisung (W + Leertaste, 3 s) in einer Lektion ohne Strafe-Aufgabe: kein Urteil
 *    am Gain-Popup, kein Urteils-Tipp im Coach-Band. In einer Stufe MIT Urteil ohne Anlauf (Leertaste, A nur
 *    in der Luft, kein W, keine Maus): Rückmeldung am Gain-Popup oder als Urteils-/Vorführungs-Tipp ≤ 5 s
 *  - Zuschauen (H) bei jeder Stufe mit Vorführung: < 10 % der Frames steht der Bot an einem geschlossenen
 *    Tor; erfüllt die Vorführung die Aufgabe, endet sie ("SO GEHT'S!") — sonst WARN (Inhalt)
 *  - Liste, Ergebnis und Pause bei 1920×1080 ohne Scrollen
 *  - Admin: Sterne je Lektion setzen (★ … ★★★, auch senken); ★★★ aller Lektionen schaltet über deriveUnlocks
 *    Spinner und Roboter frei. Ein echter Durchlauf nennt den Spinner im Ergebnis von T4 und die Roboter-Hand
 *    in dem von T8 (Plan 007 Phase 3: keine zurückgehaltenen Freischaltungen mehr)
 *  - Urteil am Gain-Popup ≤ 1 Frame nach der Landung (HUD-Zähler verdictSerial/verdictDrawn, Vorführung in
 *    einer Lektion mit Urteil, ≥ 10 Hops); Frame-Callback der Lektion +< 0.05 ms (Wert + Streuung) =
 *    HUD-Mehrkosten (Median aus 9 × benchHud, ± halber Quartilsabstand) + updateLesson + Session-Ticks
 *    (Echtzeit-Median aus 5 Fenstern à 2 s, im Stand und beim Zuschauen; mindestens die Mikro-Messung
 *    benchLesson mit 2·10⁴ Aufrufen am Stück — performance.now() je Frame ist auf ~0.1 ms vergröbert)
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
/** TRAIN_LESSONS: Lektionen aus <dir>/training/ statt public/levels/training/ ausliefern. */
async function routeLessons(ctx) {
  await ctx.route('**/levels/training/**', (route) => {
    const rel = new URL(route.request().url()).pathname.split('/levels/')[1];
    try {
      route.fulfill({ status: 200, contentType: 'application/json', body: readFileSync(`${LESSON_DIR}/${rel}`, 'utf8') });
    } catch {
      route.fulfill({ status: 404, body: 'not found' });
    }
  });
}
/** Lektions-JSON wie der Browser sie lädt (Stufen-Tipps für die Erwartung eines Checks), null = nicht lesbar. */
function lessonJson(id) {
  try {
    return JSON.parse(readFileSync(`${LESSON_DIR ?? 'public/levels'}/training/${id}.json`, 'utf8'));
  } catch {
    return null;
  }
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false }));
  });
  if (LESSON_DIR) await routeLessons(ctx);
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
  const layoutOk = async (name, given, need = []) => {
    const L = given ?? (await V(() => window.__vel.hudLayout()));
    const [top, bottom] = L.centerBand;
    const bad = [];
    for (const k of ['card', 'verdict', 'notice', 'demo']) {
      const [, y, w, h] = L.rects[k];
      if (w > 0 && y < bottom && y + h > top) bad.push(`${k} ${y}..${y + h}`);
    }
    // Ein nicht gezeichnetes Element ist "frei" — wo es gemessen werden soll, muss es da sein (w > 0).
    const missing = need.filter((k) => !(L.rects[k][2] > 0));
    check(bad.length === 0 && missing.length === 0, `${name}: Lektions-HUD frei vom mittleren Band ${top}..${bottom}${need.length ? ` (gemessen: ${need.join(', ')})` : ''}`, { lines: L.height, rects: L.rects, bad, missing });
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
  // "Empfohlen: T7/T8" (LevelIndexEntry.prepLessons) je Level mit Vor-Lektionen — ohne Trainingsfortschritt alle offen.
  const prepWant = JSON.parse(readFileSync('public/levels/index.json', 'utf8')).filter((l) => (l.prepLessons ?? []).length > 0).length;
  const prepShown = await page.locator('.vel-level-prep').allTextContents();
  check(prepShown.length === prepWant && prepShown.every((t) => t.startsWith('Empfohlen: T')), `Titel: "Empfohlen: …" an jedem Level mit Vor-Lektionen (${prepWant})`, prepShown);

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
      // Nicht zu lange warten: eine Vorführung endet 1 s nach dem Stufenziel (T5 ANLAUF: 380 u/s nach ~0.6 s).
      await page.waitForTimeout(900);
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

    // --- Nachlauf (Lektion neu, Fortschritt ist gespeichert): Neuling nach Anweisung, dann Zuschauen je Stufe.
    rep.newbie = await newbieCheck(page, id, check);
    rep.watch = await watchDemos(page, id, check, warn);
  }

  // --- Freischaltung durch echtes Spielen: der Grundlagen-Abschluss nennt den Fidget-Spinner im Ergebnis.
  // Plan 007 Phase 3: PENDING_UNLOCKS ist weg — die Ableitung vergibt Spinner (T1–T4) und Roboter (T1–T8) wirklich.
  const spinnerIn = Object.entries(report.lessons).filter(([, r]) => (r.result?.unlocked ?? []).some((n) => /spinner/i.test(n)));
  const robotIn = Object.entries(report.lessons).filter(([, r]) => (r.result?.unlocked ?? []).some((n) => /roboter/i.test(n)));
  if (filter.length > 0) console.log('(Freischalt-Check nur ohne Lektions-Filter)');
  else {
    check(spinnerIn.length === 1 && spinnerIn[0][0] === 't4', 'Grundlagen bestanden → Fidget-Spinner im Ergebnis von T4 (deriveUnlocks, echter Durchlauf)', { lessons: spinnerIn.map(([k]) => k) });
    check(robotIn.length === 1 && robotIn[0][0] === 't8', 'alles bestanden → Roboter-Hand im Ergebnis von T8 (deriveUnlocks, echter Durchlauf)', { lessons: robotIn.map(([k]) => k) });
  }

  // --- Lektion mit Urteil (T3 AIR-STRAFE): Layout erzwungen in drei Auflösungen, Stufenwechsel
  const judgeId = ids.includes('t3') ? 't3' : null;
  // --- Normales Level: Coach-Anstoß für W-Hüpfer mit Verweis aufs Training. Zuerst: ein guter Hop in einem normalen
  // Level (W-Tasten-Gegenprobe unten) gilt für die ganze Sitzung als "Strafen gelernt".
  report.coachNoStrafe = await coachNoStrafe(page, check);
  if (judgeId !== null) {
    report.layoutForced = await layoutForced(page, judgeId, layoutOk, check);
    report.stageSwitch = await stageSwitch(page, judgeId, check);
    report.bonusHint = await bonusHint(page, judgeId, check);
    // Nach bonusHint: dessen Check braucht den Geschafft-Blitz, den stageSwitch hinterlässt.
    report.staleTip = await staleTip(page, judgeId, check);
    report.wKey = await wKeyInLesson(page, judgeId, check);
  } else console.log('(Layout erzwungen / Stufenwechsel / W-Taste / Bonus-Hinweis nur mit t3)');

  // --- Messungen in einer Lektion mit Urteil (T3 AIR-STRAFE): Urteil-Verzug und Frame-Kosten
  report.measure = await measure(page, ids.includes('t3') ? 't3' : ids[0], check, warn);

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
  // Sterne je Lektion (Admin kann alles): T1 auf ★, dann jede Lektion ★★★ (= abhaken), eine wieder auf 0.
  await rows.nth(0).locator('[data-stars="1"]').click();
  await page.waitForTimeout(150);
  const one = (await V(() => window.__vel.lessons()))[0];
  check(one?.stars === 1, 'Admin: Sterne setzen (T1 auf ★)', { t1: one?.stars });
  for (let i = 0; i < n; i++) await rows.nth(i).locator('[data-stars="3"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/admin.png` });
  const after = await V(() => window.__vel.unlocks());
  const lessons = await V(() => window.__vel.lessons());
  check(n === lessons.length && lessons.every((l) => l.stars === 3), 'Admin: jede Lektion auf ★★★ gesetzt (abgehakt)', lessons.map((l) => `${l.id}:${l.stars}`));
  check(!before.includes('item.spinner') && after.includes('item.spinner') && after.includes('glove.robot'), 'Admin ★★★ → Spinner und Roboter frei (deriveUnlocks)', { before, after });
  await rows.nth(n - 1).locator('[data-stars="0"]').click();
  await page.waitForTimeout(150);
  const last = (await V(() => window.__vel.lessons()))[n - 1];
  const kept = await V(() => window.__vel.unlocks());
  check(last?.stars === 0 && kept.includes('glove.robot'), 'Admin: Lektion auf 0 zurück (Sterne senken), Roboter bleibt frei (verdient bleibt verdient)', { stars: last?.stars, robot: kept.includes('glove.robot') });

  // --- Kleine Fenster (1280×720, 1366×768): Menüs ohne Scrollen, Karte ganz im Bild
  if (filter.length === 0 || filter.includes('t3')) report.smallWindows = await smallWindows(browser, check, errors);
  else console.log('(Kleine Fenster nur mit t3)');
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
 * Urteil-Verzug: der Strafe-Bot (sync 1) hüpft in einer Lektion mit Urteil. In jedem Frame (nach dem
 * Spiel-Frame) liest das Werkzeug die HUD-Zähler: verdictSerial = angenommene Urteile, verdictDrawn = höchste
 * sichtbar gezeichnete Nummer — Verzug = Frames, bis ein neues Urteil gezeichnet ist (0 = im Frame der
 * Landung). Dazu: jedes 'lessonHop' auf dem Bus wurde vom HUD angenommen (Zähler = Ereignisse).
 * Frame-Kosten: HUD-Mehrkosten aus 9 × benchHud (Median ± halber Quartilsabstand der Differenz Lektion −
 * normal), updateLesson und session.tick als Mikro-Messung (benchLesson, am Stück). Die Echtzeit-Werte
 * (frameCost) stehen nur zum Vergleich im Bericht — je Frame vergröbert performance.now() auf ~0.1 ms.
 */
async function measure(page, id, check, warn) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V((lid) => window.__vel.start(lid, { lockless: true }), id);
  await page.waitForTimeout(2600);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const judge = (await V(() => window.__vel.training()))?.judge === true;
  let lat = null;
  if (!judge) warn(`${id}: Stufe ohne Urteil — Urteil-Verzug nicht gemessen`);
  else {
    // Zuschauen (H) wie ein Spieler, bei Ende sofort wieder: die Vorführungs-Hand hüpft stetig, jede Landung
    // wird beurteilt. Nicht demo({play}) — dort leert der 'respawn' beim Stufenwechsel die Popups vor draw.
    await V(() => {
      window.__vel.events(0);
      window.__vel.demo({ on: true });
    });
    lat = await V(
      () =>
        new Promise((resolve) => {
          const vel = window.__vel;
          const L0 = vel.hudLayout();
          const serial0 = L0.verdictSerial;
          let seen = serial0;
          const waiting = [];
          const late = [];
          let frames = 0;
          const loop = () => {
            frames++;
            if (frames % 20 === 0 && !vel.training().demo) vel.demo({ on: true });
            const L = vel.hudLayout();
            while (seen < L.verdictSerial) waiting.push({ serial: ++seen, frame: frames });
            for (let i = waiting.length - 1; i >= 0; i--) {
              if (L.verdictDrawn >= waiting[i].serial) {
                late.push(frames - waiting[i].frame);
                waiting.splice(i, 1);
              }
            }
            if (late.length < 12 && frames < 2400) requestAnimationFrame(loop);
            else {
              const hops = vel.events().filter((e) => e.type === 'lessonHop').length;
              resolve({ late, undrawn: waiting.length, accepted: L.verdictSerial - serial0, busHops: hops, frames });
            }
          };
          requestAnimationFrame(() => requestAnimationFrame(loop));
        }),
    );
    await V(() => window.__vel.demo({ on: false }));
    check(
      lat.late.length >= 10 && lat.undrawn === 0 && lat.late.every((x) => x <= 1) && lat.accepted === lat.busHops,
      `${id}: Urteil ≤ 1 Frame nach der Landung (${lat.late.length} Hops, HUD-Zähler)`,
      { framesLate: lat.late, undrawn: lat.undrawn, accepted: lat.accepted, busHops: lat.busHops },
    );
  }
  // Echtzeit: updateLesson + Session-Ticks je Frame im echten Frame (kalte Caches, GC), je 5 Fenster à 2 s im
  // Stand und beim Zuschauen. Einzelwerte sind auf ~0.1 ms vergröbert, Chromes Zufallsschwelle macht den
  // Mittelwert eines Fensters aber erwartungstreu — daher Median der Fenster und ihr halber Quartilsabstand.
  const frameCost = async () => {
    await V(() => window.__vel.frameCost());
    await page.waitForTimeout(2000);
    return V(() => window.__vel.frameCost());
  };
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  const windows = async (demoOn) => {
    const out = [];
    for (let k = 0; k < 5; k++) {
      if (demoOn) await V(() => window.__vel.training()?.demo || window.__vel.demo({ on: true }));
      out.push(await frameCost());
    }
    return out;
  };
  const idleW = await windows(false);
  const demoW = await windows(true);
  await V(() => window.__vel.demo({ on: false }));
  await page.waitForTimeout(300);
  const rt = (ws) => {
    const xs = ws.map((w) => w.lessonMs + w.lessonTickMs).sort((a, b) => a - b);
    return { median: xs[2], halfIqr: (xs[3] - xs[1]) / 2, min: xs[0], max: xs[4], frames: ws.reduce((s, w) => s + w.frames, 0) };
  };
  const idle = rt(idleW);
  const demo = rt(demoW);
  const rtWorst = idle.median >= demo.median ? idle : demo;
  // Mikro-Messung: updateLesson und session.tick je 2·10⁴ am Stück, 5 Läufe → Median.
  const benches = [];
  for (let k = 0; k < 5; k++) benches.push(await V(() => window.__vel.benchLesson(20000)));
  const ok = benches.filter((b) => b !== null);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[(s.length - 1) >> 1];
  };
  const updateMs = ok.length ? median(ok.map((b) => b.updateMs)) : NaN;
  const tickMs = ok.length ? median(ok.map((b) => b.tickMs)) : NaN;
  // HUD: 9 × benchHud; je Lauf Mehrkosten = teurere Lektions-Variante − normal.
  const huds = [];
  for (let k = 0; k < 9; k++) huds.push(await V(() => window.__vel.benchHud(3000)));
  const diffs = huds.map((h) => Math.max(h.lesson, h.lessonDemo) - h.normal).sort((a, b) => a - b);
  const hudAdded = diffs[4];
  const hudSpread = (diffs[6] - diffs[2]) / 2;
  // Session-Ticks je Frame im ungünstigsten Fall: 60 fps bei 128 Tick = 2.13 Ticks je Frame.
  const tickRate = (await V(() => window.__vel.state().tickRate)) ?? 128;
  const ticksPerFrame = tickRate / 60;
  // Abnahme konservativ: HUD-Mehrkosten (nach unten bei 0 gekappt) + der teurere Echtzeit-Median von
  // updateLesson + Session-Ticks; die Mikro-Messung (heiße Caches) ist die Untergrenze dafür.
  const micro = updateMs + tickMs * ticksPerFrame;
  const added = Math.max(0, hudAdded) + Math.max(rtWorst.median, micro);
  const spread = hudSpread + rtWorst.halfIqr;
  const us = (x) => Math.round(x * 1e5) / 100;
  check(ok.length === benches.length && added + spread < 0.05, `${id}: Frame-Callback der Lektion +${r4(added)} ± ${r4(spread)} ms < 0.05 ms (HUD-Mehrkosten + updateLesson + Session-Ticks)`, {
    hudAddedMs: { median: r4(hudAdded), halfIqr: r4(hudSpread), min: r4(diffs[0]), max: r4(diffs[8]) },
    lessonWorkRealtimeMs: { idle: { median: r4(idle.median), halfIqr: r4(idle.halfIqr), min: r4(idle.min), max: r4(idle.max), frames: idle.frames }, demo: { median: r4(demo.median), halfIqr: r4(demo.halfIqr), min: r4(demo.min), max: r4(demo.max), frames: demo.frames } },
    microUs: { updateLesson: us(updateMs), sessionTick: us(tickMs), ticksPerFrameAt60fps: Math.round(ticksPerFrame * 100) / 100, perFrame: us(micro) },
    hudMs: huds.map((h) => ({ normal: r4(h.normal), lesson: r4(h.lesson), lessonDemo: r4(h.lessonDemo) })),
    benchHops: ok.map((b) => b.hops),
  });
  return { idleW, demoW, huds, benches, hudAdded, hudSpread, updateMs, tickMs, idle, demo, added, spread, verdictLatency: lat };
}

/**
 * Neuling befolgt die Anweisung: Lektion neu, 3 s W + Leertaste gehalten vom Stufen-Spawn. In einer Stufe ohne
 * Strafe-Aufgabe (training().judge = false) darf dabei kein Urteil am Gain-Popup und kein Urteils-Tipp im
 * Coach-Band erscheinen ("+0 W LOS" für genau das, was die Karte verlangt). Danach wieder Lektion neu.
 */
async function newbieCheck(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  const t = await V(() => window.__vel.training());
  if (!t) return { skipped: 'keine Lektion' };
  if (t.judge) {
    const noRunUp = await newbieNoRunUp(page, id, check);
    return { noRunUp, withW: await newbieWithW(page, id, check) };
  }
  const r = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const yaw = (vel.training().spawn.yaw * Math.PI) / 180;
        vel.setInputOverride(() => ({ forward: 1, jumpHeld: true, yaw }));
        const hop0 = vel.events().filter((e) => e.type === 'lessonHop').length;
        const t0 = performance.now();
        let frames = 0;
        let verdictFrames = 0;
        const verdictTips = new Set();
        const loop = () => {
          frames++;
          if (vel.hudLayout().verdict !== null) verdictFrames++;
          const x = vel.training();
          if (x && x.tipKind === 'verdict' && x.notice !== null && x.notice === x.tip) verdictTips.add(x.tip);
          if (performance.now() - t0 < 3000) requestAnimationFrame(loop);
          else {
            vel.setInputOverride(null);
            const hops = vel.events().filter((e) => e.type === 'lessonHop').length - hop0;
            resolve({ frames, verdictFrames, verdictTips: [...verdictTips], hops, stage: x?.stageId ?? null });
          }
        };
        requestAnimationFrame(loop);
      }),
  );
  check(r.verdictFrames === 0 && r.verdictTips.length === 0, `${id}: Neuling mit W + Leertaste (Stufe ohne Strafe-Aufgabe) — kein Urteil, kein Urteils-Tipp`, r);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  return r;
}

/**
 * Zuschauen wie ein Spieler (H, nicht demo play): Lektion neu, jede Stufe mit Vorführung einmal ansehen, danach
 * überspringen. Je Frame: steht der Bot (< 40 u/s) an einem geschlossenen Tor (Hull ≤ 24 u entfernt)? Wann
 * meldet Game "Ziel gezeigt" (demoGoal)? Pflicht: < 10 % der Frames am geschlossenen Tor (vorher 51–64 % in fünf
 * Stufen — der Bot lief nach dem Ziel weiter und stand bis DemoDef.seconds davor). Ohne Ziel: WARN (Inhalt).
 */
async function watchDemos(page, id, check, warn) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  const out = [];
  const stages = (await V(() => window.__vel.training()))?.stages ?? [];
  for (let si = 0; si < stages.length; si++) {
    const t = await V(() => window.__vel.training());
    if (!t || t.stageIndex !== si || t.result) break;
    if (stages[si].hasDemo) {
      const r = await V(
        () =>
          new Promise((resolve) => {
            const vel = window.__vel;
            const t0 = performance.now();
            vel.demo({ on: true });
            let frames = 0;
            let gateStuck = 0;
            let goalAt = -1;
            let lastStill = 0;
            let maxSpeed = 0;
            const loop = () => {
              const s = vel.state();
              const x = vel.training();
              if (!x || !x.demo) {
                const back = x ? Math.hypot(s.pos.x - x.spawn.x, s.pos.z - x.spawn.z) : -1;
                resolve({ stage: x?.stageId ?? null, frames, gateStuck, share: frames ? gateStuck / frames : 0, goalAtS: goalAt, stillS: lastStill, maxSpeed: Math.round(maxSpeed), ms: Math.round(performance.now() - t0), backAtSpawn: Math.round(back) });
                return;
              }
              frames++;
              if (s.speed > maxSpeed) maxSpeed = s.speed;
              if (x.demoGoal && goalAt < 0) goalAt = Math.round(performance.now() - t0) / 1000;
              lastStill = x.demoStill;
              for (let g = 0; g < x.gates.length; g++) {
                if (!x.gateBlocked[g]) continue;
                const b = x.gates[g];
                const p = s.pos;
                const dx = Math.max(b.min.x - (p.x + 16), 0, p.x - 16 - b.max.x);
                const dz = Math.max(b.min.z - (p.z + 16), 0, p.z - 16 - b.max.z);
                const dy = Math.max(b.min.y - (p.y + 72), 0, p.y - b.max.y);
                if (Math.max(dx, dz, dy) < 24 && s.speed < 40) {
                  gateStuck++;
                  break;
                }
              }
              requestAnimationFrame(loop);
            };
            requestAnimationFrame(loop);
          }),
      );
      r.stage = stages[si].id;
      out.push(r);
    }
    await V(() => window.__vel.trainingSkip());
    await page.waitForTimeout(250);
  }
  const bad = out.filter((r) => r.share >= 0.1);
  check(bad.length === 0, `${id}: Zuschauen — Vorführung steht < 10 % der Zeit an einem geschlossenen Tor`, out.map((r) => ({ stage: r.stage, share: Math.round(r.share * 1000) / 10, goalAtS: r.goalAtS, s: r.ms / 1000 })));
  const noGoal = out.filter((r) => r.goalAtS < 0);
  if (noGoal.length) warn(`${id}: Vorführung ohne "Ziel gezeigt" (endete über Zeit/Stillstand): ${noGoal.map((r) => r.stage).join(', ')}`, noGoal);
  // Ergebnis-Menü (nach dem letzten Überspringen) abwarten, damit die nächste Lektion sauber startet.
  await page.waitForTimeout(300);
  return out;
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
  // Die Überspringen laufen ohne Tick dazwischen (ein evaluate): ihre 'lessonStage' kommen alle mit dem nächsten
  // Tick — keins davon darf als "GESCHAFFT!" auf den Bus (Blitz, Akkord, Faust).
  const skips = await V(({ s, yaw, gi }) => {
    const vel = window.__vel;
    vel.events(0);
    window.__skipT0 = Math.round(performance.now()) / 1000 - 0.001;
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
  const celebrated = await V(() => window.__vel.events().filter((e) => e.type === 'lessonStage' && e.t >= window.__skipT0).length);
  check(skips >= 2 && celebrated === 0, `${id}: ${skips}× Überspringen ohne Tick dazwischen — kein 'lessonStage' auf dem Bus (kein "GESCHAFFT!")`, { skips, celebrated });
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

/**
 * Lektions-HUD bei Urteil UND Tipp im selben Frame, in drei Auflösungen (pixelHeight 240/270/448 → bei 1080 px
 * Fensterhöhe 216/270/360 Zeilen): W + A in der Luft, keine Maus → Urteil 'MAUS!' je Hop, nach zwei gleichen
 * der Urteils-Tipp im Coach-Band. Nur so misst der Layout-Check Urteil und Coach-Band wirklich (ohne sie ist
 * "nicht gezeichnet" = frei). Danach das Demo-Band derselben Auflösung. Ende: wieder 270.
 */
async function layoutForced(page, id, layoutOk, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V((lid) => window.__vel.start(lid, { lockless: true }), id);
  await page.waitForFunction((lid) => window.__vel.state().lesson === lid, id, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2600);
  const out = [];
  for (const ph of [270, 240, 448]) {
    await V((p) => window.__vel.setRenderSettings({ pixelHeight: p }), ph);
    await page.waitForTimeout(400);
    // Lektion neu: Tipp-Sperren der Session zurück, Spieler am Start der ersten Stufe (mit Urteil).
    await V(() => window.__vel.trainingReset());
    await page.waitForTimeout(300);
    const got = await V(
      () =>
        new Promise((resolve) => {
          const vel = window.__vel;
          const x0 = vel.training();
          const yaw = (x0.spawn.yaw * Math.PI) / 180;
          vel.setInputOverride((st) => ({ forward: 1, side: st.onGround ? 0 : -1, jumpHeld: true, sprint: true, yaw }));
          const t0 = performance.now();
          const loop = () => {
            const L = vel.hudLayout();
            const x = vel.training();
            const both = L.rects.verdict[2] > 0 && L.rects.notice[2] > 0 && x.tipKind === 'verdict' && x.notice !== null && x.notice === x.tip;
            if (both || performance.now() - t0 > 20000) {
              vel.setInputOverride(null);
              resolve({ L, both, verdict: L.verdict, tip: x.notice, s: Math.round(performance.now() - t0) / 1000 });
            } else requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        }),
    );
    await page.screenshot({ path: `${OUT}/layout-${got.L.height}.png` });
    check(got.both, `${id} ${got.L.height} Zeilen: Urteil und Urteils-Tipp im selben Frame erzwungen`, { verdict: got.verdict, tip: got.tip, s: got.s });
    await layoutOk(`${id} ${got.L.height} Zeilen (erzwungen)`, got.L, ['card', 'verdict', 'notice']);
    // Demo-Band derselben Auflösung
    await V(() => window.__vel.trainingReset());
    await page.waitForTimeout(300);
    await V(() => window.__vel.demo({ on: true }));
    await page.waitForTimeout(900);
    const Ld = await layoutOk(`${id} ${got.L.height} Zeilen Vorführung`, undefined, ['card', 'demo']);
    await V(() => window.__vel.demo({ on: false }));
    await page.waitForTimeout(250);
    out.push({ pixelHeight: ph, lines: got.L.height, forced: got.L.rects, demo: Ld.rects.demo, verdict: got.verdict, tip: got.tip });
  }
  await V(() => window.__vel.setRenderSettings({ pixelHeight: 270 }));
  await page.waitForTimeout(400);
  return out;
}

/**
 * Stufenwechsel wie ein Spieler: T3 LINKSKURVE mit W + A + Maus 60 °/s (Review-Probe) bis zur nächsten Stufe.
 * Im ersten Frame der neuen Stufe darf der Coach-Text der alten nicht mehr stehen ("JETZT: A HALTEN" unter der
 * Karte "D HALTEN"), und die Karte zeigt "GESCHAFFT!" mit der vollen Pip-Reihe der erledigten Stufe ("5/5" war nie
 * zu sehen: die Session setzt den Zähler im selben Tick auf die neue Stufe).
 */
async function stageSwitch(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(400);
  const r = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const x0 = vel.training();
        let yaw = (x0.spawn.yaw * Math.PI) / 180;
        const dt = 1 / vel.state().tickRate;
        vel.setInputOverride((st) => {
          const air = !st.onGround;
          if (air) yaw += ((60 * Math.PI) / 180) * dt;
          return { forward: 1, side: air ? -1 : 0, jumpHeld: true, sprint: true, yaw };
        });
        const t0 = performance.now();
        let prevNotice = vel.training().notice;
        let prevCard = vel.hudLayout().card;
        // Tipp-Zähler des Frames VOR dem Wechsel: der Luft-Tipp der neuen Stufe kann schon im Wechsel-Frame stehen.
        let prevTipSerial = vel.training().tipSerial;
        // Legende am Drehbalken: vor dem ersten guten Hop der Lektion da, danach nur "MAUS".
        const legendBefore = vel.hudLayout().turnLegend;
        let sw = null;
        const loop = () => {
          const x = vel.training();
          const card = vel.hudLayout().card;
          const now = performance.now();
          const s = Math.round(now - t0) / 1000;
          if (sw === null && (x.stageIndex !== x0.stageIndex || s > 20)) {
            sw = { from: x0.stageId, to: x.stageId, s, prevNotice, notice: x.notice, prevCard, card, tipSerial: prevTipSerial, at: now, legendBefore, legendAfter: vel.hudLayout().turnLegend };
            if (x.stageIndex === x0.stageIndex) {
              vel.setInputOverride(null);
              resolve(sw);
              return;
            }
            // Weiter wie ein Spieler, der die neue Karte liest (RECHTSKURVE: D + Maus rechts): wann steht der
            // erste Tipp der NEUEN Stufe im Coach-Band? (Review: erst TIP_COOLDOWN nach dem alten, +1.3 s.)
            vel.setInputOverride((st) => {
              const air = !st.onGround;
              if (air) yaw -= ((60 * Math.PI) / 180) * dt;
              return { forward: 1, side: air ? 1 : 0, jumpHeld: true, sprint: true, yaw };
            });
          }
          if (sw !== null) {
            const shown = x.tipSerial > sw.tipSerial && x.notice !== null && x.notice === x.tip;
            if (shown || now - sw.at > 4000) {
              vel.setInputOverride(null);
              resolve({ ...sw, newTip: shown ? x.tip : null, newTipS: shown ? Math.round(now - sw.at) / 1000 : null });
              return;
            }
          }
          prevNotice = x.notice;
          prevCard = card;
          prevTipSerial = x.tipSerial;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }),
  );
  await page.screenshot({ path: `${OUT}/${id}-stage-flash.png` });
  const stale = r.prevNotice !== null && r.notice === r.prevNotice;
  const full = r.card !== null && r.prevCard !== null && r.card.title.includes('GESCHAFFT') && r.card.count === r.card.goal && r.card.goal === r.prevCard.goal && r.card.progress;
  check(r.to !== r.from && !stale, `${id}: Stufenwechsel ${r.from} → ${r.to} — kein Coach-Text der alten Stufe im ersten Frame`, { s: r.s, before: r.prevNotice, after: r.notice });
  check(full, `${id}: Stufenwechsel — Karte "GESCHAFFT!" mit voller Pip-Reihe der erledigten Stufe`, { before: r.prevCard, after: r.card });
  check(r.legendBefore === true && r.legendAfter === false, `${id}: Drehbalken erklärt ("MAUS-TEMPO / IM FLUG IM GRÜNEN HALTEN") bis zum ersten guten Hop, danach nur "MAUS"`, { before: r.legendBefore, after: r.legendAfter });
  // Hat die neue Stufe einen Luft-Tipp (T3 rechts), kommt er mit dem nächsten Sprung — nicht erst nach der Tipp-Sperre.
  const def = lessonJson(id)?.training?.stages?.find((st) => st.id === r.to);
  if (def?.tips?.some((tp) => tp.on === 'air' && tp.zone === undefined)) {
    check(r.newTip !== null && r.newTipS <= 2, `${id}: Stufenwechsel — erster Tipp der neuen Stufe nach ≤ 2 s`, { tip: r.newTip, s: r.newTipS });
  } else console.log(`(${id} ${r.to}: kein Luft-Tipp — Tipp-Verzug nach dem Stufenwechsel nicht gemessen)`);
  return r;
}

/**
 * Tipp der alten Stufe im selben Frame wie der Stufenwechsel: fiel er in einem früheren Tick des Frames, gab es beim
 * Wechsel nichts zu verwerfen (noch nicht angezeigt) — updateLesson zeigte ihn danach unter der neuen Karte. Erzwungen:
 * Ticks eingefroren, W + A + Maus 60 °/s; erst Tick für Tick (je Tick ein Frame) bis zum Wechsel zählen, dann dieselben
 * Ticks nach "Lektion neu" in EINEM Frame (stepTicks(n)). Gegenprobe ohne Game.stageTipSerial: 3/3 alter Tipp sichtbar.
 */
async function staleTip(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  const setup = `(() => {
    const vel = window.__vel;
    vel.freeze(true);
    vel.trainingReset();
    const x0 = vel.training();
    let yaw = (x0.spawn.yaw * Math.PI) / 180;
    const dt = 1 / vel.state().tickRate;
    vel.setInputOverride((st) => {
      const air = !st.onGround;
      if (air) yaw += ((60 * Math.PI) / 180) * dt;
      return { forward: 1, side: air ? -1 : 0, jumpHeld: true, sprint: true, yaw };
    });
    return x0;
  })`;
  const a = await V((src) => {
    const vel = window.__vel;
    const x0 = (0, eval)(src)();
    let n = 0;
    let ser = x0.tipSerial;
    let lastTip = null;
    while (vel.training().stageIndex === x0.stageIndex && n < 128 * 30) {
      vel.stepTicks(1);
      n++;
      const x = vel.training();
      if (x.stageIndex === x0.stageIndex && x.tipSerial !== ser) {
        ser = x.tipSerial;
        lastTip = x.tip;
      }
    }
    vel.setInputOverride(null);
    vel.freeze(false);
    return { n, lastTip, switched: vel.training().stageIndex !== x0.stageIndex };
  }, setup);
  const b = await V(
    ([src, n]) => {
      const vel = window.__vel;
      const x0 = (0, eval)(src)();
      vel.stepTicks(n);
      const x = vel.training();
      vel.setInputOverride(null);
      vel.freeze(false);
      return { from: x0.stageId, to: x.stageId, notice: x.notice };
    },
    [setup, a.n],
  );
  const r = { ticks: a.n, oldTip: a.lastTip, ...b };
  check(a.switched && a.lastTip !== null && b.to !== b.from && b.notice !== a.lastTip, `${id}: Tipp und Stufenwechsel im selben Frame (${a.n} Ticks) — der Tipp der alten Stufe erscheint nicht`, r);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  return r;
}

/**
 * Neuling folgt der Karte wörtlich in einer Stufe MIT Urteil: W + Leertaste vom Stufen-Spawn gehalten, A in der Luft.
 * Der Smart-Hop springt nach 0.2 s Stand mit ~40 u/s — dafür kein "ANLAUF MIT W" (E2E-Review v2final: Tadel für genau
 * das, was die Karte verlangt). Ein zu langsamer Absprung mit gehaltenem W heißt "WEITER ANLAUFEN".
 */
async function newbieWithW(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  const r = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const yaw = (vel.training().spawn.yaw * Math.PI) / 180;
        const mark = vel.events(1)[0] ?? null;
        vel.setInputOverride((st) => ({ forward: 1, side: st.onGround ? 0 : -1, jumpHeld: true, sprint: true, yaw }));
        const t0 = performance.now();
        const seen = [];
        const loop = () => {
          const v = vel.hudLayout().verdict;
          if (v !== null && !seen.includes(v)) seen.push(v);
          if (performance.now() - t0 < 2500) return void requestAnimationFrame(loop);
          vel.setInputOverride(null);
          const all = vel.events();
          const jumps = all.slice(all.indexOf(mark) + 1).filter((e) => e.type === 'jump').map((e) => Math.round(e.speed));
          resolve({ seen, jumps });
        };
        requestAnimationFrame(loop);
      }),
  );
  check(!r.seen.includes('ANLAUF MIT W'), `${id}: Karte wörtlich (W + Leertaste, A in der Luft) — kein "ANLAUF MIT W"`, r);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  return r;
}

/**
 * Neuling ohne Anlauf in einer Stufe MIT Urteil: Leertaste gehalten, A nur in der Luft (wie der Stufentext "IN DER
 * LUFT: A HALTEN"), kein W, keine Maus — hüpft mit ~40 u/s, der Judge wertet Absprünge unter 200 u/s nie. Pflicht:
 * eine Rückmeldung (Gain-Popup mit Text oder ein Urteils-/Vorführungs-Tipp) nach ≤ 5 s (Review: 20 s Stille).
 */
async function newbieNoRunUp(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  const r = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const x0 = vel.training();
        const yaw = (x0.spawn.yaw * Math.PI) / 180;
        // Vorher sichtbares Popup (Rest des Laufs davor) mitschreiben: die Rückmeldung muss aus DIESEM Versuch kommen.
        const before = vel.hudLayout().verdict;
        vel.setInputOverride((st) => ({ side: st.onGround ? 0 : -1, jumpHeld: true, sprint: true, yaw }));
        const t0 = performance.now();
        let maxSpeed = 0;
        const loop = () => {
          const s = (performance.now() - t0) / 1000;
          const L = vel.hudLayout();
          const x = vel.training();
          const sp = vel.state().speed;
          if (sp > maxSpeed) maxSpeed = sp;
          const tip = x.notice !== null && x.notice === x.tip && (x.tipKind === 'verdict' || x.tipKind === 'demo') ? x.notice : null;
          if (L.verdict !== null || tip !== null || s > 8) {
            vel.setInputOverride(null);
            resolve({ stage: x0.stageId, s: Math.round(s * 10) / 10, verdict: L.verdict, tip, maxSpeed: Math.round(maxSpeed), before });
          } else requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }),
  );
  check(r.before === null && r.s <= 5 && (r.verdict !== null || r.tip !== null), `${id}: Neuling ohne Anlauf (Stufe mit Urteil, kein W) — Rückmeldung nach ≤ 5 s`, r);
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  return r;
}

/**
 * Bonus-/Meisterstufe mit Vorführung nach den Pflichtstufen: die Karte zeigt "[ENTER] ERGEBNIS" UND weiter
 * "[H] ZEIGEN" (Review: der Ergebnis-Hinweis ersetzte den Vorführungs-Hinweis — Bonusstufen wirkten ohne Vorführung).
 * Pflichtstufen per Überspringen (zählt als bestanden, nicht für Sterne), dann die erste Stufe danach.
 */
async function bonusHint(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  // Direkt nach dem Stufenwechsel (stageSwitch) steht noch "GESCHAFFT!" — Lektion neu und Überspringen müssen den
  // Blitz der alten Stufe verwerfen (sonst "1/3 GESCHAFFT!" mit voller Pip-Reihe über der übersprungenen Stufe).
  const x = await V(() => {
    const vel = window.__vel;
    const flashBefore = vel.hudLayout().card?.title ?? null;
    vel.trainingReset();
    for (let n = 0; n < 12 && !vel.training().done; n++) vel.trainingSkip();
    return { ...vel.training(), flashBefore };
  });
  await page.waitForTimeout(150);
  const card = (await V(() => window.__vel.hudLayout())).card;
  await page.screenshot({ path: `${OUT}/${id}-bonus-card.png` });
  const r = { stage: x?.stageId ?? null, rank: x?.rank ?? null, hasDemo: x?.hasDemo ?? false, hint: card?.hint ?? null, hintLeft: card?.hintLeft ?? null, title: card?.title ?? null, flashBefore: x?.flashBefore ?? null };
  if (r.flashBefore !== null && r.flashBefore.includes('GESCHAFFT')) {
    check(r.title !== null && !r.title.includes('GESCHAFFT'), `${id}: Lektion neu + Überspringen direkt nach einer erledigten Stufe — kein Geschafft-Blitz der alten Stufe`, { before: r.flashBefore, after: r.title });
  } else console.log(`(${id}: kein Geschafft-Blitz vor dem Überspringen — Abbruch des Blitzes nicht geprüft)`, r.flashBefore);
  if (!x || !x.done || !x.hasDemo) {
    console.log(`(${id}: keine Bonusstufe mit Vorführung nach den Pflichtstufen — Hinweis nicht geprüft)`, r);
    return r;
  }
  check(
    r.hint !== null && r.hint.includes('ERGEBNIS') && r.hintLeft !== null && r.hintLeft.includes('ZEIGEN'),
    `${id}: ${r.rank}-Stufe ${r.stage} nach den Pflichtstufen — Karte zeigt "[ENTER] ERGEBNIS" und weiter "[H] ZEIGEN"`,
    r,
  );
  await V(() => window.__vel.trainingReset());
  await page.waitForTimeout(300);
  return r;
}

/**
 * W-Showkey in Lektionen: Lektionen erzwingen Strafe-Assist (W zählt in der Luft mit A/D nicht) — die Taste darf
 * dort nicht rot blinken, während das Urteil "GUT" sagt. Gegenprobe im normalen Level mit Assist aus: dieselbe
 * Eingabe (W + A in der Luft, Maus 90 °/s links) lässt W rot blinken. hudLayout().wRed = W in diesem Frame rot.
 */
async function wKeyInLesson(page, id, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  const wAir = () =>
    V(
      () =>
        new Promise((resolve) => {
          const vel = window.__vel;
          let yaw = (vel.state().yawDeg * Math.PI) / 180;
          const dt = 1 / vel.state().tickRate;
          vel.setInputOverride((st) => {
            const air = !st.onGround;
            if (air) yaw += ((90 * Math.PI) / 180) * dt;
            return { forward: 1, side: air ? -1 : 0, jumpHeld: true, sprint: true, yaw };
          });
          const t0 = performance.now();
          let frames = 0;
          let red = 0;
          let air = 0;
          const loop = () => {
            frames++;
            if (vel.hudLayout().wRed) red++;
            if (!vel.state().onGround) air++;
            if (performance.now() - t0 < 2500) requestAnimationFrame(loop);
            else {
              vel.setInputOverride(null);
              resolve({ frames, air, red, assist: vel.setConfig({}).strafeAssist });
            }
          };
          requestAnimationFrame(loop);
        }),
    );
  // Spieler-Config ohne Assist (Tools-Patch im normalen Level; ein Patch in der Lektion gälte nur für sie).
  await V(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().levelId === 'level1', null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2600);
  await V(() => window.__vel.setConfig({ strafeAssist: false }));
  const level = await wAir();
  await V((lid) => window.__vel.start(lid, { lockless: true }), id);
  await page.waitForFunction((lid) => window.__vel.state().lesson === lid, id, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2600);
  const lesson = await wAir();
  await page.screenshot({ path: `${OUT}/${id}-wkey.png` });
  // Spieler-Config zurück (Assist an) — im normalen Level, sonst gälte der Patch nur für die Lektion.
  await V(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().levelId === 'level1', null, { timeout: 15000 }).catch(() => undefined);
  await V(() => window.__vel.setConfig({ strafeAssist: true }));
  check(level.red > 0 && !level.assist, 'Gegenprobe L1 mit Strafe-Assist aus: W + A in der Luft lässt die W-Taste rot blinken', level);
  check(lesson.assist && lesson.air > 30 && lesson.red === 0, `${id}: W-Taste bleibt in der Lektion (Strafe-Assist erzwungen) nie rot — auch mit Spieler-Config ohne Assist`, lesson);
  return { level, lesson };
}

/**
 * Coach im normalen Level (L1): wer nur W + Leertaste hüpft (kein Strafe-Versuch, < 400 u/s), bekommt nach
 * Coach.NO_STRAFE_HOPS bewerteten Hops EINMAL den Anstoß "SCHNELLER? … TRAINING T3" — kein Fehler-Hinweis.
 */
async function coachNoStrafe(page, check) {
  const V = (fn, arg) => page.evaluate(fn, arg);
  await V(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().levelId === 'level1', null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2600);
  const r = await V(
    () =>
      new Promise((resolve) => {
        const vel = window.__vel;
        const s0 = vel.state();
        const shown0 = s0.hints.noStrafe;
        const yaw = (s0.yawDeg * Math.PI) / 180;
        vel.setInputOverride(() => ({ forward: 1, jumpHeld: true, sprint: true, yaw }));
        const t0 = performance.now();
        let maxSpeed = 0;
        const loop = () => {
          const s = vel.state();
          const t = (performance.now() - t0) / 1000;
          if (s.speed > maxSpeed) maxSpeed = s.speed;
          const hit = s.hints.noStrafe > shown0 && s.notice !== null && s.notice.startsWith('SCHNELLER');
          if (hit || t > 15) {
            vel.setInputOverride(null);
            resolve({ s: Math.round(t * 10) / 10, notice: s.notice, hints: s.hints, shownBefore: shown0, maxSpeed: Math.round(maxSpeed) });
          } else requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }),
  );
  await page.screenshot({ path: `${OUT}/l1-coach-nostrafe.png` });
  check(
    r.hints.noStrafe === r.shownBefore + 1 && r.hints.strafe === 0 && r.notice !== null && r.notice.includes('TRAINING') && r.s <= 10,
    'L1: W + Leertaste ohne Strafen → Coach-Anstoß "SCHNELLER?" mit Verweis aufs Training (≤ 10 s, kein Fehler-Hinweis)',
    r,
  );
  return r;
}

/**
 * Kleine Fenster (Review: bei 1280×720 war "Klicken zum Starten" angeschnitten, Titel/Pause scrollten 52/23 px):
 * 1280×720 und 1366×768 — Titel mit Neulings-Band, Liste, Lektions-Pause (auch mit "Ergebnis"), Lektions-Karte
 * ganz im Bild und über dem mittleren Band; 1280×720 zusätzlich das größte Ergebnis: T1 (6 Stufen) als letzte Lektion
 * (T2–T8 per Admin ★, T1 von der Vorführung gespielt) → Fidget-Spinner und Roboter-Hand.
 */
async function smallWindows(browser, check, errors) {
  const out = {};
  for (const [w, h] of [
    [1280, 720],
    [1366, 768],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(() => {
      if (sessionStorage.getItem('vel-init')) return;
      sessionStorage.setItem('vel-init', '1');
      localStorage.clear();
      localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false }));
    });
    if (LESSON_DIR) await routeLessons(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror (${w}×${h}): ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console (${w}×${h}): ${m.text()}`);
    });
    const V = (fn, arg) => page.evaluate(fn, arg);
    const scrolls = () =>
      V(() => {
        const s = document.querySelector('.vel-menu:not([hidden]) .vel-screen');
        return s ? s.scrollHeight - s.clientHeight : -1;
      });
    const tag = `${w}×${h}`;
    const r = {};
    try {
      await page.goto(srv.url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__vel?.ready === true);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => window.__vel.lessons().length > 0 && window.__vel.lessons().every((l) => l.loaded), null, { timeout: 30000 });
      await page.waitForTimeout(400);
      r.title = await scrolls();
      r.start = await V(() => {
        const b = document.querySelector('.vel-start');
        if (!b) return null;
        const rc = b.getBoundingClientRect();
        return { bottom: Math.round(rc.bottom), vh: window.innerHeight };
      });
      r.newbie = await page.locator('.vel-newbie').isVisible();
      await page.screenshot({ path: `${OUT}/small-${w}-title.png` });
      check(r.title <= 1 && r.newbie && r.start !== null && r.start.bottom <= r.start.vh, `${tag}: Titel mit Neulings-Band ohne Scrollen, Start-Knopf ganz im Bild`, { overflow: r.title, start: r.start });
      await page.locator('.vel-training-btn').click();
      await page.waitForSelector('.vel-training-screen');
      await page.waitForTimeout(300);
      r.list = await scrolls();
      check(r.list <= 1, `${tag}: Lektionsliste ohne Scrollen`, { overflow: r.list });
      await V(() => window.__vel.start('t3', { lockless: true }));
      await page.waitForFunction(() => window.__vel.state().lesson === 't3', null, { timeout: 15000 });
      await page.waitForTimeout(2600);
      const L = await V(() => window.__vel.hudLayout());
      const [cx, cy, cw, ch] = L.rects.card;
      r.card = { lines: L.height, width: L.width, rect: L.rects.card };
      check(cw > 0 && cx >= 0 && cx + cw <= L.width && cy >= 0 && cy + ch <= L.centerBand[0], `${tag}: Lektionskarte ganz im Bild, über dem mittleren Band`, r.card);
      await V(() => window.__vel.pause());
      await page.waitForSelector('.vel-lesson-pause');
      await page.waitForTimeout(300);
      r.pause = await scrolls();
      await page.screenshot({ path: `${OUT}/small-${w}-pause.png` });
      check(r.pause <= 1, `${tag}: Lektions-Pause ohne Scrollen`, { overflow: r.pause });
      await V(() => window.__vel.resume());
      await page.waitForTimeout(200);
      // Pflichtstufen durch (Überspringen) → Pause mit "Ergebnis" (ein Knopf mehr), Karte mit beiden Hinweisen.
      await V(() => {
        const vel = window.__vel;
        for (let n = 0; n < 12 && !vel.training().done; n++) vel.trainingSkip();
      });
      await page.waitForTimeout(400);
      const L2 = await V(() => window.__vel.hudLayout());
      const [bx, , bw] = L2.rects.card;
      r.cardDone = { rect: L2.rects.card, hint: L2.card?.hint ?? null, hintLeft: L2.card?.hintLeft ?? null };
      check(bw > 0 && bx >= 0 && bx + bw <= L2.width, `${tag}: Karte mit "[H] ZEIGEN" und "[ENTER] ERGEBNIS" ganz im Bild`, r.cardDone);
      await V(() => window.__vel.pause());
      await page.waitForSelector('.vel-lesson-pause');
      await page.waitForTimeout(300);
      r.pauseDone = await scrolls();
      r.pauseButtons = await page.locator('.vel-lesson-pause .vel-btn').count();
      await page.screenshot({ path: `${OUT}/small-${w}-pause-done.png` });
      check(r.pauseDone <= 1, `${tag}: Lektions-Pause nach den Pflichtstufen (${r.pauseButtons} Knöpfe) ohne Scrollen`, { overflow: r.pauseDone });
      await V(() => window.__vel.resume());
      await page.waitForTimeout(200);
      if (w === 1280) {
        // Ergebnis im schlimmsten Fall: T1 (6 Stufen) als letzte Lektion → Spinner UND Roboter. T2–T8 per Admin auf ★,
        // T1 spielt die Vorführung bis zur letzten Pflichtstufe, der Rest wird übersprungen.
        // Titel per Neuladen (toTitle führt aus einer Lektion immer in die Lektionsliste, dort wirkt F8 nicht).
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.__vel?.ready === true);
        await page.waitForFunction(() => window.__vel.lessons().length > 0 && window.__vel.lessons().every((l) => l.loaded), null, { timeout: 30000 });
        await page.waitForSelector('.vel-level');
        await page.keyboard.press('F8');
        await page.waitForSelector('.vel-admin-screen');
        const rows = page.locator('.vel-admin-lesson');
        const nRows = await rows.count();
        for (let i = 1; i < nRows; i++) await rows.nth(i).locator('[data-stars="1"]').click();
        await page.waitForTimeout(150);
        await page.keyboard.press('F8');
        await page.waitForTimeout(200);
        await V(() => window.__vel.start('t1', { lockless: true }));
        await page.waitForFunction(() => window.__vel.state().lesson === 't1', null, { timeout: 15000 });
        await page.waitForTimeout(2600);
        await V(() => window.__vel.demo({ on: true, play: true }));
        await page.waitForFunction(() => window.__vel.training()?.done === true, null, { timeout: 150000, polling: 200 }).catch(() => undefined);
        await V(() => {
          const vel = window.__vel;
          vel.demo({ on: false });
          for (let n = 0; n < 12 && vel.training() && vel.training().stageIndex < vel.training().stageTotal; n++) vel.trainingSkip();
        });
        await page.waitForFunction(() => window.__vel.state().menu === 'lessonDone', null, { timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        r.result = await scrolls();
        r.resultText = await page.locator('.vel-menu:not([hidden]) .vel-screen').innerText().catch(() => '');
        await page.screenshot({ path: `${OUT}/small-${w}-result.png` });
        const unlocked = /spinner/i.test(r.resultText) && /roboter/i.test(r.resultText);
        r.resultRows = await page.locator('.vel-stages tr').count();
        check(r.result >= 0 && r.result <= 1 && unlocked, `${tag}: Ergebnis T1 (${r.resultRows} Stufen) mit zwei Freischaltungen (Spinner, Roboter) ohne Scrollen`, { overflow: r.result, unlocked, rows: r.resultRows });
      }
    } catch (err) {
      check(false, `${tag}: Ablauf abgebrochen`, { error: err instanceof Error ? err.message : String(err) });
    }
    out[tag] = r;
    await ctx.close();
  }
  return out;
}
