# pull_request_target labeled routing and fork detection

Spike for #28 (spec §1 Stub, §9 forks). Run live on 2026-11-21.

## Answer

1. **Routing works.** A stub on `issues` + `pull_request_target` `types: [labeled]` with a job-level `if: startsWith(github.event.label.name, 'agent:')` calls a reusable workflow in a separate repo (`uses: owner/repo/.github/workflows/router.yml@main`). Nothing from the PR is checked out: the workspace is empty, `github.sha`/`github.ref` are the base default branch, and a workflow file the fork rewrote in its PR was ignored. A non-`agent:` label creates a run whose only job is `skipped`, with no runner and 0 steps.
2. **Fork detection:** use
   `github.event.pull_request.head.repo.full_name != github.event.pull_request.base.repo.full_name`.
   Do **not** use `head.repo.fork`. It is the head repo's own "is a fork" flag, so it is `true` for an ordinary same-repo PR in a repo that is itself a fork (seen live below).
3. **`issues` `labeled`** behaves the same with the same `if:`: an `agent:` label runs, a `bug` label skips. Labeling a PR fires only `pull_request_target`, never `issues`. On `issues` events every `pull_request.*` field is empty, so comparisons against `github.repository` evaluate `true` there (see pitfalls).

## Setup

- `arwagner/af-spike-prt-caller` (public): the stub, `.github/workflows/factory.yml`.
- `arwagner/af-spike-prt-router` (public): the reusable workflow, `.github/workflows/router.yml`.
- `skylight-hq/af-spike-prt-caller`: fork of the caller, owned by a different account, which is the source of the fork PR.

Test objects in the caller repo: PR #1 (same-repo branch), PR #2 (from `skylight-hq:fork-branch`, which also rewrites `factory.yml` to echo `FORK-MODIFIED WORKFLOW RAN`), issue #3. Each got `bug`, then `agent:review`, added through the REST API as arwagner.

### Stub (caller), exact YAML

```yaml
name: factory
run-name: "factory · ${{ github.event.label.name || github.event_name }} · #${{ github.event.pull_request.number || github.event.issue.number }}"
on:
  issues:
    types: [labeled]
  pull_request_target:
    types: [labeled]

permissions:
  contents: read

jobs:
  factory:
    if: startsWith(github.event.label.name, 'agent:')
    uses: arwagner/af-spike-prt-router/.github/workflows/router.yml@main
    with:
      note: "called from ${{ github.event_name }}"
```

### Router (reusable), relevant part

No `actions/checkout`. Each expression is passed through `env:` and printed, then `ls -la "$GITHUB_WORKSPACE"`.

```yaml
on:
  workflow_call:
    inputs:
      note: { type: string, required: false, default: "" }
permissions:
  contents: read
jobs:
  route:
    runs-on: ubuntu-latest
    steps:
      - name: Show context (no checkout anywhere)
        env:
          E1_FULLNAME_NE_REPO:    ${{ github.event.pull_request.head.repo.full_name != github.repository }}
          E2_FULLNAME_NE_BASE:    ${{ github.event.pull_request.head.repo.full_name != github.event.pull_request.base.repo.full_name }}
          E3_HEAD_REPO_FORK:      ${{ github.event.pull_request.head.repo.fork }}
          E4_HEAD_ID_NE_BASE_ID:  ${{ github.event.pull_request.head.repo.id != github.event.pull_request.base.repo.id }}
          E5_HEAD_ID_NE_REPO_ID:  ${{ github.event.pull_request.head.repo.id != github.repository_id }}
          E6_HEAD_OWNER_NE_OWNER: ${{ github.event.pull_request.head.repo.owner.login != github.repository_owner }}
          E7_GUARDED:             ${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.event.pull_request.base.repo.full_name }}
          # ...plus event_name, label, repository, ref, sha, job.workflow_*, head/base fields
        run: |
          env | grep ... | sort
          ls -la "$GITHUB_WORKSPACE"
```

Full file: https://github.com/arwagner/af-spike-prt-router/blob/main/.github/workflows/router.yml

## Runs

