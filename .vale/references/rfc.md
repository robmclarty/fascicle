<!-- source: https://github.com/rust-lang/rfcs/blob/master/0000-template.md 

Note: Explain the proposal as if it was already included in the language and teach it by example.
-->

## Template

- Feature Name: (fill me in with a unique ident, `my_awesome_feature`)
- Start Date: (fill me in with today's date, YYYY-MM-DD)
- RFC PR: [rust-lang/rfcs#0000](https://github.com/rust-lang/rfcs/pull/0000)
- Rust Issue: [rust-lang/rust#0000](https://github.com/rust-lang/rust/issues/0000)

## Summary
[summary]: #summary

One paragraph explanation of the feature.

## Motivation
[motivation]: #motivation

Any changes to Rust should focus on solving a problem that users of Rust are having.
This section should explain this problem in detail, including necessary background.

It should also contain several specific use cases where this feature can help a user, and explain how it helps.
This can then be used to guide the design of the feature.

This section is one of the most important sections of any RFC, and can be lengthy.

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

Explain the proposal as if it was already included in the language and you were teaching it to another Rust programmer. That generally means:

- Introducing new named concepts.
- Explaining the feature largely in terms of examples.
- Explaining how Rust programmers should *think* about the feature, and how it should impact the way they use Rust. It should explain the impact as concretely as possible.
- If applicable, provide sample error messages, deprecation warnings, or migration guidance.
- If applicable, describe the differences between teaching this to existing Rust programmers and new Rust programmers.
- Discuss how this impacts the ability to read, understand, and maintain Rust code. Code is read and modified far more often than written; will the proposed feature make code easier to maintain?

For implementation-oriented RFCs (e.g. for compiler internals), this section should focus on how compiler contributors should think about the change, and give examples of its concrete impact. For policy RFCs, this section should provide an example-driven introduction to the policy, and explain its impact in concrete terms.

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

This is the technical portion of the RFC. Explain the design in sufficient detail that:

- Its interaction with other features is clear.
- It is reasonably clear how the feature would be implemented.
- Corner cases are dissected by example.

The section should return to the examples given in the previous section, and explain more fully how the detailed proposal makes those examples work.

## Drawbacks
[drawbacks]: #drawbacks

Why should we *not* do this?

## Rationale and alternatives
[rationale-and-alternatives]: #rationale-and-alternatives

- Why is this design the best in the space of possible designs?
- What other designs have been considered and what is the rationale for not choosing them?
- What is the impact of not doing this?
- If this is a language proposal, could this be done in a library or macro instead? Does the proposed change make Rust code easier or harder to read, understand, and maintain?

## Prior art
[prior-art]: #prior-art

Discuss prior art, both the good and the bad, in relation to this proposal.
A few examples of what this can include are:

- For language, library, cargo, tools, and compiler proposals: Does this feature exist in other programming languages and what experience have their community had?
- For community proposals: Is this done by some other community and what were their experiences with it?
- For other teams: What lessons can we learn from what other communities have done here?
- Papers: Are there any published papers or great posts that discuss this? If you have some relevant papers to refer to, this can serve as a more detailed theoretical background.

This section is intended to encourage you as an author to think about the lessons from other languages, provide readers of your RFC with a fuller picture.
If there is no prior art, that is fine - your ideas are interesting to us whether they are brand new or if it is an adaptation from other languages.

Note that while precedent set by other languages is some motivation, it does not on its own motivate an RFC.
Please also take into consideration that rust sometimes intentionally diverges from common language features.

## Unresolved questions
[unresolved-questions]: #unresolved-questions

- What parts of the design do you expect to resolve through the RFC process before this gets merged?
- What parts of the design do you expect to resolve through the implementation of this feature before stabilization?
- What related issues do you consider out of scope for this RFC that could be addressed in the future independently of the solution that comes out of this RFC?

## Future possibilities
[future-possibilities]: #future-possibilities

Think about what the natural extension and evolution of your proposal would
be and how it would affect the language and project as a whole in a holistic
way. Try to use this section as a tool to more fully consider all possible
interactions with the project and language in your proposal.
Also consider how this all fits into the roadmap for the project
and of the relevant sub-team.

This is also a good place to "dump ideas", if they are out of scope for the
RFC you are writing but otherwise related.

If you have tried and cannot think of any future possibilities,
you may simply state that you cannot think of anything.

Note that having something written down in the future-possibilities section
is not a reason to accept the current or a future RFC; such notes should be
in the section on motivation or rationale in this or subsequent RFCs.
The section merely provides additional information.

---

<!-- source: https://github.com/rust-lang/rfcs/blob/master/text/2333-prior-art.md -->

## Example

- Feature Name: `prior_art`
- Start Date: 2018-02-12
- RFC PR: [rust-lang/rfcs#2333](https://github.com/rust-lang/rfcs/pull/2333)
- Rust Issue: **self-executing**

## Summary
[summary]: #summary

Adds a *Prior art* section to the RFC template where RFC authors
may discuss the experience of other programming languages and their
communities with respect to what is being proposed. This section may
also discuss theoretical work such as papers.

## Motivation
[motivation]: #motivation

### Precedent has some importance

It is arguable whether or not precedent is important or whether proposals
should be considered solely on their own merits. This RFC argues that
precedent is important.

Precedent and in particular familiarity in and from other languages may
inform our choices in terms of naming, especially if that other language
is similar to Rust.

For additions to the standard library in particular, it should carry some
weight if a feature is supported in mainstream languages because the users
of those languages, which may also be rustaceans, are used to those features.
This is not to say that precedent alone is sufficient motivation for accepting
an RFC; but neither is it useless.

### Experiences from other languages are useful

This is the chief motivation of this RFC. By explicitly asking authors for
information about the similarity of their proposal to those in other languages,
we may get more information which aids us in better evaluating RFCs. Merely name
dropping that a language has a certain feature is not all - a discussion of the
experience the communities of the language in question has had is more useful.
A proposal need also not be a language or library proposal. If a proposal is
made for changes to how we work as a community, it can be especially valuable
how other communities have tackled a similar situation.

#### Experiences are useful to the author themselves

During the process of writing an RFC, an author may change certain aspects
of the proposal from what they originally had in mind. They may tweak the RFC,
change certain aspects in a more radical way, and so on. Here, the benefit of
explicitly asking for and about prior art is that it makes the RFC author think
about the proposal in relation to other languages. In search for this
information, the author can come to new or better realizations about the
trade-offs, advantages, and drawbacks of their proposal. Thus, their RFC as
a whole is hopefully improved as a by-product.

### Papers can provide greater theoretical understanding

This RFC argues that it valuable to us to be provided with papers or similar
that explain proposals and/or their theoretical foundations in greater detail
where such resources exist. This provides RFC readers with references if they
want a deeper understanding of an RFC. At the same time, this alleviates the
need to explain the minutiae of the theoretical background. The finer details
can instead be referred to the referred-to papers.

### An improved historical record of Rust for posterity

Finally, by writing down and documenting where our ideas came from,
we can better preserve the history and evolution of Rust for posterity.
While this is not very important in right now, it will increase somewhat
in importance as time goes by.

## Guide-level explanation
[guide-level-explanation]: #guide-level-explanation

This Meta-RFC modifies the RFC template by adding a *Prior art* section
before the *Unresolved questions*. The newly introduced section is intended
to help authors reflect on the experience other languages have had with similar
and related concepts. This is meant to improve the RFC as a whole, but also
provide RFC readers with more details so that the proposal may be more fairly
and fully judged. The section also asks authors for other resources such as
papers where those exist. Finally, the section notes that precedent from other 
languages on its own is not sufficient motivation to accept an RFC.

Please read the [reference-level-explanation] for exact details of what an RFC
author will see in the changed template.

## Reference-level explanation
[reference-level-explanation]: #reference-level-explanation

The implementation of this RFC consists of inserting the following
text to the RFC template before the section *Unresolved questions*:

> ## Prior art
>
> Discuss prior art, both the good and the bad, in relation to this proposal.
> A few examples of what this can include are:
>
> - For language, library, cargo, tools, and compiler proposals:
>   Does this feature exist in other programming languages and
>   what experience have their community had?
> - For community proposals: Is this done by some other community and what
>   were their experiences with it?
> - For other teams: What lessons can we learn from what other communities
>   have done here?
> - Papers: Are there any published papers or great posts that discuss this?
>   If you have some relevant papers to refer to, this can serve as a more
>   detailed theoretical background.
>
> This section is intended to encourage you as an author to think about
> the lessons from other languages, provide readers of your RFC with a
> fuller picture. If there is no prior art, that is fine - your ideas are
> interesting to us whether they are brand new or if it is an adaptation
> from other languages.
>
> Note that while precedent set by other languages is some motivation, it does
> not on its own motivate an RFC. Please also take into consideration that rust
> sometimes intentionally diverges from common language features.

## Drawbacks
[drawbacks]: #drawbacks

This might encourage RFC authors into the thinking that just because a feature
exists in one language, it should also exist in Rust and that this can be the
sole argument. This RFC argues that the risk of this is small, and that with a
clear textual instruction in the RFC template, we can reduce it even further.

Another potential drawback is the risk that in a majority of cases, the prior
art section will simply be left empty with "N/A". Even if this is the case,
there will still be an improvement to the minority of RFCs that do include a
review of prior art. Furthermore, this the changes to the template proposed
in this RFC are by no means irreversible. If we find out after some time that
this was a bad idea, we can always revert back to the way it was before.

Finally, a longer template risks making it harder to contribute to the
RFC process as an author as you are expected to fill in more sections.
Some people who don't know a lot of other languages may be intimidated into
thinking that they are expected to know a wide variety of languages and that
their contribution is not welcome otherwise. This drawback can be mitigated
by more clearly communicating that the RFC process is a collaborative effort.
If an author does not have prior art to offer up right away, other participants
in the RFC discussion may be able to provide such information which can then
be amended into the RFC.

## Rationale and alternatives
[alternatives]: #alternatives

If we don't change the template as proposed in this RFC, the downsides
are that we don't get the benefits enumerated within the [motivation].

As always, there is the simple alternative of not doing the changes proposed
in the RFC.

Other than that, we can come to the understanding that those that
want may include a prior art section if they wish, even if it is not
in the template. This is already the case - authors can always provide
extra information. The benefit of asking for the information explicitly
in the template is that more authors are likely to provide such information.
This is discussed more in the [motivation].

Finally, we can ask for information about prior art to be provided in each
section (motivation, guide-level explanation, etc.). This is however likely to
reduce the coherence and readability of RFCs. This RFC argues that it is better
that prior art be discussed in one coherent section. This is also similar to
how papers are structured in that they include a "related work" section.

## Prior art
[prior-art]: #prior-art

In many papers, a section entitled *Related work* is included which can
be likened to this section. To not drive readers away or be attention
stealing from the main contributions of a paper, it is usually recommended
that this section be placed near the end of papers. For the reasons mentioned,
this is a good idea - and so to achieve the same effect, the section you are
currently reading will be placed precisely where it is placed right now, that
is, before the *Unresolved questions* section, which we can liken to a
*Future work* section inside a paper.

A review of the proposal templates for [`C++`], [`python`], [`Java`], [`C#`],
[`Scala`], [`Haskell`], [`Swift`], and [`Go`] did not turn up such a section
within those communities templates. Some of these templates are quite similar
and have probably inspired each other. To the RFC authors knowledge, no other
mainstream programming language features a section such as this.

[`C++`]: https://isocpp.org/std/submit-a-proposal
[`python`]: https://github.com/python/peps/blob/master/pep-0001.txt
[`Java`]: http://openjdk.java.net/jeps/2
[`C#`]: https://github.com/dotnet/csharplang/blob/master/proposals/proposal-template.md
[`Haskell`]: https://github.com/ghc-proposals/ghc-proposals/blob/master/proposals/0000-template.rst
[`Scala`]: https://github.com/scala/docs.scala-lang/blob/master/_sips/sip-template.md
[`Go`]: https://github.com/golang/proposal/blob/master/design/TEMPLATE.md
[`Swift`]: https://github.com/apple/swift-evolution/blob/master/0000-template.md

## Unresolved questions
[unresolved]: #unresolved-questions

There are none as of yet.

What is important in this RFC is that we establish whether we want a
prior art section or not, and what it should contain in broad terms.
The exact language and wording can always be tweaked beyond this.


<!--
  Trimmed here. The third sample in the original paste was the full NLL RFC
  (2197 lines), kept out because the form is already legible from the two above.
  Read it upstream when a long design RFC is the thing being written:
  https://github.com/rust-lang/rfcs/blob/master/text/2094-nll.md
-->