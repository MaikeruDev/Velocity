// Stil 'hub' — DOM-Schicht über der 3D-Szene: Stationskarte (rechts), schwebende Schilder (projiziert), Stationsleiste.
// Text bleibt DOM: scharf in Silkscreen/Pixelify, egal wie grob das Low-Res-Bild ist.
import type { FrontDoorContext, FrontDoorLevel, MedalId } from '../types';
import type { Station } from './layout';
import { stationColor } from './layout';
import { cssRgb, MEDAL_RGB } from './theme';

export interface CardAction {
  readonly label: string;
  readonly sub?: string;
  readonly run: () => void;
  /** Startet ein Level (data-lock, Pointer Lock). */
  readonly lock?: boolean;
  readonly tone?: 'primary' | 'normal' | 'newbie' | 'discord' | 'quiet';
}

const MEDAL_ORDER_UP: readonly MedalId[] = ['bronze', 'silver', 'gold', 'velocity'];
const MEDAL_LABEL: Readonly<Record<MedalId, string>> = { velocity: 'VELOCITY', gold: 'GOLD', silver: 'SILBER', bronze: 'BRONZE' };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** m:ss.cc wie die klassische Liste. */
export function fmtTime(s: number): string {
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Kurzname für Leiste und Schilder. */
export function stationName(st: Station, ctx: FrontDoorContext): string {
  switch (st.kind) {
    case 'portal': {
      const lv = ctx.levels[st.level];
      return lv ? lv.num : '??';
    }
    case 'training':
      return 'Training';
    case 'locker':
      return 'Spind';
    case 'profile':
      return 'Ausweis';
    case 'trophy':
      return 'Trophäen';
    case 'setup':
      return 'Setup';
    case 'lab':
      return 'Labor';
  }
}

function avatar(url: string | null, name: string): HTMLElement {
  const fallback = (): HTMLElement => el('span', 'hub-avatar hub-avatar--none', name.slice(0, 1).toUpperCase() || '?');
  if (!url) return fallback();
  let src: string;
  try {
    const u = new URL(url);
    u.searchParams.set('size', '16');
    src = u.toString();
  } catch {
    return fallback();
  }
  const img = el('img', 'hub-avatar');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.draggable = false;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  img.src = src;
  return img;
}

/** Name mit DEV-Abzeichen (gestufter Neon-Effekt per CSS). */
function playerName(name: string, dev: boolean): HTMLElement {
  const wrap = el('span', `hub-name${dev ? ' hub-name--dev' : ''}`);
  const n = el('span', 'hub-name-text', name);
  n.dataset.text = name;
  wrap.append(n);
  if (dev) wrap.append(el('span', 'hub-dev', 'DEV'));
  return wrap;
}

export interface OverlayHandlers {
  focus(i: number): void;
  hover(i: number): void;
}

interface Tag {
  readonly root: HTMLButtonElement;
  x: number;
  y: number;
  on: boolean;
}

export class Overlay {
  readonly ui: HTMLElement;
  private readonly safe: HTMLElement;
  private readonly card: HTMLElement;
  private readonly tagsLayer: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly account: HTMLButtonElement;
  private readonly hints: HTMLElement;
  private tags: Tag[] = [];
  private dockBtns: HTMLButtonElement[] = [];
  private actionBtns: HTMLButtonElement[] = [];
  private actions: CardAction[] = [];
  private active = 0;
  private cardKey = '';
  /** Kartenrechteck relativ zur Oberfläche (Schilder dahinter werden ausgeblendet). */
  private cardL = 1e9;
  private cardB = 0;
  private topBand = 112;

  constructor(
    root: HTMLElement,
    private readonly h: OverlayHandlers,
    logoUrl: string,
  ) {
    this.ui = el('div', 'hub-ui');
    this.tagsLayer = el('div', 'hub-tags');
    this.safe = el('div', 'hub-safe');
    this.card = el('section', 'hub-card');
    this.card.setAttribute('aria-live', 'polite');
    const top = el('header', 'hub-top');
    const logo = el('img', 'hub-logo');
    logo.alt = 'VELOCITY';
    logo.draggable = false;
    logo.src = logoUrl;
    top.append(logo);
    this.account = el('button', 'hub-account');
    this.account.type = 'button';
    this.dock = el('nav', 'hub-dock');
    this.dock.setAttribute('aria-label', 'Stationen');
    this.hints = el('div', 'hub-hints');
    // Reihenfolge im DOM: Karte zuerst (ihr erster Knopf ist "Starten"), dann Konto, Leiste.
    this.safe.append(this.card, top, this.account, this.dock, this.hints);
    // Schilder liegen per z-index unter der Karte, kommen im DOM aber danach (erster Knopf = Starten).
    this.ui.append(this.safe, this.tagsLayer);
    root.append(this.ui);
  }

  // ------------------------------------------------------------------ Stationen (Schilder + Leiste)

  setStations(stations: readonly Station[], ctx: FrontDoorContext, onAccount: () => void): void {
    this.tagsLayer.replaceChildren();
    this.dock.replaceChildren();
    this.tags = [];
    this.dockBtns = [];
    const rail = el('div', 'hub-rail');
    this.dock.append(rail);
    stations.forEach((st, i) => {
      const color = cssRgb(stationColor(st, ctx));
      // Schild über der Station.
      const tag = el('button', `hub-tag hub-tag--${st.kind}`);
      tag.type = 'button';
      tag.tabIndex = -1;
      tag.style.setProperty('--c', color);
      this.fillTag(tag, st, ctx);
      // Fokus gleich wieder abgeben: sonst löst ein späteres Enter nur diesen Knopf aus statt 'confirm'.
      tag.addEventListener('click', () => {
        tag.blur();
        this.h.focus(i);
      });
      tag.addEventListener('pointerenter', () => this.h.hover(i));
      tag.addEventListener('pointerleave', () => this.h.hover(-1));
      this.tagsLayer.append(tag);
      this.tags.push({ root: tag, x: -1e5, y: -1e5, on: false });
      // Halt in der Leiste.
      const stop = el('button', `hub-stop hub-stop--${st.kind}`);
      stop.type = 'button';
      stop.style.setProperty('--c', color);
      stop.append(el('span', 'hub-stop-pip'), el('span', 'hub-stop-label', stationName(st, ctx)));
      stop.title = st.kind === 'portal' ? `${ctx.levels[st.level]?.num ?? ''} ${ctx.levels[st.level]?.name ?? ''}` : stationName(st, ctx);
      stop.addEventListener('click', () => {
        stop.blur();
        this.h.focus(i);
      });
      stop.addEventListener('pointerenter', () => this.h.hover(i));
      stop.addEventListener('pointerleave', () => this.h.hover(-1));
      rail.append(stop);
      this.dockBtns.push(stop);
    });
    this.renderAccount(ctx);
    this.account.onclick = () => {
      this.account.blur();
      onAccount();
    };
    this.hints.replaceChildren(
      hint('lr', 'Station'),
      hint('ud', 'Wahl'),
      hint('Enter', 'Los'),
      hint('Esc', 'Portal'),
      el('span', 'hub-version', ctx.version),
    );
  }

  private fillTag(tag: HTMLElement, st: Station, ctx: FrontDoorContext): void {
    tag.replaceChildren();
    if (st.kind === 'portal') {
      const lv = ctx.levels[st.level];
      if (!lv) return;
      tag.append(el('span', 'hub-tag-title', lv.name));
      const line = el('span', 'hub-tag-sub', lv.bestTime !== null ? lv.bestText : 'Noch kein Lauf');
      if (lv.medal) {
        const m = el('span', 'hub-tag-medal');
        m.style.setProperty('--m', cssRgb(MEDAL_RGB[lv.medal]));
        line.prepend(m);
      }
      tag.append(line);
      return;
    }
    tag.append(el('span', 'hub-tag-title', stationName(st, ctx)));
    let sub = '';
    if (st.kind === 'training') sub = ctx.training.newbie ? 'Neu hier? Hier anfangen' : ctx.training.countText ? `${ctx.training.countText} bestanden` : '';
    else if (st.kind === 'locker') sub = `${ctx.cosmetics.unlocked}/${ctx.cosmetics.total} frei`;
    else if (st.kind === 'profile') sub = ctx.account.signedIn && ctx.account.name ? ctx.account.name : ctx.account.loginRequired ? 'Anmelden' : 'Konto';
    else if (st.kind === 'trophy') sub = 'Bestenliste';
    else if (st.kind === 'setup') sub = 'Einstellungen';
    else if (st.kind === 'lab') sub = 'Admin · Menü-Labor';
    if (sub) tag.append(el('span', 'hub-tag-sub', sub));
    tag.classList.toggle('is-newbie', st.kind === 'training' && ctx.training.newbie);
  }

  refreshTags(stations: readonly Station[], ctx: FrontDoorContext): void {
    stations.forEach((st, i) => {
      const t = this.tags[i];
      if (t) this.fillTag(t.root, st, ctx);
    });
    this.renderAccount(ctx);
  }

  /** Schild-Position je Frame; nur bei Pixeländerung ins DOM schreiben. */
  placeTag(i: number, x: number, y: number, show: boolean): void {
    const t = this.tags[i];
    if (!t) return;
    // Nicht unter Karte oder Kopfzeile: lieber weg als halb verdeckt.
    const visible = show && y > this.topBand && !(x + 96 > this.cardL && y - 64 < this.cardB);
    if (visible !== t.on) {
      t.on = visible;
      t.root.classList.toggle('is-on', visible);
    }
    if (!visible) return;
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === t.x && ry === t.y) return;
    t.x = rx;
    t.y = ry;
    t.root.style.transform = `translate(${rx}px, ${ry}px)`;
  }

  /** Nach Kartenwechsel/Größenänderung (liest Layout — nicht im Frame aufrufen). */
  measure(): void {
    const r = this.ui.getBoundingClientRect();
    const c = this.card.getBoundingClientRect();
    this.cardL = c.width > 0 ? c.left - r.left : 1e9;
    this.cardB = c.bottom - r.top;
    this.topBand = r.height >= 960 ? 152 : 112;
  }

  setFocus(i: number): void {
    this.dockBtns.forEach((b, k) => b.classList.toggle('is-focus', k === i));
    this.tags.forEach((t, k) => t.root.classList.toggle('is-focus', k === i));
  }

  setHover(i: number): void {
    this.dockBtns.forEach((b, k) => b.classList.toggle('is-hover', k === i));
    this.tags.forEach((t, k) => t.root.classList.toggle('is-hover', k === i));
  }

  setSelectedLevel(stations: readonly Station[], level: number): void {
    stations.forEach((st, k) => this.dockBtns[k]?.classList.toggle('is-selected', st.kind === 'portal' && st.level === level));
  }

  /** Oberfläche einblenden (0 = versteckt während des Anflugs). */
  setReveal(on: boolean): void {
    this.ui.classList.toggle('is-revealed', on);
  }

  private renderAccount(ctx: FrontDoorContext): void {
    const a = ctx.account;
    this.account.replaceChildren();
    this.account.classList.toggle('is-dev', a.dev);
    if (a.signedIn && a.name) {
      this.account.append(avatar(a.avatarUrl, a.name), playerName(a.name, a.dev));
    } else if (a.loginRequired) {
      this.account.append(el('span', 'hub-avatar hub-avatar--none', '?'), el('span', 'hub-account-text', 'Gast · Anmelden'));
    } else {
      this.account.append(el('span', 'hub-avatar hub-avatar--none', a.name ? a.name.slice(0, 1).toUpperCase() : '?'), el('span', 'hub-account-text', a.name ?? (a.online ? 'Gast' : 'Offline')));
    }
    this.account.title = 'Ausweis: Profil und Konto';
  }

  // ------------------------------------------------------------------ Karte

  /** Karte neu bauen. key = Station + Daten; gleicher key → nur Fehlerzeile/aktiver Knopf. */
  showCard(st: Station, ctx: FrontDoorContext, actions: CardAction[], body: HTMLElement[], key: string, mark: (b: HTMLButtonElement) => void): void {
    const changed = key !== this.cardKey;
    this.cardKey = key;
    this.actions = actions;
    if (this.active >= actions.length) this.active = 0;
    const color = cssRgb(stationColor(st, ctx));
    this.card.style.setProperty('--c', color);
    this.card.dataset.kind = st.kind;
    this.card.replaceChildren();
    const head = el('div', 'hub-card-head');
    head.append(el('span', 'hub-card-kicker', kicker(st, ctx)));
    this.card.append(head, ...body);
    const list = el('div', 'hub-actions');
    this.actionBtns = actions.map((a, k) => {
      // Lange Hauptknöpfe in 16 px statt 24 px (eine Zeile, Untertitel bleibt sichtbar).
      const b = el('button', `hub-act hub-act--${a.tone ?? 'normal'}${a.label.length > 9 ? ' is-long' : ''}`);
      b.type = 'button';
      b.append(el('span', 'hub-act-caret'), el('span', 'hub-act-label', a.label));
      if (a.sub) b.append(el('span', 'hub-act-sub', a.sub));
      // Synchron im Klick: play() fängt die Maus nur innerhalb der Geste.
      b.addEventListener('click', () => a.run());
      b.addEventListener('pointerenter', () => this.setActive(k));
      if (a.lock) mark(b);
      list.append(b);
      return b;
    });
    this.card.append(list);
    if (ctx.lock.error) this.card.append(el('p', 'hub-error', ctx.lock.error));
    this.setActive(this.active);
    this.measure();
    if (changed) {
      // Kurzes, gestuftes Einfahren bei Stationswechsel (CSS steps).
      this.card.classList.remove('is-in');
      void this.card.offsetWidth;
      this.card.classList.add('is-in');
    }
  }

  resetActive(): void {
    this.active = 0;
  }

  setActive(k: number): void {
    const n = this.actionBtns.length;
    if (n === 0) return;
    this.active = ((k % n) + n) % n;
    this.actionBtns.forEach((b, i) => b.classList.toggle('is-active', i === this.active));
  }

  moveActive(d: number): void {
    this.setActive(this.active + d);
  }

  /** Aktiven Knopf auslösen (Enter). Gesperrte Knöpfe (lock.pending) nicht. */
  runActive(): void {
    const a = this.actions[this.active];
    const b = this.actionBtns[this.active];
    if (!a || (b && b.disabled)) return;
    a.run();
  }

  dispose(): void {
    this.ui.remove();
  }
}

