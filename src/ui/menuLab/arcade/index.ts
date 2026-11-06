/**
 * Stil 'arcade' (Plan 010) — "Arcade-Automat": der Bildschirm ist die Röhre eines Automaten in einer dunklen Halle.
 * Gehäuse (Marquee, Rahmen, Seiten-Art, Pult) = Low-Res-Canvas (cabinet.ts), Inhalt = DOM hinter dem Glas.
 * Ablauf: entry 'boot' → Einschalten → Attract-Mode (Seiten im Wechsel) → jede Taste/Klick wirft eine Münze ein →
 * Hauptmenü (Stage-Auswahl + Menüpunkte). entry 'return' → direkt ins Hauptmenü.
 *
 * Frame-Pfad (rAF): nur Zahlen vergleichen und Klassen mit festen Strings umschalten, wenn sich etwas ändert —
 * keine Strings bauen, keine Objekte. Alles Datenabhängige wird in render*() (update/mount) gebaut.
 */
import './arcade.css';
import { formatTime } from '../../format';
import type { FrontDoor, FrontDoorAction, FrontDoorContext, FrontDoorFactory, FrontDoorLevel, MedalId } from '../types';
import { drawCabinet, STAGE_H, STAGE_W } from './cabinet';
import { StrafeDemo } from './strafeDemo';
import { drawThumb } from './thumbs';

type Mode = 'power' | 'attract' | 'menu';
const PAGES = ['title', 'demo', 'scores', 'howto', 'credits'] as const;
type Page = (typeof PAGES)[number];
/** Verweildauer je Attract-Seite (ms). */
const PAGE_MS: Readonly<Record<Page, number>> = { title: 8000, demo: 6000, scores: 7500, howto: 10000, credits: 6500 };
/** Hauptmenü ohne Eingabe → zurück in den Attract-Mode (wie ein echter Automat). */
const IDLE_MS = 75000;
const POWER_MS = 950;
const CUT_MS = 140;
const COIN_MS = 900;

/**
 * Münzen der Sitzung — bewusst auf Modulebene: die Front Door wird bei jeder Rückkehr neu gemountet,
 * der Münzzähler soll das überleben (Import fasst kein DOM an, nur eine Zahl).
 */
let credits = 0;

/** Tasten, die NICHT "Münze einwerfen"/navigieren: kommen über onAction (Enter/Esc/R) oder gehören dem Spiel/Browser. */
const IGNORE = new Set([
  'Enter', 'NumpadEnter', 'Escape', 'KeyR', 'KeyM', 'Tab', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'ContextMenu',
]);

/** Level-ids mit eigenem Karten-Motiv (thumbs.ts), in Motiv-Reihenfolge. */
const MOTIF_IDS: readonly string[] = ['level1', 'level2', 'level3', 'level4'];

const MEDAL_RANK: Readonly<Record<MedalId, number>> = { bronze: 1, silver: 2, gold: 3, velocity: 4 };
const MEDAL_LABEL: Readonly<Record<MedalId, string>> = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD', velocity: 'VELOCITY' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Pixel-Pfeil (getreppter clip-path, siehe CSS) — Silkscreen hat keine Dreiecke. */
function arrow(dir: 'l' | 'r' | 'u' | 'd' = 'r'): HTMLElement {
  return el('span', `ac-arw ac-arw--${dir}`);
}

/** Arcade-Kürzel aus dem Anzeigenamen: drei Zeichen A–Z/0–9, Umlaute ohne Punkte. */
function initials(name: string | null): string {
  if (!name) return 'YOU';
  const clean = name
    .toUpperCase()
    .normalize('NFD')
    .replace(/[^A-Z0-9]/g, '');
  return clean.length === 0 ? 'YOU' : clean.slice(0, 3).padEnd(3, '.');
}

function two(n: number): string {
  return String(Math.max(0, Math.min(99, n))).padStart(2, '0');
}

function medalChip(m: MedalId | null, withLabel = true): HTMLElement {
  const chip = el('span', `ac-medal ac-medal--${m ?? 'none'}`);
  chip.append(el('i', 'ac-medal-disc'));
  if (withLabel) chip.append(el('span', 'ac-medal-txt', m ? MEDAL_LABEL[m] : '---'));
  return chip;
}

/** Avatar pixelig klein anfordern (Discord: ?size=16). */
function avatarSrc(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('size', '16');
    return u.toString();
  } catch {
    return url;
  }
}

class ArcadeDoor implements FrontDoor {
  private root: HTMLElement | null = null;
  private ctx: FrontDoorContext | null = null;
  private sel = 0;
  private mode: Mode = 'attract';
  private page = 0;
  private pageT0 = 0;
  private modeT0 = 0;
  private lastInput = 0;
  private cutUntil = 0;
  private coinUntil = 0;
  private mountedAt = 0;
  private raf = 0;
  private reduced = false;
  // Takt-Zustände (nur bei Wechsel Klassen schreiben)
  private b1 = false;
  private b2 = false;
  private kick = false;
  private demoSide = 0;

