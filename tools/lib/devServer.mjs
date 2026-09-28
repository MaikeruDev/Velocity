/**
 * Startet einen Vite-Dev-Server im selben Prozess (für Playwright-Tools).
 * Jedes Tool nimmt einen eigenen Port, damit parallele Läufe sich nicht stören.
 *
 *   const srv = await startDevServer(5181);
 *   await page.goto(`${srv.url}dev/render.html`);
 *   await srv.close();
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

export async function startDevServer(port) {
  const server = await createServer({
    configFile: 'vite.config.ts',
    server: { port, strictPort: true, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  return { url: `http://localhost:${port}/`, close: () => server.close() };
}

/** Chromium mit echter GPU über ANGLE (headless WebGL2 funktioniert so) und ohne Autoplay-Sperre. */
export function launchBrowser() {
  return chromium.launch({
    args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
}
