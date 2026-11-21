# Actions platform limits for a reusable factory

Research for ticket #2. Question: which GitHub Actions facts limit how the factory is packaged and run. Sources are docs.github.com and the GitHub changelog unless noted. Read on 2026-11-21. **Uncertain** marks claims not confirmed by a first-party source.

## 1. Packaging: reusable workflows vs composite vs JavaScript/Docker actions

| | Reusable workflow | Composite action | JS / Docker action |
|---|---|---|---|
| Called from | a job (`jobs.<id>.uses`) | a step (`uses`) | a step (`uses`) |
| Contains | jobs (own runners, `permissions`, `concurrency`, matrix) | steps only, no jobs | one program |
| Nesting | up to 10 levels (caller + 9); at most 50 unique reusable workflows per caller file, nested trees included; no loops | up to 10 composite actions nested in one workflow | n/a |
| Secrets | yes: named or `secrets: inherit` | **no** `secrets` context; must be passed in as inputs | passed as inputs/env |
| Inputs | `boolean`, `number`, `string` | strings (in the `inputs` context; no automatic `INPUT_*` env) | strings (`INPUT_*` env) |
| Logging | each step logged in real time | logged as one step | one step |
| Own files | not on disk; must be checked out (see section 2) | whole action repo on disk at `$GITHUB_ACTION_PATH` | same |

Sources: [reusing workflow configurations (concept)](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations), [reusing workflow configurations (reference)](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), [contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax).

