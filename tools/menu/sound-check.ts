/**
 * Menü-Klänge (src/ui/menuSound.ts): zählt erzeugte Oszillatoren als Klang-Beleg — PS2-Stil (Pfeile, Enter, Esc)
 * und klassischer Stil (Fokus/Tasten). Ohne Autoplay-Sperre, der Ton startet mit der ersten Taste.
 *   npx tsx tools/menu/sound-check.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = 5732;
let fails = 0;
const check = (ok: boolean, name: string, detail: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) fails++;
};

// Wie tools/lib/devServer.mjs (dort ohne Typen). Stil kommt per ?menu=, kein Test-Pin.
delete process.env.VITE_TEST_MENU_STYLE;
const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const srv = { url: `http://localhost:${PORT}/`, close: () => vite.close() };
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const style of ['ps2', 'classic'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      // Menü-Blips an ihren Tönen erkennen (TechnoAudio UI_NOTES): Rechteck mit 1760 / 1046.5 / 784 Hz als erste Note.
      const w = window as unknown as { __ui: string[]; __all: OscillatorNode[] };
      w.__ui = [];
      w.__all = [];
      const orig = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (this: AudioContext) {
        const o = orig.call(this);
        w.__all.push(o);
        return o;
      };
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
        const hz = this.frequency.value;
        if (this.type === 'square') {
          if (hz === 1760) w.__ui.push('move');
          else if (Math.abs(hz - 1046.5) < 0.01) w.__ui.push('confirm');
          else if (hz === 784) w.__ui.push('back');
        }
        return start.call(this, when);
      };
    });
    await page.goto(`${srv.url}?menu=${style}`);
    await page.waitForSelector('.vel-menu:not([hidden])');
    await page.waitForTimeout(1500);
    const ui = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __ui: string[] }).__ui.slice());
    const osc = (): Promise<number> => page.evaluate(() => (window as unknown as { __all: unknown[] }).__all.length);
    // Erste Taste = Geste → Ton startet (Musik-Aufbau legt eigene Oszillatoren an).
    await page.keyboard.press('Shift');
    await page.waitForTimeout(1500);
    const base = await osc();
    check(base > 0, `${style}: Ton im Menü gestartet`, `${base} Oszillatoren nach erster Taste`);
    if (style === 'ps2') {
      // Boot überspringen, dann bewegen.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
    }
    const step = async (key: string, want: string): Promise<void> => {
      const n = (await ui()).length;
      await page.keyboard.press(key);
      await page.waitForTimeout(400);
      const got = (await ui()).slice(n);
      const where = await page.evaluate(() => {
        const m = document.querySelector('.vel-menu');
        const st = document.querySelector('.ps2-stage, [data-view]');
        return `${m?.querySelector(':scope > *')?.className ?? '?'} ${st?.getAttribute('data-view') ?? ''} ${document.activeElement?.tagName ?? ''}`;
      });
      check(want === 'none' ? got.length === 0 : got.length === 1 && got[0] === want, `${style}: ${key} → ${want}`, `[${got.join(', ')}] @ ${where}`);
    };
    await page.waitForTimeout(400);
    await step('ArrowDown', 'move');
    await step('ArrowDown', 'move');
    if (style === 'ps2') {
      // Nach dem Boot-Sprung steht die Disc-Bahn: Esc = zurück ins Hauptmenü, dort bewegen.
      await step('Escape', 'back');
      await step('ArrowDown', 'move');
      await step('Escape', 'none');
    }
    await step('Enter', 'confirm');
    if (style === 'classic') {
      // Level läuft → Esc öffnet die Pause (still), Esc dort ohne Wirkung (still), Enter = Weiter.
      await step('Escape', 'none');
      await step('Escape', 'none');
      await step('Enter', 'confirm');
    }
    check(errors.length === 0, `${style}: keine Seitenfehler`, errors.join(' | ') || '0');
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
process.exit(fails === 0 ? 0 : 1);
