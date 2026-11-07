/**
 * Räumliche Fokus-Navigation für DOM-Screens (Plan 011 §1.5): Steuerkreuz/Stick bewegen einen sichtbaren Pad-Fokus
 * über die bedienbaren Elemente, A aktiviert ihn, Slider ändern ihren Wert mit links/rechts.
 *
 * Bewusst KEIN echter DOM-Fokus: ein fokussierter Knopf würde von Enter/Leertaste aus dem Spiel ausgelöst (Menu.render
 * nimmt den Fokus darum weg). Der Pad-Fokus ist nur die Klasse `is-padfocus`; sichtbar wird sie per CSS erst, wenn das
 * Menü `data-input="pad"` trägt. Nur Textfelder bekommen beim Aktivieren echten Fokus (Tippen, Steam-Tastatur).
 *
 * Geometrie (pickInDirection) ist rein und DOM-frei (Vitest). Menü-Code, kein Frame-Pfad.
 */

export interface NavRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Bester Kandidat in Richtung (dx, dy) ∈ {−1,0,1}² (eine Achse), −1 = keiner.
 * Ein Kandidat muss JENSEITS der eigenen Kante liegen (Toleranz ¼ der kleineren Größe) — nur "Mittelpunkt liegt in
 * Richtung" machte angehobene Nachbarn zu "darunter" (fallen.md #242). Wertung: Abstand entlang der Achse plus das
 * Dreifache des Querversatzes zwischen den Spannen (überlappende Spannen = 0), Gleichstand → näherer Mittelpunkt.
 */
export function pickInDirection(from: NavRect, cands: readonly NavRect[], dx: number, dy: number): number {
  let best = -1;
  let bestScore = Infinity;
  let bestTie = Infinity;
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    let along: number;
    let cross: number;
    if (dx !== 0) {
      const tol = Math.min(from.w, c.w) / 4;
      if (dx > 0 ? c.x < from.x + from.w - tol : c.x + c.w > from.x + tol) continue;
      along = dx > 0 ? c.x - (from.x + from.w) : from.x - (c.x + c.w);
      cross = spanGap(from.y, from.y + from.h, c.y, c.y + c.h);
    } else {
      const tol = Math.min(from.h, c.h) / 4;
      if (dy > 0 ? c.y < from.y + from.h - tol : c.y + c.h > from.y + tol) continue;
      along = dy > 0 ? c.y - (from.y + from.h) : from.y - (c.y + c.h);
      cross = spanGap(from.x, from.x + from.w, c.x, c.x + c.w);
    }
    const score = Math.max(0, along) + 3 * cross;
    const tie = Math.hypot(c.x + c.w / 2 - fcx, c.y + c.h / 2 - fcy);
    if (score < bestScore - 0.5 || (Math.abs(score - bestScore) <= 0.5 && tie < bestTie)) {
      best = i;
      bestScore = score;
      bestTie = tie;
    }
  }
  return best;
}

/** Abstand zweier Spannen [a0,a1] und [b0,b1] (0 bei Überlappung). */
function spanGap(a0: number, a1: number, b0: number, b1: number): number {
  if (b1 < a0) return a0 - b1;
  if (b0 > a1) return b0 - a1;
  return 0;
}

/**
 * Fokus nach einem Teil-Neuaufbau wiederfinden (rein, Vitest): dieselbe Signatur am nächsten zur alten Position; fehlt
 * sie, der Platz an der alten Position (geklemmt) — `lost`: dieses Element hat der Spieler nie gewählt (Review B3: vorher
 * fiel der Fokus auf null und das nächste A klickte blind das Startelement). index −1 = nichts bedienbar oder es gab
 * keinen Fokus (key '').
 */
export function refocusIndex(keys: readonly string[], key: string, index: number): { readonly index: number; readonly lost: boolean } {
  if (keys.length === 0 || key === '') return { index: -1, lost: false };
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== key) continue;
    const d = Math.abs(i - index);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  if (best >= 0) return { index: best, lost: false };
  return { index: Math.min(Math.max(index, 0), keys.length - 1), lost: true };
}

/** Was als bedienbar zählt. [data-pad-focus] macht beliebige Elemente erreichbar, [data-pad-skip] nimmt sie heraus. */
export const PAD_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [data-pad-focus]';

export interface PadNavOptions {
  /** Nach jedem Fokuswechsel (z. B. Hover-Zustand des Stils nachziehen). */
  readonly onFocus?: (el: HTMLElement) => void;
  /** Startelement eines Screens (null = Standardregel, siehe initial()). */
  readonly initial?: (els: readonly HTMLElement[]) => HTMLElement | null;
  /** Elemente ausschließen (zusätzlich zu [data-pad-skip]). */
  readonly exclude?: (el: HTMLElement) => boolean;
}

/** Zustands-Klassen, die nicht zur Wiedererkennung eines Elements nach einem Neuaufbau zählen. */
const STATE_CLASS = /^(is-|vel-padfocus)/;

