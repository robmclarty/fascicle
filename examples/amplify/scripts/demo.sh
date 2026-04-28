#!/usr/bin/env bash
# Demo helper for amplify: measure -> run -> measure -> reset.
#
# The starter file (target/src/log_aggregator.ts) is the only in-tree
# state the loop mutates, and it is checked in. So `git restore` is the
# clean reset. Per-run artifacts live under .runs/ (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
TARGET_FILE="$PKG_DIR/target/src/log_aggregator.ts"
TARGET_REL="target/src/log_aggregator.ts"
FIXTURE="$PKG_DIR/target/fixtures/sample.log"
RUNS_DIR="$PKG_DIR/.runs"

ensure_fixture() {
  if [ ! -f "$FIXTURE" ]; then
    echo "fixture missing; generating..."
    (cd "$PKG_DIR" && pnpm gen-fixture)
  fi
}

cmd_measure() {
  ensure_fixture
  local runs="${BENCH_RUNS:-10}"
  echo "benching $TARGET_REL (BENCH_RUNS=$runs)..."
  IMPL_PATH="$TARGET_FILE" BENCH_RUNS="$runs" \
    pnpm exec tsx "$PKG_DIR/target/bench.ts"
}

cmd_run() {
  (cd "$PKG_DIR" && pnpm amplify "$@")
}

cmd_result() {
  if [ ! -d "$RUNS_DIR" ]; then
    echo "no runs found ($RUNS_DIR does not exist)" >&2
    return 1
  fi
  local latest
  latest="$(ls -t "$RUNS_DIR" 2>/dev/null | head -n 1 || true)"
  if [ -z "$latest" ]; then
    echo "no runs found in $RUNS_DIR" >&2
    return 1
  fi
  local jsonl="$RUNS_DIR/$latest/trajectory.jsonl"
  echo "run: $latest"
  echo "file: $jsonl"
  TRAJECTORY="$jsonl" node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const path = process.env.TRAJECTORY;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const baseline = events.find((e) => e.kind === 'amplify.baseline');
    const done = events.find((e) => e.kind === 'amplify.done');
    const rounds = events.filter((e) => e.kind === 'amplify.round');
    const accepted = rounds.filter((r) => r.accepted);
    const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));
    console.log('baseline   :', fmt(baseline?.score));
    console.log('final      :', fmt(done?.final_score));
    console.log('improvement:', done?.improvement_pct?.toFixed(2) + '%');
    console.log('rounds     :', rounds.length, '(' + accepted.length + ' accepted)');
    for (const r of rounds) {
      const tag = r.accepted ? 'ACCEPT' : 'reject';
      console.log('  r' + r.round, tag, 'winner=' + r.winner_id, 'value=' + fmt(r.winner_value), 'parent=' + fmt(r.parent_score));
    }
  "
}

cmd_chart() {
  node "$HERE/chart.mjs" "$@"
}

cmd_status() {
  cd "$PKG_DIR"
  if git diff --quiet -- "$TARGET_REL"; then
    echo "starter: clean (matches HEAD) — ready for a fresh run"
  else
    echo "starter: MODIFIED (a prior run committed a winner)"
    git diff --stat -- "$TARGET_REL"
  fi
}

cmd_reset() {
  cd "$PKG_DIR"
  echo "restoring $TARGET_REL from git..."
  git restore -- "$TARGET_REL"
  if [ "${1:-}" = "--purge-runs" ]; then
    echo "purging $RUNS_DIR..."
    rm -rf "$RUNS_DIR"
  fi
  cmd_status
}

cmd_help() {
  cat <<EOF
demo helper for amplify

  pnpm demo measure        bench the current starter (median ms over BENCH_RUNS, default 10)
  pnpm demo run [...args]  run amplify (extra args forwarded, e.g. --rounds 3)
  pnpm demo result         summarize the most recent run's trajectory
  pnpm demo chart [dir]    render an SVG chart of a run (default: latest)
  pnpm demo status         is the starter clean or post-run?
  pnpm demo reset          git restore the starter (add --purge-runs to also wipe .runs/)

typical demo flow:
  pnpm demo status         # confirm clean start
  pnpm demo measure        # baseline ms
  pnpm demo run            # the loop (5 rounds x 3 candidates by default)
  pnpm demo measure        # post-run ms (smaller is better)
  pnpm demo result         # baseline -> final, per-round accept/reject
  pnpm demo reset          # back to a clean starter for the next viewer
EOF
}

case "${1:-help}" in
  measure) shift; cmd_measure "$@" ;;
  run)     shift; cmd_run "$@" ;;
  result)  shift; cmd_result "$@" ;;
  chart)   shift; cmd_chart "$@" ;;
  status)  shift; cmd_status "$@" ;;
  reset)   shift; cmd_reset "$@" ;;
  help|-h|--help) cmd_help ;;
  *) echo "unknown subcommand: $1" >&2; cmd_help; exit 2 ;;
esac
