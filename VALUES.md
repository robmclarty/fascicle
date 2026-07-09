# What fascicle stands for

This is the canonical statement of fascicle's values. It says what fascicle is
about, what it is deliberately not about, and why. Everything here is a choice made
on purpose, with real costs paid on purpose, not an accident and not a gap waiting to
be filled.

The one idea underneath all of them: fascicle is a **substrate, not a scaffold**. It
is a material you plant your agent in and shape as you like, the way voxels build into
any shape in Minecraft, rather than a mold that decides in advance what your agent is
allowed to be. It hands you building blocks and the freedom to combine them; it does
not hand you an opinion about what you are building.

## Freedom

fascicle exists to give you control, not to take it. You compose behavior from
primitives instead of picking from a menu of pre-built agents; you can see every step
and override every default; and you drive the agent rather than letting a vendor's
built-in loop drive you. Freedom here has three faces that are really one: freedom to
build any shape from small parts, freedom to inspect and change what runs, and freedom
from anyone else deciding those things for you. Convenience is welcome when it does not
cost control. When the two conflict, fascicle keeps the control and pays the
convenience.

## Composition over inheritance

Everything is a small value that snaps together with everything else. There is no
class hierarchy to extend, no base type to inherit from, and no central object to
register into: a step is a plain value, and every composer takes steps and returns a
step. This is the substrate idea made concrete. The primitives are deliberately few and
deliberately general, because a small set of parts that combine freely covers more
ground than a large set of parts that each do one thing. Functional and procedural, not
object-oriented, because substitution should always hold: anywhere one block fits, any
combination of blocks fits.

## Determinism first

The orchestrator is a deterministic script, not another model. In a model-driven
harness the thing coordinating the work is itself an agent: a model deciding what to
call and when. fascicle is intentionally the opposite. The outer layer is ordinary,
deterministic code that runs steps in a known order and threads each output into the
next input; a model call is one step among many, not the thing in charge. The instinct
is the same as a Big-O optimization: just as you minimize recursion and needless loops,
you minimize model calls. Reserve them for the steps that are genuinely
non-deterministic, keep them as few as you can, and prefer the smallest and most local
model that will do the job over a larger cloud one. The payoff is speed, lower CPU and
dollar cost, and predictability, repeatability, and stability over time. It also shrinks
blast radius: every model call is a point where behavior turns uncertain and an external
system gains some control, so each one is handed only what it needs and nothing more,
with as few connections as possible. Determinism is the default; the model is the
carefully rationed exception.

## Flexibility

Changing how your agent thinks should be as easy as editing a data structure, because
that is what it is. When control flow is composed values rather than a vendor's fixed
loop, reshaping the harness is a local edit, not a fight with a framework. This matters
most in a fast-moving field: models, providers, and patterns change from month to
month, and the cost of changing your mind should stay near zero.

## Legibility

You should be able to read a flow and predict what it does, and read a trajectory and
know what it did. No hidden retries, no ambient state, no magic that changes behavior
based on the environment. The trajectory is the truth of a run: what executed, in what
order, at what cost. A system you cannot see is a system you cannot trust in
production, so fascicle keeps the whole shape walkable and the whole run observable.

## Honesty

fascicle is opinionated about what it is and, just as importantly, about what it is
not. The refusals (no registry, no hidden caching, no framework lifecycle, no batteries
you did not ask for) are deliberate, with real costs, not features that are merely
missing. This document is part of that honesty. The point is to keep your eyes open
about the tradeoffs so you can decide whether they are your tradeoffs, rather than
discovering them the hard way later.

## Sovereignty

Your agent should outlive any one vendor's decisions. Model ids are opaque and passed
verbatim; providers are swappable by config; local models are first-class rather than an
afterthought. fascicle sits on top of vendor SDKs but keeps the load-bearing logic (the
loop, tool handling, cost, the audit trail) on your side of a thin seam, so a breaking
change, a price change, or a strategy change from a commercial provider is a contained
edit instead of a rewrite. You keep the right to change direction.

## Security and privacy

The smallest surface is the safest one. fascicle has no direct runtime dependencies,
runs no install scripts, and loads provider SDKs only when you call them, so it adds
little to your attack surface and nothing you did not choose. Local models are
first-class precisely so your data and your prompts can stay on machines you control.
The full posture, including the honest admission that fascicle is itself a dependency
and therefore a vector, lives in [SECURITY.md](./SECURITY.md).

## Interoperability

