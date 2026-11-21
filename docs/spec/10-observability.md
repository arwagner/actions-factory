# 10. Observability

Decided in: Observability (#21).

## Per run

- **Job summary:**
  - the subject (linked), task, template and factory version, agent and model;
  - the outcome and every write made;
  - check results and duration;
  - tokens and cost where the CLI reports them;
  - the final merged config, collapsed;
  - a link to the transcript artifact.
- **Run name:** `factory · <label> · #<n>`, set by the stub, so the Actions list reads at a glance.
- **Status comment:** one per run on the subject, updated in place, with a link to the run and the outcome in one line. On failure, it gives the reason and how to retry.
- **Transcript:** see section 9.

## Refusals and failures with no subject

Examples are bad config on a scheduled tick and a missing secret. They're shown in the run summary, and posted to `operatorIssue:` when it's set.

## Totals

The factory builds no report of its own:
- Runs, failures, minutes and queue times come from GitHub's Actions metrics (Insights → Actions) and the run list at `/<repo>/actions`.
- Agent token cost comes from the vendor's dashboard, per API key.

The wiki's Observability page says where to look.

## Notifications

Only through GitHub itself: comments, assignment and review requests reach people's GitHub inboxes. No Slack or email integration in v1.
