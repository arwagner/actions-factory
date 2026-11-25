# Agents

The factory runs each agent's own CLI, headless, at a version pinned by the factory release, and caches the install. Choose one with `agent:` at the top level or per task. The default is `claude`.

| `agent:` | CLI | Credential secret | Usage reported |
|---|---|---|---|
| `claude` | Claude Code (`claude -p`) | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` | tokens and dollars |
| `codex` | Codex (`codex exec`) | `OPENAI_API_KEY`, or a Business/Enterprise `CODEX_ACCESS_TOKEN` | tokens |
| `copilot` | Copilot CLI (`copilot -p`) | `COPILOT_GITHUB_TOKEN` | tokens |

A run whose agent has no credential stops before the agent starts, with a comment naming the secret to set. The doctor sends agents with direct credentials a tiny test prompt. It checks a Codex login pool without using a login.

## Claude

- **API key:** `ANTHROPIC_API_KEY`, billed per token. On public repos, use a key with a spend limit (see [Safety](Safety)).
- **Subscription:** `CLAUDE_CODE_OAUTH_TOKEN`, from running `claude setup-token` on your own machine. It must be **your own** token, in **your own** repo: the factory never holds or brokers one for anyone else.

## Codex

- **API key:** `OPENAI_API_KEY`.
- **Business or Enterprise workspace:** `CODEX_ACCESS_TOKEN`.
- **ChatGPT logins (client-owned pool):** your own ChatGPT logins, kept as secrets in a `codex-pool` environment. A run leases one (state on the `factory-auth-state` branch), and a separate job saves the refreshed login back using `CODEX_POOL_TOKEN`, a token of yours limited to environment secrets that the agent never sees. A failing login is quarantined. Only items from authors with write access run in this mode.

### Codex login pool runbook

**Enroll.** Use a current factory stub and pick `agent: codex`. Leave `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` unset in that client if you want the pool. Those credentials take precedence.

1. In **Settings → Environments**, create `codex-pool`. Choose **Selected branches and tags** and allow only trusted client branches.
2. Set the client repository secret `CODEX_POOL_TOKEN` to a fine-grained token scoped to that repository with **Environments: write**. This is the CI write-back token, not the setup credential.
3. From a trusted machine, use the same factory release as the stub. For local commands, set `CODEX_POOL_TOKEN` in your shell to an operator token with **Contents: write**, **Environments: write**, **Secrets: write**, and **Variables: write** on that client. Add **Actions: read** for `recover`. Keep the operator token out of CI.
4. Run `node dist/pool.js --repo you/your-repo init`. It creates `factory-auth-state` and the transport key pair. The public key is a repository variable and the private key is a repository secret. Don't put the private key or either token in the login environment. Rerunning `init` retains an existing key pair.

**Add capacity.** Pick a free slot from `slot-01` through `slot-08` and a new account alias. Use a distinct login for every slot. A second copy of the same refresh token isn't extra capacity. For each enrollment, sign in fresh and delete the temporary home afterward:

```sh
(
  set -e
  umask 077
  pool_home="$(mktemp -d)"
  trap 'rm -rf -- "$pool_home"' EXIT
  CODEX_HOME="$pool_home" codex -c 'cli_auth_credentials_store="file"' login --device-auth
  node dist/pool.js --repo you/your-repo seed work slot-01 "$pool_home/auth.json"
)
```

**Check and recover.** Run the stub's **doctor** to check the environment, branch rules, state branch, and save-back token without consuming a login. Run `node dist/pool.js --repo you/your-repo check` for each alias, slot, lease owner or quarantine reason. If the pool is exhausted, wait for active runs or add capacity. If a run ended without releasing a login, run `node dist/pool.js --repo you/your-repo recover`. It quarantines abandoned logins, never expires an active lease by time and leaves the login reserved if GitHub can't confirm the run ended.

**Reseed or remove.** Do one maintenance operation at a time. Verify any run holding the login has finished, including save-back. Run `node dist/pool.js --repo you/your-repo remove work` using the account alias, not its slot. It refuses an active lease, quarantines an idle login before touching its secret, then removes the secret and state record. This frees the slot. To reseed it, repeat the fresh sign-in and `seed` procedure using the same alias and slot. If the login may have leaked, revoke the old session before reseeding. Do not restore a saved copy of `auth.json`.

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
