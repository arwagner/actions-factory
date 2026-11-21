#!/usr/bin/env bash
# implement's after hook: hand the new pull request to review. Labels added with FACTORY_TOKEN start the next run.
# Plain REST, so the token needs no scopes beyond the repo (gh pr edit also queries org data).
set -euo pipefail
if [ -n "${FACTORY_PULL_REQUEST:-}" ]; then
  gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$FACTORY_PULL_REQUEST/labels" -f "labels[]=agent:review" --silent
fi
