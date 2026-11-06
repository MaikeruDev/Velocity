/**
 * Stil 'ps2' (Plan 010) — "Disc eingelegt, Konsole bootet".
 *
 * Boot: Schwärze → "Disc wird gelesen" → Kristall-Türme wachsen aus dem Void, Kamera-Kran, das Logo löst sich per
 * Bayer-Raster auf (≤ 3.7 s, jede Taste/Klick überspringt; bei Rückkehr und reducedMotion gar nicht).
 * Danach ein Konsolen-Hauptmenü: rotierende Low-Poly-Objekte als Menüpunkte (eigener Low-Res-three.js-Canvas,
 * Nearest hochskaliert), eine Disc-Auswahl auf einer Umlaufbahn, ein Memory-Card-Browser (Profil + Speicherstände)
 * und eine System-Konfiguration. Layout und Mausziele sind DOM; die 3D-Objekte sitzen an DOM-Ankern (scene.ts).
 * Eigenes CSS: ./ps2.css, alles unter .vel-menu.vel-style--ps2.
 */
import './ps2.css';
import type { FrontDoor, FrontDoorAction, FrontDoorContext, FrontDoorFactory, FrontDoorLevel, MedalId } from '../types';
import { MEDAL_NAMES } from '../../medals';
import { accountName, avatar, button, el, fmtTime, keycap, medalChip } from './dom';
import type { FgKind, FgObj } from './scene';
import { BOOT_LEN, levelColor, Ps2Scene } from './scene';
import { rgb } from './models';
import type { Rgb } from './models';

type View = 'main' | 'discs' | 'card' | 'system';
type MainId = 'play' | 'training' | 'card' | 'board' | 'cosmetics' | 'system';

interface MainItem {
  readonly id: MainId;
  readonly kind: FgKind;
  readonly label: string;
  readonly glow: Rgb;
}

const MAIN_ITEMS: readonly MainItem[] = [
  { id: 'play', kind: 'disc', label: 'Spielen', glow: rgb('#33c8ff') },
  { id: 'training', kind: 'cone', label: 'Training', glow: rgb('#ff8a3a') },
  { id: 'card', kind: 'card', label: 'Memory Card', glow: rgb('#ff3fd0') },
  { id: 'board', kind: 'trophy', label: 'Bestenliste', glow: rgb('#ffcc3a') },
  { id: 'cosmetics', kind: 'gem', label: 'Kosmetik', glow: rgb('#d03cff') },
  { id: 'system', kind: 'gear', label: 'System', glow: rgb('#8fb4ff') },
];

/** Systemliste (Reihenfolge = Pfeil-Navigation). */
type SysId = 'settings' | 'controls' | 'fullscreen' | 'lab' | 'admin';
const SYS_ITEMS: readonly { id: SysId; label: string; hint: string }[] = [
  { id: 'settings', label: 'Einstellungen', hint: 'Maus, Sicht, Movement, Grafik, Ton' },
  { id: 'controls', label: 'Steuerung', hint: 'Tasten belegen' },
  { id: 'fullscreen', label: 'Vollbild', hint: 'Bildschirm füllen (F11 geht auch)' },
  { id: 'lab', label: 'Menü-Labor', hint: 'Anderen Hauptmenü-Stil ausprobieren' },
  { id: 'admin', label: 'Admin', hint: 'Freischaltungen und Medaillen setzen (F8)' },
];

/** Bleibt über Mounts erhalten (die Front Door wird bei jeder Rückkehr neu gemountet). */
const memory: { view: View; main: number; card: number; sys: number } = { view: 'main', main: 0, card: 0, sys: 0 };

const SKIP_GUARD_MS = 350;
/** 3D-Symbole als PNG-URLs (CSS-Variable → Wert), einmal je Sitzung gerendert. */
let iconCache: Map<string, string> | null = null;

class Ps2Door implements FrontDoor {
  private root: HTMLElement | null = null;
  private ctx: FrontDoorContext | null = null;
  private scene: Ps2Scene | null = null;
  private ui: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private prompts: HTMLElement | null = null;
  private errorBox: HTMLElement | null = null;
  private statusBox: HTMLElement | null = null;
  private crumb: HTMLElement | null = null;
  private clock: HTMLElement | null = null;
  private bootBox: HTMLElement | null = null;
  private logoCanvases: HTMLCanvasElement[] = [];
  private logoImg: HTMLImageElement | null = null;

  private raf = 0;
  private clockTimer = 0;
  private lastT = 0;
  private bootStart = 0;
  private booting = false;
  private skipGuardUntil = 0;
  private dirty = true;
  /** DOM-Anker im nächsten Frame neu messen (ein getBoundingClientRect-Satz, nicht je Frame). */
  private measurePending = false;
  private resizeObs: ResizeObserver | null = null;

  private view: View = 'main';
  private levelSel = 0;

  // 3D-Objekte je Ansicht
  private mainObjs: FgObj[] = [];
  private ringObjs: FgObj[] = [];
  private saveObjs: FgObj[] = [];
  private profileObj: FgObj | null = null;
  private gearObj: FgObj | null = null;
  /** Anker-Element je Objekt der aktuellen Ansicht. */
  private anchors: { o: FgObj; e: HTMLElement }[] = [];
  private ringAnchor: HTMLElement | null = null;

  // Knöpfe, deren Optik die Auswahl zeigt (kein Neubau beim Pfeil)
  private itemBtns: HTMLButtonElement[] = [];
  private saveBtns: HTMLButtonElement[] = [];
  private sysBtns: HTMLButtonElement[] = [];
  private infoBox: HTMLElement | null = null;
  private detailBox: HTMLElement | null = null;
  private panelBox: HTMLElement | null = null;

  // ------------------------------------------------------------------ Lebenszyklus