export class PadNav {
  private root: HTMLElement | null = null;
  private cur: HTMLElement | null = null;
  /** Wiedererkennung nach Neuaufbau: Signatur + Position in der Liste. */
  private key = '';
  private index = -1;
  private observer: MutationObserver | null = null;
  private restorePending = false;
  /** Fokus kam per Rückfall auf ein anderes Element (Neuaufbau): das nächste A zeigt ihn nur, statt blind auszulösen. */
  private unseen = false;
  private readonly opts: PadNavOptions;

  constructor(opts: PadNavOptions = {}) {
    this.opts = opts;
  }

  /** Neuer Bereich (neuer Screen / Ansicht). keep = Fokus-Merker behalten (gleiche Ansicht neu gebaut). */
  setRoot(root: HTMLElement | null, keep = false): void {
    if (root !== this.root) {
      this.observer?.disconnect();
      this.observer = null;
      this.root = root;
      if (root && typeof MutationObserver === 'function') {
        // Teil-Neuaufbau (Tabellen nachgeladen, Kacheln neu): Fokus im nächsten Frame wiederfinden.
        this.observer = new MutationObserver(() => this.scheduleRestore());
        this.observer.observe(root, { childList: true, subtree: true });
      }
    }
    if (!keep) {
      this.setCur(null);
      this.key = '';
      this.index = -1;
      this.unseen = false;
    }
  }

  get current(): HTMLElement | null {
    return this.cur !== null && this.valid(this.cur) ? this.cur : null;
  }

  /** Gültigen Fokus sicherstellen: wiederfinden oder Startelement. Gibt ihn zurück (null = nichts bedienbar). */
  ensure(): HTMLElement | null {
    const c = this.current;
    if (c) return c;
    const els = this.list();
    if (els.length === 0) {
      this.setCur(null);
      return null;
    }
    if (!this.refocus(els)) this.focus(this.initial(els), false);
    return this.cur;
  }

  /** Bestimmtes Element fokussieren (z. B. das gewählte Level nach einem Neuaufbau). Gewollt gesetzt = gesehen. */
  focus(el: HTMLElement | null, scroll = true): void {
    this.unseen = false;
    this.place(el, scroll);
  }

  /** Steuerkreuz: räumlich weiter; auf einem Slider ändert links/rechts den Wert. true = etwas ist passiert. */
  move(dx: number, dy: number): boolean {
    const cur = this.current;
    if (!cur) {
      // Kein gültiger Fokus: die Richtung zeigt ihn erst (auch einen Rückfall) — danach darf A auslösen.
      const shown = this.ensure() !== null;
      this.unseen = false;
      return shown;
    }
    this.unseen = false;
    // Tippt man gerade in einem Textfeld, verlässt die Richtung zuerst das Feld.
    if (document.activeElement === cur && isTextField(cur)) cur.blur();
    if (dx !== 0 && cur instanceof HTMLInputElement && cur.type === 'range') {
      stepRange(cur, dx);
      return true;
    }
    const els = this.list().filter((e) => e !== cur);
    const i = pickInDirection(rectOf(cur), els.map(rectOf), dx, dy);
    if (i < 0) return false;
    this.focus(els[i]);
    return true;
  }

  /** Linear in DOM-Reihenfolge (z. B. Aktionsknöpfe unter einer Disc). */
  step(d: number): boolean {
    const els = this.list();
    if (els.length === 0) return false;
    const cur = this.current;
    const i = cur ? els.indexOf(cur) : -1;
    const j = i < 0 ? 0 : (((i + d) % els.length) + els.length) % els.length;
    this.focus(els[j]);
    return true;
  }

  /** Zum ersten bedienbaren Element des vorigen/nächsten Abschnitts (Panels) springen — LB/RB in langen Screens. */
  jumpSection(dir: -1 | 1, sectionSel: string): boolean {
    const root = this.root;
    if (!root) return false;
    const els = this.list();
    const sections = Array.from(root.querySelectorAll<HTMLElement>(sectionSel)).filter((s) => els.some((e) => s.contains(e)));
    if (sections.length < 2) return false;
    const cur = this.current;
    const at = cur ? sections.findIndex((s) => s.contains(cur)) : -1;
    const next = sections[(((at + dir) % sections.length) + sections.length) % sections.length];
    const first = els.find((e) => next.contains(e));
    if (!first) return false;
    this.focus(first);
    return true;
  }

