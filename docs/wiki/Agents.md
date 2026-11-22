# Agents

The factory runs each agent's own CLI, headless, at a version pinned by the factory release, and caches the install. Choose one with `agent:` at the top level or per task. The default is `claude`.

| `agent:` | CLI | Credential secret | Usage reported |
|---|---|---|---|
| `claude` | Claude Code (`claude -p`) | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` | tokens and dollars |
| `codex` | Codex (`codex exec`) | `OPENAI_API_KEY`, or a Business/Enterprise `CODEX_ACCESS_TOKEN` | tokens |
| `copilot` | Copilot CLI (`copilot -p`) | `COPILOT_GITHUB_TOKEN` | tokens |

A run whose agent has no credential stops before the agent starts, with a comment naming the secret to set. The doctor sends each configured agent a tiny test prompt.

## Claude

- **API key:** `ANTHROPIC_API_KEY`, billed per token. On public repos, use a key with a spend limit (see [Safety](Safety)).
- **Subscription:** `CLAUDE_CODE_OAUTH_TOKEN`, from running `claude setup-token` on your own machine. It must be **your own** token, in **your own** repo: the factory never holds or brokers one for anyone else.

## Codex

- **API key:** `OPENAI_API_KEY`.
- **Business or Enterprise workspace:** `CODEX_ACCESS_TOKEN`.
- A ChatGPT subscription login (`auth.json`) isn't supported: Codex refreshes and rewrites it, which a CI run can't do safely.

## Copilot

`COPILOT_GITHUB_TOKEN`: a fine-grained token with **only** the Copilot Requests permission. It bills your Copilot seats, and needs no third-party secret. Never use `FACTORY_TOKEN` here. Copilot's built-in GitHub tools are switched off: the agent has no GitHub access, whichever CLI it is.

## Choosing per task

Cheaper, faster models suit read-only tasks; stronger ones suit implement and review:

```yaml
agent: claude
tasks:
  explore:
    model: claude-haiku-5-5
  review:
    agent: codex
```

## What every agent gets, and doesn't

- The checkout, the prompt, the task's skills (installed where its CLI looks), and the plan's JSON schema.
- Its own credential, and nothing else: no `FACTORY_TOKEN`, no `GITHUB_TOKEN`.
- `read-only` tasks map onto each CLI's own restrictions; `edit-workspace` tasks may edit the checkout. Either way, pushing is the factory's job.
- Each CLI reads your repo's own instruction files (`AGENTS.md`, `CLAUDE.md`).

Gemini and Antigravity aren't supported yet.
