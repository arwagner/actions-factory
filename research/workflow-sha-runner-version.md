# Minimum runner version for `job.workflow_sha`

Research for ticket #29. Question: which actions/runner release first exposes `job.workflow_sha`, `job.workflow_repository` and `job.workflow_ref` to expressions in a called reusable workflow, and is there a GHES constraint. Sources are the actions/runner repo, docs.github.com and the GitHub changelog. Read on 2026-11-21. **Uncertain** marks claims not confirmed by a first-party source.

## Answer

- **Runner v2.334.0 (2026-04-21) or later** always exposes the values. Earlier runners can't be relied on.
- **Not available on GHES**, at any runner version. The values are sent by the github.com Actions service, not computed by the runner.
- On github.com, self-hosted runners older than ~30 days stop getting jobs anyway, so in practice every working self-hosted runner there is already well past v2.334.0 (latest is v2.338.2).

## How the values reach the expression

- The runner does not compute these values. The server sends a `job` dictionary in the job message's `ContextData`. The runner copies it into its `JobContext`, which is what `${{ job.* }}` reads. [ExecutionContext.cs `InitializeJob`](https://github.com/actions/runner/blob/main/src/Runner.Worker/ExecutionContext.cs)
- Step inputs such as `actions/checkout`'s `repository:`/`ref:` are evaluated by the runner, so the runner has to keep the server's `job` keys for the expression to see them.

## Runner history

| Runner | Server `job` keys reach expressions? | Source |
|---|---|---|
| < v2.324.0 | **No.** The runner replaced `job` with an empty `JobContext` (`ExpressionValues["job"] = new JobContext();`). | [#3811 diff](https://github.com/actions/runner/commit/3a27ca292a) |
| v2.324.0 – v2.333.1 | **Only if** the server sets the feature variable `actions_add_check_run_id_to_job_context`. Whether github.com still sets it for every job is **uncertain**. | [#3811](https://github.com/actions/runner/pull/3811), [Constants.cs](https://github.com/actions/runner/blob/main/src/Runner.Common/Constants.cs) |
| **≥ v2.334.0** | **Yes, always.** #4335 removed the feature-flag gate and added typed accessors `WorkflowRef`, `WorkflowSha`, `WorkflowRepository`, `WorkflowFilePath`. | [#4335](https://github.com/actions/runner/pull/4335), [v2.334.0 release notes](https://github.com/actions/runner/releases/tag/v2.334.0) |

- #4335 was merged 2026-04-10 (commit `4a587ada27`). It is in v2.334.0 (published 2026-04-21) and not in v2.333.1 (checked with `compare v2.333.1...v2.334.0`). [releases](https://github.com/actions/runner/releases)
- The PR description mentions a fallback that derives `workflow_repository`/`workflow_file_path` from `workflow_ref`, but the merged commit doesn't contain it. The runner only passes through what the server sends. [commit 4a587ada27](https://github.com/actions/runner/commit/4a587ada27)
- The service shipped the feature to users on 2026-09-03, after v2.334.0. So there was never a time when github.com sent the values and only older runners existed. [changelog](https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates)
- Datadog's third-party figure of "v2.334.0+" (cited in `research/actions-platform-limits.md`) agrees with the source.

## GHES

- Contexts reference: each of `job.workflow_ref`, `job.workflow_sha`, `job.workflow_repository` and `job.workflow_file_path` is marked "(not available on GitHub Enterprise Server)". [contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)
- Changelog: "These properties are not available on GitHub Enterprise Server." [changelog](https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates)
- So no GHES version is enough today. A GHES client would need another way for the factory to find its own commit, such as the stub passing the ref as an input.

## Self-hosted runner update policy (github.com)

- Runners must be on v2.329.0 or later to register. They also have to install each new release within 30 days of publication, or "the Actions service stops queuing jobs" to them. Auto-update meets this. Full enforcement on GHEC started on 2026-09-25 (2026-07-31 for GHE.com data residency). "GitHub Enterprise Server isn't impacted at this time." [changelog: minimum version enforcement](https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/), [self-hosted runner requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- So on github.com a runner that can still take jobs is newer than v2.334.0. The minimum matters only for a runner that is somehow exempt or misconfigured.

## What this means for the spec

- §1 checks out `job.workflow_repository` at `job.workflow_sha` in the **router**, and §8 runs the route job on `ubuntu-latest` always. The router's read therefore never depends on a client's self-hosted runner.
- If the **agent job** (which runs on the client's `runsOn`) also needs the factory files, it should take the repo and SHA from router outputs instead of evaluating `job.workflow_*` itself. Then the self-hosted runner version doesn't matter for this feature.
- State in §8: self-hosted runners need actions/runner ≥ v2.334.0 if they evaluate `job.workflow_*`. On github.com the 30-day update rule already guarantees this. GHES is unsupported because the properties don't exist there.
