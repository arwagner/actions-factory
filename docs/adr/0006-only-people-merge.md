# 6. Only people merge, and agents don't touch workflow files by default

The factory never adds `agent:merge` itself, in any template, and no layer can override that. So every merge label came from a person, whatever token the factory uses. This also covers a person's own `FACTORY_TOKEN`, where the factory's labels can't be told apart from theirs by actor. A per-task `autoMerge` option would allow fully autonomous pipelines, but it would make merge consent depend on configuration that any layer can change. It can be added later if it's wanted.

For the same reason, the factory refuses any plan that changes `.github/workflows/` unless the task opts in with `allowWorkflowChanges: true`. A workflow an agent was tricked into adding would run with the repo's secrets as soon as its branch is pushed. The recommended token therefore leaves out the Workflows permission.
