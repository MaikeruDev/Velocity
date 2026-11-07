/**
 * Front-Door-Vertrag Runde 4 (Plan 010): Abbildung Bestenliste → FrontDoorBoard, Level-Datei → Theme, und wie die
 * PS2-Ansichten die Online-Schicht benutzen (Profil, Moderation) — gegen den echten LocalMockService.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import type { StorageLike } from '../src/engine/Settings';
import { LocalMockService } from '../src/online/LocalMockService';
import type { LeaderboardEntry, LeaderboardPage } from '../src/online/types';
import { doorBoard, doorBoardEntry, levelTheme } from '../src/ui/menuLab/doorData';
import { MENU_STYLES } from '../src/ui/menuLab/registry';
import type { FrontDoorBoard, FrontDoorContext } from '../src/ui/menuLab/types';
import { boardOf, invalidateBoards, loadBoard, onBoards, wrLine } from '../src/ui/menuLab/ps2/views';

function memStorage(): StorageLike {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const cache = new Map<string, CompiledLevel>();
const dir = join(process.cwd(), 'public', 'levels');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { id: string; file: string }[];
async function loadLevel(id: string): Promise<CompiledLevel> {
  let lv = cache.get(id);
  if (!lv) {
    const file = index.find((e) => e.id === id)?.file;
    if (!file) throw new Error(`Level ${id} unbekannt`);
    lv = compileLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')) as LevelFile);
    cache.set(id, lv);
  }
  return lv;
}

const entry = (rank: number, uid: string, time: number, extra: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
  rank,
  runId: `run-${uid}`,
  uid,
  name: uid.toUpperCase(),
  time,
  date: '2026-11-01T00:00:00Z',
  bot: false,
  avatarUrl: null,
  dev: false,
  ...extra,
});

describe('doorData: Bestenliste → Vertrag', () => {
  it('mine nur über die eigene uid, nie ohne Anmeldung', () => {
    const e = entry(1, 'a', 18.66, { dev: true, bot: true, avatarUrl: 'x' });
    expect(doorBoardEntry(e, 'a')).toEqual({ rank: 1, uid: 'a', name: 'A', avatarUrl: 'x', dev: true, bot: true, time: 18.66, runId: 'run-a', mine: true });
    expect(doorBoardEntry(e, null).mine).toBe(false);
    expect(doorBoardEntry(e, 'b').mine).toBe(false);
  });

  it('ohne eigenen Eintrag: around leer, me null; total kommt von der Top-Seite', () => {
    const top: LeaderboardPage = { levelId: 'level1', entries: [entry(1, 'a', 10), entry(2, 'b', 11)], total: 7, me: null };
    const around: LeaderboardPage = { levelId: 'level1', entries: [entry(5, 'x', 13)], total: 7, me: null };
    const b = doorBoard('level1', top, around, 'me');
    expect(b).toMatchObject({ levelId: 'level1', total: 7, me: null, around: [] });
    expect(b.top.map((e) => e.rank)).toEqual([1, 2]);
    const meE = entry(6, 'me', 14);
    const b2 = doorBoard('level1', top, { levelId: 'level1', entries: [entry(5, 'x', 13), meE], total: 7, me: meE }, 'me');
    expect(b2.me).toMatchObject({ uid: 'me', mine: true, rank: 6 });
    expect(b2.around.map((e) => e.mine)).toEqual([false, true]);
  });
});

describe('doorData: Level-Farben', () => {
  it('jede gebaute Level-Datei liefert ein vollständiges Theme', () => {
    for (const lv of index) {
      const t = levelTheme(JSON.parse(readFileSync(join(dir, lv.file), 'utf8')));
      expect(t, lv.id).not.toBeNull();
      if (!t) continue;
      for (const c of [t.trim, t.skyTop, t.skyHorizon, t.skyBottom, t.sun]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      if (t.trimAlt !== null) expect(t.trimAlt).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('kaputte Daten → null statt Fehler', () => {
    expect(levelTheme(null)).toBeNull();
    expect(levelTheme({})).toBeNull();
    expect(levelTheme({ environment: { trimColor: '#fff' } })).toBeNull();
    expect(levelTheme({ environment: { trimColor: '#ffffff', skyTop: '#000000', skyHorizon: '#111111', skyBottom: '#222222', sunColor: '#333333', moon: true } })).toMatchObject({ moon: true, trimAlt: null });
  });
});

describe('Registry: Stil-Ansichten', () => {
  it('ps2 baut Training, Bestenliste, Kosmetik, Profil, Moderation selbst; die anderen keine', () => {
    const ps2 = MENU_STYLES.find((s) => s.id === 'ps2');
    expect([...(ps2?.views ?? [])].sort()).toEqual(['cosmetics', 'leaderboard', 'moderation', 'profile', 'training']);
    for (const s of MENU_STYLES) if (s.id !== 'ps2') expect(s.views ?? []).toEqual([]);
  });
});

/** Nur die Teile des ctx, die die Bestenlisten-Ablage braucht. */
function boardCtx(svc: LocalMockService): FrontDoorContext {
  const ctx: Pick<FrontDoorContext, 'board'> = {
    board: async (levelId: string): Promise<FrontDoorBoard> => {
      const [top, around] = await Promise.all([svc.getLeaderboard(levelId, { kind: 'top', limit: 10 }), svc.getLeaderboard(levelId, { kind: 'around', radius: 3 })]);
      return doorBoard(levelId, top, around, svc.identity?.uid ?? null);
    },
  };
  return ctx as FrontDoorContext;
}

