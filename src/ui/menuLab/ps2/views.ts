/**
 * Native PS2-Ansichten für Screens, die sonst Menu.ts baut (Plan 010 Runde 4): Training, Bestenliste, Kosmetik, Profil,
 * Moderation. Sie leben in der Front Door — also vor der laufenden 3D-Welt — und reden nur über den Vertrag
 * (FrontDoorContext) mit dem Spiel. Jede Ansicht ist ein SubView-Objekt; die Front Door (index.ts) stellt den Host:
 * 3D-Objekte, DOM-Anker, Fokus-Halo, Navigation zwischen Ansichten, Prompt-Leiste.
 * Menü-Code, kein Frame-Pfad: Closures und Neuaufbau sind hier unkritisch.
 */
import type { AdminAuditEntry, AdminPlayer, AdminRun, AdminService, FrontDoorBoard, FrontDoorBoardEntry, FrontDoorContext, FrontDoorCosmetic, FrontDoorLevel, MedalId, PlayerProfile } from '../types';
import { medalFor } from '../../medals';
import { accountName, avatar, button, el, fmtTime, keycap, medalChip } from './dom';
import type { FgKind, FgObj } from './scene';
import { rgb } from './models';
import type { Rgb } from './models';

export type SubViewId = 'training' | 'board' | 'cosmetics' | 'profile' | 'moderation';

export interface PromptSpec {
  readonly keys: readonly string[];
  readonly label: string;
  /** Klickbar: 'confirm' / 'back' wie Enter/Esc, null = nur Anzeige. */
  readonly action: 'confirm' | 'back' | null;
  readonly lock?: boolean;
}

export interface SubViewParams {
  readonly levelId?: string;
  readonly uid?: string;
}

/** Was eine Ansicht von der Front Door bekommt. */
export interface Host {
  ctx(): FrontDoorContext;
  /** Neues 3D-Objekt (die Ansicht gibt es in dispose mit release frei). */
  obj(kind: FgKind, variant?: number, discOf?: FrontDoorLevel): FgObj;
  release(o: FgObj): void;
  /** Objekt an ein DOM-Element hängen (sichtbar in dieser Ansicht). */
  anchor(o: FgObj, e: HTMLElement): void;
  /** Gewähltes Objekt (Halo + nach vorn) oder keins. */
  focus(o: FgObj | null, color?: Rgb): void;
  go(v: SubViewId | 'main' | 'discs' | 'card' | 'system', p?: SubViewParams): void;
  back(): void;
  /** Ansicht neu aufbauen (Daten geändert), Zustand bleibt in der Ansicht. */
  rebuild(): void;
  /** Disc-Farbe eines Levels (Theme oder Ersatz) als CSS. */
  discColor(lv: FrontDoorLevel): string;
}

export interface SubView {
  readonly id: SubViewId;
  readonly title: string;
  build(stage: HTMLElement): void;
  /** Auswahl → Klassen + 3D-Fokus. */
  select(): void;
  navigate(dx: number, dy: number): void;
  confirm(): void;
  prompts(): readonly PromptSpec[];
  /** Neuer ctx (Daten); Standard: rebuild. */
  update?(): void;
  dispose(): void;
}

const ORANGE = rgb('#ff8a3a');
const GOLD = rgb('#ffcc3a');
const VIOLET = rgb('#d03cff');
const CARD = rgb('#ff3fd0');

function wrap(i: number, n: number): number {
  return n <= 0 ? 0 : ((i % n) + n) % n;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : null;
  }
  return null;
}

function stars(n: number): HTMLElement {
  const s = el('span', `ps2-stars ps2-stars--${n}`);
  for (let i = 0; i < 3; i++) s.append(el('i', i < n ? 'is-on' : '', i < n ? '★' : '☆'));
  return s;
}

