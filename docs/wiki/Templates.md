# Templates

A template is a folder that defines the tasks: their labels, prompts, skills, hooks, outcomes and the writes each may make, plus defaults such as the agent and checks. Your `factory.yml` names one with `template:`, and is the last layer on top of it.

| Template | For |
|---|---|
| [default](Template-default) | The full journey from issue to merged PR: explore, implement, review, merge. Used when `factory.yml` names none. |
| [full](Template-full) | `default`, plus implement-spec (a spec built ticket by ticket) and ratchet (a migration, one step at a time). |
| [review-only](Template-review-only) | Only review, of anyone's pull requests. The easiest first step. |
| [spec-flow](Template-spec-flow) | A spec-led pipeline (discover → define → specify → plan → implement → review), with a person signing off between stages. |

## Layers and `extends`

A template may `extends:` one other template. `full` extends `default`; `review-only` extends `default` and removes three tasks. `factory.yml` is simply the last layer, and the same merge rule applies at every layer (see [Customizing](Customizing)). So customizing the factory and writing a small template are the same thing.

## Choosing one

Start with `default`, or `review-only` if you'd rather the factory only reviewed at first. Switching later is a one-line change to `template:`. Items with labels the new template doesn't know are ignored, and the factory creates the labels the new one needs on its next run.

## Writing your own

A template is a folder with a `template.yml` manifest:

```yaml
name: my-flow
description: What it's for, in one sentence.
schemaVersions: [1]
extends: default          # optional
tasks:
  triage:
    label: agent:triage
    subject: issue
    prompt: tasks/triage/prompt.md
    permission: read-only
    writes: { comment: true, labels: [bug, feature] }
    outcomes:
      sorted: {}
```

Paths in a template are relative to its own folder. Every task field is in the [Config reference](Config-reference). `hooks` run scripts from the folder in the factory's own jobs, never inside the agent (see [Customizing](Customizing)).

## Where templates come from

| `template:` value | Source |
|---|---|
| omitted | `default`, from this repo |
| `full`, `review-only`, `spec-flow` | shipped in this repo, at the version your stub pins |
| `./.factory/my-template` | a folder in your repo |
| `some-org/templates/flow@v2` | another repo, pinned like an action |

Hooks in a template from another repo run with your `FACTORY_TOKEN`. Trust such a template as you would any action you `uses:`, and pin it to a commit SHA.
