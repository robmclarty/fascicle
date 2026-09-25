# viewer-demo

Produce a rich, deterministic `.trajectory.jsonl` for the viewer. The flow
exercises nested sequences, parallel branches, a retry that fails once before
succeeding, a map over a list, and a fallback that recovers from an error. No
engine layer, no network, no LLM calls.

![fascicle-viewer rendering the demo trajectory: the span tree on the left, the event log on the right](./screenshot.png)

## Flow

```text
sequence              a deterministic run with a varied span tree to view
├─ fetch_brief        look up the topic brief and its three sources
├─ explode_sources    pull out the list of sources
├─ parallel           summarize and score the same sources side by side
│  ├─ summaries  map  summarize every source at once
│  │  └─ summarize    summarize one source
│  └─ scores  map     score the sources, at most two in flight
│     └─ score        score one source
├─ to_topic           set the results aside and restart from the topic
├─ retry              up to three attempts with backoff; the second succeeds
│  └─ flaky_enrich    throws on its first attempt, then marks the topic enriched
├─ fallback           recover with a safe default when the primary throws
│  ├─ always_throws   the primary path, which always throws
│  └─ safe_default    the backup, which returns a default brief
└─ finalize           wrap the recovered value in an ok payload
```

## Run

```bash
pnpm exec tsx examples/viewer-demo/main.ts
pnpm exec fascicle-viewer .trajectory.jsonl
```

The first command writes the trajectory; the second serves the viewer on
localhost and opens the run above.