function date(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function viewHead(title: string, sub: string | Node | null, icon: HTMLElement | null): HTMLElement {
  return el('div', 'ps2-view-head', icon, el('h1', 'ps2-view-title', title), sub === null ? null : el('span', 'ps2-view-sub', sub));
}

// =====================================================================================================================
// Bestenlisten-Zwischenspeicher (auch Disc-Auswahl und Memory Card zeigen den Weltrekord)

export interface BoardSlot {
  state: 'loading' | 'ok' | 'error';
  board: FrontDoorBoard | null;
  error: string | null;
  code: string | null;
  at: number;
}

const boards = new Map<string, BoardSlot>();
/** Wer bei neuen Daten neu zeichnet (die gerade sichtbare Ansicht). */
let boardListener: (() => void) | null = null;

export function onBoards(fn: (() => void) | null): void {
  boardListener = fn;
}

/** Bestenliste holen (höchstens alle 20 s neu); fertig → boardListener. */
export function loadBoard(ctx: FrontDoorContext, levelId: string, force = false): BoardSlot {
  const cur = boards.get(levelId);
  if (cur && !force && (cur.state === 'loading' || performance.now() - cur.at < 20000)) return cur;
  const slot: BoardSlot = { state: 'loading', board: cur?.board ?? null, error: null, code: null, at: performance.now() };
  boards.set(levelId, slot);
  ctx.board(levelId).then(
    (b) => {
      slot.state = 'ok';
      slot.board = b;
      boardListener?.();
    },
    (err: unknown) => {
      slot.state = 'error';
      slot.error = errText(err);
      slot.code = errCode(err);
      boardListener?.();
    },
  );
  return slot;
}

export function boardOf(levelId: string): BoardSlot | null {
  return boards.get(levelId) ?? null;
}

/** "WR 0:18.66 · NEONHAWK" oder null. */
export function wrLine(levelId: string): string | null {
  const wr = boards.get(levelId)?.board?.top[0];
  return wr ? `WR ${fmtTime(wr.time)} · ${wr.name}` : null;
}

export function invalidateBoards(): void {
  boards.clear();
}

// =====================================================================================================================
// Training

export class TrainingView implements SubView {
  readonly id = 'training';
  readonly title = 'Training';
  private sel = 0;
  private cones: FgObj[] = [];
  private btns: HTMLButtonElement[] = [];
  private detail: HTMLElement | null = null;
  private icon: FgObj;

  constructor(private readonly host: Host) {
    const c = host.ctx();
    const rec = c.training.recommended;
    const i = rec ? c.training.lessons.findIndex((l) => l.id === rec.id) : -1;
    this.sel = Math.max(0, i);
    this.icon = host.obj('cone');
    this.icon.dimIdle = 0;
  }

  private ensureCones(n: number): void {
    while (this.cones.length < n) {
      const o = this.host.obj('cone', this.cones.length);
      o.dimIdle = 0.15;
      this.cones.push(o);
    }
  }

  build(stage: HTMLElement): void {
    const c = this.host.ctx();
    const t = c.training;
    const icon = el('span', 'ps2-head-icon');
    this.host.anchor(this.icon, icon);
    const sub = t.available ? `${t.countText} bestanden · Vorführung in der Lektion mit [${t.demoKey}]` : 'Lektionen werden geladen …';
    const cols = el('div', 'ps2-lesson-cols');
    this.btns = [];
    this.ensureCones(t.lessons.length);
    for (const g of t.groups) {
      const list = el('div', 'ps2-lesson-list');
      t.lessons.forEach((l, i) => {
        if (l.group !== g.id) return;
        const ic = el('span', 'ps2-lesson-icon');
        this.host.anchor(this.cones[i], ic);
        const b = button(
          'ps2-lesson',
          () => {
            this.sel = i;
            this.select();
            this.confirm();
          },
          ic,
          el('span', 'ps2-lesson-short', l.short),
          el('span', 'ps2-lesson-name', el('b', '', l.name), l.subtitle ? el('small', '', l.subtitle) : null),
          el('span', 'ps2-lesson-side', t.recommended?.id === l.id ? el('small', 'ps2-tag ps2-tag--gold', 'Empfohlen') : null, stars(l.stars)),
        );
        b.dataset.i = String(i);
        b.addEventListener('pointerenter', () => {
          this.sel = i;
          this.select();
        });
        if (t.playable) c.markLockButton(b);
        else b.disabled = true;
        list.append(b);
        this.btns[i] = b;
      });
      cols.append(el('section', 'ps2-panel ps2-lesson-group', el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', g.title), el('small', 'ps2-panel-note', g.reward)), list));
    }
    if (t.lessons.length === 0) cols.append(el('p', 'ps2-empty', t.available ? 'Keine Lektionen gefunden.' : 'Lektionen werden geladen …'));
    this.detail = el('div', 'ps2-detail-bar');
    stage.append(el('div', 'ps2-sub ps2-sub--training', viewHead('Training', sub, icon), el('p', 'ps2-sub-intro', 'Kurze Lektionen, kein Tod, kein Timer. Jede Stufe misst, was du tust, und sagt dir, was fehlt.'), cols, this.detail));
    this.renderDetail();
  }

  private renderDetail(): void {
    const d = this.detail;
    const c = this.host.ctx();
    if (!d) return;
    d.replaceChildren();
    const l = c.training.lessons[this.sel];
    if (!l) return;
    const start = button('ps2-btn ps2-btn--primary', () => this.confirm(), keycap('Enter', true), `${l.short} starten`);
    if (c.training.playable) c.markLockButton(start);
    else start.disabled = true;
    const what = l.stars === 0 ? 'Noch nicht bestanden' : l.stars === 3 ? 'Meister — alle Sterne' : l.stars === 2 ? 'Bonus geschafft — Meister fehlt' : 'Bestanden — Bonus offen';
    d.append(el('span', 'ps2-detail-name', `${l.short} ${l.name}`), el('span', 'ps2-detail-sub', l.subtitle ?? ''), el('span', 'ps2-detail-fact', stars(l.stars), el('b', '', what)), start);
    if (!c.training.playable && c.training.available) d.append(el('span', 'ps2-detail-sub', 'Die Lektions-Logik fehlt in diesem Build.'));
  }

  select(): void {
    this.btns.forEach((b, i) => b?.classList.toggle('is-selected', i === this.sel));
    this.cones.forEach((o, i) => {
      o.selected = i === this.sel;
    });
    this.host.focus(this.cones[this.sel] ?? null, ORANGE);
    this.renderDetail();
  }

  navigate(dx: number, dy: number): void {
    const t = this.host.ctx().training;
    const n = t.lessons.length;
    if (n === 0) return;
    if (dy !== 0) this.sel = wrap(this.sel + dy, n);
    else {
      // Spalte wechseln: gleiche Zeile in der anderen Gruppe
      const cur = t.lessons[this.sel];
      const same = t.lessons.filter((l) => l.group === cur.group);
      const row = same.indexOf(cur);
      const other = t.lessons.filter((l) => l.group !== cur.group);
      if (other.length > 0) this.sel = t.lessons.indexOf(other[Math.min(row, other.length - 1)]);
    }
    this.select();
  }

  confirm(): void {
    const c = this.host.ctx();
    const l = c.training.lessons[this.sel];
    if (l && c.training.playable) c.play(l.id);
  }

  prompts(): readonly PromptSpec[] {
    return [
      { keys: ['▲', '▼', '◀', '▶'], label: 'Lektion', action: null },
      { keys: ['Enter'], label: 'Starten', action: 'confirm', lock: true },
      { keys: ['Esc'], label: 'Zurück', action: 'back' },
    ];
  }

  dispose(): void {
    for (const o of this.cones) this.host.release(o);
    this.host.release(this.icon);
    this.cones = [];
  }
}

// =====================================================================================================================
// Bestenliste

export class BoardView implements SubView {
  readonly id = 'board';
  readonly title = 'Bestenliste';
  private level = 0;
  private row = 0;
  private discs: FgObj[] = [];
  private trophy: FgObj;
  private tabs: HTMLButtonElement[] = [];
  private rows: HTMLElement[] = [];
  private panel: HTMLElement | null = null;

  constructor(
    private readonly host: Host,
    p: SubViewParams,
  ) {
    const c = host.ctx();
    const i = p.levelId ? c.levels.findIndex((l) => l.id === p.levelId) : c.selected;
    this.level = Math.max(0, i);
    this.trophy = host.obj('trophy');
    this.trophy.dimIdle = 0;
    for (const lv of c.levels) {
      const o = host.obj('disc', lv.index, lv);
      o.dimIdle = 0.2;
      this.discs.push(o);
    }
    onBoards(() => this.renderPanel());
    const lv = c.levels[this.level];
    if (lv) loadBoard(c, lv.id);
  }

  build(stage: HTMLElement): void {
    const c = this.host.ctx();
    const icon = el('span', 'ps2-head-icon');
    this.host.anchor(this.trophy, icon);
    const list = el('div', 'ps2-board-discs');
    this.tabs = [];
    c.levels.forEach((lv, i) => {
      const ic = el('span', 'ps2-board-disc-icon');
      if (this.discs[i]) this.host.anchor(this.discs[i], ic);
      const wr = wrLine(lv.id);
      const b = button(
        'ps2-board-disc',
        () => this.setLevel(i),
        ic,
        el('span', 'ps2-board-disc-name', el('b', '', `${lv.num} ${lv.name}`), el('small', '', wr ?? `Du: ${lv.bestText}`)),
      );
      b.style.setProperty('--disc', this.host.discColor(lv));
      list.append(b);
      this.tabs.push(b);
    });
    this.panel = el('section', 'ps2-panel ps2-board-panel');
    const a = c.account;
    const who =
      a.loginRequired && !a.signedIn
        ? el('div', 'ps2-login-note', el('span', '', 'Nicht angemeldet — lesen und Ghosts gehen ohne Konto.'), button('ps2-btn ps2-btn--discord ps2-btn--small', () => this.host.ctx().signIn(), 'Mit Discord anmelden'))
        : null;
    stage.append(el('div', 'ps2-sub ps2-sub--board', viewHead('Bestenliste', c.account.online ? 'Jeder Lauf wird auf dem Server nachgespielt' : 'Offline', icon), who, el('div', 'ps2-board-body', list, this.panel)));
    this.renderPanel();
  }

  private setLevel(i: number): void {
    const c = this.host.ctx();
    this.level = wrap(i, c.levels.length);
    this.row = 0;
    const lv = c.levels[this.level];
    if (lv) {
      c.select(this.level);
      loadBoard(c, lv.id);
    }
    this.renderPanel();
    this.select();
  }

  /** Zeilen: Top 10, darunter "um dich herum" (ohne Doppelte). */
  private entries(b: FrontDoorBoard): { readonly e: FrontDoorBoardEntry; readonly gap: boolean }[] {
    const out = b.top.map((e) => ({ e, gap: false }));
    const seen = new Set(b.top.map((e) => e.runId));
    let first = true;
    for (const e of b.around) {
      if (seen.has(e.runId)) continue;
      out.push({ e, gap: first });
      first = false;
    }
    return out;
  }

  private renderPanel(): void {
    const p = this.panel;
    const c = this.host.ctx();
    if (!p) return;
    p.replaceChildren();
    this.rows = [];
    const lv = c.levels[this.level];
    if (!lv) {
      p.append(el('p', 'ps2-empty', c.loading ? 'Strecken werden gelesen …' : 'Keine Strecken.'));
      return;
    }
    p.style.setProperty('--disc', this.host.discColor(lv));
    // Weltrekord-Zeilen der Disc-Liste mitziehen
    this.tabs.forEach((t, i) => {
      const l = c.levels[i];
      const small = t.querySelector('small');
      if (l && small) small.textContent = wrLine(l.id) ?? `Du: ${l.bestText}`;
    });
    const slot = boardOf(lv.id);
    const head = el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', `${lv.num} ${lv.name}`), el('small', 'ps2-panel-note', slot?.board ? `${slot.board.total} ${slot.board.total === 1 ? 'Spieler' : 'Spieler'} in der Wertung` : ''));
    p.append(head);
    if (!slot || (slot.state === 'loading' && !slot.board)) {
      p.append(el('p', 'ps2-empty', 'Lade …'));
      return;
    }
    if (slot.state === 'error' && !slot.board) {
      p.append(el('p', 'ps2-empty ps2-bad', slot.code === 'offline' || slot.code === 'unavailable' ? `Offline — ${slot.error ?? ''}` : `Nicht geladen — ${slot.error ?? ''}`));
      return;
    }
    const b = slot.board;
    if (!b || b.top.length === 0) {
      p.append(el('p', 'ps2-empty', 'Noch niemand im Ziel. Fahr das Level bis ins Ziel — der Lauf wird geprüft und eingereicht.'));
    } else {
      const table = el('div', 'ps2-table ps2-table--board');
      table.append(el('div', 'ps2-tr ps2-th', el('span', '', '#'), el('span', '', 'Name'), el('span', '', 'Zeit'), el('span', '', 'Medaille'), el('span', '', '')));
      for (const { e, gap } of this.entries(b)) {
        if (gap) table.append(el('div', 'ps2-tr ps2-tr--gap', el('span', '', '…')));
        const medal: MedalId | null = lv.medals ? medalFor(e.time, lv.medals) : null;
        // Auch Bot-Läufe haben ein Profil (Bot = Eingabe-Override bei der Aufnahme, kein eigener Kontotyp)
        const name = button('ps2-tname-btn', () => this.host.go('profile', { uid: e.uid }), accountName(e.name, e.dev, 'ps2-tname'));
        name.title = 'Profil ansehen';
        const ghost = button('ps2-btn ps2-btn--small', () => c.raceGhost(lv.id, e.runId, `Rang ${e.rank} · ${e.name} ${fmtTime(e.time)}`), 'Ghost');
        ghost.title = 'Gegen diesen Ghost fahren';
        c.markLockButton(ghost);
        const r = el(
          'div',
          `ps2-tr${e.mine ? ' is-me' : ''} ps2-rank--${Math.min(e.rank, 4)}`,
          el('span', 'ps2-trank', `${e.rank}.`),
          el('span', 'ps2-twho', e.avatarUrl !== null ? avatar(e.avatarUrl, e.name, 16) : null, name, e.bot ? el('small', 'ps2-tag', 'Bot') : null, e.mine ? el('small', 'ps2-tag ps2-tag--me', 'Du') : null),
          el('span', 'ps2-ttime', fmtTime(e.time)),
          el('span', '', medalChip(medal, true)),
          el('span', 'ps2-tact', ghost),
        );
        r.addEventListener('pointerenter', () => {
          this.row = this.rows.indexOf(r);
          this.markRow();
        });
        table.append(r);
        this.rows.push(r);
      }
      p.append(table);
    }
    const acts = el('div', 'ps2-info-actions');
    const wr = b?.top[0];
    if (wr) {
      const w = button('ps2-btn ps2-btn--primary', () => c.raceGhost(lv.id, wr.runId, `Weltrekord · ${wr.name} ${fmtTime(wr.time)}`), 'Gegen Weltrekord');
      c.markLockButton(w);
      acts.append(w);
    }
    if (lv.bestTime !== null) {
      const own = button('ps2-btn', () => c.raceGhost(lv.id, null, 'Eigene Bestzeit'), 'Gegen eigene Bestzeit');
      c.markLockButton(own);
      acts.append(own);
    }
    if (acts.childElementCount > 0) p.append(acts);
    this.row = Math.min(this.row, Math.max(0, this.rows.length - 1));
    this.markRow();
  }

  private markRow(): void {
    this.rows.forEach((r, i) => r.classList.toggle('is-selected', i === this.row));
  }

  select(): void {
    this.tabs.forEach((t, i) => t.classList.toggle('is-selected', i === this.level));
    this.discs.forEach((o, i) => {
      o.selected = i === this.level;
    });
    this.host.focus(this.discs[this.level] ?? this.trophy, GOLD);
    this.markRow();
  }

  navigate(dx: number, dy: number): void {
    // ▲▼ wechselt die Strecke (die Discs stehen links untereinander), ◀▶ die Zeile — so bleibt Enter = Ghost der Zeile
    if (dy !== 0) this.setLevel(this.level + dy);
    else if (this.rows.length > 0) {
      this.row = wrap(this.row + dx, this.rows.length);
      this.markRow();
    }
  }

  confirm(): void {
    const c = this.host.ctx();
    const lv = c.levels[this.level];
    const b = lv ? boardOf(lv.id)?.board : null;
    if (!lv || !b) return;
    const list = this.entries(b);
    const e = list[this.row]?.e;
    if (e) c.raceGhost(lv.id, e.runId, `Rang ${e.rank} · ${e.name} ${fmtTime(e.time)}`);
  }

  prompts(): readonly PromptSpec[] {
    return [
      { keys: ['▲', '▼'], label: 'Strecke', action: null },
      { keys: ['◀', '▶'], label: 'Zeile', action: null },
      { keys: ['Enter'], label: 'Ghost', action: 'confirm', lock: true },
      { keys: ['Esc'], label: 'Zurück', action: 'back' },
    ];
  }

  dispose(): void {
    onBoards(null);
    for (const o of this.discs) this.host.release(o);
    this.host.release(this.trophy);
    this.discs = [];
  }
}

// =====================================================================================================================
// Kosmetik

export class CosmeticsView implements SubView {
  readonly id = 'cosmetics';
  readonly title = 'Kosmetik';
  private sel = 0;
  private gem: FgObj;
  private tiles: HTMLButtonElement[] = [];
  private stopPreview: (() => void) | null = null;
  private grids: HTMLElement | null = null;
  private note: HTMLElement | null = null;

  constructor(private readonly host: Host) {
    this.gem = host.obj('gem');
    this.gem.dimIdle = 0;
    const c = host.ctx().cosmetics;
    const i = c.gloves.findIndex((g) => g.equipped);
    this.sel = Math.max(0, i);
  }

  private all(): readonly FrontDoorCosmetic[] {
    const c = this.host.ctx().cosmetics;
    return [...c.gloves, ...c.items];
  }

  build(stage: HTMLElement): void {
    const c = this.host.ctx();
    const icon = el('span', 'ps2-head-icon');
    this.host.anchor(this.gem, icon);
    // Vorschau: eigener WebGL-Kontext, 150×176 Low-Res, ganzzahlig (CSS-Klasse wählt 2× oder 3×)
    this.stopPreview?.();
    const canvas = el('canvas', 'ps2-hand-preview');
    const tier = el('span', 'ps2-preview-tier', '');
    this.stopPreview = c.mountHandPreview(canvas, tier);
    const preview = el('section', 'ps2-panel ps2-preview', el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', 'Vorschau'), tier), el('div', 'ps2-preview-frame', canvas));
    this.grids = el('div', 'ps2-inventory');
    this.note = el('div', 'ps2-detail-bar');
    stage.append(el('div', 'ps2-sub ps2-sub--cosmetics', viewHead('Kosmetik', `${c.cosmetics.unlocked}/${c.cosmetics.total} frei · Medaillen und Training schalten frei`, icon), el('div', 'ps2-cosm-body', preview, el('div', 'ps2-cosm-col', this.grids, this.note))));
    this.renderTiles();
  }

  /** Nur die Kacheln neu (Ausrüsten) — die Vorschau läuft weiter. */
  update(): void {
    this.renderTiles();
    this.select();
  }

  private renderTiles(): void {
    const g = this.grids;
    const c = this.host.ctx().cosmetics;
    if (!g) return;
    g.replaceChildren();
    this.tiles = [];
    const section = (title: string, list: readonly FrontDoorCosmetic[], cls: string, offset: number): HTMLElement => {
      const grid = el('div', `ps2-inv-grid ${cls}`);
      list.forEach((it, j) => {
        const i = offset + j;
        const state = !it.unlocked ? 'is-locked' : !it.implemented ? 'is-pending' : it.equipped ? 'is-on' : '';
        const b = button(
          `ps2-inv ${state}`,
          () => {
            this.sel = i;
            this.confirm();
          },
          el('span', 'ps2-inv-name', it.name),
          !it.unlocked ? el('span', 'ps2-inv-cond', el('i', 'ps2-lock'), it.condition ?? 'gesperrt', it.progress ? el('b', 'ps2-inv-prog', it.progress) : null) : null,
          it.unlocked && !it.implemented ? el('span', 'ps2-inv-cond', 'in Arbeit') : null,
          it.equipped ? el('span', 'ps2-inv-on', 'An') : null,
        );
        if (it.conditionLong) b.title = `Gesperrt: ${it.conditionLong}`;
        b.addEventListener('pointerenter', () => {
          this.sel = i;
          this.select();
        });
        grid.append(b);
        this.tiles[i] = b;
      });
      return el('section', 'ps2-panel', el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', title)), grid);
    };
    g.append(section('Hand', c.gloves, 'ps2-inv-grid--hand', 0), section('In der Hand', c.items, 'ps2-inv-grid--item', c.gloves.length));
  }

  private renderNote(): void {
    const n = this.note;
    const it = this.all()[this.sel];
    if (!n || !it) return;
    n.replaceChildren();
    const status = !it.unlocked ? (it.conditionLong ?? 'gesperrt') : !it.implemented ? 'Kommt mit dem nächsten Update' : it.equipped ? 'Ausgerüstet' : 'Frei — Enter rüstet aus';
    n.append(el('span', 'ps2-detail-name', it.name), el('span', 'ps2-detail-sub', status));
    if (it.kind === 'item' && it.id !== 'none') n.append(el('span', 'ps2-detail-sub', 'Mit Gegenstand macht die Hand Tricks — je schneller, desto wilder.'));
  }

  select(): void {
    this.tiles.forEach((t, i) => t?.classList.toggle('is-selected', i === this.sel));
    this.host.focus(this.gem, VIOLET);
    this.gem.selected = true;
    this.renderNote();
  }

  navigate(dx: number, dy: number): void {
    const c = this.host.ctx().cosmetics;
    const n = c.gloves.length + c.items.length;
    if (n === 0) return;
    const inGloves = this.sel < c.gloves.length;
    const cols = inGloves ? 3 : 5;
    if (dx !== 0) this.sel = wrap(this.sel + dx, n);
    else {
      const base = inGloves ? 0 : c.gloves.length;
      const len = inGloves ? c.gloves.length : c.items.length;
      const local = this.sel - base;
      const next = local + dy * cols;
      if (next >= 0 && next < len) this.sel = base + next;
      else if (dy > 0 && inGloves) this.sel = c.gloves.length + Math.min(local % cols, c.items.length - 1);
      else if (dy < 0 && !inGloves) this.sel = Math.min(c.gloves.length - 1, Math.floor((c.gloves.length - 1) / 3) * 3 + Math.min(local % cols, 2));
    }
    this.select();
  }

  confirm(): void {
    const it = this.all()[this.sel];
    if (it && it.unlocked && it.implemented) this.host.ctx().equip(it.kind, it.id);
  }

  prompts(): readonly PromptSpec[] {
    return [
      { keys: ['◀', '▶', '▲', '▼'], label: 'Wählen', action: null },
      { keys: ['Enter'], label: 'Ausrüsten', action: 'confirm' },
      { keys: ['Esc'], label: 'Zurück', action: 'back' },
    ];
  }

  dispose(): void {
    this.stopPreview?.();
    this.stopPreview = null;
    this.host.release(this.gem);
  }
}

// =====================================================================================================================
// Profil (Memory-Card-Ansicht): eigenes oder fremdes

export class ProfileView implements SubView {
  readonly id = 'profile';
  readonly title = 'Profil';
  private state: 'loading' | 'ok' | 'error' | 'login' = 'loading';
  private profile: PlayerProfile | null = null;
  private error: string | null = null;
  private code: string | null = null;
  private row = 0;
  private card: FgObj;
  private discs: FgObj[] = [];
  private rows: HTMLElement[] = [];
  private seq = 0;
  private mod: ModBlock | null = null;

  constructor(
    private readonly host: Host,
    private readonly uid: string | undefined,
  ) {
    this.card = host.obj('card', 1);
    this.card.dimIdle = 0;
    this.card.sway = true;
    const c = host.ctx();
    for (const lv of c.levels) {
      const o = host.obj('disc', lv.index, lv);
      o.dimIdle = 0.15;
      this.discs.push(o);
    }
    this.load();
  }

  private get mine(): boolean {
    return this.uid === undefined;
  }

  private load(): void {
    const c = this.host.ctx();
    const seq = ++this.seq;
    if (this.mine && c.account.loginRequired && !c.account.signedIn) {
      this.state = 'login';
      return;
    }
    if (!c.account.online) {
      this.state = 'error';
      this.error = 'Offline — kein Online-Profil.';
      this.code = 'offline';
      return;
    }
    this.state = 'loading';
    c.getProfile(this.uid).then(
      (p) => {
        if (seq !== this.seq) return;
        this.state = 'ok';
        this.profile = p;
        this.host.rebuild();
      },
      (err: unknown) => {
        if (seq !== this.seq) return;
        this.state = 'error';
        this.error = errText(err);
        this.code = errCode(err);
        this.host.rebuild();
      },
    );
    const admin = c.admin();
    if (!this.mine && this.uid && admin && c.account.dev) this.mod = new ModBlock(this.host, admin, this.uid, () => this.load());
  }

  build(stage: HTMLElement): void {
    const c = this.host.ctx();
    const p = this.profile;
    const a = c.account;
    const pIcon = el('div', 'ps2-profile-icon');
    this.host.anchor(this.card, pIcon);
    const name = p?.name ?? (this.mine ? (a.name ?? (a.loginRequired ? 'Gast' : 'Lokales Profil')) : '…');
    const dev = p?.dev ?? (this.mine && a.dev);
    const av = p?.avatarUrl ?? (this.mine ? a.avatarUrl : null);
    const facts = el('dl', 'ps2-profile-stats');
    const fact = (k: string, v: string): void => {
      facts.append(el('dt', '', k), el('dd', '', v));
    };
    if (p) {
      fact('Dabei seit', date(p.memberSince));
      fact('Läufe', String(p.runs));
      fact('Weltrekorde', String(p.worldRecords));
    } else if (this.state === 'loading') fact('Status', 'lädt …');
    const left = el(
      'section',
      'ps2-profile ps2-profile--big',
      el('div', 'ps2-profile-who', pIcon, el('div', 'ps2-profile-id', el('span', 'ps2-profile-tag', this.mine ? 'Mein Profil' : 'Spieler'), el('span', 'ps2-profile-line', avatar(av, name, 32), accountName(name, dev, 'ps2-profile-name')))),
      facts,
    );
    if (this.state === 'login') {
      left.append(el('p', 'ps2-sub-intro', 'Dein Online-Profil (Ränge, Weltrekorde) braucht den Discord-Login. Lokale Bestzeiten stehen rechts.'), button('ps2-btn ps2-btn--discord', () => this.host.ctx().signIn(), 'Mit Discord anmelden'));
    }
    if (this.state === 'error') left.append(el('p', 'ps2-empty ps2-bad', this.code === 'notFound' ? 'Spieler nicht gefunden.' : (this.error ?? 'Fehler')));
    if (this.mine && a.signedIn) left.append(el('div', 'ps2-profile-actions', button('ps2-btn ps2-btn--quiet ps2-btn--small', () => this.host.ctx().signOut(), 'Abmelden')));
    if (this.mod) left.append(this.mod.element());

    // Rechts: je Level Disc, Bestzeit, Rang, Medaille, Ghost, Bestenliste
    const list = el('div', 'ps2-table ps2-table--profile');
    this.rows = [];
    c.levels.forEach((lv, i) => {
      const best = p?.bests.find((b) => b.levelId === lv.id) ?? null;
      const time = best ? best.time : this.mine ? lv.bestTime : null;
      const medal = time !== null && lv.medals ? medalFor(time, lv.medals) : null;
      const ic = el('span', 'ps2-prow-icon');
      if (this.discs[i]) this.host.anchor(this.discs[i], ic);
      const acts = el('span', 'ps2-tact');
      if (best) {
        const g = button('ps2-btn ps2-btn--small', () => c.raceGhost(lv.id, best.runId, `${name} ${fmtTime(best.time)}`), this.mine ? 'Ghost' : 'Gegen Ghost');
        c.markLockButton(g);
        acts.append(g);
      }
      acts.append(button('ps2-btn ps2-btn--small ps2-btn--quiet', () => this.host.go('board', { levelId: lv.id }), 'Liste'));
      const r = el(
        'div',
        'ps2-tr ps2-prow',
        ic,
        el('span', 'ps2-prow-name', el('b', '', `${lv.num} ${lv.name}`), el('small', '', best ? `#${best.rank} / ${best.total}` : time !== null ? 'nur lokal' : 'noch kein Lauf')),
        el('span', 'ps2-ttime', time !== null ? fmtTime(time) : '--:--.--'),
        el('span', '', medalChip(medal, true)),
        acts,
      );
      r.style.setProperty('--disc', this.host.discColor(lv));
      r.addEventListener('pointerenter', () => {
        this.row = i;
        this.select();
      });
      list.append(r);
      this.rows.push(r);
    });
    const right = el('section', 'ps2-panel ps2-profile-levels', el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', 'Speicherstände'), el('small', 'ps2-panel-note', p ? 'verifizierte Bestzeiten' : this.mine ? 'lokale Bestzeiten' : '')), list);
    stage.append(el('div', 'ps2-sub ps2-sub--profile', viewHead(this.mine ? 'Profil' : 'Spieler', this.mine ? 'Memory Card · Steckplatz 1' : 'Öffentliches Profil', null), el('div', 'ps2-card-body', left, right)));
  }

  select(): void {
    this.rows.forEach((r, i) => r.classList.toggle('is-selected', i === this.row));
    this.discs.forEach((o, i) => {
      o.selected = i === this.row;
    });
    this.host.focus(this.discs[this.row] ?? this.card, CARD);
  }

  navigate(_dx: number, dy: number): void {
    if (this.rows.length === 0) return;
    this.row = wrap(this.row + (dy !== 0 ? dy : _dx), this.rows.length);
    this.select();
  }

  confirm(): void {
    const c = this.host.ctx();
    const lv = c.levels[this.row];
    const best = lv ? this.profile?.bests.find((b) => b.levelId === lv.id) : null;
    if (lv && best) c.raceGhost(lv.id, best.runId, `${this.profile?.name ?? ''} ${fmtTime(best.time)}`);
  }

  prompts(): readonly PromptSpec[] {
    return [
      { keys: ['▲', '▼'], label: 'Strecke', action: null },
      { keys: ['Enter'], label: 'Ghost', action: 'confirm', lock: true },
      { keys: ['Esc'], label: 'Zurück', action: 'back' },
    ];
  }

  dispose(): void {
    this.seq++;
    for (const o of this.discs) this.host.release(o);
    this.host.release(this.card);
  }
}

// =====================================================================================================================
// Moderations-Block auf fremden Profilen (nur Devs)

class ModBlock {
  private player: AdminPlayer | null = null;
  private msg: string | null = null;
  private bad = false;
  private confirmBan = false;
  private box: HTMLElement | null = null;

  constructor(
    private readonly host: Host,
    private readonly admin: AdminService,
    private readonly uid: string,
    private readonly reload: () => void,
  ) {
    this.fetch();
  }

  private fetch(): void {
    this.admin.listPlayers({ search: this.uid, limit: 5 }).then(
      (page) => {
        this.player = page.items.find((x) => x.uid === this.uid) ?? null;
        this.render();
      },
      (err: unknown) => this.fail(err),
    );
  }

  private fail(err: unknown): void {
    this.msg = errText(err);
    this.bad = true;
    this.render();
  }

  element(): HTMLElement {
    this.box = el('div', 'ps2-mod-block');
    this.render();
    return this.box;
  }

  private render(): void {
    const b = this.box;
    if (!b) return;
    b.replaceChildren(el('div', 'ps2-panel-head', el('h2', 'ps2-panel-title', 'Moderation'), el('small', 'ps2-panel-note', this.player ? (this.player.banned ? `gesperrt: ${this.player.banReason ?? ''}` : `${this.player.runs} ${this.player.runs === 1 ? 'Lauf' : 'Läufe'}`) : 'lädt …')));
    const p = this.player;
    if (p) {
      const reason = el('input', 'ps2-input');
      reason.placeholder = 'Begründung (Pflicht)';
      reason.maxLength = 200;
      const banRow = el('div', 'ps2-mod-row');
      if (!this.confirmBan) {
        banRow.append(
          button(`ps2-btn ps2-btn--small${p.banned ? '' : ' ps2-btn--danger'}`, () => {
            this.confirmBan = true;
            this.render();
          }, p.banned ? 'Entsperren' : 'Sperren'),
        );
      } else {
        banRow.append(
          reason,
          button('ps2-btn ps2-btn--small ps2-btn--danger', () => {
            const r = reason.value.trim();
            if (!p.banned && r.length === 0) {
              this.msg = 'Begründung fehlt.';
              this.bad = true;
              this.render();
              return;
            }
            this.admin.setBan(p.uid, !p.banned, r.length > 0 ? r : undefined).then(
              (np) => {
                this.player = np;
                this.confirmBan = false;
                this.msg = np.banned ? 'Gesperrt.' : 'Entsperrt.';
                this.bad = false;
                invalidateBoards();
                this.render();
                this.reload();
              },
              (err: unknown) => this.fail(err),
            );
          }, p.banned ? 'Wirklich entsperren?' : 'Wirklich sperren?'),
          button('ps2-btn ps2-btn--small ps2-btn--quiet', () => {
            this.confirmBan = false;
            this.render();
          }, 'Abbrechen'),
        );
      }
      const nameIn = el('input', 'ps2-input');
      nameIn.value = p.name;
      nameIn.maxLength = 16;
      const renameRow = el(
        'div',
        'ps2-mod-row',
        nameIn,
        button('ps2-btn ps2-btn--small', () => {
          this.admin.renamePlayer(p.uid, nameIn.value).then(
            (np) => {
              this.player = np;
              this.msg = `Umbenannt in ${np.name}.`;
              this.bad = false;
              invalidateBoards();
              this.render();
              this.reload();
            },
            (err: unknown) => this.fail(err),
          );
        }, 'Umbenennen'),
      );
      b.append(banRow, renameRow, el('div', 'ps2-mod-row', button('ps2-btn ps2-btn--small ps2-btn--quiet', () => this.host.go('moderation', { uid: p.uid }), 'Läufe dieses Spielers')));
    }
    if (this.msg) b.append(el('p', `ps2-mod-msg${this.bad ? ' ps2-bad' : ''}`, this.msg));
  }
}

// =====================================================================================================================
// Moderation (nur Devs): Läufe, Spieler, Protokoll

type ModTab = 'runs' | 'players' | 'audit';

interface Paged<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
}

function paged<T>(): Paged<T> {
  return { items: [], total: 0, loading: false, error: null };
}

const PAGE = 25;

export class ModerationView implements SubView {
  readonly id = 'moderation';
  readonly title = 'Moderation';
  private tab: ModTab = 'runs';
  private runs = paged<AdminRun>();
  private players = paged<AdminPlayer>();
  private audit = paged<AdminAuditEntry>();
  private levelFilter = '';
  private uidFilter: string | undefined;
  private search = '';
  private bannedOnly = false;
  /** Zweistufige Bestätigung: Lauf/Spieler-id, die gerade "Wirklich …?" zeigt. */
  private confirming: string | null = null;
  private renaming: string | null = null;
  private notice: { text: string; bad: boolean } | null = null;
  private gear: FgObj;
  private seq = 0;

  constructor(
    private readonly host: Host,
    p: SubViewParams,
  ) {
    this.uidFilter = p.uid;
    this.gear = host.obj('gear', 3);
    this.gear.dimIdle = 0;
    this.reload();
  }

  private svc(): AdminService | null {
    return this.host.ctx().admin();
  }

  private reload(): void {
    this.seq++;
    if (this.tab === 'runs') this.runs = paged();
    else if (this.tab === 'players') this.players = paged();
    else this.audit = paged();
    this.more();
  }

  /** Nächste Seite des aktuellen Reiters. */
  private more(): void {
    const a = this.svc();
    if (!a) return;
    const seq = this.seq;
    const done = (): void => {
      if (seq === this.seq) this.host.rebuild();
    };
    if (this.tab === 'runs') {
      const st = this.runs;
      st.loading = true;
      a.listRuns({ levelId: this.levelFilter || undefined, uid: this.uidFilter, limit: PAGE, offset: st.items.length }).then(
        (pg) => {
          st.items.push(...pg.items);
          st.total = pg.total;
          st.loading = false;
          done();
        },
        (err: unknown) => {
          st.loading = false;
          st.error = errText(err);
          done();
        },
      );
    } else if (this.tab === 'players') {
      const st = this.players;
      st.loading = true;
      a.listPlayers({ search: this.search || undefined, bannedOnly: this.bannedOnly, limit: PAGE, offset: st.items.length }).then(
        (pg) => {
          st.items.push(...pg.items);
          st.total = pg.total;
          st.loading = false;
          done();
        },
        (err: unknown) => {
          st.loading = false;
          st.error = errText(err);
          done();
        },
      );
    } else {
      const st = this.audit;
      st.loading = true;
      a.auditLog({ uid: this.uidFilter, limit: PAGE, offset: st.items.length }).then(
        (pg) => {
          st.items.push(...pg.items);
          st.total = pg.total;
          st.loading = false;
          done();
        },
        (err: unknown) => {
          st.loading = false;
          st.error = errText(err);
          done();
        },
      );
    }
  }

  private setTab(t: ModTab): void {
    if (this.tab === t) return;
    this.tab = t;
    this.confirming = null;
    this.renaming = null;
    this.notice = null;
    this.reload();
    this.host.rebuild();
  }

  private levelName(id: string): string {
    const lv = this.host.ctx().levels.find((l) => l.id === id);
    return lv ? `${lv.num} ${lv.name}` : id;
  }

  build(stage: HTMLElement): void {
    const icon = el('span', 'ps2-head-icon');
    this.host.anchor(this.gear, icon);
    const a = this.svc();
    const tabs = el('div', 'ps2-tabs');
    const tab = (t: ModTab, label: string): void => {
      const b = button(`ps2-tab${this.tab === t ? ' is-selected' : ''}`, () => this.setTab(t), label);
      b.dataset.tab = t;
      tabs.append(b);
    };
    tab('runs', 'Läufe');
    tab('players', 'Spieler');
    tab('audit', 'Protokoll');
    const body = el('section', 'ps2-panel ps2-mod-panel');
    if (!a) body.append(el('p', 'ps2-empty ps2-bad', 'Moderation ist nur für Entwickler (angemeldet, Rolle dev).'));
    else if (this.tab === 'runs') this.buildRuns(body, a);
    else if (this.tab === 'players') this.buildPlayers(body, a);
    else this.buildAudit(body);
    if (this.notice) body.prepend(el('p', `ps2-mod-msg${this.notice.bad ? ' ps2-bad' : ''}`, this.notice.text));
    stage.append(el('div', 'ps2-sub ps2-sub--mod', viewHead('Moderation', 'Nur für Entwickler · jede Aktion landet im Protokoll', icon), tabs, body));
  }

  private filterBar(...kids: (Node | null)[]): HTMLElement {
    return el('div', 'ps2-mod-filter', ...kids);
  }

  private pager(st: Paged<unknown>): HTMLElement {
    const bar = el('div', 'ps2-mod-pager', el('span', 'ps2-panel-note', `${st.items.length} von ${st.total}`));
    if (st.error) bar.append(el('span', 'ps2-bad', st.error));
    if (st.loading) bar.append(el('span', 'ps2-panel-note', 'lädt …'));
    else if (st.items.length < st.total) bar.append(button('ps2-btn ps2-btn--small', () => this.more(), 'Mehr laden'));
    return bar;
  }

  private buildRuns(body: HTMLElement, a: AdminService): void {
    const c = this.host.ctx();
    const lvSeg = el('div', 'ps2-seg');
    const seg = (id: string, label: string): void => {
      lvSeg.append(
        button(`ps2-seg-btn${this.levelFilter === id ? ' is-on' : ''}`, () => {
          this.levelFilter = id;
          this.reload();
          this.host.rebuild();
        }, label),
      );
    };
    seg('', 'Alle');
    for (const lv of c.levels) seg(lv.id, lv.num);
    const who = this.uidFilter
      ? el('span', 'ps2-chip', `Spieler: ${this.runs.items[0]?.name ?? this.uidFilter.slice(0, 8)}`, button('ps2-chip-x', () => {
          this.uidFilter = undefined;
          this.reload();
          this.host.rebuild();
        }, '×'))
      : null;
    body.append(this.filterBar(el('span', 'ps2-panel-note', 'Level'), lvSeg, who));
    const t = el('div', 'ps2-table ps2-table--mod');
    t.append(el('div', 'ps2-tr ps2-th', el('span', '', 'Spieler'), el('span', '', 'Level'), el('span', '', 'Zeit'), el('span', '', 'Datum'), el('span', '', '')));
    for (const r of this.runs.items) {
      const acts = el('span', 'ps2-tact');
      acts.append(button('ps2-btn ps2-btn--small ps2-btn--quiet', () => this.host.go('profile', { uid: r.uid }), 'Profil'));
      if (this.confirming === r.runId) {
        const reason = el('input', 'ps2-input');
        reason.placeholder = 'Begründung (Pflicht)';
        reason.maxLength = 200;
        acts.append(
          reason,
          button('ps2-btn ps2-btn--small ps2-btn--danger', () => {
            const why = reason.value.trim();
            if (why.length === 0) {
              this.notice = { text: 'Zum Löschen braucht es eine Begründung.', bad: true };
              this.host.rebuild();
              return;
            }
            a.deleteRun(r.runId, why).then(
              (res) => {
                this.confirming = null;
                this.notice = { text: `Gelöscht: ${r.name} · ${this.levelName(r.levelId)} ${fmtTime(r.time)}${res.wasBest ? (res.newBest ? ` — neue Bestzeit ${fmtTime(res.newBest.time)}` : ' — keine Bestzeit mehr') : ''}`, bad: false };
                invalidateBoards();
                this.reload();
                this.host.rebuild();
              },
              (err: unknown) => {
                this.notice = { text: `Nicht gelöscht — ${errText(err)}`, bad: true };
                this.host.rebuild();
              },
            );
          }, 'Wirklich löschen?'),
          button('ps2-btn ps2-btn--small ps2-btn--quiet', () => {
            this.confirming = null;
            this.host.rebuild();
          }, 'Abbrechen'),
        );
      } else {
        acts.append(
          button('ps2-btn ps2-btn--small ps2-btn--danger', () => {
            this.confirming = r.runId;
            this.host.rebuild();
          }, 'Löschen'),
        );
      }
      t.append(
        el(
          'div',
          `ps2-tr${r.banned ? ' is-banned' : ''}${this.confirming === r.runId ? ' is-confirm' : ''}`,
          el('span', 'ps2-twho', accountName(r.name, r.dev, 'ps2-tname'), r.banned ? el('small', 'ps2-tag ps2-tag--bad', 'Gesperrt') : null, r.best ? el('small', 'ps2-tag', 'PB') : null),
          el('span', '', this.levelName(r.levelId)),
          el('span', 'ps2-ttime', fmtTime(r.time)),
          el('span', 'ps2-tdate', date(r.date)),
          acts,
        ),
      );
    }
    if (this.runs.items.length === 0 && !this.runs.loading) t.append(el('p', 'ps2-empty', 'Keine Läufe.'));
    body.append(t, this.pager(this.runs));
  }

  private buildPlayers(body: HTMLElement, a: AdminService): void {
    const q = el('input', 'ps2-input ps2-input--wide');
    q.placeholder = 'Name, Discord-Name oder ID';
    q.value = this.search;
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.search = q.value.trim();
        this.reload();
        this.host.rebuild();
      }
    });
    const go = button('ps2-btn ps2-btn--small', () => {
      this.search = q.value.trim();
      this.reload();
      this.host.rebuild();
    }, 'Suchen');
    const only = button(`ps2-seg-btn${this.bannedOnly ? ' is-on' : ''}`, () => {
      this.bannedOnly = !this.bannedOnly;
      this.reload();
      this.host.rebuild();
    }, 'Nur gesperrte');
    body.append(this.filterBar(q, go, only));
    const t = el('div', 'ps2-table ps2-table--players');
    t.append(el('div', 'ps2-tr ps2-th', el('span', '', 'Spieler'), el('span', '', 'Discord'), el('span', '', 'Läufe'), el('span', '', 'Status'), el('span', '', '')));
    for (const p of this.players.items) {
      const acts = el('span', 'ps2-tact');
      acts.append(button('ps2-btn ps2-btn--small ps2-btn--quiet', () => this.host.go('profile', { uid: p.uid }), 'Profil'));
      if (this.confirming === p.uid) {
        const reason = el('input', 'ps2-input');
        reason.placeholder = p.banned ? 'Notiz (optional)' : 'Begründung (Pflicht)';
        reason.maxLength = 200;
        acts.append(
          reason,
          button('ps2-btn ps2-btn--small ps2-btn--danger', () => {
            const why = reason.value.trim();
            if (!p.banned && why.length === 0) {
              this.notice = { text: 'Zum Sperren braucht es eine Begründung.', bad: true };
              this.host.rebuild();
              return;
            }
            a.setBan(p.uid, !p.banned, why || undefined).then(
              (np) => {
                this.replacePlayer(np);
                this.confirming = null;
                this.notice = { text: `${np.name}: ${np.banned ? 'gesperrt' : 'entsperrt'}.`, bad: false };
                invalidateBoards();
                this.host.rebuild();
              },
              (err: unknown) => {
                this.notice = { text: `Nicht geändert — ${errText(err)}`, bad: true };
                this.host.rebuild();
              },
            );
          }, p.banned ? 'Wirklich entsperren?' : 'Wirklich sperren?'),
          button('ps2-btn ps2-btn--small ps2-btn--quiet', () => {
            this.confirming = null;
            this.host.rebuild();
          }, 'Abbrechen'),
        );
      } else if (this.renaming === p.uid) {
        const n = el('input', 'ps2-input');
        n.value = p.name;
        n.maxLength = 16;
        acts.append(
          n,
          button('ps2-btn ps2-btn--small', () => {
            a.renamePlayer(p.uid, n.value).then(
              (np) => {
                this.replacePlayer(np);
                this.renaming = null;
                this.notice = { text: `Umbenannt: ${p.name} → ${np.name}.`, bad: false };
                invalidateBoards();
                this.host.rebuild();
              },
              (err: unknown) => {
                this.notice = { text: `Nicht umbenannt — ${errText(err)}`, bad: true };
                this.host.rebuild();
              },
            );
          }, 'Speichern'),
          button('ps2-btn ps2-btn--small ps2-btn--quiet', () => {
            this.renaming = null;
            this.host.rebuild();
          }, 'Abbrechen'),
        );
      } else {
        acts.append(
          button('ps2-btn ps2-btn--small', () => {
            this.renaming = p.uid;
            this.confirming = null;
            this.host.rebuild();
          }, 'Umbenennen'),
          button(`ps2-btn ps2-btn--small${p.banned ? '' : ' ps2-btn--danger'}`, () => {
            this.confirming = p.uid;
            this.renaming = null;
            this.host.rebuild();
          }, p.banned ? 'Entsperren' : 'Sperren'),
        );
      }
      t.append(
        el(
          'div',
          `ps2-tr${p.banned ? ' is-banned' : ''}${this.confirming === p.uid || this.renaming === p.uid ? ' is-confirm' : ''}`,
          el('span', 'ps2-twho', avatar(p.avatarUrl, p.name, 16), accountName(p.name, p.dev, 'ps2-tname')),
          el('span', 'ps2-tdate', p.discordName ?? '—'),
          el('span', '', String(p.runs)),
          el('span', '', p.banned ? el('small', 'ps2-tag ps2-tag--bad', 'Gesperrt') : el('small', 'ps2-tag', 'Aktiv'), p.banned && p.banReason ? el('small', 'ps2-panel-note', p.banReason) : null),
          acts,
        ),
      );
    }
    if (this.players.items.length === 0 && !this.players.loading) t.append(el('p', 'ps2-empty', 'Keine Spieler.'));
    body.append(t, this.pager(this.players));
  }

  private replacePlayer(np: AdminPlayer): void {
    const i = this.players.items.findIndex((x) => x.uid === np.uid);
    if (i >= 0) this.players.items[i] = np;
  }

  private buildAudit(body: HTMLElement): void {
    const t = el('div', 'ps2-table ps2-table--audit');
    t.append(el('div', 'ps2-tr ps2-th', el('span', '', 'Wann'), el('span', '', 'Wer'), el('span', '', 'Aktion'), el('span', '', 'Ziel'), el('span', '', 'Details')));
    const label: Readonly<Record<string, string>> = { ban: 'Gesperrt', unban: 'Entsperrt', rename: 'Umbenannt', delete_run: 'Lauf gelöscht' };
    for (const e of this.audit.items) {
      const d = e.detail;
      const parts: string[] = [];
      if (typeof d.from === 'string' && typeof d.to === 'string') parts.push(`${d.from} → ${d.to}`);
      if (typeof d.level_id === 'string') parts.push(this.levelName(d.level_id));
      if (typeof d.time_ms === 'number') parts.push(fmtTime(d.time_ms / 1000));
      if (typeof d.reason === 'string' && d.reason.length > 0) parts.push(`„${d.reason}“`);
      t.append(
        el(
          'div',
          'ps2-tr',
          el('span', 'ps2-tdate', `${date(e.at)} ${new Date(e.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`),
          el('span', '', e.actorName ?? e.actorUid.slice(0, 8)),
          el('span', `ps2-tag ps2-tag--${e.action}`, label[e.action] ?? e.action),
          el('span', '', e.targetName ?? (e.targetUid ? e.targetUid.slice(0, 8) : '—')),
          el('span', 'ps2-panel-note', parts.join(' · ')),
        ),
      );
    }
    if (this.audit.items.length === 0 && !this.audit.loading) t.append(el('p', 'ps2-empty', 'Noch keine Einträge.'));
    body.append(t, this.pager(this.audit));
  }

  select(): void {
    this.host.focus(this.gear, rgb('#8fb4ff'));
    this.gear.selected = true;
  }

  navigate(dx: number, _dy: number): void {
    if (dx === 0) return;
    const order: ModTab[] = ['runs', 'players', 'audit'];
    this.setTab(order[wrap(order.indexOf(this.tab) + dx, order.length)]);
  }

  confirm(): void {
    // Enter löst in der Moderation bewusst nichts aus (alles Destruktive braucht den Doppel-Klick).
  }

  prompts(): readonly PromptSpec[] {
    return [
      { keys: ['◀', '▶'], label: 'Reiter', action: null },
      { keys: ['Esc'], label: 'Zurück', action: 'back' },
    ];
  }

  dispose(): void {
    this.seq++;
    this.host.release(this.gear);
  }
}