  // DOM
  private cab: HTMLCanvasElement | null = null;
  private under: HTMLElement | null = null;
  private over: HTMLElement | null = null;
  private hudL: HTMLElement | null = null;
  private hudC: HTMLElement | null = null;
  private hudR: HTMLElement | null = null;
  private footR: HTMLElement | null = null;
  private footL: HTMLElement | null = null;
  private pageEls: HTMLElement[] = [];
  private insertEls: HTMLElement[] = [];
  private scoresBody: HTMLElement | null = null;
  private demoInfo: HTMLElement | null = null;
  private creditsBody: HTMLElement | null = null;
  private cards: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private startRow: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private util: HTMLElement | null = null;
  private errEl: HTMLElement | null = null;
  private keyA: HTMLElement | null = null;
  private keyD: HTMLElement | null = null;
  private demo: StrafeDemo | null = null;
  private deckCoin: HTMLElement | null = null;

  /** Navigierbare Knöpfe (Hauptmenü) und der aktuelle Cursor (data-nav-Schlüssel). */
  private navs: HTMLButtonElement[] = [];
  private cursor = 'start';

  // ------------------------------------------------------------------ Lebenszyklus

  mount(root: HTMLElement, ctx: FrontDoorContext): void {
    this.root = root;
    this.ctx = ctx;
    this.sel = ctx.selected;
    this.reduced = ctx.reducedMotion;
    root.classList.add('ac-root');
    root.classList.toggle('ac-reduced', this.reduced);
    this.build(root, ctx);
    this.layout();
    this.renderAll();
    const now = performance.now();
    this.mountedAt = now;
    this.lastInput = now;
    if (ctx.entry === 'boot') {
      // Titelseite liegt schon hinter dem Einschalt-Effekt.
      this.toAttract(now);
      if (!this.reduced) this.setMode('power', now);
    } else this.toMenu(now, false);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    root.addEventListener('click', this.onRootClick);
    root.addEventListener('mousedown', this.onMouseDown);
    root.addEventListener('mousemove', this.onMouseMove);
    this.raf = requestAnimationFrame(this.frame);
  }

  update(ctx: FrontDoorContext): void {
    this.ctx = ctx;
    this.sel = ctx.selected;
    this.renderAll();
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    const r = this.root;
    if (r) {
      r.removeEventListener('click', this.onRootClick);
      r.removeEventListener('mousedown', this.onMouseDown);
      r.removeEventListener('mousemove', this.onMouseMove);
      r.replaceChildren();
    }
    if (this.cab) {
      this.cab.width = 0;
      this.cab.height = 0;
    }
    this.root = null;
    this.ctx = null;
    this.navs = [];
    this.pageEls = [];
    this.insertEls = [];
    this.demo = null;
  }

  onAction(a: FrontDoorAction): void {
    const now = performance.now();
    this.lastInput = now;
    if (this.mode !== 'menu') {
      // Enter/R im Attract-Mode = Münze. Esc nicht (wäre "zurück" — von hier gibt es kein Zurück).
      if (a !== 'back') this.insertCoin(now);
      return;
    }
    if (a === 'confirm') this.activateCursor();
    else if (a === 'back') this.toAttract(now);
  }

  // ------------------------------------------------------------------ Aufbau

