# Third-party notices

Every file in this directory is excerpted verbatim from another project, kept as
a reference for the *form* a piece of writing takes: what a doc comment covers,
what sections an RFC has, how a changelog entry is shaped. Voice lives in
`../exemplars/`, and comes from this repo's author.

Each file records its own upstream URL at the top and marks where it was cut.
Nothing here is edited, only shortened.

| File | Upstream | Declared license |
| --- | --- | --- |
| `doc-comment.md` | [reduxjs/redux](https://github.com/reduxjs/redux) | MIT |
| `guide-prose.md` | [reduxjs/redux](https://github.com/reduxjs/redux) (docs) | MIT |
| `changelog-entry.md` | [evanw/esbuild](https://github.com/evanw/esbuild) | MIT |
| `rfc.md` | [rust-lang/rfcs](https://github.com/rust-lang/rfcs) | Apache-2.0 OR MIT |
| `troubleshooting.md` | [vitejs/vite](https://github.com/vitejs/vite) | MIT |

The table records what each upstream repository declares for its source. A
project can license its prose separately from its code, so confirm the docs
terms before treating a row as settled.

This directory is excluded from the `prose`, `docs`, and `links` checks, and
does not ship in the npm package (`package.json` `files` covers `dist` only).
