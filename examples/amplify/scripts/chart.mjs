#!/usr/bin/env node
// Render an amplify run's trajectory as a self-contained SVG.
//
// Usage: chart.mjs [run_dir]   (defaults to the most recent .runs/<id>)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, '..');
const RUNS_DIR = join(PKG_DIR, '.runs');

function find_latest_run() {
  const entries = readdirSync(RUNS_DIR)
    .map((name) => ({ name, mtime: statSync(join(RUNS_DIR, name)).mtimeMs }))
    .toSorted((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) throw new Error(`no runs found in ${RUNS_DIR}`);
  return join(RUNS_DIR, entries[0].name);
}

const arg = process.argv[2];
const run_dir = arg ? resolve(arg) : find_latest_run();
const jsonl = join(run_dir, 'trajectory.jsonl');
const events = readFileSync(jsonl, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const baseline = events.find((e) => e.kind === 'amplify.baseline');
const done = events.find((e) => e.kind === 'amplify.done');
const candidates = events.filter((e) => e.kind === 'amplify.candidate');
const rounds = events.filter((e) => e.kind === 'amplify.round');

if (!baseline || !done) throw new Error('trajectory missing baseline/done events');

// Parent line: stair-step starting at baseline, dropping only on accepted rounds.
const parent_pts = [{ x: 0, y: baseline.score }];
let parent = baseline.score;
for (const r of rounds) {
  if (r.accepted) parent = r.winner_value;
  parent_pts.push({ x: r.round, y: parent });
}

// Layout
const W = 920;
const H = 540;
const M = { top: 96, right: 40, bottom: 64, left: 72 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

const all_y = [
  baseline.score,
  ...candidates.filter((c) => c.accepted).map((c) => c.value),
  ...parent_pts.map((p) => p.y),
];
const y_min = 0;
const y_max = Math.ceil(Math.max(...all_y) * 1.12);
const x_max = Math.max(rounds.length, 1);

const sx = (x) => M.left + (x / x_max) * PW;
const sy = (y) => M.top + (1 - (y - y_min) / (y_max - y_min)) * PH;

function nice_ticks(min, max, n) {
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}
const y_ticks = nice_ticks(y_min, y_max, 6);

const COLOR = {
  bg: '#fafafa',
  axis: '#888',
  grid: '#e8e8e8',
  text: '#222',
  text_dim: '#666',
  parent: '#0a7d4f',
  parent_dark: '#063e27',
  candidate: '#bbb',
  candidate_stroke: '#666',
  fail: '#c33',
  baseline: '#444',
  panel: '#fff',
  panel_stroke: '#ddd',
};

const svg = [];
svg.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, system-ui, sans-serif">`,
);
svg.push(`<rect width="100%" height="100%" fill="${COLOR.bg}"/>`);

const run_id = run_dir.split('/').pop();
const improvement = done.improvement_pct.toFixed(1);
svg.push(
  `<text x="${M.left}" y="34" font-size="20" font-weight="600" fill="${COLOR.text}">amplify run ${run_id}</text>`,
);
svg.push(
  `<text x="${M.left}" y="58" font-size="14" fill="${COLOR.text_dim}">metric: speed (lower is better) — <tspan fill="${COLOR.parent}" font-weight="600">${improvement}% faster</tspan> (${baseline.score.toFixed(2)}ms → ${done.final_score.toFixed(2)}ms)</text>`,
);

for (const t of y_ticks) {
  const y = sy(t);
  svg.push(
    `<line x1="${M.left}" y1="${y}" x2="${M.left + PW}" y2="${y}" stroke="${COLOR.grid}"/>`,
  );
  svg.push(
    `<text x="${M.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="${COLOR.text_dim}">${t.toFixed(0)}ms</text>`,
  );
}

for (let r = 0; r <= x_max; r++) {
  const x = sx(r);
  const label = r === 0 ? 'baseline' : `r${r}`;
  svg.push(
    `<line x1="${x}" y1="${M.top + PH}" x2="${x}" y2="${M.top + PH + 4}" stroke="${COLOR.axis}"/>`,
  );
  svg.push(
    `<text x="${x}" y="${M.top + PH + 20}" text-anchor="middle" font-size="11" fill="${COLOR.text}">${label}</text>`,
  );
  if (r >= 1) {
    const round = rounds[r - 1];
    if (round) {
      const note = round.accepted ? 'ACCEPT' : 'reject';
      const color = round.accepted ? COLOR.parent : COLOR.text_dim;
      svg.push(
        `<text x="${x}" y="${M.top + PH + 36}" text-anchor="middle" font-size="10" fill="${color}" font-weight="${round.accepted ? '600' : '400'}">${note}</text>`,
      );
    }
  }
}

svg.push(
  `<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + PH}" stroke="${COLOR.axis}"/>`,
);
svg.push(
  `<line x1="${M.left}" y1="${M.top + PH}" x2="${M.left + PW}" y2="${M.top + PH}" stroke="${COLOR.axis}"/>`,
);

// Failed candidates: stack short × labels along the top of each round column.
const fail_counts = {};
for (const c of candidates) {
  if (c.accepted) continue;
  const idx = (fail_counts[c.round] = (fail_counts[c.round] ?? 0) + 1);
  const x = sx(c.round);
  const y = M.top + 14 + (idx - 1) * 14;
  svg.push(
    `<text x="${x}" y="${y}" text-anchor="middle" font-size="11" fill="${COLOR.fail}">× ${c.stage_failed}</text>`,
  );
}

// Accepted-but-not-winner candidates as soft dots in the round column.
for (const c of candidates) {
  if (!c.accepted) continue;
  const x = sx(c.round);
  const y = sy(c.value);
  svg.push(
    `<circle cx="${x}" cy="${y}" r="5" fill="${COLOR.candidate}" stroke="${COLOR.candidate_stroke}" stroke-width="0.5" opacity="0.85"/>`,
  );
}

// Parent stair-step line.
let path = '';
for (let i = 0; i < parent_pts.length; i++) {
  const p = parent_pts[i];
  path += `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)} `;
}
svg.push(
  `<path d="${path.trim()}" fill="none" stroke="${COLOR.parent}" stroke-width="2.5" stroke-linejoin="round"/>`,
);

// Round-winner emphasis on the parent line.
for (const r of rounds) {
  const x = sx(r.round);
  const y = sy(r.winner_value);
  const fill = r.accepted ? COLOR.parent : COLOR.candidate;
  const stroke = r.accepted ? COLOR.parent_dark : COLOR.candidate_stroke;
  svg.push(
    `<circle cx="${x}" cy="${y}" r="6" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
  );
}

// Baseline marker.
const bx = sx(0);
const by = sy(baseline.score);
svg.push(`<circle cx="${bx}" cy="${by}" r="6" fill="${COLOR.baseline}" stroke="#000"/>`);
svg.push(
  `<text x="${bx + 10}" y="${by + 4}" font-size="12" fill="${COLOR.text}">baseline ${baseline.score.toFixed(2)}ms</text>`,
);

// Final marker.
const fx = sx(rounds.length);
const fy = sy(done.final_score);
svg.push(
  `<text x="${fx - 10}" y="${fy - 10}" text-anchor="end" font-size="12" fill="${COLOR.parent}" font-weight="600">final ${done.final_score.toFixed(2)}ms</text>`,
);

// Legend.
const lx = M.left + PW - 240;
const ly = M.top + 6;
svg.push(`<g transform="translate(${lx}, ${ly})">`);
svg.push(
  `<rect x="0" y="0" width="240" height="86" fill="${COLOR.panel}" stroke="${COLOR.panel_stroke}" rx="4"/>`,
);
svg.push(`<line x1="12" y1="22" x2="46" y2="22" stroke="${COLOR.parent}" stroke-width="2.5"/>`);
svg.push(`<circle cx="29" cy="22" r="5" fill="${COLOR.parent}"/>`);
svg.push(`<text x="56" y="26" font-size="12" fill="${COLOR.text}">parent (best so far)</text>`);
svg.push(
  `<circle cx="29" cy="46" r="5" fill="${COLOR.candidate}" stroke="${COLOR.candidate_stroke}"/>`,
);
svg.push(`<text x="56" y="50" font-size="12" fill="${COLOR.text}">candidate (passed gate)</text>`);
svg.push(`<text x="12" y="74" font-size="12" fill="${COLOR.fail}">× failed (syntax / gate)</text>`);
svg.push(`</g>`);

// Y-axis title.
svg.push(
  `<text x="22" y="${M.top + PH / 2}" font-size="12" fill="${COLOR.text_dim}" transform="rotate(-90 22 ${M.top + PH / 2})" text-anchor="middle">median wall-clock (ms)</text>`,
);

svg.push('</svg>');

const out_path = join(run_dir, 'improvement.svg');
writeFileSync(out_path, svg.join('\n'), 'utf8');
console.log(out_path);