  private build(root: HTMLElement, ctx: FrontDoorContext): void {
    // Unter dem Gehäuse: die Röhre (Inhalt). Darüber: Gehäuse-Canvas. Ganz oben: Marquee-Logo und Pult-Beschriftung.
    const under = el('div', 'ac-stage ac-stage--under');
    const screen = el('div', 'ac-screen');
    const tint = el('div', 'ac-tint');
    const content = el('div', 'ac-content');

    const hud = el('header', 'ac-hud');
    this.hudL = el('span', 'ac-hud-l');
    this.hudC = el('span', 'ac-hud-c');
    this.hudR = el('span', 'ac-hud-r');
    hud.append(this.hudL, this.hudC, this.hudR);

    const attract = el('div', 'ac-attract');
    this.pageEls = PAGES.map((p) => {
      const sec = el('section', `ac-page ac-page--${p}`);
      sec.dataset.page = p;
      attract.append(sec);
      return sec;
    });
    this.buildTitlePage(this.pageEls[0], ctx);
    this.buildDemoPage(this.pageEls[1]);
    this.buildScoresPage(this.pageEls[2]);
    this.buildHowtoPage(this.pageEls[3]);
    this.buildCreditsPage(this.pageEls[4]);

    const menu = el('div', 'ac-menu');
    const head = el('div', 'ac-sel-head');
    const hint = el('span', 'ac-sel-keys');
    hint.append(arrow('l'), arrow('r'));
    head.append(el('span', 'ac-sel-title', 'SELECT STAGE'), hint);
    this.cards = el('div', 'ac-cards');
    this.detail = el('div', 'ac-detail');
    this.startRow = el('div', 'ac-start-row');
    this.grid = el('div', 'ac-grid');
    this.errEl = el('div', 'ac-error');
    menu.append(head, this.cards, this.detail, this.startRow, this.grid, this.errEl);

    const foot = el('footer', 'ac-foot');
    // Fuß: Konto + Werkzeuge (nur im Menü sichtbar) | Münzzähler.
    this.footL = el('span', 'ac-foot-l');
    this.util = this.footL;
    this.footR = el('span', 'ac-foot-r ac-credit');
    foot.append(this.footL, this.footR);

    content.append(hud, attract, menu, foot);
    screen.append(tint, content, el('div', 'ac-scan'), el('div', 'ac-roll'), el('div', 'ac-flash'), el('div', 'ac-power'));
    under.append(screen);

    const cab = el('canvas', 'ac-cab');
    this.cab = cab;

    const over = el('div', 'ac-stage ac-stage--over');
    const marquee = el('div', 'ac-marquee');
    const mlogo = el('img', 'ac-marquee-logo');
    mlogo.src = ctx.assets.logoUrl;
    mlogo.alt = 'VELOCITY';
    mlogo.draggable = false;
    marquee.append(mlogo, el('div', 'ac-marquee-dim'));
    const deck = el('div', 'ac-deck');
    const legend = el('div', 'ac-deck-legend');
    const k = (cap: string | HTMLElement, label: string): HTMLElement => {
      const g = el('span', 'ac-leg');
      const c = el('span', 'ac-cap');
      if (typeof cap === 'string') c.textContent = cap;
      else c.append(cap);
      g.append(c, el('span', 'ac-leg-t', label));
      return g;
    };
    const arrows = el('span', 'ac-cap-arws');
    arrows.append(arrow('l'), arrow('u'), arrow('d'), arrow('r'));
    legend.append(k(arrows, 'MOVE'), k('ENTER', 'START'), k('ESC', 'BACK'), k('5', 'COIN'));
    this.deckCoin = el('span', 'ac-deck-coin', 'INSERT COIN');
    deck.append(legend, this.deckCoin);
    over.append(marquee, deck);

    this.under = under;
    this.over = over;
    root.append(under, cab, over);
  }

  private buildTitlePage(p: HTMLElement, ctx: FrontDoorContext): void {
    const logo = el('img', 'ac-logo');
    logo.src = ctx.assets.logoUrl;
    logo.alt = 'VELOCITY';
    logo.draggable = false;
    const ins = el('p', 'ac-insert ac-bl1');
    this.insertEls.push(ins);
    p.append(
      logo,
      el('p', 'ac-tag', 'BHOP  ·  STRAFE  ·  SURF'),
      ins,
      el('p', 'ac-any', 'ANY KEY OR CLICK'),
      el('p', 'ac-copy', '© 2026 VELOCITY   1 PLAYER   128 TICK'),
    );
  }

  private buildDemoPage(p: HTMLElement): void {
    const tag = el('p', 'ac-demo-tag');
    tag.append(el('span', 'ac-rec'), el('span', '', 'DEMO PLAY'));
    this.demoInfo = el('div', 'ac-demo-info');
    const ins = el('p', 'ac-insert ac-bl1');
    this.insertEls.push(ins);
    p.append(tag, this.demoInfo, ins);
  }

  private buildScoresPage(p: HTMLElement): void {
    p.append(el('h2', 'ac-ptitle ac-rainbow', 'BEST TIMES'));
    const head = el('div', 'ac-srow ac-srow--head');
    head.append(el('span', 'ac-s-rank', 'NO'), el('span', 'ac-s-name', 'STAGE'), el('span', 'ac-s-time', 'TIME'), el('span', 'ac-s-medal', 'MEDAL'), el('span', 'ac-s-ini', 'NAME'));
    this.scoresBody = el('div', 'ac-sbody');
    const legend = el('div', 'ac-slegend');
    for (const m of ['bronze', 'silver', 'gold', 'velocity'] as const) legend.append(medalChip(m));
    p.append(head, this.scoresBody, legend, el('p', 'ac-snote ac-bl1', 'BEAT THE VELOCITY TIME'));
  }

