# Schedules and limits

There is no server and no stored state: everything comes from GitHub events, labels and the API.

## The label is the queue

Every run takes its trigger label off when it starts. So an open item that still carries a trigger label is work that hasn't started: it was held back by a limit, or its event was dropped.

## The tick

The stub wakes every 15 minutes. Each tick:

1. **Starts scheduled tasks.** Each task's `schedule.cron` (five fields) is read in the repo's `timezone` (IANA, default UTC). After missed or dropped ticks, a task runs **once**, for the latest missed slot. Slots more than 31 days old are dropped.
2. **Sweeps waiting items:** open items that still carry a trigger label, oldest first. It skips items carrying `agent:blocked` and items with a factory run already queued or going. A swept item is checked as if its label had just been added: the person who added it must have write access.
3. **Warms the agent CLI cache**, so label-started runs restore it instead of installing.

Each run the tick starts is a `repository_dispatch` of type `factory-run`, so it gets its own run, title and queue.

```yaml
timezone: Europe/London
tasks:
  ratchet:
    schedule: { cron: "0 6 * * 1-5", subject: 123 }   # 06:00 London, weekdays, about issue #123
```

`schedule.subject` is the issue or PR a scheduled run is about, required for `issue` and `pr` tasks. A scheduled run's refusals go on it; without one, to `operatorIssue`.

## Limits

| Limit | How it works |
|---|---|
| One run per item | Runs on the same item wait in order, never at once. |
| `throttles.concurrentRuns` | `unlimited` (default), or `1`: one agent job at a time across the repo. Your account's Actions limit is the outer cap. |
| `throttles.runsPerDay` | Default 50, counted from today's runs (in `timezone`). Over it, an item keeps its label, gets one comment that day, and later ticks start it. Scheduled runs count too. |
| Loop brake | At most 10 runs per item per day. Hitting it parks the item with `agent:blocked` and a comment. It isn't configurable. |

## The implement-spec queue

In the `full` template, a spec issue's tickets are its **sub-issues**, ordered by GitHub's native **blocking** links. Each run builds the first open ticket nothing open blocks, closes it, and adds `agent:implement-spec` to the spec again until none are left. The order lives in GitHub, so you change the plan by editing, reordering or linking sub-issues between runs. See [Template: full](Template-full).
