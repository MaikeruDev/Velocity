/**
 * Desktop-Login (Plan 011 §3.1, RFC 8252 §7.3): Discord-Login im SYSTEM-Browser, Rücksprung auf einen kurzlebigen
 * HTTP-Empfänger auf 127.0.0.1. Kein eingebettetes Login-Fenster (keine echte Adressleiste, Passwort-Manager/2FA
 * fehlen, Anbieter blocken es), kein Custom-Protocol (Registry je Installation) — Plan 011 §2.2.11.
 *
 *   begin()     Empfänger auf dem ersten freien Port aus AUTH_PORTS → Rücksprung-Adresse mit eigenem `state`.
 *   (Renderer)  supabase-js `signInWithOAuth(skipBrowserRedirect)` mit dieser Adresse → Auth-URL. Der PKCE-Verifier
 *               bleibt im Storage des Renderers; der Hauptprozess sieht nur den einmaligen Code.
 *   open(url)   nur die Supabase-Authorize-URL mit GENAU dieser Rücksprung-Adresse → System-Browser, dann warten auf
 *               `?state=…&code=…` bzw. `?state=…&error=…`, höchstens AUTH_TIMEOUT_MS ab dem letzten Öffnen.
 *   Rücksprung  state stimmt → Pixel-Seite, Ergebnis an den Renderer, Server zu: genau EIN Callback. Ohne/mit falschem
 *               state → 400 und weiter warten, damit eine fremde Seite (fetch auf 127.0.0.1) den Versuch nicht verbraucht.
 *
 * Supabase Auth nimmt Loopback-IPs mit beliebigem Port, Pfad und Query OHNE Eintrag in den Redirect URLs an
 * (GoTrue `IsRedirectURLValid` → `ip.IsLoopback()`; am Live-Projekt am 06.11. per simuliertem Abbruch geprüft:
 * Rücksprung samt eigenem `state` kam an). Ändert Supabase das, landet der Browser auf der Site-URL statt hier — dann
 * meldet nur die Zeitüberschreitung den Fehler (Text nennt den Grund); die Einträge dafür stehen in Plan 011 §8.
 *
 * Reine Logik ohne Electron-Import (Vitest: tests/desktopAuth.test.ts); verdrahtet in electron/authModule.ts.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DesktopAuthBegin, DesktopAuthError, DesktopAuthFailure, DesktopAuthResult } from '../src/platform/bridgeTypes.js';

/** Feste Ports: müsste Supabase Loopback-Adressen je einzeln erlauben, stehen genau diese im Dashboard (Plan 011 §8). */
export const AUTH_PORTS: readonly number[] = [47823, 47824, 47825];
export const AUTH_HOST = '127.0.0.1';
export const AUTH_PATH = '/auth/callback';
/** Danach ist der Empfänger zu — ein Discord-Login mit 2FA dauert selten länger. */
export const AUTH_TIMEOUT_MS = 5 * 60_000;
/** IPC-Kanäle (gespiegelt in preload.cts — der Sandbox-Preload darf nichts importieren). */
export const AUTH_IPC = {
  begin: 'vel:auth:begin',
  open: 'vel:auth:open',
  cancel: 'vel:auth:cancel',
  sessionRead: 'vel:auth:session:read',
  sessionWrite: 'vel:auth:session:write',
  sessionRemove: 'vel:auth:session:remove',
} as const;

/** GoTrue-Codes sind UUIDs; großzügig, aber nur URL-sichere Zeichen (landen nie in HTML, nur im IPC). */
const CODE_RE = /^[A-Za-z0-9._~-]{8,512}$/;

export interface LoopbackLoginOptions {
  /** https-Origin des Supabase-Projekts (desktop-config.json); null = Online am Desktop aus → open() lehnt ab. */
  readonly supabaseOrigin: string | null;
  /** Geprüfte Adresse im System-Browser öffnen; false = abgelehnt/fehlgeschlagen. */
  openExternal(url: string): Promise<boolean>;
  /** Nach einem gültigen Rücksprung (Hauptprozess: Spielfenster nach vorn). */
  readonly onReturn?: () => void;
  readonly ports?: readonly number[];
  readonly timeoutMs?: number;
}

