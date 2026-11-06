/**
 * Fit-Zoom für die Bestands-Screens im ps2-Stil (Training, Bestenliste, Kosmetik, Einstellungen, Steuerung, Labor,
 * Profil, Admin). Menu.ts baut sie mit klassischen Maßen; ein fester Zoom ließ sie scrollen (1080p) oder winzig oben
 * kleben (1440p). Hier: je Screen die größte Stufe aus ZOOMS, bei der Inhalt UND Breite passen — sonst 1 (scrollt wie
 * classic) — und den Block mit dem Rest-Platz ins obere Drittel setzen.
 *
 * Läuft bewusst über die Lebenszeit der Front Door hinaus (die ist abgebaut, solange diese Screens offen sind): die
 * Front Door meldet ihn beim Mount an; er meldet sich selbst ab, sobald der Menü-Root den Stil verliert. Kein Frame-Pfad:
 * gemessen wird nur bei Screenwechsel, Größenänderung und Inhaltsänderung (zusammengefasst auf einen rAF).
 */

/** Stufen, bei denen Silkscreen scharf bleibt: 16 px → 16/24/32. */
const ZOOMS = [2, 1.5, 1] as const;
/** Screens, die der Fitter anfasst (= die "nativen" Screens in ps2.css). */
const SCREENS = new Set(['training', 'leaderboard', 'cosmetics', 'settings', 'controls', 'lab', 'profile', 'admin']);
/** Platz unter dem Screen für Fußlinie + Prompt (CSS-px bei Zoom 1, skaliert mit). Muss zu ps2.css passen. */
const FOOT = 52;
/** Polster über dem Inhalt bei Zoom 1 (CSS-px). Muss zu ps2.css passen. */
const PAD_TOP = 16;
/** Mindest-Layoutbreite der klassischen Screens (CSS-px) — schmaler bricht ihr Raster um. */
const MIN_LAYOUT_W = 1180;
/** Rest-Platz: dieser Anteil kommt nach oben (0.5 = mittig; etwas weniger = angenehm im oberen Drittel). */
const UPPER = 0.4;

interface Fitter {
  stop(): void;
}

const active = new WeakMap<HTMLElement, Fitter>();

/**
 * Natürliche Inhaltshöhe in visuellen px: Unterkante des tiefsten Kindes (ohne fixierte, z. B. die Prompt-Leiste)
 * minus Oberkante des Screens, plus unteres Polster. height:auto ginge nicht — der Menü-Root ist ein Flex-Container mit
 * align-items: stretch und zöge den Screen wieder auf volle Höhe.
 */
function contentHeight(el: HTMLElement, z: number): number {
  const top = el.getBoundingClientRect().top - el.scrollTop * z;
  let bottom = top;
  for (const c of Array.from(el.children)) {
    if (!(c instanceof HTMLElement) || getComputedStyle(c).position === 'fixed') continue;
    const r = c.getBoundingClientRect();
    if (r.height > 0) bottom = Math.max(bottom, r.bottom);
  }
  const padB = parseFloat(getComputedStyle(el).paddingBottom) || 0;
  return bottom - top + padB * z;
}

export function installFitter(menu: HTMLElement): void {
  if (active.has(menu)) return;
  let raf = 0;
  let measuring = false;

  const clear = (): void => {
    menu.style.removeProperty('--ps2-fit');
    menu.style.removeProperty('--ps2-fit-pad');
    delete menu.dataset.ps2Fit;
    delete menu.dataset.ps2Fill;
  };

  const fit = (): void => {
    raf = 0;
    if (!menu.classList.contains('vel-style--ps2')) {
      stop();
      return;
    }
    const screen = menu.dataset.screen ?? '';
    const el = menu.querySelector<HTMLElement>(':scope > .vel-screen');
    if (!SCREENS.has(screen) || !el) {
      clear();
      return;
    }
    measuring = true;
    const H = menu.clientHeight;
    const W = menu.clientWidth;
    let chosen = 1;
    let content = 0;
    for (const z of ZOOMS) {
      if (z > 1 && W / z - 80 < MIN_LAYOUT_W) continue;
      menu.style.setProperty('--ps2-fit', String(z));
      menu.style.setProperty('--ps2-fit-pad', `${PAD_TOP}px`);
      // auch das Attribut: CSS bemaßt z. B. die Hand-Vorschau je Stufe anders
      menu.dataset.ps2Fit = String(z);
      const h = contentHeight(el, z);
      const avail = H - FOOT * z;
      if (h <= avail || z === 1) {
        chosen = z;
        content = h;
        break;
      }
    }
    const avail = H - FOOT * chosen;
    const spare = Math.max(0, avail - content);
    // Polster ist im gezoomten Element → in CSS-px dieses Elements umrechnen
    menu.style.setProperty('--ps2-fit', String(chosen));
    menu.style.setProperty('--ps2-fit-pad', `${PAD_TOP + (spare * UPPER) / chosen}px`);
    menu.dataset.ps2Fit = String(chosen);
    menu.dataset.ps2Fill = (Math.min(content, avail) / avail).toFixed(2);
    measuring = false;
  };

  const schedule = (): void => {
    if (measuring || raf !== 0) return;
    raf = requestAnimationFrame(fit);
  };

  const mo = new MutationObserver(schedule);
  // Screenwechsel (data-screen, class) am Root; Inhalt (Bestenliste lädt, Einstellungen klappen auf) im Baum
  mo.observe(menu, { attributes: true, attributeFilter: ['data-screen', 'class'], childList: true, subtree: true, characterData: true });
  const ro = new ResizeObserver(schedule);
  ro.observe(menu);
  document.fonts?.ready.then(schedule).catch(() => undefined);

  const stop = (): void => {
    cancelAnimationFrame(raf);
    raf = 0;
    mo.disconnect();
    ro.disconnect();
    clear();
    active.delete(menu);
  };
  active.set(menu, { stop });
  schedule();
}
