# Security Policy

Fascicle is a library that wires LLM calls, tool calls, and subprocesses into
typed workflows. That puts it on the path of API credentials, model output, and
a spawned child process (the `claude_cli` provider's, or a shell command that a
coding agent runs through `fascicle/acp`), so the security model below is worth
reading before you wire it into anything sensitive.

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

- **The library doesn't read credentials from `process.env`.** Provider
  credentials are passed explicitly into `create_engine({ providers })`; reading
  them from the environment is the harness's job, done at its own boundary. An
  internal rule (`no-process-env-in-core`) enforces this across `src/`, with two
  audited exceptions that build a subprocess environment: the `claude_cli`
  adapter and the opt-in `forward_standard_env()` helper. See
  [docs/configuration.md](./docs/configuration.md).
- **Credentials are not persisted or logged by Fascicle.** They live only in the
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
  subprocess. Under `api_key`/`auto` the child inherits only the standard keys
  (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`) plus the values
  you pass, and `inherit_env: false` starts it from an empty environment.
- Fascicle tools that carry an `execute` closure cannot run inside the
  subprocess. The default `tool_bridge: 'allowlist_only'` only adds tool *names*
  to the CLI's own allowlist and silently drops the closures; use
  `tool_bridge: 'forbid'` when you need a hard guarantee that no `execute` closure
  becomes a silent no-op.
- For untrusted work, confine the subprocess with `sandbox: { kind: 'bwrap' |
  'greywall', network_allowlist, additional_write_paths }`. Under `bwrap`, an
  empty `network_allowlist` means network-off, and a non-empty one shares the
  host network without filtering it. Under `greywall`, greyproxy enforces the
  allowlist. Full details in [docs/cli.md](./docs/cli.md).

Tools you pass to a model call run **in your process**, with whatever privileges
your process holds. Validate their inputs and scope their side effects; Fascicle
does not sandbox in-process tool execution.

## Workspace tools (`fascicle/acp`)

`workspace_tools` gives a coding agent that's served over ACP six tools that
act on your machine from inside the agent's process. `read_file`, `list_files`,
and `search` read files, `write_file` and `edit_file` change them, and
`run_command` runs a shell command. The model decides when to call them, and
anything it reads (a README, a code comment, the output of a command) can try
to steer it. So treat whatever the tools can reach as something a prompt
injection can reach too.

- **The file tools stay inside the workspace.** A path is allowed only when its
  real path, with every symlink resolved, lands under the session's `cwd` or
  under one of the additional directories that the client sent. An agent can
  refuse additional directories with `additional_directories: false` in its
  config, which keeps each session's file tools to `cwd` alone. A symlink that
  points out of the workspace is refused, and so is a new file whose nearest
  existing parent sits outside it. Inside the workspace the reads see
  everything you keep there, `.env` files included, since nothing reads
  `.gitignore`. The writes stay out of two places. In every mode, `write_file`
  and `edit_file` refuse any path that passes through a file or a directory
  named `.git` or `node_modules`. Git runs what its directory holds, a package
  manager runs what `node_modules` holds, and a change in either never shows in
  `git diff`, so an edit there would be code that runs on your next command
  without your ever seeing it. Every other file that git ignores stays
  writable, and an edit to one is just as invisible to `git diff`, so Manual is
  the mode for a checkout whose ignored files matter. If you find a file tool
  that reaches a path outside the workspace, that's a Fascicle vulnerability,
  so please report it.
- **Containment binds the file tools only.** `run_command` hands its string to
  `/bin/sh`, and a shell can read and write anything you can, including
  `~/.ssh`, `~/.aws`, your other repositories, and the network. The workspace
  boundary doesn't apply to a command at all. That's why Manual, the mode a
  session starts in, asks you before every command, and why Accept edits still
  does.
- **Commands inherit the agent's environment by default.** That includes the
  provider keys in your editor's agent server entry, so a command the model
  runs can read `OPENROUTER_API_KEY` and send it anywhere. `command_env` in
  `WorkspaceToolsOptions` replaces the environment whole, with nothing merged
  in, and `examples/acp-coder` builds it from `process.env` minus the keys that
  its providers read. Fascicle itself still reads no `process.env`, because
  your harness makes that copy at its own boundary.
- **Permission prompts fail closed.** A call that asks runs only when you
  choose an allow. A rejection, a cancelled prompt, and a request that fails
  for any reason all deny it. An "always" grant lives in memory for one session.
  For a command, it covers that exact command line, with only the whitespace at
  its ends ignored. A command with shell control syntax (`;`, `&`, `|`, `>`, `<`, a
  backtick, `$(`, or a newline) is never covered and never offered a grant, so
  `pnpm test && curl … | sh` asks you every time.
- **Auto asks for nothing.** It edits files and runs commands with nobody
  watching, so run it in a container or a throwaway worktree that holds no
  credentials you'd mind a command reading. A container doesn't hide the
  provider key that the agent itself needs, so pair it with `command_env`. An
  agent that runs on the host can leave Auto out with
  `modes: ['manual', 'accept_edits']` in its config. No client can then switch
  a session into Auto, and every command asks before it runs unless you've
  allowed that exact command line for the session.

[docs/acp.md](./docs/acp.md#coding-sessions) covers the tools, the modes, and
the prompts in full.

## Supply-chain posture

Every dependency you add is attack surface, and an agent library that handles
credentials and can spawn a subprocess is a high-value target. The npm ecosystem
has seen the whole range of the threat: compromised maintainer accounts that
publish a malicious version, malicious `postinstall` or `preinstall` scripts that
run automatically on `npm install`, and typosquatted transitive dependencies.
Fascicle's architecture is deliberately shaped to keep both its own footprint and
yours small.

### What keeps the surface small

- **No direct runtime dependencies, and zero mandatory peers.** Fascicle's
  `package.json` declares no `dependencies` at all, and `ai`, `zod`, and every
  provider SDK are *optional peer* dependencies you install explicitly, so
  `pnpm add fascicle` alone pulls in no transitive tree of its own. You choose
  and audit what actually gets added.
- **Provider SDKs and the schema library are optional peers, loaded lazily.**
  Installing Fascicle does not drag in eight LLM SDKs or a schema library; you
  install only what you call, and each is imported on first use rather than at
  load time. Schemas accept any Standard Schema implementation, so the one you
  already use works without Fascicle naming it.
- **No install scripts.** Fascicle ships no `preinstall`, `install`, or
  `postinstall` hook, so the most common npm malware-execution path (code that runs
  automatically at install time) does not exist in this package.
- **A small, published artifact you can read.** The package publishes only `dist`,
  `README.md`, `CHANGELOG.md`, and `LICENSE`, as one package rather than a spread
  of separately publishable scoped packages. The diff you pin per release is small
  enough to review.
- **An on-demand `pnpm audit` and pinned overrides.** `pnpm check:security` runs
  `pnpm audit --audit-level=high` through the check suite's `security` slot. It
  runs when someone asks for it rather than on every `pnpm check`, so CI doesn't
  fail on a new high advisory. The trade is deliberate. An advisory with no
  patched release yet would otherwise hold every build red and block the publish
  job, and no change in this repo can clear it. Transitive
  advisories are cleared by lifting the pin in `pnpm-workspace.yaml` `overrides`,
  never by widening the level.
- **Provenance-attested CI publishing with no long-lived npm credential
  anywhere.** Releases are published by CI via npm Trusted Publishing (OIDC): the
  registry trusts the release workflow's identity, minted per run, so no npm token
  exists to steal or rotate. This removes the steal-the-CI-token vector that has
  featured in several ecosystem compromises. The publish job pauses on a protected
  GitHub Environment (`npm-publish`) until a maintainer approves it, preserving
  the human gate that manual MFA-prompted publishing used to provide, and each
  release ships with a signed provenance attestation tying the tarball to this
  repository, commit, and workflow run.
- **Commitments that resist surface growth.** No plugin registry, no integrations
  arms race, no hosted service: fewer moving parts, and fewer packages that can be
  independently compromised.

### Honest residual risk: Fascicle is itself a dependency

Fascicle is a dependency like any other, so it is also a vector. The risks worth
naming plainly:

- **Single-maintainer key risk.** Fascicle is published by one maintainer, so a
  compromise of that account is the sharpest supply-chain risk to consumers, the
  same class of attack that has hit other agent frameworks. MFA reduces this risk;
  it does not remove it.
- **Provenance proves where a release was built, not that it is safe.** Every
  release from v0.9.0 on carries an attestation you can verify with
  `npm audit signatures` (or the provenance badge on npmjs.com), proving the
  tarball was built by this repository's publish workflow from a specific commit.
  It does not prove the source at that commit is benign; keep pinning exact
  versions you have reviewed. Releases published through the documented
  break-glass path (manual, when CI is unavailable) lack an attestation and are
  noted as such in the release.
- **Fascicle does not vouch for your other dependencies.** Vulnerabilities in `ai`,
  `zod` or another schema library, a provider SDK, or their transitive
  dependencies remain your audit surface. Fascicle avoids adding its own tree,
  but it cannot vet the peers you install
  alongside it.
- **Pre-1.0 support window.** Only the latest published minor receives security
  fixes (see the Supported versions section above); there is no back-porting.

For the subprocess trust boundary (`claude_cli` spawning the `claude` binary), see
the Subprocess and sandbox model section above; a compromise of the `claude` binary
itself is outside Fascicle's control.

## Out of scope

The following are not Fascicle vulnerabilities, though reports that show Fascicle
mishandling them are welcome:

- Vulnerabilities in a provider SDK, the `claude` binary, or a model endpoint
  itself.
- Secrets leaked by your own harness reading `process.env` and logging it.
- Prompt-injection of a model you call. Fascicle gives you the trajectory as an
  audit trail; deciding what a tool is allowed to do is your harness's job.