Inputs and outputs are plain values in standard shapes, so fascicle plays well with
code it did not write. Tools are plain functions; the Model Context Protocol is bridged
both ways; the trajectory is an event stream any tracing tool can consume. A substrate
you plant an app into has to connect cleanly to whatever is already growing in your
stack, not demand that the rest of the stack be rewritten in its terms.

## No commercial capture

fascicle will not become the thing it protects you from. There is no hosted service, no
dashboard, no account, and no plan to add one, because the moment a library has a
product to sell, its design starts optimizing for the product instead of for you. It is
Apache-2.0 and forkable, which makes even trust in the maintainer optional: if the
project ever drifts from these values, you can take the code and leave.

## Replies to criticisms

None of these values is free. Here are the strongest objections and the honest answers.

### "This is just more rope. A convenience framework is easier."

True, and for some projects that is the right call. If your whole product is one agent
with a few tools and a chat box, a batteries-included framework will get you there
faster and fascicle is overhead. fascicle is for the case where you want control and
will use it: composing non-trivial flows, swapping providers, running locally, keeping a
system legible a year later. Defaults exist so the common path is short; they are just
never locked. The rope is the point, for the people who want to tie their own knots.

### "Narrow means missing batteries: no RAG, no memory, no evals."

On purpose. Those are applications you build on the substrate, or separate tools you
compose in, not things baked into the material. Baking them in would make fascicle
heavier, more opinionated, and coupled to one way of doing retrieval or memory, which is
exactly the lock-in it exists to avoid. The bet is that a good substrate plus the tool
you actually want beats a big framework plus the three tools it chose for you.

### "No registry and no ambient state means more manual wiring."

Yes. You pass adapters per run and wire dependencies explicitly instead of registering
them into a global and looking them up by name. That is more to type. It is also why two
runs never interfere, why a flow is testable without a harness, and why you can read a
call site and know everything it touches. The explicitness is the feature; the wiring is
the price, and it is paid in clarity.

### "Author-composed control flow makes you do work the model could do."

A real philosophical fork. Some tools trust the model to plan and orchestrate its own
loop; fascicle lets you compose the control flow explicitly, with a model call as one
part among plain functions. This is a bet about where reliability comes from: legible,
testable structure over pure model autonomy. It is not a rejection of model-driven
agents. A model-driven agent is exactly the kind of thing fascicle wraps as a single
step, so you can choose autonomy where you want it and structure where you need it.

### "Minimizing model calls is premature optimization. Let the model handle it."

Sometimes it is, and when a step is genuinely ambiguous you should use a model without
guilt. But a model call is not only a cost line; it is a source of variance, latency,
and external dependency, and those compound. A flow that is mostly deterministic with a
few well-scoped model calls is faster, cheaper, easier to test, and far more stable
across model and provider changes than one that routes every decision through a model
that decides what to do next. You can always add model autonomy to a step later; you
cannot easily add predictability back to a system that has outsourced its control flow.

### "A solo, pre-1.0 library is a risk to depend on."

It is, and pretending otherwise would violate the honesty value. The mitigations are
structural: it is small and readable, it is Apache-2.0 and forkable, and it is a library
you can excise one piece at a time rather than a framework you are wedded to. The
intended way to adopt it is as an ordinary pinned dependency, with your own code in your
own repository built on its public contracts. That keeps the blast radius small and the
exit cheap.

### "You are reinventing libraries that already exist."

fascicle does not replace the vendor SDKs; it is built on them. It owns the layer above
the single model call: the loop, tool handling, composition, cost, and the trajectory.
That layer is where the values live, and it is a different layer from the provider
plumbing underneath. Where an existing tool already gives you what you need, use it.
fascicle is for when you want that seam to be yours.

## The through-line

These are choices, made on purpose, with costs paid on purpose. The single idea under
all of them is that fascicle is a substrate, not a scaffold: a material you plant your
agent in and shape as you like, not a mold that shapes your agent for you. It hands you
building blocks and the freedom to combine them, keeps the result legible and portable,
and refuses to grow into the kind of thing that would take that freedom back.

If those are your values too, fascicle will feel like it is on your side. If they are
not, it will feel like too much rope, and one of the friendlier frameworks it declines
to become will serve you better. Both outcomes are honest, and both are by design.

## See also

- [SECURITY.md](./SECURITY.md) - the supply-chain posture and its residual risks.
- [docs/comparison.md](./docs/comparison.md) - where fascicle sits among its neighbors.
- [docs/adoption-decision.md](./docs/adoption-decision.md) - a go/no-go framing for
  adopting fascicle, including when to reach for something else.