interface Attempt {
  readonly server: Server;
  readonly port: number;
  readonly state: Buffer;
  readonly redirectUrl: string;
  readonly result: Promise<DesktopAuthResult>;
  readonly resolve: (r: DesktopAuthResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Ab jetzt zählt kein Rücksprung mehr (Ergebnis steht oder steht gleich fest). */
  done: boolean;
  settled: boolean;
  closed: Promise<void> | null;
}

export function authFailure(error: DesktopAuthError, detail: string): DesktopAuthFailure {
  return { ok: false, error, detail };
}

/** Die einzige Adresse, die der Login öffnen darf: Supabase-Authorize für Discord mit genau diesem Rücksprung. */
export function isAuthorizeUrl(url: string, supabaseOrigin: string | null, redirectUrl: string): boolean {
  if (!supabaseOrigin) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.origin === supabaseOrigin &&
    u.pathname === '/auth/v1/authorize' &&
    u.searchParams.get('provider') === 'discord' &&
    u.searchParams.get('redirect_to') === redirectUrl
  );
}

function portRange(ports: readonly number[]): string {
  const first = ports[0];
  const last = ports[ports.length - 1];
  return first === undefined ? '–' : first === last ? String(first) : `${first}–${last}`;
}

/** Fremdtext (error_description) für Seite und Meldung: einzeilig, kurz. */
function cleanText(v: string | null): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160);
}

function sameState(expected: Buffer, got: string | null): boolean {
  if (got === null) return false;
  const b = Buffer.from(got, 'utf8');
  return b.length === expected.length && timingSafeEqual(b, expected);
}

/** Server auf genau diesem Port starten; jeder Fehler (EADDRINUSE, EACCES für von Windows reservierte Bereiche …) = nächster. */
function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => {
      server.off('listening', onListening);
      resolve(false);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: AUTH_HOST });
  });
}

export class LoopbackLogin {
  private attempt: Attempt | null = null;

  constructor(private readonly opts: LoopbackLoginOptions) {}

  /** Port des laufenden Empfängers (null = keiner). */
  get port(): number | null {
    const a = this.attempt;
    return a && !a.done ? a.port : null;
  }

  async begin(): Promise<DesktopAuthBegin> {
    // Ein neuer Versuch ersetzt den alten (z. B. Seite neu geladen): dessen Wartende bekommen 'cancelled', der Port wird frei.
    await this.finish(this.attempt, authFailure('cancelled', 'Ein neuer Login-Versuch wurde gestartet.'));
    const ports = this.opts.ports ?? AUTH_PORTS;
    for (const port of ports) {
      const server = createServer();
      // Kurze Fristen: eine liegen gelassene Verbindung hält den Empfänger nicht offen.
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 1_000;
      server.maxConnections = 16;
      if (!(await listenOn(server, port))) continue;
      const stateHex = randomBytes(16).toString('hex');
      let resolve: (r: DesktopAuthResult) => void = () => {};
      const result = new Promise<DesktopAuthResult>((r) => {
        resolve = r;
      });
      const a: Attempt = {
        server,
        port,
        state: Buffer.from(stateHex, 'utf8'),
        redirectUrl: `http://${AUTH_HOST}:${port}${AUTH_PATH}?state=${stateHex}`,
        result,
        resolve,
        timer: null,
        done: false,
        settled: false,
        closed: null,
      };
      server.on('request', (req: IncomingMessage, res: ServerResponse) => this.onRequest(a, req, res));
      // Fehler nach dem Start (selten): Versuch beenden statt still weiterzuwarten.
      server.on('error', () => void this.finish(a, authFailure('ports', 'Der Login-Empfänger ist ausgefallen.')));
      this.attempt = a;
      this.arm(a);
      return { ok: true, redirectUrl: a.redirectUrl };
    }
    return authFailure('ports', `Die Login-Ports ${portRange(ports)} sind belegt — ein anderes Programm nutzt sie.`);
  }

  /** Auth-URL öffnen (auch erneut: zweiter Klick, Browser-Tab zu) und auf DENSELBEN Rücksprung warten. */
  async open(url: string): Promise<DesktopAuthResult> {
    const a = this.attempt;
    if (!a || a.done) return authFailure('cancelled', 'Kein laufender Login-Versuch — bitte erneut anmelden.');
    if (!isAuthorizeUrl(url, this.opts.supabaseOrigin, a.redirectUrl)) {
      return authFailure('url', 'Diese Anmelde-Adresse ist am Desktop nicht erlaubt.');
    }
    // Frist ab dem letzten Öffnen: wer den Tab schließt und neu öffnet, hat wieder volle Zeit.
    this.arm(a);
    let opened = false;
    try {
      opened = await this.opts.openExternal(url);
    } catch {
      opened = false;
    }
    if (!opened) await this.finish(a, authFailure('open', 'Der Browser ließ sich nicht öffnen.'));
    return a.result;
  }

