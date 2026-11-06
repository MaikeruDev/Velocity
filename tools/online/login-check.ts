/**
 * Discord-Login-Fluss im echten Spiel gegen das echte Supabase-Projekt (Plan 009), Port LOGIN_PORT (Default 5711).
 * Braucht .env.local mit VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (Default-Backend = supabase).
 *
 *  1. Titel: Backend supabase, nicht angemeldet, Knopf "Mit Discord anmelden" (title.png).
 *  2. Bestenliste öffentlich ohne Login: lädt ohne Fehler (leer bzw. Einträge), Login-Hinweis (leaderboard.png).
 *  3. Einstellungen → Online: Login-Knopf (settings.png).
 *  4. Lauf ins Ziel ohne Login: Status 'login' + Hinweis + Knopf im Ergebnis (finish.png).
 *  5. Knopf → Redirect zu …/auth/v1/authorize?provider=discord&redirect_to=<Seite> (abgefangen, 204 → Seite bleibt),
 *     das Replay liegt vorher in sessionStorage (velocity.online.pending.v1) und überlebt ein Neuladen.
 *
 *   npx tsx tools/online/login-check.ts      → shots/login/ + report.json, Exit 1 bei Fehler
 *
 * Den ECHTEN Login (Discord-Konto) kann das Werkzeug nicht — Ablauf dafür: .docs/plans/009-online.md "Für den Betreiber".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = Number(process.env.LOGIN_PORT ?? 5711);
const OUT = 'shots/login';
const PENDING_KEY = 'velocity.online.pending.v1';
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

async function botToFinish(page: Page): Promise<number | null> {
  await page.evaluate(() => {
    const v = window.__vel;
    if (!v) throw new Error('kein __vel');
    v.useBot('route', { aimNoiseDeg: 1, seed: 3, restart: true });
    v.freeze(true);
  });
  for (let k = 0; k < 200; k++) {
    const st = await page.evaluate(() => window.__vel?.stepTicks(256) ?? null);
    if (!st || st.gameState === 'finished') break;
  }
  await page.evaluate(() => window.__vel?.freeze(false));
  await page.waitForFunction(() => window.__vel?.state().menu === 'finish', null, { timeout: 15000 });
  return (await page.evaluate(() => window.__vel?.state().finish?.time ?? null)) ?? null;
}

const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const url = `http://localhost:${PORT}/`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const authorize: string[] = [];
  // OAuth-Redirect abfangen: 204 bricht die Navigation ab, das Spiel bleibt geladen.
  await page.route('**/auth/v1/authorize**', async (route) => {
    authorize.push(route.request().url());
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto(url);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.waitForTimeout(500);

  // ---- 1) Titel
  const info = await page.evaluate(() => window.__vel?.online() ?? null);
  check('Backend supabase, nicht angemeldet', info?.backend === 'supabase' && info.uid === null, `${info?.backend} · uid ${info?.uid}`);
  const titleBtn = await page.$('.vel-side .vel-discord-btn');
  check('Titel: "Mit Discord anmelden"', titleBtn !== null && ((await titleBtn.textContent()) ?? '').includes('Discord'), `${(await titleBtn?.textContent())?.trim() ?? 'kein Knopf'}`);
  await page.screenshot({ path: `${OUT}/title.png` });

  // ---- 2) Bestenliste öffentlich
  await page.click('.vel-side .vel-board-btn');
  await page.waitForFunction(() => {
    const t = document.querySelector('.vel-board-top')?.textContent ?? '';
    return !t.includes('Lade');
  }, null, { timeout: 20000 });
  const topText = ((await page.textContent('.vel-board-top')) ?? '').replace(/\s+/g, ' ').trim();
  const whoBtn = await page.$('.vel-board-who .vel-discord-btn');
  check('Bestenliste lädt ohne Login (öffentlich, ohne Fehler)', !/Offline|Fehler/i.test(topText), `"${topText}"`);
  check('Bestenliste: Login-Hinweis', whoBtn !== null, ((await page.textContent('.vel-board-who')) ?? '').replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: `${OUT}/leaderboard.png` });
  await page.keyboard.press('Escape');

  // ---- 3) Einstellungen
  await page.waitForSelector('.vel-side', { timeout: 5000 });
  await page.click('.vel-side .vel-btn:has-text("Einstellungen")');
  await page.waitForSelector('.vel-online-panel', { timeout: 5000 });
  const setBtn = await page.$('.vel-online-panel .vel-discord-btn');
  check('Einstellungen → Online: Login-Knopf', setBtn !== null, ((await page.textContent('.vel-online-panel')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 160));
  await page.locator('.vel-online-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/settings.png` });

  // ---- 4) Lauf ohne Login
  await page.evaluate(() => window.__vel?.start('level1', { lockless: true }));
  const time = await botToFinish(page);
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => window.__vel?.online().status ?? null);
  const statusText = ((await page.textContent('.vel-online-status')) ?? '').replace(/\s+/g, ' ').trim();
  const finBtn = await page.$('.vel-online-status .vel-discord-btn');
  check('Ergebnis ohne Login: Hinweis + Knopf', st?.state === 'login' && statusText.includes('Melde dich mit Discord an') && finBtn !== null, `Zeit ${time} · ${st?.state}: "${statusText}"`);
  await page.screenshot({ path: `${OUT}/finish.png` });

  // ---- 5) Login-Knopf → Replay gesichert → Redirect zu Discord (abgefangen)
  await page.waitForFunction(() => (window.__vel?.online().replay ?? null) !== null, null, { timeout: 5000 });
  await page.waitForTimeout(500); // Ergebnis-Eingabesperre (FINISH_INPUT_GUARD_MS) abwarten
  await page.click('.vel-online-status .vel-discord-btn');
  await page.waitForTimeout(800);
  const pending = await page.evaluate((k) => sessionStorage.getItem(k), PENDING_KEY);
  let pendingInfo = 'fehlt';
  if (pending) {
    const p = JSON.parse(pending) as { levelId: string; time: number; b64: string };
    pendingInfo = `${p.levelId}, ${p.time} s, ${Math.round((p.b64.length * 3) / 4)} B`;
  }
  check('Replay vor dem Redirect in sessionStorage', pending !== null && pendingInfo.startsWith('level1'), pendingInfo);
  const auth = authorize[0] ? new URL(authorize[0]) : null;
  check(
    'Redirect zu Supabase Auth (Discord, zurück auf diese Seite, PKCE)',
    auth !== null && auth.searchParams.get('provider') === 'discord' && auth.searchParams.get('redirect_to') === url && auth.searchParams.has('code_challenge'),
    auth ? `${auth.origin}${auth.pathname}?provider=${auth.searchParams.get('provider')}&redirect_to=${auth.searchParams.get('redirect_to')}&scopes=${auth.searchParams.get('scopes')}` : 'kein Redirect',
  );
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.waitForTimeout(500);
  const stillPending = await page.evaluate((k) => sessionStorage.getItem(k) !== null, PENDING_KEY);
  check('Ohne Sitzung nach dem Neuladen: Lauf wartet weiter (wird nach echtem Login eingereicht)', stillPending, String(stillPending));

  // ---- 6) Angemeldet-Ansicht mit untergeschobener (gefälschter) Sitzung: supabase-js liest sie aus localStorage,
  // der Server lehnt das Token ab — so lassen sich Avatar/Name/Abmelden und der Einreich-Versuch des gesicherten
  // Laufs nach dem "Login" prüfen, ohne Discord. Erwartet: Ansicht angemeldet, Lauf entnommen, Server sagt 401.
  const ref = new URL(process.env.VITE_SUPABASE_URL ?? 'https://didmtxnjtalbqppmmpvq.supabase.co').hostname.split('.')[0];
  errors.length = 0;
  await page.evaluate((key) => {
    const now = Math.floor(Date.now() / 1000);
    const user = {
      id: '00000000-0000-4000-8000-00000000f00d',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: { provider: 'discord' },
      user_metadata: { full_name: 'Prüfstand', avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png' },
      created_at: new Date().toISOString(),
    };
    localStorage.setItem(key, JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user }));
  }, `sb-${ref}-auth-token`);
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.waitForFunction(() => window.__vel?.online().uid !== null, null, { timeout: 10000 });
  await page.waitForSelector('.vel-side .vel-account--in', { timeout: 5000 });
  await page.waitForTimeout(1500);
  const acct = ((await page.textContent('.vel-side .vel-account--in')) ?? '').replace(/\s+/g, ' ').trim();
  const avatar = await page.$('.vel-side .vel-account--in img.vel-avatar');
  check('Angemeldet: Avatar + Name + Abmelden im Titel', acct.includes('Prüfstand') && acct.includes('Abmelden') && avatar !== null, `"${acct}" · Avatar ${avatar ? await avatar.getAttribute('src') : 'fehlt'}`);
  const taken = await page.evaluate((k) => sessionStorage.getItem(k) === null, PENDING_KEY);
  const after = await page.evaluate(() => window.__vel?.online().status ?? null);
  check('Nach dem Login: gesicherter Lauf entnommen und eingereicht (Server lehnt Fake-Token ab)', taken && after !== null && after.state === 'error', `${after?.state}: ${after?.text}`);
  await page.screenshot({ path: `${OUT}/title-signed-in.png` });
  await page.click('.vel-side .vel-account-out');
  await page.waitForSelector('.vel-side .vel-discord-btn', { timeout: 5000 });
  check('Abmelden → wieder Login-Knopf', true, 'ok');
  // Erwartete Fehler der Fake-Sitzung (401 vom Server) nicht als Seitenfehler zählen.
  const unexpected = errors.filter((e) => !/401|403|JWT|Failed to load resource/i.test(e));
  errors.length = 0;
  errors.push(...unexpected);

  check('keine Seiten-/Konsolenfehler', errors.length === 0, errors.length === 0 ? '—' : errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
  await vite.close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, errors }, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? `\nAlle ${checks.length} Prüfungen ok → ${OUT}/` : `\n${failed.length} von ${checks.length} Prüfungen fehlgeschlagen`);
process.exit(failed.length === 0 ? 0 : 1);
