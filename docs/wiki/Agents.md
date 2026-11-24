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
- **ChatGPT logins (client-owned pool):** your own ChatGPT logins, kept as secrets in a `codex-pool` environment. A run leases one (state on the `factory-auth-state` branch), and a separate job saves the refreshed login back using `CODEX_POOL_TOKEN`, a token of yours limited to environment secrets that the agent never sees. A failing login is quarantined. Only items from authors with write access run in this mode.

### The pool command

Run it from a machine you trust, from a checkout of the factory release you use, with `CODEX_POOL_TOKEN` set (your own token, limited to environment secrets; it also needs Contents write to keep the state branch, and Variables write for the transport public key). Name the repo with `--repo owner/repo` or `GITHUB_REPOSITORY`. It is `dist/pool.js` in the release; no install step.

```sh
export CODEX_POOL_TOKEN=...
node dist/pool.js --repo you/your-repo init
node dist/pool.js --repo you/your-repo seed work s1 ./auth.json
node dist/pool.js --repo you/your-repo check
node dist/pool.js --repo you/your-repo recover [--force SESSION]
```

1. **Enrollment.** Create the `codex-pool` environment in the repo's settings and limit its deployment branches to selected branches. Then `init` checks both, creates the `factory-auth-state` branch if it is missing, and makes the transport key pair: the public key goes in the repository variable `CODEX_POOL_TRANSPORT_PUBLIC_KEY` (the agent job reads it) and the private key in the `codex-pool` secret `CODEX_POOL_TRANSPORT_PRIVATE_KEY`. Rerunning `init` keeps an existing pair.
2. **Seeding.** Make each login fresh, never from a copied local `auth.json`:

   ```sh
   CODEX_HOME=$(mktemp -d) codex -c 'cli_auth_credentials_store="file"' login --device-auth
   ```

   Then `seed <account> <session> <auth.json>` stores it as the `codex-pool` secret `CODEX_AUTH_<SESSION>` (the session in capitals, `-` as `_`) and adds it to the pool. It refuses a repeated account or session ID, and a login whose refresh token is already seeded: two copies of one login invalidate each other.
3. **Checking.** `check` is read-only. It shows each login as free, leased (with the owning run and attempt) or quarantined (with the reason).
4. **Recovery.** `recover` quarantines logins whose owner run has ended without releasing them. A lease never expires by time. If GitHub can't say whether a run ended, the login stays reserved and `recover` exits non-zero. `recover --force SESSION` quarantines that session's login now, whoever holds it.

The agent can read the login it leases, and a leaked ChatGPT login reaches the whole account. See [Safety](Safety).

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
