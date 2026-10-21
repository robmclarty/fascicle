#!/usr/bin/env node
/**
 * Walk the course in docs/learn the way a learner would, against this build.
 *
 * A lesson holds everything a learner types: the files they write, the
 * commands they run, and what each command prints. The walk builds a
 * workbench from lesson 0, writes each lesson's files in order (with the
 * in-place edits that lessons 5, 8, 9, and 13 ask for), runs the commands,
 * and holds what they print to the lesson's text. Then it compiles and runs
 * the fragments that a lesson shows inside a larger file, each in the
 * context its lesson implies, and the agent primer's sketches.
 *
 * The workbench links this repository's dist as `fascicle` and borrows zod,
 * tsx, typescript, vitest, and @types/node from its node_modules, so it runs
 * offline against whatever `pnpm build` last produced. Every command gets a
 * bare environment, so no key in the caller's shell can take a lesson live,
 * and no CI variable can stop vitest writing a lesson's first snapshot.
 *
 * A block is addressed by its index in its lesson, and each address names
 * what it expects to find there, a file and its path or a piece of output,
 * so a block added to or taken out of a lesson stops the walk with the
 * lesson and the index to update here, not with a puzzling diff.
 *
 * Exit codes:
 *   0  every check passed
 *   1  a check failed
 *   2  the walk could not run: no build, or a block is not where it should be
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEARN_DIR = join(REPO_ROOT, 'docs', 'learn');
const MODULES = join(REPO_ROOT, 'node_modules');
const DIST = join(REPO_ROOT, 'dist');

// What lesson 0 installs, plus vitest from lesson 10, borrowed from this
// repository instead of downloaded.
const PACKAGES = ['zod', 'tsx', 'typescript', 'vitest', '@types/node'];

// The command that each bin a lesson calls runs, by bin name.
const BINS = {
  tsx: join(MODULES, 'tsx', 'dist', 'cli.mjs'),
  tsc: join(MODULES, 'typescript', 'bin', 'tsc'),
  vitest: join(MODULES, 'vitest', 'vitest.mjs'),
  'fascicle-diagram': join(DIST, 'bin', 'fascicle-diagram.js'),
};

const TSX = './node_modules/.bin/tsx';
const TSC = './node_modules/.bin/tsc --noEmit -p .';
const VITEST = './node_modules/.bin/vitest run';
const DIAGRAM = './node_modules/.bin/fascicle-diagram';

// Lesson 6's stub run, which later lessons repeat to show the answer holds.
const SEVEN = ['06', 5];

// Room for a cold tsc over the whole workbench. Nothing in a lesson waits on
// the network.
const COMMAND_TIMEOUT_MS = 120_000;

/** Every fenced block in the course, by lesson: `00` through `13`, and `primer`. */
function read_lessons() {
  const lessons = new Map();
  const names = readdirSync(LEARN_DIR)
    .filter((name) => /^\d\d-.+\.md$/.test(name))
    .sort();
  for (const name of [...names, 'agent-primer.md']) {
    const key = name === 'agent-primer.md' ? 'primer' : name.slice(0, 2);
    lessons.set(key, { name, blocks: read_blocks(readFileSync(join(LEARN_DIR, name), 'utf8')) });
  }
  return lessons;
}

/** One lesson's fenced blocks, each with its language and, for a TypeScript file, its path. */
function read_blocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^```(\w+)\s*$/.exec(lines[i]);
    if (fence === null) continue;
    const body = [];
    for (i += 1; i < lines.length && lines[i] !== '```'; i += 1) body.push(lines[i]);
    const header = fence[1] === 'ts' ? /^\/\/ ([\w./-]+\.ts)$/.exec(body[0] ?? '') : null;
    blocks.push({ lang: fence[1], path: header?.[1] ?? null, code: `${body.join('\n')}\n` });
  }
  return blocks;
}

