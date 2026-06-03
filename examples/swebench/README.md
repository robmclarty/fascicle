# SWE-bench smoke harness

A 5-instance smoke harness against SWE-bench Verified. Exercises the sandbox
and judge seams so the full 500-instance benchmark is a scale change, not a
shape change.

## What it does

1. Loads 5 vendored instances from `src/instances.ts` (real `instance_id`s
   pulled from the SWE-bench Verified set).
2. Per instance: builds a per-case `Sandbox`, hands the model a tool surface
   (`read_file`, `write_file`, `run_command`, `list_files`, `grep_files`),
   lets it iterate up to 30 steps, then captures `git diff` against the base
   commit.
3. Writes predictions to `predictions.jsonl` in the exact shape SWE-bench
   eval consumes.
4. Optionally shells out to `sb-cli` to score resolution rate.

## Layers

| Layer              | File                | Role                                                  |
| ------------------ | ------------------- | ----------------------------------------------------- |
| Instance fixtures  | `src/instances.ts`  | 5 vendored cases; swap for HF loader at scale.        |
| Types              | `src/types.ts`      | Wire shapes (`SweBenchInstance`, `Prediction`, etc.). |
| Sandbox seam       | `src/sandbox.ts`    | `Sandbox` interface + `local`/`docker`/`noop` impls.  |
| Tools              | `src/tools.ts`      | Per-case tools closing over the sandbox.              |
| Prompt             | `src/prompt.ts`     | Initial prompt and system message.                    |
| Solve flow         | `src/flow.ts`       | The `Step<SweBenchInstance, Prediction>` itself.      |
| Judges + eval      | `src/judge.ts`      | Cheap in-bench judges + `sb-cli` shellout.            |
| Driver             | `src/main.ts`       | CLI entry. Writes predictions/report/trajectories.    |

## Sandboxes

The harness ships three sandbox factories. Pick with `SWEBENCH_SANDBOX`:

- **`noop`** (default): tools return empty stubs. Lets you smoke-test the
  flow wiring without git or Docker. Resolution rate will be 0.
- **`local`**: shallow-clones the repo at `base_commit` into a tmpdir on the
  host and runs tools against host filesystem. Cheap to iterate on but no
  isolation; assumes the repo's runtime is already installed.
- **`docker`**: stub. Wire up `dockerode` (or `spawn('docker', ...)`) against
  the prebuilt `swebench/sweb.eval.x86_64.<instance_id>` images. This is the
  shape required for real eval; see TODO in `sandbox.ts`.

## Judges

Two layers, kept separate on purpose.

**In-bench (cheap, every run):**

- `patch_nonempty`: did the agent emit any diff at all?
- `patch_shape`: does the output look like a unified diff?

These tell you "the agent is producing output of the right shape." They do
**not** tell you the patch is correct. Use them as the inner-loop signal
during prompt/flow iteration.

**Out-of-band (expensive, decision point):**

- `evaluate_with_sb_cli` writes predictions and invokes `sb-cli submit
  swe-bench-verified <run_id>`. Parses the returned report and computes
  resolution rate. This is the number that compares against the public
  leaderboard.

Enable with `SWEBENCH_RUN_EVAL=1`. Requires `sb-cli` on PATH and a
configured account (`pip install sb-cli && sb-cli configure`).

## Providers

Pick one via `SWEBENCH_PROVIDER`:

- **`claude_cli`** (default): OAuth via the locally logged-in `claude`
  binary. No API key, billed against your Claude account. Each case spins
  up a fresh per-instance engine with `default_cwd` pointed at the sandbox
  workdir, so the CLI's built-in Read/Write/Edit/Bash tools operate inside
  the sandbox. Our Sandbox-bound tools are skipped because `execute`
  closures can't cross the subprocess boundary anyway. Override the model
  with `SWEBENCH_MODEL=opus` (default `sonnet`) and the effort
  with `SWEBENCH_EFFORT=high` (default `medium`).
- **`anthropic`**: requires `ANTHROPIC_API_KEY`. One shared engine; the
  flow injects our Sandbox-bound tools on every model call. Override the
  model with `SWEBENCH_MODEL=opus-4-7` (default `sonnet`).

## Prereqs

- For `claude_cli`: `claude` on PATH and authenticated (`claude login`).
- For `anthropic`: `ANTHROPIC_API_KEY` in your environment.
- For `SWEBENCH_SANDBOX=local`: `git` on PATH and network access for clone.
- For real eval: `sb-cli` installed and configured (or the local
  `swebench.harness.run_evaluation` Python harness with Docker).

## Run

```bash
# Cheapest smoke — flow wiring only, no actual repo clones.
pnpm --filter @repo/example-swebench swebench

# Real attempts against host filesystem (still no Docker).
SWEBENCH_SANDBOX=local pnpm --filter @repo/example-swebench swebench

# Target a single instance.
SWEBENCH_SANDBOX=local SWEBENCH_INSTANCE=astropy__astropy-12907 \
  pnpm --filter @repo/example-swebench swebench

# Swap to the API provider.
SWEBENCH_PROVIDER=anthropic SWEBENCH_SANDBOX=local \
  pnpm --filter @repo/example-swebench swebench

# Full smoke with sb-cli scoring.
SWEBENCH_SANDBOX=local SWEBENCH_RUN_EVAL=1 \
  pnpm --filter @repo/example-swebench swebench
```

## Output

Each run writes to `examples/swebench/.runs/<run_id>/`:

```text
predictions.jsonl     # input to sb-cli / swebench eval harness
report.json           # the BenchReport with per-case scores and cost
trajectories/*.jsonl  # one filesystem_logger output per case
eval.json             # the sb-cli report (when SWEBENCH_RUN_EVAL=1)
```

## Scaling beyond 5

Swap `SMOKE_INSTANCES` for a HuggingFace dataset loader:

```ts
import { load_dataset } from '@huggingface/hub'
const ds = await load_dataset('princeton-nlp/SWE-bench_Verified', { split: 'test' })
```

Bump `concurrency` in `main.ts` once the per-case sandbox cost (Docker pull
or git clone) is amortized. SWE-bench Verified leaderboard runs typically
use 4-8 concurrent workers; cranking higher tends to flake tests under
container memory pressure.

## What this does NOT prove

- Resolution rate on 5 instances is noise. Don't compare numbers under
  ~50 cases.
- The `noop` and `local` sandboxes are not the SWE-bench-canonical sandbox;
  only Docker matches the public leaderboard exactly. Treat smoke results
  as "harness shape works," not "Fascicle scored X%."
- The cheap in-bench judges measure shape, not correctness. A patch can be
  100% shape-correct and 0% issue-resolving.

When you're ready to commit a baseline, run on the full Verified set with
the Docker sandbox, write the resulting `report.json` to
`bench/swebench/baseline.json`, and gate future runs against it via
`regression_compare`.
