# Glossary

**Factory**: The system that turns tickets in a client repo into reviewed, merged code by running agents. Here, it is delivered as reusable GitHub Actions published from this repo.

**Client repo**: A repository that uses the factory by referring to this repo and keeping a factory config. This repo is a client repo of itself.

**Stub**: The one workflow file a client repo copies in to use the factory. It does no work itself: it passes each event to the factory, at the version it names. _Avoid_: caller workflow, wrapper.

**Ticket**: A GitHub issue in a client repo that the factory works on.

**Task**: One kind of factory work started on a ticket or PR (for example explore, implement, review, merge). It is triggered by a label or a schedule. _Avoid_: stage, job, workflow (those mean other things on GitHub).

**Agent**: The coding CLI that does a task's thinking and editing (for example Claude Code or Codex). Which one runs can be swapped.

**Factory config**: The `factory.yml` file in a client repo. It names a template and adds the client's own changes as the last layer on top of it.

**Template**: A named folder of tasks, labels, prompts, skills, hooks and defaults that defines how the factory works. A template can extend one other template. It can come from this repo, from the client repo, or from another repo.

**Layer**: One template, or the factory config, in the stack that builds a client's final setup. Each layer changes the one beneath it, using the same merge rules at every level.

**Default template**: The template used when the factory config names none. It is the simple set.

**Subject**: What one run of a task is about: a single ticket, a single pull request, a batch of tickets, or the repo as a whole.

**Outcome**: One of the named results a task declares, such as `easy-call` or `needs-a-human`. The agent picks exactly one, and the outcome decides which labels come next.

**Hook**: A script a template ships alongside a task, run by the factory before or after the agent, never by the agent itself. It prepares the agent's inputs or turns its plan into writes.

**Plan**: The structured result an agent hands back: its outcome, plus the writes it asks for. The factory checks the plan against the task and makes the writes itself. _Avoid_: output, response.
