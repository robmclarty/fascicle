---
title: Provenance publishing — OIDC trusted publishing and build attestation for releases
status: draft
date: 2026-07-08
author: rob
tags: [ci, release, security, supply-chain, provenance, oidc, spec]
---

# Provenance Publishing — Specification

**Status:** Draft, implementation pending
**Scope:** the release/publish CI (`.github/workflows/`), the one-time npm
registry configuration, and the docs that describe the publish posture
(`SECURITY.md`, `docs/roadmap.md`). No `src/` changes; no change to the published
package surface.
**Background:** the supply-chain posture in [`../SECURITY.md`](../SECURITY.md) and
the sovereignty argument in
[`explorations/2026-07-ai-sdk-and-provider-sovereignty.md`](./explorations/2026-07-ai-sdk-and-provider-sovereignty.md).
**Sibling contracts:** `.ridgeline/constraints.md` (§8 distribution/publishing
rules), `AGENTS.md` (conventions), the frozen publish record at
`.ridgeline/builds/publish/spec.md` (superseded release flow).

---

## §1 — Problem Statement

Today fascicle is published **manually, from a maintainer machine, gated by
multi-factor authentication, with no long-lived npm credential in CI**. The release
workflow (`release.yaml`) only turns a pushed `v*` tag into a GitHub Release; its
permissions are `contents: write` and it explicitly holds "no id-token, no npm
token." The tarball is produced by `pnpm build` and pushed with `pnpm publish` (the
`prepublishOnly` gate runs `pnpm check && pnpm build && pnpm check:publish` first).

That posture has a real strength: there is no npm token sitting in CI to steal, which
is one of the most common supply-chain attack paths. It has one gap:

- **No build provenance.** Because publishing does not run in CI with an OIDC
  identity, releases ship with no signed attestation tying the published tarball to
  this repository and the workflow that built it. A consumer cannot cryptographically
  verify that `fascicle@X.Y.Z` on the registry was built from the source here. This is
  exactly the residual risk named in `SECURITY.md`, and the `docs/roadmap.md` Phase 1
  claim of "npm provenance on release" is currently aspirational, not true.

The goal is to close that gap **without reintroducing a long-lived npm token** and
**without losing the human-in-the-loop gate** that manual publishing gave us.

### Non-goals

- Changing what gets published, the package name, or the `files` set.
- Moving off pnpm for install/build.
- Automating version bumps or tagging (the `/version` skill and the human tag remain
  the trigger).
- Multi-package publishing (still one package from the repo root).

---

## §2 — Solution Overview

Adopt **npm Trusted Publishing via GitHub Actions OIDC**, which mints a short-lived
identity per run (no stored token) and **generates provenance automatically**, and
gate the publish job behind a **GitHub Environment with a required reviewer** so a
human still approves every release. This reconciles the three properties that were
previously in tension:

| Property | Manual publish today | This spec |
| --- | --- | --- |
| No long-lived npm token in CI | yes (no CI publish at all) | yes (OIDC mints a ~15-min identity per run; nothing stored) |
| Human gate on every publish | yes (local MFA prompt) | yes (required-reviewer approval on a protected Environment) |
| Build provenance attestation | no | yes (generated automatically under trusted publishing) |

The trigger stays the same: a maintainer runs `/version`, reviews the commit, and
pushes a `v*` tag. The tag starts the publish workflow; the workflow pauses for
approval; on approval it runs the full gate and publishes with provenance.

---

## §3 — One-time npm registry configuration (manual, outside the repo)

Trusted publishing is configured on the registry, not in code. On npmjs.com, for the
`fascicle` package: **Settings → Trusted Publishers → add a GitHub Actions publisher**
bound to:

- Repository: `robmclarty/fascicle`
- Workflow filename: the publish workflow added in §4 (for example `publish.yaml`)
- Environment name: the protected environment from §5 (for example `npm-publish`)

This ties publishing to that exact workflow file in that exact repo running under that
exact environment. Any other workflow, fork, or environment is rejected by the
registry even with a valid OIDC token.

Prerequisites and notes:

