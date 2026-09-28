#!/usr/bin/env node
/**
 * SessionStart-Hook: fasst bei jedem Claude-Code-Start den Projektstatus zusammen.
 * Läuft ohne Netzwerk und ohne Abhängigkeiten — reines Dateisystem plus git.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
};
const recent = (dir, n = 5) => {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, t: statSync(join(full, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, n)
    .map((x) => x.f);
};
const planStatus = (f) => {
  const m = readFileSync(join(root, '.docs/plans', f), 'utf8').match(/\*\*Status:\*\*\s*([^\n]+)/);
  return m ? m[1].trim() : '?';
};

const out = ['# VELOCITY — Projektstatus'];
const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch) out.push(`Branch: ${branch} · letzter Commit: ${sh('git log -1 --format=%s') || '—'}`);
const dirty = sh('git status --porcelain');
if (dirty) out.push(`Uncommittete Änderungen: ${dirty.split('\n').length} Dateien`);
out.push('', 'Pläne (neueste zuerst):');
for (const f of recent('.docs/plans')) out.push(`- ${f} — ${planStatus(f)}`);
const levels = existsSync(join(root, 'public/levels')) ? readdirSync(join(root, 'public/levels')).filter((f) => f.endsWith('.json')) : [];
out.push('', `Level: ${levels.join(', ') || '—'}`);
out.push('', 'Einstieg: AGENTS.md · Regeln: .docs/rules/ · Fallen: .docs/learnings/fallen.md');
console.log(out.join('\n'));
