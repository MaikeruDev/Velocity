/** Ausschnitt eines PNG vergroessert speichern (via Chromium, keine Extra-Deps).
 *   node tools/critique/look/crop.mjs in.png out.png x y w h [zoom]  */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const [inp, out, x, y, w, h, zoom = '2'] = process.argv.slice(2);
const b64 = readFileSync(inp).toString('base64');
const z = Number(zoom);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w) * z, height: Number(h) * z } });
await page.setContent(`<body style="margin:0;overflow:hidden"><div style="width:${w * z}px;height:${h * z}px;overflow:hidden;position:relative"><img id="i" src="data:image/png;base64,${b64}" style="position:absolute;left:${-x * z}px;top:${-y * z}px;image-rendering:pixelated;transform-origin:0 0;transform:scale(${z})"></div></body>`);
await page.waitForFunction(() => document.getElementById('i').complete);
await page.screenshot({ path: out });
await browser.close();
