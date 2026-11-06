/**
 * Desktop-Login-Smoke (Plan 011 §3.1, S3): die ECHTE Electron-Hülle mit gebauter dist/, echtem supabase-js und dem
 * Live-Supabase — aber OHNE System-Browser (`--dev --auth-no-browser`: die geprüfte Auth-URL bleibt im Hauptprozess)
 * und ohne OS-Tasten. Der Smoke spielt den Browser selbst: Authorize → simulierter Abbruch bei Discord
 * (`/auth/v1/callback?error=access_denied`, kein Login, keine Projekt-Änderung) → GoTrue leitet auf unseren
 * Loopback-Empfänger → Menü zeigt den lesbaren Fehler, das Spiel läuft weiter.
 *
 *  1  Bridge: auth-Feld, Empfänger (Port 47823–47825, state), falscher state → 400, fremder Pfad → 404,
 *     fremde URL → 'url' (nichts geöffnet), cancel → Port zu.
 *  2  Sitzungs-Tresor mit echtem safeStorage (DPAPI): Datei ohne Klartext, lesen, Müll abgelehnt, entfernen.
 *  3  Login-Knopf (klassischer Titel) → Auth-URL (Supabase-Authorize, Discord, PKCE s256, Rücksprung 127.0.0.1 mit
 *     state), zweiter Klick öffnet dieselbe URL erneut, Abbruch bei Discord → Seite "Abgebrochen" → Toast im Menü,
 *     Spiel weiter im Titel, Verifier in localStorage, Sitzung NICHT in localStorage.
 *
 *   npm run build && npx tsx tools/desktop/authSmoke.ts   → shots/desktop/auth-report.json, Exit 1 bei Fehler
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type Page } from 'playwright';
import type { DesktopBridge } from '../../src/platform/bridgeTypes';

const ROOT = process.cwd();
const OUT = 'shots/desktop';
mkdirSync(OUT, { recursive: true });

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ fehlt → erst `npm run build`.');
  process.exit(1);
}
const req = createRequire(import.meta.url);
let electronPath: string;
try {
  electronPath = req('electron') as string;
} catch (e) {
  console.error(`Electron-Binary fehlt (${e instanceof Error ? e.message : String(e)}) — siehe fallen.md #285.`);
  process.exit(1);
}
execFileSync(process.execPath, [req.resolve('typescript/bin/tsc'), '-p', 'electron'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, ['tools/desktop/config.mjs'], { cwd: ROOT, stdio: 'inherit' });
const cfg = JSON.parse(readFileSync(join(ROOT, 'out', 'electron', 'desktop-config.json'), 'utf8')) as { supabaseOrigin?: string | null };
const sbOrigin = cfg.supabaseOrigin ?? null;

type BridgeWin = Window & { velocityDesktop?: DesktopBridge; __cspViolations?: string[] };
const CSP_INIT = `window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));`;

function watch(page: Page): { errors: string[]; csp: string[] } {
  const w = { errors: [] as string[], csp: [] as string[] };
  page.on('pageerror', (e) => w.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) w.csp.push(t);
    else w.errors.push(`console: ${t}`);
  });
  return w;
}

/** Status oder -1 (Verbindung abgelehnt/getrennt). */
const statusOf = (url: string, init?: RequestInit): Promise<number> => fetch(url, init).then((r) => r.status, () => -1);

