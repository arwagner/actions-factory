# Troubleshooting

Start with the **doctor** (Actions → factory → Run workflow → `doctor`). Its summary lists each check with a fix.

## The doctor's failures

| Check | Fix |
|---|---|
| Config | The summary names the layer and field. `show-config` shows every layer. Unknown keys are errors. |
| `FACTORY_TOKEN`: not set | Create the token and set the secret ([Getting started](Getting-started)). |
| Token: read the repo | The token's resource owner, repository access, or org approval. A 401 means expired or revoked. |
| Token: push branches / write issues / open pull requests | Give the token Contents / Issues / Pull requests: Read and write. |
| Labels | The token needs Issues: Read and write. |
| Stub version | Copy the current stub over yours. |
| Agent: credential | Set one of the secrets the summary names, for that agent. |
| Agent: test prompt | The credential is wrong, expired or out of quota. The summary quotes the CLI's error. |

## A label did nothing

- **No run at all:** was the label added with GitHub's built-in `GITHUB_TOKEN`, by another workflow? Labels added that way start no workflows. Use a personal token. Also check that the stub is on the **default branch**: label events only start workflows from there.
- **A skipped run:** labels that don't start with `agent:` are dropped by the stub, by design. So is `agent:blocked`.
- **"nothing to do":** no task in the merged config uses that label. Check `template:` and `show-config`.
- **The label stayed, with a "waiting" comment:** the repo hit `throttles.runsPerDay`. A later tick starts it.

## Common refusals

| Comment | Meaning |
|---|---|
| "only people with write access can start factory tasks" | The person who added the label has triage or read access. |
| "doesn't run on pull requests from forks" | By design: fork code never runs where your secrets are. |
| "works on pull requests, not issues" (or the reverse) | The label's task has the other `subject`. |
| "the config doesn't validate" | The comment lists each error, with its layer and field. |
| "has had 10 factory runs today, which looks like a loop" | The loop brake. Remove `agent:blocked` and add the label again to carry on. |
| "the agent has no credential" | Set the secret the comment names. |
| "the plan doesn't fit the task" | The agent asked for a write the task doesn't allow. The comment lists each. Usually a prompt or `writes` mismatch. |
| "the agent changed workflow files" | Set `allowWorkflowChanges: true` on the task if that's intended, and give the token Workflows: write. |

## Missing labels

The factory creates every label the config needs whenever it runs, so a brand-new repo's labels appear after its first run. Run the doctor (or `show-config`) to create them up front.

## A run parked with `agent:blocked`

The status comment says why. Fix the cause, then add the task's label again. For an implement-spec ticket, remove `agent:blocked` from the spec and add `agent:implement-spec`.

## A release broke something

Pin the last good version exactly in your stub (`@v1.2.2`) until a fix ships. See [Versioning](Versioning).
