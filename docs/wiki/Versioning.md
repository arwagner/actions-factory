# Versioning

## Pinning

The stub's `uses:` line names the factory version:

| Form | Behaviour |
|---|---|
| `@v1` (the stub's default) | Moving major tag. Fixes and prompt improvements arrive automatically; nothing breaks within a major. |
| `@latest` | Moving tag on the newest release, following new majors too, so breaking changes arrive without notice. Never untested `main`. |
| `@vX.Y.Z` or a commit SHA | Nothing changes until you merge a bump, for example a Dependabot PR. |

Dependabot updates the pin if you enable its `github-actions` ecosystem.

## What a version covers

One version covers everything: the router, prompts, skills, templates, adapters, agent CLI versions and the stub.

- **Major:** anything that breaks a client. Removing or renaming a config field, label or template; dropping a `schemaVersion`; changing the secrets the stub passes; needing a new stub.
- **Minor:** a changed prompt or skill; a new optional field, template or adapter (unless it needs a new stub secret).
- **Patch:** fixes.

Old majors get fixes for 6 months after the next major ships. Tags are never deleted.

## Upgrading the stub

The stub declares its own version (`stub-version`). The router warns in the run summary when the stub is older than the minimum, and refuses, with a comment, when it's from an older major. To upgrade, copy the current stub from [Getting started](Getting-started) over yours. Behaviour lives in `factory.yml`, so the stub itself never needs editing.

## Rolling back

If a release breaks you on `@v1` or `@latest`, pin the last good version exactly (`@v1.2.2`) until a fix ships. The maintainers' own repair path is moving `v1` and `latest` back to the last good tag, so `@v1` clients pick up the old version on their next run.

## Reading old docs

This wiki describes the newest release. For an older version, read `docs/wiki/` in the repo at that version's tag, for example `https://github.com/arwagner/actions-factory/tree/v1.0.0/docs/wiki`.
