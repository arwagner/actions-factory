# 13. Wiki

Decided in: Wiki source and sync (#16), Spec assembly (#24).

## Source and publishing

- The source of truth is `docs/wiki/` in this repo. Docs change in the same PR as the code.
- The release workflow publishes it to the repo's GitHub wiki, pushing with this repo's own `FACTORY_TOKEN`. So the wiki always describes the newest release, which is what `@latest` runs.
- The wiki is never edited by hand. Every page carries a banner: "generated from `docs/wiki/` at vX.Y.Z — edit there". A hand edit is overwritten on the next release.
- The wiki's first page is created by hand once, because GitHub requires it. The wiki repo's branch is `master`.
- `scripts/wiki.ts` builds it: the hand-written pages, a page per shipped template from its README (`Template-<name>`), the config reference from the JSON schema, and the sidebar. Tests check every outline page exists, every internal link resolves, every schema field is documented, and Getting started shows the stub exactly as shipped.
- Docs for older versions are read in the repo at that version's tag. The Versioning page says how.

## Page outline

Pages marked *generated* are built from source at publish time. All others are hand-written in `docs/wiki/`.

1. **Home:** what the factory is, the 30-second picture (label → task → PR), links to Getting started and Templates.
2. **Getting started:** the five steps from section 12, a minimal `factory.yml`, the doctor.
3. **Identity and tokens:** why a personal access token, how to create a fine-grained one (exact permissions), classic as the fallback, machine users, org approval.
4. **How it works:** stub → router → agent job → apply job; labels as the interface; status comments; `agent:blocked` and retrying.
5. **Templates:** what a template is, layers and `extends`, choosing one, writing your own, templates from other repos.
   - **Template: default** *(generated from its README)*
   - **Template: full** *(generated)*
   - **Template: review-only** *(generated)*
   - **Template: spec-flow** *(generated)*
6. **Customizing:** the merge rule, `instructions` vs `prompt`, adding and removing tasks and skills, per-task agent and model, `show-config`.
7. **Config reference** *(generated from the JSON schema)*: every field of `factory.yml` and `template.yml`, with type, default and description.
8. **Agents:** Claude, Codex and Copilot, their credentials, terms-of-use notes, choosing per task.
9. **Runner environment:** the setup action, checks and `FACTORY_CHECK_ENV`, containers, self-hosted runners, timeouts.
10. **Schedules and limits:** cron and `timezone`, the sweep, `runsPerDay`, `concurrentRuns`, loop brakes, the implement-spec queue.
11. **Safety:** who can trigger, only people merge, fork PRs, workflow-file changes, secrets per step, prompt injection, public-repo advice.
12. **Observability:** run summaries, status comments, transcripts, where to see totals (Actions metrics, vendor dashboards), `operatorIssue`.
13. **Versioning:** `@v1`, `@latest`, exact pins; what counts as breaking; upgrading the stub; reading old docs.
14. **Troubleshooting:** the doctor's failures and fixes, common refusals, missing labels, runs that never started (the GITHUB_TOKEN rule), rolling back.
