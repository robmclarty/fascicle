---
name: Bug report
about: Something in fascicle behaves incorrectly
title: ''
labels: bug
---

## What happened

A clear description of the bug, including the error name if one was thrown
(for example `provider_not_configured_error`, `schema_validation_error`,
`claude_cli_error`).

## Expected behavior

What you expected to happen instead.

## Minimal reproduction

The smallest flow or `generate` call that triggers it. A copy-pasteable snippet
beats a description.

```ts
// ...
```

## Environment

- fascicle version:
- Node version (`node -v`):
- Provider(s) involved:
- Installed provider SDK version(s):

## Trajectory (optional)

If you can, attach the relevant excerpt from a `trajectory` logger. The event
stream usually shows exactly where the flow diverged.
