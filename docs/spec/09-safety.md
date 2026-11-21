# 9. Safety

Decided in: Safety model (#14), cross-owner test (#18). See ADR 0004 and ADR 0006.

## Who can start a task

- The router checks that whoever added the trigger label has write access or above. Triage users can add labels but can't push code, so they don't count.
- **Fork PRs are refused** with a comment before any checkout. The stub never checks out fork code where secrets are available.

## Merge consent

- **Only people merge.** The factory never adds `agent:merge`, in any template, and no layer can override that.
- Every merge label therefore came from a person, whatever token the factory uses. That includes a person's own token, where the factory's labels can't be told apart from theirs by actor.
- A merge still respects branch protection. A merge GitHub refuses parks the PR.

## Separate jobs

| Job | Holds | Runs |
|---|---|---|
| route | GITHUB_TOKEN (read), `FACTORY_TOKEN` (labels, refusals) | router logic only |
| agent | only its agent credential, in the agent step. Check steps get only `FACTORY_CHECK_ENV`. | setup action, `before` hook, agent, checks |
| apply | `FACTORY_TOKEN` | plan validation, `after` hook, all writes. No agent. |

- The agent job hands the workspace (as a git bundle) and `plan.json` to the apply job as an artifact.
- Checkout uses `persist-credentials: false`.
- Each secret goes only into the step that needs it, never job-wide.

## Prompt injection

- Agents receive only comments from people with write access. Prompts say plainly that issue and PR text is untrusted.
- The plan is validated against the task. Its writes are capped: labels only from `writes.labels`, at most one PR, issue creation up to its cap.
- Pushes go only to `agent/*` branches, never with force, and never to the default branch.
- **Workflow files:** a plan that touches `.github/workflows/` is refused unless the task sets `allowWorkflowChanges: true`. The recommended token leaves out the Workflows permission.
- The agent's network access stays open, because installing packages needs it. The docs warn that a prompt injection could leak the agent's own credential, and recommend a spend-capped API key on public repos.

## Leakage

Observed in #18:
- Log masking catches plain and base64 values, but misses reversed or split ones.
- Outputs containing a secret are dropped from what reaches the caller.
- Artifacts hold raw values.
- This repo sees nothing of a client's runs.

The only real control is which steps hold which secrets, hence the job split.

- **Transcripts:** uploaded as artifacts kept for 7 days, with every known secret value scrubbed out. On public repos they aren't uploaded unless the client opts in.
- **Hooks from other repos:** they run in the apply job holding `FACTORY_TOKEN`. Trust them like any action you `uses:`, and pin them to a commit SHA.
