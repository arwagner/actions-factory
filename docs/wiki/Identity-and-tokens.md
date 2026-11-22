# Identity and tokens

## Why a personal access token

The factory acts in your repo with a personal access token stored as the `FACTORY_TOKEN` secret, and refuses to run without one. Two reasons:

- **Chaining.** A label added with GitHub's built-in `GITHUB_TOKEN` starts no workflows. A label added with a personal token does. So a task hands off to the next by adding its label (implement adds `agent:review`), and people start tasks the same way.
- **No app.** The factory has no GitHub App, not even one you register yourself, and no `GITHUB_TOKEN`-only mode.

Without `FACTORY_TOKEN`, the factory comments on the item, using the built-in token, with a link to these steps.

## A fine-grained token (recommended)

Create it at **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:

| Setting | Value |
|---|---|
| Resource owner | the account or organization that owns the repo |
| Repository access | only the client repo |
| Contents | Read and write (push `agent/*` branches) |
| Issues | Read and write (comments, labels) |
| Pull requests | Read and write (open, update, merge) |
| Workflows | Read and write, **only** if a task sets `allowWorkflowChanges: true` |
| Expiration | your policy; the doctor reports an expired token |

The token doesn't need the Checks permission: without it, a merge relies on GitHub's own view of required checks.

## Classic tokens

A classic token with the `repo` scope also works, and is the way around an organization that won't approve fine-grained tokens. It reaches every repo its owner can, so prefer a machine user's. The factory doesn't check which kind it was given.

## Whose token

- **A machine user** (recommended): a separate GitHub account with access to the repo. The factory's comments, labels and pull requests then appear as that account.
- **Your own token:** works, but everything the factory does appears as you, and can't be told apart from your own actions.

## Organization repos

An organization can require an owner's approval for fine-grained tokens that target it (Settings → Personal access tokens). Until approved, the token is pending and the doctor reports it can't read the repo. Any member can create a token, limited to their own access.

## Other secrets

The stub passes a fixed list of secrets by name (`secrets: inherit` passes nothing across owners): `FACTORY_TOKEN`, `FACTORY_CHECK_ENV`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` and `COPILOT_GITHUB_TOKEN`. Each one reaches only the step that needs it. See [Agents](Agents) and [Safety](Safety).