  /**
   * A: fokussiertes Element auslösen. Textfelder bekommen echten Fokus (Tippen). false = kein Fokus.
   * Nach einem Fokusverlust (Rückfall auf ein anderes Element) zeigt das erste A nur den Fokus (true, nichts ausgelöst).
   */
  activate(): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (this.unseen) {
      this.unseen = false;
      cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }
    if (isTextField(cur)) {
      cur.focus();
      if (cur instanceof HTMLInputElement) cur.select();
      return true;
    }
    if (cur instanceof HTMLInputElement && cur.type === 'range') return true;
    cur.click();
    return true;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.setCur(null);
    this.root = null;
    this.unseen = false;
  }

  // ------------------------------------------------------------------ intern

  private scheduleRestore(): void {
    if (this.restorePending || this.cur === null || this.cur.isConnected) return;
    this.restorePending = true;
    requestAnimationFrame(() => {
      this.restorePending = false;
      if (this.cur !== null && !this.cur.isConnected && !this.refocus(this.list())) this.setCur(null);
    });
  }

  /**
   * Alten Fokus wiederfinden (refocusIndex) und ohne Scrollen setzen — ein Nachladen soll die Ansicht nicht verschieben.
   * Rückfall auf einen anderen Platz merkt sich `unseen` bis zur nächsten Eingabe. false = kein Merker / nichts da.
   */
  private refocus(els: readonly HTMLElement[]): boolean {
    const r = refocusIndex(els.map(keyOf), this.key, this.index);
    if (r.index < 0) return false;
    this.place(els[r.index], false);
    if (r.lost) this.unseen = true;
    return true;
  }

  private place(el: HTMLElement | null, scroll: boolean): void {
    if (el === null) {
      this.setCur(null);
      return;
    }
    this.setCur(el);
    const els = this.list();
    this.index = els.indexOf(el);
    this.key = keyOf(el);
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.opts.onFocus?.(el);
  }

  private setCur(el: HTMLElement | null): void {
    if (this.cur === el) return;
    this.cur?.classList.remove('is-padfocus');
    this.cur = el;
    el?.classList.add('is-padfocus');
  }

  private list(): HTMLElement[] {
    const root = this.root;
    if (!root) return [];
    const out: HTMLElement[] = [];
    for (const e of root.querySelectorAll<HTMLElement>(PAD_FOCUSABLE)) if (this.valid(e)) out.push(e);
    return out;
  }

  private valid(e: HTMLElement): boolean {
    if (!e.isConnected || !this.root?.contains(e)) return false;
    if (e.closest('[data-pad-skip], [hidden], [inert]')) return false;
    if (this.opts.exclude?.(e)) return false;
    if (e instanceof HTMLButtonElement && e.disabled) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(e);
    return st.visibility !== 'hidden' && st.pointerEvents !== 'none';
  }

  private initial(els: readonly HTMLElement[]): HTMLElement {
    const own = this.opts.initial?.(els);
    if (own) return own;
    return (
      els.find((e) => e.hasAttribute('data-pad-initial')) ??
      els.find((e) => e.classList.contains('is-selected')) ??
      els.find((e) => e.closest('.is-selected') !== null) ??
      els.find((e) => /--primary\b/.test(e.className)) ??
      els.find((e) => e.closest('.vel-head-row') === null) ??
      els[0]
    );
  }
}

/**
 * Hover-Zustand eines Stils nachziehen, als stünde die Maus über el: pointerenter/mouseenter auf el und allen Vorfahren
 * bis (ohne) stop, dazu ein blubberndes over. Stile wählen ihre Einträge per pointerenter aus (ps2, hub …) — so folgt
 * deren Auswahl (3D-Fokus, Infotafel) dem Pad-Fokus, ohne eigene Pad-Logik je Eintrag.
 */
export function hoverSync(el: HTMLElement, stop: HTMLElement | null): void {
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  for (let n: HTMLElement | null = el; n !== null && n !== stop; n = n.parentElement) {
    n.dispatchEvent(new PointerEvent('pointerenter'));
    n.dispatchEvent(new MouseEvent('mouseenter'));
  }
}

function rectOf(e: HTMLElement): NavRect {
  const r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function keyOf(e: HTMLElement): string {
  const cls = e.className
    .split(/\s+/)
    .filter((c) => c.length > 0 && !STATE_CLASS.test(c))
    .join('.');
  const data = Object.entries(e.dataset)
    .filter(([k]) => k !== 'glyph')
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join(',');
  return `${e.tagName}|${cls}|${data}|${(e.textContent ?? '').trim().slice(0, 40)}`;
}

function isTextField(e: HTMLElement): e is HTMLInputElement | HTMLTextAreaElement {
  if (e instanceof HTMLTextAreaElement) return true;
  return e instanceof HTMLInputElement && (e.type === 'text' || e.type === 'number' || e.type === 'search');
}

/** Slider um ein Vierzigstel der Spanne (mindestens einen Schritt) verschieben und wie eine Nutzer-Eingabe melden. */
function stepRange(r: HTMLInputElement, dir: number): void {
  const min = Number(r.min || '0');
  const max = Number(r.max || '100');
  const st = Number(r.step) > 0 ? Number(r.step) : 1;
  const k = Math.max(1, Math.round((max - min) / 40 / st));
  const v = Math.min(max, Math.max(min, Number(r.value) + dir * k * st));
  r.value = String(v);
  r.dispatchEvent(new Event('input', { bubbles: true }));
  r.dispatchEvent(new Event('change', { bubbles: true }));
}
