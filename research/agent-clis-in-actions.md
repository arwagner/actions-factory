# Agent CLIs running headless in Actions

Research for [#4](https://github.com/arwagner/actions-factory/issues/4). Researched 2026-11-21 from vendor docs. These products change monthly, so re-check anything load-bearing before building on it.

**Question.** What does it take to run each candidate agent CLI non-interactively in an Actions job: install, CI auth (API key vs subscription token, and ToS on public repos), headless flags, sandboxing and permissions, transcript format, skills and instruction files, and cost visibility?

**Short answer.** Claude Code and Codex both have a first-party action and a solid headless mode with JSON event streams, so either fits the Agent seam. Auth is the main difference:

- **Claude** has a documented one-year subscription token (`claude setup-token`), and the action accepts it.
- **Codex** subscription auth is a rotating `auth.json` that OpenAI says not to use on public or open-source repos. The Codex action takes API keys only.
- **Gemini CLI** still works headless with a paid API key or Vertex AI, but Google has moved consumers to Antigravity CLI (`agy`), which has no official action yet.
- **GitHub Copilot CLI** is the only candidate that can authenticate with the workflow's own `GITHUB_TOKEN` (org-owned repos).

## Comparison

| | Claude Code | OpenAI Codex | Gemini CLI | Antigravity CLI (`agy`) | GitHub Copilot CLI |
|---|---|---|---|---|---|
| First-party action | `anthropics/claude-code-action@v1` | `openai/codex-action@v1` | `google-github-actions/run-gemini-cli` | none found | none; docs show `npm i -g @github/copilot` in a step |
| Headless call | `claude -p "<prompt>"` | `codex exec "<prompt>"` | `gemini -p` (or non-TTY) | `agy -p` | `copilot -p` |
| API-key auth | `ANTHROPIC_API_KEY`; Bedrock, Vertex, Foundry via OIDC; Anthropic workload identity federation | `CODEX_API_KEY` / `OPENAI_API_KEY`; Azure endpoint | `GEMINI_API_KEY`; Vertex via service account or WIF | `GEMINI_API_KEY` plus `modelProvider: gemini`; ADC | n/a (bring-your-own-provider env vars exist) |
| Subscription auth in CI | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`: 1 year, inference only, accepted by the action | `auth.json` (ChatGPT login), refreshed and written back by Codex; "advanced"; **not for public or OSS repos**; action doesn't support it. Business/Enterprise: `CODEX_ACCESS_TOKEN` | Cached Google login only; consumer tiers cut off 2026-06-18 | Cached Google login only ("authenticate once interactively") | `GITHUB_TOKEN` (org repos) or fine-grained PAT with "Copilot Requests" as `COPILOT_GITHUB_TOKEN` |
| Permission control | `--permission-mode` (manual default under `-p`, `acceptEdits`, `auto`, `dontAsk`), `--allowedTools`, `--permission-prompts none` | `--sandbox read-only` (default) / `workspace-write` / `danger-full-access`; action `safety-strategy` (`drop-sudo` default) | `--approval-mode default\|auto_edit\|yolo\|plan`, `--sandbox`, Policy Engine | `--mode` / `agentMode` (auto by default under `-p`), `permissions.allow`, `--dangerously-skip-permissions` | `--allow-tool`, `--deny-tool`, `--allow-all-tools`, `--no-ask-user` |
| Machine output | `--output-format json\|stream-json` (NDJSON); final `result` message | `--json` (JSONL events); `-o` last message; `--output-schema` | `--output-format json\|stream-json` | `--output-format json\|stream-json` (NDJSON) | stdout to the Actions log (structured output not confirmed) |
| Instruction files | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` | not confirmed | custom instruction files (combined) |
| Skills | `.claude/skills/`, plugins; `/skill` as the prompt | `.agents/skills/` (repo up to root, `$HOME`) | `gemini skills`, extensions | Agent Skills, plugins carry over | supported |
| Cost visibility | `total_cost_usd` plus per-model breakdown in JSON (client estimate) | `usage` token counts on `turn.completed` (no dollars) | per-model token stats in JSON | not confirmed | AI credits by tokens (not in output) |

## Claude Code

**Install.** The action bundles the CLI. Standalone: Anthropic's native installer or npm (`@anthropic-ai/claude-code`); install commands weren't re-verified here.

**Action.** `anthropics/claude-code-action@v1` ([docs](https://code.claude.com/docs/en/github-actions)) runs in one of two modes:

- **Interactive** (no `prompt`): responds to `@claude`.
- **Automation** (`prompt` set): runs on any event, including cron.

Key inputs:

- `prompt`: plain text or a `/skill` invocation.
- `claude_args`: any CLI flags.
- `anthropic_api_key` or `claude_code_oauth_token`.
- `settings`, `plugins`, `plugin_marketplaces`, `github_token`.
- `use_bedrock`, `use_vertex`, `use_foundry`.

By default it authenticates to GitHub as the Claude GitHub App, which needs `id-token: write`. That app's permission set is broad (Workflows write, Administration read, and more). A custom app with only Contents, Issues and PRs is documented as the alternative. Commits pushed with the default `GITHUB_TOKEN` don't trigger CI ([same page](https://code.claude.com/docs/en/github-actions#ci-not-running-on-claudes-commits)). The action refuses non-write users and bot actors unless they are allowlisted (`allowed_non_write_users`, `allowed_bots`). This matters for a factory whose tasks are triggered by labels a bot might add.

**Auth options in CI** ([authentication](https://code.claude.com/docs/en/authentication)):

- `ANTHROPIC_API_KEY`: Console billing.
- `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token`. A "one-year OAuth token" for "CI pipelines, scripts". Needs Pro, Max, Ultra, Team or Enterprise. Inference only.
- Cloud providers via OIDC.
- Anthropic workload identity federation (`anthropic_federation_rule_id` and related inputs, no stored secret).

`--bare` does **not** read `CLAUDE_CODE_OAUTH_TOKEN` or profiles, so subscription runs can't use bare mode ([headless](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)). For shared org secrets, the docs recommend an API key "since an OAuth token is tied to the subscription of the person who ran `claude setup-token`".

**Terms** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):

- OAuth "is intended exclusively for purchasers of … subscription plans and is designed to support ordinary use of Claude Code".
- Pro, Max and Ultra limits "assume ordinary, individual usage".
- Developers "building products or services … should use API key authentication". Anthropic does not permit them "to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users".

There is no public-repo-specific prohibition like OpenAI's. Reading for the factory (*interpretation, not legal advice*): a client repo owner putting **their own** setup-token in **their own** repo's secrets matches the documented CI use. The factory, as published code, must never hold or broker anyone's subscription token. ADR-0001 (no hosted service) already fits that.

**Subscription accounting.** Per the [support article](https://support.claude.com/en/articles/15036540) as of 2026-10-07, `claude -p` and the Agent SDK signed in with a plan "still draw from your subscription limits". The separate Agent SDK credit announced for 2026-06-15 was paused. Max, Ultra and Team now include monthly API credits usable via a linked Console org's API key.

**Headless** ([headless](https://code.claude.com/docs/en/headless)):

- `-p`; exits 0 on success, non-zero on failure.
- `--output-format text|json|stream-json`. `json` carries `result`, `session_id`, `total_cost_usd` and a per-model cost breakdown ("client-side estimates"). `stream-json` with `--verbose` emits NDJSON: `system/init` (model, tools, MCP servers, plugin and MCP load errors), assistant and user messages, `system/api_retry`, and a final `result`.
- `--json-schema` for structured output.
- `--max-turns`, `--max-budget-usd`, `--append-system-prompt[-file]`, `--resume <session_id>`.

**Permissions:**

- Since v2.1.302, `-p` starts in Manual mode, so calls that need approval are denied.
- `--allowedTools` uses rule syntax, e.g. `Bash(git commit *)`.
- `--permission-mode acceptEdits|auto|dontAsk`.
- `--permission-prompts none` stops Claude retrying denied calls. Denials appear in `permission_denials`.
- Caution: without `--bare`, `-p` runs the repo's `.claude/settings.json` hooks and `.mcp.json` servers with no trust prompt.

**Transcripts.** Sessions are stored as `.jsonl` transcript files, which `--resume` accepts by path. The stream-json output is the practical log to upload as an artifact.

**Skills and instructions.** Reads `CLAUDE.md` and `.claude/skills/` from the checkout (not in `--bare`). Plugins install through action inputs. A skill can be the whole prompt (`/code-review:code-review …`).

## OpenAI Codex

**Install.** `openai/codex-action@v1` installs it. Standalone: npm `@openai/codex` (from memory, not re-verified).

**Action** ([repo](https://github.com/openai/codex-action)). Inputs:

- `openai-api-key`, `prompt` / `prompt-file`, `codex-args`, `output-file`.
- `model`, `effort`, `allow-users`, `codex-home`, `responses-api-endpoint` (Azure).
- `safety-strategy`: `drop-sudo` (default), `unprivileged-user`, `read-only`, `unsafe`.

It outputs `final-message`. The action keeps the key in a Responses API proxy so Codex doesn't see it directly. Even so, under `read-only` "Codex could read it if it can reach process memory". It supports **API keys only**: "Users must provide an API key". Windows runners need `safety-strategy: unsafe`.

**Auth in CI** ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth.md)):

- `CODEX_API_KEY` inline per run. "The right way to authenticate automation is with an API key."
- Don't put keys in job-level env where repo code runs.
- ChatGPT `auth.json` is "an advanced workflow for enterprise and other trusted private automation" and "Do not use this workflow for public or open-source repositories."
- Codex refreshes when `last_refresh` is older than about 8 days (or on a 401) and writes the new tokens back. Use one `auth.json` per runner or serialized stream, and "Do not share the same file across concurrent jobs or multiple machines". On ephemeral runners: restore, run, write back.
- The docs don't say refresh tokens are single-use. aint-farm's design assumes rotation, which this guidance is consistent with but doesn't confirm (*uncertain*).
- **Business and Enterprise** workspaces can mint expiring Codex access tokens (1 to 90 days) used as `CODEX_ACCESS_TOKEN` ([access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens.md)). The docs warn that "public CI, forked pull requests, or shared machines can expose tokens".

For the factory, aint-farm's rule stands. Codex subscription auth is out on public repos, and even on private repos it needs a write-back store plus a per-credential concurrency group. The Codex action can't do that, so it would mean a hand-rolled step around `codex exec`.

**Headless** ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)):

- `codex exec`: progress goes to stderr, the final message to stdout.
- `--json`: a JSONL stream with `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`. `turn.completed.usage` holds `input_tokens`, `cached_input_tokens`, `output_tokens` and `reasoning_output_tokens`.
- `-o` writes the last message to a file; `--output-schema` enforces a JSON Schema.
- `--ephemeral` skips the rollout files; `codex exec resume`.
- Codex requires a git repo (or `--skip-git-repo-check`).

**Permissions.** The sandbox defaults to read-only; `--sandbox workspace-write` allows edits. `--full-auto` is removed; `--approve-for-me` routes approvals to automatic review. Project config and MCP servers load only for trusted projects (`--trust`). The docs' recommended Actions pattern is to run Codex read-only, save a patch artifact, and have a separate job with write permission and no API key open the PR.

**Transcripts.** Rollout files are saved unless `--ephemeral` is set; the path wasn't re-verified (`~/.codex/sessions/…` from memory). The `--json` stream is the CI log.

**Skills and instructions.** `AGENTS.md`. Skills live in `.agents/skills/` from the working directory up to the repo root, plus `$HOME/.agents/skills`; `SKILL.md` needs `name` and `description` ([skills](https://developers.openai.com/codex/skills.md)).

**Cost.** Token counts only. Dollars must be computed from the price list, or read from the OpenAI usage dashboard.

## Gemini CLI and Antigravity CLI

**Status change.** Google moved Gemini CLI users to Antigravity CLI ([Google blog, 2026-05-19](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)):

- On 2026-06-18, Gemini CLI stopped serving AI Pro and Ultra subscribers and free Code Assist users.
- Code Assist Standard and Enterprise keep access.
- "Gemini CLI will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys."
- There is no 1:1 parity, but skills, hooks, subagents and extensions (now "plugins") carry over.

**Gemini CLI in Actions** ([run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)):

- Inputs: `gemini_api_key`, `prompt`, `settings` (written to `.gemini/settings.json`), `gemini_cli_version`, `use_vertex_ai`, `gcp_workload_identity_provider`, `use_gemini_code_assist`, `google_api_key`, `extensions`.
- Outputs: `summary`, `error`.
- Headless ([docs](https://geminicli.com/docs/cli/headless/)): `-p` or non-TTY. `--output-format json` returns `response`, `stats` (tokens and latency) and `error`. `stream-json` emits `init`, `message`, `tool_use`, `tool_result`, `error` and `result` (per-model token usage).
- Exit codes: 0, 1, 42 (input error), 53 (turn limit).
- Flags ([reference](https://geminicli.com/docs/cli/cli-reference/)): `--approval-mode default|auto_edit|yolo|plan`, `--sandbox`, `--allowed-tools` (deprecated in favour of the Policy Engine).
- Context file `GEMINI.md`; skills via `gemini skills`.
- Auth ([docs](https://geminicli.com/docs/get-started/authentication/)): headless reuses a cached login, or else `GEMINI_API_KEY` or Vertex. A service-account key is suggested for CI.
- Whether the action is maintained after the transition is *uncertain*: neither the blog nor the README says.

**Antigravity CLI.**

- Headless ([docs](https://antigravity.google/docs/cli/headless.md)): `agy -p`, `--output-format text|json|stream-json` (`init`, `step_update`, `result`), `--print-timeout`.
- Permissions: auto mode by default where available. Approvals it can't get are "soft-denied" and the run still exits 0. `--dangerously-skip-permissions`; pin `--mode` in CI.
- Headless "uses your cached credentials. Authenticate once with an interactive `agy` session first."
- The install docs say a `GEMINI_API_KEY` with `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json` "suits headless and CI runs". ADC is also supported (`AGY_ADC_AUTH=true`) ([install](https://antigravity.google/docs/install?tab=cli)). A GitHub issue ([#78](https://github.com/google-antigravity/antigravity-cli/issues/78)) earlier said API keys weren't supported, so *verify before relying on it*.
- No official action. Community forum threads question whether external orchestration of headless `agy` on account-based usage is allowed (*ToS unclear*).

## GitHub Copilot CLI (worth considering)

Per [automate with Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions) and [about Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli):

- Install: `npm install -g @github/copilot`.
- Auth: the workflow's `GITHUB_TOKEN` (recommended for org-owned repos, no stored secret) or a fine-grained PAT with "Copilot Requests" as `COPILOT_GITHUB_TOKEN`.
- Headless: `copilot -p` with `--allow-tool` (e.g. `shell(git:*)`, `write`), `--deny-tool`, `--allow-all-tools`, `--no-ask-user`.
- Output goes to the Actions log. A JSON output format wasn't confirmed.
- Skills and custom instruction files are supported; models are switchable with `--model`.
- Billing is AI credits by tokens. It would bill the client's Copilot seat, with no third-party secret at all, which suits the ADR-0001 goal of adopting without trusting outsiders.

## Others not researched

Aider, OpenCode, Cursor CLI, Amp and similar weren't checked. Each is a thin wrapper over API keys and would need its own sandbox and permission story.

## Implications for the factory (for #12 and the Agent seam)

1. **Common adapter shape.** Every serious candidate offers prompt in, permission flags, NDJSON or JSONL events out, and an instruction file plus skills directory in the checkout. An adapter maps factory permissions to each CLI's flags, collects the event stream as the transcript artifact, and installs skills where that CLI looks (`.claude/skills`, `.agents/skills`, `gemini skills`).
2. **Claude by default.** It is the only CLI with a sanctioned long-lived subscription token for CI and a dollar cost in its output.
3. **Codex: API key in the factory.** Subscription `auth.json` is allowed only on private repos with a serialized write-back loop, and the factory should refuse it on public repos (same rule as aint-farm).
4. **Wrap the CLI, not the vendor actions, for the Agent seam.** The actions differ in GitHub identity, trigger rules and output. Calling the CLIs directly in our own reusable workflow keeps one GitHub-token story (ours) and one transcript format per adapter. Use the vendor actions only as references, e.g. Codex's key-hiding proxy and `drop-sudo`.
5. **Watch the GITHUB_TOKEN trigger rule.** Pushes made with `GITHUB_TOKEN` don't start other workflows. That affects task chaining, a separate question.