const userData = mkdtempSync(join(tmpdir(), 'velocity-authsmoke-'));
const app = await _electron.launch({
  executablePath: electronPath,
  args: ['.', '--dev', '--auth-no-browser', '--query=online=supabase&menu=classic', '--window-mode=windowed', `--user-data=${userData}`],
  cwd: ROOT,
});
await app.context().addInitScript(CSP_INIT);
const page = await app.firstWindow();
const w = watch(page);
try {
  await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  // ---- 1 Bridge + Empfänger
  const keys = await page.evaluate(() => {
    const a = (window as BridgeWin).velocityDesktop?.auth;
    return a ? { auth: Object.keys(a).sort(), session: Object.keys(a.session).sort() } : null;
  });
  check('Bridge auth (begin/openExternal/cancel/session)', keys !== null && keys.auth.join() === 'begin,cancel,openExternal,session' && keys.session.join() === 'read,remove,write', JSON.stringify(keys));
  const b = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.auth?.begin() ?? null);
  const redirect = b && b.ok ? b.redirectUrl : null;
  check('Empfänger auf 127.0.0.1:47823–47825 mit state', redirect !== null && /^http:\/\/127\.0\.0\.1:4782[345]\/auth\/callback\?state=[0-9a-f]{32}$/.test(redirect), String(redirect ?? JSON.stringify(b)));
  if (redirect) {
    const u = new URL(redirect);
    const wrong = await statusOf(`${u.origin}${u.pathname}?state=${'0'.repeat(32)}&code=code-boese-1234`);
    const other = await statusOf(`${u.origin}/favicon.ico`);
    check('falscher state → 400, fremder Pfad → 404', wrong === 400 && other === 404, `state ${wrong}, /favicon.ico ${other}`);
  }
  const foreign = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.auth?.openExternal('https://example.com/') ?? null);
  const opened0 = await app.evaluate(() => (globalThis as { __velAuthOpened?: string[] }).__velAuthOpened?.length ?? -1);
  check('fremde Adresse → url, nichts geöffnet', foreign !== null && !foreign.ok && foreign.error === 'url' && opened0 === 0, `${JSON.stringify(foreign)}, geöffnet ${opened0}`);
  await page.evaluate(() => (window as BridgeWin).velocityDesktop?.auth?.cancel());
  await sleep(300);
  if (redirect) {
    const after = await statusOf(`${redirect}&code=code-spaet-1234`);
    check('cancel → Empfänger zu', after === -1, `Status danach ${after}`);
  }

  // ---- 2 Sitzungs-Tresor (echtes safeStorage)
  const SESSION = '{"access_token":"a","refresh_token":"smoke-geheim-refresh","user":{"id":"u"}}';
  const v = await page.evaluate(async (s) => {
    const vault = (window as BridgeWin).velocityDesktop?.auth?.session;
    if (!vault) return null;
    const write = await vault.write(s);
    const back = await vault.read();
    const junk = await vault.write('kein json');
    return { write, back, junk };
  }, SESSION);
  const file = join(userData, 'auth', 'session.bin');
  const raw = existsSync(file) ? readFileSync(file) : null;
  check(
    'Tresor: verschlüsselt geschrieben (kein Klartext), gelesen, Müll abgelehnt',
    v !== null && v.write && v.back === SESSION && !v.junk && raw !== null && !raw.toString('latin1').includes('smoke-geheim'),
    `${JSON.stringify(v && { ...v, back: v.back === SESSION ? 'gleich' : v.back })}, Datei ${raw ? `${raw.length} B` : 'fehlt'}`,
  );
  const rm = await page.evaluate(async () => {
    const vault = (window as BridgeWin).velocityDesktop?.auth?.session;
    return vault ? { removed: await vault.remove(), back: await vault.read() } : null;
  });
  check('Tresor: entfernen', rm !== null && rm.removed && rm.back === null && !existsSync(file), JSON.stringify(rm));

  // ---- 3 Ende-zu-Ende bis zum Abbruch bei Discord (Live-Supabase)
  if (!sbOrigin) check('Supabase-Origin in desktop-config.json', false, 'fehlt → Online am Desktop aus, Teil 3 übersprungen');
  else {
    await page.waitForSelector('.vel-account .vel-discord-btn', { timeout: 15000 });
    await sleep(500);
    await page.click('.vel-account .vel-discord-btn');
    let urls: string[] = [];
    for (let i = 0; i < 50 && urls.length < 1; i++) {
      await sleep(100);
      urls = await app.evaluate(() => [...((globalThis as { __velAuthOpened?: string[] }).__velAuthOpened ?? [])]);
    }
    const authUrl = urls[0] ?? null;
    const au = authUrl ? new URL(authUrl) : null;
    const rt = au?.searchParams.get('redirect_to') ?? null;
    check(
      'Login-Knopf → Supabase-Authorize für Discord mit PKCE und Loopback-Rücksprung',
      au !== null &&
        au.origin === sbOrigin &&
        au.pathname === '/auth/v1/authorize' &&
        au.searchParams.get('provider') === 'discord' &&
        au.searchParams.get('code_challenge_method') === 's256' &&
        (au.searchParams.get('code_challenge') ?? '').length >= 43 &&
        rt !== null &&
        /^http:\/\/127\.0\.0\.1:4782[345]\/auth\/callback\?state=[0-9a-f]{32}$/.test(rt),
      au ? `${au.origin}${au.pathname} provider=${au.searchParams.get('provider')} method=${au.searchParams.get('code_challenge_method')} redirect_to=${rt}` : 'keine URL',
    );
    // Zweiter Klick während des Wartens: derselbe Versuch, dieselbe URL erneut.
    await page.click('.vel-account .vel-discord-btn');
    for (let i = 0; i < 30 && urls.length < 2; i++) {
      await sleep(100);
      urls = await app.evaluate(() => [...((globalThis as { __velAuthOpened?: string[] }).__velAuthOpened ?? [])]);
    }
    check('zweiter Klick: dieselbe Auth-URL erneut', urls.length === 2 && urls[1] === urls[0], `${urls.length} geöffnet${urls.length === 2 ? (urls[1] === urls[0] ? ', gleich' : ', VERSCHIEDEN') : ''}`);

    if (authUrl && rt) {
      // Browser spielen: Authorize → Discord-Adresse mit state (UUID des Flows) → Abbruch an Supabase melden.
      const a = await fetch(authUrl, { redirect: 'manual' });
      const discord = a.headers.get('location');
      const flow = discord ? new URL(discord).searchParams.get('state') : null;
      const cb = flow ? await fetch(`${sbOrigin}/auth/v1/callback?state=${flow}&error=access_denied&error_description=velocity-smoke`, { redirect: 'manual' }) : null;
      const back = cb?.headers.get('location') ?? null;
      const bu = back ? new URL(back) : null;
      check(
        'Supabase leitet den Abbruch auf den Loopback-Empfänger (ohne Eintrag in den Redirect URLs)',
        a.status === 302 && bu !== null && `${bu.origin}${bu.pathname}?state=${bu.searchParams.get('state')}` === rt && bu.searchParams.get('error') === 'access_denied',
        `authorize ${a.status} → ${discord ? new URL(discord).host : '—'}; callback ${cb?.status ?? '—'} → ${bu ? `${bu.origin}${bu.pathname} error=${bu.searchParams.get('error')}` : '—'}`,
      );
      if (back) {
        const res = await fetch(back);
        const html = await res.text();
        check('Empfänger: Seite "Abgebrochen" (CSP, ohne Skript)', res.status === 200 && html.includes('aria-label="Abgebrochen"') && !/<script/i.test(html) && (res.headers.get('content-security-policy') ?? '').startsWith("default-src 'none'"), `HTTP ${res.status}`);
      }
      await page.waitForFunction(() => /Anmeldung fehlgeschlagen/.test(document.getElementById('vel-toast')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
      const st = await page.evaluate(() => {
        const t = document.getElementById('vel-toast');
        const keys = Object.keys(localStorage);
        return {
          toast: t && !t.hidden ? (t.textContent ?? '') : null,
          state: window.__vel?.state().gameState ?? null,
          verifier: keys.some((k) => /^sb-.+-auth-token(-flow-.+)?-code-verifier$/.test(k)),
          session: keys.filter((k) => /^sb-.+-auth-token$/.test(k)),
        };
      });
      await page.screenshot({ path: `${OUT}/auth-denied.png` });
      check('lesbarer Fehler im Menü (Toast), Spiel läuft weiter', st.toast !== null && /Anmeldung fehlgeschlagen: Anmeldung abgebrochen/.test(st.toast) && st.state === 'title', `Toast "${st.toast}", gameState ${st.state}`);
      check('PKCE-Verifier im Renderer-Storage, Sitzung nicht in localStorage', st.verifier && st.session.length === 0 && !existsSync(file), `Verifier ${st.verifier}, Sitzungsschlüssel ${st.session.length}, session.bin ${existsSync(file)}`);
    }
  }

  const csp = (await page.evaluate(() => (window as BridgeWin).__cspViolations ?? [])) ?? [];
  check('0 CSP-Verstöße', csp.length === 0 && w.csp.length === 0, [...csp, ...w.csp].slice(0, 4).join(' | ') || '0');
  check('0 Konsolenfehler', w.errors.length === 0, w.errors.slice(0, 4).join(' | ') || '0');
} finally {
  await app.close().catch(() => {});
  rmSync(userData, { recursive: true, force: true });
}

writeFileSync(`${OUT}/auth-report.json`, JSON.stringify({ checks }, null, 2));
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} grün${bad.length ? ` — rot: ${bad.map((c) => c.name).join('; ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
