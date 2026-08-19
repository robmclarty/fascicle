---
name: prose
description: Write or revise prose in this repo (docs/, README, AGENTS, VALUES, CONTRIBUTING, SECURITY, or a doc comment) so it reads in the author's voice rather than a compressed register. Use when editing any markdown prose, when `pnpm check` fails the `prose-health` or `prose` slot, or when asked to review, tighten, or rewrite documentation. Carries the decompression method, the traps that break markdown structure, and the measurement that says whether it worked.
---

# prose

The mechanical rules live in `.vale/styles/Repo/*.yml` and gate at error level. The voice lives in `.vale/exemplars/`. This skill is the third thing: the *shape* of a sentence, which neither a rule nor an exemplar can enforce, and which is where this repo's docs actually go wrong.

## The failure mode

Docs here drift toward prose that is individually correct and collectively airless. Every rule passes, every sentence parses, and the whole page reads like a specification because the clauses have been packed into modifiers:

| compressed | decompressed |
|---|---|
| a bot **wired to** a managed vector index | a bot **that's wired to** a managed vector index |
| an arm **returning** `{ winner, scores }` | an arm **that returns** `{ winner, scores }` |
| spans **emitted** without a parent | spans **that are emitted** without a parent |
| the failure mode **observed** everywhere | the failure mode **that turns up** everywhere |
| It diverges **by being** a framework with a lifecycle | It's a framework **that owns** a lifecycle |
| the event stream a composition library emits | the event stream **that** a composition library emits |
| for shapes bindings can't express | for the shapes **that** bindings can't express |

The common thread is a missing finite verb. A participle (`wired`, `returning`, `emitted`) or a bare noun stack does a clause's work, and the reader has to reconstruct the verb. Giving it back is the whole method.

## The one rule that matters

**Never insert a word to move a number.** The measurement counts `that`; a compressed sentence is fixed by rewriting it into a finite clause, and the `that` shows up as a by-product. Adding `that` to an object relative that reads fine already (`a set of functions you can call` → `a set of functions that you can call`) raises the score and makes the prose worse. The exemplars themselves drop object relatives constantly; their high density comes from **subject** relatives, where `that` is grammatically obligatory. That distinction is the whole game.

Corollary: if you cannot say which sentence got better, you did not improve it.

## Method

1. **Read the exemplars first.** All seven, every time, before writing a word. About 4.2k tokens. They are read-only by contract and the `exemplars` check fails on any diff, whitespace included.
2. **Measure before you touch anything.** `node scripts/prose-health.mjs --report`.
3. **Sort by genre, not by score.** Explanatory prose (comparison, concepts, blueprint, leaf-arm-spine, deliberation, adoption-decision) can carry essay density. Reference material (api-reference, providers, configuration, composition, cli) is tables and signatures, and **a table row has no relative clause to restore**. Say so in your report instead of forcing it. The `code` and `tbl` columns in the report show you which is which.
4. **Read the file and fix sentences.** Not patterns, sentences. `--file <path>` lists the longest ones as a starting point.
5. **Re-run `pnpm check --only prose` after every file.** Restructuring very easily produces a sentence opening on "There is", which gates at error.
6. **Verify structure, then measure again.**

## What is *not* the problem

Diagnostic work already done, twice. Do not redo it:

- **Not stripped complementizers after report verbs.** Grepping `means|shows|ensures|notes|assumes` + noun phrase across docs/ returns almost nothing.
- **Not restrictive `which` wanting to be `that`.** docs/ uses `which` *less* than the exemplars do.
- **Not present-participial post-modifiers** ("steps needing X"). There were exactly two in the whole corpus.
- **It is past-participial post-modifiers and noun stacks.** This is the live one and it is everywhere.

## Why there is no regex for it

A detector for participial post-modifiers was built, measured, and deliberately not shipped. On a labelled corpus (pre-pass vs post-pass docs) it scored roughly 50–70% precision and its before/after delta sat inside its own noise. The reason is structural: without part-of-speech tagging, *simple past with an object* is indistinguishable from *participle with an object*.

> `the token limit truncated the response` (finite verb, fine)
> `an arm returning the winner` (participle, compress)

Both match `<noun> <verb-ed|-ing> <determiner>`. Getting this right needs a POS tagger, which is a dependency, and AGENTS.md says not to add those casually. So the constructions live in the table above, for a reader to apply, and the check measures only what needs no tagging. **Do not re-attempt the regex** unless you are bringing a tagger.

## Traps

1. **`ThereIs` gates at error.** Restructuring produces `There is` / `There are` openings constantly. Re-run `pnpm check --only prose` after every file.
2. **`EmDash`, `Semicolon`, `Colon` gate at error.** An aside takes round brackets. One semicolon and one colon to a sentence. A single em dash between clauses is a pause and is fine.
3. **`HeadingCase` gates `docs/*.md`** (Chicago). Headings are Title Case and **their slugs are load-bearing** — 53 anchor links point at them. Never reword a heading without checking every `](#anchor)` target.
4. **Naming.** `Fascicle` in prose, `fascicle` only as an identifier (the package, the `fascicle/*` subpaths, the `fascicle-viewer` binary).
5. **Reflowing markdown eats list structure.** If you rewrap a paragraph, a bullet list with no blank lines between items merges into one paragraph. Treat a list marker as a hard block boundary. This has caused real damage twice.
6. **Every file has its own wrap width** (76 to 113). Preserve each file's; do not impose one.
7. **Whole-block replacement loses indentation.** Matching a block by collapsed whitespace and replacing it will silently double or drop the leading indent inside a list item. Check the result.
8. **Never re-baseline to clear a failure you introduced.** Applies to `checkride.baseline.json` and `.prose-health.json` alike.
9. **Never suppress.** No inline vale comments.

## Verify before you commit

Beyond `pnpm check:all`:

- **Structure is unchanged.** For every file touched, compare heading count, list-item count, fence count, and link count against the previous commit. They must be identical. This has caught real damage: a reflow that silently merged four bullets and a six-item numbered list into one paragraph.
- **Anchors still resolve.** Generate the GitHub slug for every heading and match every `](#…)` target.
- **Grep your own diff** for the failure modes of mechanical editing: doubled connectives (`, so … , so`), subject-verb disagreement left by a person change (`you wants`, `It runs …, have a judge read …, and only pay`), and object pronouns contracted with the next clause's verb (`nothing in it's still a step`).

Each of those has happened here. The third one shipped.

## Reporting

Give the before and after number, and **state plainly which files you judged should not move, and why**. A smaller honest delta beats a larger forced one. "The remaining gap is genre and should not be closed" is a legitimate result.

## Reference

- `node scripts/prose-health.mjs` — ratchet against the baseline (the `prose-health` check)
- `node scripts/prose-health.mjs --report` — full table, always exits 0
- `node scripts/prose-health.mjs --file docs/x.md` — one file, all metrics, longest sentences
- `node scripts/prose-health.mjs --update` — rewrite the baseline (deliberate act, own commit, state the reason)
- `.check/prose-health.json` — structured output
- Benchmark: `docs/regression-testing-model-behavior.md` sits at target with no intervention, because it is written as an essay. It is a better reference for this repo's own voice than the exemplars are for a docs page.
