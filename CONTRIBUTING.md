# Contributing to Noodle Gallery

We appreciate every contribution, and we're happy about every new contributor. So please feel invited to help make Immich a better product!

## Getting started

To get you started quickly we have detailed guides for the dev setup on our [website](https://docs.immich.app/developer/setup). If you prefer, you can also use [Devcontainers](https://docs.immich.app/developer/devcontainers).
There are also additional resources about Immich's architecture, database migrations, the use of OpenAPI, and more in our [developer documentation](https://docs.immich.app/developer/architecture).

## General

Please try to keep pull requests as focused as possible. A PR should do exactly one thing and not bleed into other, unrelated areas. The smaller a PR, the fewer changes are likely needed, and the quicker it will likely be merged. For larger/more impactful PRs, please reach out to us first to discuss your plans. The best way to do this is through our [Discord](https://discord.immich.app). We have a dedicated `#contributing` channel there. Additionally, please fill out the entire template when opening a PR.

## Finding work

If you are looking for something to work on, there are discussions and issues with a `good-first-issue` label on them. These are always a good starting point. If none of them sound interesting or fit your skill set, feel free to reach out on our Discord. We're happy to help you find something to work on!

We usually do not assign issues to new contributors, since it happens often that a PR is never even opened. Again, reach out on Discord if you fear putting a lot of time into fixing an issue, but ending up with a duplicate PR.

## Use of Generative AI

We encourage the use of LLMs and AI coding tools. Some projects ban AI-generated code; our experience is that these tools pay off when the person driving them has a clear spec.

**All PRs must include a spec or design document** that describes _what_ the change does and _why_. That holds whether you wrote every line by hand, pair-programmed with an LLM, or handed the job to an agent. With a spec in front of them, reviewers can judge intent and correctness, which is what matters regardless of who (or what) wrote the code.

**All PRs must also include tests.** Server test coverage went from 74% to 94%, and not by accident. The spec says _what_ the code should do; the tests show that it does. No tests, no merge.

The "large amount of back-and-forth" that some projects blame on LLM-generated code is, in our experience, a symptom of missing specs and unclear requirements. Solve that, add tests, and it stops mattering which tool wrote the code.

LLMs must not be used to fix GitHub issues labelled good first issue. These issues are generally not urgent, and are intended to be learning opportunities for new contributors to get familiar with the codebase. Whether you are a newcomer or not, fully automating the process of fixing this issue squanders the learning opportunity and doesn’t add much value to the project. Using LLMs to fix issues labelled as “good first issue” is forbidden, and those PRs will be closed automatically.

Misrepresenting LLM use, contribution farming (automated low-effort PRs), or repeatedly hitting auto-close rules may be grounds for a block at maintainer discretion.

## Feature freezes

From time to time, we put a feature freeze on parts of the codebase. For us, this means we won't accept most PRs that make changes in that area. Exempted from this are simple bug fixes that require only minor changes. We will close feature PRs that target a feature-frozen area, even if that feature is highly requested and you put a lot of work into it. Please keep that in mind, and if you're ever uncertain if a PR would be accepted, reach out to us first (e.g., in the aforementioned `#contributing` channel). We hate to throw away work. Currently, we have feature freezes on:

- Sharing/Asset ownership
- (External) libraries

## Non-code contributions

If you want to contribute to Immich but you don't feel comfortable programming in our tech stack, there are other ways you can help the team.

### Translations

All our translations are done through [Weblate](https://hosted.weblate.org/projects/immich). These rely entirely on the community; if you speak a language that isn't fully translated yet, submitting translations there is greatly appreciated!

### Datasets

Help us improve our [Immich Datasets](https://datasets.immich.app) by submitting photos and videos taken from a variety of devices, including smartphones, DSLRs, and action cameras, as well as photos with unique features, such as panoramas, burst photos, and photo spheres. These datasets will be publicly available for anyone to use, do not submit private/sensitive photos.

### Community support

If you like helping others, answering Q&A discussions here on GitHub and replying to people on our Discord is also always appreciated.

## Releases

This personal fork no longer includes GitHub Actions for mobile apps or documentation deployment. Server releases can be created manually via `.github/workflows/gallery-release-server-only.yml`; server image builds are available through `.github/workflows/custom-docker.yml`.

See `docs/docs/developer/releases.md` for the retained release process.
