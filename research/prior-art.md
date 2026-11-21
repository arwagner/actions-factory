# Prior art: agent factories built on GitHub Actions

Ticket: #5. Researched 2026-11-21 against official docs and source repos. Claims are cited inline; anything not confirmed from a primary source is marked **(unverified)**.

## Question

How do existing Actions-based agent systems structure config, templates and task chaining? What should we borrow, and what should we avoid, for: a config-file-driven pipeline, swappable presets, label-driven state machines, and many repos calling one shared repo?

## Systems surveyed

### 1. claude-code-action (Anthropic)

- **Shape:** one composite action, configured entirely by `with:` inputs in the client's own workflow file. No config file of its own. Trigger inputs: `trigger_phrase` (default `@claude`), `label_trigger` (default `claude`), `assignee_trigger`. Behaviour inputs: `prompt`, `claude_args` (raw CLI args), `settings` (JSON or path), `plugins`, `branch_prefix` (default `claude/`), `branch_name_template`, `track_progress`, `use_sticky_comment`. Outputs include `branch_name`, `session_id` and `structured_output` (when `--json-schema` is passed). [action.yml](https://github.com/anthropics/claude-code-action/blob/main/action.yml)
- **Mode picked implicitly:** if `prompt` is set it runs at once ("automation mode"); without it, it waits for an `@claude` mention ("interactive mode"). [docs/faq.md](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md)
- **Presets = copy-paste examples.** `examples/` holds whole workflow files (issue triage, PR review, path-filtered review, CI-failure auto-fix, scheduled maintenance, dedup...). Clients copy and edit them; there is no upgrade path from a copied example. [examples/](https://github.com/anthropics/claude-code-action/tree/main/examples), [docs/solutions.md](https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md)
- **No chaining.** Each workflow is a single shot. The FAQ says the `github-actions` user "cannot trigger subsequent GitHub Actions workflows" and recommends a PAT or your own app token. [docs/faq.md](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md)
- **Guardrails:** only users with write access trigger it; it cannot approve PRs or submit formal reviews; pushes only to its own branch; "instructed not to merge branches, rebase". The Claude GitHub App lacks workflow-write permission. [capabilities-and-limitations.md](https://github.com/anthropics/claude-code-action/blob/main/docs/capabilities-and-limitations.md), [faq.md](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md)

### 2. openai/codex-action

- Same shape as claude-code-action: a single action with `prompt` / `prompt-file`, `codex-args`, `output-schema`, output `final-message`. [README](https://github.com/openai/codex-action/blob/main/README.md)
- Worth borrowing: a `safety-strategy` input (`drop-sudo` default, `unprivileged-user`, `read-only`, `unsafe`); "protected runs reject overrides that change permissions, trust, model providers"; `config.toml` "must not come from an untrusted checkout"; example splits the agent job (`contents: read`) from a second job that posts comments with write permissions. [README](https://github.com/openai/codex-action/blob/main/README.md)

### 3. run-gemini-cli (Google) — dispatcher pattern

- One `gemini-dispatch.yml` listens to issue/PR/comment events, computes a `command` output (`review`, `triage`, `invoke`, `approve`→plan-execute, else `fallthrough`) from `event_name.action` plus `@gemini-cli /cmd` text, then calls one of several local reusable workflows (`uses: ./.github/workflows/gemini-review.yml`, etc.) with `secrets: inherit`. Only plan-execute gets `contents: write`. A `fallthrough` job posts a failure comment linking to the run log. Comment triggers are gated on `author_association` in OWNER/MEMBER/COLLABORATOR. [gemini-dispatch.yml](https://github.com/google-github-actions/run-gemini-cli/blob/main/examples/workflows/gemini-dispatch/gemini-dispatch.yml)
- Distribution is still copy-into-repo (`/setup-github` command in the CLI, or manual copy); project instructions live in `GEMINI.md`; CLI settings come via a `settings` JSON input written to `.gemini/settings.json`. [README](https://github.com/google-github-actions/run-gemini-cli/blob/main/README.md)

### 4. OpenHands resolver — the closest "many repos call one shared reusable workflow" precedent

- Client repos carried a thin caller workflow that triggered on `issues: labeled`, `pull_request: labeled`, comments and reviews, and did `uses: All-Hands-AI/OpenHands/.github/workflows/openhands-resolver.yml@main`, passing knobs from repo **variables** (`vars.OPENHANDS_MACRO`, `OPENHANDS_MAX_ITER`, `LLM_MODEL`, `TARGET_BRANCH`, `TARGET_RUNNER`) and secrets `PAT_TOKEN`, `PAT_USERNAME`, `LLM_API_KEY`. [example caller @0.50.0](https://github.com/All-Hands-AI/OpenHands/blob/0.50.0/openhands/resolver/examples/openhands-resolver.yml)
- The shared workflow did the routing itself: its job `if:` checked `github.event.label.name == 'fix-me'` / `'fix-me-experimental'` or the `@openhands-agent` macro in comment bodies, then opened a **draft** PR (input `pr_type`, default `draft`) or pushed a branch on failure, commented on the issue, and removed the label. It fell back from `PAT_TOKEN` to `github.token` with a warning. [openhands-resolver.yml @0.50.0](https://github.com/All-Hands-AI/OpenHands/blob/0.50.0/.github/workflows/openhands-resolver.yml), [PyPI 0.3.x README](https://pypi.org/project/openhands-resolver/0.3.1)
- It installed whatever `openhands-ai` version was newest on PyPI at run time (and a git-main install for the `-experimental` label). [same file, "Get latest versions" step](https://github.com/All-Hands-AI/OpenHands/blob/0.50.0/.github/workflows/openhands-resolver.yml)
- **The shared workflow was deleted** from `main` on 2026-04-23 ("Removed the V0 resolver (#14062)"). Every client pinned to `@main` broke with no migration in the caller. [commit cc100c0](https://github.com/OpenHands/OpenHands/commit/cc100c0d10fbefcc35eb80936a926405801d941a)

### 5. Sweep

- A hosted GitHub App, not an Actions-delivered system; configured by a per-repo `sweep.yaml` (`branch`, `blocked_dirs`, `draft`, free-text `description`, `rules:` list, `gha_enabled` to read Actions results). The project has since pivoted to a JetBrains plugin. [sweep.yaml](https://github.com/sweepai/sweep/blob/main/sweep.yaml), [README](https://github.com/sweepai/sweep)
- Relevance: a precedent for "config file in client repo" with natural-language `rules`, and a cautionary tale for depending on a hosted service (which ADR 0001 already avoids).

### 6. GitHub Copilot coding agent ("cloud agent")

- Runs by default in a GitHub Actions-based environment; one branch and one PR per task; hard 59-minute session limit. [about](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- Customisation by **convention-named file**: `.github/workflows/copilot-setup-steps.yml` with a single job that "MUST be called `copilot-setup-steps`", only `steps`, `permissions`, `runs-on`, `services`, `snapshot`, `timeout-minutes` honoured ("your changes will be ignored" otherwise); must be on the default branch. Plus custom instructions, custom agents/skills and repo MCP settings. [customize the agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-environment)
- Guardrails worth copying: only write-access users can trigger, others' comments aren't passed to the agent; new work goes on a `copilot/` branch and the agent can only push there; "workflows are not triggered until Copilot cloud agent's code is reviewed"; the user who asked for the PR can't approve it; internet is firewalled by default. [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)

### 7. GitHub Agentic Workflows (gh-aw, GitHub Next) — the richest config/preset design

- Each workflow is Markdown with YAML frontmatter; `gh aw compile` turns it into a hardened `.lock.yml`. Engines are swappable (Copilot, Claude Code, Codex, Gemini, Pi). The agent job is read-only by default; writes go through **safe-outputs**, which run in separate permission-scoped jobs. [overview](https://github.github.com/gh-aw/introduction/overview/)
- **Safe outputs** are typed and capped: e.g. `add-labels` max 5 calls with `allowed`/`blocked` glob lists (blocked wins), `remove-labels`, `create-pull-request` max 1, `merge-pull-request` (experimental), `dispatch-workflow` max 3, `assign-to-agent`, plus `noop` and `report-missing-tool`. [safe-outputs](https://github.github.com/gh-aw/reference/safe-outputs/)
- **Label triggers:** `names:` filter keeps the label; `label_command:` treats a label as a one-shot command and removes it by default so it can be re-applied. Also `roles:` allowlist (default admin/maintainer/write), `skip-if-match:` (search-based dedupe), `stop-after:` (cost deadline), `manual-approval:` (environment gate). [triggers](https://github.github.com/gh-aw/reference/triggers/)
- **Presets/sharing:** `imports:` pulls shared components locally or cross-repo as `owner/repo/path@ref` at **compile time**, cached by SHA in `.github/aw/imports/`. Merge rules are explicit per field (tools deep-merge, network domains union, permissions validated not merged, steps prepended; duplicate env/safe-output/service keys fail compilation). `inlined-imports: true` embeds them for cross-org `workflow_call`. [imports](https://github.github.com/gh-aw/reference/imports/)
- **Distribution:** `gh aw add owner/repo/workflow@v1.0.0` copies a workflow into the client; a `source:` field records upstream path+ref so updates "merge in those local changes by default"; `update` can open a PR. [CLI](https://github.github.com/gh-aw/setup/cli/)
- **CI triggering:** PRs created with `GITHUB_TOKEN` don't run CI, so gh-aw pushes an extra empty commit with a PAT or App token (`github-token-for-extra-empty-commit`, or magic secret `GH_AW_CI_TRIGGER_TOKEN`). [triggering CI](https://github.github.com/gh-aw/reference/triggering-ci/)

## Platform facts that constrain the design

- **`GITHUB_TOKEN` events don't start workflows** — except `workflow_dispatch`/`repository_dispatch` (always run) and `pull_request` opened/synchronize/reopened (run, but held for approval). A `labeled` event from `GITHUB_TOKEN` does **not** create a run. [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- **Reusable workflow limits:** up to 10 levels of nesting; max 50 unique reusable workflows per file; caller-level `env` not propagated; the `github` context in the callee "is always associated with the caller workflow"; `uses:` can't contain expressions (so the template can't be picked dynamically by `uses:`); permissions can only stay the same or shrink down the chain; secrets only reach the directly called workflow; `secrets: inherit` only within the same org/enterprise; a ref can be SHA, tag or branch (SHA safest). [reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations), [reuse workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- **(unverified)** A called workflow doesn't get a checkout of its own repo; reading the factory's own prompts/templates at the same ref needs extra work (e.g. the `job_workflow_sha` claim in the OIDC token, or shipping them inside a versioned action). Needs confirmation in the spike that designs delivery.

## Patterns to borrow

1. **Thin caller + one shared entrypoint that routes.** OpenHands (shared workflow decides from `github.event`) and Gemini (dispatcher job computes a `command`, then calls one reusable workflow per task). Since `uses:` can't be dynamic, the factory needs a static list of task jobs gated by a computed command — or one generic job that reads `factory.yml`.
2. **Read-only agent job, separate write job.** gh-aw safe-outputs and codex-action's two-job example: the agent proposes typed outputs (labels, PR, comment), a separate permission-scoped job applies them with caps and label allowlists. This is also where label state transitions should happen.
3. **Labels as one-shot commands.** gh-aw `label_command` (remove label after firing, so re-applying retries) and OpenHands (remove `fix-me` when done). Pair with a status reaction/comment and a fallthrough comment on failure linking to the run log (Gemini).
4. **Explicit, typed preset merge rules.** gh-aw imports define per-field merge semantics and fail on conflicting keys. Templates + `factory.yml` overrides should have equally explicit rules (and a `schemaVersion`, as aint-farm already does).
5. **Version pin + recorded source.** gh-aw records `source: owner/repo/path@ref` and offers `update` as a PR. Clients should pin the factory to a tag/SHA and get bumps via PR (Dependabot can update `uses:` refs **(unverified for reusable workflows — check)**).
6. **Agent swap via a thin adapter.** Every vendor action exposes the same shape: prompt in, raw CLI args passthrough, structured output (`--json-schema` / `output-schema`), final message/session id out. gh-aw's `engine:` field shows one config key can select the CLI.
7. **Guardrails from Copilot/Claude:** write-access-only triggering, ignore comments from others, agent-only branch prefix, agent never approves or merges its own work without a separate gate, draft PRs by default, network firewall, cost brakes (`stop-after`, `skip-if-match`, aint-farm's throttles).
8. **Convention-named setup hook** (`copilot-setup-steps.yml`): a fixed file/job name with a small whitelisted key set is a clean way to let clients add toolchain setup without forking the template.

## Pitfalls to avoid

1. **Label chaining silently dies under `GITHUB_TOKEN`.** A task that adds the next task's label with `GITHUB_TOKEN` will not trigger it. Either use a GitHub App/PAT token for label writes, or chain with `workflow_dispatch`/`repository_dispatch` (which always run). PRs opened with `GITHUB_TOKEN` also won't run CI without approval or a PAT/App push (gh-aw's empty-commit trick).
2. **Pinning clients to `@main` of the shared repo.** OpenHands deleted the shared workflow and every `@main` caller broke. Publish tagged releases and tell clients to pin; keep old majors working.
3. **Floating dependencies inside the shared workflow.** OpenHands installed "latest from PyPI" on every run, so a client's behaviour changed without any change in either repo. Pin agent CLI versions per factory release.
4. **Copy-paste presets.** claude-code-action and Gemini examples are copied into each repo and drift with no upgrade path. Templates should be referenced, not copied — or, if copied, carry a source pin and an update command.
5. **Assuming callee context.** In a reusable workflow, `github.*` is the caller's event; caller `env` doesn't pass through; secrets must be passed explicitly unless same-org `inherit`. OpenHands' `if: github.event_name == 'workflow_call'` branch appears to be dead code for this reason **(inference)**.
6. **Config spread across repo variables.** OpenHands put knobs in `vars.*`, invisible in code review and per-repo. A checked-in `factory.yml` is better; reserve secrets/vars for credentials.
7. **Trigger spoofing / prompt injection.** Gate on actor permission (not just a label or `@mention`), skip fork PRs or restrict them (claude-code-action `restrict_untrusted_prs`), and don't load agent config from an untrusted checkout (codex-action).
8. **Runner time limits.** Copilot caps sessions at 59 minutes; long tasks need checkpointing (draft PR / pushed branch on failure, as OpenHands did) rather than one long job.

## Sources

- https://github.com/anthropics/claude-code-action/blob/main/action.yml
- https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md
- https://github.com/anthropics/claude-code-action/blob/main/docs/capabilities-and-limitations.md
- https://github.com/anthropics/claude-code-action/blob/main/docs/solutions.md
- https://github.com/anthropics/claude-code-action/tree/main/examples
- https://github.com/openai/codex-action/blob/main/README.md
- https://github.com/google-github-actions/run-gemini-cli/blob/main/README.md
- https://github.com/google-github-actions/run-gemini-cli/blob/main/examples/workflows/gemini-dispatch/gemini-dispatch.yml
- https://github.com/All-Hands-AI/OpenHands/blob/0.50.0/.github/workflows/openhands-resolver.yml
- https://github.com/All-Hands-AI/OpenHands/blob/0.50.0/openhands/resolver/examples/openhands-resolver.yml
- https://github.com/OpenHands/OpenHands/commit/cc100c0d10fbefcc35eb80936a926405801d941a
- https://pypi.org/project/openhands-resolver/0.3.1
- https://github.com/sweepai/sweep/blob/main/sweep.yaml
- https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/customize-the-agent-environment
- https://github.github.com/gh-aw/introduction/overview/
- https://github.github.com/gh-aw/reference/safe-outputs/
- https://github.github.com/gh-aw/reference/triggers/
- https://github.github.com/gh-aw/reference/imports/
- https://github.github.com/gh-aw/setup/cli/
- https://github.github.com/gh-aw/reference/triggering-ci/
- https://docs.github.com/en/actions/concepts/security/github_token
- https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
- https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