  mount(root: HTMLElement, ctx: FrontDoorContext): void {
    this.root = root;
    this.ctx = ctx;
    this.levelSel = ctx.selected;
    const boot = ctx.entry === 'boot' && !ctx.reducedMotion;
    // Erster Boot startet im Hauptmenü; Rückkehr landet dort, wo man war (aus der Disc-Auswahl → wieder dort).
    this.view = ctx.entry === 'boot' ? 'main' : memory.view;
    if (ctx.entry === 'boot') memory.main = 0;

    const scene = new Ps2Scene();
    scene.reducedMotion = ctx.reducedMotion;
    this.scene = scene;
    root.append(scene.canvas);

    for (const it of MAIN_ITEMS) {
      const o = scene.addObj(it.kind, 0);
      o.dimIdle = 0.4;
      this.mainObjs.push(o);
    }
    this.profileObj = scene.addObj('card', 1);
    this.profileObj.dimIdle = 0;
    this.profileObj.sway = true;
    this.gearObj = scene.addObj('gear', 2);
    this.gearObj.dimIdle = 0;
    this.syncLevelObjs();

    this.ui = el('div', 'ps2-ui');
    root.append(this.ui);
    this.buildChrome();

    // Logo-Bild einmal laden: Boot (WebGL) + pixeliges Logo im Menü teilen es.
    const img = new Image();
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (this.logoImg !== img) return;
      this.scene?.setLogoImage(img);
      this.drawLogos();
      this.dirty = true;
    });
    img.src = ctx.assets.logoUrl;
    this.logoImg = img;

    document.fonts?.ready.then(() => {
      this.measurePending = true;
    }).catch(() => undefined);
    this.resizeObs = new ResizeObserver(() => this.relayout());
    this.resizeObs.observe(root);
    window.addEventListener('keydown', this.onKey);
    root.addEventListener('mousedown', this.onMouseDown);
    root.addEventListener('click', this.onRootClick);
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('wheel', this.onWheel, { passive: false });
    this.clockTimer = window.setInterval(() => this.tickClock(), 5000);
    this.tickClock();

    this.renderView(false);
    this.relayout();
    if (boot) this.startBoot();
    else {
      scene.bootT = BOOT_LEN;
      this.ui.classList.add('is-live', 'is-instant');
      scene.snap();
    }
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  update(ctx: FrontDoorContext): void {
    const prev = this.ctx;
    this.ctx = ctx;
    this.levelSel = ctx.selected;
    if (this.scene) this.scene.reducedMotion = ctx.reducedMotion;
    if (!prev || prev.levels.length !== ctx.levels.length) this.syncLevelObjs();
    this.renderStatus();
    this.renderError();
    this.renderView(true);
    this.dirty = true;
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.clockTimer);
    window.removeEventListener('keydown', this.onKey);
    const r = this.root;
    if (r) {
      r.removeEventListener('mousedown', this.onMouseDown);
      r.removeEventListener('click', this.onRootClick);
      r.removeEventListener('pointerdown', this.onPointerDown);
      r.removeEventListener('wheel', this.onWheel);
    }
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.exportLook();
    if (this.logoImg) this.logoImg.src = '';
    this.logoImg = null;
    this.scene?.dispose();
    this.scene = null;
    memory.view = this.view;
    r?.replaceChildren();
    this.root = null;
    this.ctx = null;
    this.mainObjs = [];
    this.ringObjs = [];
    this.saveObjs = [];
    this.anchors = [];
    this.logoCanvases = [];
  }

  /**
   * Brücke zu den Bestands-Screens (Training, Bestenliste, Kosmetik, Einstellungen …), die Menu.ts baut: Standbild
   * der Welt, Pixel-Logo, 3D-Symbole und Kontoname als CSS-Variablen am Menü-Root. ps2.css (nur unter
   * .vel-style--ps2) setzt daraus Hintergrund, Kopfzeile und Symbole — dieselbe Welt ohne zweiten WebGL-Kontext.
   * Einmal beim Abbau, nie im Frame-Pfad; Symbole werden je Sitzung nur einmal gerendert.
   */
  private exportLook(): void {
    const s = this.scene;
    const c = this.ctx;
    const menu = this.root?.closest<HTMLElement>('.vel-menu');
    if (!s || !c || !menu) return;
    try {
      const st = menu.style;
      const r = s.canvasRect;
      st.setProperty('--ps2-bd', `url("${s.snapshotBackdrop()}")`);
      st.setProperty('--ps2-bd-x', `${r.x}px`);
      st.setProperty('--ps2-bd-y', `${r.y}px`);
      st.setProperty('--ps2-bd-w', `${r.w}px`);
      st.setProperty('--ps2-bd-h', `${r.h}px`);
      st.setProperty('--ps2-px', `${s.scale / (window.devicePixelRatio || 1)}px`);
      if (iconCache === null) {
        const out = new Map<string, string>();
        const one = (name: string, o: FgObj | undefined | null): void => {
          if (!o) return;
          out.set(`--ps2-i-${name}`, `url("${s.renderIcon(o, 20)}")`);
          out.set(`--ps2-i-${name}-lg`, `url("${s.renderIcon(o, 48)}")`);
        };
        MAIN_ITEMS.forEach((it, i) => one(it.kind, this.mainObjs[i]));
        this.ringObjs.forEach((o, i) => one(`disc${i}`, o));
        iconCache = out;
      }
      for (const [k, v] of iconCache) st.setProperty(k, v);
      // Kopf-Logo der Bestands-Screens: ~96 CSS-px breit, aber im Low-Res-Raster (ganzzahlig hochskaliert)
      const img = this.logoImg;
      if (img && img.complete && img.naturalWidth > 0) {
        const dpr = window.devicePixelRatio || 1;
        // Fester Faktor 2 statt Szenen-Raster: bei 1080p (×4) blieben sonst nur 24 Pixel Breite — unlesbar
        const LOGO_PX = 2;
        const lw = Math.max(8, Math.round((96 * dpr) / LOGO_PX));
        const lh = Math.round((lw * img.naturalHeight) / img.naturalWidth);
        const cv = document.createElement('canvas');
        cv.width = lw;
        cv.height = lh;
        const g = cv.getContext('2d');
        if (g) {
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, lw, lh);
          st.setProperty('--ps2-logo', `url("${cv.toDataURL('image/png')}")`);
          st.setProperty('--ps2-logo-w', `${(lw * LOGO_PX) / dpr}px`);
          st.setProperty('--ps2-logo-h', `${(lh * LOGO_PX) / dpr}px`);
        }
      }
      const a = c.account;
      st.setProperty('--ps2-acc', JSON.stringify((a.name ?? (a.online ? 'Lokales Profil' : 'Offline')).toUpperCase()));
    } catch (err) {
      // Nur Optik: ohne Standbild fallen die Screens auf den Verlauf zurück.
      console.warn('ps2: Standbild für die Bestands-Screens fehlgeschlagen', err);
    }
  }

  onAction(a: FrontDoorAction): void {
    if (this.booting) {
      this.skipBoot();
      return;
    }
    if (performance.now() < this.skipGuardUntil) return;
    if (a === 'confirm') this.confirm();
    else if (a === 'back') this.back();
  }

  // ------------------------------------------------------------------ Boot

  private startBoot(): void {
    this.booting = true;
    this.bootStart = performance.now();
    const b = el(
      'div',
      'ps2-boot',
      el('div', 'ps2-boot-read', el('span', 'ps2-boot-disc'), 'Disc wird gelesen'),
      el('div', 'ps2-boot-sub', this.ctx?.version ?? ''),
      el('div', 'ps2-boot-skip', 'Taste oder Klick — überspringen'),
    );
    this.root?.append(b);
    this.bootBox = b;
  }

  /** guard: per Taste/Klick übersprungen → die Enter-Aktion derselben Taste nicht noch als "OK" werten. */
  private skipBoot(guard = true): void {
    if (!this.booting) return;
    this.booting = false;
    if (guard) this.skipGuardUntil = performance.now() + SKIP_GUARD_MS;
    if (this.scene) this.scene.bootT = BOOT_LEN;
    this.bootBox?.remove();
    this.bootBox = null;
    this.ui?.classList.add('is-live');
    this.scene?.restartPop();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ Gerüst (Kopf, Fuß)

  private buildChrome(): void {
    const ui = this.ui;
    const c = this.ctx;
    if (!ui || !c) return;
    const brandLogo = el('canvas', 'ps2-logo ps2-logo--small');
    this.crumb = el('span', 'ps2-crumb');
    const brand = button('ps2-brand', () => this.go('main'), brandLogo, this.crumb);
    brand.title = 'Hauptmenü';
    this.statusBox = el('div', 'ps2-status');
    this.clock = el('span', 'ps2-clock');
    const top = el('header', 'ps2-top', brand, el('div', 'ps2-top-right', this.statusBox, this.clock));
    this.stage = el('main', 'ps2-stage');
    this.errorBox = el('div', 'ps2-error');
    this.errorBox.setAttribute('role', 'alert');
    this.prompts = el('div', 'ps2-prompts');
    const lab = button('ps2-foot-link', () => this.ctx?.openLab(), 'Menü-Labor');
    const foot = el('footer', 'ps2-bottom', el('span', 'ps2-version', c.version), this.prompts, lab);
    // Bühne zuerst im DOM (erster Knopf = erster Menüpunkt, Tab-Reihenfolge), Platz per grid-area.
    ui.append(this.stage, top, this.errorBox, foot);
    this.renderStatus();
    this.renderError();
  }

  private renderStatus(): void {
    const box = this.statusBox;
    const c = this.ctx;
    if (!box || !c) return;
    box.replaceChildren();
    const a = c.account;
    if (a.signedIn && a.name) {
      const chip = button('ps2-account', () => this.go('card'), avatar(a.avatarUrl, a.name, 24), accountName(a.name, a.dev, 'ps2-account-name'));
      chip.title = 'Memory Card öffnen';
      box.append(chip);
    } else if (a.loginRequired) {
      box.append(button('ps2-account ps2-account--login', () => this.ctx?.signIn(), el('span', 'ps2-discord'), 'Mit Discord anmelden'));
    } else if (a.online) {
      const name = a.name ?? 'Lokales Profil';
      box.append(button('ps2-account', () => this.go('card'), avatar(a.avatarUrl, name, 24), accountName(name, a.dev, 'ps2-account-name')));
    } else box.append(el('span', 'ps2-account ps2-account--off', 'Offline'));
  }

  private renderError(): void {
    const box = this.errorBox;
    const c = this.ctx;
    if (!box || !c) return;
    const msg = c.lock.error;
    box.replaceChildren();
    box.hidden = msg === null;
    if (msg !== null) box.append(el('strong', 'ps2-error-head', 'Fehler'), el('span', '', msg));
  }

  private tickClock(): void {
    if (!this.clock) return;
    const d = new Date();
    this.clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  private renderPrompts(): void {
    const p = this.prompts;
    if (!p) return;
    p.replaceChildren();
    const item = (keys: HTMLElement[], label: string, onClick: (() => void) | null, lock = false): void => {
      const kids = [...keys, el('span', 'ps2-prompt-label', label)];
      if (onClick === null) {
        p.append(el('span', 'ps2-prompt', ...kids));
        return;
      }
      const b = button('ps2-prompt ps2-prompt--btn', onClick, ...kids);
      if (lock) this.ctx?.markLockButton(b);
      p.append(b);
    };
    const lr = [keycap('◀'), keycap('▶')];
    switch (this.view) {
      case 'main':
        item(lr, 'Wählen', null);
        item([keycap('Enter', true)], 'OK', () => this.confirm());
        break;
      case 'discs':
        item(lr, 'Disc', null);
        item([keycap('Enter', true)], 'Starten', () => this.confirm(), true);
        item([keycap('Esc', true)], 'Zurück', () => this.back());
        break;
      case 'card':
        item([keycap('◀'), keycap('▶'), keycap('▲'), keycap('▼')], 'Slot', null);
        item([keycap('Enter', true)], 'Laden', () => this.confirm(), this.cardSlotIsLevel());
        item([keycap('Esc', true)], 'Zurück', () => this.back());
        break;
      case 'system':
        item([keycap('▲'), keycap('▼')], 'Wählen', null);
        item([keycap('Enter', true)], 'OK', () => this.confirm());
        item([keycap('Esc', true)], 'Zurück', () => this.back());
        break;
    }
  }

  // ------------------------------------------------------------------ Logo (pixelig, im Raster der Szene)

  /** Logo-Canvas in Low-Res-Auflösung zeichnen, per CSS ganzzahlig hoch — gleiche Pixelgröße wie die 3D-Welt. */
  private drawLogos(): void {
    const img = this.logoImg;
    const s = this.scene;
    if (!img || !img.complete || img.naturalWidth === 0 || !s) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of this.logoCanvases) {
      const want = Number(c.dataset.cssw ?? '0');
      if (!(want > 0)) continue;
      const w = Math.max(8, Math.round((want * dpr) / s.scale));
      const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
      c.width = w;
      c.height = h;
      c.style.width = `${(w * s.scale) / dpr}px`;
      c.style.height = `${(h * s.scale) / dpr}px`;
      this.measurePending = true;
      const g = c.getContext('2d');
      if (!g) continue;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
    }
  }

  /** CSS-Breite der Logo-Canvases aus dem Layout ableiten (vor drawLogos). */
  private sizeLogos(): void {
    const root = this.root;
    if (!root) return;
    this.logoCanvases = Array.from(root.querySelectorAll<HTMLCanvasElement>('canvas.ps2-logo'));
    const k = this.uiScale();
    for (const c of this.logoCanvases) {
      const big = c.classList.contains('ps2-logo--big');
      const w = big ? Math.min(root.clientWidth * 0.5, 440 * k) : 128 * k;
      c.dataset.cssw = String(Math.round(w));
    }
    this.drawLogos();
  }

  private uiScale(): number {
    const root = this.root;
    if (!root) return 1;
    const v = parseFloat(getComputedStyle(root).getPropertyValue('--k'));
    return v > 0 ? v : 1;
  }

  // ------------------------------------------------------------------ Ansichten

  private go(v: View): void {
    if (this.booting) return;
    if (this.view === v) return;
    this.view = v;
    memory.view = v;
    this.renderView(false);
    this.scene?.restartPop();
    if (this.ctx?.reducedMotion) this.scene?.snap();
    this.dirty = true;
  }

  /** Ansicht neu aufbauen. keep = nur Daten neu (update), Auswahl/Animationen bleiben. */
  private renderView(keep: boolean): void {
    const stage = this.stage;
    const s = this.scene;
    if (!stage || !s || !this.ctx) return;
    stage.replaceChildren();
    stage.dataset.view = this.view;
    this.ui?.setAttribute('data-view', this.view);
    this.anchors = [];
    this.ringAnchor = null;
    this.itemBtns = [];
    this.saveBtns = [];
    this.sysBtns = [];
    this.infoBox = null;
    this.detailBox = null;
    this.panelBox = null;
    for (const o of s.objs) {
      o.shown = false;
      o.ring = false;
    }
    switch (this.view) {
      case 'main':
        this.buildMain(stage);
        break;
      case 'discs':
        this.buildDiscs(stage);
        break;
      case 'card':
        this.buildCard(stage);
        break;
      case 'system':
        this.buildSystem(stage);
        break;
    }
    // Kopfzeile: Logo + "◀ Hauptmenü" als Maus-Weg zurück (der Ansichtstitel steht groß darunter)
    if (this.crumb) this.crumb.textContent = this.view === 'main' ? '' : 'Hauptmenü';
    this.renderPrompts();
    this.applySelection();
    this.sizeLogos();
    this.measure();
    // Schriften/Logo können das Layout noch verschieben → im nächsten Frame noch einmal messen.
    this.measurePending = true;
    if (!keep) {
      // Einblenden neu anstoßen (Klasse weg, Reflow, wieder dran)
      stage.classList.remove('is-enter');
      void stage.offsetWidth;
      stage.classList.add('is-enter');
    }
  }

  // ---- Hauptmenü

  private buildMain(stage: HTMLElement): void {
    const c = this.ctx;
    const s = this.scene;
    if (!c || !s) return;
    const logo = el('canvas', 'ps2-logo ps2-logo--big');
    const hero = el('div', 'ps2-hero', logo, el('div', 'ps2-tagline', 'Bunnyhop · Air-Strafe · Surf'));
    const row = el('div', 'ps2-items');
    MAIN_ITEMS.forEach((it, i) => {
      const icon = el('span', 'ps2-item-icon');
      const label = el('span', 'ps2-item-label', it.label);
      const b = button('ps2-item', () => this.activateMain(i), icon, label);
      b.dataset.id = it.id;
      b.addEventListener('pointerenter', () => this.selectMain(i));
      if (it.id === 'training' && c.training.newbie) b.append(el('span', 'ps2-item-flag', 'Neu? Hier starten'));
      row.append(b);
      this.itemBtns.push(b);
      const o = this.mainObjs[i];
      o.shown = true;
      this.anchors.push({ o, e: icon });
    });
    this.infoBox = el('section', 'ps2-info');
    stage.append(el('div', 'ps2-main', hero, row, this.infoBox));
    this.renderInfo();
  }

  private selectMain(i: number): void {
    const n = MAIN_ITEMS.length;
    const j = ((i % n) + n) % n;
    if (j === memory.main) return;
    memory.main = j;
    this.applySelection();
    this.renderInfo();
  }

  private activateMain(i: number): void {
    const c = this.ctx;
    if (!c || this.booting) return;
    memory.main = i;
    switch (MAIN_ITEMS[i].id) {
      case 'play':
        this.go('discs');
        break;
      case 'training':
        c.openTraining();
        break;
      case 'card':
        this.go('card');
        break;
      case 'board':
        c.openLeaderboard();
        break;
      case 'cosmetics':
        c.openCosmetics();
        break;
      case 'system':
        this.go('system');
        break;
    }
  }

  /** Infotafel unter der Objektreihe: Titel, Satz, Daten, Direktknöpfe. */
  private renderInfo(): void {
    const box = this.infoBox;
    const c = this.ctx;
    if (!box || !c) return;
    box.replaceChildren();
    const it = MAIN_ITEMS[memory.main];
    box.style.setProperty('--glow', `rgb(${it.glow.map((v) => Math.round(v * 255)).join(',')})`);
    const meta = el('div', 'ps2-info-meta');
    const actions = el('div', 'ps2-info-actions');
    const primary = (label: string): HTMLButtonElement => {
      const b = button('ps2-btn ps2-btn--primary', () => this.activateMain(memory.main), keycap('Enter', true), label);
      actions.append(b);
      return b;
    };
    const fact = (k: string, v: string | Node): void => {
      meta.append(el('span', 'ps2-fact', el('em', '', k), typeof v === 'string' ? el('b', '', v) : v));
    };
    let desc = '';
    const lv = c.levels[this.levelSel] as FrontDoorLevel | undefined;
    switch (it.id) {
      case 'play': {
        desc = `${c.levels.length > 0 ? c.levels.length : '…'} Strecken auf der Disc. Medaillen schalten Handschuhe und Gegenstände frei.`;
        if (lv) {
          fact('Disc', `${lv.num} ${lv.name}`);
          fact('Bestzeit', lv.bestText);
          fact('Medaille', medalChip(lv.medal, true));
        } else fact('Disc', c.loading ? 'wird gelesen …' : '—');
        primary('Disc wählen');
        if (lv) {
          const q = button('ps2-btn', () => this.ctx?.play(lv.id), `Schnellstart ${lv.num}`);
          this.ctx?.markLockButton(q);
          actions.append(q);
        }
        break;
      }
      case 'training': {
        const t = c.training;
        desc = t.newbie
          ? 'Neu hier? In 15 Minuten lernst du Bhop, Strafen und Surfen — Schritt für Schritt, ohne Timer.'
          : 'Acht Lektionen von Auto-Hop bis Surf-Speed. Sterne für Pflicht, Bonus und Meister.';
        if (t.available) fact('Bestanden', t.countText);
        if (t.recommended) fact('Empfohlen', `${t.recommended.short} ${t.recommended.name}`);
        else if (t.available) fact('Status', 'alles bestanden');
        if (!t.available) fact('Lektionen', 'werden geladen …');
        const rec = t.recommended;
        if (rec && t.playable && t.newbie) {
          const b = button('ps2-btn ps2-btn--primary', () => this.ctx?.play(rec.id), `${rec.short} starten`);
          this.ctx?.markLockButton(b);
          actions.append(b);
          actions.append(button('ps2-btn', () => this.ctx?.openTraining(), keycap('Enter', true), 'Lektionen'));
        } else {
          primary('Lektionen');
          if (rec && t.playable) {
            const b = button('ps2-btn', () => this.ctx?.play(rec.id), `${rec.short} starten`);
            this.ctx?.markLockButton(b);
            actions.append(b);
          }
        }
        break;
      }
      case 'card': {
        desc = 'Profil und Speicherstände: Bestzeiten, Medaillen, Trainingsfortschritt.';
        const a = c.account;
        fact('Profil', a.name ? accountName(a.name, a.dev, 'ps2-fact-name') : a.loginRequired ? 'nicht angemeldet' : 'lokal');
        fact('Medaillen', this.medalSummary());
        primary('Öffnen');
        break;
      }
      case 'board': {
        desc = c.account.online ? 'Weltweite Zeiten — jeder Lauf wird auf dem Server nachgespielt und erst dann gewertet.' : 'Offline: die Bestenliste braucht eine Verbindung.';
        if (lv) fact('Strecke', `${lv.num} ${lv.name}`);
        fact('Status', c.account.online ? (c.account.backend === 'mock' ? 'Testserver' : 'online') : 'offline');
        primary('Öffnen');
        break;
      }
      case 'cosmetics': {
        const k = c.cosmetics;
        desc = 'Handschuhe und Gegenstände für die Hand — freigespielt mit Medaillen und Trainingssternen.';
        fact('Frei', `${k.unlocked}/${k.total}`);
        fact('Handschuh', k.gloveName);
        fact('Gegenstand', k.itemName);
        primary('Öffnen');
        break;
      }
      case 'system': {
        desc = 'Einstellungen, Steuerung, Vollbild und das Menü-Labor.';
        fact('Version', c.version);
        primary('Öffnen');
        break;
      }
    }
    box.append(el('h2', 'ps2-info-title', it.label), el('p', 'ps2-info-desc', desc), meta, actions);
  }

  private medalSummary(): HTMLElement {
    const c = this.ctx;
    const wrap = el('span', 'ps2-medal-sum');
    if (!c) return wrap;
    const order: MedalId[] = ['velocity', 'gold', 'silver', 'bronze'];
    for (const id of order) {
      const n = c.levels.filter((l) => l.medal === id).length;
      const chip = medalChip(id, true);
      chip.append(el('b', 'ps2-medal-count', `×${n}`));
      if (n === 0) chip.classList.add('is-zero');
      wrap.append(chip);
    }
    return wrap;
  }

  // ---- Disc-Auswahl

  private buildDiscs(stage: HTMLElement): void {
    const c = this.ctx;
    if (!c) return;
    const ring = el('div', 'ps2-ring');
    this.ringAnchor = ring;
    const prev = button('ps2-ring-arrow ps2-ring-arrow--l', () => this.moveLevel(-1), '◀');
    const next = button('ps2-ring-arrow ps2-ring-arrow--r', () => this.moveLevel(1), '▶');
    prev.title = 'Vorherige Disc';
    next.title = 'Nächste Disc';
    const ringWrap = el('div', 'ps2-ring-wrap', ring, prev, next);
    if (c.loading) ringWrap.append(el('div', 'ps2-ring-loading', 'Disc wird gelesen …'));
    for (const o of this.ringObjs) {
      o.shown = true;
      o.ring = true;
    }
    this.panelBox = el('section', 'ps2-slot-panel');
    stage.append(el('div', 'ps2-discs', el('div', 'ps2-view-head', el('h1', 'ps2-view-title', 'Disc wählen'), el('span', 'ps2-view-sub', 'Strecken auf dieser Disc')), el('div', 'ps2-discs-body', ringWrap, this.panelBox)));
    this.renderPanel();
  }

  private moveLevel(d: number): void {
    const c = this.ctx;
    if (!c || c.levels.length === 0) return;
    const n = c.levels.length;
    this.setLevel((((this.levelSel + d) % n) + n) % n);
  }

  private setLevel(i: number): void {
    const c = this.ctx;
    if (!c) return;
    this.levelSel = i;
    c.select(i);
    this.applySelection();
    this.renderPanel();
    this.renderDetail();
    this.dirty = true;
  }

  /** Speicherstand-Tafel der gewählten Disc: Name, Bestzeit, Medaillen-Leiter, Start. */
  private renderPanel(): void {
    const box = this.panelBox;
    const c = this.ctx;
    if (!box || !c) return;
    box.replaceChildren();
    const lv = c.levels[this.levelSel] as FrontDoorLevel | undefined;
    if (!lv) {
      box.append(el('p', 'ps2-info-desc', c.loading ? 'Disc wird gelesen …' : 'Keine Strecken gefunden.'));
      return;
    }
    box.style.setProperty('--disc', levelColor(lv.index));
    const head = el(
      'div',
      'ps2-slot-head',
      el('span', 'ps2-slot-num', `Disc ${lv.num} / ${String(c.levels.length).padStart(2, '0')}`),
      el('h2', 'ps2-slot-name', lv.name),
      lv.subtitle ? el('p', 'ps2-slot-sub', lv.subtitle) : null,
    );
    const best = el('div', 'ps2-slot-best', el('div', 'ps2-slot-best-t', el('em', '', 'Bestzeit'), el('b', lv.bestTime === null ? 'is-empty' : '', lv.bestText)), medalChip(lv.medal));
    const ladder = el('ol', 'ps2-ladder');
    if (lv.medals) {
      const order: MedalId[] = ['velocity', 'gold', 'silver', 'bronze'];
      for (const id of order) {
        const limit = lv.medals[id];
        const have = lv.bestTime !== null && lv.bestTime <= limit;
        const isNext = lv.nextMedal?.id === id;
        const row = el('li', `ps2-rung${have ? ' is-have' : ''}${isNext ? ' is-next' : ''}`, medalChip(id, 'dot'), el('span', 'ps2-rung-name', MEDAL_NAMES[id]), el('span', 'ps2-rung-time', fmtTime(limit)), el('span', 'ps2-rung-mark', have ? '✓' : isNext ? 'Ziel' : ''));
        ladder.append(row);
      }
    }
    const actions = el('div', 'ps2-info-actions');
    const start = button('ps2-btn ps2-btn--primary ps2-btn--start', () => this.ctx?.play(lv.id), keycap('Enter', true), 'Starten');
    this.ctx?.markLockButton(start);
    actions.append(start, button('ps2-btn', () => this.ctx?.openLeaderboard(lv.id), 'Bestenliste'));
    box.append(head, best, ladder);
    if (lv.recommended) box.append(el('p', 'ps2-slot-rec', `Vorher üben — ${lv.recommended}`));
    box.append(actions);
  }

  // ---- Memory Card

  /** Speicherstände: alle Level, dann Training, dann Kosmetik. */
  private cardSlots(): number {
    return (this.ctx?.levels.length ?? 0) + 2;
  }

  private cardSlotIsLevel(): boolean {
    return memory.card < (this.ctx?.levels.length ?? 0);
  }

  private buildCard(stage: HTMLElement): void {
    const c = this.ctx;
    if (!c) return;
    if (memory.card >= this.cardSlots()) memory.card = 0;
    const a = c.account;
    const name = a.name ?? (a.loginRequired ? 'Gast' : 'Lokales Profil');
    // Profil-Steckplatz
    const pIcon = el('div', 'ps2-profile-icon');
    if (this.profileObj) {
      this.profileObj.shown = true;
      this.anchors.push({ o: this.profileObj, e: pIcon });
    }
    const medals = el('div', 'ps2-profile-medals', this.medalSummary());
    const stats = el(
      'dl',
      'ps2-profile-stats',
      el('dt', '', 'Hand'),
      el('dd', '', `${c.cosmetics.gloveName} · ${c.cosmetics.itemName}`),
      el('dt', '', 'Zuletzt'),
      el('dd', '', c.cosmetics.latest ?? '—'),
      el('dt', '', 'Konto'),
      el('dd', '', !a.online ? 'offline' : a.backend === 'mock' ? 'Testserver' : a.signedIn ? 'Discord' : 'nicht angemeldet'),
    );
    // Fortschritt wie die Datenzeile eines Speicherstands: Medaillen-Stufen, Lektionen, Kosmetik
    const medalSteps = c.levels.reduce((n, l) => n + (l.medal === null ? 0 : 4 - (['velocity', 'gold', 'silver', 'bronze'] as const).indexOf(l.medal)), 0);
    const medalMax = c.levels.filter((l) => l.medals !== null).length * 4;
    const bars: [string, number, number][] = [
      ['Medaillen', medalSteps, medalMax],
      ['Training', c.training.passed, c.training.total],
      ['Kosmetik', c.cosmetics.unlocked, c.cosmetics.total],
    ];
    const sumHave = bars.reduce((n, b) => n + b[1], 0);
    const sumMax = bars.reduce((n, b) => n + b[2], 0);
    const pct = sumMax > 0 ? Math.round((sumHave / sumMax) * 100) : 0;
    const progress = el('div', 'ps2-progress', el('div', 'ps2-progress-head', el('em', '', 'Fortschritt'), el('b', '', `${pct}%`)));
    for (const [label, have, max] of bars) {
      const bar = el('span', 'ps2-bar');
      bar.style.setProperty('--fill', String(max > 0 ? have / max : 0));
      progress.append(el('div', 'ps2-progress-row', el('span', 'ps2-progress-label', label), bar, el('span', 'ps2-progress-num', max > 0 ? `${have}/${max}` : '—')));
    }
    const acts = el('div', 'ps2-profile-actions');
    acts.append(button('ps2-btn', () => this.ctx?.openProfile(), 'Profil'));
    if (a.loginRequired && !a.signedIn) acts.append(button('ps2-btn ps2-btn--discord', () => this.ctx?.signIn(), 'Mit Discord anmelden'));
    if (a.signedIn) acts.append(button('ps2-btn ps2-btn--quiet', () => this.ctx?.signOut(), 'Abmelden'));
    const profile = el(
      'section',
      'ps2-profile',
      el(
        'div',
        'ps2-profile-who',
        pIcon,
        el('div', 'ps2-profile-id', el('span', 'ps2-profile-tag', 'Profil'), el('span', 'ps2-profile-line', avatar(a.avatarUrl, name, 32), accountName(name, a.dev, 'ps2-profile-name'))),
      ),
      medals,
      progress,
      stats,
      acts,
    );

    const grid = el('div', 'ps2-saves');
    const levels = c.levels;
    for (let i = 0; i < this.cardSlots(); i++) {
      const icon = el('span', 'ps2-save-icon');
      let title = '';
      let sub: HTMLElement;
      let o: FgObj | undefined;
      if (i < levels.length) {
        const lv = levels[i];
        title = `${lv.num} ${lv.name}`;
        sub = el('span', 'ps2-save-sub', el('b', lv.bestTime === null ? 'is-empty' : '', lv.bestText), medalChip(lv.medal, true));
        o = this.saveObjs[i];
      } else if (i === levels.length) {
        title = 'Training';
        sub = el('span', 'ps2-save-sub', el('b', '', c.training.available ? `${c.training.countText}` : '—'), el('span', 'ps2-save-note', 'Lektionen'));
        o = this.saveObjs[levels.length];
      } else {
        title = 'Kosmetik';
        sub = el('span', 'ps2-save-sub', el('b', '', `${c.cosmetics.unlocked}/${c.cosmetics.total}`), el('span', 'ps2-save-note', 'frei'));
        o = this.saveObjs[levels.length + 1];
      }
      const b = button('ps2-save', () => this.activateCard(i), icon, el('span', 'ps2-save-title', title), sub);
      if (i < levels.length) {
        b.style.setProperty('--disc', levelColor(i));
        this.ctx?.markLockButton(b);
      }
      b.addEventListener('pointerenter', () => this.selectCard(i));
      grid.append(b);
      this.saveBtns.push(b);
      if (o) {
        o.shown = true;
        this.anchors.push({ o, e: icon });
      }
    }
    const used = levels.filter((l) => l.bestTime !== null).length;
    this.detailBox = el('div', 'ps2-save-detail');
    stage.append(
      el(
        'div',
        'ps2-card',
        el('div', 'ps2-view-head', el('h1', 'ps2-view-title', 'Memory Card'), el('span', 'ps2-view-sub', `Steckplatz 1 · ${used + (c.training.passed > 0 ? 1 : 0)} von ${this.cardSlots()} Ständen belegt`)),
        el('div', 'ps2-card-body', profile, el('div', 'ps2-saves-col', grid, this.detailBox)),
      ),
    );
    this.renderDetail();
  }

  private selectCard(i: number): void {
    const n = this.cardSlots();
    const j = ((i % n) + n) % n;
    if (j === memory.card) return;
    memory.card = j;
    const lvN = this.ctx?.levels.length ?? 0;
    if (j < lvN && this.ctx) {
      this.levelSel = j;
      this.ctx.select(j);
    }
    this.applySelection();
    this.renderDetail();
    this.renderPrompts();
  }

  private activateCard(i: number): void {
    const c = this.ctx;
    if (!c || this.booting) return;
    memory.card = i;
    if (i < c.levels.length) c.play(c.levels[i].id);
    else if (i === c.levels.length) c.openTraining();
    else c.openCosmetics();
  }

  private renderDetail(): void {
    const box = this.detailBox;
    const c = this.ctx;
    if (!box || !c) return;
    box.replaceChildren();
    const i = memory.card;
    if (i < c.levels.length) {
      const lv = c.levels[i];
      const next = lv.nextMedal ? `${MEDAL_NAMES[lv.nextMedal.id]} unter ${fmtTime(lv.nextMedal.limit)}` : lv.medals ? 'alles geholt' : '—';
      box.append(
        el('span', 'ps2-detail-name', `${lv.num} ${lv.name}`),
        el('span', 'ps2-detail-sub', lv.subtitle ?? ''),
        el('span', 'ps2-detail-fact', el('em', '', 'Nächstes Ziel'), el('b', '', next)),
        button('ps2-btn ps2-btn--small', () => this.ctx?.openLeaderboard(lv.id), 'Bestenliste'),
      );
    } else if (i === c.levels.length) {
      const r = c.training.recommended;
      box.append(el('span', 'ps2-detail-name', 'Training'), el('span', 'ps2-detail-sub', r ? `Empfohlen: ${r.short} ${r.name}` : c.training.available ? 'Alle Lektionen bestanden.' : 'Lektionen werden geladen …'));
      if (r && c.training.playable) {
        const b = button('ps2-btn ps2-btn--small', () => this.ctx?.play(r.id), `${r.short} starten`);
        this.ctx?.markLockButton(b);
        box.append(b);
      }
    } else {
      const k = c.cosmetics;
      box.append(el('span', 'ps2-detail-name', 'Kosmetik'), el('span', 'ps2-detail-sub', `${k.gloveName} · ${k.itemName}`), el('span', 'ps2-detail-fact', el('em', '', 'Zuletzt frei'), el('b', '', k.latest ?? '—')));
    }
  }

  // ---- System

  private buildSystem(stage: HTMLElement): void {
    const c = this.ctx;
    if (!c) return;
    const icon = el('div', 'ps2-sys-icon');
    if (this.gearObj) {
      this.gearObj.shown = true;
      this.anchors.push({ o: this.gearObj, e: icon });
    }
    const list = el('div', 'ps2-sys-list');
    SYS_ITEMS.forEach((it, i) => {
      const b = button(`ps2-sys-item${it.id === 'admin' ? ' ps2-sys-item--quiet' : ''}`, () => this.activateSys(i), el('span', 'ps2-sys-label', it.label), el('span', 'ps2-sys-hint', it.hint));
      if (it.id === 'admin') b.append(keycap('F8', true));
      b.addEventListener('pointerenter', () => this.selectSys(i));
      list.append(b);
      this.sysBtns.push(b);
    });
    stage.append(
      el(
        'div',
        'ps2-system',
        el('div', 'ps2-view-head', el('h1', 'ps2-view-title', 'System'), el('span', 'ps2-view-sub', c.version)),
        el('div', 'ps2-sys-body', icon, list),
      ),
    );
  }

  private selectSys(i: number): void {
    const n = SYS_ITEMS.length;
    memory.sys = ((i % n) + n) % n;
    this.applySelection();
  }

  private activateSys(i: number): void {
    const c = this.ctx;
    if (!c || this.booting) return;
    memory.sys = i;
    switch (SYS_ITEMS[i].id) {
      case 'settings':
        c.openSettings();
        break;
      case 'controls':
        c.openControls();
        break;
      case 'fullscreen':
        c.fullscreen();
        break;
      case 'lab':
        c.openLab();
        break;
      case 'admin':
        c.openAdmin();
        break;
    }
  }

  // ------------------------------------------------------------------ Auswahl → Optik + 3D

  private applySelection(): void {
    const s = this.scene;
    if (!s) return;
    for (const o of s.objs) o.selected = false;
    s.focus = null;
    switch (this.view) {
      case 'main': {
        this.itemBtns.forEach((b, i) => b.classList.toggle('is-selected', i === memory.main));
        const o = this.mainObjs[memory.main];
        o.selected = true;
        s.focus = o;
        s.focusColor = MAIN_ITEMS[memory.main].glow;
        break;
      }
      case 'discs': {
        const n = this.ringObjs.length;
        s.ring.count = n;
        s.ring.target = this.levelSel;
        const o = this.ringObjs[this.levelSel];
        if (o) {
          o.selected = true;
          s.focus = o;
          s.focusColor = hexRgb(levelColor(this.levelSel));
        }
        break;
      }
      case 'card': {
        this.saveBtns.forEach((b, i) => b.classList.toggle('is-selected', i === memory.card));
        const o = this.saveObjs[memory.card];
        if (o) {
          o.selected = true;
          s.focus = o;
          s.focusColor = memory.card < this.ringObjs.length ? hexRgb(levelColor(memory.card)) : memory.card === this.ringObjs.length ? rgb('#ff8a3a') : rgb('#d03cff');
        }
        if (this.profileObj) this.profileObj.selected = false;
        break;
      }
      case 'system': {
        this.sysBtns.forEach((b, i) => b.classList.toggle('is-selected', i === memory.sys));
        if (this.gearObj) {
          this.gearObj.selected = true;
          s.focus = this.gearObj;
          s.focusColor = rgb('#8fb4ff');
        }
        break;
      }
    }
    this.dirty = true;
  }

  /** Level-Discs (Umlaufbahn) und Speicherstand-Symbole an die Levelzahl anpassen. */
  private syncLevelObjs(): void {
    const s = this.scene;
    const c = this.ctx;
    if (!s || !c) return;
    for (const o of this.ringObjs) s.removeObj(o);
    for (const o of this.saveObjs) s.removeObj(o);
    this.ringObjs = [];
    this.saveObjs = [];
    c.levels.forEach((_lv, i) => {
      const o = s.addObj('disc', i);
      o.slot = i;
      o.dimIdle = 0.45;
      this.ringObjs.push(o);
    });
    c.levels.forEach((_lv, i) => {
      const o = s.addObj('disc', i);
      o.dimIdle = 0.3;
      this.saveObjs.push(o);
    });
    const cone = s.addObj('cone');
    cone.dimIdle = 0.3;
    const gem = s.addObj('gem');
    gem.dimIdle = 0.3;
    this.saveObjs.push(cone, gem);
  }

  // ------------------------------------------------------------------ Layout

  private relayout(): void {
    const r = this.root;
    const s = this.scene;
    if (!r || !s) return;
    const dpr = window.devicePixelRatio || 1;
    s.layout(r.clientWidth, r.clientHeight, dpr);
    this.measurePending = true;
    // Größe eines Low-Res-Pixels in CSS-Px: eigene Scanlines liegen genau auf den Pixelzeilen
    r.style.setProperty('--px', `${s.scale / dpr}px`);
    this.sizeLogos();
    this.measure();
    this.dirty = true;
  }

  /** DOM-Anker → 3D-Positionen (nur bei Aufbau/Größenänderung, nie je Frame). */
  private measure(): void {
    const r = this.root;
    const s = this.scene;
    if (!r || !s) return;
    const rr = r.getBoundingClientRect();
    for (const { o, e } of this.anchors) {
      const b = e.getBoundingClientRect();
      o.ax = b.left - rr.left + b.width / 2;
      o.ay = b.top - rr.top + b.height / 2;
      o.size = Math.min(b.width, b.height);
    }
    const ra = this.ringAnchor;
    if (ra) {
      const b = ra.getBoundingClientRect();
      s.ring.cx = b.left - rr.left + b.width / 2;
      s.ring.cy = b.top - rr.top + b.height / 2;
      s.ring.radius = Math.min(b.width * 0.42, b.height * 0.55);
    }
  }

  // ------------------------------------------------------------------ Eingabe

  private readonly onKey = (e: KeyboardEvent): void => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (this.booting) {
      // F-Tasten (F8 Admin, F1 Tuning) gehören dem Spiel; alles andere überspringt nur.
      if (/^F\d+$/.test(e.key)) return;
      this.skipBoot();
      if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let dx = 0;
    let dy = 0;
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        dx = -1;
        break;
      case 'ArrowRight':
      case 'KeyD':
        dx = 1;
        break;
      case 'ArrowUp':
      case 'KeyW':
        dy = -1;
        break;
      case 'ArrowDown':
      case 'KeyS':
        dy = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    // Fokus aus Knöpfen nehmen: sonst löste Enter den zuletzt geklickten Knopf aus statt der Auswahl.
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && this.root?.contains(ae)) ae.blur();
    this.navigate(dx, dy);
  };

  private navigate(dx: number, dy: number): void {
    switch (this.view) {
      case 'main':
        this.selectMain(memory.main + (dx !== 0 ? dx : dy));
        break;
      case 'discs':
        this.moveLevel(dx !== 0 ? dx : dy);
        break;
      case 'card': {
        const cols = this.saveCols();
        const n = this.cardSlots();
        let i = memory.card;
        if (dx !== 0) i = (i + dx + n) % n;
        else {
          i += dy * cols;
          if (i < 0 || i >= n) i = memory.card;
        }
        this.selectCard(i);
        break;
      }
      case 'system':
        this.selectSys(memory.sys + (dy !== 0 ? dy : dx));
        break;
    }
  }

  private saveCols(): number {
    const g = this.root?.querySelector<HTMLElement>('.ps2-saves');
    if (!g) return 3;
    const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter((s) => s.length > 0).length;
    return cols > 0 ? cols : 3;
  }

  private confirm(): void {
    const c = this.ctx;
    if (!c || this.booting) return;
    switch (this.view) {
      case 'main':
        this.activateMain(memory.main);
        break;
      case 'discs':
        if (c.levels.length > 0) c.play(c.levels[this.levelSel].id);
        break;
      case 'card':
        this.activateCard(memory.card);
        break;
      case 'system':
        this.activateSys(memory.sys);
        break;
    }
  }

  private back(): void {
    if (this.view !== 'main') this.go('main');
  }

  /** Maus soll Knöpfe nicht fokussieren (sonst stiehlt Enter die Pfeil-Auswahl). Klick bleibt. */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
  };

  private readonly onPointerDown = (): void => {
    if (this.booting) this.skipBoot();
  };

  /** Disc-Ansicht: Klick auf eine Disc der Bahn → wählen bzw. (vordere) starten — synchron in der Geste. */
  private readonly onRootClick = (e: MouseEvent): void => {
    if (this.view !== 'discs' || this.booting || !this.root || !this.scene) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    if (performance.now() < this.skipGuardUntil) return;
    const slot = this.scene.pickRing(e.clientX, e.clientY, this.root.getBoundingClientRect());
    if (slot < 0) return;
    if (slot === this.levelSel) this.ctx?.play(this.ctx.levels[slot].id);
    else this.setLevel(slot);
  };

  private wheelAcc = 0;
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.view !== 'discs' || this.booting) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY + e.deltaX;
    if (Math.abs(this.wheelAcc) >= 60) {
      this.moveLevel(this.wheelAcc > 0 ? 1 : -1);
      this.wheelAcc = 0;
    }
  };

  // ------------------------------------------------------------------ Frame

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const s = this.scene;
    const c = this.ctx;
    if (!s || !c) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    if (this.booting) {
      const bt = (now - this.bootStart) / 1000;
      s.bootT = bt;
      if (bt >= BOOT_LEN) this.skipBoot(false);
    }
    if (this.measurePending) {
      this.measurePending = false;
      this.measure();
      this.dirty = true;
    }
    // reducedMotion: nur bei Änderungen zeichnen (keine Dauer-Animation)
    if (c.reducedMotion && !this.dirty) return;
    this.dirty = false;
    const b = c.beat();
    s.frame(now / 1000, dt, b.bar, b.barPhase);
  };
}

function hexRgb(hex: string): Rgb {
  return rgb(hex);
}

const factory: FrontDoorFactory = () => new Ps2Door();
export default factory;