  private buildHowtoPage(p: HTMLElement): void {
    p.append(el('h2', 'ac-ptitle', 'HOW TO PLAY'));
    const wrap = el('div', 'ac-howto');
    const left = el('div', 'ac-howto-demo');
    const cv = el('canvas', 'ac-demo-cv');
    this.demo = new StrafeDemo(cv);
    const keys = el('div', 'ac-demo-keys');
    this.keyA = el('span', 'ac-cap ac-cap--big', 'A');
    this.keyD = el('span', 'ac-cap ac-cap--big', 'D');
    const mouse = el('span', 'ac-demo-mouse');
    mouse.append(el('span', 'ac-demo-mouse-t', 'MOUSE'));
    keys.append(this.keyA, mouse, this.keyD);
    left.append(cv, keys);
    const tips = el('ol', 'ac-tips');
    const tip = (cap: string, head: string, body: string): HTMLElement => {
      const li = el('li', 'ac-tip');
      const h = el('div', 'ac-tip-h');
      h.append(el('span', 'ac-cap', cap), el('span', 'ac-tip-t', head));
      li.append(h, el('p', 'ac-tip-b', body));
      return li;
    };
    tips.append(
      tip('SPACE', 'HOLD TO HOP', 'Sprung halten: Auto-Hop springt bei jeder Landung perfekt weiter.'),
      tip('A/D', 'STRAFE + MOUSE', 'In der Luft A oder D halten und die Maus in dieselbe Richtung ziehen — so wächst das Tempo.'),
      tip('W', 'ONLY STEERS', 'W bringt in der Luft kein Tempo. Strafen bringt Tempo.'),
      tip('RAMP', 'SURF', 'Auf schrägen Rampen nicht springen: in die Rampe halten und gleiten.'),
    );
    wrap.append(left, tips);
    p.append(wrap);
  }

  private buildCreditsPage(p: HTMLElement): void {
    p.append(el('h2', 'ac-ptitle', 'CREDITS'));
    this.creditsBody = el('div', 'ac-cbody');
    p.append(this.creditsBody, el('p', 'ac-thanks ac-bl1', 'THANK YOU FOR PLAYING'));
  }

  // ------------------------------------------------------------------ Größe

  private readonly onResize = (): void => this.layout();

  /**
   * Maßstab s wählen: Bühne = 388×360 Kunst-Pixel à 2·s px. s nur in 0.5er-Schritten, damit 16·s (1em) ein
   * Vielfaches von 8 bleibt (Silkscreen scharf). Passt nicht einmal s=1: stufenlos verkleinern (selten, kleine Fenster).
   */
  private layout(): void {
    const root = this.root;
    const cab = this.cab;
    if (!root || !cab || !this.under || !this.over) return;
    const W = Math.max(1, root.clientWidth);
    const H = Math.max(1, root.clientHeight);
    let s = 0;
    for (const c of [4, 3.5, 3, 2.5, 2, 1.5, 1]) {
      if (STAGE_H * 2 * c <= H && (STAGE_W + 32) * 2 * c <= W) {
        s = c;
        break;
      }
    }
    if (s === 0) s = Math.min(H / (STAGE_H * 2), W / ((STAGE_W + 16) * 2));
    const p = 2 * s; // Bildschirm-px je Kunst-Pixel
    const cw = Math.ceil(W / p);
    const ch = Math.ceil(H / p);
    const ox = Math.floor((cw - STAGE_W) / 2);
    const oy = Math.max(0, Math.floor((ch - STAGE_H) / 2));
    cab.width = cw;
    cab.height = ch;
    cab.style.width = `${cw * p}px`;
    cab.style.height = `${ch * p}px`;
    const g = cab.getContext('2d');
    if (g) drawCabinet(g, { cw, ch, ox, oy });
    for (const st of [this.under, this.over]) {
      st.style.left = `${ox * p}px`;
      st.style.top = `${oy * p}px`;
      st.style.fontSize = `${16 * s}px`;
    }
    // Harte Versätze (Phosphor-Säume, Schatten) in ganzen px; Scanline-Abstand = 1 Kunst-Pixel.
    root.style.setProperty('--ac-u', `${Math.max(1, Math.round(s))}px`);
    root.style.setProperty('--ac-p', `${Math.max(2, Math.round(p))}px`);
  }

  // ------------------------------------------------------------------ Daten → DOM (nicht im Frame-Pfad)

  private renderAll(): void {
    this.renderHud();
    this.renderScores();
    this.renderDemoInfo();
    this.renderCredits();
    this.renderCredit();
    this.renderMenu();
  }

  private renderHud(): void {
    const c = this.ctx;
    if (!c || !this.hudL || !this.hudC || !this.hudR || !this.footL) return;
    this.hudL.replaceChildren(el('span', 'ac-1p', '1P'));
    if (c.account.avatarUrl) {
      const img = el('img', 'ac-avatar');
      img.src = avatarSrc(c.account.avatarUrl);
      img.alt = '';
      img.draggable = false;
      this.hudL.append(img);
    }
    this.hudL.append(el('span', 'ac-ini', initials(c.account.name)));
    if (!c.account.online) this.hudL.append(el('span', 'ac-acc-off', 'OFFLINE'));
    if (c.account.dev) this.hudL.append(el('span', 'ac-dev', 'DEV'));
    let total = 0;
    let all = c.levels.length > 0;
    let pts = 0;
    for (const lv of c.levels) {
      if (lv.bestTime === null) all = false;
      else total += lv.bestTime;
      if (lv.medal) pts += MEDAL_RANK[lv.medal];
    }
    this.hudC.replaceChildren(el('span', 'ac-hud-k', 'TOTAL'), el('span', 'ac-hud-v', all ? formatTime(total) : '--:--.--'));
    this.hudR.replaceChildren(el('span', 'ac-hud-k', 'MEDALS'), el('span', 'ac-hud-v', `${two(pts)}/${two(c.levels.length * 4)}`));
  }

