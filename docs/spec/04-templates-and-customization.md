# 4. Templates and customization

Decided in: The template model (#10), Customization model (#11), Templates to ship (#13). See ADR 0005.

## Layers

A template is a folder containing:

- a manifest, `template.yml`: name, description, the `schemaVersions` it supports, and an optional `extends`;
- its tasks;
- its labels (name, colour, description);
- prompts, skills and hooks;
- defaults such as agent and checks.

A template may `extends:` one other template. The client's `factory.yml` is simply the last layer on top of the template it names. The same merge rule applies at every layer, so customizing the factory and writing a small template are the same thing.

## Where templates come from

| `template:` value | Source |
|---|---|
| omitted | `default`, from this repo |
| `spec-flow` | a template shipped in this repo, at the stub's pinned version |
| `./factory/my-template` | a folder in the client repo |
| `some-org/templates/flow@v2` | another repo, pinned like any action |

Hooks in a template from another repo run with `FACTORY_TOKEN`. The docs say to trust such a template like any action you `uses:`, and to pin it to a commit SHA.

## The merge rule

Maps merge by key. Scalars and lists replace. `null` removes a key.

- `tasks.review.agent: codex` changes one field.
- `checks: [...]` replaces the whole list.
- `tasks.ratchet: null` removes the task.
- `skills` is a map keyed by skill name, so a layer can add one skill or remove one with `null`.
- `prompt:` replaces the prompt file. `instructions:` adds text or a file after it, and can appear at the top level (all tasks) or per task, in any layer.

## What can be overridden

Every field, in every layer. No template can lock a field. The factory, not the config, enforces the guarantees around every run (section 3) and the safety rules (section 9).

## Paths, validation, inspection

- **Paths:** paths in a template are relative to its own folder. Paths in `factory.yml` are relative to the client repo's root. The client's own files go in `.factory/` by convention.
- **Validation:** of the final merged config, not each layer. Unknown keys are errors. Errors name the layer and the field. They're posted on the subject, or in the run summary when there's no subject.
- **Inspection:** every run's summary shows the final merged config, collapsed. A `show-config` dispatch prints it on demand.

## Labels and switching

- The factory creates or updates whatever labels the merged config needs whenever it runs. Clients never create labels by hand.
- Switching templates is just a config change. Tickets with labels the new template doesn't know are ignored.

## Shipped templates

The prompt text is left to the build. The default template's prompts and skills start as copies of aint-farm's.

- **`default`:** explore, implement, review, merge. The full journey from issue to merged PR, every task opt-in by label. `agent:merge` is added only by a person.
  - **explore** (`agent:explore`, subject: batch of open issues with the label): groups the issues, finds duplicates, and gives each issue one outcome: `easy-call` → `agent:implement`; `needs-a-human` → `needs-a-human`, waits on a person; `blocked` → `blocked`, waits on a person; `duplicate` → the issue is closed onto the oldest. Read-only.
  - **implement** (`agent:implement`, issue): builds on `agent/issue-<n>-<run>`, opens a draft PR, and adds `agent:review`.
  - **review** (`agent:review`, PR): reviews against the ticket and the repo's standards, pushes fixes, posts a verdict, and marks the PR ready. It waits on a person.
  - **merge** (`agent:merge`, PR; only a person adds the label): merges the base into the branch with a merge commit (never a rebase or force-push), and fixes conflicts and failing checks in up to 3 turns. Once GitHub's checks pass on the head, it merges with a merge commit. If anything stops it, it parks the PR with `agent:blocked`.
- **`full`:** extends `default`, adding:
  - **implement-spec** (`agent:implement-spec`, spec issue): splits the spec into sub-issues ordered by blocking links, then builds the next unblocked one per run until none are left;
  - **ratchet** (`agent:ratchet`, scheduled, about an issue tracking a migration): removes one random entry from a stricter check's exception list, fixes it, and opens a PR only if the check passes.
- **`review-only`:** extends `default` and keeps only review. The easiest first step for a team.
- **`spec-flow`:** stands alone. A spec-led pipeline (discover → define → specify → plan → implement → review) with people signing off between stages. It proves a template can replace the whole pipeline.

Other templates (docs-only, dependency updates and so on) can come later as minor releases.
