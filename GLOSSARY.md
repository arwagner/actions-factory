# Glossary

**Factory**: The system that turns tickets in a client repo into reviewed, merged code by running agents. Here, it is delivered as reusable GitHub Actions published from this repo.

**Client repo**: A repository that uses the factory by referring to this repo and keeping a factory config. This repo is a client repo of itself.

**Stub**: The one workflow file a client repo copies in to use the factory. It does no work itself: it passes each event to the factory, at the version it names. _Avoid_: caller workflow, wrapper.

**Ticket**: A GitHub issue in a client repo that the factory works on.

**Task**: One kind of factory work started on a ticket or PR (for example explore, implement, review, merge). It is triggered by a label or a schedule. _Avoid_: stage, job, workflow (those mean other things on GitHub).

**Agent**: The coding CLI that does a task's thinking and editing (for example Claude Code or Codex). Which one runs can be swapped.

**Factory config**: The `factory.yml` file in a client repo that turns tasks on and shapes how they run.

**Template**: A named preset, picked in the factory config, that can change which tasks exist and how they connect. The factory config can customize it further.

**Default template**: The template used when the factory config names none. It is the simple set.

**Subject**: What one run of a task is about: a single ticket, a single pull request, a batch of tickets, or the repo as a whole.

**Outcome**: One of the named results a task declares, such as `easy-call` or `needs-a-human`. The agent picks exactly one, and the outcome decides which labels come next.

**Hook**: A script a template ships alongside a task, run by the factory before or after the agent, never by the agent itself. It prepares the agent's inputs or turns its plan into writes.

**Plan**: The structured result an agent hands back: its outcome, plus the writes it asks for. The factory checks the plan against the task and makes the writes itself. _Avoid_: output, response.
