# 7. Orchestration

Decided in: Orchestration: queues, brakes and schedules (#19).

There is no server and no stored state. Everything comes from GitHub events, labels, and the API.

## The label is the queue

Every run takes its trigger label off when it starts. An open item that still carries a trigger label is therefore work that hasn't started: either it was held back by a limit, or its event was dropped. On each 15-minute tick, the router sweeps these items, oldest first, within the limits. Items carrying `agent:blocked` are skipped, and so are items with a factory run still queued or going.

The tick starts each run with a `repository_dispatch` of type `factory-run` (`{task, trigger, number?}`), sent with `FACTORY_TOKEN`, so every run gets its own title and per-subject queue. A swept item's run is routed as the label event it stands for: the person who added the label (from the issue's events) must have write access, and an item that was closed or lost the label meanwhile starts nothing.

## Limits

| Limit | How it works |
|---|---|
| One run per subject | A concurrency group per issue or PR, `queue: max`, so runs wait in order. |
| `throttles.concurrentRuns` | `unlimited` (default), or `1`: a repo-wide concurrency group. The account's Actions limit is the outer cap. |
| `throttles.runsPerDay` (default 50) | The router counts today's factory runs through the API. Over the limit, the item keeps its label, gets a comment, and is picked up by later ticks. |
| Loop brake | At most 10 factory runs per subject per day. Hitting it parks the item with `agent:blocked` and a comment. |

## Schedules

- The router evaluates each task's five-field cron in the repo's `timezone` (IANA, default UTC) on every tick.
- It finds the last tick it handled from the previous successful or still-running scheduled run, through the API. Each tick handles the slots between that run's creation and its own.
- After missed or dropped ticks, each task runs **once**, for the latest missed slot. Slots more than 31 days old are dropped.
- Scheduled runs count toward `runsPerDay`. A slot that comes due over the limit is skipped and shown in the tick's summary.
- `schedule.subject` is the number of the issue or PR the scheduled run is about. It's required for `issue` and `pr` tasks.
- A scheduled run's refusals and failures go on its `schedule.subject` if it has one, and otherwise to the run summary and `operatorIssue`, once a day per kind of refusal.

## implement-spec queue

A spec issue's tickets are its **sub-issues**, ordered by GitHub's native blocking links. Each run builds the next unblocked ticket, closes it, and adds the label to the spec issue again until none are left. Order lives in GitHub, not in issue bodies.

## Failures and retries

- No automatic retries.
- A failed run adds `agent:blocked` and a comment saying how to retry: add the trigger label again. For a parked spec ticket, remove `agent:blocked`.

## Assignee

With `assignee:` set, that login is assigned whatever waits on a person:
- an outcome with `waitsOnPerson`, such as `needs-a-human` or a PR the review found ready;
- anything parked with `agent:blocked`;
- a PR the factory opened that no factory review will read. That PR also requests the assignee's review.

A run that picks the item up again unassigns them. Only that one login is ever added or removed. GitHub ignores an assignee without access to the repo.
