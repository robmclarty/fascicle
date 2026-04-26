---
title: Naming — library and UI (fascicle + weft)
status: draft
date: 2026-04-24
author: rob
tags: [naming, branding, ux]
---

# Naming — library and UI

Working notes from picking a name pair for the library + the visual UI app that sits on top of it. Captured here because the evidence (npm availability, real-world brand collisions, metaphor fit) took real work to gather and I don't want to redo it in six months if I second-guess myself.

## Starting position

Three pair-candidates on the table:

1. **funitel + patchbay**
2. **bouton + plexus**
3. **fascicle + commissure**

Gut lean was funitel + patchbay. Patchbay is the audio-engineering term for the panel where you physically route signals between gear — a near-ideal mental model for a visual node editor. Funitel is the French-coined dual-cable aerial lift: two parallel cables for stability in high wind, which is a fun redundancy metaphor that echoes `parallel`, `ensemble`, `retry`, `fallback`.

Real-world checks broke that gut.

## npm reality (all checked against the registry directly)

| name | unscoped status | notes |
|---|---|---|
| `funitel` | **available (404)** | clean |
| `fascicle` | **available (404)** | clean |
| `patchbay` | taken (200) | active-ish: Dominic Tarr's SSB/Scuttlebutt work, last published 2022 |
| `plexus` | taken (200) | dead squatter (v0.0.1 from 2014) |
| `bouton` | taken (200) | "a framework to build your reactive library", last 2022 |
| `commissure` | **available (404)** | clean |
| `weft` | taken (200) | universally taken for common nouns, but no significant brand |
| `synapse` | taken (200) | dead 2011 HTTP-event-framework squatter |
| `loom` | taken (200) | and Loom.com dominates the SERP |

Key realization: every common English noun is squatted on unscoped npm, usually by an abandoned 2012–2014 single-commit package. This is not a reason to avoid a name. **Scoped packages (`@derailleur/<name>`, `@robmclarty/<name>`) are the modern norm** — Vercel, TanStack, Anthropic, Shopify, Next.js, every serious ecosystem publishes under a scope. The unscoped registry is a historical squatters' forest, not the actual constraint. The real constraint is SERP collision and brand recognizability.

## Dropping commissure

Three problems, all fatal:

- **Obscure.** A commissure is the neural bridge joining bilateral structures (corpus callosum, anterior commissure). Doctors know it. Biologists know it. Developers don't.
- **Unspellable on first hearing.** The double-consonant + `-ure` ending invites misspellings (`comissure`, `comisure`, `commisure`). Three common spellings means two ways to fail every search.
- **Unexciting on its own.** "Commissure" is a *passive* anatomical structure. It just sits there being a bridge. Product names want a verb in them — something that *happens*. Commissure fails that test.

The metaphor was beautiful on paper (a bridge between fascicle structures), but the name has to survive first-hearing, first-spelling, and first-pronouncing, and it fails all three.

## Keeping fascicle

Initial worry I talked myself into: phonetic adjacency to "fascist" (same first syllable "fass-", same Latin root *fascis* = "bundle"). User pushed back, and after actually searching brand-confusion write-ups and pronunciation discussions, **zero results support it as a documented concern**. I was projecting an association I'd invented, not citing one anyone had documented. Retracted.

Reasons to keep fascicle:

1. **Knuth association.** *The Art of Computer Programming* ships in "fascicles" — Volume 4, Fascicle 5, etc. For a library that markets itself on craft and rigor (`.ridgeline/taste.md`, the architectural enforcement story), association with Knuth is brand gold. Technical readers register it immediately as a prestige signal, not a collision.
2. **Metaphor precision.** "A bundle of parallel fibers sharing a connective tissue sheath" is not adjacent to step-as-value composition — that *is* step-as-value composition. `sequence`, `parallel`, `ensemble`, `scope` all produce bundled flows sharing a typed sheath. Derailleur's taste document even talks about "bundles" implicitly.
3. **Pronunciation is solved.** `/ˈfæsɪkəl/` — "FASS-i-kul". Every educated English speaker reads it correctly on first sight. In every dictionary.
4. **No significant brand collision.** "Fascile Technologies" is a different spelling (one c). No major software product owns it.

## The UI-name hunt

With fascicle kept, the UI name had to:

