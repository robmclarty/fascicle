# Spec: pr-improve cloud deployment

> **This spec supersedes [SPEC.md](./SPEC.md)** for all remaining work.
> SPEC.md is retained as historical design context for the shipped pipeline
> (Phases A–C). Anything in SPEC.md that contradicts this document is wrong;
> trust this file.

## Context

The 4-stage agent pipeline is shipped and works end-to-end against real GitHub PRs under both `claude_cli` (developer's logged-in Claude) and `anthropic` (API key). The portability proof is live. What's missing is a way to run it *without a developer at the keyboard* — a cloud trigger so labelling a PR with `fascicle-improve` produces an improvement PR within minutes.

This spec covers exactly that gap: the AWS-side machinery and the Terraform module that owns it. It does not modify the agent flow, the stage prompts, or the local CLI — those are stable and out of scope.

**What "done" means here.** A reviewer adds the `fascicle-improve` label to a PR in an opted-in repo, and within ~5 min an improvement PR appears on that repo with a comment on the original linking the two. All operational signal lives in CloudWatch + S3-archived trajectories. No SRE heroics required to debug a typical run.

## Goals

1. **Hands-off trigger.** GitHub webhook → tiny Lambda → SQS → Fargate task running the existing `build_flow` against `--provider anthropic`.
2. **Single Terraform module** under `examples/pr-improve/infra/` so the app team owns its own infra alongside the code that consumes it. No separate repo, no submodule.
3. **Bounded blast radius.** Per-PR singleton concurrency, hard cost cap per run, container scales to zero, DLQ catches repeat failures.
4. **Observability without new IAM.** Trajectory events stream to CloudWatch via stdout (Fargate's `awslogs` driver) and to S3 on container exit, mirroring how the local CLI tees `filesystem_logger` + `stdout_logger` today.
5. **Zero handoff friction.** Anyone with `terraform apply` access to the target AWS account can stand up a new deployment from the contents of this repo.

Explicit non-goals: multi-region, multi-tenancy, a dashboard, comment-command triggers, alert integrations beyond CloudWatch Logs Insights.

## High-level architecture

```text
GitHub PR labelled `fascicle-improve`
   │
   │  webhook event: pull_request.labeled
   ▼
API Gateway HTTP API ──► webhook Lambda (Node, ~30 LOC)
                              │
                              │  HMAC verify, filter label, build payload
                              ▼
                          SQS FIFO queue
                          MessageGroupId       = repo/pr_number
                          MessageDeduplicationId = repo/pr_number/event_id
                              │
                              │  EventBridge Pipes (SQS → ECS RunTask)
                              ▼
                          ECS Fargate task (one per message)
                              │  image: pr-improve:<tag>
                              │  args:  worker.ts, payload from SQS body
                              │
                              ├── pulls secrets from Secrets Manager:
                              │     GH_TOKEN, ANTHROPIC_API_KEY, WEBHOOK_SECRET
                              ├── git worktree of PR head (in container fs)
                              ├── runs build_flow (--provider anthropic)
                              ├── posts review/improvement PR/comment via gh
                              ├── stdout → CloudWatch Logs (awslogs driver)
                              └── on exit → S3 upload of trajectory.jsonl

DLQ: messages whose Fargate tasks fail repeatedly land here, no auto-retry past N=2.
```

One process per PR. One container per task. No queue of work inside the container, no orchestrator beyond SQS + Pipes.

## Components

### `src/worker.ts` (Fargate entrypoint)

A thin wrapper around the existing `build_flow` for the SQS-driven path. Concretely:

1. Read the SQS message body from process args (EventBridge Pipes injects the body as the container's command argv).
2. Parse the payload into a `WorkerInput = { repo, pr_number, head_oid, label_event_id, install_id }`.
3. Fetch secrets from Secrets Manager (one call, batched). Set `GH_TOKEN`, `ANTHROPIC_API_KEY` in the env for the duration of the run.
4. Set up the worktree in `/work/<run_id>` using the existing `setup_worktree` helper, but pointed at a freshly cloned shallow checkout (no preexisting cwd, unlike the local CLI which uses the dev's repo).
5. Build the engine via `create_app_engine({ provider: 'anthropic', ... })`. Wire the trajectory: `tee_logger(filesystem_logger(local_path), stdout_logger())`.
6. Wrap the call in a **cost guardrail** — abort if the engine's cumulative `usage` exceeds `MAX_COST_USD` (default `1.00`). Implementation: subscribe to the engine's cost trajectory events; on first event past the cap, call the run's `AbortController`.
7. Run `build_flow` with `FlowEnv = { worktree_root: '/work/<run_id>', provider: 'anthropic' }`.
8. On `kind === 'improvement_ready'`: commit, push, create improvement PR, post linking comment — same `post_*` helpers `main.ts` already uses for `--pr` mode.
9. On any other terminal kind: post the appropriate follow-up comment (no improvement PR, did-not-converge).
10. On any uncaught error: log it via the trajectory, exit non-zero so ECS marks the task failed.
11. **Always**, in `finally`: upload `trajectory.jsonl` (and the run's `.runs/<run_id>/` artifacts) to S3 at `s3://<bucket>/<repo>/<pr_number>/<run_id>/`. Then `cleanup_worktree`.

Code reuse: `setup_worktree`, `commit_changes`, `push_branch`, `cleanup_worktree`, `gh_pr_*`, `post_review`, `post_followup`, `post_improvement_pr`, `build_flow`, `default_models`, `create_app_engine`. Worker should be ~200 LOC; ~80% of that is glue around already-built helpers.

### `src/webhook_lambda.ts`

~30 lines. AWS Lambda Node.js runtime (no bundler-specific imports). Per request:

1. Verify the GitHub HMAC signature (`X-Hub-Signature-256`) against `WEBHOOK_SECRET` (timing-safe compare).
2. Reject anything that isn't `pull_request` with action `labeled`.
3. Reject if the label isn't `fascicle-improve`.
4. Reject if `repository.full_name` isn't in the allowlist (env var `ALLOWED_REPOS`, comma-separated).
5. Build the payload `{ repo, pr_number, head_oid, label_event_id, install_id }` and call `SQS.SendMessage` with the FIFO group/dedup IDs.
6. Return `202 Accepted` with the message ID, or `4xx` with a reason on rejection.

No external deps beyond the AWS SDK v3 SQS client (or `node-fetch` to call `sqs.amazonaws.com` directly to avoid the SDK bundle weight). HMAC via `node:crypto`. Built as a separate tsdown bundle (`dist/webhook_lambda.js`) so the Lambda zip is small and cold starts are fast.

### `Dockerfile` (Fargate image)

```dockerfile
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/ /app/dist/
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/worker.js"]
```

Built off the bundled `dist/worker.js` (tsdown output), not the source tree — the image is a deployment artifact, not a dev environment. Image is published to ECR and tagged with the git SHA. Terraform pins by tag.

### `tsdown.config.ts` additions

The repo already uses `tsdown` (root `tsdown.config.ts`). Phase D extends it with two new bundles produced under `examples/pr-improve/dist/`:

- `worker.js` — bundled `src/worker.ts`, format `esm`, target `node24`, externals: nothing (full bundle so the container doesn't need `node_modules`).
- `webhook_lambda.js` — bundled `src/webhook_lambda.ts`, format `esm`, target `node22` (Lambda runtime), externals: `@aws-sdk/*` (provided by the Lambda runtime).

A new `pnpm --filter @repo/example-pr-improve build` script runs both. CI publishes the worker image on every commit to `main`; the Lambda zip is published as part of `terraform apply` via Terraform's `archive_file` data source pulling from `dist/webhook_lambda.js`.

### `infra/` (Terraform module)

Owned alongside the app code. Single module, no submodules, no remote module references — keep it readable and reviewable in one place. Layout:

```text
examples/pr-improve/infra/
├── README.md          # how to apply, what to set in tfvars, how to roll back
├── main.tf            # all resources (see breakdown below)
├── variables.tf       # inputs: aws_region, repo_allowlist, image_tag, max_cost_usd, etc.
├── outputs.tf         # webhook_url, queue_arn, bucket_name, image_repo_url
├── versions.tf        # required_providers + required_version pins
└── tfvars.example     # template for the tfvars file the operator copies
```

Resources in `main.tf`:

1. **API Gateway HTTP API** (`aws_apigatewayv2_api` + `aws_apigatewayv2_route` for `POST /webhook`). HTTP API, not REST — cheaper, no usage plans, sub-second cold start with the Lambda integration.
2. **Webhook Lambda** (`aws_lambda_function`) — Node 22 runtime, code from `data.archive_file.webhook_lambda_zip` pointing at `../dist/webhook_lambda.js`. Env: `WEBHOOK_SECRET_ARN`, `QUEUE_URL`, `ALLOWED_REPOS`. IAM: read the secret, `sqs:SendMessage` on the queue.
3. **SQS FIFO queue** (`aws_sqs_queue`) with `fifo_queue = true`, `content_based_deduplication = false` (Lambda sets `MessageDeduplicationId` explicitly), `visibility_timeout_seconds = 1800` (30 min — covers worst-case build runtime), redrive policy → DLQ.
4. **SQS DLQ** (`aws_sqs_queue`) — also FIFO. CloudWatch alarm on `ApproximateNumberOfMessagesVisible >= 1` (so a single failed message gets attention).
5. **EventBridge Pipes** (`aws_pipes_pipe`) — source: SQS; target: ECS RunTask; transformer: pass the SQS message body through as the container's command override. This is the SQS→ECS bridge — no Lambda in the middle.
6. **ECS cluster** (`aws_ecs_cluster`, Fargate-only).
7. **ECS task definition** (`aws_ecs_task_definition`) — image from `aws_ecr_repository.worker.repository_url:${var.image_tag}`, `requires_compatibilities = ["FARGATE"]`, `cpu = 1024`, `memory = 2048`, ephemeral storage 21 GiB (room for shallow clones + worktrees + node_modules if any), task role with the IAM in (8), execution role for ECR pull + log group write.
8. **Task IAM role** — read `GH_TOKEN`, `ANTHROPIC_API_KEY` from Secrets Manager; `s3:PutObject` to the trajectory bucket prefix; `logs:CreateLogStream` + `logs:PutLogEvents` (provided by `awslogs` driver setup).
9. **Secrets Manager secrets** (3) — `pr-improve/gh_token`, `pr-improve/anthropic_api_key`, `pr-improve/webhook_secret`. Created empty by Terraform (`ignore_changes = [secret_string]`); operator populates via the AWS console or `aws secretsmanager put-secret-value` after the first apply. Plan must not destroy these on subsequent applies.
10. **S3 bucket** (`aws_s3_bucket`) — versioned, private, lifecycle rule transitions to Glacier after 30 days and expires after 365. Bucket policy denies non-task-role principals.
11. **ECR repository** (`aws_ecr_repository`) — for the worker image. Lifecycle policy: keep 10 most recent tagged images, expire untagged after 1 day.
12. **CloudWatch log groups** (2) — one for the Lambda, one for the ECS task. Retention 30 days.
13. **ECS task definition log driver** — `awslogs` writing to the log group from (12), so stdout from the worker becomes CloudWatch Logs Insights-queryable JSON automatically.
14. **CloudWatch alarms** — DLQ depth ≥ 1, Fargate task failure count ≥ 3 in 5 min. Targets an SNS topic; the topic has zero subscribers by default (operator wires their preferred channel in tfvars).

`outputs.tf` exposes `webhook_url` (the operator pastes this into GitHub's webhook UI), `image_repo_url` (where CI pushes), and `trajectory_bucket_name` (for replay tooling).

### Secrets

Three secrets, all in Secrets Manager, all created empty by Terraform with `ignore_changes` on the value:

- **`pr-improve/gh_token`** — fine-grained PAT scoped to the allowlisted repos with `pull_requests: write`, `contents: write`, `issues: write`. Rotate quarterly.
- **`pr-improve/anthropic_api_key`** — Anthropic console key, scoped to a workspace dedicated to this app for billing visibility.
- **`pr-improve/webhook_secret`** — random 64-byte hex, also configured in the GitHub webhook settings. Used by the Lambda for HMAC verify.

Operator runbook (in `infra/README.md`): after first `terraform apply`, populate all three via `aws secretsmanager put-secret-value`. The Lambda and the ECS task fail closed if any secret is empty.

## Operational invariants

### Cost guardrail

Per-run hard cap (`MAX_COST_USD`, default `1.00`). Implemented in `worker.ts` by subscribing to the engine's cost trajectory events:

```ts
let cumulative_usd = 0
const cost_abort = new AbortController()
trajectory.on('cost', (e) => {
  cumulative_usd += e.usd
  if (cumulative_usd > MAX_COST_USD) {
    cost_abort.abort(new Error(`cost cap exceeded: $${cumulative_usd.toFixed(2)} > $${MAX_COST_USD}`))
  }
})
```

The `AbortSignal` is composed with the run's existing signal so any in-flight `model_call` aborts cleanly. Aborted runs still upload their partial trajectory to S3, exit 1, and surface in CloudWatch.

### Concurrency

Per-PR singleton via SQS FIFO `MessageGroupId = ${repo}/${pr_number}`. A second label event for the same PR queues behind any in-flight run rather than racing. Webhook Lambda computes the group ID and the dedup ID together — so a duplicated webhook delivery within the 5-min FIFO dedup window collapses to a single execution.

`MessageDeduplicationId = ${repo}/${pr_number}/${label_event_id}`. The label event ID is GitHub's stable per-event identifier; the same retry from GitHub deduplicates, but a relabel-after-unlabel produces a fresh event ID and a fresh run.

### Failure modes

| Where | Failure | Behavior |
|---|---|---|
| Webhook Lambda | HMAC verify fails | 401, no SQS enqueue, Lambda metric `signature_invalid` increments |
| Webhook Lambda | event isn't `pull_request.labeled` w/ `fascicle-improve` | 204 No Content, no SQS enqueue |
| Webhook Lambda | repo not in allowlist | 403, no SQS enqueue |
| Worker | secrets missing | log + exit 1 + DLQ on retry |
| Worker | engine error | log + exit 1; SQS retries up to `maxReceiveCount = 2`, then DLQ |
| Worker | cost cap exceeded | log + abort + exit 1; trajectory uploaded; **no DLQ** (deterministic, retry won't help — set `_failure_kind: 'cost_cap'` on the message and have the redrive policy skip these via filter) |
| Worker | uncaught exception | trajectory captures it, exit 1, DLQ on second failure |
| Pipes | RunTask throttled by ECS | Pipes auto-retries with backoff (built-in) |

DLQ has a CloudWatch alarm at depth ≥ 1, no auto-clear. Operator triages via the SQS console + the run's S3 trajectory.

### Idempotency on retry

Worker is idempotent: the improvement branch is `fascicle/improve-<pr_number>` (deterministic), and `setup_worktree` already removes any pre-existing worktree pinned to that branch (`workspace.ts:60-65`). A retry replays the work; the second `gh pr create` returns the existing PR's URL rather than creating a duplicate. The follow-up comment is gated on whether one already exists (added in PR D-1 — small `gh pr view --json comments` check).

### Trajectory persistence

Two destinations, one source:

- **Live (CloudWatch)**: `stdout_logger` writes one JSON line per event to stdout. `awslogs` driver pipes that to a CloudWatch log group with 30-day retention. Logs Insights queries treat each line as a JSON document.
- **Archive (S3)**: `filesystem_logger` writes the same events to `/work/<run_id>/trajectory.jsonl`. On worker exit (success or failure, in `finally`), the file is uploaded to `s3://<bucket>/<repo>/<pr_number>/<run_id>/trajectory.jsonl` along with the rest of `.runs/<run_id>/`.

Local replay uses `pnpm dlx fascicle-viewer s3://...` (the viewer already supports S3 sources). No new tooling.

## Build sequence

Three PRs. Each one is independently mergeable and deployable.

### PR D-1 — Worker + Dockerfile + bundle (no live infra)

Pure application code. No AWS resources created or modified by this PR.

1. `src/worker.ts` — the entrypoint described above. Reuses every `main.ts` helper that's not CLI-specific.
2. `src/cost_guard.ts` — extracts the `MAX_COST_USD` subscriber so it can be unit-tested in isolation against a stub trajectory.
3. `Dockerfile` + `.dockerignore`.
4. `tsdown.config.ts` updates: produce `dist/worker.js` and `dist/webhook_lambda.js` from `examples/pr-improve/`.
5. `bin/pr-improve-worker` shell wrapper (or `pnpm --filter @repo/example-pr-improve worker:local`) that runs `worker.ts` with a JSON payload from stdin — for local smoke testing without SQS/Fargate.
6. Tests: `worker.test.ts` runs the worker end-to-end against a fixture payload using the stub engine (mirrors `--fixture --stub` mode); `cost_guard.test.ts` covers the cap.
7. Idempotency check: skip the linking comment if a `pr-improve` comment already exists on the original PR.

PR D-1 ships when: `docker build` succeeds, the local worker smoke runs against a fixture, and `pnpm check:all` is green.

### PR D-2 — Webhook Lambda + Terraform module

1. `src/webhook_lambda.ts` — the ~30-LOC handler.
2. `webhook_lambda.test.ts` — HMAC verify (valid + tampered), label filter (positive + wrong label + wrong action), repo allowlist (positive + denied), payload shape.
3. `infra/` — every resource enumerated above, plus `README.md` with the apply runbook and the post-apply secret-population steps.
4. `tfvars.example` checked in.
5. CI step that runs `terraform fmt -check` and `terraform validate` against the module on PRs touching `infra/`.

PR D-2 ships when: the Lambda is unit-tested, `terraform validate` passes, and the README runbook reads as something an SRE could execute without asking questions.

### PR D-3 — Production rollout (operational PR, not a code PR)

1. `terraform apply` against the chosen account/region. Operator populates the three secrets.
2. ECR push of the first worker image; `image_tag` in `tfvars` updated; `terraform apply` again.
3. Configure the GitHub webhook on the fascicle repo (operator pastes `webhook_url` from `terraform output`, sets the same secret as `pr-improve/webhook_secret`, scopes to `pull_request` events only).
4. Enable on the fascicle repo: add the `fascicle-improve` label to a low-stakes PR. Watch CloudWatch + the SQS depth metric. Verify the improvement PR appears.
5. If anything blocks for >15 min: pause by removing the label or scaling the ECS service to 0 (which prevents new task launches; in-flight runs complete).

PR D-3 isn't a code change — it's a checklist + the recorded outcome. Closed when the first auto-improvement PR lands on the fascicle repo.

## Verification

| Layer | What | How |
|---|---|---|
| Unit | Webhook handler logic | `webhook_lambda.test.ts` |
| Unit | Cost guard trip | `cost_guard.test.ts` |
| Integration (local) | Worker against fixture | `pnpm --filter @repo/example-pr-improve worker:local < fixtures/sqs-payload.json` |
| Integration (local) | Worker against real PR with API provider | run `worker.ts` with a hand-built payload pointing at a real PR; check artifacts in `/work/<run_id>` |
| Build | Container | `docker build .` produces a runnable image; `docker run pr-improve:local --help` exits 0 |
| Build | Terraform | `terraform fmt -check && terraform validate` |
| Acceptance (staging) | Webhook → SQS | curl with a recorded GitHub `pull_request.labeled` payload; verify SQS message lands |
| Acceptance (staging) | SQS → Fargate task | manually `aws sqs send-message` a hand-built payload; verify ECS task launches and completes |
| Acceptance (production) | End-to-end | label a PR on the fascicle repo; improvement PR appears within ~5 min |
| Pipeline-level | All other checks | `pnpm check:all` green at every PR boundary |

## Open questions

These need answers before PR D-2 (webhook + infra) goes in. PR D-1 is unblocked.

1. **AWS account/region.** Is there an existing account, or do we provision a fresh one? Region default `us-east-1` unless told otherwise.
2. **Container registry.** ECR in the same account (default), or push to a shared registry (GHCR / Dockerhub) and have ECS pull from there?
3. **Networking.** Public subnet (simplest, default) or private subnet + NAT gateway (more correct, more cost)? Webhook Lambda needs internet egress to call SQS but that's via the AWS SDK; ECS needs egress to GitHub + Anthropic + ECR + Secrets Manager.
4. **Image build pipeline.** Is there an existing CI step that builds + pushes images, or does this PR introduce one (GitHub Actions `pr-improve-image.yml`)?
5. **Cost cap default.** $1/run is a guess. Want to start lower ($0.50) for the rollout window, then raise?
6. **Secret rotation.** Manual quarterly is simplest; do we need automated rotation via Lambda from day one?

## Out of scope

- **Multi-tenant deployments.** The infra module supports one deployment at a time; multi-tenancy is a different module.
- **A web dashboard.** CloudWatch Logs Insights + the local `fascicle-viewer` against S3 trajectories cover all real debugging needs.
- **Comment-command triggers** (`/fascicle improve`). The `pull_request.labeled` event is the only opt-in surface; revisit only if the label proves too coarse.
- **Multi-repo allowlist UI.** `ALLOWED_REPOS` env var on the Lambda is the source of truth; updating it is a Terraform apply.
- **Cross-region failover.** Single region. If it goes down, manually re-add the label after recovery.
- **GitHub App** (vs. webhook + PAT). PAT is simpler and the security envelope is the same for a single-org rollout. App is the right choice once we open this to external orgs.
