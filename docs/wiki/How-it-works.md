# How it works

```text
label added ─→ stub (your repo) ─→ router.yml@v1 (this repo)
                                      route job:  load factory.yml + template, decide, take the label off
                                      agent job:  setup, before hook, agent rounds and checks → plan + work
                                      apply job:  check the plan, push, PR, comments, labels, after hook, status
```

## The stub

One fixed workflow in your repo, `.github/workflows/factory.yml`. It wakes on labels starting with `agent:` (a job-level filter drops other labels before a runner starts), on the `doctor` and `show-config` commands, on the 15-minute schedule tick, and on `repository_dispatch` (which the tick uses to start runs). It calls this repo's router at the version it pins, and passes the secrets by name.

## The route job

Loads `factory.yml` and its template stack, validates the merged config, and decides what this event means: run one task, a command, the tick, or nothing. It refuses, with a comment, when:

- the label came from someone without write access;
- the pull request is from a fork;
- `FACTORY_TOKEN` isn't set, the stub is from an older major, or the config doesn't validate;
- the label's task works on the other kind of item;
- the repo is over its limits (see [Schedules and limits](Schedules-and-limits)).

A run takes its trigger label off when it starts, so a label on an open item always means work that hasn't started.

## The agent job

Holds no GitHub token. It checks out the work (a pull request's head for PR tasks, with the config always read from the base), runs your setup action, then the task's `before` hook, then the agent. The agent gets a prompt (the template's, plus every layer's `instructions`, the item, and comments from people with write access) and writes a **plan**: a JSON file saying which outcome it chose and which writes it wants. Then the repo's checks run. If they fail and the task allows more `turns`, the agent gets another round with the failing output.

## The apply job

Holds `FACTORY_TOKEN`, and runs no agent. It checks the plan against the task (only the writes the task allows, within their caps), then makes every write itself: pushes the work to an `agent/*` branch, opens or reuses the pull request, comments, applies the outcome's labels, creates issues, merges. Then it runs the `after` hook.

## Labels are the interface

- A task's **label** starts it.
- An **outcome** adds and removes labels, which is how one task hands off to the next. For example, explore's `easy-call` adds `agent:implement`.
- **`agent:merge`** is added only by a person. No outcome, write or template can add it.
- **`agent:blocked`** parks an item.

## Status comments

Each run keeps one status comment on its item, updated in place: `✅ implement: done`, or `⛔ implement stopped: <reason>. To retry, add agent:implement again.` It links to the run, whose summary shows the details (see [Observability](Observability)).

## Failures and retrying

Nothing is retried automatically. A run that fails or is refused by the apply job adds `agent:blocked`, assigns the `assignee`, and says why. To retry, fix the cause and add the task's label again. For a parked implement-spec ticket, remove `agent:blocked`.
