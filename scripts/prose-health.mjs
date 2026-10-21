#!/usr/bin/env node
/**
 * Prose health: a ratchet over the shape and register of the repo's hand-written prose.
 *
 * Vale polices mechanics one sentence at a time, and the exemplars carry the
 * voice. Neither can see the thing that goes wrong across a whole file: prose
 * that is individually correct and collectively compressed, where every noun
 * has been packed into a modifier and every clause into a phrase. That shows up
 * only as a corpus statistic, which is what this measures.
 *
 * Nothing here is a target. The baseline records what each file scores today,
 * and the check fails only when a file moves the wrong way beyond a tolerance,
 * exactly like `checkride.baseline.json` freezes existing findings. Comparing a
 * file against its own past is what keeps the measure genre-neutral: a table of
 * exports is allowed to score a tenth of what an essay scores, forever, as long
 * as it does not get worse.
 *
 * Writing to the number is the failure mode this file is most likely to cause.
 * A density is raised honestly by rewriting a compressed sentence into a finite
 * clause, and dishonestly by inserting the word the metric counts. The second
 * moves the number and makes the prose worse, so read `.claude/skills/prose/`
 * before acting on anything printed here.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, '.prose-health.json');
const REPORT_PATH = join(REPO_ROOT, '.check', 'prose-health.json');

/**
 * The corpus: hand-written prose whose shape is worth holding a line on.
 *
 * CHANGELOG.md is excluded deliberately. It is 170-odd release-note sections
 * whose register is set by the format rather than by the author, and its bulk
 * would swamp every corpus-level number.
 */
const TOP_LEVEL = ['README.md', 'AGENTS.md', 'VALUES.md', 'CONTRIBUTING.md', 'SECURITY.md'];

/** A file smaller than this is too noisy to ratchet; it is measured and reported only. */
const MIN_RATCHET_WORDS = 200;

/**
 * The metrics that gate, and which direction counts as decay.
 *
 * `down` metrics fall when prose is compressed or de-registered: relative
 * clauses collapse into modifiers, contractions revert, the reader stops being
 * addressed. `up` metrics rise when punctuation starts doing a clause's job.
 *
 * `first_person` and the sentence-length averages are measured but absent here.
 * First person is legitimately zero in reference material, and mean length
 * moves for good reasons in both directions, so gating either would punish
 * correct writing.
 */
const RATCHETED = {
  that_per_1k: 'down',
  relativizers_per_1k: 'down',
  contractions_per_1k: 'down',
  second_person_per_1k: 'down',
  prose_colons_per_1k: 'up',
  semicolons_per_1k: 'up',
  sentences_over_55: 'up',
};

/** Tolerance before a move counts as decay: the larger of a share of baseline and a floor. */
const TOLERANCE_SHARE = 0.08;
const TOLERANCE_FLOOR = { density: 1.0, count: 1 };

/**
 * Strip everything that is not prose, and mark the hard boundaries between what remains.
 *
 * Fenced code, HTML comments, table rows, inline code spans, link targets, and
 * bare URLs are all removed, because counting them measures the sample rather
 * than the writing. The NUL (`\u0000`) markers left behind are hard sentence
 * boundaries: without them a lead-in, a fenced example, and the paragraph after
 * it read as one sentence, and every length statistic inflates.
 */
