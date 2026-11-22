# Releasing

How a version of the factory is cut, tested and rolled back (spec §11).

## Cut a release

1. In a pull request, bump `version` in `package.json` (and, for a new stub, `STUB_VERSION` in `src/router/version.ts` and the stub's header). Merge it.
2. Run the **release** workflow on `main` with that version.

The workflow:
1. Checks the version: it must look like `1.2.3`, match `package.json`, and not be tagged already.
2. Runs lint, schema validation, unit tests, and the check that `dist/` is built from this commit.
3. Points the `release-candidate` branch at this commit. The sandbox's stub calls the router there.
4. Runs the end-to-end scenarios in the sandbox (`scripts/e2e.ts`), one per shipped template, on the `fake` agent.
5. Only if they all pass: tags `vX.Y.Z`, moves `vX` and `latest` to it, and publishes a GitHub release with notes generated from the merged pull requests.
6. Publishes the wiki from `docs/wiki/` (`node scripts/wiki.ts`), using this repo's own `FACTORY_TOKEN`. Without that secret, it's skipped with a warning.

A failed scenario stops the release before anything is tagged. The run summary lists each scenario's result.

Until this repo has the `SANDBOX_TOKEN` secret, step 4 is skipped with a warning. Run the scenarios by hand first (below).

## Before a major release: the smoke run

Run the **smoke** workflow and choose an agent. It runs the sandbox's implement task on that real agent, against the current commit, and checks it opens a pull request. The sandbox needs that agent's secret (for example `CLAUDE_CODE_OAUTH_TOKEN`).

## The sandbox

`skylight-hq/osh-simulator` is the sandbox client. It's in another account, so every release tests the cross-owner path.

- Its stub, on its default branch, calls the router at `@release-candidate`. Don't repin it.
- It has its own `FACTORY_TOKEN`.
- The scenarios rewrite its `factory.yml` and `.factory/fake/` for each template, open issues and pull requests labelled `e2e`, and close them afterwards. The default scenario merges a pull request and then removes its files again.

This repo needs one secret for it, `SANDBOX_TOKEN`: a token that can act on the sandbox, with Contents, Issues, Pull requests and Actions set to write. It drives the scenarios the way a person would: adding labels, including `agent:merge`.

To run the scenarios by hand (all of them, or some by name):

```sh
SANDBOX_TOKEN=… node scripts/e2e.ts            # every scenario
SANDBOX_TOKEN=… node scripts/e2e.ts full doctor
```

This uses whatever `release-candidate` points at.

## Roll back

If a release breaks clients on `@v1` or `@latest`, move those tags back to the last good release. No agent and no new release is needed:

```sh
git fetch --tags
git tag -f v1 v1.2.2        # the last good version
git tag -f latest v1.2.2
git push --force origin v1 latest
```

Clients pinned to `@v1` or `@latest` pick up the old version on their next run. The bad `vX.Y.Z` tag stays, since tags are never deleted. Fix forward in a new patch release.
