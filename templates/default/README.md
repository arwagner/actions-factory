# default

The template a repo gets when `factory.yml` names none: the full journey from issue to merged pull request. Every task starts when its label is added, so you choose how far each issue goes.

| Task | Label | Works on | Does |
|---|---|---|---|
| explore | `agent:explore` | every open issue with the label | Groups them, finds duplicates, verifies claims against the code, and gives each issue one outcome: `easy-call` (adds `agent:implement`), `needs-a-human`, `blocked`, or `duplicate` (closed onto the oldest). Read-only. |
| implement | `agent:implement` | an issue | Builds it on `agent/issue-<n>-<run>`, opens a draft pull request, and adds `agent:review` to it. |
| review | `agent:review` | a pull request | Reviews it against the ticket and the repo's standards, pushes fixes for anything a person needn't decide, posts a verdict, and marks it ready when nothing is left. |
| merge | `agent:merge` | a pull request | Merges the base in (never a rebase), fixes conflicts and failing checks in up to 3 rounds, then merges with a merge commit once GitHub's checks pass. |

Only a person adds `agent:merge`; the factory never does.

## Customizing

Every field can be changed in `factory.yml`. For example, run review on Codex and drop explore:

```yaml
schemaVersion: 1
tasks:
  review:
    agent: codex
  explore: null
```
