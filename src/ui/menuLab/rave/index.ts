// Stil 'rave' (Plan 010): Hauptmenü als Warehouse-Rave-Flyer. Level = Line-up, Menüpunkte = Tracklist,
// Konto = Gästeliste-Armband; alles rastet auf den Takt (ctx.beat()). CSS: ./rave.css, nur unter .vel-style--rave.
import './rave.css';
import type { FrontDoor, FrontDoorAction, FrontDoorContext, FrontDoorFactory, FrontDoorLevel, MedalId } from '../types';
import { paintDots, paintGrain, paintPrint } from './print';

type Focus = 'lineup' | 'tracks';

interface Track {
  readonly code: string;
  readonly label: string;
  meta(c: FrontDoorContext): string;
  run(c: FrontDoorContext): void;
}

const MEDAL_LABEL: Readonly<Record<MedalId, string>> = { velocity: 'VELOCITY', gold: 'GOLD', silver: 'SILBER', bronze: 'BRONZE' };

/** Vorab gebaute Strings fürs rAF (keine Allokation pro Frame, Plan 010 §4.8). */
const K_STR = ['0', '0.25', '0.5', '0.75', '1'] as const;
const N_STR = ['0', '1', '2', '3', '4', '5', '6', '7'] as const;
/** Korn-Versatz je Beat (ganze Pixel, 8 feste Lagen) — das Xerox-Korn "springt" auf jeder Kick. */
const GRAIN_POS = [
  'translate3d(0px,0px,0)',
  'translate3d(-37px,-91px,0)',
  'translate3d(-112px,-13px,0)',
  'translate3d(-64px,-150px,0)',
  'translate3d(-171px,-58px,0)',
  'translate3d(-9px,-127px,0)',
  'translate3d(-143px,-171px,0)',
  'translate3d(-88px,-34px,0)',
] as const;

/** Ticker: so viele Beats, bis sich der Text einmal um seine Länge verschoben hat (Ruck je Beat). */
const TICKER_EASE = 'cubic-bezier(0.12, 0.9, 0.3, 1)';

