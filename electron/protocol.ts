/**
 * `app://velocity/` → Vite-`dist/` (Plan 011 §2.2.9). Eigenes Protokoll statt file://: stabile Origin
 * (localStorage bleibt über Updates gleich), Secure Context (Gamepad API), fetch der Level-JSON, CSP als Header.
 */
import { readFile } from 'node:fs/promises';
import { protocol, type Session } from 'electron';
import { APP_SCHEME, mimeFor, resolveAppPath } from './policy.js';

/** Muss VOR app.ready laufen (Electron-Vorgabe). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

export function handleAppProtocol(session: Session, root: string, csp: string): void {
  session.protocol.handle(APP_SCHEME, async (req) => {
    const file = resolveAppPath(root, req.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      // Gesamte Datei lesen: die größten Assets sind ~1.5 MB, Streaming lohnt nicht. Funktioniert auch in app.asar.
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': mimeFor(file),
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
