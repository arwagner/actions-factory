# 3. Tasks

Decided in: The task model (#9), Safety model (#14), Orchestration (#19). See ADR 0004.

## What a task is

A task is declarative YAML, plus optional script hooks. Its parts:

- **Trigger:** a `label` (prefix `agent:`) on an issue or PR, a `schedule`, or both.
- **Subject:** `issue`, `pr`, `batch` (an issue `query`, as explore uses), or `repo` (scheduled sweeps).
- **Prompt and skills:** a prompt file, extra `instructions`, and a map of skills.
- **Agent and model:** defaulting to the repo's.
- **Permission profile:** `read-only` or `edit-workspace`.
- **Checks:** whether they gate the push (`checksGate`), and how many rounds of agent then checks are allowed (`turns`, default 1).
- **Allowed writes, with caps:** comments, labels (from an allowed list), a pull request (draft or not), push, close the issue, create issues (up to N), merge.
- **Outcomes:** named results. Each adds labels, removes labels, or marks that the item now waits on a person.
- **Hooks:** `before` and `after` scripts from the template's folder.
- **Plan schema:** optional extra plan fields that hooks consume, such as explore's `duplicate_of`.

The full field list is in section 5.

## The plan

The agent never holds a GitHub token. It works in a checkout and writes `plan.json`, containing:

- exactly one outcome from the task's list;
- the writes it asks for: comments, labels, a PR title and body, which issues to close;
- any extra fields declared by `planSchema`.

The writes a plan can ask for are `comment`, `labels` (`add`, `remove`), `pullRequest` (`title`, `body`), `closeIssue` (the subject issue only), `createIssues` and `merge`. Pushing isn't a plan field: the agent's changes to the checkout are the push, and the factory picks the branch.

For a `batch` subject, the plan instead has `items`, one per issue: `number`, `outcome`, and that issue's `comment`, `labels` and `close`, plus `planSchema` fields. Each item is validated like a single plan, and must name an issue from the batch, once (#37).

The factory validates the plan against the task. An outcome not on the list, or a write the task doesn't allow, fails the run. Then the factory makes the writes itself (section 9).

## Hooks

- `before` prepares inputs. For example, ratchet picks a file at random, and explore gathers the batch.
- `after` turns the plan into writes or the next step. For example, implement-spec queues tickets.
- Hooks run in the factory's jobs, never inside the agent. A `before` hook runs in the agent job before the agent, without the agent credential. An `after` hook runs in the apply job and holds `FACTORY_TOKEN`.
- **`before`** runs first, before the prompt is built, with the default token (read). It gets `FACTORY_TASK`, `FACTORY_SUBJECT` (the item's number, or the origin's) and `FACTORY_WORK_DIR`. Whatever it writes to `$FACTORY_WORK_DIR/context.md` goes into the prompt, under "Context from the template".
- **`after`** runs last, once every write is made. It gets `FACTORY_TASK`, `FACTORY_TASK_LABEL`, `FACTORY_OUTCOME`, `FACTORY_PLAN` (the plan as JSON), `FACTORY_SUBJECT`, `FACTORY_PULL_REQUEST` (if the run opened or reused one) and `FACTORY_CREATED_ISSUES` (the numbers of the issues it created, in plan order).

## Outcomes and chaining

An outcome's labels are how one task hands off to the next. For example, explore's `easy-call` adds `agent:implement`, and `needs-a-human` adds `needs-a-human`. The factory never adds `agent:merge` (section 9).

## What the factory guarantees around every run

- The trigger label comes off when the run starts, so adding it again retries.
- One status comment, with a hidden `<!-- factory:status -->` marker, posted or updated in place, linking to the run.
- On failure, the item gets `agent:blocked` and a comment saying how to retry.
- No automatic retries.
- Agents read only comments from people with write access, and never the factory's status comments.
- The factory runs the checks itself and never takes the agent's word that they passed.
