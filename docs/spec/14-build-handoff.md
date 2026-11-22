# 14. Build handoff

What goes to the new build map. Each item becomes a ticket there, and the order shown is the suggested dependency order. Every ticket cites the spec sections it implements.

## Spikes first

Facts the build must confirm before relying on them:

1. **Dependabot and reusable workflows:** does Dependabot open bump PRs for a `uses:` ref to a reusable workflow? Section 11 assumes it for exact-pin clients.
2. **Masking in job summaries:** is a secret written to `$GITHUB_STEP_SUMMARY` masked? This was unconfirmed in #18.
3. **`pull_request_target` labeled:** confirm that the stub can route PR label events without checking out PR code, and that fork PRs are detected reliably.
4. **Runner version for `job.workflow_sha`:** confirm the minimum runner version, which matters for self-hosted clients.
5. **Masking of `FACTORY_CHECK_ENV` values:** confirm each dotenv value is registered with `::add-mask::` before checks run.

## Build slices

1. **Config engine:** JSON schema for `factory.yml` and `template.yml`, template resolution (shipped, local, other repo), layer merge, validation errors naming the layer and field, and `show-config` output. (Sections 4, 5)
2. **Stub and router:** the stub file, event filtering and `run-name`, the router's routing, write-access check, fork refusal, label creation, missing-token refusal, and stale-stub warnings. (Sections 1, 2, 9, 11)
3. **Task runner:** the agent and apply jobs, workspace handoff, plan validation, capped writes, status comments, `agent:blocked`, hooks, and `turns` with checks. (Sections 3, 8, 9)
4. **`fake` and `claude` adapters:** the adapter contract, skills install, transcript scrubbing and upload. (Section 6)
5. **Default template:** explore, implement, review and merge, with prompts and skills copied from aint-farm and adapted (no aint-farm names). (Section 4)
6. **Orchestration:** the sweep on each tick, limits, loop brake, schedules with time zones and missed slots, assignee. (Section 7)
7. **Doctor.** (Section 12)
8. **Release and sandbox:** the release workflow, end-to-end scenarios in `skylight-hq/osh-simulator`, and tag moves. (Section 11)
9. **Wiki:** `docs/wiki/` pages, generators for the config reference and template pages, and the publish step. (Section 13)
10. **Dog-food switch-on:** this repo's stub and `factory.yml`, pinned `@latest`, after the first release. (Section 11)
11. **`codex` and `copilot` adapters.** (Section 6)
12. **`full` template:** implement-spec (the sub-issue queue) and ratchet. (Sections 4, 7)
13. **`review-only` and `spec-flow` templates.** (Section 4)

## Setup only a person can do

- Create a machine user (optional), and a `FACTORY_TOKEN` for this repo and for `skylight-hq/osh-simulator`. Neither needed an org owner's approval in practice.
- Create the wiki's first page by hand.
- Put an agent credential in this repo, and in the sandbox for the optional real-agent smoke run.