  /** Laufenden Versuch abbrechen (Spiel beendet, Anmelde-URL nicht erzeugbar). */
  cancel(): Promise<void> {
    return this.finish(this.attempt, authFailure('cancelled', 'Login abgebrochen.'));
  }

  // ------------------------------------------------------------------ intern

  private arm(a: Attempt): void {
    if (a.timer !== null) clearTimeout(a.timer);
    const ms = this.opts.timeoutMs ?? AUTH_TIMEOUT_MS;
    a.timer = setTimeout(() => {
      const min = Math.max(1, Math.round(ms / 60_000));
      void this.finish(
        a,
        authFailure('timeout', `Keine Rückmeldung aus dem Browser (${min} min). Kam dort keine Seite „Login fertig“, nimmt Supabase die Rücksprung-Adresse nicht an.`),
      );
    }, ms);
  }

  private settle(a: Attempt, r: DesktopAuthResult): void {
    a.done = true;
    if (a.settled) return;
    a.settled = true;
    if (a.timer !== null) clearTimeout(a.timer);
    a.timer = null;
    if (this.attempt === a) this.attempt = null;
    a.resolve(r);
  }

  /** Server zu; das Versprechen erfüllt sich, wenn der Port wirklich frei ist (begin() nimmt ihn sonst nicht wieder). */
  private shutdown(a: Attempt): Promise<void> {
    if (a.closed === null) {
      a.closed = new Promise<void>((resolve) => {
        a.server.close(() => resolve());
        a.server.closeAllConnections();
      });
    }
    return a.closed;
  }

  private finish(a: Attempt | null, r: DesktopAuthFailure): Promise<void> {
    if (!a) return Promise.resolve();
    this.settle(a, r);
    return this.shutdown(a);
  }

  private onRequest(a: Attempt, req: IncomingMessage, res: ServerResponse): void {
    const host = `${AUTH_HOST}:${a.port}`;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      sendPage(res, 400, 'error', 'Ungültige Anfrage.');
      return;
    }
    if (req.method !== 'GET' || url.pathname !== AUTH_PATH) {
      sendPage(res, 404, 'error', 'Nicht gefunden.');
      return;
    }
    // Host-Kopf zusätzlich zum state: DNS-Rebinding einer fremden Seite trüge deren Namen.
    if (req.headers.host !== host) {
      sendPage(res, 400, 'error', 'Ungültige Anfrage.');
      return;
    }
    if (a.done) {
      sendPage(res, 410, 'error', 'Dieser Login ist schon abgeschlossen.');
      return;
    }
    if (!sameState(a.state, url.searchParams.get('state'))) {
      sendPage(res, 400, 'error', 'Dieser Link gehört zu keinem laufenden Login. Bitte im Spiel neu anmelden.');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    let r: DesktopAuthResult;
    if (code !== null && CODE_RE.test(code)) r = { ok: true, code };
    else if (error === 'access_denied') {
      // Auch "Registrierung aus", "gesperrt": GoTrue meldet all das als access_denied, der Grund steht in der Beschreibung.
      const why = cleanText(url.searchParams.get('error_description'));
      r = authFailure('denied', `Anmeldung abgebrochen oder abgelehnt${why ? ` (${why})` : ''}.`);
    } else if (error !== null) {
      const why = cleanText(url.searchParams.get('error_description')) || cleanText(error);
      r = authFailure('provider', `Discord/Supabase meldet einen Fehler: ${why}.`);
    } else r = authFailure('provider', 'Rücksprung ohne Anmelde-Code.');
    // Genau ein Callback: Ergebnis sofort festhalten, Server erst zu, wenn die Seite beim Browser ist. Die Frist ist
    // damit gelöscht — bricht der Browser vorher ab (kein 'close' mehr), schließt der Rückfall-Timer.
    this.settle(a, r);
    res.once('close', () => void this.shutdown(a));
    setTimeout(() => void this.shutdown(a), 3_000).unref();
    if (r.ok) {
      sendPage(res, 200, 'ok', 'Zurück zum Spiel — dieses Fenster kannst du schließen.');
      this.opts.onReturn?.();
    } else sendPage(res, 200, 'stop', `${r.detail} Im Spiel kannst du es erneut versuchen.`);
  }
}

