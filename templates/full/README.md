# full

Everything in [`default`](../default/README.md), plus two tasks for longer work.

```yaml
schemaVersion: 1
template: full
```

| Task | Label | Works on | Does |
|---|---|---|---|
| implement-spec | `agent:implement-spec` | a spec issue | Splits the spec into tickets (sub-issues, ordered by blocking links), then builds the next unblocked ticket per run, all on one branch and one draft pull request, until none are left. Then it hands the pull request to review. |
| ratchet | `agent:ratchet` | an issue tracking a migration | Picks one random entry from the migration's exception list, fixes it, and opens a pull request only if the stricter check passes. |

## implement-spec

Write the spec as an issue and add `agent:implement-spec`. Each run then does one of three things:

1. **No tickets yet:** splits the spec into tickets. They become its sub-issues, and the order between them becomes blocking links, so GitHub shows the queue.
2. **Tickets left:** builds the first open ticket in sub-issue order that nothing open blocks. It works on `agent/issue-<spec>`, which every run continues, and closes the ticket.
3. **All closed:** hands the spec's pull request to review (`agent:review`).

After the split and after each ticket, the factory adds the label to the spec again, which starts the next run. To change the plan, edit, reorder or add sub-issues between runs. To pause, park the spec with `agent:blocked`, and remove it to carry on. The loop brake allows 10 runs per spec per day.

## ratchet

The tracking issue names the exception list and the stricter check, each on a line of its own:

```text
ratchet-exceptions: config/strict-null-exceptions.txt
ratchet-check: npx tsc --noEmit --strict -p tsconfig.strict.json
```

The list has one entry per line; blank lines and `#` comments are ignored. `{entry}` in the check is replaced with the picked entry.

Run it by hand with `agent:ratchet`, or on a schedule. The template can't know the tracking issue's number, so the schedule goes in `factory.yml`:

```yaml
tasks:
  ratchet:
    schedule: { cron: "0 6 * * 1-5", subject: 123 }
```

## Customizing

As with `default`, every field can be changed in `factory.yml`, and `tasks.ratchet: null` removes a task.
