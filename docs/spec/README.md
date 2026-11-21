# actions-factory spec

actions-factory is a software factory delivered as reusable GitHub Actions. A client repo copies in one stub workflow and adds a `factory.yml`. From then on, labels on its issues and PRs start agent tasks: explore, implement, review, merge, and whatever else its template defines. The tasks turn tickets into reviewed, merged code. There is no GitHub App and no server (ADR 0001).

This spec is the complete design for version 1. Terms are defined in [GLOSSARY.md](../../GLOSSARY.md), and the hard-to-reverse decisions are in [docs/adr](../adr). The decision tickets behind each section are linked from the [map](https://github.com/arwagner/actions-factory/issues/1).

| Section | Covers |
|---|---|
| [1. Architecture](01-architecture.md) | stub, router, task runner, jobs, how the factory reads its own files |
| [2. Identity and secrets](02-identity-and-secrets.md) | `FACTORY_TOKEN`, label chaining, the named secrets |
| [3. Tasks](03-tasks.md) | the task model, plans, outcomes, hooks, guarantees around every run |
| [4. Templates and customization](04-templates-and-customization.md) | layers, merge rules, where templates live, shipped templates |
| [5. Config reference](05-config-reference.md) | every field of `factory.yml` and `template.yml` |
| [6. Agents](06-agents.md) | the adapter contract, Claude, Codex, Copilot |
| [7. Orchestration](07-orchestration.md) | queueing, limits, schedules, failures, assignee |
| [8. Runner environment](08-runner-environment.md) | setup action, checks, containers, time limits |
| [9. Safety](09-safety.md) | who may trigger, merge consent, job separation, injection, leakage |
| [10. Observability](10-observability.md) | summaries, status comments, transcripts, metrics |
| [11. Versioning, release and dog-fooding](11-versioning-and-release.md) | pinning, semver, the release workflow, the sandbox |
| [12. Onboarding](12-onboarding.md) | Getting started, the doctor |
| [13. Wiki](13-wiki.md) | source, publishing, page outline |
| [14. Build handoff](14-build-handoff.md) | the build map's seed tickets and early spikes |

## Requirements at a glance

- A client repo needs exactly one workflow file (the stub), one config file (`factory.yml`), `FACTORY_TOKEN`, and one agent credential.
- With no `template:`, the client gets the default template: explore, implement, review and merge.
- Naming a template can replace the whole pipeline. `factory.yml` can override any part of the chosen template.
- The agent can be swapped per repo and per task: Claude Code (default), Codex or Copilot CLI.
- The client's secrets never leave the client repo, and this repo sees nothing of a client's runs.
- This repo is a client of itself and always runs the newest release.
- Nothing public is named after aint-farm, which continues separately as a personal hub.