- Complement the metaphor world fascicle opens (fiber bundles, anatomy, publishing)
- Be exciting on its own (commissure's fatal flaw)
- Be easy to spell and pronounce
- Survive first-hearing without explanation
- Not be dominated by an unrelated SaaS brand

### Neural family — synapse, axon, dendrite

`synapse` was the obvious first pick. Everyone has met the word in middle-school biology. Short, spellable, active ("where signals cross"). The unscoped npm squatter is a dead 2011 HTTP framework — negligible.

Killed by SERP collision:

- **Azure Synapse Analytics** (Microsoft's data warehouse) — billions of dollars of enterprise mindshare
- **Synaptics Inc.** — the touchpad/peripheral company, public, ~40 years old
- **Synapse AI / Synapse Pixels / ~12 other medtech startups**

Three dominant commercial meanings, all in the tech/SaaS adjacency where derailleur lives. Unwinnable.

`axon` and `dendrite` have the same problem one layer down: Axon Enterprise (the Taser company, public), TJ Holowaychuk's old messaging library (abandoned but recognized), and an actively maintained 2024 `dendrite` package. Also, the metaphor weakens — dendrites *receive* signals, but a node editor isn't specifically a receiver.

### Textile family — loom, weft, shuttle, warp

The textile family turned out to be the strongest fit because **fascicle is already a fiber metaphor**. A fascicle is a bundle of parallel fibers. The next step in textile is weaving those fibers into cloth. So fascicle → textile is not a pivot; it's the natural follow-through.

- **Loom** — best metaphor on the whole list. Most recognizable word. Would have been #1. Killed by Loom.com — $975M Atlassian acquisition, dominant video-messaging brand. "Check it out in Loom" already means something. Do not pick this fight.
- **Shuttle** — the mechanical carrier threading across the loom. Active, mechanical (echoes derailleur). But: space shuttle, shuttle diplomacy, shuttle bus. Ambiguous. The primary association isn't textile.
- **Warp** — the lengthwise threads on a loom. Killed by: warp speed, time warp, Meta's PyTorch "warp", WarpTool, Warp terminal (the actual 2022 Rust-based terminal app, active). Too colonized.
- **Weft** — the crosswise thread that crosses the warp and binds the fibers into cloth. **Survived everything.** No dominant SaaS brand. Rare enough to own. Common enough to teach.

### Book-publishing family — quire, folio, colophon

Pairs with fascicle's installment-publishing meaning (Knuth again):

- **Quire** — a gathering of folded sheets, the unit of book binding. Lovely. Collides with Quire.io (task management, active). Workable but adds friction.
- **Folio** — a volume format. Massively colonized as a brand name for design/portfolio products.
- **Colophon** — the decorative mark at the end of a printed book. Rarest, prettiest. Pairs with fascicle beautifully. **But** — fails the "exciting on its own" test for the same reason commissure did: too obscure, requires explanation on first hearing.

### Other candidates considered and rejected

- **Rhizome** — Deleuzian underground-network metaphor. Intellectual cachet but pretentious for a dev tool. The `-ome` noun suffix is crowded (biome, genome, microbiome).
- **Mycelium** — fungal network. Overused in tech-philosophy writing. Longer.
- **Atrium** — anatomical second meaning (heart chamber), central open space. Inoffensive, uninspiring.
- **Aperture** — observability metaphor (lens, opening). Decent but weaker than weft: aperture is about *seeing* the flow; weft is about *building* it. If the UI does both, weft is more load-bearing.
- **Forge / anvil / bench** — crafting words. Too generic. "Forge" is a product name in ~50 places.
- **Cadence** — echoes derailleur (pedaling cadence). Killed by Cadence Design Systems ($74B market cap) and Uber's Cadence workflow engine.
- **Atelier** — French workshop, pairs phonetically with derailleur. But unfamiliar to English speakers, hard to spell, and the JRPG series Atelier is a real collision.

## Decision: fascicle + weft

**Library:** `fascicle` (published as `@robmclarty/fascicle` or `@derailleur/fascicle`, scope TBD).

**UI:** `weft` (published as `@derailleur/weft` — scope all the way given the name's commonness).

### Why this is the right pair

1. **The metaphor is load-bearing in both directions.** A fascicle is a bundle of parallel fibers sharing a sheath. A weft is the crosswise thread that weaves those fibers into cloth. "Compose your flow as a fascicle; weave fascicles together on weft" is a two-word pitch that teaches itself.
2. **Neither word fights a dominant brand.** Both have inactive npm squatters (ignorable under scopes). Neither word is owned by a SaaS giant. SERP is clean.
3. **Rhythmically balanced.** Three syllables + one. Sibilant + fricative. "Fascicle and weft" has cadence (ironic given the reason cadence itself was rejected).
4. **Both spellable, both pronounceable.** `/ˈfæsɪkəl/` and `/wɛft/`. Dictionary-standard, unambiguous.
5. **Knuth-adjacency on fascicle is free brand equity** for the craft-rigor audience derailleur targets.
6. **Weft is the rare dev-name that's short, evocative, and uncolonized.** That combination is vanishingly hard to find in 2026.

### What this displaces

- `derailleur` as the library name becomes historical. Keep the directory and workspace `@repo/*` structure but rename the published package to `@robmclarty/fascicle` (or `@derailleur/fascicle` if we keep derailleur as a scope / umbrella / meta-brand).
- One option worth considering: **derailleur stays as the GitHub org / scope / overarching brand**, while fascicle is the specific library inside it. That keeps the bicycle-mechanical heritage at the org level and the biological-textile world at the library/UI level. Two metaphor worlds that don't collide because they're at different tiers.
- `commissure`, `bouton`, `plexus`, `funitel`, `patchbay`, `synapse`, `loom` all dropped.

## Standing commitments

- **Scoped packaging always.** Do not chase unscoped npm names. `@derailleur/fascicle` and `@derailleur/weft` (or `@robmclarty/*`) are the published shapes. Unscoped is a 2014 concern.
- **Do not rename again without this much evidence.** Naming churn is costly; the evidence here is the reason to stop second-guessing.
- **If a collision emerges** — if a prominent product ships as "Weft" or "Fascicle" — revisit. Not before.

## Open questions

- **Does derailleur stay as the scope / org / repo name, or does fascicle inherit everything?** My inclination: keep the derailleur GitHub org and monorepo directory (`code/derailleur/`), rename the published package to fascicle, and position weft as the companion UI under the same org. Two metaphor tiers, one project.
- **Is there a third companion name** for docs / CLI / playground that extends the textile world? Candidates: `shuttle` (the active weaving mechanism — could be the CLI that runs flows), `reed` (the loom part that beats the weft into place), `heddle` (the part that lifts specific warp threads). Defer until a third surface actually needs naming.
- **Logo / visual identity** should probably riff on woven or fibrous forms. Not decided; not urgent.
