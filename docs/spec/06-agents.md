# 6. Agents

Decided in: Agent CLIs research (#4), The agent seam (#12).

## The adapter contract

An adapter is a Node module in this repo at `src/agents/<name>.ts`, run by the agent job's one generic agent step. Composite actions don't work here: `uses:` can't name an adapter by expression, and a local action would have to sit inside the checkout the agent can edit (#54). The step gets only the chosen adapter's credentials. Adapters live only in this repo: a new agent ships as a factory release with a new stub version, because the stub has to name the new secret.

**Inputs:**
- checkout path;
- prompt file (the template prompt plus every layer's `instructions`);
- the task's skills;
- the plan's JSON schema;
- the turn number (later turns follow failed checks; the prompt then includes their scrubbed output);
- permission profile (`read-only` or `edit-workspace`);
- model;
- time and budget limits.

**Outputs:**
- `plan.json`, written to a given path; the factory validates it. An adapter may also use its CLI's native schema flag.
- An NDJSON transcript.
- Usage: tokens, plus dollars where the CLI reports them.
- Exit status: `ok`, `failed` or `timed-out`.

**Duties:**
- Install the task's skills where its CLI looks (`.claude/skills`, `.agents/skills`, …). Each CLI reads the repo's own instruction files (`AGENTS.md`, `CLAUDE.md`) itself.
- Map the permission profile onto the CLI's own flags.
- Never put a GitHub token in the agent's environment.

The factory wraps each CLI directly instead of using the vendors' own Actions. Those Actions differ in GitHub identity, trigger rules and output.

## Adapters in v1

| Adapter | Credential | Notes |
|---|---|---|
| `claude` (default) | `ANTHROPIC_API_KEY`, or the client's own `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Headless `claude -p`, stream-json transcript, cost in output. A subscription token must be the client's own, in their own repo; the factory never holds or brokers one. |
| `codex` | `OPENAI_API_KEY`, or a Business/Enterprise `CODEX_ACCESS_TOKEN` | `codex exec --json`, tokens only. No ChatGPT subscription `auth.json`: that would need a write-back loop and a token able to write secrets. |
| `copilot` | `COPILOT_GITHUB_TOKEN`, a fine-grained token with only Copilot Requests | Bills the client's Copilot seats; no third-party secret. |

Gemini and Antigravity are left out until their CI auth and terms are clear.

## Selection and versions

- `agent:` and `model:` per repo and per task.
- Each factory release pins every agent CLI's version. Nothing installs "latest" at run time.
- Each CLI install is cached by its pinned version.