function extract_prose(text) {
  const kept = [];
  let in_fence = false;
  let in_comment = false;

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      in_fence = !in_fence;
      kept.push('\u0000');
      continue;
    }
    if (in_fence) continue;

    if (/<!--/.test(line)) in_comment = true;
    if (in_comment) {
      if (/-->/.test(line)) in_comment = false;
      continue;
    }

    // A table row, a heading, a list marker, and a blank line each end a sentence.
    if (/^\s*\|/.test(line) || /^\s*#{1,6}\s/.test(line) || /^\s*$/.test(line)) {
      kept.push('\u0000');
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line)) kept.push('\u0000');

    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/`[^`]*`/gs, ' ') // a hard-wrapped span can straddle two lines
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1 ') // keep link text, drop the target
    .replace(/^\s*\[[^\]]*\]:.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

const ABBREVIATIONS = /(?:e\.g|i\.e|etc|al|vs|Dr|Mr|Mrs|Ms|St|No|Fig|Ch|approx|cf)\.$/i;

/**
 * Split prose into sentences, treating the block markers as unconditional breaks.
 *
 * A period only ends a sentence when it is followed by whitespace and something
 * that can open one. Guarding the house-style `e.g.,` and `i.e.,`, decimals, and
 * version numbers stops a single `v0.12.0` from reading as three sentences.
 */
function split_sentences(prose) {
  const sentences = [];
  for (const block of prose.split('\u0000')) {
    const text = block.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    let current = '';
    for (const token of text.split(' ')) {
      current = current ? `${current} ${token}` : token;
      const ends = /[.!?]["')\]]?$/.test(token);
      if (!ends) continue;
      if (ABBREVIATIONS.test(token)) continue;
      if (/\d\.$/.test(token)) continue; // "v0.12.0." and list-ish numerals
      sentences.push(current);
      current = '';
    }
    if (current.trim()) sentences.push(current.trim());
  }
  return sentences;
}

const COUNTERS = {
  that_per_1k: /\bthat\b/gi,
  relativizers_per_1k: /\b(?:that|which|who|whose|whom)\b/gi,
  contractions_per_1k: /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi,
  second_person_per_1k: /\b(?:you|your|yours|yourself)\b/gi,
  first_person_per_1k: /\b(?:I|my|me|mine|myself|we|our|ours|us)\b/g,
};

/**
 * Count colons that separate clauses, not colons that introduce a sample.
 *
 * A colon ending a line is almost always a lead-in to a fence or a list, which
 * is a formatting decision rather than a register one. Only mid-sentence colons
 * say anything about how the prose is punctuated.
 */
function count_prose_colons(prose) {
  let n = 0;
  for (const line of prose.split('\n')) {
    const body = line.trimEnd();
    if (!body || body.endsWith(':')) continue;
    n += (body.match(/:/g) || []).length;
  }
  return n;
}

/** Every measurement for one file, densities per 1k prose words. */
function measure(text) {
  const prose = extract_prose(text);
  const words = prose.split(/\s+/).filter(Boolean).length;
  const sentences = split_sentences(prose);
  const lengths = sentences.map((s) => s.split(' ').filter(Boolean).length).sort((a, b) => a - b);

  const per_1k = (n) => (words ? Number(((n * 1000) / words).toFixed(2)) : 0);
  const metrics = { words, sentences: sentences.length };

  for (const [name, pattern] of Object.entries(COUNTERS)) {
    metrics[name] = per_1k((prose.match(pattern) || []).length);
  }
  metrics.prose_colons_per_1k = per_1k(count_prose_colons(prose));
  metrics.semicolons_per_1k = per_1k((prose.match(/;/g) || []).length);
  metrics.sentences_over_55 = lengths.filter((n) => n > 55).length;
  metrics.mean_sentence_words = lengths.length
    ? Number((lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1))
    : 0;
  metrics.p90_sentence_words = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;

  // How much of the page is sample rather than sentences. These are reported,
  // never gated, and they exist so a low density can be read for what it is:
  // a table of exports has no relative clause to hold, and comparing it to an
  // essay is a category error. Deliberately two numbers rather than one genre
  // label, because the obvious single ratio does not separate the cases. A doc
  // can be fence-heavy and still be an essay (worked examples inside an
  // argument), while a table-heavy doc rarely is.
  Object.assign(metrics, structural_shares(text));

  return metrics;
}

/** The share of a file's non-blank lines that is fenced code, and the share that is table rows. */
function structural_shares(text) {
  let in_fence = false;
  let fence = 0;
  let table = 0;
  let total = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      in_fence = !in_fence;
      fence += 1;
      total += 1;
      continue;
    }
    if (!line) continue;
    total += 1;
    if (in_fence) fence += 1;
    else if (line.startsWith('|')) table += 1;
  }

  return {
    code_share: total ? Number((fence / total).toFixed(2)) : 0,
    table_share: total ? Number((table / total).toFixed(2)) : 0,
  };
}

/**
 * Every file in the corpus, repo-relative, in a stable order. The walk
 * through docs/ takes in its subfolders, so the course in docs/learn is held
 * to its own past like every other doc.
 */
function corpus_files() {
  const docs = readdirSync(join(REPO_ROOT, 'docs'), { recursive: true })
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `docs/${f}`);
  const top = TOP_LEVEL.filter((f) => existsSync(join(REPO_ROOT, f)));
  return [...docs, ...top];
}

/** Measure every file in the corpus. */
function measure_corpus() {
  const out = {};
  for (const file of corpus_files()) {
    out[file] = measure(readFileSync(join(REPO_ROOT, file), 'utf8'));
  }
  return out;
}

/** The tolerance for one metric: a share of the baseline, never below the floor. */
function tolerance_for(name, baseline_value) {
  const floor = name === 'sentences_over_55' ? TOLERANCE_FLOOR.count : TOLERANCE_FLOOR.density;
  return Math.max(Math.abs(baseline_value) * TOLERANCE_SHARE, floor);
}

/** Every metric on every file that decayed past its tolerance since the baseline. */
function find_regressions(current, baseline) {
  const regressions = [];
  for (const [file, now] of Object.entries(current)) {
    const was = baseline.files?.[file];
    if (!was) continue;
    if (now.words < MIN_RATCHET_WORDS) continue;

    for (const [name, direction] of Object.entries(RATCHETED)) {
      const before = was[name];
      const after = now[name];
      if (typeof before !== 'number' || typeof after !== 'number') continue;

      const delta = after - before;
      const tolerance = tolerance_for(name, before);
      const decayed = direction === 'down' ? delta < -tolerance : delta > tolerance;
      if (decayed) regressions.push({ file, metric: name, before, after, delta: Number(delta.toFixed(2)) });
    }
  }
  return regressions;
}

/**
 * Name the likely cause of one file's regressions, from the shape of the set.
 *
 * `that` and `relativizers` move together when clauses genuinely collapsed into
 * modifiers, because the second counts the first. When only `that` falls they
 * have not collapsed, something was merely respelled as `which`, and there is
 * probably nothing to fix. Reading the pair is what separates the two, and it
 * is the reason both are ratcheted despite the redundancy.
 */
function read_the_pattern(items) {
  const moved = new Set(items.map((r) => r.metric));
  if (moved.has('that_per_1k') && !moved.has('relativizers_per_1k')) {
    return '↳ relative clauses held; `that` was respelled (`which`/`who`). Probably fine.';
  }
  if (moved.has('that_per_1k') && moved.has('relativizers_per_1k')) {
    return '↳ relative clauses collapsed into modifiers. Look for participles and noun stacks.';
  }
  if (moved.has('prose_colons_per_1k') || moved.has('semicolons_per_1k')) {
    return '↳ punctuation took a clause\'s job. Look for a colon or semicolon splicing two claims.';
  }
  if (moved.has('sentences_over_55')) {
    return '↳ a sentence grew past 55 words. Check whether it is carrying more than one claim.';
  }
  return '↳ register drifted. Compare against the exemplars before changing anything.';
}

/** Corpus-level totals, recomputed from the per-file numbers weighted by length. */
function corpus_summary(current) {
  const words = Object.values(current).reduce((a, m) => a + m.words, 0);
  const weighted = (name) =>
    words
      ? Number(
          (Object.values(current).reduce((a, m) => a + m[name] * m.words, 0) / words).toFixed(2),
        )
      : 0;
  return {
    files: Object.keys(current).length,
    words,
    that_per_1k: weighted('that_per_1k'),
    relativizers_per_1k: weighted('relativizers_per_1k'),
    contractions_per_1k: weighted('contractions_per_1k'),
    second_person_per_1k: weighted('second_person_per_1k'),
    prose_colons_per_1k: weighted('prose_colons_per_1k'),
    semicolons_per_1k: weighted('semicolons_per_1k'),
    sentences_over_55: Object.values(current).reduce((a, m) => a + m.sentences_over_55, 0),
  };
}

const NAME_WIDTH = 40;

/** Print the per-file table, least dense first, with each file's structural shares beside it. */
function print_table(current, baseline) {
  const rows = Object.entries(current).sort((a, b) => a[1].that_per_1k - b[1].that_per_1k);

  console.log('');
  console.log(
    `${'file'.padEnd(NAME_WIDTH)}${'that'.padStart(7)}${'rel'.padStart(7)}${'contr'.padStart(7)}${'you'.padStart(7)}${'>55w'.padStart(6)}${'code'.padStart(7)}${'tbl'.padStart(6)}${'  vs baseline'}`,
  );
  console.log('-'.repeat(100));

  for (const [file, m] of rows) {
    const was = baseline.files?.[file];
    let mark = '  new';
    if (was && typeof was.that_per_1k === 'number') {
      const d = m.that_per_1k - was.that_per_1k;
      mark = Math.abs(d) < 0.005 ? '  =' : `  ${d > 0 ? '+' : ''}${d.toFixed(2)}`;
    }
    const name = file.length > NAME_WIDTH - 1 ? `…${file.slice(-(NAME_WIDTH - 2))}` : file;
    console.log(
      `${name.padEnd(NAME_WIDTH)}${m.that_per_1k.toFixed(2).padStart(7)}${m.relativizers_per_1k.toFixed(2).padStart(7)}${m.contractions_per_1k.toFixed(2).padStart(7)}${m.second_person_per_1k.toFixed(2).padStart(7)}${String(m.sentences_over_55).padStart(6)}${m.code_share.toFixed(2).padStart(7)}${m.table_share.toFixed(2).padStart(6)}${mark}`,
    );
  }

  const s = corpus_summary(current);
  console.log('-'.repeat(100));
  console.log(
    `${'corpus'.padEnd(NAME_WIDTH)}${s.that_per_1k.toFixed(2).padStart(7)}${s.relativizers_per_1k.toFixed(2).padStart(7)}${s.contractions_per_1k.toFixed(2).padStart(7)}${s.second_person_per_1k.toFixed(2).padStart(7)}${String(s.sentences_over_55).padStart(6)}`,
  );
  console.log(`${s.files} files, ${s.words} prose words`);
  console.log('');
  console.log('`code` and `tbl` are the share of non-blank lines that is fenced code and table');
  console.log('rows. A low density next to a high `tbl` is a table of exports doing its job,');
  console.log('not a defect. Nothing in this table is a target; only movement against the');
  console.log('baseline is a signal.');
}

/** Measure the voice exemplars the same way, as the reference point the docs are read against. */
function measure_exemplars() {
  const dir = join(REPO_ROOT, '.vale/exemplars');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const measured = {};
  for (const f of files) measured[f] = measure(readFileSync(join(dir, f), 'utf8'));
  return corpus_summary(measured);
}

/** Print one file's sentences, longest first, as a reading aid rather than a verdict. */
function print_file_detail(file) {
  const path = join(REPO_ROOT, file);
  if (!existsSync(path)) {
    console.error(`prose-health: no such file: ${file}`);
    process.exit(2);
  }
  const text = readFileSync(path, 'utf8');
  const m = measure(text);
  console.log(`\n${relative(REPO_ROOT, path)}  (${m.words} prose words)\n`);
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(24)} ${v}`);

  const long = split_sentences(extract_prose(text))
    .map((s) => ({ s, n: s.split(' ').filter(Boolean).length }))
    .filter((x) => x.n > 40)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);

  if (long.length) {
    console.log('\n  Longest sentences. Length alone is not a defect; read each one and ask');
    console.log('  whether it is carrying more than one claim.\n');
    for (const { s, n } of long) console.log(`  ${String(n).padStart(3)}w  ${s.slice(0, 150)}${s.length > 150 ? '…' : ''}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const report_only = args.includes('--report');
  const update = args.includes('--update');
  const file_flag = args.indexOf('--file');

  if (file_flag !== -1) {
    print_file_detail(args[file_flag + 1] ?? '');
    return;
  }

  const current = measure_corpus();
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    : { files: {} };

  if (update) {
    const written = {
      note: 'Written by scripts/prose-health.mjs --update. Re-baselining is a deliberate act: do it in its own commit and say why. See .claude/skills/prose/SKILL.md.',
      exemplars: measure_exemplars(),
      corpus: corpus_summary(current),
      files: current,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(written, null, 2)}\n`);
    print_table(current, { files: current });
    console.log(`\nprose-health: baseline written to ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  const regressions = find_regressions(current, baseline);

  mkdirSync(join(REPO_ROOT, '.check'), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({ ok: regressions.length === 0, corpus: corpus_summary(current), exemplars: measure_exemplars(), regressions, files: current }, null, 2)}\n`,
  );

  if (report_only) {
    print_table(current, baseline);
    const ex = measure_exemplars();
    if (ex) console.log(`exemplars (voice reference): that ${ex.that_per_1k} / 1k, contractions ${ex.contractions_per_1k} / 1k`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('prose-health: no baseline found. Record one with:');
    console.error('  node scripts/prose-health.mjs --update');
    process.exit(1);
  }

  if (regressions.length === 0) {
    const s = corpus_summary(current);
    console.log(`prose-health: ${s.files} files hold their baseline (that ${s.that_per_1k} / 1k over ${s.words} words)`);
    return;
  }

  const by_file = new Map();
  for (const r of regressions) {
    if (!by_file.has(r.file)) by_file.set(r.file, []);
    by_file.get(r.file).push(r);
  }

  console.error(`prose-health: ${by_file.size} file(s) decayed against .prose-health.json\n`);
  for (const [file, items] of by_file) {
    console.error(`  ${file}`);
    for (const r of items) {
      const dir = RATCHETED[r.metric] === 'down' ? 'fell' : 'rose';
      console.error(
        `    ${r.metric.padEnd(22)} ${dir} ${r.before} → ${r.after}  (${r.delta > 0 ? '+' : ''}${r.delta})`,
      );
    }
    console.error(`    ${read_the_pattern(items)}`);
    console.error('');
  }

  console.error('These are shape measurements, not rules, and the fix is always a rewrite.');
  console.error('Read the file, find the sentences that lost a finite verb, and give it back:');
  console.error(`  node scripts/prose-health.mjs --file ${[...by_file.keys()][0]}`);
  console.error('');
  console.error('Do NOT insert the counted word to move the number. Inserting `that` into an');
  console.error('object relative raises the score and makes the prose worse, which is the one');
  console.error('outcome this check exists to prevent. See .claude/skills/prose/SKILL.md.');
  console.error('');
  console.error('If the change is deliberate (a doc genuinely became reference material),');
  console.error('re-baseline in its own commit, with the reason, via:');
  console.error('  node scripts/prose-health.mjs --update');
  process.exit(1);
}

main();
