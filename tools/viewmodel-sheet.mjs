/**
 * Viewmodel-Kontaktblatt ohne Spiel (Plan 006): rendert Kacheln über dev/viewmodel.html.
 *   node tools/viewmodel-sheet.mjs <spec.json> <out.png>
 * spec.json: { "w": 480, "h": 270, "zoom": 2, "depth": 34, "cells": [ {pose, item, frame, …}, … ] }
 * Port VMSHEET_PORT (Default 5282).
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const [specPath, outPath] = process.argv.slice(2);
if (!specPath || !outPath) {
  console.error('node tools/viewmodel-sheet.mjs <spec.json> <out.png>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const PORT = Number(process.env.VMSHEET_PORT ?? 5282);
mkdirSync(dirname(outPath), { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const cols = spec.cols ?? 4;
  const width = Math.min(3800, cols * (spec.w * spec.zoom + 6) + 12);
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
  });
  await page.goto(`${srv.url}dev/viewmodel.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vm !== undefined);
  await page.evaluate((s) => window.__vm.render(s.cells, { w: s.w, h: s.h, zoom: s.zoom, depth: s.depth }), spec);
  const el = await page.$('#sheet');
  await el.screenshot({ path: outPath });
  await page.close();
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`→ ${outPath}`);