| Event | Object | Label | Result | Run |
|---|---|---|---|---|
| pull_request_target | PR #1 same-repo | `bug` | skipped, no runner | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934648897 |
| pull_request_target | PR #1 same-repo | `agent:review` | success | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934653632 |
| pull_request_target | PR #2 fork | `bug` | skipped, no runner | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934660212 |
| pull_request_target | PR #2 fork | `agent:review` | success | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934665761 |
| issues | issue #3 | `bug` | skipped, no runner | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934671761 |
| issues | issue #3 | `agent:review` | success | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934677665 |
| issues | issue #3 | `AGENT:Upper` | **success** (case-insensitive) | https://github.com/arwagner/af-spike-prt-caller/actions/runs/44934826061 |
| pull_request_target | same-repo PR #1 inside the fork repo `skylight-hq/af-spike-prt-caller` | `agent:review` | success | https://github.com/skylight-hq/af-spike-prt-caller/actions/runs/44934904675 |

Skipped runs: the `factory` job has `conclusion: skipped`, `runner_name: null`, 0 steps.

## Expression results

| Expression | same-repo PR | fork PR | issue | same-repo PR in a fork repo |
|---|---|---|---|---|
| E1 `head.repo.full_name != github.repository` | false | true | **true** | false |
| E2 `head.repo.full_name != base.repo.full_name` | false | true | false | false |
| E3 `head.repo.fork` | false | true | empty | **true** |
| E4 `head.repo.id != base.repo.id` | false | true | false | false |
| E5 `head.repo.id != github.repository_id` | false | true | **true** | false |
| E6 `head.repo.owner.login != github.repository_owner` | false | true | **true** | false (wrong for a fork in the same owner) |
| E7 `pull_request && E2` | false | true | empty (falsy) | false |

Only E2, E4 and E7 are right in every column. E2 is the readable one.

Other values seen inside the called workflow, all events:

- `github.repository`, `github.event_name`, `github.event.*`, `github.ref` (`refs/heads/main`), `github.sha` (base head), `github.workflow_ref` are the **caller's**. The reusable workflow sees the full original event.
- `job.workflow_repository` = `arwagner/af-spike-prt-router`, `job.workflow_sha` = router commit. This matches §1.
- Fork PR: `head.repo.full_name` = `skylight-hq/af-spike-prt-caller`, `head.label` = `skylight-hq:fork-branch`, `author_association` = `OWNER` (the PR author was arwagner, through the org fork).
- GITHUB_TOKEN permissions were `Contents: read`, `Metadata: read` for the fork PR too. On `pull_request_target`, the stub's `permissions:` block applies even to forks.
- The fork's rewritten `factory.yml` never ran: `FORK-MODIFIED` appears in no log. `pull_request_target` always takes the workflow file from the base default branch.

## Recommended expressions

Stub job filter:

```yaml
if: startsWith(github.event.label.name, 'agent:')
```

Fork test, in the router (an `if:` or a step env):

```yaml
github.event.pull_request.head.repo.full_name != github.event.pull_request.base.repo.full_name
```

It is false on events with no `pull_request`, because both sides are null. If the head repo has been deleted, `head.repo` is null, the test is true, and the PR is refused: it fails closed. (That case follows from the payload shape and was not reproduced here.)

## Pitfalls

- **`startsWith` is case-insensitive.** `AGENT:Upper` passed the filter. The router should match labels case-sensitively against its own list, and must treat `AGENT:merge` and the like deliberately.
- **`head.repo.fork` is wrong for this job.** It describes the head repo, not the PR. It gave a false positive live on a same-repo PR in a fork repo, and it would fail open (null) if the head repo were deleted.
- **Comparing against `github.repository`, `repository_id` or `repository_owner` misfires on non-PR events.** On `issues`, E1, E5 and E6 are `true` because null != string. Compare head to `base.repo` instead, or guard with `github.event_name == 'pull_request_target'`.
- **Owner comparison is not fork detection.** A fork into the same org or user (another repo name) has the same owner.
- **Skipped events still create runs.** Every non-`agent:` label adds a skipped run to the Actions list. No runner and no minutes, but noise in the list. `run-name` keeps the list readable.
- **`issue_comment` on a PR** (also a stub trigger) has no `pull_request.head` in its payload. There the router has to fetch the PR (`GET /repos/{repo}/pulls/{n}`) and apply the same head-vs-base comparison to the response.
- **Not tested here:** whether the repo setting "require approval for fork PR workflows" gates `pull_request_target`. As far as we know it is meant for `pull_request` and does not protect this stub. The PR author here was a member, so the spike couldn't show it either way. The router must refuse forks itself regardless.

## Spec follow-ups

- §1 Stub: the prefix filter is case-insensitive. Say that the router re-checks labels exactly. Also mention the skipped-run noise.
- §9 Forks: name the detection expression above, and say that `head.repo.fork` must not be used. For `issue_comment` on a PR, say the router fetches the PR to decide.
