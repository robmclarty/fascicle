# Research

This folder holds longer-form thinking that sits alongside the project: white papers, design explorations, strategy notes, and the diagrams that go with them. It is deliberately separate from `docs/`.

## How this differs from `docs/`

`docs/` is living reference material for people using the project. If the code changes, the docs change. Stale content there is a bug.

`research/` is the opposite. Entries here are **snapshots of thinking at a moment in time**. They may describe things the code doesn't implement yet, approaches we considered and rejected, or theoretical groundwork that informs the design without being directly reflected in it. A piece from a year ago can still be valuable even if the codebase has moved on.

If you're trying to *use* the project, start in `docs/`. If you're trying to understand *why it is the way it is*, or the thinking behind where it might go, start here.

For short, decision-focused records ("we chose X over Y because Z"), see `docs/adr/` instead. ADRs live with the docs because contributors need them while working in the code. Longer exploratory pieces live here.

## Layout

```
research/
├── README.md              # this file
├── papers/                # formal long-form pieces, numbered
├── explorations/          # drafts, spikes, working notes
└── assets/
    └── diagrams/          # shared diagram sources and exports
```

### `papers/`

Formal, considered pieces. Numbered sequentially with a short slug:

```
0001-intent-engineering.md
0002-meta-harness-architecture.md
0003-provider-abstraction.md
```

Numbers are never reused, even if a paper is superseded or removed. The number is a stable identifier other documents can cite.

### `explorations/`

Less formal. Spikes, working notes, research roundups, half-formed thinking that isn't ready to be a paper (and may never be). Named with a date prefix so chronology is obvious:

```
2026-04-provider-abstraction-notes.md
2026-05-swe-bench-findings.md
```

Content here is expected to be rougher. Don't let the bar for "paper-worthy" prevent useful thinking from being captured.

### `assets/diagrams/`

Shared diagram assets referenced by more than one document. Diagrams owned by a single paper can live next to that paper instead; only promote to the shared folder when there's a real reason to.

## Frontmatter

Every document in `papers/` and `explorations/` starts with YAML frontmatter:

```markdown
---
title: Meta-Harness Architecture
status: draft
date: 2026-04-15
author: rob
supersedes: 0001-intent-engineering.md   # optional
tags: [harness, architecture, agents]    # optional
---
```

The `status` field is the important one. It tells a reader immediately whether they're looking at current thinking or an artifact:

- **`draft`**: in progress, not ready to be cited
- **`accepted`**: considered current thinking, actively informs the project
- **`superseded`**: replaced by a newer piece (use the `supersedes` field on the replacement to link back)
- **`historical`**: preserved for context but no longer reflects current direction

`historical` is not a failure state. Projects evolve, and keeping the paper trail intact is more valuable than pruning it. Mark it, don't delete it.

## Diagrams

**Text-based diagrams** (Mermaid, PlantUML, Graphviz) go inline in the markdown. They diff cleanly, render on GitHub, and don't need separate asset files.

**Binary-source diagrams** (Excalidraw, tldraw, draw.io, Figma exports) follow a two-file convention: commit the source alongside an exported SVG or PNG, named identically.

```
harness-phases.excalidraw     # editable source
harness-phases.svg            # referenced from markdown
```

Reference the export from the markdown. Keep the source next to it so the diagram is editable by anyone who opens the repo, not just the original author.

For Figma or other cloud-hosted tools, treat the exported SVG as canonical and drop a link to the cloud source in a comment or in the document itself.

## Writing conventions

**Audience**: assume a technically literate reader who is not necessarily a contributor. Link to concepts in `docs/` rather than re-explaining them.

**Length**: no limits in either direction. A two-page note is fine if two pages is what the idea needs. Don't pad, don't artificially split.

**Citations**: link generously. External papers, blog posts, other documents in this folder. If a claim rests on something, make it traceable.

**Voice**: first-person is fine. These are considered pieces of thinking, not neutral reference material, and pretending otherwise makes them worse.

**Updates**: prefer writing a new document that supersedes an old one over editing the old one in place. The exception is fixing typos, broken links, or clarifying wording that doesn't change the substance. If thinking has genuinely moved on, that's a new paper with a `supersedes` pointer, and the old paper's status flips to `superseded`.

## Adding a new piece

1. Decide whether it's a `paper` or an `exploration`. When in doubt, start as an exploration; it can be promoted later.
2. For papers, pick the next unused number. For explorations, use today's date as the prefix.
3. Add frontmatter with `status: draft` and fill in the rest.
4. If it supersedes something, update the superseded document's status and add a note at the top pointing to the replacement.
5. Open a PR. Research pieces are reviewed for clarity and internal consistency, not for agreement with their conclusions. It's fine to merge a paper whose ideas are still being debated, as long as its status reflects that.

## Index

A running index of accepted papers, grouped by theme, lives at the bottom of this README. Update it when a paper's status changes to `accepted` or `superseded`.

### Accepted

*(none yet)*

### Superseded

*(none yet)*

### Historical

*(none yet)*
