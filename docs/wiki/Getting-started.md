# Getting started

About ten minutes, in five steps.

## 1. Create the token

The factory acts in your repo with a personal access token, the `FACTORY_TOKEN` secret. Create a **fine-grained** token, ideally on a machine user (see [Identity and tokens](Identity-and-tokens)):

- **Resource owner:** the account or organization that owns the repo.
- **Repository access:** only this repo.
- **Permissions:** Contents, Issues and Pull requests set to **Read and write**. Add Workflows only if a task sets `allowWorkflowChanges: true`.

## 2. Set the secrets

In the repo's **Settings → Secrets and variables → Actions**, add:

- `FACTORY_TOKEN`: the token from step 1.
- One credential for your agent, for example `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. See [Agents](Agents).
- `FACTORY_CHECK_ENV`, only if your checks need secrets, such as a test database URL. See [Runner environment](Runner-environment).

## 3. Add two files

Copy the stub to `.github/workflows/factory.yml`, unchanged:

```yaml
# actions-factory stub v1.1.0
# Copy this file to .github/workflows/factory.yml on your default branch. Don't edit it:
# behaviour lives in factory.yml. To update, copy a newer stub over it.
name: factory
# The title is how the router counts runs (runsPerDay, loop brake) and finds the last tick: keep it as it is.
run-name: "factory · ${{ github.event.label.name || github.event.client_payload.trigger || inputs.command || (github.event_name == 'schedule' && 'tick') || github.event_name }}${{ (github.event.issue.number || github.event.pull_request.number || github.event.client_payload.number) && format(' · #{0}', github.event.issue.number || github.event.pull_request.number || github.event.client_payload.number) || '' }}"

on:
  issues:
    types: [labeled]
  pull_request_target:
    types: [labeled]
  workflow_dispatch:
    inputs:
      command:
        description: What to run
        type: choice
        options: [doctor, show-config]
        default: doctor
  repository_dispatch:
  schedule:
    - cron: "*/15 * * * *"

permissions: {}

jobs:
  factory:
    # Label events other than agent: labels (and agent:blocked, which starts nothing) stop here, before a runner starts.
    if: github.event_name != 'issues' && github.event_name != 'pull_request_target' || startsWith(github.event.label.name, 'agent:') && github.event.label.name != 'agent:blocked'
    # Pin @v1 (default), @latest, or an exact @vX.Y.Z / commit SHA.
    uses: arwagner/actions-factory/.github/workflows/router.yml@v1
    permissions:
      contents: read
      issues: write
      pull-requests: write
      actions: read
    with:
      stub-version: 1.1.0
    secrets:
      FACTORY_TOKEN: ${{ secrets.FACTORY_TOKEN }}
      FACTORY_CHECK_ENV: ${{ secrets.FACTORY_CHECK_ENV }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      CODEX_ACCESS_TOKEN: ${{ secrets.CODEX_ACCESS_TOKEN }}
      CODEX_POOL_TOKEN: ${{ secrets.CODEX_POOL_TOKEN }}
      CODEX_POOL_TRANSPORT_PRIVATE_KEY: ${{ secrets.CODEX_POOL_TRANSPORT_PRIVATE_KEY }}
      COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
```

And a minimal `factory.yml` at the repo's root, with the commands that prove a change works:

```yaml
schemaVersion: 1
checks:
  - npm ci
  - npm test
```

That's the `default` template on Claude Code. [Customizing](Customizing) and the [Config reference](Config-reference) cover the rest. This repo's own [`factory.yml`](https://github.com/arwagner/actions-factory/blob/main/factory.yml) is a working example.

## 4. Merge to the default branch

Label events only start workflows from the default branch, so both files must be on it.

## 5. Run the doctor

In **Actions → factory → Run workflow**, choose `doctor`. It checks each of these and shows pass or fail, with a fix, in the run summary:

- the config validates, and its template stack resolves;
- `FACTORY_TOKEN` is set, and can read the repo, push branches, and write issues and pull requests (probed without writing anything);
- every agent the config uses has a credential, and answers a tiny test prompt;
- the labels exist (the doctor creates them);
- the stub is the current version.

Then add `agent:implement` to a small issue and watch it go. `show-config` prints the merged config the factory sees.
