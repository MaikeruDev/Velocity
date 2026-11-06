// Stil 'hub' (Plan 010) — diegetischer 3D-Hub: ein Neon-Dach über der Stadt, die Menüpunkte sind Orte.
// Eigenes Low-Res-WebGL (Nearest, ganzzahlig skaliert), DOM nur für scharfen Text. Beim Import kein DOM.
import './hub.css';
import {
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  Ray,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  BufferGeometry,
  BufferAttribute,
} from 'three';
import type { ShaderMaterial } from 'three';
import { computeLowRes } from '../../../render/lowres';
import type { LowResLayout } from '../../../render/lowres';
import type { FrontDoor, FrontDoorAction, FrontDoorContext, FrontDoorFactory } from '../types';
import { CameraRig } from './camera';
import { portalStation, stationOfKind } from './layout';
import type { Station } from './layout';
import { createHubUniforms, createPostMaterial, MAX_GROUPS } from './materials';
import type { HubUniforms } from './materials';
import { avatar, el, fmtTime, medalChip, medalLadder, Overlay, playerName, row, segBar, stars } from './overlay';
import type { CardAction } from './overlay';
import { HubWorld, logoTexture } from './world';

/** Höchstens so viele Low-Res-Zeilen (wie die Spiel-Voreinstellung 270). */
const PIXEL_HEIGHT = 270;

class HubDoor implements FrontDoor {
  private root: HTMLElement | null = null;
  private ctx: FrontDoorContext | null = null;
  private renderer: WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private target: WebGLRenderTarget | null = null;
  private post: ShaderMaterial | null = null;
  private postScene: Scene | null = null;
  private postGeo: BufferGeometry | null = null;
  private readonly postCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly cam = new PerspectiveCamera(CameraRig.VFOV, 16 / 9, 0.1, 420);
  private readonly rig = new CameraRig();
  private u: HubUniforms | null = null;
  private world: HubWorld | null = null;
  private overlay: Overlay | null = null;
  private layout: LowResLayout | null = null;
  private readonly res = new Vector2(1, 1);
  private raf = 0;
  private last = 0;
  private t0 = 0;
  private focus = 0;
  private hover = -1;
  private level = 0;
  private signature = '';
  private motion = true;
  private fade = 0;
  private fadeSpeed = 0;
  private wheelAt = 0;
  private logoTex: ReturnType<typeof logoTexture> | null = null;
  private logoImg: HTMLImageElement | null = null;
  private disposed = false;
  // Scratch (keine Allokation im Frame / bei Mausbewegung).
  private readonly invVP = new Matrix4();
  private readonly v = new Vector3();
  private readonly ray = new Ray();
  private readonly hit = new Vector3();
  private readonly glow = new Float32Array(MAX_GROUPS);
  private chevronAngle = 0;
  private cardSeq = 0;

