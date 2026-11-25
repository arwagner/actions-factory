# 12. Onboarding

Decided in: Onboarding a client repo (#22).

## Getting started (copy-paste, about 10 minutes)

1. **Create the token.** A fine-grained token on a machine user (recommended) or a person, limited to the repo. Set Contents, Issues and Pull requests to write; add Workflows only if a task opts into workflow changes. In an org, an owner usually has to approve it.
2. **Set secrets:** `FACTORY_TOKEN`, plus one agent credential (for example `CLAUDE_CODE_OAUTH_TOKEN`). Add `FACTORY_CHECK_ENV` if the checks need secrets.
3. **Copy the stub** to `.github/workflows/factory.yml`, and add a minimal `factory.yml`:
   ```yaml
   schemaVersion: 1
   checks:
     - npm ci
     - npm test
   ```
4. **Merge to the default branch.**
5. **Run the doctor.**

This repo's own `factory.yml` is linked as a working example. There's no generator in v1; a `gh factory init` extension could come later as a minor release.

## The doctor

`workflow_dispatch` on the stub with `command: doctor` checks each of these and reports pass or fail, with a fix, in the run summary:

- the config validates, and the template stack resolves;
- the required secrets are present;
- the token can read the repo, push branches, and write issues and PRs (through the API). Each write is probed with input GitHub rejects, so nothing is written: GitHub answers 403 without the permission and 422 with it. Workflows: write can't be probed this way, so it's only noted when a task sets `allowWorkflowChanges`;
- direct agent credentials work (a tiny prompt), in the doctor's agent job;
- a configured Codex login pool has its environment, a selected branch rule, a state branch and a save-back token allowed to write environment secrets. The doctor shows free, leased and quarantined logins without using one or printing its credential;
- the labels are created;
- the stub's version is current.

`command: show-config` prints the final merged config.

## First real event

The router creates any missing labels whenever it runs, so a repo that skips the doctor still works.