/** Text compared the way a reader compares it: trailing spaces and outer blank lines don't count. */
function norm(text) {
  return text
    .trim()
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

/** What a block was expected to be, for the message when it isn't. */
function expected_block(lang, path) {
  if (path !== null) return `the ${lang} file ${path}`;
  return lang === 'ts' ? 'a ts fragment with no file header' : `a ${lang} block`;
}

/** What a block turned out to be, for the same message. */
function found_block(found) {
  if (found === undefined) return 'missing';
  return found.path === null ? `a ${found.lang} block` : `the ${found.lang} file ${found.path}`;
}

/**
 * The workbench and everything a lesson does in it: read a block, write or
 * edit a file, run a command, and record a check. A block that isn't what
 * its address expects throws, which ends the walk.
 */
function open_workbench(lessons, dir) {
  const results = [];

  const block = (lesson, index, lang, path = null) => {
    const entry = lessons.get(lesson);
    const found = entry?.blocks[index];
    if (found !== undefined && found.lang === lang && found.path === path) return found.code;
    throw new Error(
      `docs/learn/${entry?.name ?? lesson}: block ${index} should be ${expected_block(lang, path)}, but it is ${found_block(found)}. A block was added or removed above it, so update the index in scripts/check-learn.mjs`,
    );
  };

  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };

  const sh = (command, env = {}) => {
    const done = spawnSync('sh', ['-c', command], {
      cwd: dir,
      env: { ...bare_env(), ...env },
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    return { code: done.status ?? 1, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
  };

  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    process.stderr.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`);
    if (!ok && detail !== '') process.stderr.write(`${detail}\n`);
  };

  return {
    results,
    block,
    text: (lesson, index) => block(lesson, index, 'text'),
    fragment: (lesson, index) => block(lesson, index, 'ts'),
    file: (lesson, index, path) => block(lesson, index, 'ts', path),
    apply: (lesson, index, path) => write(path, block(lesson, index, 'ts', path)),
    write,
    append: (rel, content) => appendFileSync(join(dir, rel), content),
    read: (rel) => readFileSync(join(dir, rel), 'utf8'),
    edit: (rel, before, after) => {
      const text = readFileSync(join(dir, rel), 'utf8');
      if (text.split(before).length !== 2) {
        throw new Error(`${rel} should hold ${JSON.stringify(before)} once for the walk to edit it, so the lesson that writes it has changed`);
      }
      writeFileSync(join(dir, rel), text.replace(before, after));
    },
    sh,
    check,

    /** Run a command and hold what it prints, all of it or a part, and its exit code, to the lesson. */
    expect: (label, command, expected, { contains = false, code = 0, stream = 'stdout', env = {} } = {}) => {
      const ran = sh(command, env);
      const got = norm(stream === 'stdout' ? ran.stdout : ran.stderr);
      const ok = ran.code === code && (contains ? got.includes(norm(expected)) : got === norm(expected));
      check(
        label,
        ok,
        `  exit ${ran.code} (expected ${code})\n  --- expected ---\n${expected}\n  --- stdout ---\n${ran.stdout}\n  --- stderr ---\n${ran.stderr.slice(-2000)}`,
      );
    },

    /** Type-check the workbench, expecting it clean, or failing with the errors that a lesson shows. */
    tsc: (label, { fails = false, contains = null } = {}) => {
      const ran = sh(TSC);
      const ok = (fails ? ran.code !== 0 : ran.code === 0) && (contains === null || norm(ran.stdout).includes(norm(contains)));
      check(label, ok, `${ran.stdout.slice(-3000)}${ran.stderr.slice(-1000)}`);
    },
  };
}

/**
 * The environment that every lesson command runs with: enough to find node
 * and a home directory, and nothing else, so no provider key or CI flag in
 * the caller's shell reaches a lesson.
 */
function bare_env() {
  const env = { NO_COLOR: '1' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Fill the workbench's node_modules the way lessons 0 and 10 would, from
 * this repository: `fascicle` is its package.json beside a link to its dist,
 * each tool links to the copy installed here, and each bin a lesson calls is
 * a shim that runs that copy's script.
 */
function link_toolchain(dir) {
  const modules = join(dir, 'node_modules');
  mkdirSync(join(modules, 'fascicle'), { recursive: true });
  mkdirSync(join(modules, '@types'), { recursive: true });
  mkdirSync(join(modules, '.bin'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'package.json'), join(modules, 'fascicle', 'package.json'));
  symlinkSync(DIST, join(modules, 'fascicle', 'dist'));
  for (const name of PACKAGES) symlinkSync(join(MODULES, name), join(modules, name));
  for (const [name, script] of Object.entries(BINS)) {
    const shim = join(modules, '.bin', name);
    writeFileSync(shim, `#!/bin/sh\nexec node "${script}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
}

/** True when the run wrote a trajectory that opens with the flow's structure, as lessons 7 and 12 say. */
function trajectory_written(wb) {
  const ran = wb.sh('head -c 40 .trajectory.jsonl');
  return ran.stdout.startsWith('{"kind":"flow_structure"');
}

/** Lessons 0 through 4: steps, composers, and the spine, with no model in sight. */
function walk_basics(wb) {
  wb.write('package.json', '{ "name": "workbench", "private": true, "type": "module" }\n');
  wb.write('tsconfig.json', wb.block('00', 3, 'json'));
  wb.write('.gitignore', wb.text('00', 4));
  wb.sh('git init -q && git config user.email learner@example.com && git config user.name Learner');
  wb.apply('00', 6, 'hello.ts');
  wb.expect('L0 hello', `${TSX} hello.ts`, wb.text('00', 8));
  wb.tsc('L0 tsc');

  wb.apply('01', 1, '01-add.ts');
  wb.expect('L1 add', `${TSX} 01-add.ts`, wb.text('01', 3));

  wb.apply('02', 0, '02-sequence.ts');
  wb.expect('L2 sequence', `${TSX} 02-sequence.ts`, wb.text('02', 2));
  wb.tsc('L2 tsc');

  // Lesson 3's file grows as the lesson goes, one composer at a time.
  const shapes = [wb.file('03', 0, '03-shapes.ts'), wb.fragment('03', 3), wb.fragment('03', 6), wb.fragment('03', 8)];
  wb.write('03-shapes.ts', shapes.join('\n'));
  wb.expect('L3 shapes', `${TSX} 03-shapes.ts`, [2, 4, 7, 9].map((index) => norm(wb.text('03', index))).join('\n'));
  wb.tsc('L3 tsc');

  wb.apply('04', 1, '04-chain.ts');
  wb.expect('L4 chain', `${TSX} 04-chain.ts`, wb.text('04', 3));
}

/** Lessons 5 and 6: fake leaves, then model leaves on a stub, then the engine module. */
function walk_models(wb) {
  wb.apply('05', 1, 'solver/calc.ts');
  wb.apply('05', 2, 'solver/flow.ts');
  wb.apply('05', 3, 'solver/main.ts');
  wb.expect('L5 fake model', `${TSX} solver/main.ts`, wb.text('05', 5));
  wb.tsc('L5 tsc (fake)');
  wb.apply('05', 6, 'solver/flow.ts');
  wb.apply('05', 7, 'solver/stub.ts');
  wb.apply('05', 8, 'solver/main.ts');
  wb.expect('L5 stub model', `${TSX} solver/main.ts`, wb.text('05', 10));
  wb.tsc('L5 tsc (stub)');
  wb.edit('solver/stub.ts', "content: { a: 3, b: 4, op: 'add' }", "content: { a: 'three', b: 4, op: 'add' }");
  wb.expect('L5 broken contract', `${TSX} solver/main.ts`, wb.text('05', 11), { contains: true, code: 1, stream: 'stderr' });
  wb.edit('solver/stub.ts', "content: { a: 'three', b: 4, op: 'add' }", "content: { a: 3, b: 4, op: 'add' }");

  wb.apply('06', 2, 'engine.ts');
  wb.apply('06', 3, 'solver/main.ts');
  wb.expect('L6 stub default', `${TSX} solver/main.ts`, wb.text(...SEVEN));
  wb.expect('L6 missing key', `${TSX} solver/main.ts`, 'OPENROUTER_API_KEY is not set: add it to .env, or export it in your shell', {
    contains: true,
    code: 1,
    stream: 'stderr',
    env: { FASCICLE_PROVIDER: 'openrouter' },
  });
  wb.expect('L6 typo provider', `${TSX} solver/main.ts`, 'unknown FASCICLE_PROVIDER "open-router"', {
    contains: true,
    code: 1,
    stream: 'stderr',
    env: { FASCICLE_PROVIDER: 'open-router' },
  });
  wb.tsc('L6 tsc');
}

/** Lessons 7 and 8: the diagram, the trajectory, and what a failure tells you. */
function walk_watching(wb) {
  wb.apply('07', 0, 'solver/flow.ts');
  wb.apply('07', 1, 'solver/diagram.ts');
  wb.expect('L7 diagram', `${DIAGRAM} solver/diagram.ts`, wb.text('07', 3));
  wb.expect('L7 diagram prefix', `${DIAGRAM} solver/diagram.ts --prefix ' * '`, wb.text('07', 5));
  wb.apply('07', 6, 'solver/main.ts');
  wb.sh('rm -f .trajectory.jsonl');
  wb.expect('L7 run with trajectory', `${TSX} solver/main.ts`, wb.text(...SEVEN));
  wb.check('L7 trajectory written', trajectory_written(wb));
  wb.tsc('L7 tsc');

  const DIVIDE = "content: { a: 5, b: 0, op: 'divide' }";
  const ADD = "content: { a: 3, b: 4, op: 'add' }";
  const COOKIES = `${TSX} solver/main.ts "Share 5 cookies among 0 friends."`;
  wb.apply('08', 1, 'solver/main.ts');
  wb.edit('solver/stub.ts', ADD, DIVIDE);
  wb.expect('L8 error path (lesson 7 flow)', COOKIES, wb.text('08', 2), { code: 1, stream: 'stderr' });
  wb.edit('solver/stub.ts', DIVIDE, ADD);
  wb.apply('08', 5, 'solver/guess.ts');
  wb.apply('08', 6, 'solver/flow.ts');
  wb.expect('L8 hardened diagram', `${DIAGRAM} solver/diagram.ts`, wb.text('08', 8));
  wb.expect('L8 stub still answers', `${TSX} solver/main.ts`, wb.text(...SEVEN));
  wb.expect('L8 refusal', `${TSX} solver/main.ts "What is the capital of France?"`, 'I can only solve word problems that have numbers in them.');
  wb.edit('solver/stub.ts', ADD, DIVIDE);
  wb.expect('L8 error path (hardened)', COOKIES, 'failed at branch_1 > chain_1 > answer', { contains: true, code: 1, stream: 'stderr' });
  wb.edit('solver/stub.ts', DIVIDE, ADD);
  wb.apply('08', 9, 'solver/flaky.ts');
  wb.expect('L8 flaky absorbed', `${TSX} solver/flaky.ts`, wb.text(...SEVEN));
  wb.tsc('L8 tsc');
}

/** Lessons 9 and 10: five styles that agree, then tests on a stub. */
function walk_styles_and_tests(wb) {
  wb.edit('solver/flow.ts', 'const EXTRACT = `solver/extract', 'export const EXTRACT = `solver/extract');
  wb.edit('solver/flow.ts', 'const EXPLAIN = `solver/explain', 'export const EXPLAIN = `solver/explain');
  wb.apply('09', 0, 'styles/leaves.ts');
  wb.apply('09', 1, 'styles/pipeline.ts');
  wb.apply('09', 3, 'styles/chain.ts');
  wb.apply('09', 4, 'styles/direct.ts');
  wb.apply('09', 6, 'styles/class.ts');
  wb.apply('09', 10, 'styles/compare.ts');
  wb.expect('L9 five styles agree', `${TSX} styles/compare.ts`, wb.text('09', 12));
  wb.tsc('L9 tsc');

  wb.apply('10', 1, 'solver/solver.test.ts');
  const first = wb.sh(`${VITEST} 2>&1`);
  wb.check(
    'L10 vitest (6 pass, snapshot written)',
    first.code === 0 && first.stdout.includes('Tests  6 passed (6)') && first.stdout.includes('Snapshots  1 written'),
    first.stdout.slice(-3000),
  );
  const shown = wb.fragment('10', 4).split('toMatchInlineSnapshot(`')[1]?.split('`)')[0] ?? '';
  wb.check('L10 snapshot matches lesson text', shown !== '' && norm(wb.read('solver/solver.test.ts')).includes(norm(shown)));
  wb.tsc('L10 tsc');
}

/** Lessons 11 and 12: the commit tool and the morning digest. */
function walk_tools(wb) {
  wb.apply('11', 1, 'commit/git.ts');
  wb.apply('11', 2, 'commit/message.ts');
  wb.apply('11', 3, 'commit/flow.ts');
  wb.apply('11', 4, 'commit/stub.ts');
  wb.apply('11', 5, 'commit/main.ts');
  wb.apply('11', 6, 'commit/diagram.ts');
  wb.tsc('L11 tsc');
  wb.expect('L11 diagram', `${DIAGRAM} commit/diagram.ts`, wb.text('11', 8));
  wb.sh('git add solver');
  wb.expect('L11 stub message', `${TSX} commit/main.ts`, wb.text('11', 10));
  wb.sh('git reset -q');
  wb.expect('L11 nothing staged', `${TSX} commit/main.ts`, 'nothing is staged: run `git add`', { contains: true, code: 1, stream: 'stderr' });

  wb.apply('12', 1, 'digest/flow.ts');
  wb.apply('12', 2, 'digest/stub.ts');
  wb.apply('12', 3, 'digest/main.ts');
  wb.apply('12', 4, 'digest/diagram.ts');
  wb.tsc('L12 tsc');
  wb.expect('L12 diagram', `${DIAGRAM} digest/diagram.ts`, wb.text('12', 5));
  wb.sh('rm -f .trajectory.jsonl');
  wb.expect('L12 digest on the stub', `${TSX} digest/main.ts`, wb.text('12', 7));
  wb.check('L12 digest trajectory written', trajectory_written(wb));
}

/** Lesson 13: the blueprint layout, the type errors it causes, and the snapshot that notices. */
function walk_blueprint(wb) {
  wb.write('solver/prompts/extract.md', wb.block('13', 0, 'markdown'));
  wb.write('solver/prompts/explain.md', wb.block('13', 1, 'markdown'));
  wb.apply('13', 2, 'solver/prompts/load.ts');
  wb.apply('13', 3, 'solver/stages/extract.ts');
  wb.apply('13', 4, 'solver/stages/explain.ts');
  wb.apply('13', 5, 'solver/messages.ts');
  wb.append('solver/calc.ts', `\n${wb.fragment('13', 6)}`);
  wb.apply('13', 7, 'solver/flow.ts');
  wb.tsc('L13 tsc breaks styles', { fails: true, contains: wb.text('13', 9) });
  wb.apply('13', 10, 'styles/leaves.ts');
  wb.tsc('L13 tsc clean again');
  wb.expect('L13 solver still answers', `${TSX} solver/main.ts`, wb.text(...SEVEN));
  wb.expect('L13 styles still agree', `${TSX} styles/compare.ts`, wb.text('09', 12));
  // The flow file's header comment is the diagram, pasted in with --prefix.
  const header = wb.file('13', 7, 'solver/flow.ts').split('\n').slice(4, 17).join('\n');
  wb.expect('L13 header diagram matches flow', `${DIAGRAM} solver/diagram.ts --prefix ' * '`, header);
  const changed = wb.sh(`${VITEST} 2>&1`);
  wb.check('L13 snapshot catches the change', changed.code !== 0 && changed.stdout.includes('Tests  1 failed | 5 passed (6)'), changed.stdout.slice(-3000));
  const accepted = wb.sh(`${VITEST} -u 2>&1`);
  wb.check('L13 snapshot accepted', accepted.code === 0 && accepted.stdout.includes('Tests  6 passed (6)'), accepted.stdout.slice(-3000));
}

/**
 * The fragments a learner pastes into a file they already have, each given
 * the context its lesson implies, and the agent primer's sketches. They all
 * compile together, each one runs, and where its lesson shows the output, it
 * prints that.
 */
function walk_fragments(wb) {
  const PAIR = 'type Pair = { a: number; b: number }\n';
  const ADD = "const add = step('add', ({ a, b }: Pair) => a + b)\n";
  const fragments = {
    l1_meta: `import { step } from 'fascicle'\n${PAIR}${wb.fragment('01', 6)}console.log(add.meta)\n`,
    l1_slow: `import { run, step } from 'fascicle'\n${PAIR}${wb.fragment('01', 7)}`,
    l1_wrap: `import { step } from 'fascicle'\n${PAIR}${wb.fragment('01', 8)}export { add }\n`,
    l1_pass: `import { step } from 'fascicle'\n${PAIR}${wb.fragment('01', 9)}export { add }\n`,
    l2_described: `import { describe, sequence, step } from 'fascicle'\n${PAIR}${wb.fragment('02', 4)}console.log(describe.diagram(flow))\n`,
    l2_nested: `import { describe, run, sequence, step } from 'fascicle'\n${PAIR}${wb.fragment('02', 4).split('\nconst flow')[0]}\n${wb.fragment('02', 8)}`,
    l2_pipe: wb.fragment('02', 11).replace("import { pipe } from 'fascicle'\n", `import { pipe, run, step } from 'fascicle'\n${PAIR}${ADD}`),
    l3_maybe: `import { branch, run, step } from 'fascicle'\n${PAIR}${wb.fragment('03', 5)}console.log(await run(maybe_divide, { a: 6, b: 0 }), await run(maybe_divide, { a: 6, b: 3 }))\n`,
    l3_by_hand: `import { describe, step } from 'fascicle'\n${PAIR}${wb.fragment('03', 10)}console.log(describe.diagram(report_all_by_hand))\n`,
    l4_by_hand: `import { run, sequence, step } from 'fascicle'\n${PAIR}${wb.fragment('04', 0)}console.log(await run(by_hand, { a: 2, b: 3 }))\n`,
    l4_direct: `import { describe, run, step } from 'fascicle'\n${PAIR}${ADD}${wb.fragment('04', 5)}console.log(describe.diagram(report_direct))\nconsole.log(await run(report_direct, { a: 2, b: 3 }))\n`,
    l8_wrappers:
      "import { retry, timeout } from 'fascicle'\nimport { make_solver_stub } from '../solver/stub.js'\n" +
      "import { make_extract_step } from '../solver/stages/extract.js'\nconst extract = make_extract_step(make_solver_stub(), 'stub')\n" +
      `export const a = ${wb.fragment('08', 3)}export const b = ${wb.fragment('08', 4)}`,
    l9_hardened: `import { retry, timeout } from 'fascicle'\nimport type { Step } from 'fascicle'\n${wb.fragment('09', 2)}export { hardened }\n`,
    l9_addstep: `import { describe, run, sequence, step } from 'fascicle'\n${wb.fragment('09', 8)}console.log(describe.diagram(add_then_double))\n`,
  };
  for (const [name, code] of Object.entries(fragments)) wb.write(`fragments/${name}.ts`, code);
  wb.write(
    'commit/adversarial_probe.ts',
    "import { adversarial, model_step, run, sequence, step } from 'fascicle'\n" +
      "import type { AdversarialBuildInput, Step } from 'fascicle'\n" +
      "import { commit_schema, format_request, problems_with, render_message } from './message.js'\n" +
      "import type { CommitMessage } from './message.js'\n" +
      "import { make_commit_stub } from './stub.js'\n" +
      'const engine = make_commit_stub()\n' +
      "const write: Step<string, CommitMessage> = model_step({ engine, model: 'stub', system: 'commit/write\\nx', schema: commit_schema, id: 'write' })\n" +
      wb.fragment('11', 13) +
      "console.log(await run(draft, 'diff --git a/x b/x', { install_signal_handlers: false }))\n",
  );
  wb.write('solver/guess.test.ts', `import { expect, it } from 'vitest'\n${wb.fragment('10', 5)}`);
  wb.write('primer/calc.ts', wb.read('solver/calc.ts'));
  wb.write('primer/engine.ts', wb.file('primer', 2, 'engine.ts'));
  wb.write('primer/calc_flow.ts', wb.file('primer', 3, 'calc_flow.ts'));
  wb.write('primer/calc_flow.test.ts', wb.file('primer', 4, 'calc_flow.test.ts'));

  wb.tsc('fragments compile in their lessons');
  // Where a lesson shows what its fragment prints, the fragment has to print it.
  const shown = {
    l2_described: wb.text('02', 5),
    l2_nested: wb.text('02', 9),
    l2_pipe: wb.text('02', 12),
    l3_by_hand: wb.text('03', 11),
    l4_direct: wb.text('04', 6),
    l9_addstep: wb.text('09', 9),
  };
  for (const name of ['l1_meta', 'l1_slow', 'l2_described', 'l2_nested', 'l2_pipe', 'l3_maybe', 'l3_by_hand', 'l4_by_hand', 'l4_direct', 'l9_addstep']) {
    wb.expect(`fragment ${name} runs`, `${TSX} fragments/${name}.ts`, shown[name] ?? '', { contains: true });
  }
  wb.expect('L11 adversarial alternative', `${TSX} commit/adversarial_probe.ts`, wb.text('11', 10));
  const tests = wb.sh(`${VITEST} solver/guess.test.ts primer 2>&1`);
  wb.check('L10 guess test and primer test pass', tests.code === 0 && tests.stdout.includes('Tests  3 passed (3)'), tests.stdout.slice(-3000));
  wb.expect('primer engine module', `${TSX} -e "import('./primer/engine.js').then((m) => console.log(Object.keys(m).join()))"`, 'engine_from_env');
}

function main() {
  if (!existsSync(join(DIST, 'index.js')) || !existsSync(BINS['fascicle-diagram'])) {
    console.error('check-learn: dist/ has no build to walk the course against: run `pnpm build` first');
    process.exit(2);
  }
  const lessons = read_lessons();
  const dir = mkdtempSync(join(tmpdir(), 'fascicle-learn-'));
  const wb = open_workbench(lessons, dir);
  try {
    link_toolchain(dir);
    walk_basics(wb);
    walk_models(wb);
    walk_watching(wb);
    walk_styles_and_tests(wb);
    walk_tools(wb);
    walk_blueprint(wb);
    walk_fragments(wb);
  } catch (err) {
    console.error(`\ncheck-learn: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`the workbench is kept at ${dir}`);
    process.exit(2);
  }

  const failed = wb.results.filter((result) => !result.ok);
  console.error(`\ncheck-learn: ${wb.results.length - failed.length}/${wb.results.length} passed`);
  if (failed.length > 0) {
    console.error(`the workbench is kept at ${dir}`);
    process.exit(1);
  }
  rmSync(dir, { recursive: true, force: true });
}

main();
