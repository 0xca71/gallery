# Releases

This fork retains server releases and Docker publishing but does not build or publish iOS/Android apps in GitHub Actions. App release workflows were removed in PR #14 and the follow-up CI cleanup. Releases are manual, and versions are provided by the maintainer.

## Server releases

### Release Gallery Server

Workflow: `gallery-release-server-only.yml`. Inputs: a required `version` and an optional `commit`.

- `commit` defaults to the HEAD of the triggering branch. Supplying it pins the release to that exact commit ("release up to this commit"); the commit must already be merged on the branch.

It builds and pushes multi-arch Docker images to `ghcr.io/open-noodle/`, moves three git tags, creates the GitHub Release (with auto-generated changelog noting the upstream Immich version), and flips the version endpoint that self-hosted instances poll.

The three git tags:

- `vX.Y.Z`: the specific version (e.g. `v5.0.0`)
- `vX`: floats to the latest release in that major (e.g. `v5`)
- `release`: always points to the latest server release

## Version in source files

Source files (`package.json`, `pubspec.yaml`, `pyproject.toml`) contain the **upstream Immich version**, not the Gallery version, which keeps upstream rebases free of merge conflicts. The branding script (`branding/scripts/apply-branding.sh`) overwrites these at build time with the Gallery version passed into the release workflow.

In local development the server reports the upstream Immich version. That is expected: branding only runs during CI builds.

## Docker image tags

Users pin their deployments with the `IMMICH_VERSION` env var in `docker-compose.yml`:

| Tag              | Example   | Behavior                  |
| ---------------- | --------- | ------------------------- |
| Specific version | `v5.0.0`  | Pinned to exact release   |
| Major version    | `v5`      | Floats to latest `v5.x.x` |
| `release`        | `release` | Always latest build       |

## Upstream tracking

The upstream Immich version is recorded in `branding/config.json` under `upstream.version`. This is updated during rebases and included in GitHub Release notes.