/** Tastenkappe; 'lr'/'ud' = gezeichnete Pfeile (Silkscreen hat keine Pfeil-Glyphen). */
function hint(key: string, text: string): HTMLElement {
  const s = el('span', 'hub-hint');
  if (key === 'lr' || key === 'ud') {
    const k = el('kbd', `hub-key hub-key--${key}`);
    k.append(el('i', 'hub-arrow hub-arrow--a'), el('i', 'hub-arrow hub-arrow--b'));
    s.append(k);
  } else s.append(el('kbd', 'hub-key', key));
  s.append(el('span', '', text));
  return s;
}

function kicker(st: Station, ctx: FrontDoorContext): string {
  switch (st.kind) {
    case 'portal':
      return `Portal ${ctx.levels[st.level]?.num ?? ''} / ${String(ctx.levels.length).padStart(2, '0')}`;
    case 'training':
      return 'Trainingsparcours';
    case 'locker':
      return 'Spind · Kosmetik';
    case 'profile':
      return 'Ausweis · Konto';
    case 'trophy':
      return 'Trophäenwand';
    case 'setup':
      return 'Werkbank';
    case 'lab':
      return 'Wartung';
  }
}

// ------------------------------------------------------------------ Karteninhalte (DOM-Bausteine)

export function row(label: string, value: string | HTMLElement, cls = ''): HTMLElement {
  const r = el('div', `hub-row ${cls}`);
  const v = typeof value === 'string' ? el('span', 'hub-row-value', value) : value;
  if (typeof value !== 'string') v.classList.add('hub-row-value');
  r.append(el('span', 'hub-row-label', label), v);
  return r;
}