function fmtTime(s: number): string {
  const cs = Math.round(s * 100);
  const m = Math.floor(cs / 6000);
  const r = cs - m * 6000;
  const sec = Math.floor(r / 100);
  const c = r - sec * 100;
  return `${m}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  // Synchron im Klick (Pointer Lock braucht die Geste).
  b.addEventListener('click', onClick);
  return b;
}

/** Discord-Avatar pixelig: immer 16 px holen (wie der klassische Titel), per CSS ×2/×3 ohne Glättung. */
function avatar(url: string | null, name: string): HTMLElement {
  const none = (): HTMLElement => el('span', 'rv-avatar rv-avatar--none', name.slice(0, 1).toUpperCase());
  if (!url) return none();
  let src: string;
  try {
    const u = new URL(url);
    u.searchParams.set('size', '16');
    src = u.toString();
  } catch {
    return none();
  }
  const img = el('img', 'rv-avatar');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.draggable = false;
  img.addEventListener('error', () => img.replaceWith(none()), { once: true });
  img.src = src;
  return img;
}

const TRACKS: readonly Track[] = [
  {
    code: 'A1',
    label: 'Training',
    meta: (c) => (c.training.available ? `${c.training.countText}${c.training.recommended ? ` · ${c.training.recommended.short}` : ''}` : '--'),
    run: (c) => c.openTraining(),
  },
  {
    code: 'A2',
    label: 'Bestenliste',
    meta: (c) => (c.account.online ? `akt ${c.levels[c.selected]?.num ?? '--'}` : 'offline'),
    run: (c) => c.openLeaderboard(),
  },
  { code: 'A3', label: 'Kosmetik', meta: (c) => `${c.cosmetics.unlocked}/${c.cosmetics.total}`, run: (c) => c.openCosmetics() },
  { code: 'A4', label: 'Profil', meta: (c) => (c.account.signedIn ? 'konto' : 'gast'), run: (c) => c.openProfile() },
  { code: 'B1', label: 'Einstellungen', meta: () => 'sens/fov', run: (c) => c.openSettings() },
  { code: 'B2', label: 'Steuerung', meta: () => 'tasten', run: (c) => c.openControls() },
  {
    code: 'B3',
    label: 'Vollbild',
    meta: () => (typeof document !== 'undefined' && document.fullscreenElement ? 'an' : 'aus'),
    run: (c) => c.fullscreen(),
  },
  { code: 'B4', label: 'Menü-Labor', meta: () => 'stil', run: (c) => c.openLab() },
];

const TICKER_A = ['VELOCITY', '132 BPM', 'NO GUNS JUST SPEED', 'BHOP · STRAFE · SURF', '128 TICK', 'ALL NIGHT LONG'];

function createRaveDoor(): FrontDoor {
  let ctx: FrontDoorContext | null = null;
  let root: HTMLElement | null = null;
  let wrap: HTMLElement | null = null;
  let raf = 0;
  let bootTimer = 0;
  let resizeTimer = 0;
  let musicAsked = false;
  let focus: Focus = 'lineup';
  let trackIdx = 0;
  let sel = 0;
  let levelKey = '';
  let tickerKey = '';
  let armed = false;

  // Teile, die neu gezeichnet werden.
  let lineup: HTMLElement | null = null;
  let actBtns: HTMLButtonElement[] = [];
  let trackBtns: HTMLButtonElement[] = [];
  let trackMeta: HTMLElement[] = [];
  let startBtn: HTMLButtonElement | null = null;
  let startName: HTMLElement | null = null;
  let startGoal: HTMLElement | null = null;
  let lockErr: HTMLElement | null = null;
  let newbieSlot: HTMLElement | null = null;
  let wristSlot: HTMLElement | null = null;
  let tickerB: HTMLElement | null = null;
  let tickerA: HTMLElement | null = null;
  let grain: HTMLElement | null = null;
  let printCv: HTMLCanvasElement | null = null;
  let versionEl: HTMLElement | null = null;
  let anims: Animation[] = [];

  // rAF-Zustand (nur Zahlen).
  let lastK = -1;
  let lastBeat = -1;
  let lastBar = -1;
  let lastLive = false;
  let lastEnergy = -1;
  let tickerBeats: number[] = [];

  const reduced = (): boolean => ctx?.reducedMotion ?? false;

  // ------------------------------------------------------------------ Aufbau

  const buildTicker = (cls: string, words: readonly string[]): HTMLElement => {
    const band = el('div', `rv-ticker ${cls}`);
    const track = el('div', 'rv-ticker-track');
    const unit = el('span', 'rv-ticker-unit');
    for (const w of words) {
      unit.append(el('span', 'rv-ticker-word', w), el('span', 'rv-ticker-sep', '//'));
    }
    track.append(unit);
    band.append(track);
    return band;
  };

  /** Ticker füllen (Einheit klonen, bis 2× Bildschirmbreite) und per WAAPI im Takt ruckeln lassen. */
  const armTickers = (): void => {
    for (const a of anims) a.cancel();
    anims = [];
    tickerBeats = [];
    const c = ctx;
    if (!c || !wrap) return;
    const bands = [tickerA, tickerB];
    const vw = wrap.clientWidth;
    const b = c.beat();
    const beatMs = 60000 / b.bpm;
    for (let bi = 0; bi < bands.length; bi++) {
      const band = bands[bi];
      if (!band) continue;
      const track = band.firstElementChild as HTMLElement | null;
      const unit = track?.firstElementChild as HTMLElement | null;
      if (!track || !unit) continue;
      // Alte Klone weg, Einheit messen (Layout-Lesen nur hier, beim Aufbau/Resize).
      while (track.childElementCount > 1) track.lastElementChild?.remove();
      const uw = unit.offsetWidth;
      if (uw <= 0) continue;
      const copies = Math.ceil((vw * 1.3) / uw) + 1;
      for (let i = 0; i < copies; i++) {
        const cl = unit.cloneNode(true) as HTMLElement;
        cl.setAttribute('aria-hidden', 'true');
        track.append(cl);
      }
      if (reduced()) continue;
      // Pro Beat ein Ruck von ~pxPerBeat; n Beats für eine Einheit.
      const pxPerBeat = (bi === 0 ? 7 : 5) * Number.parseFloat(getComputedStyle(wrap).getPropertyValue('--g') || '8');
      const n = Math.max(4, Math.round(uw / pxPerBeat));
      const frames: Keyframe[] = [];
      const dir = bi === 0 ? -1 : 1;
      for (let k = 0; k <= n; k++) {
        const x = dir === -1 ? (-uw * k) / n : -uw + (uw * k) / n;
        frames.push({ transform: `translate3d(${x.toFixed(2)}px,0,0)`, easing: TICKER_EASE });
      }
      const anim = track.animate(frames, { duration: n * beatMs, iterations: Infinity });
      anims.push(anim);
      tickerBeats.push(n);
    }
    syncTickers();
  };

  /** Ticker-Phase an die Beat-Uhr binden (nach Aufbau, beim Wechsel auf echte Musik, alle 8 Takte gegen Drift). */
  const syncTickers = (): void => {
    const c = ctx;
    if (!c) return;
    const b = c.beat();
    const beatMs = 60000 / b.bpm;
    for (let i = 0; i < anims.length; i++) {
      const n = tickerBeats[i] ?? 4;
      const t = b.beat - Math.floor(b.beat / n) * n;
      anims[i].currentTime = t * beatMs;
    }
  };

  const paintTextures = (): void => {
    if (!wrap || !printCv) return;
    const px = Number.parseFloat(getComputedStyle(wrap).getPropertyValue('--px') || '2');
    const w = Math.ceil(wrap.clientWidth / px);
    const h = Math.ceil(wrap.clientHeight / px);
    paintPrint(printCv, w, h, '#ff3fd0', '#33f0ff');
    printCv.style.width = `${w * px}px`;
    printCv.style.height = `${h * px}px`;
  };

  const buildHero = (): HTMLElement => {
    const hero = el('h1', 'rv-hero');
    hero.setAttribute('aria-label', 'VELOCITY');
    // Drei Druckplatten (Cyan, Magenta, Schwarz/Weiß) — gegeneinander verschoben = Passer-Fehler.
    // x = Glitch-Streifen: schmaler Ausschnitt der Weiß-Platte, springt auf der Eins jedes Takts zur Seite.
    for (const plate of ['c', 'm', 'k', 'x']) {
      const s = el('span', `rv-hero-plate rv-hero-plate--${plate}`, 'VELOCITY');
      s.setAttribute('aria-hidden', 'true');
      hero.append(s);
    }
    return hero;
  };

  const build = (c: FrontDoorContext): HTMLElement => {
    const w = el('div', 'rv');
    w.dataset.focus = focus;

    // Untergrund: Halbton-Druck + riesige angeschnittene BPM-Zahl.
    const bg = el('div', 'rv-bg');
    printCv = el('canvas', 'rv-print');
    bg.append(printCv, el('div', 'rv-bgtype', String(Math.round(c.beat().bpm))));

    // Xerox-Foto: das laufende Spiel hinter dem Menü, durch backdrop-filter zu Schwarz-Weiß-Kopie gemacht.
    const photo = el('div', 'rv-photo');
    const dots = el('canvas', 'rv-photo-dots');
    paintDots(dots, 3, '#07040f');
    photo.append(el('div', 'rv-photo-dotlayer'), el('div', 'rv-photo-cover'), el('span', 'rv-photo-cap', 'FIG. 01 — LIVE'));
    const dotLayer = photo.querySelector<HTMLElement>('.rv-photo-dotlayer');
    if (dotLayer) dotLayer.style.backgroundImage = `url(${dots.toDataURL()})`;

    tickerA = buildTicker('rv-ticker--a', TICKER_A);
    tickerB = buildTicker('rv-ticker--b', ['TONIGHT']);

    const safe = el('div', 'rv-safe');

    // Kopf: Präsentiert-Zeile, Riesen-Schrift, Klebeband-Unterzeile.
    const head = el('header', 'rv-head');
    const kicker = el('p', 'rv-kicker');
    kicker.append(el('span', 'rv-kicker-a', 'VELOCITY CREW PRESENTS'), el('span', 'rv-kicker-b', 'EIN NEON-PARCOURS IN 4 AKTEN'));
    const tag = el('p', 'rv-tag', 'BHOP · AIR-STRAFE · SURF');
    wristSlot = el('div', 'rv-wrist-slot');
    head.append(kicker, buildHero(), tag, wristSlot);

    // Links: Line-up + Start.
    const left = el('section', 'rv-left');
    const lh = el('div', 'rv-sechead');
    lh.append(el('h2', 'rv-h2', 'LINE-UP'), el('span', 'rv-secmeta', 'AKT / NAME / BESTZEIT'));
    lineup = el('div', 'rv-lineup');
    lineup.setAttribute('role', 'list');
    const startRow = el('div', 'rv-startrow');
    startBtn = button('rv-start', () => ctx?.playSelected());
    c.markLockButton(startBtn);
    const sl = el('span', 'rv-start-main');
    sl.append(el('span', 'rv-start-play'), el('span', 'rv-start-word', 'START'));
    startName = el('span', 'rv-start-name');
    startGoal = el('span', 'rv-start-goal');
    const sinfo = el('span', 'rv-start-info');
    sinfo.append(startName, startGoal);
    startBtn.append(sl, sinfo, el('span', 'rv-key', 'ENTER'));
    startRow.append(startBtn);
    lockErr = el('p', 'rv-lockerr');
    lockErr.setAttribute('role', 'alert');
    left.append(lh, lineup, startRow, lockErr);

    // Rechts: Tracklist + Armband.
    const right = el('section', 'rv-right');
    const th = el('div', 'rv-sechead');
    th.append(el('h2', 'rv-h2', 'TRACKLIST'), el('span', 'rv-secmeta', 'SIDE A / B'));
    const tl = el('div', 'rv-tracks');
    trackBtns = [];
    trackMeta = [];
    TRACKS.forEach((t, i) => {
      const b = button('rv-track', () => {
        trackIdx = i;
        const cc = ctx;
        if (cc) t.run(cc);
      });
      b.dataset.side = t.code.slice(0, 1);
      const meta = el('span', 'rv-track-meta');
      b.append(el('span', 'rv-track-code', t.code), el('span', 'rv-track-rule'), el('span', 'rv-track-label', t.label), meta);
      b.addEventListener('focus', () => {
        trackIdx = i;
        setFocus('tracks');
      });
      trackBtns.push(b);
      trackMeta.push(meta);
      tl.append(b);
    });
    newbieSlot = el('div', 'rv-newbie-slot');
    right.append(newbieSlot, th, tl);

    // Kleingedrucktes.
    const fine = el('footer', 'rv-fine');
    const fineText = el('span', 'rv-fine-text', 'EINLASS JEDERZEIT · DRESSCODE: HANDSCHUH · ');
    versionEl = el('span', 'rv-fine-ver');
    fineText.append(versionEl);
    const keys = el('span', 'rv-fine-keys', 'PFEILE WÄHLEN · ENTER STARTET · 1–4 AKT');
    const admin = button('rv-fine-btn rv-fine-admin', () => ctx?.openAdmin());
    admin.append('ADMIN ', el('span', 'rv-key rv-key--s', 'F8'));
    const lab = button('rv-fine-btn rv-fine-lab', () => ctx?.openLab());
    lab.textContent = 'MENÜ-LABOR';
    fine.append(fineText, keys, lab, admin);

    safe.append(head, left, right, fine);

    grain = el('div', 'rv-grain');
    const gcv = el('canvas', 'rv-grain-cv');
    paintGrain(gcv, 128);
    grain.style.backgroundImage = `url(${gcv.toDataURL()})`;

    const side = (cls: string, a: string, b: string, small: string): HTMLElement => {
      const s = el('div', `rv-side ${cls}`);
      s.setAttribute('aria-hidden', 'true');
      // Drei Sätze: bei 32:9 füllen sie den breiten Rand, bei 21:9 schneidet overflow den Rest ab.
      for (let i = 0; i < 3; i++) {
        s.append(el('span', 'rv-side-small', small), el('span', 'rv-side-type', a), el('span', 'rv-side-type rv-side-type--hot', b), el('span', 'rv-side-bar'));
      }
      // Rechts gespiegelt: Warnband innen an der Bühne.
      if (cls === 'rv-side--r') s.append(...Array.from(s.children).reverse());
      return s;
    };
    const sideL = side('rv-side--l', 'NO GUNS', 'JUST SPEED', 'ALL NIGHT LONG · 128 TICK');
    const sideR = side('rv-side--r', 'BHOP', 'STRAFE · SURF', 'VELOCITY CREW · LIVE');
    const flash = el('div', 'rv-flash');
    const hazard = el('div', 'rv-hazard');
    w.append(photo, bg, sideL, sideR, tickerB, tickerA, hazard, safe, grain, flash);
    return w;
  };

  // ------------------------------------------------------------------ Zeichnen (nur auf Ereignisse, nie pro Frame)

  const renderLineup = (c: FrontDoorContext): void => {
    if (!lineup) return;
    const key = c.levels.map((l) => `${l.id}:${l.bestText}:${l.medal ?? ''}:${l.recommended ?? ''}`).join('|') + (c.loading ? '#l' : '');
    if (key === levelKey && actBtns.length === c.levels.length) return;
    levelKey = key;
    lineup.replaceChildren();
    actBtns = [];
    if (c.loading || c.levels.length === 0) {
      lineup.append(el('div', 'rv-tba', c.loading ? 'LINE-UP T.B.A. — LÄDT …' : 'KEINE AKTE'));
      return;
    }
    for (const lv of c.levels) lineup.append(actRow(c, lv));
  };

  const actRow = (c: FrontDoorContext, lv: FrontDoorLevel): HTMLElement => {
    const b = button('rv-act', () => {
      sel = lv.index;
      ctx?.play(lv.id);
    });
    b.setAttribute('role', 'listitem');
    c.markLockButton(b);
    // Fokus (Tab) wählt aus, Hover nicht — der Weg zum Start-Knopf führt über die Liste (wie klassisch).
    b.addEventListener('focus', () => {
      setSel(lv.index);
      setFocus('lineup');
    });
    const body = el('span', 'rv-act-body');
    body.append(el('span', 'rv-act-name', lv.name));
    if (lv.subtitle || lv.recommended) {
      const line = el('span', 'rv-act-line');
      if (lv.subtitle) line.append(el('span', 'rv-act-sub', lv.subtitle));
      if (lv.recommended) line.append(el('span', 'rv-act-rec', lv.recommended));
      body.append(line);
    }
    const time = el('span', 'rv-act-time');
    time.append(el('small', 'rv-act-tl', 'BEST'), el('span', lv.bestTime === null ? 'rv-act-tv is-none' : 'rv-act-tv', lv.bestText));
    const stamp = el('span', 'rv-stamp');
    if (lv.medal) {
      stamp.classList.add(`rv-stamp--${lv.medal}`);
      stamp.textContent = MEDAL_LABEL[lv.medal];
    } else {
      // Noch keine Medaille: das nächste Ziel als blasser, gestrichelter Stempel.
      stamp.classList.add('is-empty');
      stamp.textContent = lv.nextMedal ? MEDAL_LABEL[lv.nextMedal.id] : '—';
    }
    b.append(el('span', 'rv-act-chev'), el('span', 'rv-act-num', lv.num), body, el('span', 'rv-act-lead'), time, stamp);
    actBtns.push(b);
    return b;
  };

  const renderSelection = (): void => {
    const c = ctx;
    if (!c) return;
    for (let i = 0; i < actBtns.length; i++) actBtns[i].classList.toggle('is-sel', i === sel);
    for (let i = 0; i < trackBtns.length; i++) trackBtns[i].classList.toggle('is-sel', focus === 'tracks' && i === trackIdx);
    const lv = c.levels[sel];
    if (startName) startName.textContent = lv ? `${lv.num} ${lv.name}` : 'LÄDT …';
    if (startGoal) {
      startGoal.textContent = lv
        ? lv.nextMedal
          ? `ZIEL ${MEDAL_LABEL[lv.nextMedal.id]} < ${fmtTime(lv.nextMedal.limit)}`
          : lv.medal
            ? 'ALLES GEHOLT'
            : lv.subtitle ?? ''
        : '';
    }
    if (startBtn) startBtn.dataset.off = lv ? '' : '1';
    if (wrap) wrap.dataset.focus = focus;
    // Bestenliste zeigt das gewählte Level an.
    if (trackMeta[1]) trackMeta[1].textContent = TRACKS[1].meta({ ...c, selected: sel });
  };

  const renderTracks = (c: FrontDoorContext): void => {
    for (let i = 0; i < TRACKS.length; i++) {
      const m = trackMeta[i];
      if (m) m.textContent = TRACKS[i].meta(c);
    }
    const words = c.levels.length > 0 ? c.levels.map((l) => `${l.num} ${l.name}`) : ['LINE-UP T.B.A.'];
    const tkey = `${words.join('|')}#${c.training.countText}`;
    if (tickerB && tkey !== tickerKey) {
      tickerKey = tkey;
      const unit = tickerB.querySelector('.rv-ticker-unit');
      if (unit) {
        unit.replaceChildren();
        unit.append(el('span', 'rv-ticker-word rv-ticker-word--hl', 'TONIGHT'));
        for (const w of words) unit.append(el('span', 'rv-ticker-star'), el('span', 'rv-ticker-word', w));
        unit.append(el('span', 'rv-ticker-star'), el('span', 'rv-ticker-word', `TRAINING ${c.training.countText || '--'}`));
        unit.append(el('span', 'rv-ticker-star'));
      }
      // Neuer Text = neue Breite: Klone und Animation neu (nur bei Datenänderung, nie pro Frame).
      if (armed) armTickers();
    }
  };

  const renderNewbie = (c: FrontDoorContext): void => {
    if (!newbieSlot) return;
    newbieSlot.replaceChildren();
    const rec = c.training.recommended;
    if (!c.training.newbie || !rec || !c.training.playable) return;
    const b = button('rv-newbie', () => ctx?.play(rec.id));
    c.markLockButton(b);
    const txt = el('span', 'rv-newbie-txt');
    txt.append(el('span', 'rv-newbie-top', 'NEU HIER? ERST AUFWÄRMEN'), el('span', 'rv-newbie-main', `${rec.short} ${rec.name}`));
    b.append(el('span', 'rv-newbie-tag', 'WARM-UP'), txt, el('span', 'rv-start-play rv-newbie-play'));
    newbieSlot.append(b);
  };

  const renderAccount = (c: FrontDoorContext): void => {
    if (!wristSlot) return;
    wristSlot.replaceChildren();
    const a = c.account;
    const band = el('div', 'rv-wrist');
    const stub = el('span', 'rv-wrist-stub');
    const body = el('div', 'rv-wrist-body');
    const code = el('span', 'rv-wrist-code');
    if (!a.online) {
      band.classList.add('is-off');
      stub.textContent = 'OFF';
      body.append(el('span', 'rv-wrist-top', 'GÄSTELISTE'), el('span', 'rv-wrist-name', 'OFFLINE'), el('span', 'rv-wrist-sub', 'Lokale Bestzeiten zählen trotzdem.'));
    } else if (a.signedIn && a.name !== null) {
      band.classList.toggle('is-vip', a.dev);
      stub.textContent = a.dev ? 'VIP' : 'ADMIT';
      const nm = el('span', 'rv-wrist-name');
      const label = el('span', 'rv-wrist-nm', a.name);
      label.dataset.text = a.name;
      nm.append(avatar(a.avatarUrl, a.name), label);
      if (a.dev) nm.append(el('span', 'rv-dev', 'DEV'));
      body.append(el('span', 'rv-wrist-top', a.dev ? 'GÄSTELISTE · CREW' : 'GÄSTELISTE · +0'), nm);
      if (a.loginRequired) {
        const out = button('rv-wrist-btn', () => ctx?.signOut());
        out.textContent = 'ABMELDEN';
        body.append(out);
      }
    } else if (a.loginRequired) {
      band.classList.add('is-guest');
      stub.textContent = '?';
      const login = button('rv-wrist-btn rv-wrist-btn--discord', () => ctx?.signIn());
      login.textContent = 'MIT DISCORD ANMELDEN';
      login.title = 'Anmeldung über Discord — du kommst danach hierher zurück';
      body.append(el('span', 'rv-wrist-top', 'NICHT AUF DER LISTE'), login);
    } else {
      band.classList.add('is-guest');
      stub.textContent = 'ADMIT';
      body.append(el('span', 'rv-wrist-top', `GÄSTELISTE · ${a.backend.toUpperCase()}`), el('span', 'rv-wrist-name', a.name ?? 'GAST'));
    }
    band.append(stub, body, code);
    wristSlot.append(band);
  };

  const renderLock = (c: FrontDoorContext): void => {
    if (!lockErr) return;
    lockErr.textContent = c.lock.error ?? '';
    lockErr.hidden = c.lock.error === null;
  };

  const renderAll = (c: FrontDoorContext): void => {
    renderLineup(c);
    renderTracks(c);
    renderNewbie(c);
    renderAccount(c);
    renderLock(c);
    if (versionEl) versionEl.textContent = c.version;
    renderSelection();
  };

  // ------------------------------------------------------------------ Eingabe

  const setSel = (i: number): void => {
    const c = ctx;
    if (!c || c.levels.length === 0) return;
    const n = c.levels.length;
    const j = ((i % n) + n) % n;
    if (j === sel) return;
    sel = j;
    c.select(j);
    renderSelection();
    stutter();
  };

  const setFocus = (f: Focus): void => {
    if (focus === f) return;
    focus = f;
    renderSelection();
  };

  /** Auswahl-Ruckler: zwei Animationsnamen im Wechsel, damit die Animation ohne Reflow neu startet. */
  let stutterFlip = false;
  const stutter = (): void => {
    if (!wrap || reduced()) return;
    stutterFlip = !stutterFlip;
    wrap.dataset.stutter = stutterFlip ? 'a' : 'b';
  };

  const moveTrack = (d: number): void => {
    const n = TRACKS.length;
    trackIdx = (((trackIdx + d) % n) + n) % n;
    renderSelection();
    stutter();
  };

  const askMusic = (): void => {
    if (musicAsked) return;
    musicAsked = true;
    ctx?.startMusic();
  };

  const endBoot = (): void => {
    if (bootTimer) clearTimeout(bootTimer);
    bootTimer = 0;
    if (wrap) delete wrap.dataset.boot;
  };

  const onPointer = (): void => {
    askMusic();
    endBoot();
  };

  const onKey = (e: KeyboardEvent): void => {
    const c = ctx;
    if (!c) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Buchstaben aus dem Spiel (W gehalten beim Zurückkommen) nicht als Dauerfeuer durch die Liste jagen.
    const letter = e.code.startsWith('Key');
    if (letter && e.repeat) return;
    let handled = true;
    switch (e.code) {
      case 'ArrowUp':
      case 'KeyW':
        if (focus === 'lineup') setSel(sel - 1);
        else moveTrack(-1);
        break;
      case 'ArrowDown':
      case 'KeyS':
        if (focus === 'lineup') setSel(sel + 1);
        else moveTrack(1);
        break;
      case 'ArrowLeft':
      case 'KeyA':
        setFocus('lineup');
        break;
      case 'ArrowRight':
      case 'KeyD':
        setFocus('tracks');
        break;
      default:
        if (e.code.startsWith('Digit')) {
          const d = Number(e.code.slice(5));
          if (d >= 1 && d <= c.levels.length) {
            setFocus('lineup');
            setSel(d - 1);
          } else handled = false;
        } else handled = false;
    }
    if (handled) {
      e.preventDefault();
      askMusic();
      endBoot();
    }
  };

  const onResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      paintTextures();
      armTickers();
    }, 120);
  };

  const onFullscreen = (): void => {
    const m = trackMeta[6];
    if (m && ctx) m.textContent = TRACKS[6].meta(ctx);
  };

  // ------------------------------------------------------------------ Takt (rAF: nur Zahlen vergleichen, vorgebaute Strings setzen)

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    const c = ctx;
    const w = wrap;
    if (!c || !w) return;
    const b = c.beat();
    // Kick in 5 Stufen: harte Sprünge statt weichem Pumpen (PS2-Look) und kaum Style-Neuberechnung.
    const k = Math.min(4, Math.round(b.kick * 4));
    if (k !== lastK) {
      lastK = k;
      w.style.setProperty('--k', K_STR[k]);
    }
    const bi = Math.floor(b.beat);
    if (bi !== lastBeat) {
      lastBeat = bi;
      w.dataset.beat = N_STR[bi & 3];
      if (grain) grain.style.transform = GRAIN_POS[bi & 7];
    }
    if (b.bar !== lastBar) {
      const resync = lastBar >= 0 && (b.bar & 7) === 0;
      lastBar = b.bar;
      w.dataset.bar = N_STR[b.bar & 7];
      if (resync) syncTickers();
    }
    const e = Math.min(2, Math.floor(b.energy * 3));
    if (e !== lastEnergy) {
      lastEnergy = e;
      w.dataset.energy = N_STR[e];
    }
    if (b.live !== lastLive) {
      // Ersatz-Uhr → echte Musik: der Beat-Zähler springt, Ticker neu anlegen.
      lastLive = b.live;
      syncTickers();
    }
  };

  // ------------------------------------------------------------------ Lebenszyklus

  return {
    mount(r, c) {
      root = r;
      ctx = c;
      sel = c.selected;
      levelKey = '';
      tickerKey = '';
      armed = false;
      wrap = build(c);
      r.append(wrap);
      renderAll(c);
      paintTextures();
      armTickers();
      armed = true;
      if (c.reducedMotion) wrap.dataset.reduced = '1';
      else if (c.entry === 'boot') {
        wrap.dataset.boot = 'full';
        bootTimer = window.setTimeout(endBoot, 1800);
      } else {
        wrap.dataset.boot = 'return';
        bootTimer = window.setTimeout(endBoot, 360);
      }
      lastLive = c.beat().live;
      window.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      document.addEventListener('fullscreenchange', onFullscreen);
      r.addEventListener('pointerdown', onPointer);
      if (!c.reducedMotion) raf = requestAnimationFrame(frame);
    },
    update(c) {
      ctx = c;
      sel = c.selected;
      renderAll(c);
    },
    unmount() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (bootTimer) clearTimeout(bootTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      bootTimer = resizeTimer = 0;
      for (const a of anims) a.cancel();
      anims = [];
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFullscreen);
      root?.removeEventListener('pointerdown', onPointer);
      root?.replaceChildren();
      root = wrap = lineup = startBtn = startName = startGoal = lockErr = newbieSlot = wristSlot = null;
      tickerA = tickerB = grain = printCv = versionEl = null;
      actBtns = [];
      trackBtns = [];
      trackMeta = [];
      ctx = null;
    },
    onAction(a: FrontDoorAction) {
      const c = ctx;
      if (!c) return;
      askMusic();
      endBoot();
      if (a === 'confirm') {
        // Synchron: play() braucht die (noch gültige) Geste des Tastendrucks.
        if (focus === 'tracks') TRACKS[trackIdx].run(c);
        else c.playSelected();
      } else if (a === 'back') {
        if (focus === 'tracks') setFocus('lineup');
      }
    },
  };
}

const factory: FrontDoorFactory = () => createRaveDoor();
export default factory;
