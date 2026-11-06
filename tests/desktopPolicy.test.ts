import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCsp, isAppUrl, isExternalAllowed, mimeFor, resolveAppPath, sanitizeOrigin } from '../electron/policy';

/** Plan 011 §2.1: Regeln der Electron-Hülle (ohne Electron, reine Funktionen). */
describe('Desktop-Protokoll app://velocity', () => {
  const root = resolve('dist');

  it('löst Pfade unter dist/ auf, "/" → index.html, Query zählt nicht', () => {
    expect(resolveAppPath(root, 'app://velocity/')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://velocity/index.html?online=mock#x')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://velocity/levels/index.json')).toBe(join(root, 'levels', 'index.json'));
    expect(resolveAppPath(root, 'app://velocity/assets/a%20b.js')).toBe(join(root, 'assets', 'a b.js'));
  });

  it('kein Ausbruch aus dist/, kein fremder Host/Scheme', () => {
    // %2e%2e ist für den URL-Parser ein Punkt-Segment: wird schon dort zu /package.json (bleibt in dist/, 404).
    expect(resolveAppPath(root, 'app://velocity/%2e%2e/package.json')).toBe(join(root, 'package.json'));
    expect(resolveAppPath(root, 'app://velocity/..%5c..%5cpackage.json')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/%2e%2e%2f%2e%2e%2fwindows')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/C:%5cWindows%5cwin.ini')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/index.html::$DATA')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/a%00b')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/%E0%A4%A')).toBeNull();
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppPath(root, 'file:///C:/Windows/win.ini')).toBeNull();
  });

  it('MIME je Endung', () => {
    expect(mimeFor('a.js')).toMatch(/^text\/javascript/);
    expect(mimeFor('a.JSON')).toMatch(/^application\/json/);
    expect(mimeFor('a.woff2')).toBe('font/woff2');
    expect(mimeFor('a.unknown')).toBe('application/octet-stream');
  });

  it('CSP: Skripte nur aus dem Paket, Supabase nur wenn bekannt', () => {
    const c = buildCsp('https://abc.supabase.co');
    expect(c).toContain("script-src 'self'");
    expect(c).not.toMatch(/script-src[^;]*unsafe/);
    expect(c).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co");
    expect(buildCsp(null)).toContain("connect-src 'self';");
  });

  it('Navigation nur auf die eigene Origin bzw. den lokalen Dev-Server', () => {
    expect(isAppUrl('app://velocity/index.html', null)).toBe(true);
    expect(isAppUrl('app://velocity.evil/index.html', null)).toBe(false);
    expect(isAppUrl('https://example.com/', null)).toBe(false);
    expect(isAppUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/x', 'http://localhost:5173')).toBe(false);
  });

  it('externe Links: nur https auf Discord und dem eigenen Supabase', () => {
    const sb = 'https://abc.supabase.co';
    expect(isExternalAllowed('https://discord.com/oauth2/authorize?x=1', sb)).toBe(true);
    expect(isExternalAllowed('https://cdn.discord.com/x', sb)).toBe(true);
    expect(isExternalAllowed('https://abc.supabase.co/auth/v1/authorize', sb)).toBe(true);
    expect(isExternalAllowed('https://evil.supabase.co/', sb)).toBe(false);
    expect(isExternalAllowed('https://discord.com.evil.io/', sb)).toBe(false);
    expect(isExternalAllowed('http://discord.com/', sb)).toBe(false);
    expect(isExternalAllowed('https://user:pw@discord.com/', sb)).toBe(false);
    expect(isExternalAllowed('file:///C:/x', sb)).toBe(false);
    expect(isExternalAllowed('javascript:alert(1)', sb)).toBe(false);
  });

  it('sanitizeOrigin nimmt nur https-Origins', () => {
    expect(sanitizeOrigin('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co');
    expect(sanitizeOrigin('http://abc.supabase.co')).toBeNull();
    expect(sanitizeOrigin('kaputt')).toBeNull();
    expect(sanitizeOrigin(undefined)).toBeNull();
  });
});
