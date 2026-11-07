import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_PATH, AUTH_PORTS, isAuthorizeUrl, LoopbackLogin, PAGE_CSP, pixelTitle } from '../electron/auth';
import { SecureSessionStore, SESSION_MAX_CHARS, type SessionCipher } from '../electron/session';
import type { DesktopAuthBridge, DesktopBridge } from '../src/platform/bridgeTypes';
import { detectPlatform } from '../src/platform/index';

/** Plan 011 §3.1: Loopback-Login (echter HTTP-Empfänger auf 127.0.0.1) und Sitzungs-Tresor — ohne Electron. */

const SB = 'https://abc.supabase.co';
const authUrl = (redirect: string, provider = 'discord'): string =>
  `${SB}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirect)}&scopes=identify&code_challenge=abc&code_challenge_method=s256`;

function listen(s: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve());
  });
}

/** Freie Ports (kurz binden, wieder frei); paarweise verschieden. */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) {
    const s = createServer();
    await listen(s, 0);
    const a = s.address();
    await new Promise<void>((r) => s.close(() => r()));
    if (a && typeof a !== 'string' && !out.includes(a.port)) out.push(a.port);
  }
  return out;
}

/** Ist der Port wieder frei (der Empfänger wirklich zu)? Bis zu 1 s erneut versuchen. */
async function portFree(port: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const s = createServer();
    const ok = await listen(s, port).then(
      () => true,
      () => false,
    );
    if (ok) {
      await new Promise<void>((r) => s.close(() => r()));
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** GET mit eigenem Host-Kopf (fetch erlaubt das nicht). */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const logins: LoopbackLogin[] = [];
const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(logins.splice(0).map((l) => l.cancel()));
  await Promise.all(blockers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function makeLogin(ports: readonly number[], opts: { timeoutMs?: number; open?: (url: string) => Promise<boolean> } = {}): { login: LoopbackLogin; opened: string[]; returns: number[] } {
  const opened: string[] = [];
  const returns: number[] = [];
  const login = new LoopbackLogin({
    supabaseOrigin: SB,
    openExternal:
      opts.open ??
      (async (url) => {
        opened.push(url);
        return true;
      }),
    onReturn: () => returns.push(1),
    ports,
    timeoutMs: opts.timeoutMs,
  });
  logins.push(login);
  return { login, opened, returns };
}

async function started(login: LoopbackLogin): Promise<string> {
  const b = await login.begin();
  if (!b.ok) throw new Error(b.detail);
  return b.redirectUrl;
}

describe('Desktop-Login: Loopback-Empfänger (electron/auth.ts)', () => {
  it('feste Ports, Pfad /auth/callback, state je Versuch', async () => {
    expect(AUTH_PORTS).toEqual([47823, 47824, 47825]);
    expect(AUTH_PATH).toBe('/auth/callback');
    const [p] = await freePorts(1);
    const { login } = makeLogin([p]);
    const r1 = await started(login);
    expect(r1).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${p}/auth/callback\\?state=[0-9a-f]{32}$`));
    expect(login.port).toBe(p);
    const r2 = await started(login);
    expect(r2).not.toBe(r1);
  });

  it('Code → Ergebnis: gültiger Rücksprung, Pixel-Seite (CSP, ohne externe Ressourcen), Fenster nach vorn, Empfänger zu', async () => {
    const [p] = await freePorts(1);
    const { login, opened, returns } = makeLogin([p]);
    const redirect = await started(login);
    const result = login.open(authUrl(redirect));
    await tick();
    expect(opened).toEqual([authUrl(redirect)]);
    const res = await fetch(`${redirect}&code=11111111-2222-3333-4444-555555555555`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('aria-label="Login fertig"');
    expect(html).toContain('Zurück zum Spiel');
    // Keine Skripte, keine Datei-/Netz-Ressourcen; der eine Stilblock steht per Hash in der CSP.
    expect(html).not.toMatch(/<script|\bsrc=|\bhref=|url\(|@import|https?:\/\//i);
    const css = /<style>([^<]*)<\/style>/.exec(html)?.[1] ?? '';
    expect(css.length).toBeGreaterThan(0);
    expect(PAGE_CSP).toContain(`'sha256-${createHash('sha256').update(css).digest('base64')}'`);
    expect(PAGE_CSP).toMatch(/^default-src 'none'/);
    // Der Code steht nie in der Seite.
    expect(html).not.toContain('11111111-2222');
    await expect(result).resolves.toEqual({ ok: true, code: '11111111-2222-3333-4444-555555555555' });
    expect(returns).toHaveLength(1);
    expect(login.port).toBeNull();
    expect(await portFree(p)).toBe(true);
  });

  it('zweiter Callback wird ignoriert: gleichzeitig → genau einer zählt; danach → abgewiesen, Ergebnis bleibt', async () => {
    const [p] = await freePorts(1);
    const { login } = makeLogin([p]);
    const redirect = await started(login);
    const result = login.open(authUrl(redirect));
    await tick();
    const both = await Promise.all(['code-aaaa-1111', 'code-bbbb-2222'].map((c) => fetch(`${redirect}&code=${c}`).then((r) => r.status, () => -1)));
    expect(both.filter((s) => s === 200)).toHaveLength(1);
    const r = await result;
    expect(r.ok && ['code-aaaa-1111', 'code-bbbb-2222'].includes(r.code)).toBe(true);
    // Später (Seite neu geladen): Empfänger ist zu oder meldet "schon abgeschlossen" — nie ein zweites Ergebnis.
    const late = await fetch(`${redirect}&code=code-cccc-3333`).then((x) => x.status, () => -1);
    expect([410, -1]).toContain(late);
    expect(await login.open(authUrl(redirect))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await result).toEqual(r);
  });

  it('falscher oder fehlender state → 400, zählt nicht (fremde Seite kann den Versuch nicht verbrauchen)', async () => {
    const [p] = await freePorts(1);
    const { login } = makeLogin([p]);
    const redirect = await started(login);
    const result = login.open(authUrl(redirect));
    await tick();
    const wrong = await fetch(`http://127.0.0.1:${p}${AUTH_PATH}?state=${'0'.repeat(32)}&code=code-boese-1`);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('aria-label="Fehler"');
    expect((await fetch(`http://127.0.0.1:${p}${AUTH_PATH}?code=code-boese-2`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${p}${AUTH_PATH}?state=kurz&code=code-boese-3`)).status).toBe(400);
    // Andere Pfade, andere Methode, fremder Host-Kopf (DNS-Rebinding) → abgewiesen.
    expect((await fetch(`http://127.0.0.1:${p}/favicon.ico`)).status).toBe(404);
    expect((await fetch(redirect, { method: 'POST' })).status).toBe(404);
    const path = new URL(redirect);
    expect(await rawGet(p, `${path.pathname}${path.search}&code=code-boese-4`, `evil.example:${p}`)).toBe(400);
    expect(login.port).toBe(p);
    const ok = await fetch(`${redirect}&code=code-echt-5`);
    expect(ok.status).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, code: 'code-echt-5' });
  });

  it('Port belegt → nächster Port der Liste; alle belegt → ports (lesbar)', async () => {
    const [a, b] = await freePorts(2);
    const blockA = createServer();
    blockers.push(blockA);
    await listen(blockA, a);
    const { login } = makeLogin([a, b]);
    const redirect = await started(login);
    expect(redirect.startsWith(`http://127.0.0.1:${b}/`)).toBe(true);
    await login.cancel();
    const blockB = createServer();
    blockers.push(blockB);
    await listen(blockB, b);
    const res = await makeLogin([a, b]).login.begin();
    expect(res).toMatchObject({ ok: false, error: 'ports' });
    expect(res.ok ? '' : res.detail).toContain(`${a}–${b}`);
  });

  it('Zeitüberschreitung → timeout mit Hinweis auf die Rücksprung-Adresse, Empfänger zu', async () => {
    const [p] = await freePorts(1);
    const { login } = makeLogin([p], { timeoutMs: 60 });
    const redirect = await started(login);
    const r = await login.open(authUrl(redirect));
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(r.ok ? '' : r.detail).toContain('Rücksprung-Adresse');
    expect(login.port).toBeNull();
    expect(await portFree(p)).toBe(true);
  });

  it('openExternal-Allowlist: nur Supabase-Authorize für Discord mit GENAU dieser Rücksprung-Adresse', async () => {
    const [p] = await freePorts(1);
    const { login, opened } = makeLogin([p]);
    const redirect = await started(login);
    const bad = [
      authUrl(redirect).replace(SB, 'https://evil.example'),
      authUrl(redirect).replace('https://', 'http://'),
      authUrl(redirect).replace('/auth/v1/authorize', '/rest/v1/profiles'),
      authUrl(redirect, 'github'),
      authUrl('http://127.0.0.1:1/auth/callback?state=fremd'),
      authUrl(redirect).replace('https://', 'https://user:pw@'),
      'https://discord.com/oauth2/authorize?client_id=1',
      'https://abc.supabase.co.evil.example/auth/v1/authorize',
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'kein url',
    ];
    for (const u of bad) expect(await login.open(u), u).toMatchObject({ ok: false, error: 'url' });
    expect(opened).toEqual([]);
    // Abgelehnte Adressen beenden den Versuch nicht.
    expect(login.port).toBe(p);
    expect(isAuthorizeUrl(authUrl(redirect), SB, redirect)).toBe(true);
    // Ohne Supabase-Origin (Online am Desktop aus) auch die richtige Adresse nicht.
    expect(isAuthorizeUrl(authUrl(redirect), null, redirect)).toBe(false);
    void login.open(authUrl(redirect));
    await tick();
    expect(opened).toEqual([authUrl(redirect)]);
  });

  it('im Browser abgebrochen → denied mit Grund (Seite "Abgebrochen"); anderer Fehler → provider; ohne Code → provider', async () => {
    const [p] = await freePorts(1);
    const { login } = makeLogin([p]);
    let redirect = await started(login);
    let result = login.open(authUrl(redirect));
    await tick();
    const page = await fetch(`${redirect}&error=access_denied&error_description=${encodeURIComponent('The resource owner denied the request <b>')}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('aria-label="Abgebrochen"');
    expect(html).not.toContain('<b>');
    const denied = await result;
    expect(denied).toMatchObject({ ok: false, error: 'denied' });
    expect(denied.ok ? '' : denied.detail).toContain('The resource owner denied the request');

    expect(await portFree(p)).toBe(true);
    redirect = await started(login);
    result = login.open(authUrl(redirect));
    await tick();
    await fetch(`${redirect}&error=server_error&error_description=Database%20error`);
    expect(await result).toMatchObject({ ok: false, error: 'provider' });

    expect(await portFree(p)).toBe(true);
    redirect = await started(login);
    result = login.open(authUrl(redirect));
    await tick();
    await fetch(`${redirect}&code=x`); // zu kurz, kein gültiger Code
    expect(await result).toMatchObject({ ok: false, error: 'provider' });
  });

  it('neuer Versuch ersetzt den alten (cancelled); cancel() schließt; Browser startet nicht → open', async () => {
    const [p] = await freePorts(1);
    const { login } = makeLogin([p]);
    const first = login.open(authUrl(await started(login)));
    const redirect2 = await started(login);
    expect(await first).toMatchObject({ ok: false, error: 'cancelled' });
    // Port des ersten Versuchs ist wieder frei → derselbe Port für den neuen.
    expect(redirect2.startsWith(`http://127.0.0.1:${p}/`)).toBe(true);
    const second = login.open(authUrl(redirect2));
    await login.cancel();
    expect(await second).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await portFree(p)).toBe(true);
    expect(await login.open(authUrl(redirect2))).toMatchObject({ ok: false, error: 'cancelled' });

    const broken = makeLogin([p], { open: () => Promise.reject(new Error('kein Browser')) }).login;
    const r = await broken.open(authUrl(await started(broken)));
    expect(r).toMatchObject({ ok: false, error: 'open' });
    expect(broken.port).toBeNull();
  });

  it('Abbruch während begin() noch bindet → begin meldet cancelled, Port frei, kein Versuch lebt weiter (Review N2)', async () => {
    const [p] = await freePorts(1);
    const { login, opened } = makeLogin([p]);
    const pending = login.begin();
    await login.cancel();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
    expect(login.port).toBeNull();
    await tick();
    expect(await portFree(p)).toBe(true);
    expect(await login.open(authUrl(`http://127.0.0.1:${p}/auth/callback?state=00`))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(opened).toEqual([]);
    // Danach geht ein neuer Versuch normal.
    expect((await started(login)).startsWith(`http://127.0.0.1:${p}/`)).toBe(true);
  });

  it('Pixel-Titel: ganze Pixel aus dem 5×7-HUD-Font', () => {
    const t = pixelTitle('LOGIN FERTIG');
    // L O G I(3) N, Leerzeichen 3, F E R T I(3) G — je 1 Pixel Abstand.
    expect(t.width).toBe(64);
    expect(t.d).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });
});

describe('Desktop-Login: Sitzungs-Tresor (electron/session.ts)', () => {
  /** Ersatz für safeStorage: umkehrbar, aber nie Klartext auf der Platte. */
  class FakeCipher implements SessionCipher {
    ok = true;
    async available(): Promise<boolean> {
      return this.ok;
    }
    async encrypt(plain: string): Promise<Buffer> {
      return Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a));
    }
    async decrypt(data: Buffer): Promise<string> {
      if (data[0] === 0) throw new Error('fremder Schlüssel');
      return Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8');
    }
  }
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function store(cipher = new FakeCipher()): { s: SecureSessionStore; file: string; cipher: FakeCipher } {
    const dir = mkdtempSync(join(tmpdir(), 'velocity-session-'));
    dirs.push(dir);
    const file = join(dir, 'auth', 'session.bin');
    return { s: new SecureSessionStore(file, cipher), file, cipher };
  }
  const SESSION = '{"access_token":"a","refresh_token":"geheim-refresh","user":{"id":"u"}}';

  it('schreiben → verschlüsselte Datei (kein Klartext), lesen, entfernen', async () => {
    const { s, file } = store();
    expect(await s.read()).toBeNull();
    expect(await s.write(SESSION)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).toString('utf8')).not.toContain('geheim-refresh');
    expect(await s.read()).toBe(SESSION);
    expect(await s.remove()).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(await s.read()).toBeNull();
  });

  it('nur JSON-Objekte bis 64 K Zeichen; ohne OS-Schlüsselspeicher nichts auf die Platte', async () => {
    const { s, file, cipher } = store();
    for (const v of ['', 'kein json', '[1,2]', '"text"', 'null', 42, null, { a: 1 }, `{"x":"${'y'.repeat(SESSION_MAX_CHARS)}"}`]) {
      expect(await s.write(v), String(v).slice(0, 20)).toBe(false);
    }
    expect(existsSync(file)).toBe(false);
    cipher.ok = false;
    expect(await s.write(SESSION)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('kaputte/fremde Datei → abgemeldet und weg; Reihenfolge bleibt (Refresh überholt nie ein Abmelden)', async () => {
    const { s, file } = store();
    expect(await s.write(SESSION)).toBe(true);
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    expect(await s.read()).toBeNull();
    expect(existsSync(file)).toBe(false);
    // Ohne await hintereinander: das letzte Kommando bestimmt den Stand.
    const ops = [s.write('{"n":1}'), s.write('{"n":2}'), s.remove(), s.write('{"n":3}')];
    await Promise.all(ops);
    expect(await s.read()).toBe('{"n":3}');
    const ops2 = [s.write('{"n":4}'), s.remove()];
    await Promise.all(ops2);
    expect(await s.read()).toBeNull();
  });
});

describe('Plattform: platform.auth', () => {
  const fullAuth = (): DesktopAuthBridge => ({
    begin: () => Promise.resolve({ ok: true, redirectUrl: 'http://127.0.0.1:47823/auth/callback?state=x' }),
    openExternal: () => Promise.resolve({ ok: false, error: 'cancelled', detail: '' }),
    cancel: () => {},
    session: { read: () => Promise.resolve(null), write: () => Promise.resolve(true), remove: () => Promise.resolve(true) },
  });
  const bridge = (auth: unknown): DesktopBridge =>
    ({
      version: 1,
      versions: { electron: '45.2.3', chrome: '156' },
      dev: false,
      quit: () => {},
      window: { getMode: () => Promise.resolve('windowed'), setMode: (m) => Promise.resolve(m) },
      openExternal: () => Promise.resolve(false),
      saveMirror: { readSync: () => null, write: () => Promise.resolve(true), writeSync: () => true },
      auth,
    }) as DesktopBridge;

  it('Desktop mit vollständigem Login-Feld → auth; unvollständig/fehlt → null; Web → null', () => {
    const a = fullAuth();
    expect(detectPlatform({ velocityDesktop: bridge(a) }).auth).toBe(a);
    expect(detectPlatform({ velocityDesktop: bridge({ ...a, session: undefined }) }).auth).toBeNull();
    expect(detectPlatform({ velocityDesktop: bridge({ begin: a.begin }) }).auth).toBeNull();
    expect(detectPlatform({ velocityDesktop: bridge(undefined) }).auth).toBeNull();
    expect(detectPlatform(undefined).auth).toBeNull();
  });
});
