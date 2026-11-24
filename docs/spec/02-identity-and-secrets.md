# 2. Identity and secrets

Decided in: Identity and task chaining (#7), Safety model (#14), cross-owner test (#18), schema (#23). See ADR 0001 and ADR 0003.

## The factory's identity

- The factory acts in a client repo with a **personal access token** stored as the `FACTORY_TOKEN` secret, and **refuses to run without it**. Without it, the router stops and comments, using GitHub's own default token, how to set one up.
- **Fine-grained is recommended:** limited to the client's repo, with Contents, Issues and Pull requests set to write. Workflows (write) is added only if some task sets `allowWorkflowChanges: true`.
- **Classic works too.** It's documented as the way around an org's approval of fine-grained tokens, with a warning that it reaches every repo its owner can.
- The factory doesn't check which kind it was given.
- **Owner:** a machine user is recommended. With a person's own token, the factory's comments and labels appear as that person.
- **Org repos:** a fine-grained token that targets an org stays pending until an org owner approves it (GitHub's default). Any member can create one, limited to their own access.
- **No GitHub App of any kind,** including one a client registers for itself. **No GITHUB_TOKEN-only mode.**

## Chaining

A label added with `FACTORY_TOKEN` starts workflows. So a task hands off by adding the next task's label, and people start tasks the same way. The stub wakes and the router runs the task the label names. There is no dispatch-based chaining.

## Secrets the stub passes

`secrets: inherit` silently passes nothing across owners (tested in #18), so the stub passes this fixed list by name:

| Secret | Used by |
|---|---|
| `FACTORY_TOKEN` | the apply job (writes), the router (reads) |
| `FACTORY_CHECK_ENV` | check steps only; dotenv format, one `NAME=value` per line |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | the Claude adapter |
| `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` | the Codex adapter |
| `CODEX_POOL_TOKEN` | the saving job of the Codex ChatGPT-login mode only (section 6): a client-owned token limited to environment secrets, never in the agent job |
| `COPILOT_GITHUB_TOKEN` | the Copilot adapter (a token with only Copilot Requests, never `FACTORY_TOKEN`) |

- Adding an adapter that needs a new secret means a new stub version (section 11).
- Each secret goes only into the step that needs it, never job-wide (section 9).
- The Codex ChatGPT-login mode (section 6) keeps its logins as secrets in a `codex-pool` environment, not in this list. Only the saving job holds `CODEX_POOL_TOKEN`.
- A run whose agent has no credential refuses, with a comment naming the secret it needs.