  private renderCredit(): void {
    const c = this.ctx;
    if (!this.footR || !c) return;
    const text = this.mode === 'menu' && credits === 0 ? 'FREE PLAY' : `CREDIT ${two(credits)}`;
    this.footR.textContent = text;
    const label = credits > 0 ? 'PRESS START' : 'INSERT COIN';
    for (const e of this.insertEls) e.textContent = label;
    if (this.deckCoin) this.deckCoin.textContent = credits > 0 ? `CREDIT ${two(credits)}` : 'INSERT COIN';
  }

  private renderScores(): void {
    const c = this.ctx;
    const body = this.scoresBody;
    if (!c || !body) return;
    body.replaceChildren();
    if (c.loading) body.append(el('p', 'ac-loading ac-bl1', 'LOADING'));
    const ini = initials(c.account.name);
    for (const lv of c.levels) {
      const row = el('div', 'ac-srow');
      row.dataset.lv = String(lv.index % 4);
      const has = lv.bestTime !== null;
      row.classList.toggle('is-empty', !has);
      row.append(
        el('span', 'ac-s-rank', lv.num),
        el('span', 'ac-s-name', lv.name),
        el('span', 'ac-s-time', has ? lv.bestText : '--:--.--'),
        el('span', 'ac-s-medal'),
        el('span', 'ac-s-ini', has ? ini : '---'),
      );
      row.children[3].append(medalChip(lv.medal));
      body.append(row);
    }
  }

  private renderDemoInfo(): void {
    const c = this.ctx;
    const d = this.demoInfo;
    if (!c || !d) return;
    d.replaceChildren();
    const lv = c.levels[0];
    if (!lv) return;
    d.append(el('span', 'ac-demo-stage', `STAGE ${lv.num}`), el('span', 'ac-demo-name', lv.name));
    if (lv.subtitle) d.append(el('span', 'ac-demo-sub', lv.subtitle));
  }

  private renderCredits(): void {
    const c = this.ctx;
    const b = this.creditsBody;
    if (!c || !b) return;
    b.replaceChildren();
    const line = (k: string, v: string): void => {
      const r = el('div', 'ac-crow');
      r.append(el('span', 'ac-c-k', k), el('span', 'ac-c-dots'), el('span', 'ac-c-v', v));
      b.append(r);
    };
    line('PHYSICS', 'SOURCE PMOVE 128 TICK');
    line('MUSIC', 'LIVE TECHNO 132 BPM');
    line('GRAPHICS', 'PS2 PIXEL PIPE');
    line('STAGES', `${two(c.levels.length)} + ${two(c.training.total)} TRAINING`);
    line('LOCKER', `${two(c.cosmetics.unlocked)}/${two(c.cosmetics.total)} UNLOCKED`);
    if (c.training.total > 0) line('TRAINING', `${two(c.training.passed)}/${two(c.training.total)} PASSED`);
    b.append(el('p', 'ac-c-ver', c.version));
  }