describe('PS2-Ansichten gegen den Mock (Profil + Moderation)', () => {
  it('Weltrekord-Zeile, Bann blendet aus, Profil des Gesperrten ist unbekannt, Löschen verschiebt den WR', async () => {
    const svc = new LocalMockService({ storage: memStorage(), loadLevel, latencyMs: 0, dev: true });
    await svc.auth('Dev');
    await svc.ensureRivals('level1');
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    const ctx = boardCtx(svc);
    invalidateBoards();
    const wait = (): Promise<void> =>
      new Promise((res) => {
        onBoards(() => res());
      });

    let done = wait();
    loadBoard(ctx, 'level1', true);
    await done;
    const first = boardOf('level1')?.board?.top[0];
    if (!first) throw new Error('keine Bestenliste');
    expect(wrLine('level1')).toMatch(new RegExp(`^WR \\d\\d:\\d\\d\\.\\d\\d · ${first.name}$`));

    // Profil (wie ProfileView): fremd ohne Login lesbar, Rang 1
    const prof = await svc.getProfile(first.uid);
    expect(prof.bests.find((b) => b.levelId === 'level1')).toMatchObject({ rank: 1, runId: first.runId });

    // Bann (wie ModBlock): Begründung Pflicht, danach weg aus der Liste, Profil unbekannt
    await expect(admin.setBan(first.uid, true, '')).rejects.toMatchObject({ code: 'invalid' });
    await admin.setBan(first.uid, true, 'Test');
    done = wait();
    loadBoard(ctx, 'level1', true);
    await done;
    expect(boardOf('level1')?.board?.top.some((e) => e.uid === first.uid)).toBe(false);
    await expect(svc.getProfile(first.uid)).rejects.toMatchObject({ code: 'notFound' });
    await admin.setBan(first.uid, false);

    // Löschen (wie ModerationView): WR wandert zum Zweiten
    done = wait();
    loadBoard(ctx, 'level1', true);
    await done;
    const second = boardOf('level1')?.board?.top[1];
    await admin.deleteRun(first.runId, 'Test');
    done = wait();
    loadBoard(ctx, 'level1', true);
    await done;
    expect(boardOf('level1')?.board?.top[0].runId).toBe(second?.runId);
    const log = await admin.auditLog({});
    expect(log.items.map((e) => e.action).slice(0, 3)).toEqual(['delete_run', 'unban', 'ban']);
    onBoards(null);
  });
});

