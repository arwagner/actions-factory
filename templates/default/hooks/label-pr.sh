#!/usr/bin/env bash
# implement's after hook: hand the new pull request to review. Labels added with FACTORY_TOKEN start the next run.
set -euo pipefail
if [ -n "${FACTORY_PULL_REQUEST:-}" ]; then
  gh pr edit "$FACTORY_PULL_REQUEST" -R "$GITHUB_REPOSITORY" --add-label agent:review
fi
