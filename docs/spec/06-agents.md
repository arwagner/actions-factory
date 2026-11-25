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
| `codex` | `OPENAI_API_KEY`, or a Business/Enterprise `CODEX_ACCESS_TOKEN` | `codex exec --json`, tokens only. The key reaches the CLI as `CODEX_API_KEY` (what `exec` reads); an access token is logged in with `codex login --with-access-token`, into a temporary `CODEX_HOME` that also holds the skills. Read-only uses Codex's own `--sandbox read-only`. ChatGPT logins (`auth.json`) are decided, see below. |
| `copilot` | `COPILOT_GITHUB_TOKEN`, a fine-grained token with only Copilot Requests | `copilot -p --output-format json`; bills the client's Copilot seats; no third-party secret. The built-in GitHub MCP server is off, and skills go in a temporary `COPILOT_HOME`. Read-only denies the write tool; Copilot has no OS sandbox. |

Codex and Copilot have no schema flag the factory relies on: the agent writes `plan.json` as the prompt asks, or, in a read-only run, gives the plan as its final message, which the adapter writes for it.

Gemini and Antigravity are left out until their CI auth and terms are clear.

## Selection and versions

- `agent:` and `model:` per repo and per task.
- Each factory release pins every agent CLI's version. Nothing installs "latest" at run time.
- Each CLI install is cached by its pinned version. The 15-minute tick installs and saves it on a miss, because scheduled runs may write the cache while label-triggered runs get a read-only one. The jobs that run agents only restore it: a save there would follow agent-written code, which could plant a tampered CLI.

## Codex ChatGPT logins (decided in #74, built in parts)

A client can run Codex on its own ChatGPT subscription logins. This reverses the earlier rule of "no ChatGPT subscription `auth.json`". The mode is decided here; the details are written as each part lands.

- **Client-owned pool.** The logins are the client's own, held as secrets in a `codex-pool` environment in the client's repo. The factory never holds or brokers a login for anyone else.
- **Leases.** A run leases one login from the pool. Lease state lives on the `factory-auth-state` branch, so two runs never share a login.
- **Saving back.** Codex refreshes and rewrites `auth.json`, so the refreshed login must be saved. A separate job does it, using `CODEX_POOL_TOKEN`. The agent runs in a nested reusable workflow that receives neither the write-back token nor the transport private key. The `codex-pool` environment holds the logins, not the write-back credentials.
- **Encrypted handoff.** The refreshed login passes from the agent job to the saving job encrypted, never as a plain artifact.
- **The adapter (part 4).** With a leased `auth.json` path handed in (`authFile`, from the job's `CODEX_AUTH_FILE`), the adapter writes it into the temporary `CODEX_HOME` as `auth.json`, mode 0600, never in the checkout, and scrubs its token values from the transcript. After the run it writes the home's `auth.json` back over the leased path and reports `auth: { path, changed }`. A failed run reports `failure: "auth"` (the login is bad: quarantine it) or `"quota"` (a usage or rate limit: try another login), classified from Codex's error text; anything unrecognised reports neither.
- **Precedence.** `OPENAI_API_KEY` first, then `CODEX_ACCESS_TOKEN`, then a leased login. An explicit key or token the client set on purpose keeps working exactly as before, and a leased login is used only when neither is set.
- **When the mode is on (part 5).** The route job decides, not a config key: the mode is on for a run whose agent is Codex when the `factory-auth-state` branch lists at least one enrolled login (it reads that with `FACTORY_TOKEN`). It publishes this as the `codex-pool` output, and the agent job uses the `codex-pool` environment only then. If the pool can't be read the mode is off for that run, with a warning. A client that has set `OPENAI_API_KEY` or `CODEX_ACCESS_TOKEN` keeps using it and leases nothing.
- **The agent job.** One short capture step (`agent.js pool-capture`) is the only step that reads the `CODEX_AUTH_*` secrets. It writes them to a private 0600 file outside the checkout, leases one login and writes it where the adapter reads it. The agent step gets only that login's path. After the last round, `agent.js pool-handoff` seals every leased login's final `auth.json` to the transport public key and uploads only the sealed file as the `factory-pool-handoff` artifact. Every copy is removed, also when sealing fails.
- **Failover.** A quota failure sets the login aside and leases another, within the task's time budget. Logins set aside stay leased to the run until the saving job, so each is tried at most once per run. If every login is busy the step waits briefly (two minutes), then the run fails with a reason and the item is parked with it as the comment. An auth failure never fails over: it quarantines the login.
- **The saving job.** A job after the agent job (`apply.js pool-save`) holds `CODEX_POOL_TOKEN` and the transport private key, and runs no agent code. For each login the pool says this run holds, it opens the sealed handoff, checks the refreshed login is for the same account as the stored one and that the stored one is the generation the pool recorded, saves it through the encrypted-secrets API, records the new hash and releases the lease. Anything uncertain quarantines the login: no handoff, a different account, a stale generation, a failed save or release. The set of logins comes from the pool's own state, so a run can't leave one out by omission. `CODEX_POOL_TOKEN` needs only environment secrets write: the lease and hash updates use `FACTORY_TOKEN`.
- **Quarantine.** A login that fails, or can't be saved back, is quarantined and leaves the pool until a person recovers it.

**Why the old line is reversed.** The old objection was a write-back loop needing a token able to write secrets. That token (`CODEX_POOL_TOKEN`) is now the client's own, is never in the agent job, and is limited to environment secrets. It can't reach repo contents, other secrets or workflows.

The author gate and the leak risk are in section 9.
