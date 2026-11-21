# 8. Runner environment

Decided in: Runner environment (#20), schema (#23).

## Setup

- If the client repo has `.factory/setup/action.yml` (a composite action), the factory runs it before the agent and before the checks. It can use any action: `actions/setup-node`, `actions/cache`, apt installs, starting a database. This is the only way a client adds toolchain steps.
- `container:` (an image, per repo or per task) is an extra option for clients who already have one.
- Services such as databases are started in the setup action or provided by the container. There's no `services:` field.

## Checks

- `checks:` is a list of shell commands, run in order in the client's checkout after setup.
- They run in the agent job, after the agent, so turn-taking tasks (merge: up to 3 rounds of agent then checks) work in one job.
- The check steps get `FACTORY_CHECK_ENV` (dotenv) and nothing else. Those values must be low-value, such as a test database URL, because checks run code the agent wrote.

## Runner selection

- `runsOn:` per repo or per task, default `ubuntu-latest`. Self-hosted labels work the same way.
- The router passes `runsOn` and `container` to the agent job as outputs, read with `fromJSON`.
- The route and apply jobs always run on `ubuntu-latest`, so a broken client setup can still be reported.

## Time limits

- The agent step's `timeout:` per task defaults to 60 minutes.
- The agent job's limit is that plus a margin for setup and checks, capped at 6 h on hosted runners.

## Caching

Agent CLI installs are cached by their pinned version. Clients cache their own toolchain inside the setup action.