  private renderMenu(): void {
    const c = this.ctx;
    if (!c || !this.cards || !this.startRow || !this.grid || !this.util || !this.errEl || !this.detail) return;
    const navs: HTMLButtonElement[] = [];
    const nav = (key: string, cls: string, onClick: () => void, lock = false): HTMLButtonElement => {
      const b = el('button', `ac-btn ${cls}`);
      b.type = 'button';
      b.dataset.nav = key;
      // Synchron im Klick: play() fängt die Maus nur innerhalb der Geste (Pointer Lock).
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.lastInput = performance.now();
        onClick();
      });
      b.addEventListener('mouseenter', () => this.setCursor(key));
      if (lock) c.markLockButton(b);
      navs.push(b);
      return b;
    };

    // Stage-Karten
    this.cards.replaceChildren();
    if (c.loading) this.cards.append(el('p', 'ac-loading ac-bl1', 'LOADING STAGES'));
    for (const lv of c.levels) {
      const b = nav(`card:${lv.index}`, 'ac-card', () => this.clickCard(lv), true);
      b.dataset.lv = String(lv.index % 4);
      const thumb = el('canvas', 'ac-card-thumb');
      // Motiv nach Level-id (nicht Position), damit ein umsortierter Index nicht falsche Bilder zeigt.
      drawThumb(thumb, MOTIF_IDS.indexOf(lv.id) >= 0 ? MOTIF_IDS.indexOf(lv.id) : 4 + lv.index);
      b.append(
        thumb,
        el('span', 'ac-card-tag', '1P'),
        el('span', 'ac-card-num', lv.num),
        el('span', 'ac-card-name', lv.name),
        el('span', `ac-card-best${lv.bestTime === null ? ' is-none' : ''}`, lv.bestTime === null ? 'NO RECORD' : lv.bestText),
        medalChip(lv.medal),
      );
      this.cards.append(b);
    }

    // START (+ Neuling-Angebot)
    this.startRow.replaceChildren();
    const lv = c.levels[this.sel];
    const start = nav('start', 'ac-start', () => this.play(c, this.ctx?.levels[this.sel]?.id ?? null), true);
    start.append(arrow('r'), el('span', 'ac-start-t', 'START'), el('span', 'ac-start-lv', lv ? `${lv.num} ${lv.name}` : ''));
    this.startRow.append(start);
    const rec = c.training.recommended;
    if (c.training.newbie && rec && c.training.playable) {
      const nb = nav('newbie', 'ac-newbie', () => this.play(c, rec.id), true);
      nb.append(el('span', 'ac-newbie-k ac-bl1', 'NEW PLAYER?'), el('span', 'ac-newbie-t', `${rec.short} ${rec.name.toUpperCase()}`));
      this.startRow.append(nb);
    }

    // Menüpunkte
    this.grid.replaceChildren();
    const item = (key: string, label: string, info: string, onClick: () => void): void => {
      const b = nav(key, 'ac-item', onClick);
      b.append(arrow('r'), el('span', 'ac-item-t', label), el('span', 'ac-item-i', info));
      this.grid?.append(b);
    };
    const tr = c.training;
    item('training', 'TRAINING', tr.countText + (tr.recommended && !tr.newbie ? ` ${tr.recommended.short}` : ''), () => this.ctx?.openTraining());
    item('locker', 'LOCKER', `${c.cosmetics.unlocked}/${c.cosmetics.total}`, () => this.ctx?.openCosmetics());
    item('scores', 'HIGH SCORES', c.account.online ? '' : 'OFFLINE', () => this.ctx?.openLeaderboard());
    item('options', 'OPTIONS', '', () => this.ctx?.openSettings());
    item('controls', 'CONTROLS', '', () => this.ctx?.openControls());
    item('profile', 'PROFILE', '', () => this.ctx?.openProfile());

    // Konto + Werkzeuge
    this.util.replaceChildren();
    const a = c.account;
    const tools = el('div', 'ac-tools');
    const tool = (key: string, label: string, onClick: () => void, extra = ''): void => {
      const b = nav(key, `ac-tool ${extra}`, onClick);
      b.textContent = label;
      tools.append(b);
    };
    if (a.loginRequired && !a.signedIn) tool('login', 'LOGIN', () => this.ctx?.signIn(), 'ac-tool--login');
    if (a.signedIn) tool('logout', 'LOGOUT', () => this.ctx?.signOut());
    tool('full', 'FULLSCREEN', () => this.ctx?.fullscreen());
    tool('lab', 'LAB', () => this.ctx?.openLab());
    tool('admin', 'ADMIN', () => this.ctx?.openAdmin(), 'ac-tool--quiet');
    this.util.append(tools);

    // Lock-Fehler sichtbar
    this.errEl.replaceChildren();
    this.errEl.classList.toggle('is-on', c.lock.error !== null);
    if (c.lock.error !== null) this.errEl.append(el('span', 'ac-err-k ac-bl2', '!'), el('span', 'ac-err-t', c.lock.error));

    this.navs = navs;
    if (!navs.some((n) => n.dataset.nav === this.cursor)) this.cursor = 'start';
    this.renderSelection();
  }

  /** Auswahl/Cursor ohne Neuaufbau nachziehen (nach select() kommt kein update). */
  private renderSelection(): void {
    const c = this.ctx;
    if (!c) return;
    for (const n of this.navs) {
      const key = n.dataset.nav ?? '';
      n.classList.toggle('is-cursor', key === this.cursor);
      if (key.startsWith('card:')) n.classList.toggle('is-sel', key === `card:${this.sel}`);
    }
    const lv = c.levels[this.sel];
    const lvText = this.startRow?.querySelector('.ac-start-lv');
    if (lvText) lvText.textContent = lv ? `${lv.num} ${lv.name}` : '';
    const d = this.detail;
    if (!d) return;
    d.replaceChildren();
    if (!lv) return;
    d.append(el('span', 'ac-det-sub', lv.subtitle ?? ''));
    const right = el('span', 'ac-det-r');
    if (lv.recommended) right.append(el('span', 'ac-det-rec', lv.recommended));
    if (lv.nextMedal) {
      const nx = el('span', 'ac-det-next');
      nx.append(el('span', 'ac-det-k', 'NEXT'), medalChip(lv.nextMedal.id), el('span', 'ac-det-t', formatTime(lv.nextMedal.limit)));
      right.append(nx);
    } else if (lv.medals) right.append(el('span', 'ac-det-all', 'ALL MEDALS'));
    d.append(right);
  }

  // ------------------------------------------------------------------ Aktionen

  private play(c: FrontDoorContext, id: string | null): void {
    if (id === null) return;
    // Münze verbrauchen — aber nur, wenn der Start auch angenommen wird (während pending ignoriert play()).
    if (credits > 0 && !c.lock.pending) credits--;
    c.play(id);
  }

  private clickCard(lv: FrontDoorLevel): void {
    const c = this.ctx;
    if (!c) return;
    // Erster Klick wählt, Klick auf die gewählte Karte startet (wie "Player Select": zweimal drücken).
    if (lv.index !== this.sel) {
      this.selectLevel(lv.index);
      this.setCursor(`card:${lv.index}`);
    } else this.play(c, lv.id);
  }

  private selectLevel(i: number): void {
    const c = this.ctx;
    if (!c || c.levels.length === 0) return;
    const n = c.levels.length;
    this.sel = ((i % n) + n) % n;
    c.select(this.sel);
    this.renderSelection();
  }

  private setCursor(key: string): void {
    if (this.cursor === key) return;
    this.cursor = key;
    for (const n of this.navs) n.classList.toggle('is-cursor', n.dataset.nav === key);
  }

  private activateCursor(): void {
    const b = this.navs.find((n) => n.dataset.nav === this.cursor);
    // click() synchron → play() bleibt in der Geste. Gesperrte (disabled) Knöpfe tun nichts.
    b?.click();
  }

  private insertCoin(now: number): void {
    credits = Math.min(99, credits + 1);
    // Münze = Geste: Musik jetzt entsperren (läuft im Menü gedämpft) — der Automat "erwacht".
    this.ctx?.startMusic();
    this.coinUntil = now + COIN_MS;
    this.root?.classList.add('is-coin');
    this.toMenu(now, true);
  }

  private setMode(m: Mode, now: number): void {
    this.mode = m;
    this.modeT0 = now;
    const r = this.root;
    if (r) r.dataset.mode = m;
    this.renderCredit();
  }

  private toAttract(now: number): void {
    this.setMode('attract', now);
    this.showPage(0, now);
  }

  private toMenu(now: number, cut: boolean): void {
    this.setMode('menu', now);
    this.lastInput = now;
    if (cut) this.cutAt(now);
  }

  private showPage(i: number, now: number): void {
    this.page = i;
    this.pageT0 = now;
    for (let k = 0; k < this.pageEls.length; k++) this.pageEls[k].classList.toggle('is-on', k === i);
    if (this.root) this.root.dataset.page = PAGES[i];
    this.cutAt(now);
  }

  /** Harter Bildwechsel: kurz Zeilenversatz/Helligkeitssprung (reducedMotion: nichts — der Schnitt reicht). */
  private cutAt(now: number): void {
    if (this.reduced || !this.root) return;
    this.cutUntil = now + CUT_MS;
    this.root.classList.add('is-cut');
  }

  // ------------------------------------------------------------------ Eingabe

  private readonly onKey = (e: KeyboardEvent): void => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (IGNORE.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    const now = performance.now();
    this.lastInput = now;
    if (this.mode !== 'menu') {
      // Gedrückt gehaltene Taste aus dem Spiel (Sprung) wirft keine Münzen nach.
      if (e.repeat) return;
      e.preventDefault();
      this.insertCoin(now);
      return;
    }
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        e.preventDefault();
        this.move(-1, 0);
        break;
      case 'ArrowRight':
      case 'KeyD':
        e.preventDefault();
        this.move(1, 0);
        break;
      case 'ArrowUp':
      case 'KeyW':
        e.preventDefault();
        this.move(0, -1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        e.preventDefault();
        this.move(0, 1);
        break;
      case 'Space':
        // Fokussierter Knopf: Browser löst selbst click aus. Wiederholung/frisch gemountet: Sprungtaste aus dem Spiel.
        if (t instanceof HTMLButtonElement || e.repeat || now - this.mountedAt < 400) return;
        e.preventDefault();
        this.activateCursor();
        break;
      case 'Digit5':
      case 'Numpad5':
        // Münztaste wie an Emulatoren.
        if (e.repeat) return;
        credits = Math.min(99, credits + 1);
        this.coinUntil = now + COIN_MS;
        this.root?.classList.add('is-coin');
        this.renderCredit();
        break;
      default:
        break;
    }
  };

  /** Klick irgendwo im Attract-Mode = Münze (Menü-Knöpfe stoppen ihr click selbst). */
  private readonly onRootClick = (): void => {
    if (this.mode === 'menu') return;
    this.insertCoin(performance.now());
  };

  /** Kein Fokus per Maus: sonst löst eine Leertaste aus dem Spiel später den Knopf aus. Tab-Fokus bleibt. */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.target instanceof HTMLButtonElement || (e.target instanceof Element && e.target.closest('button'))) e.preventDefault();
  };

  private readonly onMouseMove = (): void => {
    this.lastInput = performance.now();
  };

  /** Räumliche Navigation: nächster Knopf in Richtung (dx, dy); auf den Karten wechselt ←/→ die Stage. */
  private move(dx: number, dy: number): void {
    const c = this.ctx;
    if (!c) return;
    const cur = this.navs.find((n) => n.dataset.nav === this.cursor) ?? null;
    const onCard = this.cursor.startsWith('card:');
    if (onCard && dx !== 0) {
      this.selectLevel(this.sel + dx);
      this.setCursor(`card:${this.sel}`);
      return;
    }
    if (!cur) {
      this.setCursor('start');
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLButtonElement | null = null;
    let bestScore = Infinity;
    for (const n of this.navs) {
      if (n === cur) continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0) continue;
      const bx = r.left + r.width / 2;
      const by = r.top + r.height / 2;
      const along = dx !== 0 ? (bx - ax) * dx : (by - ay) * dy;
      // Kandidat muss jenseits der eigenen Kante liegen (Toleranz ¼ Größe) — sonst gilt die angehobene Karte
      // nebenan als "darunter" und START als "rechts" von TRAINING.
      const beyond =
        dx > 0 ? r.left >= a.right - a.width / 4 : dx < 0 ? r.right <= a.left + a.width / 4 : dy > 0 ? r.top >= a.bottom - a.height / 4 : r.bottom <= a.top + a.height / 4;
      if (along <= 2 || !beyond) continue;
      // Quer-Abstand: 0, solange sich die Knöpfe in der Querachse überlappen.
      const cross = dx !== 0 ? Math.max(0, Math.max(r.top, a.top) - Math.min(r.bottom, a.bottom)) : Math.max(0, Math.max(r.left, a.left) - Math.min(r.right, a.right));
      const crossC = dx !== 0 ? Math.abs(by - ay) : Math.abs(bx - ax);
      const score = along + cross * 4 + crossC * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (!best) return;
    let key = best.dataset.nav ?? 'start';
    // Hoch auf die Kartenreihe: immer zur gewählten Stage, nicht zur nächstgelegenen.
    if (key.startsWith('card:') && !onCard) key = `card:${this.sel}`;
    this.setCursor(key);
  }

  // ------------------------------------------------------------------ Frame

  private readonly frame = (t: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const c = this.ctx;
    const r = this.root;
    if (!c || !r) return;
    if (!this.reduced) {
      const b = c.beat();
      // Blinken im Takt: b1 = alle 2 Beats (INSERT COIN), b2 = halber Beat (Cursor), kick = Marquee-Licht.
      const b1 = (Math.floor(b.beat / 2) & 1) === 0;
      const b2 = b.phase < 0.5;
      const k = b.kick > 0.55;
      if (b1 !== this.b1) {
        this.b1 = b1;
        r.classList.toggle('ac-b1', b1);
      }
      if (b2 !== this.b2) {
        this.b2 = b2;
        r.classList.toggle('ac-b2', b2);
      }
      if (k !== this.kick) {
        this.kick = k;
        r.classList.toggle('ac-kick', k);
      }
    }
    if (this.cutUntil > 0 && t >= this.cutUntil) {
      this.cutUntil = 0;
      r.classList.remove('is-cut');
    }
    if (this.coinUntil > 0 && t >= this.coinUntil) {
      this.coinUntil = 0;
      r.classList.remove('is-coin');
    }
    if (this.mode === 'power') {
      if (t - this.modeT0 >= POWER_MS) {
        this.setMode('attract', t);
        this.pageT0 = t;
      }
    } else if (this.mode === 'attract') {
      if (t - this.pageT0 >= PAGE_MS[PAGES[this.page]]) this.showPage((this.page + 1) % PAGES.length, t);
      if (PAGES[this.page] === 'howto' && this.demo) {
        this.demo.draw(this.reduced ? 0.3 : (t - this.pageT0) / 1000);
        const side = this.demo.side();
        if (side !== this.demoSide) {
          this.demoSide = side;
          this.keyA?.classList.toggle('is-down', side < 0);
          this.keyD?.classList.toggle('is-down', side > 0);
        }
      }
    } else if (t - this.lastInput >= IDLE_MS) this.toAttract(t);
  };
}

const factory: FrontDoorFactory = () => new ArcadeDoor();
export default factory;
