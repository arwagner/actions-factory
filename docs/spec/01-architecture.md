# 1. Architecture

Decided in: Packaging (#6), Actions platform limits (#2), Prior art (#5), cross-owner test (#18). See ADR 0002.

## Layers

```
client repo                               this repo (arwagner/actions-factory)
.github/workflows/factory.yml  (stub) ──► .github/workflows/router.yml  (reusable)
factory.yml                                 ├─ route job      (ubuntu-latest)
.factory/  (client's own files)             ├─ agent job      (client's runsOn / container)
                                            └─ apply job      (ubuntu-latest)
```

- **Stub.** One fixed workflow that the client copies once. It wakes on:
  - `issues` and `pull_request_target` `labeled` events whose label starts with `agent:`. A job-level `if:` filters on the prefix before any runner starts. Other labels still leave a skipped run, with no runner, in the Actions list. `startsWith` ignores case, so the router re-checks the label exactly;
  - `workflow_dispatch`, with a `command` input (`doctor`, `show-config`);
  - `repository_dispatch`, which the router ignores for now. It's reserved for external triggers, so they can come later without a new stub;
  - a `schedule` tick every 15 minutes.

  It doesn't listen to `issue_comment`. Every comment would wake it, including the factory's own, and comment-triggered tasks would need new task fields anyway (#36).

  It sets a readable `run-name` (`factory · agent:review · #42`) and calls the router at the version it pins, passing the named secrets (section 2). It carries its own version in a comment.
- **Router.** A reusable workflow in this repo. It reads `factory.yml` and the resolved template stack, validates the merged config, and picks at most one task per event, or none. It refuses or defers with a reason (section 7). It creates any missing labels, then hands the task to the task runner jobs.
- **Task runner.** A generic job graph that is the same for every task. Tasks are data, not workflow files (section 3), so a template can replace the whole pipeline without touching the client's workflows.
  - **agent job:** setup action, the agent, and checks, with up to `turns` rounds.
  - **apply job:** validates the plan and makes the writes.

  The split between them is a safety rule (section 9).

A template can't add triggers at run time. Workflow files have to be on the client's default branch, and `uses:` can't be an expression. That is why the stub is generic and listens broadly.

## How the factory reads its own files

The router checks out `job.workflow_repository` at `job.workflow_sha` into `$RUNNER_TEMP/actions-factory` (`persist-credentials: false`). It then uses its actions, prompts, skills and templates from there by local path. So everything matches the exact commit the client's stub pinned. Verified across owners with the default token (#18). `.factory/` in the client checkout is left for the client's own files.

## Platform limits the design accepts

- Labels, comments and pushes made with GITHUB_TOKEN start no workflows. That is why `FACTORY_TOKEN` exists (section 2).
- A hosted job lasts at most 6 h. GITHUB_TOKEN is limited to 1,000 API calls per hour per repo.
- Scheduled runs are best-effort and can be dropped, so every sweep is idempotent (section 7).
- With the default single queue, a concurrency group drops all but the newest pending run. The factory uses `queue: max` where losing a run matters.
