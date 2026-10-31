# Releasing fascicle

Pushing the tag starts the release. `publish.yaml` runs an OIDC trusted-publishing job that pauses at the `npm-publish` environment until a required reviewer approves it, and `release.yaml` creates the GitHub Release from the version's `CHANGELOG.md` section. The skill pushes only the tag, so end the report by pointing at both follow-ups: approve the paused `publish.yaml` run in GitHub Actions, and push the branch with `git push origin main`.

`publish.confirm` is false because that approval is the confirmation. A pushed tag publishes nothing until a person approves the run.

`verify` runs only the five slots that a version string and changelog prose can fail. The two prose slots are there because vale and the prose ratchet read `CHANGELOG.md` like any other markdown, and v0.12.6 shipped a sentence with two semicolons that passed `docs,links,spell` and then failed `prose` in `publish.yaml`, which stranded its tag on a commit that could never pass. The heavy checks gate `prepublishOnly` (`pnpm check:all`) instead.

Fix and feature commits write their own `CHANGELOG.md` entries under `## Unreleased` as they land, so a release usually promotes that section whole. An entry opens with a bold one-sentence headline and then says what was wrong, why, and what happens now, all on one line. An entry the release adds matches that, and a docs link inside one is written as `./docs/x.md#anchor`.
