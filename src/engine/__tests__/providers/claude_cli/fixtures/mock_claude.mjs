#!/usr/bin/env node
/**
 * Mock claude CLI binary for engine tests.
 *
 * Configuration via environment variables (the adapter's build_env passes
 * whatever ClaudeCliCallOptions.env supplies; tests thread these through):
 *
 *   MOCK_CLAUDE_SCRIPT          path to a JSON file describing ordered ops
 *   MOCK_CLAUDE_RESUME_SCRIPT   optional script used when argv contains --resume
 *   MOCK_CLAUDE_RECORD          path where argv + env is written at startup
 *   MOCK_CLAUDE_RECORD_RESUME   optional record path used on --resume invocations
 *   MOCK_CLAUDE_IGNORE_SIGTERM  "1" installs a no-op SIGTERM handler
 *
 * Supported ops (each object in the script array):
 *   { "op": "line",   "data": <any> }      JSON.stringify(data) + "\n" -> stdout
 *   { "op": "raw",    "text": "..." }      raw text -> stdout (no newline)
 *   { "op": "stderr", "text": "..." }      raw text -> stderr
 *   { "op": "delay",  "ms": 100 }          setTimeout
 *   { "op": "exit",   "code": 0 }          exit with code (default 0)
 *   { "op": "hang" }                       wait forever (used for abort tests)
 */

import { writeFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const is_resume = argv.includes('--resume');
const resume_script_path = process.env.MOCK_CLAUDE_RESUME_SCRIPT;
const resume_record_path = process.env.MOCK_CLAUDE_RECORD_RESUME;
const script_path =
  is_resume && typeof resume_script_path === 'string' && resume_script_path.length > 0
    ? resume_script_path
    : process.env.MOCK_CLAUDE_SCRIPT;
const record_path =
  is_resume && typeof resume_record_path === 'string' && resume_record_path.length > 0
    ? resume_record_path
    : process.env.MOCK_CLAUDE_RECORD;
const ignore_sigterm = process.env.MOCK_CLAUDE_IGNORE_SIGTERM === '1';

if (ignore_sigterm) {
  process.on('SIGTERM', () => {});
}

process.stdin.on('data', () => {});
process.stdin.on('error', () => {});

if (record_path !== undefined && record_path.length > 0) {
  const snapshot = {
    argv,
    env: { ...process.env },
    cwd: process.cwd(),
    pid: process.pid,
  };
  writeFileSync(record_path, JSON.stringify(snapshot));
}

function emit_default_success() {
  process.stdout.write(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'mock-session',
      model: 'mock-model',
    }) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'mock-session',
      duration_ms: 1,
      total_cost_usd: 0,
      is_error: false,
      usage: { input_tokens: 0, output_tokens: 0 },
      result: '',
    }) + '\n',
  );
}

if (script_path === undefined || script_path.length === 0) {
  emit_default_success();
  process.exit(0);
}

const ops = JSON.parse(readFileSync(script_path, 'utf8'));

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function run_ops() {
  for (const op of ops) {
    if (op.op === 'line') {
      process.stdout.write(JSON.stringify(op.data) + '\n');
    } else if (op.op === 'raw') {
      process.stdout.write(op.text);
    } else if (op.op === 'stderr') {
      process.stderr.write(op.text);
    } else if (op.op === 'delay') {
      await sleep(op.ms);
    } else if (op.op === 'exit') {
      process.exit(op.code ?? 0);
    } else if (op.op === 'hang') {
      // A bare unresolved Promise does not keep the Node event loop alive;
      // we need an active handle (timer) to truly block until signalled.
      await new Promise(() => {
        setInterval(() => {}, 60_000);
      });
    }
  }
  process.exit(0);
}

run_ops().catch((err) => {
  process.stderr.write(`mock_claude error: ${String(err)}\n`);
  process.exit(99);
});