  mount(root: HTMLElement, ctx: FrontDoorContext): void {
    this.root = root;
    this.ctx = ctx;
    this.motion = !ctx.reducedMotion;
    this.level = ctx.selected;
    root.classList.add('hub-root');

    const canvas = el('canvas', 'hub-canvas');
    canvas.setAttribute('aria-hidden', 'true');
    root.append(canvas);
    this.canvas = canvas;
    const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 1);
    renderer.autoClear = true;
    this.renderer = renderer;
    this.target = new WebGLRenderTarget(1, 1, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      format: RGBAFormat,
      type: UnsignedByteType,
      samples: 0,
    });
    this.u = createHubUniforms();
    this.u.uMotion.value = this.motion ? 1 : 0;
    this.post = createPostMaterial(this.target.texture, this.res);
    this.postGeo = new BufferGeometry();
    this.postGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const pm = new Mesh(this.postGeo, this.post);
    pm.frustumCulled = false;
    this.postScene = new Scene();
    this.postScene.add(pm);

    this.overlay = new Overlay(root, { focus: (i) => this.focusStation(i, true), hover: (i) => this.setHover(i) }, ctx.assets.logoUrl);
    this.buildWorld(ctx);
    this.focus = portalStation(this.stations, this.level);
    this.overlay.setFocus(this.focus);
    this.chevronAngle = this.stations[this.focus]?.angle ?? 0;
    this.resize();
    const w = this.world;
    if (w) this.rig.jump(w.stations[this.focus]);
    const boot = ctx.entry === 'boot' && this.motion;
    if (boot) {
      this.rig.startBoot();
      this.fade = 1;
      this.fadeSpeed = 1.6;
    } else if (this.motion) {
      this.fade = 1;
      this.fadeSpeed = 5;
    }
    this.overlay.setReveal(!boot);
    this.renderCard(true);
    this.loadAssets(ctx);

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    canvas.addEventListener('pointermove', this.onPointer);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('click', this.onClick);
    root.addEventListener('wheel', this.onWheel, { passive: false });
    root.addEventListener('pointerdown', this.onAnyPointer);
    this.t0 = performance.now();
    this.last = this.t0;
    this.raf = requestAnimationFrame(this.frame);
  }

  update(ctx: FrontDoorContext): void {
    const prev = this.ctx;
    this.ctx = ctx;
    if (!prev || !this.overlay) return;
    if (this.signatureOf(ctx) !== this.signature) {
      // Level geladen / Medaille / Konto geändert: Szene neu (selten; Kamera bleibt, wo sie ist).
      const kind = this.stations[this.focus]?.kind ?? 'portal';
      const lvl = this.stations[this.focus]?.level ?? -1;
      this.buildWorld(ctx);
      if (prev.levels.length === 0 && ctx.levels.length > 0) this.level = ctx.selected;
      const i = kind === 'portal' ? portalStation(this.stations, lvl >= 0 ? lvl : this.level) : stationOfKind(this.stations, kind);
      this.focus = i;
      this.overlay.setFocus(i);
      if (this.logoTex && this.logoImg && this.world) this.world.setLogo(this.logoTex, this.logoImg.naturalWidth / Math.max(1, this.logoImg.naturalHeight));
      const st = this.stations[i];
      if (st) {
        if (this.rig.booting || this.rig.flying) this.rig.refresh(st);
        else this.rig.jump(st);
      }
    } else this.overlay.refreshTags(this.stations, ctx);
    this.renderCard(false);
  }

  unmount(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    const c = this.canvas;
    if (c) {
      c.removeEventListener('pointermove', this.onPointer);
      c.removeEventListener('pointerleave', this.onLeave);
      c.removeEventListener('click', this.onClick);
    }
    this.root?.removeEventListener('wheel', this.onWheel);
    this.root?.removeEventListener('pointerdown', this.onAnyPointer);
    if (this.logoImg) this.logoImg.onload = null;
    this.world?.dispose();
    this.world = null;
    this.logoTex?.dispose();
    this.post?.dispose();
    this.postGeo?.dispose();
    this.target?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.renderer = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.root?.replaceChildren();
    this.root?.classList.remove('hub-root');
    this.root = null;
    this.ctx = null;
  }

  onAction(a: FrontDoorAction): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.rig.booting) {
      this.skipBoot();
      return;
    }
    if (a === 'confirm') {
      // Synchron (gilt noch als Geste): Enter am Portal startet sofort.
      this.overlay?.runActive();
    } else if (a === 'back') {
      const i = portalStation(this.stations, this.level);
      if (i !== this.focus) this.focusStation(i, true);
      else this.overlay?.resetActive();
      this.renderCard(false);
    }
  }

  // ------------------------------------------------------------------ Aufbau

  private get stations(): readonly Station[] {
    return this.world ? this.world.stations : [];
  }

  private signatureOf(ctx: FrontDoorContext): string {
    const a = ctx.account;
    return `${ctx.levels.map((l) => `${l.id}:${l.medal ?? '-'}`).join(',')}|${a.dev ? 1 : 0}${a.signedIn ? 1 : 0}${a.loginRequired ? 1 : 0}`;
  }

  private buildWorld(ctx: FrontDoorContext): void {
    const u = this.u;
    const ov = this.overlay;
    if (!u || !ov) return;
    this.world?.dispose();
    this.world = new HubWorld(u, ctx);
    this.signature = this.signatureOf(ctx);
    this.glow.fill(0);
    ov.setStations(this.world.stations, ctx, () => this.focusStation(stationOfKind(this.stations, 'profile'), true));
    ov.setFocus(this.focus);
    ov.setSelectedLevel(this.world.stations, this.level);
  }

  private loadAssets(ctx: FrontDoorContext): void {
    // Silkscreen für die Schilder in der Welt (Canvas-Text braucht die geladene Schrift).
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.load('700 32px Silkscreen').then(
        () => {
          if (!this.disposed) this.world?.redrawText();
        },
        () => undefined,
      );
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (this.disposed) return;
      this.logoTex = logoTexture(img);
      this.logoImg = img;
      this.world?.setLogo(this.logoTex, img.naturalWidth / Math.max(1, img.naturalHeight));
    };
    img.src = ctx.assets.logoUrl;
    this.logoImg = img;
  }

  private readonly onResize = (): void => this.resize();

  private resize(): void {
    const root = this.root;
    const r = this.renderer;
    const c = this.canvas;
    const u = this.u;
    if (!root || !r || !c || !u || !this.target) return;
    const w = Math.max(1, root.clientWidth || window.innerWidth);
    const h = Math.max(1, root.clientHeight || window.innerHeight);
    const lay = computeLowRes(w, h, PIXEL_HEIGHT, window.devicePixelRatio || 1);
    this.layout = lay;
    r.setSize(lay.lowW, lay.lowH, false);
    this.target.setSize(lay.lowW, lay.lowH);
    this.res.set(lay.lowW, lay.lowH);
    u.uRes.value.set(lay.lowW, lay.lowH);
    c.style.width = `${lay.cssW}px`;
    c.style.height = `${lay.cssH}px`;
    c.style.left = `${lay.cssLeft}px`;
    c.style.top = `${lay.cssTop}px`;
    this.cam.aspect = lay.lowW / lay.lowH;
    this.cam.updateProjectionMatrix();
    this.rig.safeAspect = Math.min(16 / 9, w / h);
    const st = this.stations[this.focus];
    if (st) this.rig.refresh(st);
    this.overlay?.measure();
  }

  // ------------------------------------------------------------------ Navigation

  private focusStation(i: number, fly: boolean): void {
    const ctx = this.ctx;
    const st = this.stations[i];
    if (!ctx || !st) return;
    if (this.rig.booting) this.skipBoot();
    const steps = i - this.focus;
    if (i === this.focus) return;
    this.focus = i;
    if (st.kind === 'portal') {
      this.level = st.level;
      ctx.select(st.level);
      this.overlay?.setSelectedLevel(this.stations, st.level);
    }
    if (fly && this.motion) this.rig.flyTo(st, steps);
    else this.rig.jump(st);
    this.overlay?.resetActive();
    this.overlay?.setFocus(i);
    this.renderCard(true);
  }

  private step(d: number): void {
    const n = this.stations.length;
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, this.focus + d));
    this.focusStation(i, true);
  }

  private setHover(i: number): void {
    if (i === this.hover) return;
    this.hover = i;
    this.overlay?.setHover(i);
    if (this.canvas) this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
  }

  /** Station auslösen (Klick auf die fokussierte Station): erster Knopf der Karte. Synchron. */
  private activate(i: number): void {
    if (i !== this.focus) {
      this.focusStation(i, true);
      return;
    }
    this.overlay?.setActive(0);
    this.overlay?.runActive();
  }

  private skipBoot(): void {
    this.rig.skipBoot();
    this.fade = Math.min(this.fade, 0.3);
    this.fadeSpeed = 4;
    this.overlay?.setReveal(true);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const k = e.code;
    const nav = k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'KeyA' || k === 'KeyD' || k === 'KeyW' || k === 'KeyS';
    const digit = /^Digit[1-9]$/.test(k) ? Number(k.slice(5)) : 0;
    if (!nav && digit === 0) return;
    e.preventDefault();
    if (this.rig.booting) {
      this.skipBoot();
      return;
    }
    if (digit > 0) {
      if (digit <= (this.ctx?.levels.length ?? 0)) this.focusStation(portalStation(this.stations, digit - 1), true);
      return;
    }
    if (k === 'ArrowLeft' || k === 'KeyA') this.step(-1);
    else if (k === 'ArrowRight' || k === 'KeyD') this.step(1);
    else if (k === 'ArrowUp' || k === 'KeyW') this.overlay?.moveActive(-1);
    else this.overlay?.moveActive(1);
  };

  private readonly onAnyPointer = (): void => {
    if (this.rig.booting) this.skipBoot();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (e.target instanceof Element && e.target.closest('.hub-card')) return;
    e.preventDefault();
    const now = performance.now();
    if (now - this.wheelAt < 160 || Math.abs(e.deltaY) < 4) return;
    this.wheelAt = now;
    this.step(e.deltaY > 0 ? 1 : -1);
  };

  private readonly onLeave = (): void => {
    this.setHover(-1);
    this.rig.targetMx = 0;
    this.rig.targetMy = 0;
  };

  private pickAt(clientX: number, clientY: number): number {
    const c = this.canvas;
    const w = this.world;
    if (!c || !w) return -1;
    const r = c.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((clientY - r.top) / r.height) * 2 - 1);
    this.ray.origin.setFromMatrixPosition(this.cam.matrixWorld);
    this.ray.direction.set(nx, ny, 0.5).unproject(this.cam).sub(this.ray.origin).normalize();
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < w.pick.length; i++) {
      if (this.ray.intersectBox(w.pick[i], this.hit)) {
        const d = this.hit.distanceToSquared(this.ray.origin);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }

  private readonly onPointer = (e: PointerEvent): void => {
    const c = this.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    this.rig.targetMx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    this.rig.targetMy = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    this.setHover(this.pickAt(e.clientX, e.clientY));
  };

  private readonly onClick = (e: MouseEvent): void => {
    const i = this.pickAt(e.clientX, e.clientY);
    if (i < 0) return;
    // Synchron im Klick (Pointer Lock): fokussierte Station → Hauptaktion, sonst hinfliegen.
    this.activate(i);
  };

  // ------------------------------------------------------------------ Karte

  private renderCard(fresh: boolean): void {
    const ctx = this.ctx;
    const ov = this.overlay;
    const st = this.stations[this.focus];
    if (!ctx || !ov) return;
    if (!st) {
      ov.showCard({ kind: 'portal', level: -1, angle: 0, radius: 10, view: 5, lookY: 1, tagY: 1 }, ctx, [], [el('p', 'hub-text', ctx.loading ? 'Level werden geladen …' : 'Keine Level gefunden.')], 'empty', ctx.markLockButton);
      return;
    }
    const body: HTMLElement[] = [];
    const acts: CardAction[] = [];
    const tr = ctx.training;
    const rec = tr.recommended;
    const lessonAct = (): CardAction | null =>
      rec && tr.playable ? { label: `${rec.short} ${rec.name}`, sub: 'Lektion starten', lock: true, run: () => ctx.play(rec.id), tone: 'primary' } : null;
    switch (st.kind) {
      case 'portal': {
        const lv = ctx.levels[st.level];
        if (!lv) break;
        body.push(el('h2', 'hub-title', lv.name));
        if (lv.subtitle) body.push(el('p', 'hub-subtitle', lv.subtitle));
        const best = el('span', 'hub-best', lv.bestText);
        if (lv.bestTime === null) best.classList.add('is-empty');
        const val = el('span', 'hub-best-wrap');
        val.append(medalChip(lv.medal), best);
        body.push(row('Bestzeit', val, 'hub-row--best'));
        const ladder = medalLadder(lv);
        if (ladder) body.push(ladder);
        if (lv.nextMedal) body.push(el('p', 'hub-next', `Nächstes Ziel: ${lv.nextMedal.id === 'velocity' ? 'VELOCITY' : lv.nextMedal.id === 'gold' ? 'Gold' : lv.nextMedal.id === 'silver' ? 'Silber' : 'Bronze'} unter ${fmtTime(lv.nextMedal.limit)}`));
        if (lv.recommended) body.push(el('p', 'hub-rec', lv.recommended));
        acts.push({ label: 'Starten', sub: `${lv.num} ${lv.name}`, lock: true, run: () => ctx.play(lv.id), tone: 'primary' });
        if (tr.newbie && st.level === 0) {
          const l = lessonAct();
          if (l) acts.push({ ...l, label: 'Neu? Training', sub: l.label, tone: 'newbie' });
        }
        acts.push({ label: 'Bestenliste', sub: 'Ghosts + Online', run: () => ctx.openLeaderboard(lv.id) });
        break;
      }
      case 'training': {
        body.push(el('h2', 'hub-title', 'Training'));
        if (!tr.available) body.push(el('p', 'hub-text', 'Lektionen werden geladen …'));
        else {
          const prog = el('div', 'hub-progress');
          prog.append(el('span', 'hub-progress-label', `${tr.passed}/${tr.total} bestanden`), segBar(tr.passed, tr.total, 'hub-seg--green'));
          body.push(prog);
          if (rec) {
            const box = el('div', 'hub-lesson');
            box.append(el('span', 'hub-lesson-short', rec.short), el('span', 'hub-lesson-name', rec.name), stars(rec.stars));
            if (rec.subtitle) box.append(el('span', 'hub-lesson-sub', rec.subtitle));
            body.push(el('p', 'hub-row-label hub-label', tr.newbie ? 'Fang hier an' : 'Empfohlen'), box);
          } else body.push(el('p', 'hub-text', 'Alle Lektionen bestanden. Hol dir die Sterne.'));
        }
        const l = lessonAct();
        if (l) acts.push(l);
        acts.push({ label: 'Alle Lektionen', sub: tr.countText || undefined, run: () => ctx.openTraining() });
        break;
      }
      case 'locker': {
        const c = ctx.cosmetics;
        body.push(el('h2', 'hub-title', 'Spind'));
        const stats = el('div', 'hub-stats');
        stats.append(row('Handschuh', c.gloveName), row('Gegenstand', c.itemName));
        body.push(stats);
        const prog = el('div', 'hub-progress');
        prog.append(el('span', 'hub-progress-label', `${c.unlocked}/${c.total} freigeschaltet`), segBar(c.unlocked, c.total, 'hub-seg--magenta'));
        body.push(prog);
        if (c.latest) body.push(el('p', 'hub-next', `Zuletzt: ${c.latest}`));
        acts.push({ label: 'Spind öffnen', sub: 'Skins + Gegenstände', run: () => ctx.openCosmetics(), tone: 'primary' });
        break;
      }
      case 'trophy': {
        body.push(el('h2', 'hub-title', 'Trophäen'));
        const list = el('div', 'hub-board');
        for (const lv of ctx.levels) {
          const r = el('div', `hub-board-row${lv.index === this.level ? ' is-sel' : ''}`);
          r.append(el('span', 'hub-board-num', lv.num), el('span', 'hub-board-name', lv.name), el('span', `hub-board-time${lv.bestTime === null ? ' is-empty' : ''}`, lv.bestText), medalChip(lv.medal));
          list.append(r);
        }
        body.push(list);
        for (const lv of ctx.levels) acts.push({ label: `Bestenliste ${lv.num}`, sub: lv.name, run: () => ctx.openLeaderboard(lv.id) });
        break;
      }
      case 'setup': {
        body.push(el('h2', 'hub-title', 'Werkbank'));
        body.push(el('p', 'hub-text', 'Maus, Grafik, Ton, Movement-Preset und Tastenbelegung.'));
        acts.push({ label: 'Einstellungen', sub: 'Grafik · Ton · Maus', run: () => ctx.openSettings(), tone: 'primary' });
        acts.push({ label: 'Steuerung', sub: 'Tasten · Gamepad', run: () => ctx.openControls() });
        acts.push({ label: 'Vollbild', sub: 'umschalten', run: () => ctx.fullscreen() });
        break;
      }
      case 'profile': {
        const a = ctx.account;
        body.push(el('h2', 'hub-title', 'Ausweis'));
        const id = el('div', `hub-id${a.dev ? ' is-dev' : ''}`);
        const nm = a.signedIn && a.name ? a.name : a.name ?? 'Gast';
        const who = el('div', 'hub-id-who');
        who.append(playerName(nm, a.dev), el('span', 'hub-id-state', a.signedIn ? (a.loginRequired ? 'Mit Discord angemeldet' : `Angemeldet · ${a.backend}`) : a.loginRequired ? 'Nicht angemeldet — Spielen geht auch so' : a.online ? `Online · ${a.backend}` : 'Offline · lokale Bestzeiten'));
        id.append(avatar(a.signedIn ? a.avatarUrl : null, nm), who);
        body.push(id);
        acts.push({ label: 'Profil', sub: 'Name · Abzeichen', run: () => ctx.openProfile(), tone: 'primary' });
        if (a.loginRequired && !a.signedIn) acts.push({ label: 'Mit Discord anmelden', sub: 'zum Einreichen', run: () => ctx.signIn(), tone: 'discord' });
        if (a.loginRequired && a.signedIn) acts.push({ label: 'Abmelden', run: () => ctx.signOut(), tone: 'quiet' });
        break;
      }
      case 'lab': {
        body.push(el('h2', 'hub-title', 'Labor'));
        body.push(el('p', 'hub-text', 'Menü-Stil wechseln. Hinter der Tür: Admin (auch F8).'));
        acts.push({ label: 'Menü-Labor', sub: 'Stil wechseln', run: () => ctx.openLab(), tone: 'primary' });
        if (ctx.adminMenu) acts.push({ label: 'Admin', sub: 'F8', run: () => ctx.openAdmin(), tone: 'quiet' });
        body.push(el('p', 'hub-version-line', ctx.version));
        break;
      }
    }
    if (fresh) this.cardSeq++;
    ov.showCard(st, ctx, acts, body, `${this.focus}|${this.cardSeq}`, ctx.markLockButton);
  }

  // ------------------------------------------------------------------ Frame

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const r = this.renderer;
    const w = this.world;
    const u = this.u;
    const ctx = this.ctx;
    const tg = this.target;
    if (!r || !w || !u || !ctx || !tg || !this.post || !this.postScene) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const t = (now - this.t0) / 1000;
    const beat = ctx.beat();
    u.uTime.value = t;
    u.uPulse.value = this.motion ? 0.84 + 0.3 * beat.kick : 0.95;
    u.uBeat.value = this.motion ? beat.phase : 1;

    const wasBoot = this.rig.booting;
    this.rig.update(this.cam, dt, t, this.motion);
    if (wasBoot && !this.rig.booting) this.overlay?.setReveal(true);
    else if (wasBoot && this.rig.bootProgress > 0.78) this.overlay?.setReveal(true);

    // Hervorhebung weich (Fokus 1, Hover 0.55).
    const g = u.uGlow.value;
    const k = this.motion ? Math.min(1, dt * 7) : 1;
    for (let i = 0; i < w.stations.length && i < MAX_GROUPS - 1; i++) {
      const target = i === this.focus ? 1 : i === this.hover ? 0.55 : 0;
      this.glow[i] += (target - this.glow[i]) * k;
      g[i] = this.glow[i];
      w.setGlow(i, this.glow[i]);
      w.setLight(i, this.glow[i], this.motion ? 0.85 + 0.3 * beat.kick : 1);
    }
    // Pfeile zum gewählten Portal drehen nach.
    const sel = w.stations[portalStation(w.stations, this.level)];
    if (sel) {
      this.chevronAngle += (sel.angle - this.chevronAngle) * (this.motion ? Math.min(1, dt * 5) : 1);
      w.setChevronAngle(this.chevronAngle);
    }
    w.tick(t, this.motion);
    w.setBillboardVisible(this.rig.booting);

    if (this.fade > 0) this.fade = Math.max(0, this.fade - dt * this.fadeSpeed);
    this.post.uniforms.uFade.value = this.fade;

    this.cam.updateMatrixWorld();
    this.invVP.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse).invert();
    w.skyMaterial.uniforms.uInvViewProj.value = this.invVP;

    r.setRenderTarget(tg);
    r.render(w.scene, this.cam);
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);

    this.placeTags();
  };

  private placeTags(): void {
    const w = this.world;
    const ov = this.overlay;
    const lay = this.layout;
    if (!w || !ov || !lay) return;
    const reveal = !this.rig.booting || this.rig.bootProgress > 0.78;
    for (let i = 0; i < w.tagAnchor.length; i++) {
      this.v.copy(w.tagAnchor[i]).project(this.cam);
      const inView = this.v.z < 1 && this.v.x > -1.05 && this.v.x < 1.05 && this.v.y > -1 && this.v.y < 1.1;
      const x = lay.cssLeft + (this.v.x * 0.5 + 0.5) * lay.cssW;
      const y = lay.cssTop + (-this.v.y * 0.5 + 0.5) * lay.cssH;
      ov.placeTag(i, x, y, reveal && inView && i !== this.focus);
    }
  }
}

const factory: FrontDoorFactory = () => new HubDoor();
export default factory;