// ------------------------------------------------------------------ Pixel-Seite (ohne Datei, Font oder Skript)

/** Versalien aus dem HUD-Font (src/ui/glyphs.ts, 5×7) — nur die Titel-Buchstaben; die Hülle packt src/ nicht mit ein. */
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
};

/** Titel als EIN SVG-Pfad aus ganzen Pixeln (Läufe je Zeile) — scharf bei jeder Größe, CSP-neutral (Attribute, kein Stil). */
export function pixelTitle(text: string): { readonly d: string; readonly width: number } {
  let x = 0;
  const parts: string[] = [];
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) {
      x += 3; // Leerzeichen (und alles ohne Glyphe)
      continue;
    }
    g.forEach((row, y) => {
      let run = -1;
      for (let i = 0; i <= row.length; i++) {
        const on = row[i] === '#';
        if (on && run < 0) run = i;
        else if (!on && run >= 0) {
          parts.push(`M${x + run} ${y}h${i - run}v1h${run - i}z`);
          run = -1;
        }
      }
    });
    x += (g[0]?.length ?? 0) + 1;
  }
  return { d: parts.join(''), width: Math.max(1, x - 1) };
}

type PageKind = 'ok' | 'stop' | 'error';

const PAGES: Readonly<Record<PageKind, { readonly title: string; readonly label: string; readonly ink: string }>> = {
  ok: { title: 'LOGIN FERTIG', label: 'Login fertig', ink: '#3df2ff' },
  stop: { title: 'ABGEBROCHEN', label: 'Abgebrochen', ink: '#ffd23d' },
  error: { title: 'FEHLER', label: 'Fehler', ink: '#ff4d6d' },
};

// Nacht-Techno-Look des Spiels: harte Kanten, Dither-Raster als Hintergrund, Versatz-Schatten statt weichem Glow (look.md).
const PAGE_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0}',
  'body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;' +
    'background:#07061a repeating-conic-gradient(#110d33 0 25%,#07061a 0 50%) 0 0/4px 4px;color:#e8e6ff;' +
    'font:16px/1.5 Consolas,"Lucida Console","Courier New",monospace}',
  'main{width:100%;max-width:620px;padding:24px 28px 26px;background:#0c0a28;border:4px solid #ff3df2;box-shadow:8px 8px 0 #000;text-align:center}',
  '.brand{margin:0 0 18px;color:#ff3df2;font-weight:bold;letter-spacing:6px}',
  'svg{display:block;width:100%;height:auto;margin:0 0 20px}',
  'p{margin:0}',
].join('');
const PAGE_CSS_HASH = createHash('sha256').update(PAGE_CSS).digest('base64');
/** Nur dieser eine Stilblock; keine Skripte, Bilder, Fonts, Formulare, Einbettung. */
export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${PAGE_CSS_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function authPage(kind: PageKind, text: string): string {
  const p = PAGES[kind];
  const t = pixelTitle(p.title);
  return (
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">' +
    `<title>VELOCITY · ${escapeHtml(p.label)}</title><style>${PAGE_CSS}</style></head><body><main>` +
    '<p class="brand">VELOCITY</p>' +
    `<svg viewBox="0 0 ${t.width + 1} 8" role="img" aria-label="${escapeHtml(p.label)}" shape-rendering="crispEdges">` +
    // Schatten 1 Font-Pixel versetzt, dunkel genug, dass er nicht als zweite Glyphe gelesen wird.
    `<path transform="translate(1 1)" fill="#2a0c3c" d="${t.d}"/><path fill="${p.ink}" d="${t.d}"/></svg>` +
    `<p>${escapeHtml(text)}</p></main></body></html>`
  );
}

function sendPage(res: ServerResponse, status: number, kind: PageKind, text: string): void {
  const body = authPage(kind, text);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Security-Policy': PAGE_CSP,
    // Die URL trägt den Code: nicht cachen, nicht weiterreichen.
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(body);
}
