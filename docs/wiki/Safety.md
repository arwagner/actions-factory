# Safety

The factory's rule is **the agent plans, the factory writes**. The agent never holds a GitHub token. It writes a plan; a separate job checks the plan against the task and makes the writes.

## Who can start a task

- Whoever added the trigger label must have **write** access or above. Triage users can add labels but not push code, so they don't count, and the factory says so on the item.
- **Fork pull requests are refused** with a comment, before any checkout. A PR counts as a fork when its head repo isn't the base repo, or is gone.

## Only people merge

- The factory never adds `agent:merge`, in any template, and no layer can make it. So every merge label came from a person.
- A merge still respects branch protection and required checks. A merge GitHub refuses parks the PR.
- `writes.merge` is allowed only on a task started by a label alone, never a scheduled one.

## Separate jobs, separate secrets

| Job | Holds | Runs |
|---|---|---|
| route | the built-in token (read) and `FACTORY_TOKEN` (labels, refusals) | the router only |
| agent | the agent's credential, in the agent step only; checks get only `FACTORY_CHECK_ENV` | setup action, `before` hook, agent, checks |
| apply | `FACTORY_TOKEN` | plan validation, every write, `after` hook. No agent. |

Checkouts don't keep credentials. The work moves from the agent job to the apply job as a git bundle. A pull request's own changes can't alter the config its runs use: the config is always read from the base branch.

## Prompt injection

Assume issue and PR text can try to steer the agent, so:

- The agent sees only comments from people with write access, and its prompt says plainly that issue and PR text is untrusted.
- The plan is validated against the task: labels only from `writes.labels`, at most one PR, issue creation up to its cap, one declared outcome.
- Pushes go only to `agent/*` branches, never with force, never to the default branch.
- **Workflow files:** a change touching `.github/workflows/` is refused unless the task sets `allowWorkflowChanges: true`. The recommended token leaves out the Workflows permission anyway.

## Public repos

- The agent needs network access to install packages, so a successful prompt injection could leak **the agent's own credential**. Use an API key with a spend limit, never a key shared with anything important.
- Transcripts aren't kept as artifacts on public repos.
- Anyone can open an issue, but only people with write access can start a task on it.

## What leaks, and what doesn't

Log masking catches plain and base64-encoded secret values, but not reversed or split ones; the factory scrubs known values from transcripts and check output. The real control is which steps hold which secrets, hence the job split above.
