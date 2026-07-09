# Security Policy

Fascicle is a library that wires LLM calls, tool calls, and subprocesses into
typed workflows. That puts it on the path of API credentials, model output, and
(via the `claude_cli` provider) a spawned child process, so the security model
below is worth reading before you wire it into anything sensitive.

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue
for a vulnerability.

- Preferred: open a private report through GitHub's
  [security advisories](https://github.com/robmclarty/fascicle/security/advisories/new)
  ("Report a vulnerability").
- Alternative: email `hello@robmclarty.com` with `fascicle security` in the
  subject.

Please include a description of the issue, the affected version, and a minimal
reproduction if you have one. This is a small, single-maintainer project: expect
an initial acknowledgement within a few days, and updates as a fix is worked out.
Once a fix ships, credit is given in the release notes unless you ask otherwise.

## Supported versions

Fascicle is pre-1.0 and ships breaking changes on minor releases. Only the latest
published minor receives security fixes; there is no back-porting to older lines.
Pin a version you have reviewed and upgrade deliberately.

| Version | Supported          |
| ------- | ------------------ |
| latest `0.x` minor | yes     |
| older `0.x` lines  | no      |

## Credentials and data

- **The library never reads `process.env`.** Provider credentials are passed
  explicitly into `create_engine({ providers })`; reading them from the
  environment is the harness's job, done at its own boundary. An internal rule
  (`no-process-env-in-core`) enforces this across `src/`. See
  [docs/configuration.md](./docs/configuration.md).
- **Credentials are not persisted or logged by fascicle.** They live only in the
  engine config you construct and are handed to the underlying provider SDK.
- **Trajectory and checkpoint files are sensitive.** They capture prompts, model
  output, and tool inputs/outputs in plain text. The bundled `filesystem_logger`
  and `filesystem_store` adapters write unencrypted files to disk; treat their
  output paths like any other secret-bearing artifact and keep them out of
  version control.

## Subprocess and sandbox model (`claude_cli`)

The `claude_cli` provider spawns the `claude` binary and parses its streamed
output. That is a real trust boundary:

- Under `auth_mode: 'oauth'` the adapter scrubs `ANTHROPIC_API_KEY` from the
  child environment so a stored session is used instead of leaking a key into the
  subprocess. Under `api_key`/`auto` the child starts from an empty environment
  and only caller-supplied values pass through.
- fascicle tools that carry an `execute` closure cannot run inside the
  subprocess. The default `tool_bridge: 'allowlist_only'` only adds tool *names*
  to the CLI's own allowlist and silently drops the closures; use
  `tool_bridge: 'forbid'` when you need a hard guarantee that no `execute` closure
  becomes a silent no-op.
- For untrusted work, confine the subprocess with `sandbox: { kind: 'bwrap' |
  'greywall', network_allowlist, additional_write_paths }`. An empty
  `network_allowlist` means network-off. Full details in [docs/cli.md](./docs/cli.md).

Tools you pass to a model call run **in your process**, with whatever privileges
your process holds. Validate their inputs and scope their side effects; fascicle
does not sandbox in-process tool execution.

## Supply-chain posture

Every dependency you add is attack surface, and an agent library that handles
credentials and can spawn a subprocess is a high-value target. The npm ecosystem
has seen the whole range of the threat: compromised maintainer accounts that
publish a malicious version, malicious `postinstall` or `preinstall` scripts that
run automatically on `npm install`, and typosquatted transitive dependencies.
fascicle's architecture is deliberately shaped to keep both its own footprint and
yours small.

### What keeps the surface small

- **No direct runtime dependencies.** fascicle's `package.json` has an empty
  `dependencies` field. `ai`, `zod`, and every provider SDK are *peer*
  dependencies you install explicitly, so installing fascicle pulls in no
  transitive tree of its own. You choose and audit what actually gets added.
- **Provider SDKs are optional peers, loaded lazily.** Installing fascicle does not
  drag in eight LLM SDKs; you install only the ones you call, and each is imported
  on first use rather than at load time.
- **No install scripts.** fascicle ships no `preinstall`, `install`, or
  `postinstall` hook, so the most common npm malware-execution path (code that runs
  automatically at install time) does not exist in this package.
- **A small, published artifact you can read.** The package publishes only `dist`,
  `README.md`, `CHANGELOG.md`, and `LICENSE`, as one package rather than a spread
  of separately publishable scoped packages. The diff you pin per release is small
  enough to review.
- **`pnpm audit` gate and pinned overrides.** `pnpm check:security`
  (`--audit-level=high`) tracks known advisories; transitive advisories are pinned
  with `overrides` (for example, `smol-toml` and `fast-uri`).
- **Manual, MFA-gated publishing with no long-lived npm credential in CI.**
  Releases are published from a maintainer machine behind multi-factor
  authentication; CI only turns a pushed tag into a GitHub Release and holds no npm
  token. This removes the steal-the-CI-token vector that has featured in several
  ecosystem compromises.
- **Commitments that resist surface growth.** No plugin registry, no integrations
  arms race, no hosted service: fewer moving parts, and fewer packages that can be
  independently compromised.

### Honest residual risk: fascicle is itself a dependency

fascicle is a dependency like any other, so it is also a vector. The risks worth
naming plainly:

- **Single-maintainer key risk.** fascicle is published by one maintainer, so a
  compromise of that account is the sharpest supply-chain risk to consumers, the
  same class of attack that has hit other agent frameworks. MFA reduces this risk;
  it does not remove it.
- **No build provenance yet.** Because publishing is manual rather than CI-driven,
  releases currently ship without a signed provenance attestation tying the
  published artifact to this repository and its build, so you cannot yet
  cryptographically verify that a given version was built from the source here.
  Provenance-attested CI publishing is a tracked hardening item; until it lands,
  pin an exact version you have reviewed.
- **fascicle does not vouch for your other dependencies.** Vulnerabilities in `ai`,
  a provider SDK, or their transitive dependencies remain your audit surface.
  fascicle avoids adding its own tree, but it cannot vet the peers you install
  alongside it.
- **Pre-1.0 support window.** Only the latest published minor receives security
  fixes (see the Supported versions section above); there is no back-porting.

For the subprocess trust boundary (`claude_cli` spawning the `claude` binary), see
the Subprocess and sandbox model section above; a compromise of the `claude` binary
itself is outside fascicle's control.

## Out of scope

The following are not fascicle vulnerabilities, though reports that show fascicle
mishandling them are welcome:

- Vulnerabilities in a provider SDK, the `claude` binary, or a model endpoint
  itself.
- Secrets leaked by your own harness reading `process.env` and logging it.
- Prompt-injection of a model you call. fascicle gives you the trajectory as an
  audit trail; deciding what a tool is allowed to do is your harness's job.
