# suspend-resume

Human-in-the-loop pause and resume. `run.until_suspended` reports the pause
as a typed outcome, and calling the outcome's `resume(data)` re-runs the flow
with the decision, so the flow continues into `combine`.

![terminal output of the suspend-resume example: the suspended flag and the resumed result carrying the supplied decision](./screenshot.png)

Every step is a deterministic stub: no engine layer, no network, no LLM calls.

## Flow

The flow is a single `suspend` step, so this tree draws the program that
drives it.

```text
run_suspend_resume      drive the approval gate from outside the flow
├─ run.until_suspended  first run; resolves to a suspended outcome
│  └─ approve           suspend: no decision yet, so call on() and pause
└─ outcome.resume       re-run from the same input with { approved: true }
   └─ approve           suspend: check the decision against resume_schema
      └─ combine        shipped:<brief> if approved, else rejected:<brief>
```

## Run

```bash
pnpm exec tsx examples/suspend-resume/main.ts
```