- The package already exists (currently `fascicle@0.8.16`), so no bootstrap token is
  needed to create it. Trusted publishing only needs to be turned on.
- Keep account-level 2FA enabled. Trusted publishing governs automated publishes; it
  does not replace account security, and the manual break-glass path (§7) still relies
  on it.
- If the org later requires it, set the package publish access to "require trusted
  publishing" so a leaked token cannot publish out-of-band.

---

## §4 — CI workflow changes

Add a dedicated `publish.yaml` rather than extending `release.yaml`, so the elevated
`id-token: write` permission is scoped only to the publish job and the GitHub-Release
job keeps its minimal `contents: write`. Both trigger on `v*` tags.

Illustrative shape (pin every action by commit SHA with a `# vX.Y.Z` comment, as the
existing workflows do):

```yaml
name: Publish

on:
  push:
    tags: ['v*']

permissions:
  contents: read      # checkout only
  id-token: write     # OIDC identity for npm trusted publishing + provenance

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish   # required-reviewer gate: the human approval step
    steps:
      - uses: actions/checkout@<sha>   # persist-credentials: false
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<sha>
      - uses: actions/setup-node@<sha>
        with:
          node-version: 24
          registry-url: 'https://registry.npmjs.org'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Trusted publishing + provenance needs a recent npm CLI (>= 11.5.1).
      # Node 24 ships npm 11.x; upgrade explicitly to guarantee the floor.
      - run: npm install -g npm@latest
      - run: pnpm check
      - run: pnpm build
      - run: pnpm check:publish
      # No NODE_AUTH_TOKEN: the OIDC identity authorizes the publish, and
      # provenance is attested automatically under trusted publishing.
      - run: npm publish --provenance --access public
```

Key points:

- **No `NODE_AUTH_TOKEN` / `secrets.NPM_TOKEN`.** Under trusted publishing the OIDC
  exchange authorizes the publish; there is no token to store or leak.
- **`--provenance` is explicit but redundant.** Trusted publishing attests provenance
  automatically; the flag documents intent and keeps behavior correct if the registry
  ever requires it explicitly.
- **`environment: npm-publish`** is the human gate. Configure the environment (repo
  Settings → Environments) with required reviewers; the run halts until a maintainer
  approves, then proceeds. This is the CI equivalent of the old local MFA prompt.
- The publish job re-runs `pnpm check` / `pnpm build` / `pnpm check:publish` so the
  gate is enforced in CI, not only via `prepublishOnly`.

---

## §5 — Publish vs GitHub Release ordering

Two tag-triggered workflows now exist: `release.yaml` (unchanged, creates the GitHub
Release, `contents: write`) and `publish.yaml` (new, `id-token: write`). They are
independent and can run in parallel; neither depends on the other. If a single
ordered pipeline is preferred later, fold the Release step into `publish.yaml` after a
successful `npm publish` and give that job both `contents: write` and
`id-token: write`. Default recommendation: keep them separate for least-privilege.

---

## §6 — Open decision: `npm publish` vs `pnpm publish`

The publish step above uses `npm publish` deliberately. As of mid-2026, npm's OIDC
trusted-publishing token exchange is an npm CLI feature (>= 11.5.1); pnpm supports
`--provenance` but its support for npm OIDC *trusted publishing* (tokenless) needs
verification at implementation time. Because fascicle ships a single package from the
repo root with a bundled `dist/`, `npm publish` from the root is equivalent to
`pnpm publish` for this artifact, so using `npm` for the publish step alone (while
pnpm still does install and build) is the low-risk choice that guarantees provenance.

**Decision:** use `npm publish` in CI; keep pnpm for everything else. Revisit if a
verified pnpm release supports OIDC trusted publishing end to end.

---

## §7 — Break-glass (manual fallback)

Keep a documented manual path for when CI is unavailable: build locally, then
`npm publish` from a maintainer machine behind 2FA. Note the tradeoff explicitly in
the runbook: a local publish does **not** produce provenance (no OIDC), so it should
be rare and followed by a note in the release. This preserves the ability to ship
without depending on GitHub Actions, at the cost of that one release lacking an
attestation.

