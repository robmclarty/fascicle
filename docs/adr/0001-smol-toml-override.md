# ADR 0001 — pnpm override for `smol-toml`

Status: accepted — 2026-04-21

## Context

`pnpm audit` reports a moderate-severity DoS advisory (GHSA-v3rj-xjv7-4jmq) against `smol-toml < 1.6.1`. The vulnerable version enters the tree transitively through `markdownlint-cli2 → smol-toml`. `markdownlint-cli2` is a dev-only tool used by the `docs` check in `pnpm check`; `smol-toml` is never loaded at runtime by any published artifact.

The check pipeline's `check:security` threshold is `high`, so the finding does not fail the build, but it shows up in any manual `pnpm audit` and will eventually be triggered if we ever tighten the threshold.

## Decision

Add a `pnpm.overrides` entry in the root `package.json` forcing `smol-toml` to the patched range (`>=1.6.1`). Remove the override once `markdownlint-cli2` bumps its own dependency to a patched version.

```jsonc
// package.json
"pnpm": {
  "overrides": {
    "smol-toml": ">=1.6.1"
  }
}
```

## Consequences

- `pnpm audit` reports clean at the `moderate` level.
- One more line of supply-chain forcing in the root manifest; must remember to drop it when `markdownlint-cli2` ships a fix upstream.
- No runtime impact — `smol-toml` is dev-only transitive.
- If a future `markdownlint-cli2` release tightens its own lower bound beyond `1.6.1`, the override will still resolve so long as pnpm's resolver can satisfy both constraints; otherwise we delete the override entry.