export function medalChip(m: MedalId | null): HTMLElement {
  if (!m) return el('span', 'hub-medal hub-medal--none', 'Keine');
  const c = el('span', `hub-medal hub-medal--${m}`, MEDAL_LABEL[m]);
  c.style.setProperty('--m', cssRgb(MEDAL_RGB[m]));
  return c;
}

/** Medaillen-Leiter: vier Stufen, erreichte leuchten. */
export function medalLadder(lv: FrontDoorLevel): HTMLElement | null {
  const m = lv.medals;
  if (!m) return null;
  const wrap = el('div', 'hub-ladder');
  for (const id of MEDAL_ORDER_UP) {
    const got = lv.bestTime !== null && lv.bestTime <= m[id];
    const cell = el('div', `hub-rung${got ? ' is-got' : ''}${lv.nextMedal?.id === id ? ' is-next' : ''}`);
    cell.style.setProperty('--m', cssRgb(MEDAL_RGB[id]));
    cell.append(el('span', 'hub-rung-name', MEDAL_LABEL[id]), el('span', 'hub-rung-time', fmtTime(m[id])));
    wrap.append(cell);
  }
  return wrap;
}

export function segBar(done: number, total: number, cls = ''): HTMLElement {
  const bar = el('div', `hub-seg ${cls}`);
  const n = Math.max(1, Math.min(32, total));
  for (let i = 0; i < n; i++) bar.append(el('span', i < done ? 'is-on' : ''));
  return bar;
}

export function stars(n: number): HTMLElement {
  const s = el('span', 'hub-stars');
  for (let i = 0; i < 3; i++) s.append(el('span', i < n ? 'is-on' : ''));
  return s;
}

export { avatar, playerName };
