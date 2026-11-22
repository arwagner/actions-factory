# Observability

## On the item: the status comment

Each run keeps one comment on its issue or PR, updated in place: the task and its outcome in one line, and a link to the run. On failure it says why, and how to retry.

## In the run: the summary

Each run's summary (the run page, under the job list) shows:

- **From the route job:** the subject (linked), the task and who started it, the template layers, the factory version and commit, the agent and its CLI version and model, and the final merged config, collapsed.
- **From the apply job:** the outcome, or why the run stopped. Then every write it made, in order, and the agent's rounds and time. Then each check with its result and duration, tokens and cost (where the CLI reports them), and where the transcript is.

The **run name** reads `factory · <label> · #<n>`, so the Actions list reads at a glance.

## Transcripts

The agent's full transcript is kept for 7 days as the run's `factory-handoff` artifact (`transcript.ndjson`), with every known secret value scrubbed out. Public repos keep none.

## Problems with no item: `operatorIssue`

Some problems have no issue or PR to comment on: bad config on a scheduled tick, a missing secret, a scheduled task with no `schedule.subject`. They're shown in the run summary, and posted on the issue `operatorIssue:` names, at most once a day for each kind:

```yaml
operatorIssue: 1
```

## Totals

The factory builds no report of its own:

- **Runs, failures, minutes and queue times:** GitHub's Actions metrics (the repo's **Insights → Actions**, or the organization's) and the run list at `/<repo>/actions`. Filter the run list by the run names above.
- **Agent cost:** the vendor's dashboard, per API key (Anthropic Console, OpenAI platform, Copilot usage).

## Notifications

Only through GitHub: comments, assignment (see `assignee`) and review requests reach people's GitHub inboxes. There's no Slack or email integration.
