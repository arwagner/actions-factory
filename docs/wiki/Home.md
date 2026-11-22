# actions-factory

A software factory for any GitHub repository, run entirely by GitHub Actions. You add a label to an issue or pull request; a coding agent does the task the label names; the factory makes the writes (a branch, a pull request, comments, labels) and reports back on the item.

```text
you add agent:implement to issue #42
  → the factory's agent builds it, and the repo's checks run
  → the factory pushes agent/issue-42-…, opens a draft PR, and adds agent:review to it
  → the review task reviews the PR, pushes fixes, posts a verdict, and marks it ready
you read it, and add agent:merge
  → the merge task merges it once GitHub's checks pass
```

- **One file to install.** A small workflow, the stub, calls this repo's router. There is no server, app or database.
- **Labels are the interface.** Every task starts when its label is added, so you choose how far each issue goes. Only people add `agent:merge`.
- **Templates.** The tasks come from a template: `default` (explore, implement, review, merge), `full`, `review-only`, `spec-flow`, or your own. `factory.yml` customizes any of it.
- **Your agent.** Claude Code (default), Codex or Copilot CLI, with your own credentials.
- **Safe by construction.** The agent never holds a GitHub token. It writes a plan, and the factory checks the plan and makes the writes.

**Start here:** [Getting started](Getting-started). Then [How it works](How-it-works) and [Templates](Templates).
