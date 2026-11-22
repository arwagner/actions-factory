# Runner environment

The agent and your checks run in the agent job, on the runner `runsOn` names (default `ubuntu-latest`), in your repo's checkout.

## The setup action

If your repo has `.factory/setup/action.yml`, a composite action, the factory runs it before the agent and before the checks. It's the only way to add toolchain steps, and it can use any action:

```yaml
# .factory/setup/action.yml
name: setup
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v5
      with: { node-version: 24, cache: npm }
    - run: npm ci
      shell: bash
```

Services such as a database are started here too, or provided by the container. There's no `services:` field.

## Checks

`checks:` is a list of shell commands, run in order in the checkout after each agent round. They're how the factory knows the work is done:

```yaml
checks:
  - npm run lint
  - npm test
```

- With `checksGate: true` (the default), work whose checks fail isn't pushed, and the run parks.
- With `turns: N` (up to 5), a failing round gives the agent another go, with the failing output in its prompt.
- The prompt lists the checks, so the agent runs them itself before finishing.

## `FACTORY_CHECK_ENV`

Secrets your checks need, such as a test database URL, go in one secret, `FACTORY_CHECK_ENV`, in dotenv format:

```text
DATABASE_URL=postgres://test:test@localhost:5432/test
STRIPE_TEST_KEY=sk_test_…
```

Each value is masked in the logs, and given only to the check commands' own environment: never to the agent, never to `$GITHUB_ENV`. Kept check output is scrubbed of the values. Checks run code the agent wrote, so these must be **low-value** secrets: a test database, a sandbox key.

## Containers and self-hosted runners

- `container:` runs the agent job in an image (per task or top level), for toolchains that are easier to ship that way.
- `runsOn:` takes a runner label or a list of labels, so self-hosted and larger runners work. The runner needs Node 24 (the factory installs it with `actions/setup-node`) and network access to install the agent CLI and reach its API.

## Timeouts

- `timeout:` (minutes, default 60) is each agent round's limit. A round that hits it is stopped, with everything it started, and the run reports a timeout.
- The job's own limit is `timeout × turns + 30` minutes, within the 6-hour hosted-runner cap.