// ------------------------------------------------------------------ Plan 011 §1.5/§1.6: Glyphen + Pad-Navigation

import { glyphFamily, padCodeGlyph, promptGlyphs } from '../src/ui/padGlyphs';
import { pickInDirection, refocusIndex } from '../src/ui/padNav';
import { FRONT_DOOR_PROMPTS } from '../src/ui/menuLab/types';
import type { FrontDoorGlyphFamily } from '../src/ui/menuLab/types';
import { PAD_BUTTONS, PAD_PRESETS } from '../src/engine/pad/types';

describe('Glyphen (Plan 011 §1.6)', () => {
  const families: readonly FrontDoorGlyphFamily[] = ['keyboard', 'xbox', 'playstation'];
  const src = { demoKey: 'H', padBinds: PAD_PRESETS.bumper };

  it('jeder Hinweis × Gerät hat Symbole (Tastatur: Reiter bewusst ohne Taste)', () => {
    for (const fam of families) {
      for (const p of FRONT_DOOR_PROMPTS) {
        const g = promptGlyphs(p, fam, src);
        const noKey = fam === 'keyboard' && (p === 'tabs' || p === 'tabPrev' || p === 'tabNext');
        if (noKey) expect(g, `${fam}/${p}`).toEqual([]);
        else expect(g.length, `${fam}/${p}`).toBeGreaterThan(0);
        if (p === 'tabs' && fam !== 'keyboard') expect(g.length).toBe(2);
        for (const x of g) {
          expect(x.family).toBe(fam);
          expect(x.text.length, `${fam}/${p}`).toBeGreaterThan(0);
          expect(x.name.length, `${fam}/${p}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('PlayStation bestätigt mit Kreuz, zurück mit Kreis (westlich); Xbox mit A/B', () => {
    expect(promptGlyphs('confirm', 'playstation', src)[0]).toMatchObject({ kind: 'face', symbol: 'cross' });
    expect(promptGlyphs('back', 'playstation', src)[0]).toMatchObject({ kind: 'face', symbol: 'circle' });
    expect(promptGlyphs('confirm', 'xbox', src)[0]).toMatchObject({ kind: 'face', text: 'A', symbol: null });
    expect(promptGlyphs('back', 'xbox', src)[0]).toMatchObject({ text: 'B' });
    expect(promptGlyphs('tabs', 'playstation', src).map((x) => x.text)).toEqual(['L1', 'R1']);
  });

  it('Spiel-Aktionen folgen der Pad-Belegung, Tastatur der Vorführungs-Taste', () => {
    expect(promptGlyphs('demo', 'keyboard', { demoKey: 'G', padBinds: null })[0].text).toBe('G');
    const binds = { ...PAD_PRESETS.bumper, respawn: ['PadLT' as const] };
    expect(promptGlyphs('respawn', 'xbox', { demoKey: 'H', padBinds: binds })[0]).toMatchObject({ text: 'LT', kind: 'trigger' });
    expect(promptGlyphs('restart', 'xbox', { demoKey: 'H', padBinds: { ...binds, restart: [] } })).toEqual([]);
  });

  it('jeder Pad-Knopf hat je Familie eine Glyphe, Formen nur bei PlayStation-Gesichtstasten', () => {
    for (const fam of ['xbox', 'playstation'] as const) {
      for (const c of PAD_BUTTONS) {
        const g = padCodeGlyph(c, fam);
        expect(g.text.length, `${fam}/${c}`).toBeGreaterThan(0);
        expect(g.symbol !== null, `${fam}/${c}`).toBe(fam === 'playstation' && g.kind === 'face');
      }
    }
  });

  it('Familie: Tastatur bleibt Tastatur, Einstellung schlägt Erkennung, unbekanntes Pad = Xbox', () => {
    expect(glyphFamily('keyboard', 'playstation')).toBe('keyboard');
    expect(glyphFamily('xbox', 'playstation')).toBe('playstation');
    expect(glyphFamily('playstation', 'auto')).toBe('playstation');
    expect(glyphFamily('generic', 'auto')).toBe('xbox');
  });
});

describe('Pad-Navigation: Richtungswahl (Plan 011 §1.5)', () => {
  const r = (x: number, y: number, w = 100, h = 40) => ({ x, y, w, h });

  it('nimmt in einer Spalte den direkten Nachbarn, nicht den nächsten Mittelpunkt schräg', () => {
    const from = r(0, 0);
    const cands = [r(0, 60), r(110, 10), r(0, 120)];
    expect(pickInDirection(from, cands, 0, 1)).toBe(0);
    expect(pickInDirection(from, cands, 1, 0)).toBe(1);
    expect(pickInDirection(from, cands, 0, -1)).toBe(-1);
  });

  it('ein breiter Knopf darüber ist nicht "rechts" (fallen.md #242)', () => {
    const from = r(0, 100);
    const wide = r(-50, 0, 600, 40);
    expect(pickInDirection(from, [wide], 1, 0)).toBe(-1);
    expect(pickInDirection(from, [wide], 0, -1)).toBe(0);
  });

  it('angehobener Nachbar (Versatz < ¼) zählt als seitlich, nicht als oben', () => {
    const from = r(0, 0);
    const lifted = r(120, -8);
    expect(pickInDirection(from, [lifted], 0, -1)).toBe(-1);
    expect(pickInDirection(from, [lifted], 1, 0)).toBe(0);
  });

  it('bevorzugt überlappende Spannen vor näheren, aber versetzten Kandidaten', () => {
    const from = r(0, 0);
    const aligned = r(0, 200);
    const offset = r(300, 50);
    expect(pickInDirection(from, [offset, aligned], 0, 1)).toBe(1);
  });
});

describe('Pad-Navigation: Fokus nach Teil-Neuaufbau (Review B3)', () => {
  it('gleiche Signatur wird wiedergefunden (auch verschoben), am nächsten zur alten Position', () => {
    expect(refocusIndex(['a', 'b', 'c'], 'b', 1)).toEqual({ index: 1, lost: false });
    // Zeile davor kam hinzu: "b" rutscht auf 2 — derselbe Knopf, kein Verlust.
    expect(refocusIndex(['x', 'a', 'b', 'c'], 'b', 1)).toEqual({ index: 2, lost: false });
    // Zweimal dieselbe Signatur (zwei "Ghost"-Knöpfe): der nähere gewinnt.
    expect(refocusIndex(['g', 'n', 'g', 'n'], 'g', 3)).toEqual({ index: 2, lost: false });
  });

  it('ersetztes Element (Online-Zeile, anderer Text): Rückfall auf den nächstliegenden Index statt null, als Verlust markiert', () => {
    // Vorher: kein Treffer → Fokus null → das nächste A klickte blind das Startelement (Primärknopf).
    expect(refocusIndex(['prim', 'neu', 'menu'], 'login', 1)).toEqual({ index: 1, lost: true });
    // Letztes Element verschwunden → geklemmt auf das neue letzte.
    expect(refocusIndex(['a', 'b'], 'c', 2)).toEqual({ index: 1, lost: true });
    expect(refocusIndex(['a', 'b'], 'c', -1)).toEqual({ index: 0, lost: true });
  });

  it('nichts bedienbar oder nie fokussiert → -1 (dann gilt das Startelement, kein Verlust)', () => {
    expect(refocusIndex([], 'a', 0)).toEqual({ index: -1, lost: false });
    expect(refocusIndex(['a', 'b'], '', -1)).toEqual({ index: -1, lost: false });
  });
});