- Reference form: `{owner}/{repo}/.github/workflows/{file}@{ref}`. `ref` can be a SHA, tag or branch; a tag wins over a branch with the same name; SHA is the "safest". Workflows can't live in subdirectories of `.github/workflows/`. The calling job can't use `environment`. [reuse workflows how-to](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- `secrets: inherit` passes all of the caller's secrets. Only directly called workflows get passed secrets; a nested call must pass them on again with `jobs.<id>.secrets`. The how-to describes `inherit` as working for workflows "in the same organization or enterprise". **Uncertain**: whether `inherit` works across owners (a client repo calling this repo in another account). Named secrets should work either way. [reuse workflows how-to](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- Permissions: the called workflow gets `GITHUB_TOKEN` automatically. If the calling job sets no `permissions`, the called workflow gets the token's default permissions. The called workflow can only lower permissions, never raise them, at every level of nesting. Naming any permission sets every unnamed one to `none`. [reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- Visibility: a private caller can use public and private reusable workflows; a public caller can use only public ones. A private called repo has to allow callers in its Actions access-policy setting. So **if this repo stays public, any client can call it with no setup**. [reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- Outputs go from step to job output to `on.workflow_call.outputs`, and every downstream job in the caller can read them. [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- JS actions run on `node20` or `node24`, with optional `pre`/`post` (`pre` isn't supported for local actions). Docker actions run `runs.image` with `args`. [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)

## 2. Reading this repo's files (prompts, skills) at the called ref

- In a reusable workflow, the `github` context is the **caller's**: `github.repository`, `github.sha` and `github.workflow_ref` point at the client repo. `actions/checkout` with no inputs checks out the client repo. [reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- New (changelog, Sept 2026): the **`job.workflow_repository`, `job.workflow_sha`, `job.workflow_ref` and `job.workflow_file_path`** properties name the reusable workflow file that defines the current job. A called workflow can check out its own repo at its exact commit, e.g. `actions/checkout` with `repository: ${{ job.workflow_repository }}`, `ref: ${{ job.workflow_sha }}`, `path: .factory`. Not on GHES. A third-party guide (Datadog) says it needs runner v2.334.0 or later (**uncertain**). [changelog](https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates), [contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
- The checkout token defaults to `github.token`, which only covers the current repo. A private second repo needs a PAT or App token. **Uncertain** (docs don't say): whether the default token can clone a *public* repo owned by someone else. In practice it should, since public repos are readable. [actions/checkout](https://github.com/actions/checkout), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- Another way: put prompts and skills inside a **composite or JS action** in this repo. The runner downloads the action repo at the `uses:` ref, and the files sit at `${{ github.action_path }}` / `$GITHUB_ACTION_PATH` (`github.action_path` is only supported in composite actions). `github.action_repository` and `github.action_ref` name the action. [contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)

## 3. Triggers and the GITHUB_TOKEN rule

- `issues` (`labeled`/`unlabeled`/…), `issue_comment` (on issues **and** PRs), `workflow_dispatch`, `repository_dispatch` and `schedule` only fire **if the workflow file exists on the default branch**. They run on the default branch's latest commit. [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- `pull_request` `labeled` runs at the PR merge ref (`refs/pull/N/merge`). `pull_request_target` runs in the base repo's default-branch context. Fork PRs get no secrets. [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- **The GITHUB_TOKEN rule**: "With the exception of `workflow_dispatch` and `repository_dispatch`, other `GITHUB_TOKEN`-triggered events do not create workflow runs at all." So a label, comment or push made with `GITHUB_TOKEN` will **not** start the next task. [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- New (changelog, May/June 2026): PRs opened by `github-actions[bot]` now create `pull_request` runs (`opened`/`synchronize`/`reopened`) in an **approval-required** state, which a user with write access must approve. To have them run unattended, use a GitHub App installation token or a PAT. [changelog](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- Chaining with `GITHUB_TOKEN` is therefore possible only through dispatch:
  - `workflow_dispatch` API: needs `actions: write`. `ref` is a branch or tag; at most 25 top-level inputs and 65,535 chars. The response now returns `workflow_run_id`, `run_url` and `html_url`. [REST workflows](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
  - `repository_dispatch` API: needs `contents: write`. `event_type` is at most 100 chars; `client_payload` has at most 10 top-level properties and must be under 64 KB. [REST repos](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
  - `workflow_run` can chain at most 3 levels and gets secrets and a write token. [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- `GITHUB_TOKEN` is scoped to the repo the workflow runs in, is limited to 1,000 API requests/hour/repo (15,000 on GHEC), and expires when the job ends (at most 6 h hosted; refreshable for only 24 h on self-hosted). [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token), [limits](https://docs.github.com/en/actions/reference/limits)

## 4. Concurrency

- At most one running and, by default (`queue: single`), one pending run per group. A newer pending run **cancels** the older pending one. [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [concurrency concept](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- `queue: max` allows up to 100 pending runs per group, run in order. It can't be combined with `cancel-in-progress: true` (validation error). Group names are case-insensitive. Can be set at workflow or job level. [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [limits](https://docs.github.com/en/actions/reference/limits)

## 5. Time and volume limits

- Job: 6 h on GitHub-hosted, 5 days on self-hosted. `timeout-minutes` defaults to 360; step `timeout-minutes` is at most 360. Workflow run: 35 days, waits included. Self-hosted queue: 24 h. [limits](https://docs.github.com/en/actions/reference/limits), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- Concurrent hosted jobs: 20 Free / 40 Pro / 60 Team / 500 Enterprise. Matrix: 256 jobs. Workflow file: 500 KB. Trigger events: 1,500 per 10 s per repo. Re-runs: 50 per run. [limits](https://docs.github.com/en/actions/reference/limits)

## 6. Cron (`schedule`)

- Runs in UTC by default; an IANA `timezone` can now be set. Runs only on the latest commit of the default branch. Shortest interval is 5 minutes. "Can be delayed during periods of high loads"; "some queued jobs may be dropped". Public repos turn scheduled workflows off after 60 days with no repo activity. [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- So a schedule is a best-effort sweep, not a guarantee. Each run must be idempotent and pick up anything a dropped run missed.

## 7. Pushing to a repo's wiki

- A wiki is a separate git repo at `<owner>/<repo>.wiki.git`. It can be cloned only after a first page has been created in the web UI. [adding or editing wiki pages](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages)
- **Uncertain** (third-party only, no first-party statement found): `GITHUB_TOKEN` with `contents: write` can push to the **same** repo's wiki (`actions/checkout` with `repository: ${{ github.repository }}.wiki`, then commit and push). Another repo's wiki needs a PAT or App token. Seen in [vscode-go wiki workflow](https://go.googlesource.com/vscode-go/+/refs/tags/v0.34.1/.github/workflows/wiki.yml) and [Andrew-Chen-Wang/github-wiki-action](https://github.com/Andrew-Chen-Wang/github-wiki-action). Wiki edits fire the `gollum` event; by the GITHUB_TOKEN rule, a token-made edit shouldn't trigger runs.

## What this means for packaging and chaining

- **Shape**: each task as a reusable workflow (it needs its own jobs, `permissions`, `concurrency`, secrets), with steps shared through composite actions that carry the prompt and skill files at `$GITHUB_ACTION_PATH`. Or check out `job.workflow_repository@job.workflow_sha`. Both give files at the same ref as the called code.
- **Client stub**: the client repo must keep thin caller workflows on its **default branch** for every trigger (labels, comments, schedule, dispatch). Templates can't add triggers at run time, so the set of stubs is fixed by whatever the client installed.
- **Chaining**: one task's label or comment made with `GITHUB_TOKEN` won't start the next task. Options: (a) dispatch the next task directly (`workflow_dispatch`/`repository_dispatch`, which works with `GITHUB_TOKEN`); (b) use an App or PAT token for the label so normal events fire; (c) a scheduled sweep as a backstop. Agent-opened PRs made with `GITHUB_TOKEN` need human approval before CI runs.
- **Serialising**: `concurrency` per ticket or PR (`queue: max` if dispatches mustn't be lost); the default `single` queue silently drops all but the newest pending run.
- **Budget**: 6 h per hosted job, and `GITHUB_TOKEN` at 1,000 req/h/repo shared by every task in that repo.
