# Customizing

Everything is customized in `factory.yml`, and every field can be changed: no template can lock one. The factory itself, not the config, enforces the guarantees around each run and the [Safety](Safety) rules.

## The merge rule

`factory.yml` is a layer on top of its template (and the template on top of anything it `extends`). Layers merge like this:

- **Maps merge by key.** `tasks.review.agent: codex` changes one field of one task.
- **Scalars and lists replace.** `checks: [...]` replaces the whole list.
- **`null` removes a key.** `tasks.explore: null` removes the task.

```yaml
schemaVersion: 1
checks: [npm ci, npm run lint, npm test]
tasks:
  review:
    agent: codex           # one field of one task
  explore: null            # remove a task
```

## `instructions` and `prompt`

- `instructions:` **adds** text, or a file's contents, after the prompt. At the top level it applies to every task; inside a task, to that task. Every layer's instructions are kept, in order.
- `prompt:` **replaces** a task's prompt file.

Prefer `instructions` for house rules ("we use pnpm", "never touch `legacy/`"): you keep the template's prompt as it improves.

```yaml
instructions: Use pnpm, never npm. Our domain terms are in GLOSSARY.md.
tasks:
  implement:
    instructions: .factory/implement-notes.md
```

## Tasks and skills

- **Add a task:** define it under `tasks:`, with at least a label or a schedule, a subject, a prompt and outcomes. Paths in `factory.yml` are relative to the repo root; put your files in `.factory/` by convention.
- **Remove a task:** `tasks.<name>: null`.
- **Skills** are a map of name to folder, so a layer can add one or remove one with `null`:

```yaml
tasks:
  review:
    skills:
      our-standards: .factory/skills/our-standards
      clarify: null
```

## Agent and model, per task

`agent:` and `model:` work at the top level and per task:

```yaml
agent: claude
tasks:
  explore:
    model: claude-haiku-5-5
  review:
    agent: codex
```

See [Agents](Agents) for the credentials each needs.

## Hooks

A task's `before` and `after` hooks are scripts the factory runs in its own jobs, never inside the agent.

- **`before`** runs in the agent job, before the prompt is built, with read access. It gets `FACTORY_TASK`, `FACTORY_SUBJECT` (the item's number) and `FACTORY_WORK_DIR`. Whatever it writes to `$FACTORY_WORK_DIR/context.md` goes into the prompt.
- **`after`** runs in the apply job once every write is made, with `FACTORY_TOKEN` (as `GH_TOKEN`, for `gh`). It gets `FACTORY_TASK`, `FACTORY_TASK_LABEL`, `FACTORY_OUTCOME`, `FACTORY_PLAN` (the plan as JSON), `FACTORY_SUBJECT`, `FACTORY_PULL_REQUEST` and `FACTORY_CREATED_ISSUES`.

A task's `planSchema` (a JSON schema file) adds fields the agent may put in its plan, for its hooks to read.

## See the result: `show-config`

In **Actions → factory → Run workflow**, choose `show-config`. The run summary shows the final merged config, with the layer each value came from. Every task run's summary shows it too, collapsed. Errors name the layer and the field.
