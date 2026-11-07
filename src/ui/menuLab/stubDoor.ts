import type { FrontDoor, FrontDoorAction, FrontDoorContext, FrontDoorStyleId } from './types';

/**
 * Platzhalter-Front-Door ("<STIL> — im Bau"): beweist, dass der Vertrag end-to-end trägt (Start mit Pointer Lock,
 * alle Screens, Labor). Die Stil-Agenten ersetzen sie durch ihre echte Umsetzung (und importieren das hier nicht mehr).
 */
export function createStubDoor(id: FrontDoorStyleId, label: string): FrontDoor {
  let root: HTMLElement | null = null;
  let ctx: FrontDoorContext | null = null;
  let raf = 0;
  let pulse: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let status: HTMLElement | null = null;

  const btn = (text: string, onClick: () => void, lock = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vel-btn';
    b.textContent = text;
    // Synchron im Klick: play() fängt die Maus nur innerhalb der Geste.
    b.addEventListener('click', onClick);
    if (lock) ctx?.markLockButton(b);
    return b;
  };

  const renderList = (): void => {
    const c = ctx;
    if (!c || !list) return;
    list.replaceChildren();
    if (c.loading) list.append('Level werden geladen …');
    for (const lv of c.levels) {
      const medal = lv.medal ? ` · ${lv.medal.toUpperCase()}` : '';
      const b = btn(`${lv.num} ${lv.name}  ${lv.bestText}${medal}`, () => c.play(lv.id), true);
      b.classList.add('vel-stub-level');
      if (lv.index === c.selected) b.classList.add('is-selected');
      list.append(b);
    }
    if (status) {
      status.textContent = c.lock.error ?? `${c.version} · Training ${c.training.countText} · Kosmetik ${c.cosmetics.unlocked}/${c.cosmetics.total}`;
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    const c = ctx;
    if (!c || c.levels.length === 0) return;
    if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
    e.preventDefault();
    const n = c.levels.length;
    const i = (c.selected + (e.code === 'ArrowDown' ? 1 : n - 1)) % n;
    c.select(i);
    // select() löst kein update aus — Schnappschuss lokal nachziehen.
    ctx = { ...c, selected: i };
    renderList();
  };

  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    if (!ctx || !pulse || ctx.reducedMotion) return;
    pulse.style.opacity = String(0.3 + 0.7 * ctx.beat().kick);
  };

  const el = (tag: keyof HTMLElementTagNameMap, cls: string, text = ''): HTMLElement => {
    const e = document.createElement(tag);
    e.className = cls;
    e.textContent = text;
    return e;
  };

  return {
    mount(r, c) {
      root = r;
      ctx = c;
      const box = el('div', 'vel-stub');
      box.dataset.style = id;
      pulse = el('div', 'vel-stub-pulse');
      list = el('div', 'vel-stub-list');
      status = el('p', 'vel-hint vel-stub-status');
      const row = el('div', 'vel-row vel-stub-actions');
      row.append(
        btn('Start', () => ctx?.playSelected(), true),
        btn('Training', () => ctx?.openTraining()),
        btn('Bestenliste', () => ctx?.openLeaderboard()),
        btn('Kosmetik', () => ctx?.openCosmetics()),
        btn('Einstellungen', () => ctx?.openSettings()),
        btn('Steuerung', () => ctx?.openControls()),
        btn('Profil', () => ctx?.openProfile()),
        btn('Menü-Labor', () => ctx?.openLab()),
      );
      // Admin nur, wo er etwas tut (Vertrag: adminMenu false → Eintrag weglassen).
      if (c.adminMenu) row.append(btn('Admin', () => ctx?.openAdmin()));
      box.append(el('h1', 'vel-h1', `${label} — im Bau`), pulse, list, row, status);
      r.append(box);
      renderList();
      window.addEventListener('keydown', onKey);
      raf = requestAnimationFrame(frame);
    },
    update(c) {
      ctx = c;
      renderList();
    },
    unmount() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      root?.replaceChildren();
      root = null;
      ctx = null;
    },
    onAction(a: FrontDoorAction) {
      if (a === 'confirm') ctx?.playSelected();
    },
  };
}
