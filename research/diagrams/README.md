# Diagrams

Shared diagram sources for the research notes. Each diagram is a Mermaid
`.mmd` source file (the canonical, editable source) and is also embedded below
so it renders inline on GitHub.

Mermaid is the format on purpose: text-based, diffable, and LLM-editable, the
same properties the project values in the rest of the codebase. To export a
standalone SVG/PNG:

```sh
pnpm dlx @mermaid-js/mermaid-cli -i architecture-layers.mmd -o architecture-layers.svg
```

These describe the **current** `src/` layout, not the `packages/*` workspace
sketched in [`../papers/0001-studio-pdr.md`](../papers/0001-studio-pdr.md) (that
PDR is a snapshot of earlier thinking). When the code moves, move these with it.

## Architecture layers

How a fascicle harness is wired: the composition layer builds a `Step` tree,
the runner executes it while threading a `RunContext`, the engine handles model
calls across providers, and adapters fan events/checkpoints out to disk and the
viewer. Source: [`architecture-layers.mmd`](architecture-layers.mmd).

```mermaid
flowchart TB
  subgraph compose["Composition · src/core + src/composites"]
    prim["primitives (20)<br/>step · sequence · parallel · branch · map · pipe<br/>retry · fallback · timeout · loop · compose · use<br/>scope · stash · checkpoint · suspend"]
    comp["composites<br/>adversarial · ensemble · tournament · consensus"]
  end

  subgraph runner["Runner · src/core/runner.ts"]
    run["run(flow, input, opts)"]
    ctx["RunContext<br/>run_id · trajectory · checkpoint store"]
  end

  subgraph engine["Engine · src/engine"]
    gen["create_engine · generate · streaming · tool_loop"]
    prov["providers<br/>anthropic · openai · google · bedrock<br/>ollama · lmstudio · openrouter · claude_cli"]
  end

  subgraph adapters["Adapters · src/adapters"]
    log["loggers · filesystem · http · tee · noop"]
    store["filesystem_store (checkpoints)"]
  end

  subgraph viewer["Viewer · src/viewer"]
    srv["SSE server · broadcast · tail · CLI"]
  end

  prim --> run
  comp --> run
  run --> ctx
  run -->|model calls| gen
  gen --> prov
  run -->|TrajectoryEvent| log
  ctx -->|checkpoint / resume| store
  log -->|http_logger over SSE| srv
```

## Primitives taxonomy

The 20 entries of `STEP_KINDS` (`src/core/step_kinds.ts`) grouped by intent.
This is the closed registry the runner dispatches on and that a studio palette
would enumerate. Source: [`primitives-taxonomy.mmd`](primitives-taxonomy.mmd).

```mermaid
mindmap
  root((fascicle<br/>step kinds))
    leaf
      step
    flow
      sequence
      parallel
      pipe
      map
    control
      branch
      loop
    resilience
      retry
      fallback
      timeout
    reuse
      compose
      use
    state
      scope
      stash
      checkpoint
      suspend
    multi-model
      adversarial
      ensemble
      tournament
      consensus
```

## Trajectory pipeline

How a trajectory event reaches a live monitor. The wire format
(`src/core/trajectory.ts`) is an ordered union — `span_start`, `span_end`,
`emit`, then a permissive `custom` fallthrough — and `tee_logger` fans every
event to both the filesystem and the SSE viewer. Source:
[`trajectory-pipeline.mmd`](trajectory-pipeline.mmd).

```mermaid
flowchart LR
  flow["flow (Step tree)"] --> run["run()"]
  run -->|span_start / span_end| traj["TrajectoryLogger"]
  emit["ctx.emit(...)"] -->|emit| traj
  run -->|custom kinds| traj

  traj --> tee["tee_logger"]
  tee --> fs["filesystem_logger<br/>.trajectory.jsonl"]
  tee --> http["http_logger"]
  http -->|HTTP + SSE| server["viewer server<br/>ring buffer (last N)"]
  server -->|event: trajectory| browser["browser monitor"]
  fs -.->|npx tail| server
```
