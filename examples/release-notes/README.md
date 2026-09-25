# release-notes

A whole agent in one file. The blueprint
([docs/blueprint.md](../../docs/blueprint.md)) describes the layered layout
for multi-role apps; this example is deliberately the other end of that
spectrum. One model role, so the system prompt is an inline string, the
schema sits beside it, and the whole topology is a single `chain` read top to
bottom. Reach for the layered layout when roles multiply or the prompt
deserves its own review surface, not before.

![terminal output of the release-notes example: rendered release notes with highlights and a commit-type tally](./screenshot.png)

```text
chain
├─ commits    hash and subject per raw git log --oneline line, pure
├─ grouped    bucket subjects by conventional-commit type, pure
├─ notes      call the writer through ctx.call on every release
│  └─ writer  model_step to the notes schema, the only model boundary
└─ output     step
```

The `output` row renders the release-notes markdown, and it's pure too.

The engine is a canned stub, so the example runs with no keys and no network;
swap `make_stub_engine()` for `create_engine({...})` to go live.

## Run

```bash
pnpm exec tsx examples/release-notes/main.ts
```
