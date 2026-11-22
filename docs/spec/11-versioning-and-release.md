# 11. Versioning, release and dog-fooding

Decided in: Versioning and release (#8), Dog-fooding (#15).

## Pinning

The stub's `uses:` line names the factory version, in one of three forms:

| Form | Behaviour |
|---|---|
| `@v1` (default in the stub) | Moving major tag. Fixes and prompt improvements arrive automatically, and nothing breaks within a major. |
| `@latest` | Moving tag on the newest release, which follows new majors too, so breaking changes arrive without notice. Never points at untested `main`. |
| `@vX.Y.Z` or a commit SHA | Nothing changes until the client merges a bump, for example a Dependabot PR. |

## What a version covers

- One semver tag covers everything: actions, prompts, skills, templates, adapters and the stub. The router reads its files at the pinned commit (section 1).
- **Major:** anything that breaks a client. That means removing or renaming a config field, label or template; dropping a `schemaVersion`; changing the secrets the stub needs; or needing a new stub.
- **Minor:** changing a prompt or skill, adding an optional field, template or adapter (unless it needs a new stub secret).
- **Old majors:** get fixes for 6 months after the next major ships. Tags are never deleted.
- **Stale stubs:** the stub carries its own version. The router warns in the run summary when the stub is older than the minimum, and refuses with a comment when the stub is from an older major.

## Release workflow

A manually started workflow on `main`:
1. Runs lint, schema validation and unit tests.
2. Runs end-to-end scenarios in the sandbox against the candidate commit.
3. Only if they pass, tags `vX.Y.Z`, moves `vX` and `latest`, and writes the changelog from the merged PR titles.
4. Publishes the wiki (section 13).

Before a major release, an optional, manually started smoke run uses real agents.

## Sandbox

- `skylight-hq/osh-simulator` is the sandbox client. It sits in another account, so every release tests the cross-owner path.
- It needs the stub on its `main` (label events fire only from the default branch), calling the router at `@release-candidate`. The release workflow points that branch at the candidate commit before the scenarios run. It also needs its own `FACTORY_TOKEN`.
- This repo holds a `SANDBOX_TOKEN` that can act on the sandbox (Contents, Issues, Pull requests and Actions set to write). The scenarios use it to set the sandbox's config and to add labels the way a person would, `agent:merge` included.
- Scenarios (`scripts/e2e.ts`) use the `fake` adapter, which returns ready-made plans with no LLM call. They run label → router → task → writes → next label for each shipped template, plus the doctor. `docs/releasing.md` has the procedure and the rollback.
- Scenario issues and PRs carry an `e2e` label and are closed after each run.
- The `fake` adapter ships in this repo for tests only and isn't documented for clients.

## Dog-fooding

- This repo's stub pins `@latest`. It always runs the newest release, never unreleased `main`, and is the first client to get every release.
- Its `factory.yml` uses the `default` template, with its own checks (lint, schema validation, unit tests).
- `agent:merge` is allowed on this repo. Merging to `main` doesn't release anything.
- **Repair path:** if a release breaks the factory, move `latest` and `vX` back to the previous tag. It's a documented manual step, with no agent needed.
