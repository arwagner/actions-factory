# spec-flow

A spec-led pipeline on one issue, with a person signing off between stages. It stands alone (it doesn't extend `default`), which shows a template can replace the whole pipeline.

```yaml
schemaVersion: 1
template: spec-flow
```

| Stage | Label | Works on | Writes |
|---|---|---|---|
| discover | `agent:discover` | an issue | a discovery write-up: who has the problem, what happens today, constraints, unknowns |
| define | `agent:define` | the same issue | a problem brief: the one problem, scope, what success looks like |
| specify | `agent:specify` | the same issue | a spec: testable requirements with Given / When / Then acceptance criteria |
| plan | `agent:plan` | the same issue | an implementation plan: approach, changes, tests, steps, risks |
| implement | `agent:implement` | the same issue | a draft pull request that builds the plan, then `agent:review` on it |
| review | `agent:review` | that pull request | a verdict against the spec and the repo's standards, with fixes pushed; ready if nothing's left |

The first four stages change no code: each posts its write-up as a comment on the issue, adds `needs-signoff` and assigns the `assignee`. Later stages read the earlier write-ups, and any comments from people with write access, from the issue.

**To sign off,** read the write-up, comment with any corrections (a person's comment wins over the write-up), and add the next stage's label. To redo a stage, add its label again. You can start at any stage: an issue that already has a clear problem can begin at `agent:specify`. `needs-signoff` comes off when implement opens the pull request.

The review stage uses `default`'s review prompt and skills, told to hold the pull request to the issue's spec.

## Customizing

Every field can be changed in `factory.yml`. For example, skip discovery and run the plan stage on Codex:

```yaml
schemaVersion: 1
template: spec-flow
tasks:
  discover: null
  plan:
    agent: codex
```
