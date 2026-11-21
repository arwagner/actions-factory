# 5. Config reference

Decided in: The factory.yml schema in full (#23), with fields from every other ticket. This is the source of the JSON schema that the wiki's config reference is generated from (section 13).

Field names are camelCase. `factory.yml` lives at the client repo's root.

## `factory.yml`, top level (`schemaVersion: 1`)

| Field | Type | Default |
|---|---|---|
| `schemaVersion` | `1` | required |
| `template` | name, `./path`, or `owner/repo/path@ref` | `default` |
| `agent` | `claude`, `codex` or `copilot` | `claude` |
| `model` | string | the adapter's default |
| `timezone` | IANA name | `UTC` |
| `runsOn` | string or list | `ubuntu-latest` |
| `container` | image | none |
| `checks` | list of shell commands | `[]` |
| `instructions` | text or path, added to every task's prompt | none |
| `assignee` | GitHub login | none |
| `operatorIssue` | issue number | none |
| `throttles.runsPerDay` | integer | `50` |
| `throttles.concurrentRuns` | `1` or `unlimited` | `unlimited` |
| `labels` | map of name → `{color, description}` | from the template |
| `tasks` | map of name → task, or `null` to remove it | from the template |

## Per task

| Field | Type | Default |
|---|---|---|
| `label` | string starting with `agent:` | none (schedule-only task) |
| `subject` | `issue`, `pr`, `batch`, `repo` | required |
| `query` | issue search query (with `subject: batch`) | none |
| `schedule` | `{cron, subject?}`: five-field cron, in `timezone`; `subject` is the number of the issue or PR the run is about (required for `issue` and `pr` tasks), where its refusals and failures go | none |
| `prompt` | path | required |
| `instructions` | text or path | none |
| `skills` | map of name → path, or `null` | `{}` |
| `agent`, `model`, `runsOn`, `container` | as top level | top level |
| `timeout` | minutes for the agent step | `60` |
| `permission` | `read-only` or `edit-workspace` | `read-only` |
| `checksGate` | boolean: checks must pass before a push | `true` |
| `turns` | integer: rounds of agent then checks | `1` |
| `writes.comment` | boolean | `true` |
| `writes.labels` | list of labels the plan may add or remove | `[]` |
| `writes.pullRequest` | `false` or `{draft: boolean}` | `false` |
| `writes.push` | boolean (only to `agent/*` branches) | `false` |
| `writes.closeIssue` | boolean | `false` |
| `writes.createIssues` | integer cap | `0` |
| `writes.merge` | boolean | `false` |
| `outcomes` | map of name → `{addLabels, removeLabels, waitsOnPerson}` | required |
| `planSchema` | path to a JSON schema of extra plan fields | none |
| `hooks.before`, `hooks.after` | paths | none |
| `allowWorkflowChanges` | boolean | `false` |

## Hard rules (not configurable)

- `writes.merge` is valid only on a task whose trigger is a label that a person adds.
- No outcome or write may add `agent:merge`.
- Pushes go only to `agent/*` branches, never with force, never to the default branch.
- A label that triggers a task must start with `agent:`.

## `template.yml`

The same format as `factory.yml`, minus `schemaVersion` and `template`, plus:

| Field | Type |
|---|---|
| `name` | string |
| `description` | string |
| `schemaVersions` | list of the `schemaVersion`s it supports |
| `extends` | a template reference, as in `template:` |

## Schema evolution

`schemaVersion: 1` covers exactly these fields. Adding an optional field is a minor change. Renaming or removing one needs `schemaVersion: 2` and a new major version of the factory (section 11). An unknown `schemaVersion` is refused, with a comment naming the field.