---

## §8 — Docs to update on completion

- **`SECURITY.md`** — replace "No build provenance yet" with a description of what
  provenance now proves and how to verify it (`npm audit signatures`, the provenance
  badge on npmjs.com); update the "manual, MFA-gated" bullet to "published from CI via
  OIDC trusted publishing behind a required-reviewer gate; no long-lived npm token;
  provenance attested per release."
- **`docs/roadmap.md`** — the Phase 1 "npm provenance on release" line becomes true;
  reconcile it (it currently reads as shipped but is not).
- **`.ridgeline/constraints.md` §8** — record trusted publishing + the required-reviewer
  gate as the publishing rule if constraints track it.

---

## §9 — Success criteria

1. Pushing a `v*` tag starts `publish.yaml`; the run pauses on the `npm-publish`
   environment until a maintainer approves.
2. On approval, the job runs the full gate and publishes; the run fails closed if
   `pnpm check`, `pnpm build`, or `pnpm check:publish` fails.
3. npmjs.com shows the **provenance badge** on the new version, linking to the source
   commit and the workflow run.
4. `npm audit signatures` (or `npm view fascicle@X.Y.Z --json` provenance fields)
   confirms a valid attestation for the published version.
5. The repository holds **no** long-lived npm publish token in secrets.
6. The published file list is byte-for-byte what `check:publish` asserts (dist,
   README, CHANGELOG, LICENSE; no source, no tests, no `.ridgeline/`, no `docs/`).

---

## §10 — Failure modes and rollback

- **Trusted publishing misconfigured** (wrong repo/workflow/environment): the publish
  step fails closed with an auth error; nothing ships. Fix the registry binding (§3)
  and re-run; no bad artifact can be produced.
- **npm CLI too old:** the explicit `npm install -g npm@latest` prevents this; if it
  regresses, pin an exact `npm@>=11.5.1`.
- **Need to ship with CI down:** use the break-glass path (§7); accept the one release
  without provenance and note it.
- **Full revert:** delete `publish.yaml`, remove the trusted publisher on npmjs.com,
  and return to manual local publishing. No source or package changes to undo.

---

## §11 — Open questions

1. **pnpm OIDC support (§6).** Verify whether a current pnpm release does tokenless
   trusted publishing; if so, drop the `npm publish` special-case.
2. **Required-reviewer set.** Single-maintainer today, so the reviewer is the same
   person who pushed the tag. The environment gate is still worth it (an explicit
   "yes, publish" click distinct from "push a tag"), but it is a soft gate until there
   is a second reviewer. Note this honestly.
3. **Attestation verification in CI.** Optionally add a post-publish step that runs
   `npm audit signatures` against the just-published version as a smoke check, or
   leave verification to consumers.
4. **Sigstore/public-good log retention.** Provenance is logged to a public
   transparency log; confirm nothing in the build leaks a path or secret into the
   attested metadata (it should not, but check the first attestation).

---

## Bootstrap / required reading for the builder

1. `.github/workflows/release.yaml` and `ci.yaml` — current CI shape, action-pinning
   convention, Node/pnpm setup.
2. `package.json` — `publishConfig`, `prepublishOnly`, `files`, `bin`, empty
   `dependencies`.
3. `scripts/check-publish.mjs` — what the publish preflight asserts.
4. npm trusted publishing docs (the registry-side setup) and the GitHub Actions OIDC
   permissions model (`id-token: write`).
5. `SECURITY.md` "Supply-chain posture" — the residual-risk text this spec makes
   obsolete.

### Build order

1. Turn on trusted publishing for `fascicle` on npmjs.com (§3), bound to the workflow
   filename and environment chosen below.
2. Create the `npm-publish` GitHub Environment with a required reviewer.
3. Add `publish.yaml` (§4), actions pinned by SHA.
4. Cut a patch release as the first provenance-attested publish; confirm the badge and
   `npm audit signatures` (§9).
5. Update `SECURITY.md` and `docs/roadmap.md` (§8).
