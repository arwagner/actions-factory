# Are secrets masked in job summaries?

Ticket: #27. Researched 2026-11-21 against GitHub docs and the actions/runner source (`main` at `7e211dc`, 2026-11-19). Claims are cited inline.

## Question

When a registered secret (`secrets.*`) or an `::add-mask::` value is written to `$GITHUB_STEP_SUMMARY`, is it masked in the rendered job summary? Does the factory need to scrub summaries itself?

## Answer

**Yes.** The runner runs every line of the step summary file through the same secret masker used for logs, and uploads only the scrubbed copy. Primary sources settle it; no live test needed for the basic case. The masker's limits are the same as for logs: transformed or split values get through.

## Evidence

- **Docs say so.** "Summaries automatically mask any secrets that might have been added accidentally. If a job summary contains sensitive information that must be deleted, you can delete the entire workflow run to remove all its job summaries." [Workflow commands: Adding a job summary](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary) ([source](https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/workflow-commands.md))
- **Runner source.** `CreateStepSummaryCommand.ProcessCommand` reads the summary file line by line, calls `HostContext.SecretMasker.MaskSecrets(line)`, writes a `-scrubbed` copy, and queues *that* copy for both uploads (Checks attachment and Results service). [FileCommandManager.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Runner.Worker/FileCommandManager.cs#L221-L291)
- **Tested.** `CreateStepSummaryCommand_ScrubSecrets` asserts a registered value does not appear in the scrubbed file. [CreateStepSummaryCommandL0.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Test/L0/Worker/CreateStepSummaryCommandL0.cs#L140-L165)
- **Present since the feature shipped:** step summaries were added in [actions/runner#1642](https://github.com/actions/runner/pull/1642) (Feb 2022) with scrubbing. Any current runner, hosted or self-hosted, has it.
- **Same masker as logs.** `secrets.*` values arrive as secret job variables and are registered whole and per line ([Worker.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Runner.Worker/Worker.cs#L155-L205)); `::add-mask::` registers whole and per line too ([ActionCommandManager.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Runner.Worker/ActionCommandManager.cs#L430-L450)). Encoders added to the masker (base64 variants, JSON/XML/URI/expression/command-line escapes, trimmed quotes) apply to summaries as well ([HostContext.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Runner.Common/HostContext.cs#L103-L112)).

## Edges and limits (from the source)

- **Timing.** Scrubbing runs in a `finally` after the step finishes ([ActionRunner.cs](https://github.com/actions/runner/blob/7e211dc69c347b78fc398e630e74facb11a13235/src/Runner.Worker/ActionRunner.cs#L276-L283)). So an `::add-mask::` issued anywhere in the same step, or earlier, covers that step's summary. A mask registered in a *later* step does not reach summaries already uploaded.
- **Line by line.** A value split across lines, or broken up by Markdown (`sec**ret**`), is not matched. Same for reversed values, or encodings the masker doesn't know, such as HTML entities (`&#115;ecret`), which the rendered Markdown would then decode. This matches what #18 saw in logs.
- **Raw file stays on the runner.** The unscrubbed file stays in the runner's file-commands directory for the rest of the job. Only later steps in the same job could read it, and those already have the secrets.
- **Size.** Over 1 MiB per step, the upload is skipped with an error annotation; the step's status is unaffected ([docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#step-isolation-and-limits), FileCommandManager.cs L247-L253).
- **Not found:** no changelog entry or runner issue reports summary masking failing. The 2022 launch post ([github.blog](https://github.blog/2022-05-09-supercharging-github-actions-with-job-summaries/)) doesn't mention masking.

## Implication for the spec

- The factory does **not** need to scrub summaries for registered secrets. It gets the same protection logs get.
- What's left is the same risk as logs: agent-written text that holds a secret in a transformed form. The defence stays the same: keep secrets out of the step that writes agent-derived content (§9 job split). Don't run a separate summary scrubber.
- Any value the factory derives at runtime (e.g. a minted token) must be `::add-mask::`ed before, or in the same step as, the summary write.
